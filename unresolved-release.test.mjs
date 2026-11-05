import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemporaryReleaseClient, createTemporaryReleaseTransport } from './temporary-release-client.js';
import { DEFAULT_RELEASE_PROFILE } from './release-profile.js';

const head = 'a'.repeat(40);
const refusal = 'Unresolved job blocks new deployment';
function profile() {
  const value = structuredClone(DEFAULT_RELEASE_PROFILE);
  for (const key of Object.keys(value.baseImages)) value.baseImages[key] = 'example/image@sha256:' + 'b'.repeat(64);
  return value;
}
function fixture({ team = true } = {}) {
  const p = profile(), calls = [], sources = [];
  let overview = { jobs: [] }, cleaned = 0;
  const client = createTemporaryReleaseClient({ profile: p, team, getUser: async () => ({ name: team ? '成员' : p.allowedNames.dev[0] }), source: {
    async resolve(input) { sources.push(['resolve', input]); return { ...input, head }; },
    async prepare(input) { sources.push(['prepare', input]); return { path: '/tmp/source.tar', sha256: 'c'.repeat(64), size: 12, cleanup() { cleaned++; } }; },
  }, transport: async request => {
    calls.push(request);
    if (request.action === 'overview') return overview;
    if (['check', 'promote', 'restore'].includes(request.action)) return {
      planId: request.action + '-plan', environment: request.action === 'promote' ? 'test' : request.body.environment || 'dev',
      ...(request.action === 'restore' ? { operation: 'restore' } : {}),
      remote: { repository: p.repository, branch: p.branch, head }, expiresAt: Date.now() / 1000 + 300,
    };
    return { jobId: 'new-job', status: 'pending' };
  } });
  return { client, calls, sources, cleaned: () => cleaned, overview(value) { overview = value; } };
}
const conflict = error => error.status === 409 && /任务记录未完成，服务器尚未提供活动核验，请核对\/升级/.test(error.message);
const knownConflict = error => error.status === 409 && /旧的未解决发布任务阻止新部署/.test(error.message);
const job = (environment, status) => ({ jobId: 'old-job', environment, status });
const start = (client, planId) => client.start({ planId, confirmation: true, databaseRiskAccepted: true });

