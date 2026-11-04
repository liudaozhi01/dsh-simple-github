import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDockerSsh } from './docker-ssh.js';

const command = "sudo -n /usr/bin/python3 -I - apply job dev <<'XIAN_OA_APPLY_PY'\npass\nXIAN_OA_APPLY_PY";
const input = { alias: 'xian-oa-test', command };
const host = { alias: 'xian-oa-test', host: '119.45.50.213', user: 'liudaozhi', port: 22, auth: 'key', proxyJump: [] };
const success = { result: { exitCode: 0, timedOut: false, truncated: false, stdout: 'ok', stderr: 'secret-never-returned' } };
const ERROR = 'Docker SSH operation unavailable (details suppressed; remote state unknown; do not retry).';
const rejects = promise => assert.rejects(promise, error => error.message === ERROR && !error.cause);
async function server(t, handler) {
  const calls = [];
  const instance = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const call = { path: req.url, method: req.method, headers: req.headers, body: body ? JSON.parse(body) : undefined, address: req.socket.remoteAddress };
    calls.push(call);
    handler(call, res);
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => { instance.closeAllConnections(); return new Promise(resolve => instance.close(resolve)); });
  return { port: instance.address().port, calls };
}
function json(res, value, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }

test('strict constructor port even with trusted bridge; construction makes no calls', () => {
  assert.throws(() => createDockerSsh(null), { message: ERROR });
  assert.throws(() => createDockerSsh({ get port() { throw Error('secret'); } }), { message: ERROR });
  for (const port of [undefined, null, '22', 0, -1, 65536, 1.2, NaN, Infinity]) assert.throws(() => createDockerSsh({ port, bridge() {} }), { message: ERROR });
  assert.throws(() => createDockerSsh({ port: 1, bridge: {} }), { message: ERROR });
  let count = 0;
  for (const port of [1, 65535]) createDockerSsh({ port, bridge() { count++; } }).close();
  assert.equal(count, 0);
});

test('loopback HTTP hosts precedes every exec, bounded defaults and no credentials', async t => {
  const { port, calls } = await server(t, (call, res) => json(res, call.path.endsWith('/hosts') ? { hosts: [{ alias: 'unrelated', host: 'not-contacted' }, host] } : success));
  const ssh = createDockerSsh({ port }); t.after(ssh.close);
  assert.deepEqual(await ssh.exec(input), { exitCode: 0, stdout: 'ok' });
  assert.deepEqual(await ssh.exec({ ...input, timeoutMs: 180000 }), { exitCode: 0, stdout: 'ok' });
  assert.deepEqual(calls.map(call => [call.method, call.path]), [['GET', '/api/dsh-ssh/hosts'], ['POST', '/api/dsh-ssh/exec'], ['GET', '/api/dsh-ssh/hosts'], ['POST', '/api/dsh-ssh/exec']]);
  assert.deepEqual(calls[1].body, { ...input, timeoutMs: 180000 });
  for (const call of calls) {
    assert.equal(call.address, '127.0.0.1');
    assert.equal(call.headers.host, `127.0.0.1:${port}`);
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.headers.connection, 'close');
  }
});

test('invalid alias, command, options and timeouts never request hosts', async () => {
  let calls = 0;
  const ssh = createDockerSsh({ port: 1, bridge() { calls++; } });
  for (const bad of [undefined, {}, { ...input, alias: 'other' }, { ...input, command: 'sudo python -I' }, { ...input, command: 'sudo -n /usr/bin/python3 -I - ' }, { ...input, command: command + '\0' }, { ...input, command: command + 'x'.repeat(65536) }, { ...input, command: command + '中'.repeat(22000) }, ...[0, -1, 180001, 1.5, '1', null].map(timeoutMs => ({ ...input, timeoutMs })), { ...input, port: 22 }, { ...input, get extra() { throw Error('secret'); } }]) await rejects(ssh.exec(bad));
  assert.equal(calls, 0); ssh.close();
});

test('identity mismatch and malformed host lists prohibit POST', async () => {
  const lists = [null, {}, { hosts: [] }, { hosts: [host, host] }, ...[{ host: 'evil' }, { user: 'root' }, { port: 2222 }, { port: '22' }, { auth: 'none' }, { proxyJump: ['other'] }, { proxyJump: undefined }, { proxyCommand: 'secret' }, { proxyCommand: false }].map(patch => ({ hosts: [{ ...host, ...patch }] }))];
  for (const value of lists) {
    const calls = [];
    const ssh = createDockerSsh({ port: 1, bridge(path) { calls.push(path); return value; } });
    await rejects(ssh.exec(input));
    assert.deepEqual(calls, ['/api/dsh-ssh/hosts']); ssh.close();
  }
  for (const auth of ['key', 'password', 'agent']) {
    const ssh = createDockerSsh({ port: 1, bridge: path => path.endsWith('/hosts') ? { hosts: [{ ...host, auth }] } : success });
    assert.deepEqual(await ssh.exec(input), { exitCode: 0, stdout: 'ok' }); ssh.close();
  }
});

