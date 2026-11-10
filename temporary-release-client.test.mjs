import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createTemporaryReleaseClient, createTemporaryReleaseTransport } from './temporary-release-client.js';
import { DEFAULT_RELEASE_PROFILE } from './release-profile.js';
const HEAD = 'a'.repeat(40);
function profile() { const p = structuredClone(DEFAULT_RELEASE_PROFILE); for (const key of Object.keys(p.baseImages)) p.baseImages[key] = `reviewed/${key.toLowerCase()}@sha256:${'b'.repeat(64)}`; return p; }
function fixture(name = '刘道志', override = {}) {
  const calls = [], sources = []; let cleanups = 0;
  const p = profile();
  const client = createTemporaryReleaseClient({ profile: p, getUser: async () => ({ name }), source: {
    async resolve(input) { sources.push(['resolve', input]); return { ...input, head: HEAD }; },
    async prepare(input) { sources.push(['prepare', input]); return { path: '/tmp/trusted-source.tar', sha256: 'c'.repeat(64), size: 123, async cleanup() { cleanups++; } }; },
  }, transport: async request => { calls.push(request); if (['check', 'promote'].includes(request.action)) return { planId: request.action + '-plan', environment: request.action === 'check' ? 'dev' : 'test', remote: { repository: p.repository, branch: p.branch, head: HEAD }, expiresAt: Date.now() + 300000 }; return { status: 'pending', jobId: 'job-1' }; }, ...override });
  return { client, calls, sources, cleanups: () => cleanups, p };
}
test('dev source resolution and pinned preparation; test promotion never prepares/uploads source', async () => {
  const f = fixture(); f.p.target.host = 'mutated';
  await f.client.check(); await f.client.start({ planId: 'check-plan', confirmation: true, databaseRiskAccepted: true });
  await f.client.status(); await f.client.status('job-1'); await f.client.accept({ jobId: 'job-1', confirmation: true });
  await f.client.promotion({ releaseId: 'release-1' }); await f.client.start({ planId: 'promote-plan', confirmation: true, databaseRiskAccepted: true }); await f.client.reconcile({ jobId: 'job-1' });
  assert.deepEqual(f.calls.map(c => c.action), ['check', 'start', 'status', 'status', 'accept', 'promote', 'start', 'reconcile']);
  assert.deepEqual(f.calls[0].body, { head: HEAD }); assert.equal(f.calls[0].profile.target.host, '119.45.50.213');
  assert.equal(f.calls[1].bundle.path, '/tmp/trusted-source.tar'); assert.equal(f.calls[6].bundle, undefined);
  assert.deepEqual(f.sources.map(s => s[0]), ['resolve', 'prepare']); assert.equal(f.sources[1][1].head, HEAD); assert.equal(f.cleanups(), 1);
});
test('strict browser inputs and missing plans fail closed before source or transport', async () => {
  const f = fixture();
  for (const input of [{ profile: profile() }, { command: 'anything' }, { head: HEAD }, { directory: '/tmp/x' }, null, []]) await assert.rejects(f.client.check(input));
  await assert.rejects(f.client.start({ planId: 'unknown', confirmation: true, databaseRiskAccepted: true }), /计划/);
  await assert.rejects(f.client.start({ planId: 'x', confirmation: true })); await assert.rejects(f.client.status('bad\n'));
  assert.equal(f.calls.length, 0); assert.equal(f.sources.length, 0);
});
test('exact-name gate on starts, promotion, acceptance; readonly status still allowed', async () => {
  const f = fixture('other');
  await assert.rejects(f.client.start({ planId: 'x', confirmation: true, databaseRiskAccepted: true }), { status: 403 });
  await assert.rejects(f.client.promotion({ releaseId: 'x' }), { status: 403 }); await assert.rejects(f.client.accept({ jobId: 'x', confirmation: true }), { status: 403 });
  await f.client.status(); assert.equal(f.calls.length, 1);
});
test('lost start response consumes plan, cleans source, never retries; close blocks further work', async () => {
  let starts = 0, cleaned = 0;
  const p = profile();
  const f = fixture('刘道志', { source: { resolve: async input => ({ ...input, head: HEAD }), prepare: async () => ({ path: '/tmp/x', sha256: 'c'.repeat(64), size: 1, cleanup: async () => { cleaned++; } }) }, transport: async ({ action }) => {
    if (action === 'check') return { planId: 'p', environment: 'dev', remote: { repository: p.repository, branch: p.branch, head: HEAD }, expiresAt: 9999999999 };
    starts++; throw Error('secret remote stderr');
  } });
  await f.client.check();
  await assert.rejects(f.client.start({ planId: 'p', confirmation: true, databaseRiskAccepted: true }), error => error.status === 503 && !error.message.includes('secret'));
  await assert.rejects(f.client.start({ planId: 'p', confirmation: true, databaseRiskAccepted: true })); assert.equal(starts, 1); assert.equal(cleaned, 1);
  f.client.close(); await assert.rejects(f.client.status(), { status: 503 });
});
test('check response cannot substitute another SHA', async () => {
  const f = fixture('刘道志', { transport: async () => ({ planId: 'p', environment: 'dev', remote: { repository: profile().repository, branch: 'dev', head: 'b'.repeat(40) }, expiresAt: 123 }) });
  await assert.rejects(f.client.check(), /不匹配/);
});
test('production transport checks SSH target, root-bootstraps bounded inline script, no permanent entry', async () => {
  const p = profile(), commands = [];
  const transport = createTemporaryReleaseTransport({ port: 60582, script: 'print("{}")', bridge: async (path, { json }) => {
    if (path === '/api/dsh-ssh/hosts') return { hosts: [{ ...p.target, auth: 'key', proxyJump: [] }] };
    commands.push(json.command); return { result: { exitCode: 0, stdout: '{}' } };
  } });
  assert.deepEqual(await transport.request({ profile: p, action: 'status', body: {} }), {});
  assert.equal(commands.length, 1); assert.match(commands[0], /^sudo -n \/usr\/bin\/python3 -I - <<'DSH_TEMPORARY_RELEASE'/);
  assert.match(commands[0], /os\.mkdir\(stage,0o700\)/); assert.match(commands[0], /os\.O_NOFOLLOW,0o600/); assert.match(commands[0], /shutil\.rmtree\(stage\)/); assert.doesNotMatch(commands[0], /\/usr\/local\/libexec|git clone|github/);
  transport.close(); await assert.rejects(transport.request({ profile: p, action: 'status', body: {} }));
});
test('production rejects oversized script and wrong SSH identity without remote exec', async () => {
  let calls = 0;
  const transport = createTemporaryReleaseTransport({ port: 1, script: 'x'.repeat(65537), bridge: async () => { calls++; } });
  await assert.rejects(transport.request({ profile: profile(), action: 'status', body: {} }), /64KiB/); assert.equal(calls, 0);
  const wrong = createTemporaryReleaseTransport({ port: 1, script: 'pass', bridge: async () => ({ hosts: [{ ...profile().target, host: 'wrong', auth: 'key', proxyJump: [] }] }) });
  await assert.rejects(wrong.request({ profile: profile(), action: 'status', body: {} }), /身份/);
});
test('known preflight refusals survive transport and client without leaking stderr', async () => {
  for (const [reason, expected] of [['Existing services must be healthy', /服务不健康/], ['Expected one existing container per service', /缺失或未运行/], ["Preflight service failure: Referencing column 'employee_id' and referenced column 'id' in foreign key constraint 'rbac_account_ibfk_1' are incompatible.", /外键字段类型不兼容.*rbac_account_ibfk_1/]]) {
    for (const jsonResponse of [false, true]) {
    const p = profile();
    const transport = createTemporaryReleaseTransport({ port: 1, script: 'pass', bridge: async path => {
      if (path === '/api/dsh-ssh/hosts') return { hosts: [{ ...p.target, auth: 'key', proxyJump: [] }] };
      return { result: { exitCode: 1, stdout: jsonResponse ? JSON.stringify({ error: reason }) : '', stderr: jsonResponse ? '' : 'password=secret\nrelease.Refused: ' + reason } };
    } });
    const f = fixture('刘道志', { transport });
    await assert.rejects(f.client.check(), error => expected.test(error.message) && !error.message.includes('secret'));
    transport.close();
    }
  }
});
test('schema structural refusal survives JSON transport and repeated sanitization', async () => {
  const reason='SCHEMA_REVIEW_V1:'+JSON.stringify({force:false,details:[{code:'COLUMN_TYPE_MISMATCH',reason:'password=secret',table:'org_employee',column:'id',fromType:'varchar(36)',toType:'bigint'}]});
  const p=profile();
  const transport=createTemporaryReleaseTransport({port:1,script:'pass',bridge:async path=>path==='/api/dsh-ssh/hosts'?{hosts:[{...p.target,auth:'key',proxyJump:[]}]}:{result:{exitCode:1,stdout:JSON.stringify({error:reason}),stderr:''}}});
  const f=fixture('刘道志',{transport});
  await assert.rejects(f.client.check(),error=>/org_employee.id/.test(error.message)&&/test varchar\(36\) → dev bigint/.test(error.message)&&!error.message.includes('secret'));
  transport.close();
});
test('unknown transport failures remain private and uncertain', async () => {
  const f = fixture('刘道志', { transport: async () => { throw Error('password=secret'); } });
  await assert.rejects(f.client.check(), error => /未明确响应/.test(error.message) && !error.message.includes('secret'));
});
async function loopbackBridge(t, respond) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const call = { path: req.url, method: req.method, body, headers: req.headers }; calls.push(call);
    const response = respond(call, calls);
    res.writeHead(response.status ?? 200, { 'content-type': 'application/json' });
    res.end(typeof response.body === 'string' ? response.body : JSON.stringify(response.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, calls };
}

