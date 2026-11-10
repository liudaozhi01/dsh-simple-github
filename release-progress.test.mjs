import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createReleaseProgress, reportReleaseProgress } from './release-progress.js';
import { createLocalSourceBundle } from './local-source-bundle.js';
import { createTemporaryReleaseClient, createTemporaryReleaseTransport } from './temporary-release-client.js';
import { DEFAULT_RELEASE_PROFILE } from './release-profile.js';
import { Readable } from 'node:stream';
import { apply } from './index.js';
const head = 'a'.repeat(40);
function profile() {
  const p = structuredClone(DEFAULT_RELEASE_PROFILE);
  for (const key of Object.keys(p.baseImages)) p.baseImages[key] = `reviewed/${key.toLowerCase()}@sha256:${'b'.repeat(64)}`;
  return p;
}

test('snapshots are bounded, isolated, safe and stop elapsed time on completion/failure', () => {
  let time = 100;
  const tracker = createReleaseProgress({ now: () => time });
  assert.equal(tracker.snapshot().state, 'idle');
  const update = tracker.begin();
  assert.throws(() => tracker.begin(), { status: 409 });
  time = 150; update({ stage: 'source-downloading', bytes: 12, totalBytes: Infinity, path: '/private', error: 'secret' });
  update({ stage: '/private/secret', bytes: 99 });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.elapsedMs, 50);
  assert.deepEqual(snapshot.completedStages, [{ stage: 'authorizing', durationMs: 50 }]);
  assert.equal(snapshot.bytes, 12); assert.equal(snapshot.totalBytes, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|private/);
  snapshot.completedStages[0].durationMs = 999;
  assert.equal(tracker.snapshot().completedStages[0].durationMs, 50);
  time = 200; tracker.finish(false); time = 1000;
  assert.equal(tracker.snapshot().elapsedMs, 100); assert.equal(tracker.snapshot().state, 'failed');
  assert.deepEqual(tracker.snapshot().completedStages.at(-1), { stage: 'source-downloading', durationMs: 50 });
  const next = tracker.begin(); update({ stage: 'submitting' });
  assert.equal(tracker.snapshot().stage, 'authorizing');
  for (let i = 0; i < 100; i++) next({ stage: i % 2 ? 'preflight' : 'submitting' });
  assert.equal(tracker.snapshot().completedStages.length, 64);
  tracker.finish(true); assert.equal(tracker.snapshot().state, 'completed');
  assert.doesNotThrow(() => reportReleaseProgress(() => { throw Error('UI failed'); }, 'preflight'));
});

test('actual source, client and team transport emit safe progress while preserving hash, seal and one-use start', async t => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'release-progress-test-'));
  t.after(() => rm(baseDirectory, { recursive: true, force: true }));
  const p = profile(), archive = gzipSync(Buffer.alloc(1024)), events = [], commands = [], uploads = [];
  const source = createLocalSourceBundle({ baseDirectory,
    command: async () => ({ stdout: JSON.stringify({ ref: 'refs/heads/dev', object: { type: 'commit', sha: head } }) }),
    download: async ({ handle, onProgress }) => { await handle.writeFile(archive); reportReleaseProgress(onProgress, 'source-downloading', { bytes: archive.length }); },
  });
  const transport = createTemporaryReleaseTransport({ port: 1, team: true, bridge: async (path, { json, file }) => {
    if (path === '/api/dsh-ssh/hosts') return { hosts: [{ ...p.target, user: 'member', auth: 'key', proxyJump: [] }] };
    if (file) { uploads.push(file); return { ok: true }; }
    commands.push(json.command);
    const output = json.command.includes('xian-oa-team-entry.py') ? JSON.stringify({ jobId: 'job-1', status: 'pending' }) : '{}';
    return { result: { exitCode: 0, stdout: output } };
  } });
  t.after(() => transport.close());
  let startCalls = 0;
  const client = createTemporaryReleaseClient({ profile: p, team: true, source, getUser: async () => ({ name: 'member' }), transport: async request => {
    if (request.action === 'overview') return { jobs: [] };
    if (request.action === 'check') return { planId: 'p', environment: 'dev', remote: { repository: p.repository, branch: p.branch, head }, expiresAt: Date.now() / 1000 + 300 };
    startCalls++;
    assert.equal(request.bundle.sha256, createHash('sha256').update(archive).digest('hex'));
    return transport.request(request);
  } });
  await client.check();
  const tracker = createReleaseProgress(), update = tracker.begin();
  const result = await client.start({ planId: 'p', confirmation: true, databaseRiskAccepted: true }, { onProgress: event => { events.push(event); update(event); } });
  tracker.finish(true);
  assert.equal(result.jobId, 'job-1');
  const stages = events.map(event => event.stage);
  for (const stage of ['authorizing', 'preflight', 'source-preparing', 'source-resolving', 'source-downloading', 'source-hashing', 'upload-preparing', 'uploading', 'upload-sealing', 'submitting', 'cleanup']) assert.ok(stages.includes(stage), stage);
  assert.ok(stages.indexOf('source-hashing') < stages.indexOf('uploading'));
  assert.ok(stages.indexOf('upload-sealing') < stages.indexOf('submitting'));
  assert.equal(uploads.length, 1); assert.equal(startCalls, 1);
  assert.ok(commands.some(command => command.includes('os.fchmod(fd,0o600)')));
  assert.doesNotMatch(JSON.stringify(events), /path|sha256|member|repository/);
  await assert.rejects(client.start({ planId: 'p', confirmation: true, databaseRiskAccepted: true }));
  assert.equal(startCalls, 1);
});

