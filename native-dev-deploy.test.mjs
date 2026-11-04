import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { createNativeDevDeploy } from './native-dev-deploy.js';

const HEAD = 'a'.repeat(40), FINGERPRINT = 'b'.repeat(64);
const HOST = { alias: 'xian-oa-test', host: '119.45.50.213', user: 'liudaozhi', port: 22, auth: 'key', proxyJump: [], updatedAt: '2026-11-02' };
const ID = '12345678-1234-4234-8234-123456789abc';
const digest = data => createHash('sha256').update(data).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function finished(service) { for (let i = 0; i < 2000; i++) { const s = service.status(); if (s.state !== 'running') return s; await tick(); } throw Error('mock job did not settle'); }
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-dev-unit-')));
  const dist = join(root, 'dist'), jar = join(root, 'application.jar');
  await mkdir(dist); await writeFile(join(dist, 'index.html'), '<html>test</html>'); await writeFile(jar, 'jar');
  let info = { directory: root, branch: 'dev', head: HEAD, fingerprint: FINGERPRINT, changes: [] };
  let hosts = [structuredClone(HOST)], now = 1000;
  const calls = [], local = [];
  const archive = Buffer.from('mock pinned archive bytes');
  const bridge = async (path, opts = {}) => {
    calls.push({ path, ...opts });
    if (options.bridge) return options.bridge(path, opts, calls);
    if (path.endsWith('/hosts')) return { hosts };
    if (path.includes('/upload?')) return { type: 'result', ok: true };
    const cmd = opts.json.command;
    if (cmd.includes("print(preflight())")) return { result: { exitCode: 0, stdout: 'NATIVE_PREFLIGHT_OK\n' } };
    if (cmd.includes('NATIVE_STAGE_OK')) return { result: { exitCode: 0, stdout: 'NATIVE_STAGE_OK\n' } };
    if (cmd.includes('fcntl.flock')) {
      if (options.applyFailure) throw Error('password=should-not-leak ghp_testingtoken remote reply lost');
      return { result: { exitCode: 0, stdout: 'NATIVE_RESULT ' + JSON.stringify({ id: ID, hash: digest(archive), state: 'completed' }) } };
    }
    return { result: { exitCode: 0, stdout: 'NATIVE_RESULT ' + JSON.stringify({ id: ID, hash: digest(archive), state: options.reconciled || 'unknown' }) } };
  };
  const service = createNativeDevDeploy({ inspect: async () => structuredClone(info), port: 60582 }, {
    bridge, uuid: () => ID, now: () => now, env: { PATH: process.env.PATH, XINGLIAN_DB_PASSWORD: 'test-db-password' },
    build: async (...args) => { local.push('build'); if (options.build) return options.build(...args); return { dist, jar }; },
    command: async (exe, args, opts) => { local.push({ exe, args, opts }); if (exe === 'tar') await writeFile(args[1], archive); },
    ...options.deps,
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { service, root, dist, jar, calls, local, setInfo: patch => { info = { ...info, ...patch }; }, setHosts: value => { hosts = value; }, setNow: value => { now = value; }, body: { directory: root, head: HEAD, fingerprint: FINGERPRINT }, archive };
}
const confirmation = plan => ({ planId: plan.planId, confirmation: true, databaseRiskAccepted: true });

test('constructor pins loopback port and requires inspect', () => {
  assert.throws(() => createNativeDevDeploy({ port: 1 }), /inspect/);
  assert.throws(() => createNativeDevDeploy({ inspect() {}, port: '60582' }), /port/);
});

test('check is read-only and produces expiring explicit risk plan', async t => {
  const f = await fixture(t), plan = await f.service.check(f.body);
  assert.equal(plan.expiresAt, 301000); assert.equal(plan.databaseRiskRequired, true);
  assert.match(plan.risks.join('\n'), /数据库.*迁移/);
  assert.equal(plan.summary.target.alias, HOST.alias);
  assert.deepEqual(f.local, []);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].path, '/api/dsh-ssh/hosts');
  const cmd = f.calls[1].json.command;
  assert.ok(cmd.includes('systemctl')); assert.ok(!cmd.includes('os.mkdir('));
  assert.ok(!cmd.includes("'restart','xian-oa-dev.service'],check=True"));
  assert.ok(cmd.includes('SERVER_PORT='));
  assert.ok(!cmd.includes('print(unit_text)'));
});

test('directory, branch, HEAD, fingerprint and merge conflicts fail closed', async t => {
  const f = await fixture(t);
  for (const patch of [{ directory: f.root + '/nested' }, { head: 'c'.repeat(40) }, { fingerprint: 'c'.repeat(64) }]) await assert.rejects(f.service.check({ ...f.body, ...patch }), /变化/);
  f.setInfo({ branch: 'main' }); await assert.rejects(f.service.check(f.body), /dev/);
  f.setInfo({ branch: 'dev', changes: [{ status: 'UU' }] }); await assert.rejects(f.service.check(f.body), /冲突/);
  assert.equal(f.calls.length, 0);
});

