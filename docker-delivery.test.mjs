import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createDockerDelivery } from './docker-delivery.js';

const head = 'c'.repeat(40);
const backendImage = `registry.example/team/backend@sha256:${'a'.repeat(64)}`;
const frontendImage = `registry.example/team/frontend@sha256:${'b'.repeat(64)}`;
function input(environment = 'dev') {
  return { environment, remote: { repository: 'ssal-team/XiAN-OA', branch: 'dev', head },
    artifact: { head, backendImage, frontendImage, provenanceVerified: true } };
}
function proof(environment = 'dev') {
  return { schema: 1, status: 'preflight-only', environment, head,
    checks: { linux: true, compose: true, metadata: true, fixedTemplate: true, imagesPresent: true, composeImages: true, legacyInactive: true } };
}
function harness(response = () => ({ code: 0, stdout: JSON.stringify(proof()) })) {
  const calls = [], uploads = [];
  return { calls, uploads, delivery: createDockerDelivery({ exec: async call => { calls.push(call); return response(call); }, upload: async call => uploads.push(call),
    command: () => { throw new Error('Local commands forbidden'); } }) };
}

test('default capability is disabled and invalid requests never invoke remote', async () => {
  await assert.rejects(createDockerDelivery().deliver(input()), /disabled/);
  const { delivery, calls } = harness();
  const mutations = [
    value => { value.environment = 'prod'; },
    value => { value.service = 'db'; },
    value => { value.remote.alias = 'other'; },
    value => { value.remote.repository = 'other/repo'; },
    value => { value.remote.branch = 'main'; },
    value => { value.remote.head += '\n'; },
    value => { value.artifact.head = 'd'.repeat(40); },
    value => { value.artifact.provenanceVerified = false; },
    value => { delete value.artifact.provenanceVerified; },
    value => { value.artifact.backendImage = `sha256:${'a'.repeat(64)}`; },
    value => { value.artifact.frontendImage = 'image:latest'; },
    value => { value.artifact.backendImage += '\n'; },
    value => { value.artifact.backendImage = `registry.example:99999/app@sha256:${'a'.repeat(64)}`; },
    value => { value.artifact.backendImage = '$(touch /tmp/no)'; },
    value => { value.artifact.localImageId = { backend: `sha256:${'a'.repeat(64)}` }; },
    value => { Object.defineProperty(value.artifact, 'backendImage', { get() { throw Error('getter executed'); } }); },
  ];
  for (const mutate of mutations) { const value = input(); mutate(value); await assert.rejects(delivery.deliver(value)); }
  assert.equal(calls.length, 0);
  assert.throws(() => createDockerDelivery({ env: { SECRET: 'never-forward' } }), /plain data/);
});

test('valid existing digest images yield only explicitly limited preflight evidence', async () => {
  const { delivery, calls, uploads } = harness();
  const result = await delivery.deliver(input());
  assert.equal(result.status, 'preflight-only');
  assert.equal(result.preflightVerified, true);
  for (const key of ['deployable', 'delivered', 'verified']) assert.equal(result[key], false);
  for (const key of ['backendImage', 'frontendImage', 'accepted', 'localImageId']) assert.equal(Object.hasOwn(result, key), false);
  assert.equal(uploads.length, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['alias', 'command', 'timeoutMs']);
  assert.equal(calls[0].alias, 'xian-oa-test');
  const script = calls[0].command;
  assert.match(script, /^sudo -n \/usr\/bin\/python3 -I - dev /);
  assert.match(script, /RepoDigests/);
  assert.match(script, /services\['backend'\]\.get\('image'\)==backend/);
  assert.match(script, /'--env-file','\/dev\/null'/);
  assert.match(script, /fcntl\.LOCK_EX\|fcntl\.LOCK_NB/);
  assert.match(script, /container.env',secret=True/);
  assert.doesNotMatch(script, /docker','(?:pull|load|save)'/);
  assert.doesNotMatch(script, /'up'|'start'|'stop'|os\.mkdir|os\.unlink|open\([^\n]+['"]w/);
  assert.match(result.limitations.join(' '), /No deployment marker is consumed/);
});

test('static isolated Python compiles locally without running the remote program', async () => {
  const { delivery, calls } = harness();
  await delivery.deliver(input());
  const script = calls[0].command.split("<<'XIAN_OA_PREFLIGHT_PY'\n")[1].split('XIAN_OA_PREFLIGHT_PY')[0];
  const result = spawnSync('python3', ['-I', '-c', "import sys; compile(sys.stdin.read(), '<preflight>', 'exec')"], { input: script, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test('test promotion uses same supplied digests, never rebuilds or claims delivery', async () => {
  const { delivery, calls } = harness(() => ({ exitCode: 0, stdout: JSON.stringify(proof('test')) }));
  const result = await delivery.deliver(input('test'));
  assert.equal(result.delivered, false);
  assert.match(calls[0].command, new RegExp(`- test ${head} ${backendImage} ${frontendImage}`));
});

test('remote failures/config output are not leaked and incomplete or forged success is refused', async () => {
  for (const response of [
    { code: 1, stdout: 'SECRET', stderr: 'SECRET' },
    { code: 0, exitCode: 1, stdout: 'SECRET' },
    { stdout: JSON.stringify(proof()) },
    { code: 0, stdout: 'SECRET' },
    { code: 0, stdout: 'x'.repeat(2049) },
    { code: 0, stdout: JSON.stringify({ ...proof(), status: 'delivered' }) },
    { code: 0, stdout: JSON.stringify({ ...proof(), environment: 'test' }) },
    { code: 0, stdout: JSON.stringify({ ...proof(), checks: { ...proof().checks, imagesPresent: false } }) },
    { code: 0, stdout: JSON.stringify({ ...proof(), secret: 'SECRET' }) },
  ]) {
    const { delivery } = harness(() => response);
    await assert.rejects(delivery.deliver(input()), error => !error.message.includes('SECRET'));
  }
  const { delivery } = harness(() => { throw Error('SECRET'); });
  await assert.rejects(delivery.deliver(input()), error => !error.message.includes('SECRET'));
});

test('snapshot values cannot be mutated during asynchronous exec', async () => {
  const value = input();
  const { delivery } = harness(() => {
    value.remote.head = 'd'.repeat(40);
    value.artifact.backendImage = 'bad';
    return { code: 0, stdout: JSON.stringify(proof()) };
  });
  assert.equal((await delivery.deliver(value)).head, head);
});
