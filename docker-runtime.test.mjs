import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createDockerRuntime } from './docker-runtime.js';

const head = 'a'.repeat(40), digest = `sha256:${'d'.repeat(64)}`;
const ids = { backend: `sha256:${'b'.repeat(64)}`, frontend: `sha256:${'c'.repeat(64)}` };
const backendBase = `registry.example/java@sha256:${'e'.repeat(64)}`;
const frontendBase = `registry.example/nginx@sha256:${'f'.repeat(64)}`;
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t, hooks = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'xian-runtime-test-'));
  t.after(async () => { // Test-owned canonical mkdtemp root only.
    assert.equal(await realpath(directory), directory);
    await rm(directory, { recursive: true, force: true });
  });
  const journalDirectory = join(directory, 'journal');
  await mkdir(journalDirectory, { mode: 0o700 });
  const calls = [], tags = new Map(), templates = [], sources = [];
  let runtime, userCalls = 0;
  const options = {
    backendBase, frontendBase, backendRepository: 'registry.example/oa/backend', frontendRepository: 'registry.example/oa/frontend',
    dockerConfig: join(directory, 'publisher-config'), journalDirectory, path: '/mock/bin', now: () => 1000,
    resolveDev: async () => ({ repository: 'ssal-team/XiAN-OA', branch: 'dev', head }),
    getUser: async () => { userCalls++; await hooks.user?.(userCalls); return { name: '刘道志' }; },
    command: async (executable, args, settings) => {
      calls.push({ executable, args, settings });
      await hooks.command?.(executable, args, settings);
      let stdout = '', stderr = '';
      if (executable === 'git') {
        if (args.includes('init')) sources.push(settings.cwd);
        if (args.includes('rev-parse')) stdout = head;
      }
      if (executable === 'java') stderr = 'openjdk version "21.0.5"';
      if (executable === 'mvn') {
        await mkdir(join(settings.cwd, 'backend', 'target'), { recursive: true });
        await mkdir(join(settings.cwd, 'dist'), { recursive: true });
        await writeFile(join(settings.cwd, 'backend', 'target', 'app.jar'), 'mock jar');
        await writeFile(join(settings.cwd, 'dist', 'index.html'), '<html>mock</html>');
      }
      if (executable === 'docker') {
        if (args[0] === 'build') {
          const role = settings.cwd.endsWith('/backend') ? 'backend' : 'frontend';
          tags.set(args[args.indexOf('--tag') + 1], ids[role]);
          templates.push(await readFile(join(settings.cwd, 'Dockerfile'), 'utf8'));
        }
        if (args[0] === 'image' && args[1] === 'inspect') stdout = tags.get(args.at(-1)) || args.at(-1);
        if (args[0] === 'image' && args[1] === 'tag') tags.set(args[3], args[2]);
        if (args[0] === 'manifest') stdout = JSON.stringify({ Descriptor: { digest, mediaType: 'application/vnd.oci.image.manifest.v1+json' }, SchemaV2Manifest: { config: { digest: args.at(-1).includes('/backend') ? ids.backend : ids.frontend } } });
      }
      return { stdout, stderr, truncated: false }; // core.runCommand success has no exit code.
    },
    exec: async input => {
      calls.push({ ssh: input });
      const tokens = input.command.split('\n')[0].split(' ');
      const [mode, jobId, environment, sourceHead, backendImage, frontendImage] = tokens.slice(5);
      await hooks.exec?.(mode, input);
      return { exitCode: 0, stdout: JSON.stringify({ schema: 1, jobId, environment, head: sourceHead, backendImage, frontendImage, phase: 'applied', backendHealthy: true, frontendHealthy: true, observedAt: 1000 }) };
    },
  };
  async function open(overrides = {}) { runtime = await createDockerRuntime({ ...options, ...overrides }); return runtime; }
  t.after(async () => { if (runtime) await runtime.close().catch(() => {}); });
  return { options, open, calls, templates, sources, journalDirectory };
}
async function settled(runtime, id) {
  for (let n = 0; n < 10000; n++) {
    const status = runtime.status(id);
    if (!['pending', 'running'].includes(status.status)) return status;
    await setImmediate();
  }
  throw new Error('Mock execution did not settle.');
}
async function dev(runtime) {
  const plan = await runtime.check({});
  const started = await runtime.start({ planId: plan.planId, confirmation: true, databaseRiskAccepted: true });
  return settled(runtime, started.jobId);
}