test('host list shape, identity, duplicate alias and proxies are rejected', async t => {
  const f = await fixture(t);
  for (const hosts of [[], [HOST, HOST], [{ ...HOST, host: '127.0.0.1' }], [{ ...HOST, user: 'root' }], [{ ...HOST, proxyJump: ['other'] }], [{ ...HOST, proxyCommand: 'proxy' }]]) {
    f.setHosts(hosts); await assert.rejects(f.service.check(f.body), /主机/);
  }
  assert.equal(f.calls.filter(c => c.json).length, 0);
});

test('start requires both confirmations; expired plans cannot run', async t => {
  const f = await fixture(t), plan = await f.service.check(f.body);
  await assert.rejects(f.service.start({ planId: plan.planId, confirmation: true }), /数据库/);
  await assert.rejects(f.service.start({ planId: plan.planId, databaseRiskAccepted: true }), /确认/);
  f.setNow(plan.expiresAt); await assert.rejects(f.service.start(confirmation(plan)), /过期/);
  assert.deepEqual(f.local, []);
});

test('snapshot changes consume one-use plan without starting remote writes', async t => {
  const f = await fixture(t), plan = await f.service.check(f.body);
  f.setInfo({ fingerprint: 'c'.repeat(64) });
  const started = await f.service.start(confirmation(plan)); assert.equal(started.state, 'running');
  const s = await finished(f.service); assert.equal(s.state, 'failed'); assert.equal(s.remoteState, 'not-started');
  await assert.rejects(f.service.start(confirmation(plan)), /已使用/);
  assert.equal(f.calls.filter(c => c.path.includes('upload')).length, 0);
});

test('full mocked deployment pins upload hash and static lock/marker/switch rules', async t => {
  const f = await fixture(t), plan = await f.service.check(f.body);
  await f.service.start(confirmation(plan));
  await assert.rejects(f.service.start(confirmation(plan)), /正在执行/);
  const s = await finished(f.service);
  assert.equal(s.state, 'succeeded'); assert.equal(s.remoteState, 'completed'); assert.equal(s.artifactSha256, digest(f.archive));
  assert.equal(s.backupPath, '/opt/xian-oa-dev/.dsh-native-backup-' + ID);
  const upload = f.calls.find(c => c.path.includes('/upload?'));
  const query = new URL('http://127.0.0.1' + upload.path).searchParams;
  assert.equal(query.get('alias'), HOST.alias); assert.equal(query.get('remotePath'), '/tmp/dsh-xian-oa-dev-' + ID + '/bundle.tar');
  const apply = f.calls.find(c => c.json?.command.includes('fcntl.flock')).json.command.replaceAll("'\\''", "'");
  for (const term of ['LOCK_EX|fcntl.LOCK_NB', 'O_NOFOLLOW', 'hashlib.sha256', digest(f.archive), "m.issym()", "m.islnk()", "'..'", "marker('completed')", "marker('failed')", "os.path.lexists(MARK)", "r.status==200", "200<=r.status<300", 'NoRedirect', 'sudo']) assert.ok(apply.includes(term), term);
  assert.ok(!apply.includes('rollback('));
  assert.equal(f.local.filter(c => c?.exe === 'tar').length, 1);
  const opts = f.local.find(c => c?.exe === 'tar').opts;
  assert.equal(opts.env.XINGLIAN_DB_PASSWORD, undefined);
  assert.equal(f.service.status().controller, undefined);
  await assert.rejects(f.service.start(confirmation(plan)), /已使用/);
  assert.throws(() => f.service.status({ jobId: 'other' }), /不存在/);
  // Compile every generated Python program locally, without executing any of it.
  for (const call of f.calls.filter(c => c.json)) {
    const quoted = call.json.command.slice('sudo -n /usr/bin/python3 -I -c '.length);
    const source = quoted.slice(1, -1).replaceAll("'\\''", "'");
    const check = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: source, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
  }
});

test('lost apply reply performs read-only reconciliation, never repeats writes', async t => {
  for (const reconciled of ['unknown', 'completed', 'failed', 'started']) {
    const f = await fixture(t, { applyFailure: true, reconciled });
    const plan = await f.service.check(f.body); await f.service.start(confirmation(plan));
    const s = await finished(f.service);
    assert.equal(s.state, reconciled === 'completed' ? 'succeeded' : 'failed');
    assert.equal(s.remoteState, reconciled);
    assert.equal(f.calls.filter(c => c.json?.command.includes('fcntl.flock')).length, 1);
    assert.equal(f.calls.filter(c => c.path.includes('/upload?')).length, 1);
    assert.ok(!s.logs.includes('should-not-leak')); assert.ok(!s.logs.includes('ghp_testingtoken'));
  }
});

