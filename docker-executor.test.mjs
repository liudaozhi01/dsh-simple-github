import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createDockerExecutor } from './docker-executor.js';
import { createDockerPlans } from './docker-plan.js';

const remote = { repository: 'ssal-team/XiAN-OA', branch: 'dev', head: 'a'.repeat(40) };
const images = { backendImage: 'registry.example/oa/backend@sha256:' + 'b'.repeat(64), frontendImage: 'registry.example/oa/frontend@sha256:' + 'C'.repeat(64) };
const evidence = () => ({ ...images, delivered: true, healthy: true });
const request = planId => ({ planId, confirmation: true, databaseRiskAccepted: true });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(options = {}) {
  let time = 1000, user = { name: '开发人员' }, builds = [], deliveries = [], records = [];
  const plans = createDockerPlans({ resolveDev: async () => remote, getUser: async () => user, now: () => time });
  const executor = createDockerExecutor({
    plans: { getPlan: plans.getPlan, recordDevRelease: record => { records.push({ ...record }); return plans.recordDevRelease(record); } },
    build: async input => { builds.push(input); return { head: remote.head, ...images, provenanceVerified: true, privateArtifact: 'secret-artifact', logs: 'password=hidden' }; },
    deliver: async input => { deliveries.push(input); return evidence(); },
    getUser: async () => user, now: () => time, ...options,
  });
  return { executor, plans, builds, deliveries, records, setUser: value => { user = value; }, setTime: value => { time = value; } };
}
async function finish(executor, jobId) {
  for (let i = 0; i < 20; i++) {
    const result = executor.status(jobId);
    if (!['pending', 'running'].includes(result.status)) return result;
    await setImmediate();
  }
  assert.fail('Mock job did not settle');
}

test('dev wrong source/provenance blocks delivery and digest substitution cannot become accepted', async () => {
  for (const artifact of [{ ...images, head: 'e'.repeat(40), provenanceVerified: true }, { ...images, head: remote.head, provenanceVerified: false }]) {
    const f = fixture({ build: async () => artifact });
    const job = await f.executor.start(request((await f.plans.check()).planId));
    assert.equal((await finish(f.executor, job.jobId)).status, 'failed');assert.equal(f.deliveries.length, 0);
  }
  const f = fixture({ deliver: async () => ({ ...evidence(), backendImage: images.frontendImage }) });
  const job = await f.executor.start(request((await f.plans.check()).planId));
  assert.equal((await finish(f.executor, job.jobId)).status, 'uncertain');
  await assert.rejects(() => f.executor.accept({ jobId: job.jobId, confirmation: true }));assert.equal(f.records.length, 0);
});

test('read-only reconciliation recovers original uncertain delivery without replay or automatic acceptance', async () => {
  let queries=0;const f=fixture({deliver:async()=>{throw Error('disconnect');},query:async expected=>{queries++;return {schema:1,...expected,phase:'applied',backendHealthy:true,frontendHealthy:true,observedAt:1000};}});
  const job=await f.executor.start(request((await f.plans.check()).planId));assert.equal((await finish(f.executor,job.jobId)).status,'uncertain');
  await assert.rejects(()=>f.executor.reconcile({jobId:job.jobId,backendImage:images.backendImage}));
  const recovered=await f.executor.reconcile({jobId:job.jobId});assert.equal(recovered.status,'delivered');assert.equal(recovered.accepted,false);assert.equal(f.records.length,0);assert.equal(f.builds.length,1);assert.equal(queries,1);
  await assert.rejects(()=>f.executor.reconcile({jobId:job.jobId}));await f.executor.accept({jobId:job.jobId,confirmation:true});assert.equal(f.records.length,1);
});
test('missing marker and query failures retain uncertainty without rebuilding',async()=>{
  for(const query of [async expected=>({schema:1,...expected,phase:'absent',backendHealthy:true,frontendHealthy:true,observedAt:1000}),async()=>{throw Error('secret');}]){
    const f=fixture({deliver:async()=>{throw Error('lost');},query});const job=await f.executor.start(request((await f.plans.check()).planId));await finish(f.executor,job.jobId);assert.equal((await f.executor.reconcile({jobId:job.jobId})).status,'uncertain');assert.equal(f.builds.length,1);assert.equal(f.records.length,0);
  }
});

