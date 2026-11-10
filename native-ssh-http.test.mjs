import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { apply } from './index.js';

test('collaboration plugin no longer exposes native SSH settings or connection routes', async () => {
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
      assert.equal((await request(route, {}, token, 'GET')).status, 404);
      assert.equal((await request(route, {}, token)).status, 404);
      assert.equal((await request(route, { host: 'evil', command: 'whoami', privateKey: 'SECRET' }, token)).status, 404);
    }
  } finally { for (const dispose of disposers.reverse()) dispose(); }
});

test('production entry uses default DSH bridge without native SSH creation or fallback', async () => {
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /native-ssh|createNativeSsh|nativeSsh|sshNamespace|sshTarget|\.dsh-simple-github/);
  assert.match(source, /createTemporaryReleaseClient\(\{ port: ctx\.webServer\.port, team: true, profile: runtimeProfile, source: createLocalSourceBundle\(\), getUser \}\)/);
  assert.doesNotMatch(source, /bridge:|createTemporaryReleaseTransport/);
});
