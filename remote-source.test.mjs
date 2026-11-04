import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRemoteSource } from './remote-source.js';

const head = 'a'.repeat(40);
const snapshot = () => ({ repository: 'ssal-team/XiAN-OA', branch: 'dev', head, sourceOrigin: 'github-remote-dev' });
async function fixture(t, options = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'remote-source-test-')));
  // Explicitly verified test-owned root; cleanup never targets a caller/local repository.
  const identity = await lstat(base);
  t.after(async () => {
    const current = await lstat(base);
    assert.equal(current.ino, identity.ino);
    assert.equal(current.dev, identity.dev);
    await rm(base, { recursive: true, force: true });
  });
  const calls = [];
  const source = createRemoteSource({ baseDirectory: base, env: options.env || {}, command: async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const index = args.findIndex(arg => ['init', 'fetch', 'rev-parse', 'checkout', 'status'].includes(arg));
    const operation = args[index];
    if (options.onCommand) {
      const result = await options.onCommand({ cmd, args, opts, operation });
      if (result !== undefined) return result;
    }
    if (operation === 'rev-parse') return { stdout: `${head}\n` };
    if (operation === 'checkout') await writeFile(join(opts.cwd, 'remote-only.txt'), 'remote fixture');
    return { stdout: '' };
  } });
  return { base, calls, source };
}

test('fixed HTTPS fetch uses isolated tmpdir and detached locked SHA, not local files', async t => {
  const { base, calls, source } = await fixture(t);
  await writeFile(join(base, 'local-only.txt'), 'must not be copied');
  const result = await source.checkout(snapshot());
  assert.equal(result.head, head);
  assert.equal(dirname(dirname(result.directory)), base);
  assert.equal(await readFile(join(result.directory, 'remote-only.txt'), 'utf8'), 'remote fixture');
  await assert.rejects(readFile(join(result.directory, 'local-only.txt')), { code: 'ENOENT' });
  const fetch = calls.find(call => call.args.includes('fetch'));
  assert.deepEqual(fetch.args.slice(fetch.args.indexOf('fetch')), ['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', 'https://github.com/ssal-team/XiAN-OA.git', 'refs/heads/dev']);
  const checkout = calls.find(call => call.args.includes('checkout'));
  assert.deepEqual(checkout.args.slice(checkout.args.indexOf('checkout')), ['checkout', '--detach', head]);
  assert.ok(calls[0].args.includes('init'));
  assert.deepEqual(calls.filter(call => call.args.includes('rev-parse')).map(call => call.args.at(-1)), ['FETCH_HEAD', 'HEAD']);
  assert.ok(calls.every(call => call.cmd === 'git' && Array.isArray(call.args) && call.opts.shell === false && call.opts.cwd === result.directory));
  await result.cleanup(); await result.cleanup(); await source.close();
  assert.deepEqual(await readdir(base), ['local-only.txt']);
  await assert.rejects(source.checkout(snapshot()), /closed/);
});

test('snapshot rejects directory, URL, alternative repository/ref, malformed SHA and accessors before running commands', async t => {
  const { base, calls, source } = await fixture(t);
  const bad = [null, [], {}, { head: head + '\n' }, { head: 'abc' }, { head: ';echo unsafe' },
    { ...snapshot(), directory: '/local' }, { ...snapshot(), url: 'file:///local' },
    { ...snapshot(), remote: 'https://other.example/repo' }, { ...snapshot(), repository: 'other/repo' },
    { ...snapshot(), branch: 'main' }, { ...snapshot(), sourceOrigin: 'local' },
    { ...snapshot(), [Symbol('directory')]: '/local' }, Object.create({ head }),
    Object.defineProperty({}, 'head', { get() { throw new Error('must not read getter'); } })];
  for (const input of bad) await assert.rejects(source.checkout(input), /snapshot|head|fixed/);
  assert.equal(calls.length, 0); assert.deepEqual(await readdir(base), []);
  await source.close();
});

test('branch movement is rejected before checkout and automatically removes only the owned temporary root', async t => {
  const { base, calls, source } = await fixture(t, { onCommand: ({ operation }) => operation === 'rev-parse' ? { stdout: 'b'.repeat(40) + '\n' } : undefined });
  await writeFile(join(base, 'keep.txt'), 'local');
  await assert.rejects(source.checkout(snapshot()), /branch changed/);
  assert.ok(!calls.some(call => call.args.includes('checkout')));
  assert.deepEqual(await readdir(base), ['keep.txt']);
  await source.close();
});

