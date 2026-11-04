import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { createDockerBuild } from './docker-build.js';

const head = 'a'.repeat(40), digest = 'b'.repeat(64);
const input = () => ({ remote: { repository: 'ssal-team/XiAN-OA', branch: 'dev', head }, backendBase: `eclipse-temurin@sha256:${digest}`, frontendBase: `nginxinc/nginx-unprivileged@sha256:${digest}`, uid: 10001, gid: 10001 });
async function fixture(options = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'docker-build-fixture-'));
  await mkdir(join(directory, 'dist', 'assets'), { recursive: true });
  await mkdir(join(directory, 'backend', 'target'), { recursive: true });
  await writeFile(join(directory, 'dist', 'index.html'), '<html>fixture</html>');
  await writeFile(join(directory, 'dist', 'assets', 'main.js'), '// fixture only');
  await writeFile(join(directory, 'backend', 'target', 'app.jar'), 'fixture jar');
  await writeFile(join(directory, 'backend', 'target', 'original-app.jar'), 'original');
  await writeFile(join(directory, '.env'), 'DO_NOT_COPY=fixture');
  const calls = [], contexts = new Set(), configs = [];
  let cleaned = 0, checkedOut = 0;
  const checkout = async remote => {
    checkedOut++;
    assert.equal(remote.head, head);
    return { directory, head: options.head || head, cleanup: async () => { cleaned++; await rm(directory, { recursive: true, force: true }); } };
  };
  const command = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    contexts.add(dirname(opts.env.HOME));
    if (options.fail?.(cmd, args)) throw new Error('injected command failure');
    if (cmd === 'java') return { stdout: '', stderr: options.java || 'openjdk version "21.0.4" 2024-07-16' };
    if (cmd === 'docker' && args[0] === 'build') {
      contexts.add(dirname(opts.cwd));
      configs.push(await readFile(join(opts.cwd, 'Dockerfile'), 'utf8'));
      if (opts.cwd.endsWith('backend')) assert.equal(await readFile(join(opts.cwd, 'app.jar'), 'utf8'), 'fixture jar');
      else assert.equal(await readFile(join(opts.cwd, 'web', 'assets', 'main.js'), 'utf8'), '// fixture only');
      await assert.rejects(lstat(join(opts.cwd, '.env')), { code: 'ENOENT' });
    }
    return { stdout: cmd === 'docker' && args[0] === 'image' ? (options.inspect ?? `sha256:${digest}\n`) : '', stderr: '' };
  };
  return { directory, calls, contexts, configs, checkout, command, get cleaned() { return cleaned; }, get checkedOut() { return checkedOut; },
    async dispose() { await rm(directory, { recursive: true, force: true }); },
    async assertClean() { assert.equal(cleaned, 1); await assert.rejects(lstat(directory), { code: 'ENOENT' }); for (const path of contexts) await assert.rejects(lstat(path), { code: 'ENOENT' }); },
  };
}

