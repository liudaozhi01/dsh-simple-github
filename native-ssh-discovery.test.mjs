import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm, chmod, symlink, link, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createNativeSsh } from './native-ssh.js';
const target = { host: '192.0.2.10', port: 22, alias: 'test-oa' };
async function fixture(t, extra = {}) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'ssh-discovery-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.ssh'), { mode: 0o700 });
  const calls = [];
  const spawn = (program, args, options) => {
    calls.push({ program, args, options });
    if (!program.endsWith('powershell.exe')) throw Error('network/subprocess forbidden');
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(c, e, done) { done(); } });
    child.stdin.on('finish', () => queueMicrotask(() => { child.stdout.end(extra.aclDenied ? 'DENIED' : 'DSH_ACL_OK'); child.emit('close', extra.aclDenied ? 1 : 0); }));
    child.kill = () => true; return child;
  };
  const { aclDenied: _aclDenied, ...construction } = extra;
  const ssh = createNativeSsh({ directory: join(home, 'state'), target, home, spawn, ...construction });
  t.after(() => ssh.close());
  const file = async (name, text = 'INVALID KEY BYTES — never parse', mode = 0o600) => { const p = join(home, '.ssh', name); await writeFile(p, text, { mode }); return p; };
  return { ssh, home, calls, file };
}

test('discovery only suggests common/private+public pairs, never writes, connects or parses keys', async t => {
  const f = await fixture(t);
  const common = await f.file('id_ed25519', '\0not a key');
  const custom = await f.file('team-key'); await f.file('team-key.pub', 'public');
  await f.file('random-notes'); await f.file('config', '# no matching server'); await f.file('known_hosts'); await f.file('authorized_keys');
  const before = await readdir(f.home);
  const result = await f.ssh.discover();
  assert.deepEqual(new Set(result.candidates.map(c => c.privateKeyPath)), new Set([common, custom]));
  assert.ok(result.candidates.every(c => Object.keys(c).sort().join(',') === 'privateKeyPath,source'));
  assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.home), before);
  await assert.rejects(access(join(f.home, 'state')));
  assert.match(result.message, /未读取私钥正文/);
});

test('saved config and exact DSH server key references deduplicate and never leak credentials', async t => {
  const f = await fixture(t); const key = await f.file('id_rsa'); const other = await f.file('custom');
  await f.ssh.save({ user: 'alice', privateKeyPath: key });
  await mkdir(join(f.home, '.dsh'), { mode: 0o700 });
  await writeFile(join(f.home, '.dsh', 'dsh-ssh.json'), JSON.stringify({ hosts: [
    { host: target.host, port: 22, auth: { kind: 'key', keyPath: key, passphrase: 'SECRET' } },
    { host: target.host, auth: { kind: 'key', keyPath: other } },
    { host: target.host, port: 23, auth: { kind: 'key', keyPath: other + 'bad' } },
    { host: 'other', port: 22, auth: { kind: 'key', keyPath: other + 'bad' } },
    { host: target.host, auth: { kind: 'password', password: 'SECRET', keyPath: other + 'bad' } }
  ] }), { mode: 0o600 });
  const state = await readFile(join(f.home, 'state', 'config.json'), 'utf8');
  const result = await f.ssh.discover();
  assert.deepEqual(result.candidates.map(c => c.privateKeyPath), [key, other]);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(await readFile(join(f.home, 'state', 'config.json'), 'utf8'), state);
  assert.equal((await f.ssh.read()).trusted, false); assert.equal(f.calls.length, 0);
});

test('OpenSSH exact Host+HostName+port only; no wildcard/Match/Include/command expansion', async t => {
  const f = await fixture(t); const key = await f.file('selected identity'); const wrong = await f.file('wrong');
  await f.file('config', `Host unrelated\n HostName other\n IdentityFile "${wrong}"\nHost test-oa\n HostName ${target.host}\n Port 22\n IdentityFile "${key}"\nHost *\n HostName ${target.host}\n IdentityFile "${wrong}"\nHost test-oa\n HostName other\n IdentityFile "${wrong}"\nMatch all\nHost test-oa\n HostName ${target.host}\n IdentityFile "${wrong}"\n`);
  assert.deepEqual((await f.ssh.discover()).candidates.map(c => c.privateKeyPath), [key]);
  await f.file('config', `Include other\nHost test-oa\nHostName ${target.host}\nIdentityFile "${wrong}"\n`);
  assert.deepEqual((await f.ssh.discover()).candidates, []);
});

test('unsafe candidates and config symlinks/oversize/malformed are excluded without changing permissions', async t => {
  const f = await fixture(t); const key = await f.file('id_rsa'); await chmod(key, 0o644);
  const original = await f.file('actual'); await symlink(original, join(f.home, '.ssh', 'id_ed25519'));
  await link(original, join(f.home, '.ssh', 'id_dsa'));
  await symlink(original, join(f.home, '.ssh', 'config'));
  assert.deepEqual((await f.ssh.discover()).candidates, []);
  await rm(join(f.home, '.ssh', 'config')); await f.file('config', 'x'.repeat(65537));
  await mkdir(join(f.home, '.dsh')); await writeFile(join(f.home, '.dsh', 'dsh-ssh.json'), '{password SECRET', { mode: 0o600 });
  assert.deepEqual((await f.ssh.discover()).candidates, []);
});

test('bounded directory and output; serialized discovery respects close', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 80; i++) { await f.file('k' + i); await f.file('k' + i + '.pub'); }
  const results = await Promise.all([f.ssh.discover(), f.ssh.discover()]);
  assert.ok(results.every(r => r.candidates.length <= 64)); assert.deepEqual(results[0], results[1]);
  f.ssh.close(); await assert.rejects(f.ssh.discover(), /已关闭/);
});

test('all sources reject public/config references even if explicitly configured', async t => {
  const f = await fixture(t);
  const paths = [];
  for (const name of ['key.pub', 'known_hosts', 'config', 'authorized_keys']) paths.push(await f.file(name));
  await mkdir(join(f.home, '.dsh'));
  await writeFile(join(f.home, '.dsh', 'dsh-ssh.json'), JSON.stringify({ hosts: paths.map(keyPath => ({ host: target.host, port: 22, auth: { kind: 'key', keyPath } })) }), { mode: 0o600 });
  assert.deepEqual((await f.ssh.discover()).candidates, []);
});

test('Windows denied ACL never recommends a candidate or changes permissions', async t => {
  const f = await fixture(t, { platform: 'win32', aclDenied: true });
  await f.file('id_ed25519');
  assert.deepEqual((await f.ssh.discover()).candidates, []);
  assert.ok(f.calls.length > 0);
  assert.ok(f.calls.every(c => c.options.env.DSH_SSH_CREATE === '0'));
});

test('Windows ACL checks are local only and D drive fallback is not interpreted as POSIX path', async t => {
  const f = await fixture(t, { platform: 'win32' }); const key = await f.file('id_ecdsa');
  const result = await f.ssh.discover();
  assert.deepEqual(result.candidates.map(c => c.privateKeyPath), [key]);
  assert.ok(f.calls.length > 0); assert.ok(f.calls.every(c => c.program.endsWith('powershell.exe')));
  assert.ok(f.calls.every(c => !c.options.env.DSH_SSH_CREATE || c.options.env.DSH_SSH_CREATE === '0'));
});