for (const status of ['pending', 'running', 'uncertain']) {
  test(`check refuses dev ${status} before source resolution`, async () => {
    const f = fixture(); f.overview({ jobs: [job('dev', status)] });
    await assert.rejects(f.client.check(), conflict);
    assert.deepEqual(f.sources, []); assert.deepEqual(f.calls.map(x => x.action), ['overview']); f.client.close();
  });
  test(`start rechecks dev ${status} before preparation and consumes plan without retry`, async () => {
    const f = fixture(); const plan = await f.client.check();
    f.overview({ jobs: [job('dev', status)] });
    await assert.rejects(start(f.client, plan.planId), conflict);
    await assert.rejects(start(f.client, plan.planId), /计划未在当前连接检查/);
    assert.deepEqual(f.sources.map(x => x[0]), ['resolve']);
    assert.deepEqual(f.calls.map(x => x.action), ['overview', 'check', 'overview']); assert.equal(f.cleaned(), 0); f.client.close();
  });
}
for (const [activity, expected] of [
  [{ state: 'active' }, /发布人正在发布 dev（阶段：服务器编译；创建时间：2026-01-01T00:00:00\.000Z）/],
  [{ state: 'interrupted' }, /^上次发布已中断，待核对$/],
  [{ state: 'unknown' }, /^无法确认发布活动，暂不发布$/],
  [{ state: 'finished' }, /^无法确认发布活动，暂不发布$/],
  [null, /^无法确认发布活动，暂不发布$/],
  ['active', /^无法确认发布活动，暂不发布$/],
  [{}, /^无法确认发布活动，暂不发布$/],
  [{ state: 'unrecognized' }, /^无法确认发布活动，暂不发布$/],
]) {
  for (const status of ['pending', 'running', 'uncertain']) test(`activity ${JSON.stringify(activity)} keeps ${status} blocked before source work`, async () => {
    const f = fixture();
    const entry = { ...job('dev', status), actor: '发布人', stage: 'building', createdAt: 1767225600, activity };
    f.overview({ jobs: [entry] });
    await assert.rejects(f.client.check(), error => error.status === 409 && expected.test(error.message));
    assert.deepEqual(f.sources, []);
    f.overview({ jobs: [] }); const plan = await f.client.check(); f.overview({ jobs: [entry] });
    await assert.rejects(start(f.client, plan.planId), error => error.status === 409 && expected.test(error.message));
    assert.deepEqual(f.sources.map(x => x[0]), ['resolve']); assert.equal(f.calls.some(x => x.action === 'start'), false);
    f.client.close();
  });
}
test('active actor is control-free and bounded; arbitrary stage and unsafe time stay private', async () => {
  const f = fixture();
  f.overview({ jobs: [{ ...job('dev', 'running'), activity: { state: 'active' }, actor: '\u001b\n\r\u0085\u202e' + '甲'.repeat(90), stage: 'secret-stage-token', createdAt: 'secret-time' }] });
  await assert.rejects(f.client.check(), error => {
    assert.equal(error.status, 409); assert.ok(error.message.startsWith('甲'.repeat(80) + '正在发布 dev'));
    assert.equal(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(error.message), false);
    assert.equal(/secret|阶段|创建时间/.test(error.message), false); return true;
  });
  assert.deepEqual(f.sources, []); f.client.close();
});
for (const createdAt of [-1, 1.5, 253402300800, Number.MAX_SAFE_INTEGER, null]) test(`unsafe created time omitted: ${createdAt}`, async () => {
  const f = fixture(); f.overview({ jobs: [{ ...job('dev', 'running'), actor: null, stage: '__proto__', createdAt, activity: { state: 'active' } }] });
  await assert.rejects(f.client.check(), error => error.status === 409 && /^某位成员正在发布 dev；暂不重复发布$/.test(error.message)); f.client.close();
});
test('active publisher takes precedence over interrupted history only in the same environment', async () => {
  const f = fixture(); f.overview({ jobs: [
    { ...job('dev', 'uncertain'), activity: { state: 'interrupted' } },
    { ...job('test', 'running'), actor: '其他环境', activity: { state: 'active' } },
    { ...job('dev', 'running'), actor: '当前发布人', stage: 'health', activity: { state: 'active' } },
  ] });
  await assert.rejects(f.client.check(), error => error.status === 409 && /当前发布人正在发布 dev（阶段：健康检查）/.test(error.message) && !/其他环境|中断/.test(error.message)); f.client.close();
});
test('active test publisher names test environment before promotion start', async () => {
  const f = fixture(); const plan = await f.client.promotion({ releaseId: 'release' });
  f.overview({ jobs: [{ ...job('test', 'pending'), actor: '测试发布人', stage: 'queued', activity: { state: 'active' } }] });
  await assert.rejects(start(f.client, plan.planId), error => error.status === 409 && /测试发布人正在发布 test（阶段：排队中）/.test(error.message));
  assert.deepEqual(f.sources, []); f.client.close();
});
test('non-team client retains legacy behavior without overview preflight', async () => {
  const f = fixture({ team: false });
  f.overview({ jobs: [{ ...job('dev', 'running'), activity: { state: 'active' } }] });
  const plan = await f.client.check(); await start(f.client, plan.planId);
  assert.deepEqual(f.calls.map(x => x.action), ['check', 'start']); assert.equal(f.cleaned(), 1); f.client.close();
});
test('other environment unresolved jobs do not block dev source, pinned SHA or cleanup', async () => {
  const f = fixture(); f.overview({ jobs: [job('test', 'uncertain')] });
  const plan = await f.client.check(); await start(f.client, plan.planId);
  assert.deepEqual(f.sources.map(x => x[0]), ['resolve', 'prepare']); assert.equal(f.sources[1][1].head, head);
  assert.equal(f.cleaned(), 1); assert.deepEqual(f.calls.map(x => x.action), ['overview', 'check', 'overview', 'start']); f.client.close();
});
for (const status of ['pending', 'running', 'uncertain']) test(`test start blocks same environment ${status} without source`, async () => {
  const f = fixture(); const plan = await f.client.promotion({ releaseId: 'release' });
  f.overview({ jobs: [job('test', status)] }); await assert.rejects(start(f.client, plan.planId), conflict);
  assert.deepEqual(f.sources, []); assert.deepEqual(f.calls.map(x => x.action), ['promote', 'overview']); f.client.close();
});
test('test start ignores dev unresolved jobs and never prepares source', async () => {
  const f = fixture(); const plan = await f.client.promotion({ releaseId: 'release' });
  f.overview({ jobs: [job('dev', 'running')] }); await start(f.client, plan.planId);
  assert.deepEqual(f.sources, []); assert.equal(f.calls.at(-1).bundle, undefined); f.client.close();
});
for (const environment of ['dev', 'test']) test(`restore start also guards ${environment}`, async () => {
  const f = fixture(); const plan = await f.client.restore({ environment, jobId: 'old-job' });
  f.overview({ jobs: [job(environment, 'uncertain')] }); await assert.rejects(start(f.client, plan.planId), conflict);
  assert.deepEqual(f.sources, []); assert.deepEqual(f.calls.map(x => x.action), ['restore', 'overview']); f.client.close();
});
for (const overview of [{}, { jobs: null }, { jobs: {} }, { jobs: [null] }, { jobs: [{ status: 'running' }] }, { jobs: [job('prod', 'running')] }, { jobs: [job('dev', 'unknown')] }]) {
  test(`malformed overview fails closed: ${JSON.stringify(overview)}`, async () => {
    const f = fixture(); f.overview(overview); await assert.rejects(f.client.check(), { status: 503 });
    assert.deepEqual(f.sources, []); assert.deepEqual(f.calls.map(x => x.action), ['overview']); f.client.close();
  });
}
test('malformed start overview fails closed before preparation', async () => {
  const f = fixture(); const plan = await f.client.check(); f.overview({});
  await assert.rejects(start(f.client, plan.planId), { status: 503 });
  assert.deepEqual(f.sources.map(x => x[0]), ['resolve']); assert.equal(f.calls.some(x => x.action === 'start'), false); f.client.close();
});
test('finished jobs permit fresh check and start', async () => {
  const f = fixture(); f.overview({ jobs: ['delivered', 'failed', 'ready', 'accepted'].map(status => job('dev', status)) });
  const plan = await f.client.check(); await start(f.client, plan.planId); assert.equal(f.cleaned(), 1); f.client.close();
});
for (const json of [true, false]) test(`production nonzero exec refusal survives transport and call (${json ? 'JSON' : 'stderr'})`, async () => {
  const p = profile(); const transport = createTemporaryReleaseTransport({ port: 1, team: true, bridge: async path => {
    if (path === '/api/dsh-ssh/hosts') return { hosts: [{ ...p.target, user: 'member', auth: 'key', proxyJump: [] }] };
    return { result: { exitCode: 1, stdout: json ? JSON.stringify({ error: refusal }) : '', stderr: json ? '' : 'secret=private\nrelease.Refused: ' + refusal } };
  } });
  const client = createTemporaryReleaseClient({ profile: p, team: true, transport, getUser: async () => ({ name: '成员' }) });
  await assert.rejects(client.overview(), error => knownConflict(error) && !error.message.includes('private')); client.close();
});
for (const [reason, expected, status] of [[refusal, /旧的未解决发布任务阻止新部署/, 409], ['Existing services must be healthy', /服务不健康/, 503], ['Expected one existing container per service', /缺失或未运行/, 503], ['Another release operation is active', /已有发布操作正在执行/, 503], ['secret=private', /入口拒绝或未明确响应/, 503]]) {
  test(`direct response.error preserves only known refusal: ${reason}`, async () => {
    const client = createTemporaryReleaseClient({ profile: profile(), team: true, getUser: async () => ({ name: '成员' }), transport: async () => ({ error: reason }) });
    await assert.rejects(client.overview(), error => error.status === status && expected.test(error.message) && !error.message.includes('private')); client.close();
  });
}
test('near-miss refusal text is not exposed', async () => {
  const client = createTemporaryReleaseClient({ profile: profile(), team: true, getUser: async () => ({ name: '成员' }), transport: async () => ({ error: refusal + ' secret=private' }) });
  await assert.rejects(client.overview(), error => error.status === 503 && !error.message.includes('private') && !error.message.includes('旧的未解决')); client.close();
});