test('injected commands only: exact host build, isolated artifact contexts, inspect IDs and runtime nginx contract', async () => {
  const f = await fixture();
  const old = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'fixture-token-never-forward';
  try {
    const result = await createDockerBuild(f).build(input());
    assert.equal(result.attested, false);
    assert.deepEqual(result.localImageId, { backend: `sha256:${digest}`, frontend: `sha256:${digest}` });
    assert.equal(result.head, head);
    assert.notEqual(result.backendTag, result.frontendTag);
    assert.match(result.runtimeConstraint, /read-only/);
    assert.deepEqual(f.calls.slice(0, 4).map(x => [x.cmd, x.args]), [
      ['java', ['-version']], ['npm', ['ci']], ['npm', ['run', 'build']], ['mvn', ['-B', '-f', 'backend/pom.xml', 'package']],
    ]);
    assert.equal(f.calls.length, 8);
    for (const call of f.calls) {
      assert.equal(call.opts.shell, false);
      assert.ok(call.opts.timeout > 0 && call.opts.timeout <= 600000);
      assert.deepEqual(Object.keys(call.opts.env).filter(key => !['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'PATH', 'LANG', 'LC_ALL', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT'].includes(key)), []);
      assert.equal(call.opts.env.GH_TOKEN, undefined);
      assert.notEqual(call.opts.env.HOME, process.env.HOME);
      if (call.cmd !== 'docker') assert.equal(call.opts.cwd, f.directory);
    }
    assert.equal(f.contexts.size, 1);
    assert.ok(![...f.contexts][0].startsWith(f.directory));
    assert.match(f.configs[0], /FROM eclipse-temurin@sha256:/);
    assert.match(f.configs[0], /USER 10001:10001/);
    assert.match(f.configs[1], /FROM nginxinc\/nginx-unprivileged@sha256:/);
    assert.doesNotMatch(f.configs.join('\n'), /^(?:RUN|ADD|EXPOSE) |^COPY .*nginx\.conf|8082|28081/m);
    assert.deepEqual(f.calls.slice(4, 6).map(x => x.args), [['build', '--network=none', '--tag', result.backendTag, '.'], ['build', '--network=none', '--tag', result.frontendTag, '.']]);
    assert.deepEqual(f.calls.slice(6).map(x => x.args), [['image', 'inspect', '--format', '{{.Id}}', result.backendTag], ['image', 'inspect', '--format', '{{.Id}}', result.frontendTag]]);
    assert.equal('backendImage' in result, false);
    await f.assertClean();
  } finally { if (old === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = old; await f.dispose(); }
});

test('reject invalid input before checkout or any command, including local input/accessors', async () => {
  let touched = 0;
  const builder = createDockerBuild({ command: async () => { touched++; }, checkout: async () => { touched++; } });
  const invalid = [null, [], { ...input(), directory: '/local' }, { ...input(), env: { GH_TOKEN: 'x' } },
    { ...input(), uid: 0 }, { ...input(), gid: -1 }, { ...input(), uid: '1000' }, { ...input(), gid: 1.5 },
    { ...input(), backendBase: 'java:21' }, { ...input(), frontendBase: `nginx:latest@sha256:${digest}` },
    { ...input(), backendBase: `nginx@sha256:${digest}\n` }, { ...input(), frontendBase: `host:99999/nginx@sha256:${digest}` },
    { ...input(), remote: { head, directory: '/local' } }, { ...input(), remote: { head, branch: 'main' } },
    { ...input(), remote: { head: 'bad' } }, { ...input(), remote: { head: `${head}\n` } },
    Object.defineProperty(input(), 'uid', { get() { throw new Error('getter executed'); } }),
  ];
  for (const value of invalid) await assert.rejects(builder.build(value), TypeError);
  assert.equal(touched, 0);
  assert.throws(() => createDockerBuild(), TypeError);
});

test('makeConfig cannot smuggle Docker RUN, nginx.conf, ports, or an alternate base', async () => {
  let checked = false;
  const builder = createDockerBuild({ checkout: async () => { checked = true; }, makeConfig: () => ({ backendDockerfile: 'FROM java:latest\nRUN curl example.com\n', frontendDockerfile: 'COPY nginx.conf /etc/nginx/nginx.conf\nEXPOSE 28081\n' }) });
  await assert.rejects(builder.build(input()), /fixed pinned/);
  assert.equal(checked, false);
});

test('Java 21 and locked checkout HEAD are mandatory, failures still clean source', async () => {
  for (const options of [{ java: 'openjdk version "17.0.8"' }, { java: 'openjdk version "210"' }, { head: 'c'.repeat(40) }]) {
    const f = await fixture(options);
    try {
      await assert.rejects(createDockerBuild(f).build(input()), /Java version 21|HEAD differs/);
      assert.ok(f.calls.every(call => call.cmd === 'java'));
      await f.assertClean();
    } finally { await f.dispose(); }
  }
});

test('reject missing/multiple JAR, artifact symlinks, irregular roots and byte limit before Docker', async () => {
  for (const alter of [
    async f => rm(join(f.directory, 'backend', 'target', 'app.jar')),
    async f => writeFile(join(f.directory, 'backend', 'target', 'second.jar'), 'x'),
    async f => symlink(join(f.directory, '.env'), join(f.directory, 'dist', 'secret')),
    async f => { await rm(join(f.directory, 'dist'), { recursive: true }); await symlink(join(f.directory, 'backend'), join(f.directory, 'dist')); },
    async f => truncate(join(f.directory, 'backend', 'target', 'app.jar'), 512 * 1024 * 1024 + 1),
    async f => rm(join(f.directory, 'dist', 'index.html')),
    async f => mkdir(join(f.directory, 'dist', ...Array(65).fill('nested')), { recursive: true }),
  ]) {
    const f = await fixture();
    try { await alter(f); await assert.rejects(createDockerBuild(f).build(input())); assert.ok(f.calls.every(call => call.cmd !== 'docker')); await f.assertClean(); }
    finally { await f.dispose(); }
  }
});

test('irregular artifact socket is rejected before Docker', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture(), server = createServer();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(join(f.directory, 'dist', 'socket'), resolve); });
    await assert.rejects(createDockerBuild(f).build(input()), /irregular files/);
    assert.ok(f.calls.every(call => call.cmd !== 'docker'));
    await f.assertClean();
  } finally { await new Promise(resolve => server.close(resolve)); await f.dispose(); }
});