test('ambiguous remote results fail without retry and suppress all details', async () => {
  for (const value of [null, {}, ...[{ exitCode: 1 }, { exitCode: null }, { timedOut: true }, { timedOut: undefined }, { truncated: true }, { truncated: undefined }, { stdout: null }, { stdout: 's'.repeat(4097) }, { stdout: '中'.repeat(1366) }].map(patch => ({ result: { ...success.result, ...patch } }))]) {
    const calls = [];
    const ssh = createDockerSsh({ port: 1, bridge(path) { calls.push(path); return path.endsWith('/hosts') ? { hosts: [host] } : value; } });
    await rejects(ssh.exec(input));
    assert.deepEqual(calls, ['/api/dsh-ssh/hosts', '/api/dsh-ssh/exec']); ssh.close();
  }
  const ssh = createDockerSsh({ port: 1, bridge(path) { if (path.endsWith('/hosts')) return { hosts: [host] }; throw Error('password=secret'); } });
  await rejects(ssh.exec(input)); ssh.close();
});

test('HTTP status, JSON, size and broken response errors are fixed and never retry', async t => {
  for (const mode of ['redirect', 'bad-json', 'oversized', 'broken']) {
    await t.test(mode, async t => {
      const { port, calls } = await server(t, (call, res) => {
        if (call.path.endsWith('/hosts')) return json(res, { hosts: [host] });
        if (mode === 'redirect') { res.writeHead(302, { location: 'http://example.invalid/secret' }); res.end('password'); }
        if (mode === 'bad-json') res.end('password');
        if (mode === 'oversized') res.end('x'.repeat(65537));
        if (mode === 'broken') { res.writeHead(200, { 'content-length': 1000 }); res.write('{'); res.destroy(); }
      });
      const ssh = createDockerSsh({ port }); t.after(ssh.close);
      await rejects(ssh.exec(input)); assert.equal(calls.length, 2);
    });
  }
});

test('HTTP absolute timeout covers hanging exec and trickling hosts', async t => {
  for (const phase of ['hosts', 'exec']) await t.test(phase, async t => {
    const { port, calls } = await server(t, (call, res) => {
      if (phase === 'exec' && call.path.endsWith('/hosts')) return json(res, { hosts: [host] });
      res.writeHead(200); res.write(' ');
    });
    const ssh = createDockerSsh({ port }); t.after(ssh.close);
    await rejects(ssh.exec({ ...input, timeoutMs: 40 }));
    assert.equal(calls.length, phase === 'hosts' ? 1 : 2);
  });
});

test('trusted bridge timeout and close bound local waiting even for uncooperative hooks', async () => {
  const ssh = createDockerSsh({ port: 1, bridge: () => new Promise(() => {}) });
  await rejects(ssh.exec({ ...input, timeoutMs: 10 }));
  const waiting = ssh.exec(input); ssh.close(); ssh.close();
  await rejects(waiting); await rejects(ssh.exec(input));
});

test('close destroys pending local HTTP and rejects future operations', async t => {
  let arrived;
  const started = new Promise(resolve => { arrived = resolve; });
  let socket;
  const { port, calls } = await server(t, (call, res) => {
    if (call.path.endsWith('/hosts')) return json(res, { hosts: [host] });
    socket = res.socket; arrived();
  });
  const ssh = createDockerSsh({ port });
  const pending = ssh.exec(input);
  await started;
  const socketClosed = new Promise(resolve => socket.once('close', resolve));
  ssh.close(); await rejects(pending); await socketClosed;
  await rejects(ssh.exec(input)); assert.equal(calls.length, 2);
});

test('stdout exact byte boundary and minimal return shape', async () => {
  const stdout = 'x'.repeat(4096);
  const ssh = createDockerSsh({ port: 1, bridge: path => path.endsWith('/hosts') ? { hosts: [host] } : { result: { ...success.result, stdout } } });
  assert.deepEqual(await ssh.exec(input), { exitCode: 0, stdout }); ssh.close();
});
