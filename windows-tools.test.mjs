import test from 'node:test';
import assert from 'node:assert/strict';
import { discover, createLocalDeploy } from './local-deploy.js';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverWindowsTools, WINDOWS_PACKAGES, MAVEN_INSTALL_SCRIPT, MAVEN_SHA512, MAVEN_VERSION } from './windows-tools.js';

const base = () => ({ Path: 'C:\\stale', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files', SYSTEMROOT: 'C:\\Windows' });
function fixture({ installed = ['mvn', 'npm', 'jdk'], winget = true, version = 21 } = {}) {
  const available = new Set(installed), calls = [], logs = [], probes = [];
  const jdk = 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.9.10-hotspot';
  const env = base();
  const options = {
    findToolImpl: async (name, config) => {
      probes.push({ name, config: { ...config, env: { ...config.env } } });
      if (name === 'mvn' && available.has('mvn')) return config.extraPaths[0];
      if (name === 'npm' && available.has('npm')) return config.extraPaths[0];
      if (name === 'winget.exe' && winget) return config.extraPaths[0];
      if (name.endsWith('powershell.exe')) return name;
      if (name === `${jdk}\\bin\\java.exe` && available.has('jdk')) return name;
      if (name === `${jdk}\\bin\\javac.exe` && available.has('jdk')) return name;
      return null;
    },
    readdirImpl: async root => root.endsWith('Eclipse Adoptium') ? [{ name: 'jdk-21.0.9.10-hotspot', isDirectory: () => true }] : [],
    readFileImpl: async () => `JAVA_VERSION="${version}.0.9"`,
    run: async (exe, args, cwd, label) => {
      calls.push({ exe, args, cwd, label });
      if (args.includes(WINDOWS_PACKAGES.npm)) available.add('npm');
      if (args.includes(WINDOWS_PACKAGES.jdk)) available.add('jdk');
      if (args.includes(MAVEN_INSTALL_SCRIPT)) available.add('mvn');
    },
    log: value => logs.push(value),
  };
  return { env, options, calls, logs, probes, available };
}

test('stale GUI PATH finds fixed known roots, validates JDK and changes private env only', async () => {
  const f = fixture(), original = { ...process.env };
  const tools = await discoverWindowsTools(f.env, f.options);
  assert.match(tools.mvn, /apache-maven-3\.9\.11\\bin\\mvn.cmd$/);
  assert.equal(tools.npm, 'C:\\Program Files\\nodejs\\npm.cmd');
  assert.match(f.env.JAVA_HOME, /jdk-21/);
  assert.match(f.env.PATH, /jdk-21.*\\bin;C:\\Program Files\\nodejs;/);
  assert.equal(f.env.Path, undefined);
  assert.deepEqual({ ...process.env }, original);
  assert.equal(f.calls.length, 0);
});

test('missing tools install only fixed allowlist/source then recheck once and continue', async () => {
  const f = fixture({ installed: [] });
  const tools = await discover(f.env, { platform: 'win32', ...f.options });
  assert.ok(tools.mvn && tools.npm);
  assert.equal(f.calls.length, 3);
  const winget = f.calls.filter(call => call.exe.endsWith('winget.exe'));
  assert.deepEqual(winget.map(call => call.args), Object.values(WINDOWS_PACKAGES).map(id => ['install', '--id', id, '--exact', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity']));
  const maven = f.calls[0];
  assert.ok(maven.exe.endsWith('WindowsPowerShell\\v1.0\\powershell.exe'));
  assert.deepEqual(maven.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(maven.args[4], MAVEN_INSTALL_SCRIPT);
  assert.ok(f.calls.every(call => call.cwd === 'C:\\Windows'));
  assert.equal(f.probes.filter(p => p.name === 'mvn').length, 2);
  assert.match(f.logs.join(''), /继续本地部署/);
});

test('only missing tool installs; Maven archive works without winget', async () => {
  const f = fixture({ installed: ['npm', 'jdk'], winget: false });
  await discoverWindowsTools(f.env, f.options);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[4], MAVEN_INSTALL_SCRIPT);
});

test('Maven download is fixed official HTTPS and hash checked before extraction', () => {
  assert.match(MAVEN_INSTALL_SCRIPT, new RegExp(`https://archive\\.apache\\.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin\\.zip`));
  assert.match(MAVEN_SHA512, /^[a-f0-9]{128}$/);
  assert.ok(MAVEN_INSTALL_SCRIPT.indexOf('Get-FileHash') < MAVEN_INSTALL_SCRIPT.indexOf('Expand-Archive'));
  assert.ok(MAVEN_INSTALL_SCRIPT.includes(MAVEN_SHA512));
  assert.doesNotMatch(MAVEN_INSTALL_SCRIPT, /Invoke-Expression|ExecutionPolicy|setx|Start-Process/i);
});

test('missing winget and installer failure report explicitly without fallback', async () => {
  const f = fixture({ installed: [], winget: false });
  await assert.rejects(discoverWindowsTools(f.env, f.options), /Windows App Installer.*不会回退/);
  assert.equal(f.calls.length, 0);
  const g = fixture({ installed: ['mvn', 'jdk'] });
  g.options.run = async (...args) => { g.calls.push(args); throw new Error('exit 5'); };
  await assert.rejects(discoverWindowsTools(g.env, g.options), /自动安装失败: exit 5.*UAC/);
  assert.equal(g.calls.length, 1);
});

test('unsuccessful recheck does not loop; JRE and old JDK do not satisfy JDK21', async () => {
  for (const mode of ['missing', 'old', 'jre']) {
    const f = fixture({ installed: mode === 'missing' ? ['npm', 'jdk'] : undefined, version: mode === 'old' ? 17 : 21 });
    if (mode === 'jre') {
      const find = f.options.findToolImpl;
      f.options.findToolImpl = (name, config) => name.endsWith('javac.exe') ? null : find(name, config);
    }
    f.options.run = async (...args) => { f.calls.push(args); };
    await assert.rejects(discoverWindowsTools(f.env, f.options), /安装后仍未发现/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.probes.filter(p => p.name === 'mvn').length, 2);
  }
});

test('cancellation stops before next installer and no recheck occurs', async () => {
  const f = fixture({ installed: [] });
  let cancelled = false;
  f.options.check = () => { if (cancelled) throw new Error('cancelled'); };
  f.options.run = async (...args) => { f.calls.push(args); cancelled = true; };
  await assert.rejects(discoverWindowsTools(f.env, f.options), /cancelled/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.probes.filter(p => p.name === 'mvn').length, 1);
});

async function until(deploy, predicate) {
  for (let i = 0; i < 300; i++) {
    const status = await deploy.route('deploy-status');
    if (predicate(status)) return status;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('deployment did not settle');
}

test('deployment owns tool installers: stop and timeout kill only owned process tree', async t => {
  for (const cancel of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), 'windows-tools-test-'));
    await mkdir(join(directory, 'backend'));
    await writeFile(join(directory, 'backend/pom.xml'), '<project/>');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' }, dependencies: { react: '19', vite: '6' } }));
    const calls = [], f = fixture({ installed: ['mvn', 'jdk'] });
    let pid = 10000;
    const deploy = createLocalDeploy({ inspect: async () => ({ directory, head: 'h', fingerprint: 'f' }) }, {
      platform: 'win32', env: f.env, toolInstallTimeout: cancel ? 1000 : 10, commandTimeout: 1,
      discover: (env, options) => discover(env, { ...f.options, ...options }),
      spawn: (exe, args) => {
        const child = new EventEmitter(); child.pid = ++pid;
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        calls.push({ exe, args });
        if (exe.endsWith('taskkill.exe')) queueMicrotask(() => child.emit('close', 0));
        return child;
      },
    });
    t.after(async () => { await deploy.close(); await rm(directory, { recursive: true, force: true }); });
    await deploy.route('deploy-start', { directory, packages: ['evil'], command: 'evil', env: { PATH: 'evil' } });
    await until(deploy, () => calls.length === 1);
    if (cancel) await deploy.route('deploy-stop');
    const status = await until(deploy, s => !s.task);
    assert.equal(status.state, cancel ? 'stopped' : 'failed');
    if (!cancel) assert.match(status.error, /超时/);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].args.includes(WINDOWS_PACKAGES.npm));
    assert.ok(calls[1].exe.endsWith('taskkill.exe'));
    assert.deepEqual(calls[1].args, ['/PID', '10001', '/T', '/F']);
    assert.equal(status.logs.includes('evil'), false);
  }
});

test('non-Windows discovery never calls installation seams', async () => {
  for (const platform of ['darwin', 'linux']) {
    let installs = 0;
    const env = { PATH: '/bin', JAVA_HOME: '/jdk' };
    await discover(env, { platform, findToolImpl: async name => `/bin/${name}`, run: async () => { installs++; } });
    assert.equal(installs, 0);
  }
});