test('default production team transport uses DSH hosts, exec and NDJSON upload without native SSH', async t => {
  const p = profile();
  const bridge = await loopbackBridge(t, call => {
    if (call.path === '/api/dsh-ssh/hosts') return { body: { hosts: [{ ...p.target, user: 'member', auth: 'key', proxyJump: [], updatedAt: 1 }] } };
    if (call.path.startsWith('/api/dsh-ssh/upload?')) return { body: '{"type":"progress","bytes":1}\n{"type":"result","ok":true}\n' };
    assert.equal(call.path, '/api/dsh-ssh/exec');
    return { body: { result: { exitCode: 0, stdout: '{"ok":true}', timedOut: false, truncated: false } } };
  });
  const transport = createTemporaryReleaseTransport({ port: bridge.port, team: true }); t.after(() => transport.close());
  const body = { planId: 'p', confirmation: true, databaseRiskAccepted: true };
  assert.deepEqual(await transport.request({ profile: p, action: 'start', body, bundle: { path: fileURLToPath(import.meta.url), size: 123, sha256: 'c'.repeat(64) } }), { ok: true });
  const hosts = bridge.calls.filter(c => c.path === '/api/dsh-ssh/hosts'); assert.equal(hosts.length, 4); assert.ok(hosts.every(c => c.method === 'GET'));
  const uploads = bridge.calls.filter(c => c.path.startsWith('/api/dsh-ssh/upload?')); assert.equal(uploads.length, 1);
  const upload = new URL(uploads[0].path, 'http://localhost'); assert.equal(upload.searchParams.get('alias'), p.target.alias); assert.match(upload.searchParams.get('remotePath'), /^\/tmp\/dsh-upload-[a-f0-9-]+\/source\.tar$/);
  assert.equal(uploads[0].method, 'POST'); assert.equal(uploads[0].headers['content-type'], 'application/octet-stream'); assert.ok(uploads[0].body.length > 0);
  const execs = bridge.calls.filter(c => c.path === '/api/dsh-ssh/exec').map(c => JSON.parse(c.body)); assert.equal(execs.length, 3);
  assert.ok(execs.every(c => c.alias === p.target.alias && c.timeoutMs === 180000));
  assert.ok(execs.every(c => !/sudo|ssh-keyscan|ssh-keygen|privateKey/.test(c.command)));
  assert.match(execs[2].command, /^\/usr\/bin\/python3 -I \/usr\/local\/libexec\/xian-oa-team-entry.py /);
  const encoded = execs[2].command.match(/'([^']+)'$/)[1], payload = JSON.parse(Buffer.from(encoded, 'base64'));
  assert.deepEqual(Object.keys(payload).sort(), ['action', 'body']); assert.equal(payload.body.bundle.sha256, 'c'.repeat(64)); assert.equal(payload.action, 'start');
});