test('HTTP progress is read-only, origin-guarded, live during start and rejects overlapping starts', async () => {
  let handler, release, started;
  const disposers = [], live = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const runtime = Object.fromEntries(['check', 'promotion', 'status', 'accept', 'reconcile'].map(method => [method, async () => ({})]));
  runtime.start = async (_body, { onProgress }) => { calls++; onProgress({ stage: 'source-downloading', bytes: 42, error: 'secret' }); started(); return pending; };
  apply({ effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    webServer: { port: 51234, register(route) { handler = route.handler; return () => {}; } } }, { dockerRuntime: runtime });
  async function request(name, { method = 'GET', token, origin = 'http://127.0.0.1:51234' } = {}) {
    const req = Readable.from([Buffer.from('{}')]);
    Object.assign(req, { method, url: '/simple-github/api/' + name, headers: { host: '127.0.0.1:51234', origin, 'content-type': 'application/json', ...(token ? { 'x-simple-git-token': token } : {}) }, socket: { remoteAddress: '127.0.0.1', localPort: 51234 } });
    let status, value;
    await handler(req, { setHeader() {}, writeHead(code) { status = code; }, end(text) { value = JSON.parse(text); } });
    return { status, value };
  }
  let submission;
  try {
    const token = (await request('status')).value.csrfToken;
    assert.equal((await request('docker-progress')).value.progress.state, 'idle');
    assert.equal((await request('docker-progress', { method: 'POST', token })).status, 405);
    assert.equal((await request('docker-progress?path=secret')).status, 400);
    assert.equal((await request('docker-progress', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('docker-start', { method: 'POST' })).status, 403);
    submission = request('docker-start', { method: 'POST', token });
    await live;
    const snapshot = await request('docker-progress');
    assert.equal(snapshot.status, 200); assert.equal(snapshot.value.progress.state, 'running');
    assert.equal(snapshot.value.progress.bytes, 42); assert.doesNotMatch(JSON.stringify(snapshot.value), /secret/);
    assert.equal((await request('docker-start', { method: 'POST', token })).status, 409);
    assert.equal(calls, 1);
    release({ status: 'pending', jobId: 'j1' });
    assert.equal((await submission).status, 200);
    assert.equal((await request('docker-progress')).value.progress.state, 'completed');
  } finally { release({}); await submission; for (const dispose of disposers.reverse()) dispose(); }
});

test('failing callback never bypasses real source SHA validation', async t => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'release-progress-failure-'));
  t.after(() => rm(baseDirectory, { recursive: true, force: true }));
  let downloads = 0;
  const source = createLocalSourceBundle({ baseDirectory,
    command: async () => ({ stdout: JSON.stringify({ ref: 'refs/heads/dev', object: { type: 'commit', sha: 'b'.repeat(40) } }) }),
    download: async () => { downloads++; },
  });
  await assert.rejects(source.prepare({ repository: 'ssal-team/XiAN-OA', branch: 'dev', head }, { onProgress() { throw Error('consumer'); } }), /changed from the locked head/);
  assert.equal(downloads, 0);
});