test('startup fails fast for invalid dependencies/config without commands or journal side effects', async t => {
  const x = await fixture(t);
  for (const override of [
    { command: undefined }, { exec: undefined }, { getUser: null }, { resolveDev: null }, { now: null },
    { backendBase: 'java:21' }, { frontendBase: frontendBase + '\n' }, { backendBase: `registry.example:99999/java@${digest}` },
    { backendRepository: 'local' }, { frontendRepository: x.options.backendRepository }, { dockerConfig: 'relative' },
    { journalDirectory: undefined }, { journalDirectory: 'relative' }, { path: '/bin\n' }, { uid: 1 }, { directory: '/caller/source' },
  ]) await assert.rejects(() => createDockerRuntime({ ...x.options, ...override }));
  let accessed = false;
  const accessor = { ...x.options };
  Object.defineProperty(accessor, 'command', { get() { accessed = true; return x.options.command; } });
  await assert.rejects(() => createDockerRuntime(accessor));
  assert.equal(accessed, false);
  assert.deepEqual(x.calls, []);
  assert.deepEqual(await readdir(x.journalDirectory), []);
});

test('composes isolated remote build, fixed bases and UID/GID, publisher env, apply and durable promotion restore', async t => {
  const x = await fixture(t), runtime = await x.open();
  assert.deepEqual(x.calls, []);
  assert.equal(Object.isFrozen(runtime), true);
  await assert.rejects(() => runtime.check({ backendBase: 'override' }));
  const delivered = await dev(runtime);
  assert.equal(delivered.status, 'delivered');
  assert.equal(x.templates.length, 2);
  assert.match(x.templates[0], new RegExp(`^FROM ${backendBase.replaceAll('.', '\\.')}\\n`));
  assert.match(x.templates[1], /USER 10001:10001/);
  assert.match(x.templates[0], /COPY --chown=10001:10001/);
  assert.match(x.templates[1], /FROM registry\.example\/nginx@sha256:f{64}/);
  const fetch = x.calls.find(c => c.executable === 'git' && c.args.includes('fetch'));
  assert.ok(fetch.args.includes('https://github.com/ssal-team/XiAN-OA.git'));
  assert.ok(fetch.args.includes('refs/heads/dev'));
  assert.equal(fetch.settings.shell, false);
  assert.equal(fetch.settings.env.DOCKER_CONFIG, undefined);
  assert.notEqual(fetch.settings.cwd, process.cwd());
  for (const call of x.calls.filter(c => c.executable === 'docker' && c.args[0] !== 'build' && c.settings.cwd === '/')) {
    assert.deepEqual(call.settings.env, { PATH: '/mock/bin', HOME: '/nonexistent', DOCKER_CONFIG: x.options.dockerConfig, LANG: 'C', LC_ALL: 'C' });
    assert.equal(call.settings.shell, false);
  }
  const ssh = x.calls.find(c => c.ssh).ssh;
  assert.equal(ssh.alias, 'xian-oa-test');
  assert.match(ssh.command, /python3 -I - apply/);
  assert.match(ssh.command, /'--no-build','--pull','never','--no-recreate'/);
  await assert.rejects(() => runtime.promotion({ releaseId: delivered.jobId }));
  await runtime.accept({ jobId: delivered.jobId, confirmation: true });
  const text = await readFile(join(x.journalDirectory, 'docker-releases.jsonl'), 'utf8');
  assert.equal(JSON.parse(text.trim()).release.releaseId, delivered.jobId);
  assert.equal(JSON.parse(text.trim()).release.accepted, true);
  await runtime.close();
  const count = x.calls.length, restored = await x.open();
  const promotion = await restored.promotion({ releaseId: delivered.jobId });
  const job = await restored.start({ planId: promotion.planId, confirmation: true, databaseRiskAccepted: true });
  assert.equal((await settled(restored, job.jobId)).status, 'delivered');
  assert.equal(x.calls.slice(count).filter(c => c.executable).length, 0);
  assert.equal(promotion.backendImage, delivered.backendImage);
  await restored.close();
  for (const source of x.sources) await assert.rejects(() => lstat(source), { code: 'ENOENT' });
});

test('close rejects pending detached identity work, never closes its source, and can be retried after terminal status', async t => {
  const entered = deferred(), gate = deferred();
  const x = await fixture(t, { user: async n => { if (n === 2) { entered.resolve(); await gate.promise; } } });
  const runtime = await x.open(), plan = await runtime.check();
  const job = await runtime.start({ planId: plan.planId, confirmation: true, databaseRiskAccepted: true });
  await entered.promise;
  assert.equal(runtime.status(job.jobId).status, 'pending');
  await assert.rejects(() => runtime.close(), /pending\/running/);
  assert.ok(await lstat(join(x.journalDirectory, 'docker-releases.lock')));
  await assert.rejects(() => runtime.start({ planId: plan.planId, confirmation: true, databaseRiskAccepted: true }), /closed/);
  await assert.rejects(() => runtime.check(), /closed/);
  await assert.rejects(() => runtime.promotion({ releaseId: job.jobId }), /closed/);
  await assert.rejects(() => runtime.accept({ jobId: job.jobId, confirmation: true }), /closed/);
  await assert.rejects(() => runtime.reconcile({ jobId: job.jobId }), /closed/);
  gate.resolve();
  assert.equal((await settled(runtime, job.jobId)).status, 'delivered');
  await runtime.close();
  await runtime.close();
  await assert.rejects(() => lstat(join(x.journalDirectory, 'docker-releases.lock')), { code: 'ENOENT' });
});

