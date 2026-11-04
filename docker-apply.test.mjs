import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createDockerApply } from './docker-apply.js';
import { createDockerReconciler } from './docker-reconcile.js';

const head = 'c'.repeat(40);
const backendImage = `ghcr.io/ssal-team/backend@sha256:${'a'.repeat(64)}`;
const frontendImage = `ghcr.io/ssal-team/frontend@sha256:${'b'.repeat(64)}`;
const expected = { jobId: 'Job:1._-A', environment: 'dev', head, backendImage, frontendImage };
const input = () => ({ jobId: expected.jobId, environment: expected.environment, remote: { repository: 'ssal-team/XiAN-OA', branch: 'dev', head, sourceOrigin: 'github-remote-dev' }, artifact: { head, backendImage, frontendImage, provenanceVerified: true } });
const proof = (extra = {}) => ({ schema: 1, ...expected, phase: 'applied', backendHealthy: true, frontendHealthy: true, observedAt: 1000, ...extra });
const response = (p = proof()) => ({ code: 0, stdout: JSON.stringify(p), stderr: 'SECRET NEVER RETURN' });
function mocked(output = response()) {
  const calls = [];
  const api = createDockerApply({ now: () => 1000, exec: async call => { calls.push(call); if (output instanceof Error) throw output; return output; } });
  return { api, calls };
}

test('explicit injection and strict option data only', () => {
  for (const options of [undefined, {}, { exec: true }, { exec() {}, unknown: true }, { exec() {}, now: 1 }, { get exec() { throw Error('getter'); } }]) assert.throws(() => createDockerApply(options));
});

test('delivers only validated real digest+health evidence, no acceptance', async () => {
  const { api, calls } = mocked();
  assert.deepEqual(await api.deliver(input()), { status: 'delivered', delivered: true, healthy: true, ...expected, observedAt: 1000, accepted: false, retryAllowed: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].alias, 'xian-oa-test');
  assert.equal(calls[0].timeoutMs, 180000);
  assert.ok(calls[0].command.startsWith(`sudo -n /usr/bin/python3 -I - apply ${expected.jobId} dev ${head} ${backendImage} ${frontendImage} 1000 <<'XIAN_OA_APPLY_PY'\n`));
});

