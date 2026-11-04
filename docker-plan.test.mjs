import test from 'node:test';
import assert from 'node:assert/strict';
import { createDockerPlans } from './docker-plan.js';

const source = () => ({ repository: 'ssal-team/XiAN-OA', branch: 'dev', head: 'a'.repeat(40) });
const release = (releaseId = 'dev-release-1') => ({ releaseId, head: 'b'.repeat(40), backendImage: 'registry.example/oa/backend@sha256:' + 'C'.repeat(64), frontendImage: 'registry.example/oa/frontend@sha256:' + 'd'.repeat(64), delivered: true, accepted: true });
function fixture(overrides = {}) {
  let time = 1000, serial = 0;
  const plans = createDockerPlans({ resolveDev: async () => source(), getUser: async () => ({ name: '刘道志' }), now: () => time, randomId: () => `plan-${++serial}`, ...overrides });
  return { ...plans, setTime: value => { time = value; } };
}

test('remote dev plans use trusted snapshots only and never claim execution', async () => {
  let calls = 0;
  const snapshot = source();
  const plans = fixture({ resolveDev: async () => { calls++; return snapshot; } });
  const result = await plans.check();
  assert.equal(calls, 1);
  assert.equal(result.planId, 'plan-1');
  assert.deepEqual(result.remote, source());
  assert.equal(result.sourceOrigin, 'github-remote-dev');
  assert.equal(result.status, 'awaiting-executor');
  assert.equal(result.deployable, false);
  assert.equal(result.expiresAt - result.createdAt, 300000);
  assert.equal(result.environment, 'dev');
  assert.equal('backendImage' in result, false);
  result.remote.head = '0'.repeat(40);
  snapshot.head = 'f'.repeat(40);
  assert.equal(plans.getPlan(result.planId).remote.head, 'a'.repeat(40));
  assert.equal((await plans.check(Object.create(null))).remote.head, 'f'.repeat(40));
  assert.equal(calls, 2);
});

test('check accepts only an empty plain data object before resolving remote', async () => {
  let calls = 0;
  const plans = fixture({ resolveDev: async () => { calls++; return source(); } });
  const invalid = [null, [], new Date(), 'dev', 1, Object.create({}), { directory: '/project' }, { head: 'a'.repeat(40) }, { backendImage: release().backendImage }, { frontendImage: release().frontendImage }, { name: '刘道志' }, { delivered: true }, { [Symbol('secret')]: true }, Object.defineProperty({}, 'hidden', { value: true })];
  for (const input of invalid) await assert.rejects(() => plans.check(input), /空对象/);
  assert.equal(calls, 0);
});

test('untrusted repository, branch and malformed remote heads fail closed', async () => {
  for (const value of [null, {}, { ...source(), repository: 'other/repo' }, { ...source(), branch: 'test' }, { ...source(), head: 'a'.repeat(39) }, { ...source(), head: 'a'.repeat(40) + '\n' }, { ...source(), head: 123 }]) {
    await assert.rejects(() => fixture({ resolveDev: async () => value }).check(), /远程 dev 快照/);
  }
  await assert.rejects(() => fixture({ resolveDev: async () => { throw new Error('remote unavailable'); } }).check(), /remote unavailable/);
});

test('plan cache expires exactly at five minutes and is bounded to 128 entries', async () => {
  const plans = fixture();
  const first = await plans.check();
  plans.setTime(first.expiresAt - 1);
  assert.equal(plans.getPlan(first.planId).planId, first.planId);
  plans.setTime(first.expiresAt);
  assert.throws(() => plans.getPlan(first.planId), error => error.status === 410);
  const ids = [];
  for (let i = 0; i < 129; i++) ids.push((await plans.check()).planId);
  assert.throws(() => plans.getPlan(ids[0]), error => error.status === 404);
  assert.equal(plans.getPlan(ids[1]).planId, ids[1]);
  assert.equal(plans.getPlan(ids.at(-1)).planId, ids.at(-1));
});

test('test promotion preserves the internally verified exact same image strings', async () => {
  let users = 0, resolves = 0;
  const plans = fixture({ getUser: async () => { users++; return { name: '刘道志' }; }, resolveDev: async () => { resolves++; throw new Error('should not rebuild from new dev HEAD'); } });
  const record = release();
  const registered = plans.recordDevRelease(record);
  record.backendImage = 'tampered';
  registered.frontendImage = 'tampered';
  const promoted = await plans.promotion({ releaseId: 'dev-release-1' });
  assert.equal(users, 2);
  assert.equal(resolves, 0);
  for (const [key, value] of Object.entries(release())) assert.equal(promoted[key], value);
  assert.equal(promoted.status, 'awaiting-executor');
  assert.equal(promoted.deployable, false);
  assert.equal(promoted.environment, 'test');
  assert.deepEqual(promoted.remote, { ...source(), head: release().head });
  promoted.backendImage = 'tampered';
  assert.equal(plans.getPlan(promoted.planId).backendImage, release().backendImage);
  plans.setTime(promoted.expiresAt);
  assert.throws(() => plans.getPlan(promoted.planId), /过期/);
});