test('command errors, unavailable private fetch, bad HEAD, and dirty checkout clean up without local fallback', async t => {
  for (const failure of ['init', 'fetch', 'head', 'dirty']) {
    const { base, source, calls } = await fixture(t, { onCommand: ({ args, operation }) => {
      if (operation === failure) throw new Error('credential secret must not leak');
      if (failure === 'head' && operation === 'rev-parse' && args.at(-1) === 'HEAD') return { stdout: 'b'.repeat(40) };
      if (failure === 'dirty' && operation === 'status') return { stdout: '?? modified\0' };
    } });
    await assert.rejects(source.checkout(snapshot()), failure === 'fetch' ? /authentication is not supported; no local fallback/ : undefined);
    assert.deepEqual(await readdir(base), []);
    assert.ok(calls.every(call => call.cmd === 'git'));
    if (failure === 'fetch') assert.equal(calls.length, 2);
    await source.close();
  }
});

test('Git has no ambient credentials, hooks, global/system configuration or local transport', async t => {
  const env = { PATH: '/usr/bin:/bin', GH_TOKEN: 'secret-test-token-987', GITHUB_TOKEN: 'secret-test-token-987', DB_PASSWORD: 'secret-test-token-987',
    HOME: '/user-home', SSH_AUTH_SOCK: '/agent', GIT_DIR: '/local/.git', GIT_WORK_TREE: '/local',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.file:///local.insteadOf', GIT_CONFIG_VALUE_0: 'https://github.com/',
    GIT_CONFIG_PARAMETERS: 'evil', GIT_ASKPASS: '/askpass', HTTPS_PROXY: 'https://user:password@proxy', GIT_TEMPLATE_DIR: '/template' };
  const { source, calls } = await fixture(t, { env });
  const result = await source.checkout({ head: head.toUpperCase() });
  assert.equal(result.head, head);
  for (const { args, opts } of calls) {
    assert.equal(opts.env.PATH, env.PATH);
    for (const key of Object.keys(env).filter(key => key !== 'PATH' && key !== 'HOME')) assert.equal(opts.env[key], undefined, key);
    assert.notEqual(opts.env.HOME, env.HOME);
    assert.equal(opts.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(opts.env.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null');
    assert.equal(opts.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(opts.env.GIT_ALLOW_PROTOCOL, 'https');
    for (const config of ['credential.helper=', 'protocol.file.allow=never', 'core.fsmonitor=false', 'http.followRedirects=false']) assert.ok(args.includes(config));
    assert.ok(args.some(arg => arg.startsWith('core.hooksPath=') && arg.includes(dirname(result.directory))));
    assert.ok(!JSON.stringify({ args, opts }).includes('secret-test-token-987'));
  }
  await source.close();
});

test('each checkout is independent and close cleans all owned roots without touching siblings', async t => {
  const { base, source } = await fixture(t);
  await writeFile(join(base, 'keep'), 'outside');
  const first = await source.checkout(snapshot()), second = await source.checkout(snapshot());
  assert.notEqual(first.directory, second.directory);
  await first.cleanup();
  assert.equal(await readFile(join(second.directory, 'remote-only.txt'), 'utf8'), 'remote fixture');
  await source.close(); await source.close();
  assert.deepEqual(await readdir(base), ['keep']);
});

test('cleanup refuses replaced temporary root symlink and never deletes outside directory', async t => {
  const { base, source } = await fixture(t);
  const result = await source.checkout(snapshot());
  const root = dirname(result.directory), moved = join(base, 'saved-owned-root');
  // Both paths are explicit descendants of this test-owned fixture root.
  assert.equal(dirname(root), base); assert.equal(dirname(moved), base);
  await rename(root, moved);
  const outside = await mkdtemp(join(base, 'outside-'));
  await writeFile(join(outside, 'keep'), 'outside');
  await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(result.cleanup(), /identity changed/);
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'outside');
  await assert.rejects(source.close(), /safe cleanup failed/);
  // Fixture teardown removes this test's own entire base, not a provider cleanup fallback.
});

test('close waits for an in-flight command before safe cleanup and rejects its checkout', async t => {
  let started, finish;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { finish = resolve; });
  const { base, source } = await fixture(t, { onCommand: async ({ operation, opts }) => {
    if (operation === 'fetch') {
      started(); await blocked;
      assert.ok((await lstat(opts.cwd)).isDirectory());
    }
  } });
  const task = source.checkout(snapshot());
  const rejected = assert.rejects(task, /closed/);
  await entered;
  const closing = source.close();
  finish();
  await Promise.all([closing, rejected]);
  assert.deepEqual(await readdir(base), []);
});
