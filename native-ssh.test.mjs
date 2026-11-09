import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, realpath, writeFile, readFile, stat, chmod, symlink, link, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createNativeSsh, NATIVE_SSH_MESSAGES } from './native-ssh.js';

const target = { host: '192.0.2.10', port: 2222, alias: 'fixed' };
const blob = Buffer.concat([Buffer.from([0,0,0,11]), Buffer.from('ssh-ed25519'), Buffer.from([0,0,0,32]), Buffer.alloc(32, 7)]).toString('base64');
const line = `[192.0.2.10]:2222 ssh-ed25519 ${blob}\n`;
function mock(responses = []) {
  const calls = [];
  const spawn = (program, args, options) => {
    const response = responses.shift() ?? { stdout: '{"jobs":[]}', code: 0 };
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.bytes = [];
    child.stdin = new Writable({ write(chunk, encoding, done) { child.bytes.push(Buffer.from(chunk)); done(); } });
    child.kill = signal => { child.killed = signal; child.emit('close', null); return true; };
    calls.push({ program, args, options, child });
    if (!response.hang) child.stdin.on('finish', () => queueMicrotask(() => {
      if (response.error) { child.emit('error', new Error('SECRET /private/key-path')); return; }
      child.stdout.end(response.stdout ?? ''); child.stderr.end(response.stderr ?? ''); child.emit('close', response.code ?? 0);
    }));
    return child;
  };
  return { spawn, calls };
}
async function fixture(t, responses = []) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'native-ssh-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const key = join(base, 'identity'); await writeFile(key, 'TEST KEY PLACEHOLDER', { mode: 0o600 });
  const m = mock(responses), directory = join(base, 'state');
  const ssh = createNativeSsh({ directory, target, spawn: m.spawn });
  t.after(() => ssh.close());
  return { base, directory, key, ssh, ...m };
}
async function ready(f) { await f.ssh.save({ user: 'alice', privateKeyPath: f.key }); const scan = await f.ssh.scan(); await f.ssh.trust({ fingerprint: scan.fingerprint }); return scan; }

test('construction/read are inert; input fields and selected target cannot be changed', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.ssh.read(), { alias: 'fixed', host: target.host, port: 2222, configured: false, trusted: false, fingerprint: null, user: '', privateKeyPath: '' });
  await assert.rejects(access(f.directory)); assert.equal(f.calls.length, 0);
  for (const input of [{ user: 'root', privateKeyPath: f.key }, { user: 'alice', privateKeyPath: 'relative' }, { user: 'alice', privateKeyPath: f.key, host: 'evil' }]) await assert.rejects(f.ssh.save(input));
  await assert.rejects(f.ssh.bridge('/api/dsh-ssh/exec', { json: { alias: 'evil', command: 'id' } }));
  await assert.rejects(f.ssh.bridge('/api/dsh-ssh/hosts', { json: {} }));
  assert.throws(() => createNativeSsh({ directory: f.directory, target: { ...target, host: '-oProxyCommand=evil' } }));
});

test('save persists only reference at 700/600, survives re-open, preserves trust', async t => {
  const f = await fixture(t, [{ stdout: line }]);
  await ready(f);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  for (const name of ['config.json', 'known_hosts']) assert.equal((await stat(join(f.directory, name))).mode & 0o777, 0o600);
  const text = await readFile(join(f.directory, 'config.json'), 'utf8');
  assert.ok(!text.includes('TEST KEY PLACEHOLDER')); assert.ok(text.includes(f.key));
  const other = createNativeSsh({ directory: f.directory, target, spawn: f.spawn });
  const result = await other.read(); assert.equal(result.configured, true); assert.equal(result.trusted, true);
  const saved = await other.save({ user: 'bob', privateKeyPath: f.key }); assert.equal(saved.trusted, true); assert.equal(saved.user, 'bob'); other.close();
});

test('scan never trusts; fingerprint agrees with local OpenSSH ssh-keygen', async t => {
  const f = await fixture(t, [{ stdout: line }]);
  const scan = await f.ssh.scan(); assert.equal(scan.trusted, false); assert.equal((await f.ssh.read()).trusted, false);
  const publicFile = join(f.base, 'public.pub'); await writeFile(publicFile, `ssh-ed25519 ${blob}\n`);
  const expected = execFileSync('/usr/bin/ssh-keygen', ['-lf', publicFile, '-E', 'sha256'], { encoding: 'utf8' }).split(/\s+/)[1];
  assert.equal(scan.fingerprint, expected);
  await assert.rejects(f.ssh.trust({ fingerprint: 'SHA256:wrong' }));
  assert.equal((await f.ssh.trust({ fingerprint: expected })).trusted, true);
  await assert.rejects(f.ssh.trust({ fingerprint: expected }));
  assert.equal(f.calls[0].program, '/usr/bin/ssh-keyscan');
});