test('close waits for start identity before evaluating detached job state and concurrent closes share outcome', async t => {
  const entered = deferred(), gate = deferred(), executing = deferred(), executeGate = deferred();
  const x = await fixture(t, { user: async n => {
    if (n === 1) { entered.resolve(); await gate.promise; }
    if (n === 2) { executing.resolve(); await executeGate.promise; }
  } });
  const runtime = await x.open(), plan = await runtime.check();
  const starting = runtime.start({ planId: plan.planId, confirmation: true, databaseRiskAccepted: true });
  await entered.promise;
  let finished = false;
  const closing = runtime.close();
  assert.strictEqual(runtime.close(), closing);
  const outcome = closing.then(() => { finished = true; }, error => { finished = true; return error; });
  await setImmediate();
  assert.equal(finished, false);
  gate.resolve();
  const job = await starting;
  await executing.promise;
  assert.match((await outcome).message, /pending\/running/);
  executeGate.resolve();
  assert.equal((await settled(runtime, job.jobId)).status, 'delivered');
  await runtime.close();
});

test('close waits for accept identity and persisted journal append before releasing lock', async t => {
  const entered = deferred(), gate = deferred();
  let hold = false;
  const x = await fixture(t, { user: async () => { if (hold) { entered.resolve(); await gate.promise; } } });
  const runtime = await x.open(), delivered = await dev(runtime);
  assert.equal(delivered.status, 'delivered');
  hold = true;
  const accepting = runtime.accept({ jobId: delivered.jobId, confirmation: true });
  await entered.promise;
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  await setImmediate();
  assert.equal(closed, false);
  await assert.rejects(() => runtime.accept({ jobId: delivered.jobId, confirmation: true }), /closed/);
  gate.resolve();
  assert.equal((await accepting).status, 'accepted');
  await closing;
  assert.equal(JSON.parse((await readFile(join(x.journalDirectory, 'docker-releases.jsonl'), 'utf8')).trim()).release.accepted, true);
  await assert.rejects(() => lstat(join(x.journalDirectory, 'docker-releases.lock')), { code: 'ENOENT' });
});

test('close retains running build source until job completes; no cancellation or timers', async t => {
  const entered = deferred(), gate = deferred();
  let checkout;
  const x = await fixture(t, { command: async (cmd, _args, settings) => { if (cmd === 'java') { checkout = settings.cwd; entered.resolve(); await gate.promise; } } });
  const runtime = await x.open(), plan = await runtime.check();
  const job = await runtime.start({ planId: plan.planId, confirmation: true, databaseRiskAccepted: true });
  await entered.promise;
  await assert.rejects(() => runtime.close(), /pending\/running/);
  assert.ok((await lstat(checkout)).isDirectory());
  gate.resolve();
  assert.equal((await settled(runtime, job.jobId)).status, 'delivered');
  await runtime.close();
});

test('uncertain apply is query-reconciled and close waits for in-flight reconciliation', async t => {
  const entered = deferred(), gate = deferred();
  const x = await fixture(t, { exec: async mode => { if (mode === 'apply') throw new Error('mock transport lost'); entered.resolve(); await gate.promise; } });
  const runtime = await x.open(), delivered = await dev(runtime);
  assert.equal(delivered.status, 'uncertain');
  const reconciling = runtime.reconcile({ jobId: delivered.jobId });
  await entered.promise;
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  await setImmediate();
  assert.equal(closed, false);
  gate.resolve();
  assert.equal((await reconciling).status, 'delivered');
  await closing;
  assert.equal(x.calls.filter(c => c.ssh).length, 2);
  assert.match(x.calls.filter(c => c.ssh)[1].ssh.command, /python3 -I - query/);
});

test('journal pre-existing lock remains untouched; poisoned write prevents acceptance/promotion and retains lock', async t => {
  const x = await fixture(t), lock = join(x.journalDirectory, 'docker-releases.lock');
  await writeFile(lock, 'operator review', { mode: 0o600 });
  await assert.rejects(() => createDockerRuntime(x.options), { code: 'EEXIST' });
  assert.equal(await readFile(lock, 'utf8'), 'operator review');
  assert.deepEqual(x.calls, []);
  // Remove only this fixture-owned lock after explicitly checking its exact path.
  assert.equal(lock, join(x.journalDirectory, 'docker-releases.lock'));
  await rm(lock);
  const runtime = await x.open(), delivered = await dev(runtime);
  assert.equal(delivered.status, 'delivered');
  await writeFile(join(x.journalDirectory, 'docker-releases.jsonl'), 'external modification');
  await assert.rejects(() => runtime.accept({ jobId: delivered.jobId, confirmation: true }), /不确定/);
  await assert.rejects(() => runtime.promotion({ releaseId: delivered.jobId }));
  await runtime.close();
  assert.ok(await lstat(lock));
});