test('static Python compiles locally without executing its body', async () => {
  const { api, calls } = mocked();
  await api.deliver(input());
  const script = calls[0].command.split("<<'XIAN_OA_APPLY_PY'\n")[1].slice(0, -'XIAN_OA_APPLY_PY'.length);
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', "import sys; compile(sys.stdin.read(), '<docker-apply>', 'exec')"], { input: script, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  // Compile is the only local subprocess test. No generated remote body runs.
  assert.match(script, /os\.O_RDWR\|os\.O_CREAT\|os\.O_EXCL\|os\.O_NOFOLLOW/);
  assert.match(script, /os\.fsync\(fd\); os\.fsync\(mfd\)/);
  assert.match(script, /fcntl\.flock\(lock,fcntl\.LOCK_EX\|fcntl\.LOCK_NB\)/);
  assert.match(script, /os\.O_DIRECTORY\|os\.O_NOFOLLOW/);
  assert.match(script, /'Config',\{\}\)\.get\('Image'\)==ref/);
  assert.match(script, /container\.get\('Image'\)==ids\[ref\]/);
  assert.match(script, /'RepoDigests'/);
  assert.match(script, /http\(8082 if environment=='dev' else 8081,'\/api\/v1\/health'\)/);
  assert.match(script, /http\(28081 if environment=='dev' else 28080,'\/'\)/);
  assert.match(script, /ProxyHandler\(\{\}\)/);
  assert.match(script, /time\.monotonic\(\)<deadline/);
  assert.match(script, /len\(output\)<=LIMIT/);
  assert.match(script, /readfd\(config\)==expected\.encode/);
  assert.match(script, /readfd\(nginx\)==TEMPLATES/);
  assert.doesNotMatch(script, /readfd\(secret/);
  assert.match(script, /nginx=filefd\(efd,'nginx-container.conf',public=True\)/);
  assert.match(script, /stat.S_IMODE\(os.fstat\(fd\).st_mode\)==0o644/);
  assert.match(script, /secret=filefd\(efd,'container.env'\)/);
  assert.match(script, /set\(state\)==\{'loaded','inactive'\}/);
  assert.match(script, /\(2,30,0\)/);
  assert.match(script, /'failed'/);
  assert.equal((script.match(/run\(compose\+\['up'/g) || []).length, 1);
  assert.ok(script.indexOf("markerwrite(marker,'pending')") < script.indexOf("run(compose+['up'"));
  assert.ok(script.indexOf("if mode=='query':") < script.indexOf("markerwrite(marker,'pending')"));
  assert.doesNotMatch(script, /\['(?:docker|systemctl)'[^\n]*(?:'stop'|'restart'|'pull'|'push'|'build'|'rm'|'down')/);
  assert.match(script, /\['up','-d','--no-build','--pull','never','--no-recreate'\]/);
  assert.match(script, /existing=run\(compose\+\['ps','--all','--format','json'\]\)/);
  assert.match(script, /require\(existing in \('','\[\]'\)\)/);
  // All subprocess roots are fixed; no shell=True / os.system / eval.
  const roots = [...script.matchAll(/run\(\['([^']+)'/g)].map(m => m[1]);
  assert.ok(roots.every(root => ['docker', 'systemctl'].includes(root)));
  assert.doesNotMatch(script, /shell\s*=|os\.system|eval\(|exec\(/);
});

test('query uses full trusted expected identity; read-only branch never writes or starts', async () => {
  const { api, calls } = mocked();
  assert.deepEqual(await api.query(expected), proof());
  assert.match(calls[0].command, /^sudo -n \/usr\/bin\/python3 -I - query /);
  const queryBranch = calls[0].command.split("if mode=='query':")[1].split('\n    else:')[0];
  assert.doesNotMatch(queryBranch, /markerwrite|O_CREAT|O_RDWR|\['up'|ftruncate|os\.write/);
  for (const phase of ['pending', 'failed', 'absent']) {
    const { api: queryApi } = mocked(response(proof({ phase, backendHealthy: false, frontendHealthy: false })));
    assert.equal((await queryApi.query(expected)).phase, phase);
  }
});

test('invalid delivery proof, executor errors, timeout and disconnect never retry or leak', async () => {
  const malformed = [null, { code: 1, stdout: 'SECRET' }, { code: 0, exitCode: 1, stdout: JSON.stringify(proof()) }, { code: 0, stdout: 'SECRET' }, { code: 0, stdout: ' '.repeat(4097) }, new Error('SECRET timeout')];
  for (const change of [{ schema: 2 }, { jobId: 'other' }, { environment: 'test' }, { head: 'd'.repeat(40) }, { backendImage: frontendImage }, { frontendImage: backendImage }, { phase: 'pending' }, { phase: 'failed' }, { phase: 'absent' }, { backendHealthy: false }, { frontendHealthy: false }, { backendHealthy: 'true' }, { observedAt: 1001 }, { observedAt: -1 }, { observedAt: 1.2 }, { secret: 'SECRET' }]) malformed.push(response(proof(change)));
  const missing = proof(); delete missing.observedAt; malformed.push(response(missing));
  for (const output of malformed) {
    const { api, calls } = mocked(output);
    await assert.rejects(api.deliver(input()), error => error.message === 'Docker apply evidence unavailable (details suppressed; do not retry).');
    assert.equal(calls.length, 1);
  }
  const stale = createDockerApply({ exec: async () => response(), now: () => 32000 });
  await assert.rejects(stale.deliver(input()));
});

test('fail closed input allowlist, no interpolation, no exec on validation failures', async () => {
  const variants = [];
  for (const jobId of ['.', '..', '../x', 'x/y', 'x\\y', 'x\n', 'x;id', 'x$(id)', 'x`id`', 'x '.repeat(10), '', 'a'.repeat(129)]) variants.push({ ...input(), jobId });
  for (const environment of ['prod', 'dev\n', 'test;id']) variants.push({ ...input(), environment });
  for (const change of [{ repository: 'other/XiAN-OA' }, { branch: 'main' }, { head: 'A'.repeat(40) }, { head: head+'\n' }, { sourceOrigin: 'client' }, { injected: true }]) variants.push({ ...input(), remote: { ...input().remote, ...change } });
  for (const change of [{ provenanceVerified: false }, { provenanceVerified: 'true' }, { head: 'd'.repeat(40) }, { backendImage: 'sha256:'+'a'.repeat(64) }, { backendImage: 'repo:latest' }, { backendImage: backendImage+'\n' }, { frontendImage: 'repo@sha256:'+'a'.repeat(64)+';id' }, { backendImage: 'registry.test:65536/a@sha256:'+'a'.repeat(64) }, { extra: true }]) variants.push({ ...input(), artifact: { ...input().artifact, ...change } });
  variants.push({ ...input(), extra: true });
  variants.push({ ...input(), get remote() { throw Error('getter must not run'); } });
  for (const value of variants) {
    const { api, calls } = mocked();
    await assert.rejects(api.deliver(value)); assert.equal(calls.length, 0);
  }
  for (const value of [{ jobId: expected.jobId }, { ...expected, extra: true }, { ...expected, jobId: '..' }]) {
    const { api, calls } = mocked(); await assert.rejects(api.query(value)); assert.equal(calls.length, 0);
  }
});

test('query evidence integrates with existing reconciler without applying', async () => {
  const { api, calls } = mocked();
  const reconciler = createDockerReconciler({ query: api.query, now: () => 1000 });
  const result = await reconciler.reconcile(expected);
  assert.equal(result.status, 'delivered');
  assert.equal(result.healthy, true);
  assert.equal(result.accepted, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /^sudo -n \/usr\/bin\/python3 -I - query /);
});

test('all allowed job characters including leading dot/colon are preserved; snapshots immutable across await', async () => {
  for (const jobId of ['.safe', ':safe', '-safe', '_safe', 'a.b:C_9-']) {
    const api = createDockerApply({ now: () => 1000, exec: async () => response(proof({ jobId })) });
    assert.equal((await api.deliver({ ...input(), jobId })).jobId, jobId);
  }
  const value = input();
  const api = createDockerApply({ now: () => 1000, exec: async () => {
    value.remote.head = 'd'.repeat(40); value.artifact.backendImage = frontendImage;
    return response();
  } });
  assert.equal((await api.deliver(value)).head, head);
});