test('changed fingerprint refuses overwrite and malformed scans refuse trust', async t => {
  const changed = line.replace(blob, Buffer.concat([Buffer.from([0,0,0,11]), Buffer.from('ssh-ed25519'), Buffer.from([0,0,0,32]), Buffer.alloc(32, 8)]).toString('base64'));
  const f = await fixture(t, [{ stdout: line }, { stdout: changed }, { stdout: 'host ssh-ed25519 AAAA' }]);
  await ready(f); const before = await readFile(join(f.directory, 'known_hosts'), 'utf8');
  const scan = await f.ssh.scan(); await assert.rejects(f.ssh.trust({ fingerprint: scan.fingerprint }), /禁止覆盖/);
  assert.equal(await readFile(join(f.directory, 'known_hosts'), 'utf8'), before);
  await assert.rejects(f.ssh.scan()); await assert.rejects(f.ssh.trust({ fingerprint: scan.fingerprint }));
});

test('SSH isolation, protocol compatibility, overview-only test and sanitized stderr', async t => {
  const f = await fixture(t, [{ stdout: line }, { stdout: '{"jobs":[]}' }, { stdout: '{"ok":true}', stderr: 'SECRET /private/key', code: 1 }]);
  await ready(f);
  assert.equal((await f.ssh.bridge('/api/dsh-ssh/hosts')).hosts[0].auth, 'key');
  assert.deepEqual(await f.ssh.test(), { ok: true, connected: true, authorized: true, message: 'SSH 连接与团队入口授权检查通过，未执行部署' });
  const call = f.calls[1]; assert.equal(call.program, '/usr/bin/ssh'); assert.equal(call.options.shell, false);
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'IdentitiesOnly=yes', 'ForwardAgent=no', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'UpdateHostKeys=no', 'ProxyCommand=none']) assert.ok(call.args.includes(option));
  assert.ok(call.args.includes('UserKnownHostsFile="' + join(f.directory, 'known_hosts') + '"'));
  assert.equal(call.args.at(-2), target.host); assert.ok(call.args.at(-1).startsWith('/usr/bin/python3 -I /usr/local/libexec/xian-oa-team-entry.py '));
  const payload = JSON.parse(Buffer.from(call.args.at(-1).split("'")[1], 'base64')); assert.deepEqual(payload, { action: 'overview', body: {} });
  const result = await f.ssh.bridge('/api/dsh-ssh/exec', { json: { alias: 'fixed', command: 'printf data', timeoutMs: 1000 } });
  assert.equal(result.result.exitCode, 1); assert.equal(result.result.stderr, '');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('timeout, close, output limit and spawn failure terminate locally without secret errors', async t => {
  for (const kind of ['timeout', 'close', 'limit', 'spawn']) {
    const response = kind === 'limit' ? { stdout: 'x'.repeat(1024 * 1024 + 1) } : kind === 'spawn' ? { error: true } : { hang: true };
    const f = await fixture(t, [{ stdout: line }, response]); await ready(f);
    const running = f.ssh.bridge('/api/dsh-ssh/exec', { json: { alias: 'fixed', command: 'id', timeoutMs: kind === 'timeout' ? 10 : 10000 } });
    if (kind === 'close') { while (f.calls.length < 2) await new Promise(resolve => setImmediate(resolve)); f.ssh.close(); }
    await assert.rejects(running, e => e.status === 503 && !e.message.includes('SECRET') && !e.message.includes(f.key));
    if (kind !== 'spawn') assert.equal(f.calls.at(-1).child.killed, 'SIGKILL');
  }
  assert.ok(Object.isFrozen(NATIVE_SSH_MESSAGES));
});