test('mandatory trusted injection, idle status and strict start/accept HTTP fields', async () => {
  assert.throws(() => createDockerExecutor(), /Trusted/);
  for (const key of ['plans', 'build', 'deliver', 'getUser', 'now']) assert.throws(() => createDockerExecutor({ plans: { getPlan() {}, recordDevRelease() {} }, build() {}, deliver() {}, getUser() {}, now: Date.now, [key]: null }), /Trusted/);
  const { executor, plans, builds } = fixture();
  assert.deepEqual(executor.status(), { status: 'idle' });
  const { planId } = await plans.check();
  for (const value of [undefined, null, [], {}, { ...request(planId), environment: 'test' }, { ...request(planId), directory: '/tmp' }, { ...request(planId), uid: 1 }, { ...request(planId), backendBase: images.backendImage }, { ...request(planId), name: '刘道志' }, { ...request(planId), backendImage: images.backendImage }, { ...request(planId), confirmation: 1 }, { ...request(planId), databaseRiskAccepted: false }, Object.defineProperty(request(planId), 'secret', { get() { assert.fail('getter executed'); } }), { ...request(planId), [Symbol()]: true }]) {
    await assert.rejects(() => executor.start(value));
  }
  await assert.rejects(() => executor.accept({ jobId: 'unknown', confirmation: true, backendImage: images.backendImage }));
  assert.equal(builds.length, 0);
});

test('dev builds locked remote only; delivery is not acceptance; acceptance records real evidence', async () => {
  const f = fixture();
  const plan = await f.plans.check();
  const started = await f.executor.start(request(plan.planId));
  assert.equal(started.status, 'pending');
  assert.equal(started.id, started.jobId);
  const done = await finish(f.executor, started.jobId);
  assert.equal(done.status, 'delivered');
  assert.equal(done.accepted, false);
  assert.equal(f.records.length, 0);
  assert.deepEqual(f.builds, [{ remote }]);
  assert.equal(f.deliveries[0].environment, 'dev');
  assert.equal(f.deliveries[0].jobId, started.jobId);
  assert.deepEqual(f.deliveries[0].remote, remote);
  assert.equal(JSON.stringify(done).includes('hidden'), false);
  assert.equal(JSON.stringify(done).includes('privateArtifact'), false);
  done.backendImage = 'client-tampering';
  f.setUser({ name: '另一位有效验收人' });
  const accepted = await f.executor.accept({ jobId: started.jobId, confirmation: true });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.accepted, true);
  assert.deepEqual(f.records, [{ releaseId: started.jobId, head: remote.head, ...images, delivered: true, accepted: true }]);
  await assert.rejects(() => f.executor.accept({ jobId: started.jobId, confirmation: true }), /未验收/);
  await assert.rejects(() => f.executor.start(request(plan.planId)), /已使用/);
});

test('identity required before any execution and rechecked before delivery/after delivery/accept', async () => {
  for (const user of [null, {}, { login: '刘道志' }, { name: '' }, { name: '   ' }]) {
    const f = fixture(); f.setUser(user);
    await assert.rejects(async () => f.executor.start(request((await f.plans.check()).planId)), error => error.status === 403);
    assert.equal(f.builds.length, 0);
  }
  const gate = deferred();
  const f = fixture({ build: async () => { await gate.promise; return {}; } });
  const first = await f.executor.start(request((await f.plans.check()).planId));
  f.setUser(null); gate.resolve();
  assert.equal((await finish(f.executor, first.jobId)).status, 'failed');
  assert.equal(f.deliveries.length, 0);
  const g = fixture({ deliver: async () => { g.setUser(null); return evidence(); } });
  const second = await g.executor.start(request((await g.plans.check()).planId));
  assert.equal((await finish(g.executor, second.jobId)).status, 'uncertain');
  assert.equal(g.records.length, 0);
  const h = fixture();
  const third = await h.executor.start(request((await h.plans.check()).planId));
  await finish(h.executor, third.jobId); h.setUser({ name: '' });
  await assert.rejects(() => h.executor.accept({ jobId: third.jobId, confirmation: true }), error => error.status === 403);
  assert.equal(h.records.length, 0);
});

