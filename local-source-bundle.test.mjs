import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { lstat, mkdtemp, readdir, readFile, realpath, rename, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createLocalSourceBundle } from './local-source-bundle.js';

const repository = 'ssal-team/XiAN-OA', branch = 'dev', head = 'a'.repeat(40);
const snapshot = { repository, branch, head };
// A valid empty tar archive compressed as gzip; GitHub prefix handling belongs to the server.
const archive = gzipSync(Buffer.alloc(1024));
async function fixture(t, options = {}) {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'local-bundle-test-'));
  t.after(() => rm(baseDirectory, { recursive: true, force: true }));
  const calls = [];
  const command = async (...args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ ref: `refs/heads/${branch}`, object: { type: 'commit', sha: head } }) };
  };
  const downloads = [];
  const download = async request => { downloads.push(request); await request.handle.writeFile(archive); };
  return { baseDirectory, calls, downloads, source: createLocalSourceBundle({ baseDirectory, command, download, ...options }) };
}

test('resolves exact remote binding with fixed host and bounded command contract', async t => {
  const { source, calls } = await fixture(t);
  assert.deepEqual(await source.resolve({ repository, branch }), snapshot);
  assert.deepEqual(calls[0].slice(0, 2), ['gh', ['api', `repos/${repository}/git/ref/heads/dev`, '--hostname', 'github.com']]);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].maxOutput, 65536);
  assert.equal(calls[0][2].env.GH_HOST, 'github.com');
  assert.equal(calls[0][2].env.GH_DEBUG, undefined);
});

test('prepares only remote SHA tarball bytes with hash, private file and idempotent cleanup', async t => {
  const { source, downloads, calls, baseDirectory } = await fixture(t);
  const bundle = await source.prepare(snapshot);
  assert.equal(calls.length, 1);
  assert.equal(downloads.length, 1);
  assert.deepEqual(downloads[0].args, ['api', `repos/${repository}/tarball/${head}`, '--hostname', 'github.com']);
  assert.equal(downloads[0].maxBytes, 256 * 1024 * 1024);
  assert.deepEqual(await readFile(bundle.path), archive);
  assert.equal(bundle.size, archive.length);
  assert.equal(bundle.sha256, createHash('sha256').update(archive).digest('hex'));
  if (process.platform !== 'win32') assert.equal((await lstat(bundle.path)).mode & 0o777, 0o600);
  assert.equal(dirname(dirname(bundle.path)), await realpath(baseDirectory));
  await bundle.cleanup(); await bundle.cleanup();
  assert.deepEqual(await readdir(baseDirectory), []);
});

test('rejects URL/local source/options and invalid branches before any command', async t => {
  const { source, calls } = await fixture(t);
  for (const input of [
    { repository: 'https://github.com/ssal-team/XiAN-OA', branch },
    { repository: 'owner/repo?token=x', branch },
    { repository: 'owner/../repo', branch },
    ...['--help', '../dev', 'dev?x', 'dev\n', 'a//b', 'a.lock/b', '.hidden', 'a@{b', 'a b', 'https://evil/x'].map(branch => ({ repository, branch })),
    { repository, branch, directory: '/tmp/source' },
    { get repository() { throw new Error('getter must not execute'); }, branch },
  ]) await assert.rejects(source.resolve(input));
  await assert.rejects(source.prepare({ ...snapshot, head: '--help' }));
  assert.equal(calls.length, 0);
});

test('nested branch uses escaped path but verifies the original exact ref', async t => {
  let args;
  const { source } = await fixture(t, { command: async (_, values) => {
    args = values;
    return { stdout: JSON.stringify({ ref: 'refs/heads/feature/a#b', object: { type: 'commit', sha: head.toUpperCase() } }) };
  } });
  assert.deepEqual(await source.resolve({ repository, branch: 'feature/a#b' }), { repository, branch: 'feature/a#b', head });
  assert.equal(args[1], `repos/${repository}/git/ref/heads/feature/a%23b`);
});

test('rejects mismatched ref, noncommit, malformed JSON and truncated output', async t => {
  for (const response of [
    { stdout: '{}' }, { stdout: 'invalid' },
    { stdout: JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: head } }) },
    { stdout: JSON.stringify({ ref: 'refs/heads/dev', object: { type: 'tag', sha: head } }) },
    { stdout: JSON.stringify({ ref: 'refs/heads/dev', object: { type: 'commit', sha: head } }), truncated: true },
  ]) {
    const { source } = await fixture(t, { command: async () => response });
    await assert.rejects(source.resolve({ repository, branch }), /GitHub remote branch/);
  }
});

test('changed remote SHA refuses download and creates no temp bundle', async t => {
  const { source, downloads, baseDirectory } = await fixture(t);
  await assert.rejects(source.prepare({ ...snapshot, head: 'b'.repeat(40) }), /changed/);
  assert.equal(downloads.length, 0);
  assert.deepEqual(await readdir(baseDirectory), []);
});

test('failed, nongzip, empty and oversized downloads remove owned files and hide diagnostics', async t => {
  for (const download of [
    async () => { throw new Error('ghp_secret_credentials'); },
    async ({ handle }) => handle.writeFile(Buffer.alloc(40)),
    async () => {},
    async ({ handle, maxBytes }) => handle.truncate(maxBytes + 1),
  ]) {
    const { source, baseDirectory } = await fixture(t, { download });
    await assert.rejects(source.prepare(snapshot), error => {
      assert.doesNotMatch(error.message, /ghp_secret_credentials/);
      return true;
    });
    assert.deepEqual(await readdir(baseDirectory), []);
  }
});

test('command failures do not expose authentication diagnostics', async t => {
  const { source } = await fixture(t, { command: async () => { throw new Error('Authorization: token ghp_secret'); } });
  await assert.rejects(source.resolve({ repository, branch }), error => {
    assert.doesNotMatch(error.message, /ghp_secret|Authorization/); return true;
  });
});

test('cleanup refuses replaced temporary root rather than deleting another directory', async t => {
  const { source } = await fixture(t);
  const bundle = await source.prepare(snapshot), root = dirname(bundle.path), moved = `${root}-original`;
  await rename(root, moved); await mkdir(root);
  await assert.rejects(bundle.cleanup(), /identity changed/);
  assert.equal((await lstat(root)).isDirectory(), true);
  await rm(root, { recursive: true }); await rename(moved, root);
  await bundle.cleanup();
});

test('download file symlink replacement is refused and target is not followed', async t => {
  let outside;
  const { source, baseDirectory } = await fixture(t, { download: async ({ handle }) => {
    await handle.writeFile(archive);
    const [rootName] = await readdir(baseDirectory);
    const path = join(baseDirectory, rootName, 'source.tar.gz');
    outside = join(baseDirectory, 'outside');
    await mkdir(outside);
    await rm(path); await symlink(outside, path);
  } });
  await assert.rejects(source.prepare(snapshot), /Invalid or oversized/);
  assert.equal((await lstat(outside)).isDirectory(), true);
  assert.deepEqual(await readdir(baseDirectory), ['outside']);
});