test('entry count is bounded including empty directories', async () => {
  const f = await fixture();
  try {
    // Empty entries are cheap fixtures and must count, not just copied file bytes.
    for (let start = 0; start < 10001; start += 100) await Promise.all(Array.from({ length: Math.min(100, 10001 - start) }, (_, i) => mkdir(join(f.directory, 'dist', `d${start + i}`))));
    await assert.rejects(createDockerBuild(f).build(input()), /entry limit/);
    assert.ok(f.calls.every(call => call.cmd !== 'docker'));
    await f.assertClean();
  } finally { await f.dispose(); }
});

test('each command failure and invalid inspect ID clean source/context, never remove shared images', async () => {
  for (const fail of [
    cmd => cmd === 'java', cmd => cmd === 'npm', cmd => cmd === 'mvn',
    (cmd, args) => cmd === 'docker' && args[0] === 'build' && args.includes('--tag') && args.some(x => x.startsWith('xian-oa-local-backend:')),
    (cmd, args) => cmd === 'docker' && args[0] === 'build' && args.some(x => x.startsWith('xian-oa-local-frontend:')),
    (cmd, args) => cmd === 'docker' && args[0] === 'image',
  ]) {
    const f = await fixture({ fail });
    try { await assert.rejects(createDockerBuild(f).build(input()), /injected command failure/); await f.assertClean(); assert.ok(!f.calls.some(c => c.cmd === 'docker' && (c.args.includes('rm') || c.args.includes('push') || c.args.includes('run')))); }
    finally { await f.dispose(); }
  }
  const f = await fixture({ inspect: `repo@sha256:${digest}` });
  try { await assert.rejects(createDockerBuild(f).build(input()), /local sha256 image ID/); await f.assertClean(); } finally { await f.dispose(); }
});

test('cleanup errors are reported rather than pretending success', async () => {
  const f = await fixture();
  try {
    const checkout = async remote => { const source = await f.checkout(remote); return { ...source, cleanup: async () => { await source.cleanup(); throw new Error('injected cleanup failure'); } }; };
    await assert.rejects(createDockerBuild({ command: f.command, checkout }).build(input()), error => error instanceof AggregateError && error.errors.some(x => x.message === 'injected cleanup failure'));
    await f.assertClean();
  } finally { await f.dispose(); }
});