test('mutex covers pending identity/build/delivery and rejects duplicate starts', async () => {
  const gate = deferred();
  const f = fixture({ getUser: async () => { await gate.promise; return { name: 'valid' }; } });
  const plan = await f.plans.check();
  const starting = f.executor.start(request(plan.planId));
  await assert.rejects(() => f.executor.start(request(plan.planId)), /正在执行/);
  gate.resolve();
  const started = await starting;
  await finish(f.executor, started.jobId);
  await assert.rejects(() => f.executor.start(request(plan.planId)), /已使用/);
});

test('build errors fail, disconnected deliver and malformed proof are uncertain without retry or record', async () => {
  for (const options of [
    { build: async () => { throw new Error('password=build-secret'); } },
    { deliver: async () => { throw new Error('token=disconnected-secret'); } },
    ...[null, {}, { ...evidence(), healthy: false }, { ...evidence(), backendImage: 'oa:latest' }, { ...evidence(), frontendImage: images.frontendImage + '\n' }, { ...evidence(), delivered: 1 }].map(value => ({ deliver: async () => value })),
  ]) {
    const f = fixture(options), plan = await f.plans.check();
    const started = await f.executor.start(request(plan.planId));
    const done = await finish(f.executor, started.jobId);
    assert.equal(done.status, options.build ? 'failed' : 'uncertain');
    assert.equal(JSON.stringify(done).includes('secret'), false);
    assert.equal(f.records.length, 0);
    await assert.rejects(() => f.executor.start(request(plan.planId)), /已使用/);
    await assert.rejects(() => f.executor.accept({ jobId: started.jobId, confirmation: true }));
  }
});

async function promote(f) {
  f.plans.recordDevRelease({ releaseId: 'trusted-dev', head: remote.head, ...images, delivered: true, accepted: true });
  f.setUser({ name: '刘道志' });
  return f.plans.promotion({ releaseId: 'trusted-dev' });
}
test('test delivers exact original digests without build, requires 刘道志 before and after', async () => {
  const f = fixture(), plan = await promote(f);
  const started = await f.executor.start(request(plan.planId));
  assert.equal((await finish(f.executor, started.jobId)).status, 'delivered');
  assert.deepEqual(f.deliveries[0].artifact, images);
  assert.equal(f.builds.length, 0);
  assert.equal(f.records.length, 0);
  await assert.rejects(() => f.executor.accept({ jobId: started.jobId, confirmation: true }));
  for (const user of [{ name: '开发人员' }, { login: '刘道志' }, { name: ' 刘道志' }]) {
    const g = fixture(), testPlan = await promote(g); g.setUser(user);
    await assert.rejects(() => g.executor.start(request(testPlan.planId)), error => error.status === 403);
    assert.equal(g.deliveries.length, 0);
  }
  const h = fixture({ deliver: async () => { h.setUser({ name: '其他人' }); return evidence(); } });
  const changing = await h.executor.start(request((await promote(h)).planId));
  assert.equal((await finish(h.executor, changing.jobId)).status, 'uncertain');
});

test('test digest substitution even just case differences is uncertain', async () => {
  const f = fixture({ deliver: async () => ({ ...evidence(), frontendImage: images.frontendImage.toLowerCase() }) });
  const started = await f.executor.start(request((await promote(f)).planId));
  assert.equal((await finish(f.executor, started.jobId)).status, 'uncertain');
  assert.equal(f.records.length, 0);
});

