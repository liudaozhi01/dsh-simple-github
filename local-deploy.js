import { spawn as nodeSpawn } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, win32 } from 'node:path';
import { findTool, normalizeEnv, spawnPortable, terminateTree } from './platform.js';
import { discoverWindowsTools } from './windows-tools.js';
import net from 'node:net';
import http from 'node:http';

const URLS = Object.freeze({ frontend: 'http://127.0.0.1:5180', backend: 'http://127.0.0.1:8081', health: 'http://127.0.0.1:8081/api/v1/health' });
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const same = (a, b) => a && b && a.directory === b.directory && a.head === b.head && a.fingerprint === b.fingerprint;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function defaultRedact(value) {
  return String(value).replace(/(?:gh[pousr]_[\w]+|github_pat_[\w]+)/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@')
    .replace(/((?:authorization|password|passwd|secret|[\w-]*token|api[_-]?key)\s*[=:]\s*["']?)(?:bearer\s+|token\s+)?[^\s,"'}]+/ig, '$1[REDACTED]');
}
async function portAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    // Exclusive wildcard bind also rejects processes listening on other interfaces.
    server.listen({ port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}
async function health(url) {
  return new Promise(resolve => {
    const request = http.get(url, { timeout: 1000 }, response => { response.resume(); resolve(response.statusCode >= 200 && response.statusCode < 300); });
    request.on('timeout', () => request.destroy()); request.on('error', () => resolve(false));
  });
}
export async function discover(env, { platform = process.platform, findToolImpl = findTool, nodePath = process.execPath, ...windowsOptions } = {}) {
  if (platform === 'win32') return discoverWindowsTools(env, { findToolImpl, nodePath, ...windowsOptions });
  const normalized = normalizeEnv(env, platform);
  if (platform === 'win32') for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, normalized);
  const windows = platform === 'win32', pjoin = windows ? win32.join : join;
  const find = (name, extraPaths = []) => findToolImpl(name, { env, platform, extraPaths });
  const mvn = await find('mvn', platform === 'darwin' ? ['/opt/homebrew/bin/mvn', '/usr/local/bin/mvn'] : []);
  const npm = await find('npm', platform === 'darwin' ? ['/opt/homebrew/bin/npm', '/usr/local/bin/npm'] : []);
  if (!mvn || !npm) throw fail('需要安装 npm 和 Maven (mvn)', 503);
  if (!env.JAVA_HOME && platform === 'darwin') {
    for (const home of ['/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home', '/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home', '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home', '/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home']) {
      if (await find(pjoin(home, 'bin', 'java'))) { env.JAVA_HOME = home; break; }
    }
  }
  const java = (env.JAVA_HOME && await find(pjoin(env.JAVA_HOME, 'bin', windows ? 'java.exe' : 'java'))) || await find('java');
  if (!java) throw fail('缺少 Java/JDK，请安装项目要求的 Java 21+ 并配置 JAVA_HOME 后重试；不会自动修改系统环境', 503);
  return { mvn, npm, node: nodePath };
}

/** Fixed XiAN-OA local verification. The second argument is a trusted test seam,
 * never populated from HTTP input. No route accepts commands, ports or env.
 * inspect must validate the fixed repository and return its exact root and digest.
 */
export function createLocalDeploy({ inspect, redact = value => value }, dependencies = {}) {
  if (typeof inspect !== 'function') throw new TypeError('inspect is required');
  const deps = { platform: process.platform, spawn: nodeSpawn, kill: (pid, signal) => process.kill(pid, signal), portAvailable, health, discover, env: process.env, commandTimeout: 10 * 60_000, toolInstallTimeout: 30 * 60_000, readyTimeout: 90_000, pollInterval: 300, killGrace: 500, logLimit: 24_000, ...dependencies };
  const env = normalizeEnv(deps.env, deps.platform);
  for (const key of Object.keys(env)) if (/^(?:GH_|GITHUB_).*TOKEN$|^GITHUB_PAT$|^NODE_OPTIONS$|^NPM_CONFIG_SCRIPT_SHELL$/i.test(key)) delete env[key];
  const secrets = Object.entries(deps.env).filter(([key, value]) => value && /token|secret|password|api[_-]?key/i.test(key)).map(([, value]) => String(value)).filter(value => value.length >= 4);
  const sanitize = value => {
    let text = String(value); for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return defaultRedact(String(redact(defaultRedact(text))));
  };
  let state = 'stopped', info = null, confirmed = null, error = null, closed = false, generation = 0, active = null;
  let frontend = { state: 'stopped', ready: false, url: URLS.frontend }, backend = { state: 'stopped', ready: false, url: URLS.backend };
  let checks = { state: 'idle', frontend: 'idle', backend: 'idle', head: null, fingerprint: null };
  let logs = '', logsTruncated = false;
  const processes = new Set(), jobs = new Set();
  const log = value => { logs += sanitize(value); if (logs.length > deps.logLimit) { logs = logs.slice(-deps.logLimit); logsTruncated = true; } };
  const snapshot = () => ({ state, task: active, directory: info?.directory ?? null, head: info?.head ?? null, fingerprint: info?.fingerprint ?? null, urls: { ...URLS }, frontend: { ...frontend }, backend: { ...backend }, checks: { ...checks }, confirmed: confirmed ? { ...confirmed } : null, logs, logsTruncated, error });
  const current = token => { if (closed || generation !== token) throw fail('部署任务已取消'); };
  async function inspectInfo(directory) {
    if (typeof directory !== 'string' || !isAbsolute(directory) || /[\0\r\n]/.test(directory)) throw fail('需要项目绝对目录', 400);
    const result = await inspect(directory);
    if (result?.changes?.some(change => ['DD','AU','UD','UA','DU','AA','UU'].includes(change.status.trim()))) throw fail('请先解决 Git 冲突，再启动本地验证');
    if (!result || typeof result.directory !== 'string' || !isAbsolute(result.directory) || !result.head || !result.fingerprint) throw fail('项目检查未返回有效指纹');
    return { directory: result.directory, head: result.head, fingerprint: result.fingerprint, ...(result.contentFingerprint ? { contentFingerprint: result.contentFingerprint } : {}) };
  }
  async function project(directory) {
    const root = await realpath(directory);
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const modules = { ...pkg.dependencies, ...pkg.devDependencies };
    if (!modules.react || !modules.vite || !pkg.scripts?.build) throw fail('仅支持 React + Vite 项目');
    await access(join(root, 'backend/pom.xml'));
    return { root, modules };
  }
  async function prepareDependencies(original, tools, token) {
    const { root, modules } = await project(original.directory); current(token);
    const missing = [];
    for (const name of Object.keys(modules)) {
      if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name) || name.split('/').some(part => part === '.' || part === '..')) throw fail('不支持的依赖包名称');
      try { await access(join(root, 'node_modules', name, 'package.json')); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; missing.push(name); }
    }
    try { await access(join(root, 'node_modules/vite/bin/vite.js')); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; missing.push('vite 启动文件'); }
    if (!missing.length) { log('\n[dependencies] 前端直接依赖已存在；后端依赖由 Maven 自动解析下载。\n'); return; }
    log(`\n[dependencies] 缺少 ${missing.join('、')}，正在自动安装（包含开发依赖，可能下载网络资源并执行项目安装脚本）。\n`);
    let locked = false;
    for (const name of ['npm-shrinkwrap.json', 'package-lock.json']) {
      try { await access(join(root, name)); locked = true; } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    }
    await command(tools.npm, [locked ? 'ci' : 'install', ...(locked ? [] : ['--package-lock=false']), '--include=dev', '--no-audit', '--no-fund'], root, 'dependency install', token);
    current(token);
    for (const name of Object.keys(modules)) {
      try { await access(join(root, 'node_modules', name, 'package.json')); }
      catch { throw fail(`依赖安装后仍缺少 ${name}，请查看安装日志`); }
    }
    await access(join(root, 'node_modules/vite/bin/vite.js'));
  }
  function launch(command, args, directory, label, token) {
    current(token);
    log(`\n[${label}] ${command} ${args.join(' ')}\n`);
    // Windows native fs.watch can throw EBUSY on atomic-write staging files.
    // Chokidar (used by Vite) honors these fixed env overrides; scope to frontend.
    const childEnv = { ...env };
    if (deps.platform === 'win32' && label === 'frontend') {
      childEnv.CHOKIDAR_USEPOLLING = 'true';
      childEnv.CHOKIDAR_INTERVAL = '300';
      log('\n[frontend watch] Windows 使用 300ms 轮询监听，避免原子写入临时文件触发 EBUSY；可能增加 CPU/磁盘使用。\n');
    }
    const child = spawnPortable(command, args, { platform: deps.platform, spawnImpl: deps.spawn, ...(deps.existsImpl ? { existsImpl: deps.existsImpl } : {}), cwd: directory, env: childEnv, shell: false, detached: deps.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const record = { child, exited: false, label, stopping: null };
    processes.add(record);
    // Buffer whole lines so credentials split across stream chunks stay secret.
    let tail = '';
    const output = chunk => {
      tail += chunk.toString('utf8');
      let newline;
      while ((newline = tail.indexOf('\n')) >= 0) { log(tail.slice(0, newline + 1)); tail = tail.slice(newline + 1); }
      if (tail.length > deps.logLimit) { tail = tail.slice(-deps.logLimit); logsTruncated = true; }
    };
    child.stdout?.on('data', output); child.stderr?.on('data', output);
    record.done = new Promise((resolve, reject) => {
      record.cancel = () => reject(fail(`${label} 已取消`));
      child.once('error', cause => { record.exited = true; reject(fail(`无法启动 ${label}: ${cause.code || 'spawn error'}`)); });
      child.once('close', (code, signal) => { record.exited = true; if (tail) { log(tail); tail = ''; } code === 0 ? resolve() : reject(fail(`${label} 已退出 (${code ?? signal})`)); });
    });
    // Register immediately, including service processes not yet awaited.
    record.done.catch(() => {});
    return record;
  }
  async function terminate(record) {
    if (record.stopping) return record.stopping;
    record.stopping = (async () => {
      record.cancel();
      if (deps.platform === 'win32' && record.exited && record.child.pid && ['frontend', 'backend'].includes(record.label)) throw fail('服务父进程已退出，无法安全确认其后代进程已清理');
      try { await terminateTree(record.child, { killImpl: deps.kill, grace: deps.killGrace }); }
      catch (cause) { log(`\n停止 ${record.label}: ${cause.code || cause.message || 'error'}\n`); throw cause; }
      processes.delete(record);
    })();
    try { return await record.stopping; }
    catch (cause) { record.stopping = null; throw cause; }
  }
  async function stopProcesses() {
    const results = await Promise.allSettled([...processes].map(terminate));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) {
      state = 'failed'; confirmed = null; frontend.ready = backend.ready = false;
      frontend.state = backend.state = 'failed';
      error = sanitize(`进程树清理未确认，请重试停止: ${failed.reason.message}`);
      log(`\n${error}\n`);
      return false;
    }
    return true;
  }
  async function command(command, args, directory, label, token, timeout = deps.commandTimeout) {
    const record = launch(command, args, directory, label, token);
    let timer;
    try {
      await Promise.race([record.done, new Promise((_, reject) => { timer = setTimeout(() => reject(fail(`${label} 超时`, 504)), timeout); })]);
      current(token);
    } finally { clearTimeout(timer); await terminate(record); }
  }
  async function runChecks(original, tools, token) {
    confirmed = null; checks = { state: 'running', frontend: 'running', backend: 'idle', head: null, fingerprint: null };
    await command(tools.npm, ['run', 'build'], original.directory, 'frontend build', token);
    current(token); checks.frontend = 'passed'; checks.backend = 'running';
    await command(tools.mvn, ['-f', 'backend/pom.xml', 'test'], original.directory, 'backend test', token);
    current(token); checks.backend = 'passed';
    const after = await inspectInfo(original.directory); current(token);
    if (!same(original, after)) throw fail('检查期间项目发生变化，请重新检查');
    checks = { state: 'passed', frontend: 'passed', backend: 'passed', head: original.head, fingerprint: original.fingerprint };
  }
  function enqueue(kind, work) {
    if (active) throw fail('已有部署任务正在执行');
    const token = ++generation; active = kind;
    const job = Promise.resolve().then(() => work(token)).catch(async cause => {
      if (generation !== token || closed) return;
      confirmed = null; error = sanitize(cause.message); log(`\n${error}\n`);
      if (checks.state === 'running' || checks.state === 'pending') { if (checks.frontend === 'running') checks.frontend = 'failed'; if (checks.backend === 'running') checks.backend = 'failed'; checks.state = 'failed'; }
      if (kind === 'start') { state = 'failed'; frontend.ready = backend.ready = false; frontend.state = backend.state = 'stopped'; await stopProcesses(); }
    }).finally(() => { jobs.delete(job); if (generation === token) active = null; });
    jobs.add(job);
  }
  async function ready(token, records) {
    const deadline = Date.now() + deps.readyTimeout;
    while (Date.now() < deadline) {
      current(token);
      if (records.some(record => record.exited)) throw fail('服务在就绪前退出');
      const [front, back] = await Promise.all([deps.health(URLS.frontend), deps.health(URLS.health)]); current(token);
      frontend.ready = !!front; backend.ready = !!back;
      if (front && back) return;
      await delay(deps.pollInterval);
    }
    throw fail('本地服务健康检查超时', 504);
  }
  async function verify(candidate, requireConfirmation, expectedCurrent = candidate) {
    if (closed || active || state !== 'running' || !frontend.ready || !backend.ready || checks.state !== 'passed') throw fail('请先启动本地服务并完成检查');
    const token = generation, original = info;
    if (!same(original, candidate) || !same(original, { directory: original.directory, ...checks }) || (requireConfirmation && !same(original, confirmed))) throw fail('本地验证或确认已失效');
    const [after, front, back] = await Promise.all([inspectInfo(original.directory), deps.health(URLS.frontend), deps.health(URLS.health)]);
    if (closed || generation !== token || active || state !== 'running' || !same(expectedCurrent, after) || !front || !back) {
      confirmed = null; throw fail('项目已变化或服务未就绪，请重新检查并确认');
    }
    return original;
  }
  async function route(name, body = {}) {
    if (closed) throw fail('本地部署已关闭');
    if (name === 'deploy-status') return snapshot();
    if (name === 'deploy-stop') {
      if (active === 'stop') return snapshot();
      ++generation; active = 'stop'; confirmed = null; state = 'stopping'; frontend.ready = backend.ready = false;
      checks = { state: 'idle', frontend: 'idle', backend: 'idle', head: null, fingerprint: null };
      const stopToken = generation;
      const job = stopProcesses().then(cleaned => { if (generation === stopToken && cleaned) { state = 'stopped'; frontend.state = backend.state = 'stopped'; error = null; } }).finally(() => { jobs.delete(job); if (generation === stopToken) active = null; }); jobs.add(job);
      return snapshot();
    }
    if (name === 'deploy-confirm') {
      const candidate = { directory: body.directory ?? info?.directory, head: body.head, fingerprint: body.fingerprint };
      const token = generation, verified = await verify(candidate, false);
      current(token); if (active || state !== 'running' || !frontend.ready || !backend.ready) throw fail('本地验证已失效');
      confirmed = { ...verified, confirmedAt: new Date().toISOString() }; return snapshot();
    }
    if (name !== 'deploy-start' && name !== 'deploy-check') throw fail('Unknown local deploy route', 404);
    if (active) throw fail('已有部署任务正在执行');
    if (name === 'deploy-start' && state === 'running') throw fail('本地服务已经启动');
    if (processes.size && state === 'failed') throw fail('进程树清理未确认，请先重试停止，不能启动或检查其他进程');
    const directory = body.directory ?? info?.directory;
    if (typeof directory !== 'string' || !isAbsolute(directory) || /[\0\r\n]/.test(directory)) throw fail('需要项目绝对目录', 400);
    if (state === 'running' && await realpath(directory) !== info.directory) throw fail('请先停止当前项目');
    if (active) throw fail('已有部署任务正在执行');
    confirmed = null; error = null;
    checks = { state: name === 'deploy-start' ? 'idle' : 'pending', frontend: 'idle', backend: 'idle', head: null, fingerprint: null };
    if (name === 'deploy-start') { state = 'starting'; frontend.state = backend.state = 'starting'; }
    enqueue(name === 'deploy-start' ? 'start' : 'check', async token => {
      const { root } = await project(directory); current(token);
      let original;
      if (name === 'deploy-start') {
        original = { directory: root, head: null, fingerprint: null };
      } else {
        original = await inspectInfo(root); current(token);
        if (state === 'running' && !same(info, original)) throw fail('项目已变化，请停止并重新启动本地服务');
      }
      info = original;
      if (name === 'deploy-start') {
        const ports = await Promise.all([deps.portAvailable(5180), deps.portAvailable(8081)]); current(token);
        if (ports.some(value => !value)) throw fail('端口 5180 或 8081 已被占用；不会停止其他进程');
      }
      const tools = await deps.discover(env, { platform: deps.platform, log, check: () => current(token), ...(name === 'deploy-start' ? { run: (executable, args, directory, label) => command(executable, args, directory, label, token, deps.toolInstallTimeout) } : {}) }); current(token);
      await prepareDependencies(original, tools, token); current(token);
      if (name === 'deploy-check') { await runChecks(original, tools, token); current(token); return; }
      // This optional baseline protects later push verification only. Git state,
      // conflicts and repositories without HEAD must never prevent local startup.
      try { original = await inspectInfo(root); current(token); info = original; }
      catch (cause) { current(token); log(`\n[push baseline] ${cause.message}; 本地启动继续，推送前需重新启动以记录有效快照。\n`); }
      const portsStillFree = await Promise.all([deps.portAvailable(5180), deps.portAvailable(8081)]); current(token);
      if (portsStillFree.some(value => !value)) throw fail('端口 5180 或 8081 已被占用；不会停止其他进程');
      const records = [launch(tools.node, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5180', '--strictPort'], original.directory, 'frontend', token), launch(tools.mvn, ['-f', 'pom.xml', 'spring-boot:run', '-Dspring-boot.run.arguments=--server.address=127.0.0.1'], join(original.directory, 'backend'), 'backend', token)];
      for (const record of records) record.done.then(() => serviceExited(), () => serviceExited());
      function serviceExited() { if (!closed && records.some(record => !record.stopping && record.exited)) { confirmed = null; frontend.ready = backend.ready = false; if (state === 'running') { state = 'failed'; error = '本地服务已退出'; void stopProcesses(); } } }
      await ready(token, records); current(token);
      if (records.some(record => record.exited)) throw fail('本地服务已退出');
      state = 'running'; frontend.state = backend.state = 'running';
    });
    return snapshot();
  }
  async function close() {
    if (!closed) { closed = true; ++generation; confirmed = null; frontend.ready = backend.ready = false; }
    await stopProcesses(); await Promise.allSettled([...jobs]);
    if (await stopProcesses()) state = 'stopped';
    else throw fail(error || '进程树清理未确认');
  }
  // Internal capability only: core calls this after proving the index tree became
  // HEAD unchanged and the verified worktree content survived staging/commit.
  // HTTP routes cannot request rebinding or supply their own content identity.
  async function rebindVerified(before, after, { confirmedSelfTest } = {}) {
    if (confirmedSelfTest !== true || !before.contentFingerprint || before.contentFingerprint !== after.contentFingerprint || info?.contentFingerprint !== before.contentFingerprint || before.directory !== after.directory) throw fail('提交内容与本地验证不一致，请重新部署');
    const token = generation;
    await verify(before, false, after); current(token);
    info = { directory: after.directory, head: after.head, fingerprint: after.fingerprint, contentFingerprint: after.contentFingerprint };
    checks = { ...checks, head: after.head, fingerprint: after.fingerprint };
    confirmed = null;
  }
  async function assertVerified(candidate, { confirmedSelfTest } = {}) {
    if (confirmedSelfTest === true && checks.state !== 'passed') {
      if (closed || active || state !== 'running' || !frontend.ready || !backend.ready) throw fail('请先启动本地服务并完成检查');
      if (!info?.head || !info?.fingerprint || !same(info, candidate)) throw fail('项目已变化或缺少启动快照，请停止并重新启动本地服务后确认');
      const token = ++generation; active = 'check'; error = null;
      const job = (async () => {
        const [fresh, front, back] = await Promise.all([inspectInfo(info.directory), deps.health(URLS.frontend), deps.health(URLS.health)]);
        current(token);
        if (!same(info, fresh) || !front || !back) throw fail('项目已变化或服务未就绪，请重新启动并确认');
        const tools = await deps.discover(env, { platform: deps.platform, log, check: () => current(token), run: (executable, args, directory, label) => command(executable, args, directory, label, token, deps.toolInstallTimeout) }); current(token);
        await runChecks(info, tools, token);
      })();
      jobs.add(job);
      try { await job; }
      catch (cause) {
        if (generation === token && !closed) {
          confirmed = null; error = sanitize(cause.message); log(`\n${error}\n`);
          if (checks.state === 'running') { if (checks.frontend === 'running') checks.frontend = 'failed'; if (checks.backend === 'running') checks.backend = 'failed'; checks.state = 'failed'; }
        }
        throw cause;
      } finally { jobs.delete(job); if (generation === token) active = null; }
    }
    return { ...await verify(candidate, confirmedSelfTest !== true) };
  }
  return { route, assertVerified, rebindVerified, close };
}
