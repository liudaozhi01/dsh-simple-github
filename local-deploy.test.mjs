import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDeploy, discover } from './local-deploy.js';

async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'local-deploy-')));
  await mkdir(join(directory, 'backend'));
  await mkdir(join(directory, 'node_modules/vite/bin'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' }, dependencies: { react: '19', vite: '6' } }));
  await writeFile(join(directory, 'backend/pom.xml'), '<project/>');
  await writeFile(join(directory, 'node_modules/vite/bin/vite.js'), '');
  for (const name of ['react', 'vite']) { await mkdir(join(directory, 'node_modules', name), { recursive: true }); await writeFile(join(directory, 'node_modules', name, 'package.json'), '{}'); }
  const calls = [], kills = [], children = [];
  let fingerprint = 'original', pid = 900000, healthy = true;
  const inspect = async value => ({ directory: value, head: 'head', fingerprint });
  const spawn = (command, args, config) => {
    const child = new EventEmitter(); child.pid = ++pid;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    children.push(child); calls.push({ command, args, config });
    if (/taskkill\.exe$/i.test(command)) { queueMicrotask(() => child.emit('close', options.taskkillExit?.() ?? 0)); return child; }
    if (!args.some(arg => arg.includes('spring-boot:run')) && !args.includes('--strictPort') && !options.hang) {
      queueMicrotask(async () => { await options.output?.(child, args, directory); child.emit('close', options.exitCode || 0); });
    }
    return child;
  };
  const deploy = createLocalDeploy({ inspect, ...options.api }, {
    spawn, kill: (pid, signal) => { kills.push([pid, signal]); const child = children.find(c => c.pid === -pid); if (signal === 'SIGTERM') child?.emit('close', null, signal); },
    portAvailable: async () => !options.occupied,
    health: async () => healthy,
    discover: async () => ({ npm: '/trusted/npm', mvn: '/trusted/mvn', node: '/trusted/node' }),
    env: { PATH: '/bin', GH_TOKEN: 'super-secret-token', GITHUB_TOKEN: 'another-secret', JAVA_HOME: '/java' },
    commandTimeout: 30, readyTimeout: 25, pollInterval: 1, killGrace: 1, ...options.deps,
  });
  t.after(async () => { await deploy.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...deploy, directory, calls, kills, children, mutate: () => { fingerprint = 'changed'; }, unhealthy: () => { healthy = false; } };
}
async function until(deploy, predicate) {
  for (let i = 0; i < 300; i++) {
    const status = await deploy.route('deploy-status');
    if (predicate(status)) return status;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('background task did not reach expected state');
}
async function start(deploy) {
  const initial = await deploy.route('deploy-start', { directory: deploy.directory });
  assert.equal(initial.state, 'starting');
  return until(deploy, status => (status.state === 'running' || status.state === 'failed') && !status.task);
}
async function checkedStart(deploy) {
  const status = await start(deploy);
  if (status.state !== 'running') return status;
  await deploy.route('deploy-check', { directory: deploy.directory });
  return until(deploy, status => !status.task);
}
const candidate = status => ({ directory: status.directory, head: status.head, fingerprint: status.fingerprint });

test('fixed commands, env sanitation, confirmation, verification and asynchronous stop', async t => {
  const deploy = await fixture(t);
  const status = await checkedStart(deploy);
  assert.equal(status.state, 'running'); assert.equal(status.checks.state, 'passed');
  assert.deepEqual(deploy.calls.map(call => call.args), [
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5180', '--strictPort'],
    ['-f', 'pom.xml', 'spring-boot:run', '-Dspring-boot.run.arguments=--server.address=127.0.0.1'],
    ['run', 'build'], ['-f', 'backend/pom.xml', 'test'],
  ]);
  for (const call of deploy.calls) { assert.equal(call.config.shell, false); assert.equal(call.config.env.GH_TOKEN, undefined); assert.equal(call.config.env.GITHUB_TOKEN, undefined); assert.equal(call.config.env.JAVA_HOME, '/java'); }
  if (process.platform !== 'win32') assert.equal(deploy.calls[0].config.env.CHOKIDAR_USEPOLLING, undefined);
  assert.equal('env' in status, false);
  await assert.rejects(deploy.assertVerified(candidate(status)), /失效/);
  const confirmed = await deploy.route('deploy-confirm', candidate(status));
  assert.ok(confirmed.confirmed.confirmedAt);
  assert.deepEqual(await deploy.assertVerified(candidate(status)), candidate(status));
  const stopping = await deploy.route('deploy-stop'); assert.equal(stopping.state, 'stopping'); assert.equal(stopping.confirmed, null);
  await assert.rejects(deploy.assertVerified(candidate(status)));
  await until(deploy, status => status.state === 'stopped');
  assert.ok(deploy.kills.some(([pid, signal]) => pid < 0 && signal === 'SIGKILL'));
});

test('missing direct dependencies install automatically using lockfile or no-lock fallback', async t => {
  for (const locked of [true, false]) {
    const deploy = await fixture(t, { output: async (_child, args, directory) => {
      if (!['ci','install'].includes(args[0])) return;
      await mkdir(join(directory,'node_modules/react'), {recursive:true});
      await writeFile(join(directory,'node_modules/react/package.json'), '{}');
    }});
    await rm(join(deploy.directory,'node_modules/react'), {recursive:true});
    if (locked) await writeFile(join(deploy.directory,'package-lock.json'), '{}');
    const status = await start(deploy); assert.equal(status.state,'running',status.error);
    assert.deepEqual(deploy.calls[0].args,[locked?'ci':'install',...(locked?[]:['--package-lock=false']),'--include=dev','--no-audit','--no-fund']);
    assert.ok(deploy.calls[1].args.includes('--strictPort')); assert.match(status.logs,/正在自动安装/);
  }
});
test('failed or incomplete install never builds or launches services', async t => {
  for (const exitCode of [0,1]) {
    const deploy = await fixture(t,{exitCode}); await rm(join(deploy.directory,'node_modules/react'),{recursive:true});
    const status=await start(deploy);assert.equal(status.state,'failed');assert.equal(deploy.calls.length,1);assert.equal(status.checks.state,'idle');
  }
});
test('source changes during installation do not prevent direct startup', async t => {
  let deploy;
  deploy=await fixture(t,{output:async(_child,args,directory)=>{
    if(args[0]!=='install')return;
    await mkdir(join(directory,'node_modules/react'),{recursive:true});await writeFile(join(directory,'node_modules/react/package.json'),'{}');deploy.mutate();
  }});
  await rm(join(deploy.directory,'node_modules/react'),{recursive:true});const status=await start(deploy);
  assert.equal(status.state,'running');assert.equal(status.fingerprint,'changed');assert.equal(status.checks.state,'idle');assert.equal(deploy.calls.length,3);
});
test('dependency install can be cancelled without later build or launch', async t => {
  const deploy=await fixture(t,{hang:true,deps:{commandTimeout:1000}});await rm(join(deploy.directory,'node_modules/react'),{recursive:true});
  await deploy.route('deploy-start',{directory:deploy.directory});
  await until(deploy,()=>deploy.calls.length===1);await deploy.route('deploy-stop');await until(deploy,s=>s.state==='stopped');
  assert.equal(deploy.calls.length,1);assert.ok(deploy.kills.length);
});
test('start/check locks are acquired before awaiting inspect', async t => {
  const deploy = await fixture(t, { hang: true });
  await deploy.route('deploy-start', { directory: deploy.directory });
  await assert.rejects(deploy.route('deploy-start', { directory: deploy.directory }), /正在执行/);
  await assert.rejects(deploy.route('deploy-check', { directory: deploy.directory }), /正在执行/);
  await deploy.route('deploy-stop');
  await until(deploy, status => status.state === 'stopped');
  assert.equal((await deploy.route('deploy-status')).confirmed, null);
});

test('occupied ports refuse before spawning and never kill other processes', async t => {
  const deploy = await fixture(t, { occupied: true });
  const status = await checkedStart(deploy);
  assert.equal(status.state, 'failed'); assert.match(status.error, /占用/);
  assert.equal(deploy.calls.length, 0); assert.equal(deploy.kills.length, 0);
});

test('source mutation during checks invalidates successful commands', async t => {
  let inspectCount = 0;
  const deploy = await fixture(t, { api: { inspect: async directory => ({ directory, head: 'head', fingerprint: ++inspectCount === 1 ? 'before' : 'after' }) } });
  await deploy.route('deploy-check', {directory:deploy.directory});
  const status = await until(deploy, status => !status.task);
  assert.equal(status.state, 'stopped'); assert.equal(status.checks.state, 'failed'); assert.match(status.error, /发生变化/);
  assert.equal(deploy.calls.length, 2);
});

test('failed commands and hung commands fail checks without service launch', async t => {
  for (const options of [{ exitCode: 1 }, { hang: true }]) {
    const deploy = await fixture(t, options); await deploy.route('deploy-check', {directory:deploy.directory}); const status = await until(deploy, status => !status.task);
    assert.equal(status.state, 'stopped'); assert.equal(status.checks.state, 'failed'); assert.equal(deploy.calls.length, 1);
    assert.ok(deploy.kills.length > 0);
  }
});

test('check alone does not count as running and cannot confirm', async t => {
  const deploy = await fixture(t);
  await deploy.route('deploy-check', { directory: deploy.directory });
  const status = await until(deploy, status => status.checks.state === 'passed' && !status.task);
  assert.equal(status.state, 'stopped');
  await assert.rejects(deploy.route('deploy-confirm', candidate(status)), /先启动/);
});

test('post-confirm source changes, unhealthy services, and exits reject push verification', async t => {
  for (const action of ['mutate', 'unhealthy', 'exit']) {
    const deploy = await fixture(t); const status = await checkedStart(deploy);
    await deploy.route('deploy-confirm', candidate(status));
    if (action === 'exit') deploy.children[0].emit('close', 1); else deploy[action]();
    await assert.rejects(deploy.assertVerified(candidate(status)));
  }
});

test('rechecks require same running source and invalidate confirmation', async t => {
  const deploy = await fixture(t); const status = await checkedStart(deploy);
  await deploy.route('deploy-confirm', candidate(status));
  await deploy.route('deploy-check', { directory: deploy.directory });
  assert.equal((await deploy.route('deploy-status')).confirmed, null);
  await until(deploy, status => status.checks.state === 'passed' && !status.task);
  await assert.rejects(deploy.assertVerified(candidate(status)));
  deploy.mutate(); await deploy.route('deploy-check', { directory: deploy.directory });
  await until(deploy, status => !!status.error);
  await assert.rejects(deploy.route('deploy-confirm', candidate(status)));
});

test('logs redact split credentials and truncate; request command/env options ignored', async t => {
  const deploy = await fixture(t, { output: child => {
    child.stdout.emit('data', Buffer.from('password=top')); child.stdout.emit('data', Buffer.from('secret GH_TOKEN=super-secret-token ghp_abcdef\n'));
    child.stderr.emit('data', Buffer.from('x'.repeat(200) + '\n'));
  }, deps: { logLimit: 120 } });
  await deploy.route('deploy-start', { directory: deploy.directory, command: 'evil', env: { GH_TOKEN: 'evil' } });
  const status = await until(deploy, status => status.state === 'running' && !status.task);
  assert.ok(status.logs.length <= 120); assert.equal(status.logsTruncated, true);
  assert.doesNotMatch(status.logs, /topsecret|super-secret-token|ghp_abcdef/);
  assert.equal(deploy.calls.some(call => call.command === 'evil'), false);
});

test('readiness timeout cleans processes and close rejects further routes', async t => {
  const deploy = await fixture(t, { deps: { health: async () => false } });
  const status = await checkedStart(deploy);
  assert.equal(status.state, 'failed'); assert.match(status.error, /健康检查超时/);
  await deploy.close(); await assert.rejects(deploy.route('deploy-status'), /关闭/);
});

test('untruncated split output is redacted before logs become visible', async t => {
  const deploy = await fixture(t, { output: child => {
    child.stdout.emit('data', Buffer.from('password=top'));
    child.stdout.emit('data', Buffer.from('secret GH_TOKEN=super-secret-token ghp_abcdef\n'));
  } });
  const status = await checkedStart(deploy);
  assert.match(status.logs, /\[REDACTED\]/);
  assert.doesNotMatch(status.logs, /topsecret|super-secret-token|ghp_abcdef/);
});

test('close cancels hung commands and cleans their process groups', async t => {
  const deploy = await fixture(t, { hang: true, deps: { commandTimeout: 60_000 } });
  await deploy.route('deploy-check', { directory: deploy.directory });
  await until(deploy, status => status.checks.state === 'running');
  await deploy.close();
  assert.ok(deploy.kills.some(([, signal]) => signal === 'SIGKILL'));
  await assert.rejects(deploy.route('deploy-status'));
});

test('startup directly launches services; explicit first push runs deferred checks once', async t => {
  const deploy = await fixture(t);
  const status = await start(deploy);
  assert.equal(status.state, 'running'); assert.equal(status.checks.state, 'idle');
  assert.equal(deploy.calls.length, 2);
  await assert.rejects(deploy.assertVerified(candidate(status)));
  await assert.rejects(deploy.assertVerified(candidate(status), { confirmedSelfTest: 'true' }));
  assert.equal(deploy.calls.length, 2);
  await deploy.assertVerified(candidate(status), { confirmedSelfTest: true });
  assert.equal((await deploy.route('deploy-status')).checks.state, 'passed');
  assert.deepEqual(deploy.calls.slice(2).map(call => call.args), [['run', 'build'], ['-f', 'backend/pom.xml', 'test']]);
  await deploy.assertVerified(candidate(status), { confirmedSelfTest: true });
  assert.equal(deploy.calls.length, 4);
});

test('missing HEAD or conflicting Git snapshot cannot prevent local startup', async t => {
  for (const inspect of [async () => { throw new Error('repository has no HEAD'); }, async directory => ({directory,head:'head',fingerprint:'conflict',changes:[{status:'UU'}]})]) {
    const deploy = await fixture(t, {api:{inspect}});
    const status = await start(deploy);
    assert.equal(status.state, 'running'); assert.equal(status.checks.state, 'idle');
    assert.equal(status.head, null); assert.equal(deploy.calls.length, 2);
    await assert.rejects(deploy.assertVerified(candidate(status), {confirmedSelfTest:true}), /启动快照/);
  }
});

test('deferred push checks acquire task lock and stop cancels pending verification', async t => {
  const deploy = await fixture(t, {hang:true,deps:{commandTimeout:1000}});
  const status = await start(deploy);
  const pending = deploy.assertVerified(candidate(status), {confirmedSelfTest:true});
  const rejected = assert.rejects(pending);
  await until(deploy, status => status.checks.state === 'running');
  await assert.rejects(deploy.assertVerified(candidate(status), {confirmedSelfTest:true}));
  await assert.rejects(deploy.route('deploy-check', {directory:deploy.directory}), /正在执行/);
  await deploy.route('deploy-stop'); await rejected;
  await until(deploy, status => status.state === 'stopped' && !status.task);
  assert.equal(deploy.calls.length, 3);
});

test('changed launch baseline refuses first push before deferred commands', async t => {
  const deploy = await fixture(t); const status = await start(deploy); deploy.mutate();
  await assert.rejects(deploy.assertVerified({...candidate(status),fingerprint:'changed'}, {confirmedSelfTest:true}), /重新启动/);
  assert.equal(deploy.calls.length, 2);
});

test('dirty snapshots auto-check and accept explicit push confirmation without deploy-confirm', async t => {
  const deploy = await fixture(t, { api: { inspect: async directory => ({ directory, head: 'head', fingerprint: 'dirty', isClean: false, changes: [{ status: ' M', path: 'source.js' }] }) } });
  const status = await checkedStart(deploy);
  assert.equal(status.state, 'running'); assert.equal(status.checks.state, 'passed');
  await assert.rejects(deploy.assertVerified(candidate(status)), /失效/);
  await assert.rejects(deploy.assertVerified(candidate(status), { confirmedSelfTest: 'true' }), /失效/);
  await deploy.assertVerified(candidate(status), { confirmedSelfTest: true });
  assert.equal((await deploy.route('deploy-status')).confirmed, null);
});

test('trusted commit rebind requires identical content and current healthy snapshot', async t => {
  let head = 'before', fingerprint = 'dirty', contentFingerprint = 'same-content';
  const deploy = await fixture(t, { api: { inspect: async directory => ({ directory, head, fingerprint, contentFingerprint, isClean: head !== 'before' }) } });
  const status = await checkedStart(deploy), before = { ...candidate(status), contentFingerprint };
  head = 'after'; fingerprint = 'clean';
  const after = { directory: deploy.directory, head, fingerprint, contentFingerprint };
  await assert.rejects(deploy.assertVerified(after, { confirmedSelfTest: true }));
  await assert.rejects(deploy.rebindVerified(before, after));
  await assert.rejects(deploy.rebindVerified(before, { ...after, contentFingerprint: 'different' }, { confirmedSelfTest: true }));
  await deploy.rebindVerified(before, after, { confirmedSelfTest: true });
  await deploy.assertVerified(after, { confirmedSelfTest: true });
  assert.equal((await deploy.route('deploy-status')).checks.head, 'after');
  contentFingerprint = 'different'; fingerprint = 'changed';
  await assert.rejects(deploy.assertVerified(after, { confirmedSelfTest: true }));
});

test('confirmation requires explicit displayed head and fingerprint', async t => {
  const deploy = await fixture(t); const status = await checkedStart(deploy);
  await assert.rejects(deploy.route('deploy-confirm', {}));
  await assert.rejects(deploy.route('deploy-confirm', { ...candidate(status), head: 'wrong' }));
  await assert.rejects(deploy.route('deploy-confirm', { ...candidate(status), fingerprint: 'wrong' }));
  assert.equal((await deploy.route('deploy-status')).confirmed, null);
});

test('Windows discovery uses normalized Path, mvn.cmd/npm.cmd and JAVA_HOME java.exe', async () => {
  const calls = [], env = { Path: 'C:\\工具', java_home: 'C:\\Program Files\\Java' };
  const findToolImpl = async (name, config) => {
    calls.push({ name, config });
    return ({ mvn: 'C:\\工具\\mvn.cmd', npm: 'C:\\工具\\npm.cmd', 'C:\\Program Files\\Java\\bin\\java.exe': 'C:\\Program Files\\Java\\bin\\java.exe', 'C:\\Program Files\\Java\\bin\\javac.exe': 'C:\\Program Files\\Java\\bin\\javac.exe' })[name] || null;
  };
  assert.deepEqual(await discover(env, { platform: 'win32', findToolImpl, nodePath: 'C:\\node.exe', readdirImpl: async () => [], readFileImpl: async () => 'JAVA_VERSION="21.0.1"' }), { mvn: 'C:\\工具\\mvn.cmd', npm: 'C:\\工具\\npm.cmd', node: 'C:\\node.exe' });
  assert.deepEqual(calls.map(call => call.name), ['mvn', 'npm', 'java', 'C:\\Program Files\\Java\\bin\\java.exe', 'C:\\Program Files\\Java\\bin\\javac.exe']);
  assert.ok(calls[0].config.env.PATH.includes('C:\\工具')); assert.equal(env.JAVA_HOME, 'C:\\Program Files\\Java');
  assert.equal(env.Path, undefined); assert.equal(env.java_home, undefined);
  assert.equal(calls.some(call => call.config.extraPaths.some(path => path.startsWith('/opt/'))), false);
});

test('macOS discovery preserves Homebrew fallback and JDK probing', async () => {
  const env = { PATH: '/usr/bin' }, calls = [];
  const home = '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home';
  const tools = await discover(env, { platform: 'darwin', findToolImpl: async (name, config) => {
    calls.push({ name, config });
    return name === 'mvn' ? '/opt/homebrew/bin/mvn' : name === 'npm' ? '/opt/homebrew/bin/npm' : name === `${home}/bin/java` ? name : null;
  } });
  assert.equal(tools.mvn, '/opt/homebrew/bin/mvn'); assert.equal(env.JAVA_HOME, home);
  assert.deepEqual(calls[0].config.extraPaths, ['/opt/homebrew/bin/mvn', '/usr/local/bin/mvn']);
});

test('missing Windows tools fail safely without an owned installer runner', async () => {
  const seams = { platform: 'win32', readdirImpl: async () => [], readFileImpl: async () => '' };
  await assert.rejects(discover({ Path: 'C:\\tools' }, { ...seams, findToolImpl: async name => ['mvn', 'npm'].includes(name) ? `C:\\tools\\${name}.cmd` : null }), /jdk.*运行器/);
  await assert.rejects(discover({}, { ...seams, findToolImpl: async () => null }), /mvn.*npm.*jdk/);
});

test('Windows deployment launches controlled batch tools and stops owned process trees', async t => {
  const deploy = await fixture(t, { deps: {
    platform: 'win32', existsImpl: () => false,
    env: { Path: 'C:\\工具', java_home: 'C:\\Java', github_token: 'windows-secret' },
    discover: async () => ({ npm: 'C:\\工具\\npm.cmd', mvn: 'C:\\Program Files (x86)\\Maven\\mvn.cmd', node: 'C:\\node.exe' }),
  } });
  const status = await checkedStart(deploy);
  assert.equal(status.state, 'running', status.error); assert.equal(status.checks.state, 'passed', status.error);
  const launches = deploy.calls.filter(call => !/taskkill\.exe$/i.test(call.command));
  assert.equal(launches[0].command, 'C:\\node.exe');
  assert.equal(launches[0].config.env.CHOKIDAR_USEPOLLING, 'true');
  assert.equal(launches[0].config.env.CHOKIDAR_INTERVAL, '300');
  assert.equal(launches[1].config.env.CHOKIDAR_USEPOLLING, undefined);
  assert.equal(launches[1].command, 'C:\\Windows\\System32\\cmd.exe');
  assert.match(launches[1].args[4], /spring-boot:run/);
  for (const call of launches) {
    assert.equal(call.config.detached, false); assert.equal(call.config.shell, false);
    assert.equal(call.config.env.PATH, 'C:\\工具'); assert.equal(call.config.env.JAVA_HOME, 'C:\\Java');
    assert.equal(call.config.env.GITHUB_TOKEN, undefined); assert.equal(call.config.env.Path, undefined);
  }
  await deploy.route('deploy-stop'); await until(deploy, value => value.state === 'stopped');
  const kills = deploy.calls.filter(call => /taskkill\.exe$/i.test(call.command));
  assert.equal(kills.length, 2);
  for (const call of kills) { assert.deepEqual(call.args.slice(2), ['/T', '/F']); assert.ok(deploy.children.some(child => String(child.pid) === call.args[1])); }
  assert.equal(deploy.kills.length, 0);
});

test('Windows failed cleanup remains failed and retained owned children can be retried', async t => {
  let failing = true;
  const deploy = await fixture(t, { taskkillExit: () => failing ? 5 : 0, deps: { platform: 'win32' } });
  assert.equal((await start(deploy)).state, 'running');
  await deploy.route('deploy-stop');
  const failed = await until(deploy, value => !value.task);
  assert.equal(failed.state, 'failed'); assert.match(failed.error, /清理未确认/);
  assert.equal(failed.frontend.state, 'failed');
  await assert.rejects(deploy.route('deploy-start', { directory: deploy.directory }), /清理未确认/);
  await assert.rejects(deploy.route('deploy-check', { directory: deploy.directory }), /清理未确认/);
  const first = deploy.calls.filter(call => /taskkill\.exe$/i.test(call.command));
  assert.equal(first.length, 2);
  failing = false;
  await deploy.route('deploy-stop');
  const stopped = await until(deploy, value => !value.task);
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.error, null);
  const retried = deploy.calls.filter(call => /taskkill\.exe$/i.test(call.command));
  assert.equal(retried.length, 4);
  assert.deepEqual(retried.slice(2).map(call => call.args[1]), first.map(call => call.args[1]));
});

test('Windows occupied ports never taskkill unrelated processes', async t => {
  const deploy = await fixture(t, { occupied: true, deps: { platform: 'win32' } });
  assert.equal((await start(deploy)).state, 'failed'); assert.equal(deploy.calls.length, 0); assert.equal(deploy.kills.length, 0);
});
