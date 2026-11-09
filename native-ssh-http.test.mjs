import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { apply } from './index.js';

test('native SSH settings are local CSRF-protected strict routes and never accept host/command/secrets', async () => {
  let handler; const disposers = [];
  apply({ effect(f) { const dispose = f(); if (typeof dispose === 'function') disposers.push(dispose); }, webServer: { port: 51234, register(value) { handler = value.handler; return () => {}; } } }, { dockerRuntime: null });
  async function request(name, body = {}, token, method = 'POST') {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url: '/simple-github/api/' + name, headers: { host: '127.0.0.1:51234', origin: 'http://127.0.0.1:51234', 'content-type': 'application/json', ...(token ? { 'x-simple-git-token': token } : {}) }, socket: { remoteAddress: '127.0.0.1', localPort: 51234 } });
    let status, value;
    await handler(req, { setHeader() {}, writeHead(code) { status = code; }, end(data) { value = JSON.parse(data); } });
    return { status, value };
  }
  try {
    const token = (await request('status', {}, undefined, 'GET')).value.csrfToken;
    for (const route of ['ssh-key-discover', 'ssh-config-read', 'ssh-config-save', 'ssh-host-scan', 'ssh-host-trust', 'ssh-connection-test']) {
      assert.equal((await request(route)).status, 403);
      assert.equal((await request(route, {}, token, 'GET')).status, 405);
      assert.equal((await request(route, { host: 'evil', command: 'whoami', privateKey: 'SECRET' }, token)).status, 400);
    }
    const result = await request('ssh-config-read', {}, token);
    assert.equal(result.status, 200);
    assert.equal(result.value.host, '119.45.50.213');
    assert.equal(result.value.port, 22);
    assert.equal(Object.hasOwn(result.value, 'privateKey'), false);
    assert.equal((await request('ssh-config-save', { user: 'root', privateKeyPath: '/unused' }, token)).status, 400);
    for (const body of [{directory:'/arbitrary'}, {home:'C:\\'}, {platform:'win32'}]) assert.equal((await request('ssh-key-discover', body, token)).status, 400);
    for (const body of [{ user: 'member', privateKeyPath: '/unused', privateKey: 'SECRET' }, { user: 'member', privateKeyPath: '/unused', passphrase: 'SECRET' }]) {
      assert.equal((await request('ssh-config-save', body, token)).status, 400);
    }
    assert.equal((await request('ssh-host-trust', { fingerprint: 'SHA256:unscanned' }, token)).status, 409);
  } finally { for (const dispose of disposers.reverse()) dispose(); }
});