test('missing DSH SSH bridge fails once without native or alternate endpoint fallback', async t => {
  const bridge = await loopbackBridge(t, () => ({ status: 404, body: { error: 'missing' } }));
  const transport = createTemporaryReleaseTransport({ port: bridge.port, team: true }); t.after(() => transport.close());
  await assert.rejects(transport.request({ profile: profile(), action: 'status', body: {} }), /SSH 桥接失败 \(404\)/);
  assert.deepEqual(bridge.calls.map(c => c.path), ['/api/dsh-ssh/hosts']);
});

test('default DSH bridge refuses changed destination, root account and proxy configuration before exec', async t => {
  for (const change of [{ host: 'wrong' }, { port: 23 }, { user: 'root' }, { proxyJump: ['jump'] }, { proxyCommand: 'proxy' }]) {
    const bridge = await loopbackBridge(t, () => ({ body: { hosts: [{ ...profile().target, user: 'member', auth: 'key', proxyJump: [], ...change }] } }));
    const transport = createTemporaryReleaseTransport({ port: bridge.port, team: true }); t.after(() => transport.close());
    await assert.rejects(transport.request({ profile: profile(), action: 'status', body: {} }), /身份不匹配/);
    assert.equal(bridge.calls.length, 1);
  }
});

test('default bridge detects saved SSH identity changes before submission without retry', async t => {
  let reads = 0;
  const bridge = await loopbackBridge(t, () => ({ body: { hosts: [{ ...profile().target, user: 'member', auth: 'key', proxyJump: [], updatedAt: ++reads }] } }));
  const transport = createTemporaryReleaseTransport({ port: bridge.port, team: true }); t.after(() => transport.close());
  await assert.rejects(transport.request({ profile: profile(), action: 'status', body: {} }), /SSH 配置已变化/);
  assert.deepEqual(bridge.calls.map(c => c.path), ['/api/dsh-ssh/hosts', '/api/dsh-ssh/hosts']);
});