test('upload is stdin streaming with exclusive 600 file and strict UUID destination', async t => {
  const f = await fixture(t, [{ stdout: line }, { stdout: '' }]); await ready(f);
  const file = join(f.base, 'source.tar'); await writeFile(file, 'archive-data');
  const url = '/api/dsh-ssh/upload?' + new URLSearchParams({ alias: 'fixed', remotePath: '/tmp/dsh-upload-12345678-1234-4234-9234-123456789abc/source.tar' });
  assert.deepEqual(await f.ssh.bridge(url, { file }), { type: 'result', ok: true });
  const call = f.calls.at(-1), command = call.args.at(-1);
  assert.ok(command.startsWith('/usr/bin/python3 -I -c '));
  assert.ok(command.includes('os.O_EXCL')); assert.ok(command.includes('0o600')); assert.ok(command.includes('sys.stdin.buffer.read')); assert.ok(command.includes('268435456'));
  assert.equal(Buffer.concat(call.child.bytes).toString(), 'archive-data');
  for (const bad of [url.replace('source.tar', 'other'), url + '&alias=fixed', url.replace('%2Ftmp%2F', '%2Fvar%2Ftmp%2F')]) await assert.rejects(f.ssh.bridge(bad, { file }));
  const huge = await import('node:fs/promises').then(fs => fs.open(join(f.base, 'huge'), 'w')); await huge.truncate(256 * 1024 * 1024 + 1); await huge.close();
  await assert.rejects(f.ssh.bridge(url, { file: join(f.base, 'huge') }));
});

test('Windows ACL hook uses fixed encoded PowerShell and fixed native binaries', async t => {
  const f = await fixture(t);
  await mkdir(f.directory, { mode: 0o700 }); // Mock PowerShell cannot create its real directory.
  const calls = [];
  let deny = false;
  const spawn = (program, args, options) => {
    const powershell = program.endsWith('powershell.exe');
    calls.push({ program, args, options });
    return mock([{ stdout: powershell ? (deny ? 'DENIED' : 'DSH_ACL_OK') : line, code: 0 }]).spawn(program, args, options);
  };
  const ssh = createNativeSsh({ directory: f.directory, target, platform: 'win32', spawn });
  t.after(() => ssh.close());
  await ssh.save({ user: 'alice', privateKeyPath: f.key });
  const aclCall = calls.find(c => c.program.endsWith('powershell.exe'));
  assert.ok(aclCall.program.includes('WindowsPowerShell')); assert.equal(aclCall.options.shell, false);
  const source = Buffer.from(aclCall.args.at(-1), 'base64').toString('utf16le');
  assert.ok(source.includes('Get-Acl')); assert.ok(source.includes('ReparsePoint')); assert.ok(source.includes('SetAccessRuleProtection($true,$false)')); assert.ok(source.includes('S-1-5-32-544'));
  assert.ok(!source.includes(f.key)); assert.ok(aclCall.options.env.DSH_SSH_SECURE_PATH);
  await ssh.scan(); assert.ok(calls.some(c => c.program.endsWith('OpenSSH\\ssh-keyscan.exe')));
  deny = true; await assert.rejects(ssh.read(), /权限安全校验失败/);
});

test('symlink, hardlink, permission and existing inconsistent trust fail closed', async t => {
  const f = await fixture(t, [{ stdout: line }]);
  const symlinkKey = join(f.base, 'key-link'); await symlink(f.key, symlinkKey);
  await assert.rejects(f.ssh.save({ user: 'alice', privateKeyPath: symlinkKey }));
  const hard = join(f.base, 'hard'); await link(f.key, hard);
  await assert.rejects(f.ssh.save({ user: 'alice', privateKeyPath: f.key })); await rm(hard);
  await chmod(f.key, 0o644); await assert.rejects(f.ssh.save({ user: 'alice', privateKeyPath: f.key })); await chmod(f.key, 0o600);
  await ready(f);
  await chmod(join(f.directory, 'config.json'), 0o644); await assert.rejects(f.ssh.read()); await chmod(join(f.directory, 'config.json'), 0o600);
  await writeFile(join(f.directory, 'known_hosts'), line.replace(blob, blob.slice(0, -4) + 'AAAA')); await assert.rejects(f.ssh.read());
  const unsafe = join(f.base, 'unsafe'); await mkdir(unsafe, { mode: 0o755 });
  await assert.rejects(createNativeSsh({ directory: unsafe, target }).read());
  const sym = join(f.base, 'sym'); await symlink(f.directory, sym);
  await assert.rejects(createNativeSsh({ directory: sym, target }).read());
});