test('promotion denies forged records, unaccepted dev and body identity/image overrides', async () => {
  const plans = fixture();
  for (const record of [{ ...release(), accepted: false }, { ...release(), delivered: false }, { ...release(), accepted: 'true' }]) assert.throws(() => plans.recordDevRelease(record), /交付并验收/);
  await assert.rejects(() => plans.promotion({ releaseId: release().releaseId }), /未找到/);
  plans.recordDevRelease(release());
  const invalid = [undefined, null, [], {}, { releaseId: 'unknown' }, { releaseId: 'dev-release-1', ...release() }, ...['name', 'user', 'head', 'backendImage', 'frontendImage', 'accepted', 'delivered', 'directory', 'environment', 'record', 'deployable'].map(key => ({ releaseId: 'dev-release-1', [key]: true })), { releaseId: 'dev-release-1', [Symbol('secret')]: true }];
  for (const body of invalid) await assert.rejects(() => plans.promotion(body));
  assert.throws(() => plans.recordDevRelease({ ...release(), backendImage: release().frontendImage }), /不允许替换/);
  assert.deepEqual(plans.recordDevRelease(release()), release());
});

test('promotion requires exact trusted user.name twice, not login or a cached identity', async () => {
  for (const user of [null, {}, { login: '刘道志' }, { name: ' 刘道志' }, { name: '刘道志 ' }, { name: 'other', login: '刘道志' }]) {
    const plans = fixture({ getUser: async () => user });
    plans.recordDevRelease(release());
    await assert.rejects(() => plans.promotion({ releaseId: release().releaseId }), error => error.status === 403);
  }
  let count = 0;
  const plans = fixture({ getUser: async () => ({ name: ++count === 1 ? '刘道志' : 'other' }) });
  plans.recordDevRelease(release());
  await assert.rejects(() => plans.promotion({ releaseId: release().releaseId }), error => error.status === 403);
  assert.equal(count, 2);
  assert.throws(() => plans.getPlan('plan-1'), /不存在/);
});

test('internal registration rejects mutable tags, malformed digests and accessor records', () => {
  const plans = fixture();
  for (const value of ['oa/api:latest', 'oa/api@sha256:' + 'a'.repeat(63), 'oa/api@sha256:' + 'g'.repeat(64), release().backendImage + '\n', 'registry.example:99999/oa@sha256:' + 'a'.repeat(64), 'user:password@registry/oa@sha256:' + 'a'.repeat(64), '$IMAGE', '']) {
    for (const field of ['backendImage', 'frontendImage']) assert.throws(() => plans.recordDevRelease({ ...release(), [field]: value }), /digest/);
  }
  for (const value of [null, [], {}, { ...release(), head: 'a'.repeat(40) + '\n' }, { ...release(), releaseId: 'a\n' }, { ...release(), password: 'not allowed' }]) assert.throws(() => plans.recordDevRelease(value));
  let calls = 0;
  const accessor = Object.defineProperty(release(), 'backendImage', { get() { calls++; return release().backendImage; } });
  assert.throws(() => plans.recordDevRelease(accessor));
  assert.equal(calls, 0);
});

test('verified release registry is independently bounded and cannot be forged by check', async () => {
  const plans = fixture();
  for (let i = 0; i < 129; i++) plans.recordDevRelease(release(`r-${i}`));
  await assert.rejects(() => plans.promotion({ releaseId: 'r-0' }), /未找到/);
  assert.equal((await plans.promotion({ releaseId: 'r-1' })).releaseId, 'r-1');
  const checked = await plans.check();
  await assert.rejects(() => plans.promotion({ releaseId: checked.planId }), /未找到/);
  assert.deepEqual(Object.keys(plans).sort(), ['check', 'getPlan', 'promotion', 'recordDevRelease', 'setTime'].sort());
});

test('server ID collisions and invalid clock fail without replacing a plan', async () => {
  const plans = fixture({ randomId: () => 'same-id' });
  const first = await plans.check();
  await assert.rejects(() => plans.check(), /duplicate/);
  assert.deepEqual(plans.getPlan(first.planId), first);
  await assert.rejects(() => fixture({ now: () => NaN }).check(), /clock/);
  assert.throws(() => createDockerPlans({ resolveDev: async () => source() }), /server functions/);
});