test('generated bundle bootstrap compiles and verifies bytes before root invocation', async () => {
  const commands = [], p = profile();
  const transport = createTemporaryReleaseTransport({ port: 1, script: 'pass', bridge: async (path, { json, file }) => {
    if (path === '/api/dsh-ssh/hosts') return { hosts: [{ ...p.target, auth: 'key', proxyJump: [] }] };
    if (file) { assert.equal(file, '/tmp/local.tar.gz'); return { ok: true }; }
    commands.push(json.command); return { result: { exitCode: 0, stdout: '{}' } };
  } });
  await transport.request({ profile: p, action: 'start', body: { planId: 'p', confirmation: true, databaseRiskAccepted: true }, bundle: { path: '/tmp/local.tar.gz', sha256: 'c'.repeat(64), size: 123 } });
  assert.equal(commands.length, 2);
  for (const command of commands) {
    const program = command.split('\n').slice(1, -1).join('\n');
    const result = spawnSync('python3', ['-I', '-c', 'import sys; compile(sys.stdin.read(), "bootstrap", "exec")'], { input: program, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.match(commands[1], /O_DIRECTORY\|os.O_NOFOLLOW/); assert.match(commands[1], /h.hexdigest\(\)==/); assert.match(commands[1], /archive.tar.gz/);
});