test('symlink artifacts stop before any remote write', async t => {
  const f = await fixture(t);
  await symlink(f.jar, join(f.dist, 'bad-link'));
  const plan = await f.service.check(f.body); await f.service.start(confirmation(plan));
  const s = await finished(f.service); assert.equal(s.state, 'failed'); assert.equal(s.remoteState, 'not-started');
  assert.equal(f.calls.filter(c => c.path.includes('upload')).length, 0);
});

test('close aborts trusted builder and rejects future calls', async t => {
  const f = await fixture(t, { build: async (_original, { signal }) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }); }) });
  const plan = await f.service.check(f.body); await f.service.start(confirmation(plan));
  while (!f.local.includes('build')) await tick();
  await f.service.close(); assert.equal(f.service.status().state, 'failed');
  await assert.rejects(f.service.check(f.body), /关闭/);
  await assert.rejects(f.service.start(confirmation(plan)), /关闭/);
});

test('real loopback adapter parses JSON and rejects NDJSON upload failure', async t => {
  const f = await fixture(t);
  const server = http.createServer(async (req, res) => {
    let raw = Buffer.alloc(0); for await (const chunk of req) raw = Buffer.concat([raw, chunk]);
    if (req.url === '/api/dsh-ssh/hosts') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ hosts: [HOST] })); return; }
    if (req.url.startsWith('/api/dsh-ssh/upload?')) { assert.deepEqual(raw, f.archive); res.setHeader('content-type', 'application/x-ndjson'); res.end('{"type":"progress"}\n{"type":"result","ok":false}\n'); return; }
    const { alias, command, timeoutMs } = JSON.parse(raw.toString());
    assert.equal(alias, HOST.alias); assert.equal(timeoutMs, 210000);
    const stdout = command.includes('print(preflight())') ? 'NATIVE_PREFLIGHT_OK' : command.includes('NATIVE_STAGE_OK') ? 'NATIVE_STAGE_OK' : 'NATIVE_RESULT ' + JSON.stringify({ id: ID, hash: digest(f.archive), state: 'unknown' });
    res.end(JSON.stringify({ result: { exitCode: 0, stdout } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const native = createNativeDevDeploy({ inspect: async () => ({ ...f.body, branch: 'dev', changes: [] }), port }, {
    uuid: () => ID, env: {}, build: async () => ({ dist: f.dist, jar: f.jar }),
    command: async (_exe, args) => { await writeFile(args[1], f.archive); },
  });
  t.after(async () => { await native.close(); await new Promise(resolve => server.close(resolve)); });
  const plan = await native.check(f.body); await native.start(confirmation(plan));
  const s = await finished(native); assert.equal(s.state, 'failed'); assert.equal(s.remoteState, 'unknown'); assert.match(s.error, /上传/);
});

test('default builder invokes npm build and Maven package with tests on Java 21 only', async t => {
  const commands = [];
  const f = await fixture(t, { deps: {
    build: undefined,
    discover: async () => ({ npm: 'mock-npm', mvn: 'mock-mvn' }),
    command: async (exe, args, opts) => {
      commands.push({ exe, args, env: opts.env });
      if (args[0] === '-version') opts.onOutput('Apache Maven\nJava version: 21.0.8, vendor: test\n');
      if (exe === 'tar') await writeFile(args[1], Buffer.from('mock pinned archive bytes'));
    },
  } });
  await mkdir(join(f.root, 'backend/target'), { recursive: true }); await writeFile(join(f.root, 'backend/pom.xml'), '<project/>');
  await writeFile(join(f.root, 'backend/target/backend.jar'), 'jar');
  await mkdir(join(f.root, 'node_modules/vite/bin'), { recursive: true }); await writeFile(join(f.root, 'node_modules/vite/bin/vite.js'), '');
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' }, dependencies: { react: '1', vite: '1' } }));
  const plan = await f.service.check(f.body); await f.service.start(confirmation(plan));
  const s = await finished(f.service); assert.equal(s.state, 'succeeded', s.error);
  assert.deepEqual(commands.slice(0, 3).map(c => [c.exe, c.args]), [['mock-mvn', ['-version']], ['mock-npm', ['run', 'build']], ['mock-mvn', ['-B', '-f', 'backend/pom.xml', 'package']]]);
  for (const c of commands) { assert.equal(c.env.XINGLIAN_DB_PASSWORD, undefined); assert.ok(!c.args.some(arg => /skipTests|install|spring-boot:run/.test(arg))); }
});