test('used IDs remain bounded without evicting valid IDs; expired authoritative plans cannot replay', async () => {
  const f = fixture({ build: async () => { throw new Error('mock build fail'); } });
  let first;
  for (let i = 0; i < 128; i++) {
    const plan = await f.plans.check(); first ??= plan;
    const job = await f.executor.start(request(plan.planId));
    await finish(f.executor, job.jobId);
  }
  const extra = await f.plans.check();
  await assert.rejects(() => f.executor.start(request(extra.planId)), error => error.status === 429);
  // First plan may be evicted by plans, but executor still must reject its consumed ID.
  await assert.rejects(() => f.executor.start(request(first.planId)), /已使用/);
  f.setTime(first.expiresAt);
  await assert.rejects(() => f.executor.start(request(first.planId)));
  const fresh = await f.plans.check();
  const started = await f.executor.start(request(fresh.planId));
  assert.equal((await finish(f.executor, started.jobId)).status, 'failed');
});

test('plan expires during initial identity resolution without consuming or executing', async () => {
  const gate = deferred();
  const f = fixture({ getUser: async () => { await gate.promise; return { name: 'valid' }; } });
  const plan = await f.plans.check();
  const starting = f.executor.start(request(plan.planId));
  f.setTime(plan.expiresAt); gate.resolve();
  await assert.rejects(() => starting);
  assert.equal(f.builds.length, 0);
  assert.equal(f.deliveries.length, 0);
  assert.deepEqual(f.executor.status(), { status: 'idle' });
});

test('test identity cannot change between authorization and delivery', async () => {
  let checks = 0;
  const f = fixture({ getUser: async () => ({ name: ++checks <= 2 ? '刘道志' : '其他人' }) });
  const plan = await promote(f);
  const started = await f.executor.start(request(plan.planId));
  assert.equal((await finish(f.executor, started.jobId)).status, 'failed');
  assert.equal(f.builds.length, 0);
  assert.equal(f.deliveries.length, 0);
});

test('acceptance mutex prevents duplicate trusted records', async () => {
  const gate = deferred(); let records = 0;
  const f = fixture({ plans: {
    getPlan: id => f.plans.getPlan(id),
    recordDevRelease: async () => { records++; await gate.promise; },
  } });
  const started = await f.executor.start(request((await f.plans.check()).planId));
  await finish(f.executor, started.jobId);
  const accepting = f.executor.accept({ jobId: started.jobId, confirmation: true });
  await assert.rejects(() => f.executor.accept({ jobId: started.jobId, confirmation: true }), /正在执行/);
  await assert.rejects(() => f.executor.start(request((started.planId))), /正在执行/);
  gate.resolve();
  assert.equal((await accepting).accepted, true);
  assert.equal(records, 1);
});

test('expired/invalid remote plans and broken clock fail closed; record failure cannot retry', async () => {
  const f = fixture(), plan = await f.plans.check();
  f.setTime(plan.expiresAt);
  await assert.rejects(() => f.executor.start(request(plan.planId)));
  for (const changed of [{ environment: 'production' }, { remote: { ...remote, branch: 'test' } }, { remote: { ...remote, repository: 'other/repo' } }, { expiresAt: Infinity }]) {
    const g = fixture({ plans: { getPlan: () => ({ ...plan, ...changed }), recordDevRelease() {} } });
    await assert.rejects(() => g.executor.start(request(plan.planId)));
    assert.equal(g.builds.length, 0);
  }
  const h = fixture({ plans: { getPlan: () => plan, recordDevRelease: () => { throw new Error('password=secret'); } } });
  const started = await h.executor.start(request(plan.planId));
  await finish(h.executor, started.jobId);
  await assert.rejects(() => h.executor.accept({ jobId: started.jobId, confirmation: true }), /不会自动重试/);
  assert.equal(h.executor.status().status, 'uncertain');
  await assert.rejects(() => h.executor.accept({ jobId: started.jobId, confirmation: true }));
  const broken = fixture({ now: () => NaN });
  assert.throws(() => broken.executor.status(), error => error.status === 503);
});
