import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { validateReleaseProfile } from './release-profile.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/;
const SHA = /^[a-f0-9]{40}$(?![\s\S])/;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const releaseRefusals = new Map([
  ['Existing services must be healthy', '发布前检查失败：当前环境服务不健康，请先排查并恢复服务；本次发布尚未启动。'],
  ['Expected one existing container per service', '发布前检查失败：当前环境存在缺失或未运行的服务容器；本次发布尚未启动。'],
  ['Another release operation is active', '服务器已有发布操作正在执行，请先查询状态，不要重复发布。'],
]);
function knownReleaseRefusal(text) {
  if (typeof text !== 'string' || text.length > 65536) return;
  const foreignKey = text.match(/Referencing column '([A-Za-z0-9_]+)' and referenced column '([A-Za-z0-9_]+)' in foreign key constraint '([A-Za-z0-9_]+)' are incompatible\./);
  if (foreignKey) return `发布前检查失败：后端启动失败，外键字段类型不兼容（引用字段 ${foreignKey[1]}，被引用字段 ${foreignKey[2]}，约束 ${foreignKey[3]}）。实际错误：${foreignKey[0]} 请先修复数据库结构与代码的兼容问题；本次发布尚未启动。`;
  for (const [source, message] of releaseRefusals) {
    if (text.split(/\r?\n/).some(line => line === source || line.endsWith(': ' + source) || line === message)) return message;
  }
}
function object(value, keys) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(k => !keys.includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k), 'value'))) throw fail('发布请求字段无效');
  return { ...value };
}
function id(value) { if (typeof value !== 'string' || !ID.test(value)) throw fail('需要有效的任务或发布编号'); }
function bundleInfo(value) {
  if (!value || typeof value.path !== 'string' || !isAbsolute(value.path) || /[\x00-\x1f\x7f]/.test(value.path) || !/^[a-f0-9]{64}$(?![\s\S])/.test(value.sha256 || '') || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > 256 * 1024 * 1024 || typeof value.cleanup !== 'function') throw fail('源码包元数据无效');
  return { path: value.path, sha256: value.sha256, size: value.size };
}
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const python = code => `sudo -n /usr/bin/python3 -I - <<'DSH_TEMPORARY_RELEASE'\n${code}\nDSH_TEMPORARY_RELEASE`;

/** Production transport: fixed loopback bridge, verified SSH identity, no permanent install.
 * request({profile,action,body,bundle?}) -> remote JSON. bundle is trusted local metadata.
 * bridge/script injection is for local tests only, never HTTP input.
 */
export function createTemporaryReleaseTransport({ port, bridge: injectedBridge, script: injectedScript, team = false } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Loopback DSH port required');
  let closed = false;
  const requests = new Set();
  const ensure = () => { if (closed) throw fail('发布连接已关闭', 503); };
  async function bridge(path, { json, file } = {}) {
    ensure();
    if (injectedBridge) return injectedBridge(path, { json, file });
    return new Promise((resolve, reject) => {
      let source, output = '', length = 0, done = false;
      const req = http.request({ hostname: '127.0.0.1', port, path, method: json || file ? 'POST' : 'GET', agent: false, headers: json ? { 'content-type': 'application/json' } : file ? { 'content-type': 'application/octet-stream' } : {} }, res => {
        res.setEncoding('utf8');
        res.on('data', chunk => { length += Buffer.byteLength(chunk); if (length > 1024 * 1024) req.destroy(fail('SSH 响应超过限制', 503)); else output += chunk; });
        res.on('error', finish);
        res.on('end', () => {
          if (res.statusCode !== 200) return finish(fail(`SSH 桥接失败 (${res.statusCode})`, 503));
          try {
            if (!file) return finish(null, JSON.parse(output));
            const lines = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
            if (lines.filter(line => line.type === 'result').length !== 1 || lines.at(-1)?.type !== 'result' || lines.at(-1).ok !== true) throw fail('上传未明确成功', 503);
            finish(null, lines.at(-1));
          } catch (error) { finish(error); }
        });
      });
      const timer = setTimeout(() => req.destroy(fail('SSH 超时；请查询状态，不要重试发布', 503)), 240000);
      function finish(error, value) { if (done) return; done = true; clearTimeout(timer); requests.delete(req); source?.destroy(); if (error) { req.destroy(); reject(error); } else resolve(value); }
      requests.add(req); req.on('error', finish);
      if (file) { source = createReadStream(file); source.on('error', error => req.destroy(error)); source.pipe(req); }
      else req.end(json ? JSON.stringify(json) : undefined);
    });
  }
  async function host(profile) {
    const data = await bridge('/api/dsh-ssh/hosts');
    const matches = data?.hosts?.filter(item => item.alias === profile.target.alias);
    if (!Array.isArray(matches) || matches.length !== 1) throw fail('固定 SSH 主机缺失或重复', 503);
    const item = matches[0], target = profile.target;
    // Team mode uses each member's saved SSH account; fixed destination remains pinned.
    // Its actual identity is rechecked around upload/exec and authorized by SO_PEERCRED.
    const keys = team ? ['alias', 'host', 'port'] : ['alias', 'host', 'user', 'port'];
    if (keys.some(key => item[key] !== target[key]) || (team && (!/^[a-z_][a-z0-9_-]*$/.test(item.user || '') || item.user === 'root')) || !['key', 'password', 'agent'].includes(item.auth) || !Array.isArray(item.proxyJump) || item.proxyJump.length || item.proxyCommand) throw fail('SSH 身份不匹配或包含代理配置', 503);
    return JSON.stringify({ ...target, user: item.user, auth: item.auth, updatedAt: item.updatedAt ?? null });
  }
  async function exec(profile, command) {
    const data = await bridge('/api/dsh-ssh/exec', { json: { alias: profile.target.alias, command, timeoutMs: 180000 } });
    const result = data?.result;
    if (result && result.exitCode !== 0 && !result.timedOut && !result.truncated) {
      let responseReason;
      try { responseReason = knownReleaseRefusal(JSON.parse(result.stdout)?.error); } catch { /* Non-JSON SSH failures stay private. */ }
      const reason = responseReason || knownReleaseRefusal(result.stderr) || knownReleaseRefusal(result.stdout);
      if (reason) throw fail(reason, 503);
    }
    if (!result || result.exitCode !== 0 || result.timedOut || result.truncated || typeof result.stdout !== 'string') throw fail('远程操作未明确响应；请查询状态，不要重复提交发布', 503);
    return result.stdout;
  }
  async function request({ profile: inputProfile, action, body, bundle }) {
    ensure();
    const profile = validateReleaseProfile(inputProfile);
    if (!['check', 'promote', 'start', 'status', 'overview', 'restore', 'accept', 'reconcile'].includes(action)) throw fail('无效发布操作');
    if (bundle) { if (action !== 'start') throw fail('仅开发启动允许源码包'); bundle = bundleInfo({ ...bundle, cleanup() {} }); }
    if (team) {
      const identity = await host(profile);
      let remoteBundle;
      if (bundle) {
        const upload = '/tmp/dsh-upload-' + randomUUID();
        // Ordinary SSH identity creates its own private data directory; no sudo.
        const code = `import os\nos.umask(0o077)\nos.mkdir('${upload}',0o700)`;
        await exec(profile, `/usr/bin/python3 -I - <<'DSH_TEAM_UPLOAD'\n${code}\nDSH_TEAM_UPLOAD`);
        if (await host(profile) !== identity) throw fail('SSH 配置已变化', 503);
        await bridge('/api/dsh-ssh/upload?' + new URLSearchParams({ alias: profile.target.alias, remotePath: upload + '/source.tar' }), { file: bundle.path });
        remoteBundle = { path: upload + '/source.tar', sha256: bundle.sha256, size: bundle.size };
        if (await host(profile) !== identity) throw fail('SSH 配置已变化', 503);
        // SFTP may create 0644 independently of the earlier SSH process umask.
        const seal = `import os,stat\nfd=os.open('${upload}/source.tar',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)\ntry:\n s=os.fstat(fd)\n assert stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and s.st_nlink==1\n os.fchmod(fd,0o600)\nfinally: os.close(fd)`;
        await exec(profile, `/usr/bin/python3 -I - <<'DSH_TEAM_SEAL'\n${seal}\nDSH_TEAM_SEAL`);
      }
      if (await host(profile) !== identity) throw fail('SSH 配置已变化', 503);
      // Only action/body cross the privilege boundary. Server owns profile and ACL.
      const payload = { action, body: { ...body, ...(remoteBundle ? { bundle: remoteBundle } : {}) } };
      const output = await exec(profile, `/usr/bin/python3 -I /usr/local/libexec/xian-oa-team-entry.py '${encode(payload)}'`);
      if (Buffer.byteLength(output) > 65536) throw fail('发布响应超过限制', 503);
      try { return JSON.parse(output); } catch { throw fail('发布响应格式无效', 503); }
    }
    const bytes = injectedScript === undefined ? await readFile(new URL('./temporary-release.py', import.meta.url)) : Buffer.from(injectedScript);
    if (!bytes.length || bytes.length > 65536) throw fail('临时发布脚本必须在 64KiB 内', 503);
    const identity = await host(profile), uuid = randomUUID();
    const stage = '/var/tmp/dsh-release-' + uuid, upload = '/tmp/dsh-upload-' + uuid;
    let remoteBundle;
    if (bundle) {
      // User-writable upload is data only. Root never executes a script from here.
      await exec(profile, python(`import os,pwd\nu=pwd.getpwnam('${profile.target.user}')\nos.mkdir('${upload}',0o700)\nos.chown('${upload}',u.pw_uid,u.pw_gid)\nprint('UPLOAD_STAGE_OK')`));
      if (await host(profile) !== identity) throw fail('SSH 配置已变化', 503);
      await bridge('/api/dsh-ssh/upload?' + new URLSearchParams({ alias: profile.target.alias, remotePath: upload + '/source.tar' }), { file: bundle.path });
      remoteBundle = { path: stage + '/archive.tar.gz', sha256: bundle.sha256, size: bundle.size };
    }
    if (await host(profile) !== identity) throw fail('SSH 配置已变化', 503);
    const payload = { profile, action, body: { ...body, ...(remoteBundle ? { bundle: remoteBundle } : {}) } };
    const code = `import os,sys,stat,base64,json,hashlib,subprocess,shutil,pwd\nassert os.geteuid()==0 and os.environ.get('SUDO_USER')=='${profile.target.user}', 'sudo identity mismatch'\nstage='${stage}'\nos.umask(0o077)\nos.mkdir(stage,0o700)\nowned=os.lstat(stage)\ndef cleanup_stage():\n try: current=os.lstat(stage)\n except FileNotFoundError: return\n assert stat.S_ISDIR(current.st_mode) and current.st_uid==0 and (current.st_dev,current.st_ino)==(owned.st_dev,owned.st_ino), 'stage identity changed'\n shutil.rmtree(stage)\nresult=None\ntry:\n script=base64.b64decode('${bytes.toString('base64')}')\n assert len(script)<=65536\n fd=os.open(stage+'/script.py',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)\n with os.fdopen(fd,'wb') as f: f.write(script)\n${remoteBundle ? ` upload='${upload}'\n u=pwd.getpwnam('${profile.target.user}')\n s=os.lstat(upload)\n assert stat.S_ISDIR(s.st_mode) and s.st_uid==u.pw_uid\n dfd=os.open(upload,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)\n try:\n  src=os.open('source.tar',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=dfd)\n  with os.fdopen(src,'rb') as f:\n   s=os.fstat(f.fileno())\n   assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==u.pw_uid and s.st_size==${bundle.size}\n   dst=os.open(stage+'/archive.tar.gz',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)\n   h=hashlib.sha256(); n=0\n   with os.fdopen(dst,'wb') as out:\n    while True:\n     chunk=f.read(1048576)\n     if not chunk: break\n     n+=len(chunk); assert n<=${bundle.size}; h.update(chunk); out.write(chunk)\n   assert n==${bundle.size} and h.hexdigest()=='${bundle.sha256}', 'source checksum mismatch'\n  os.unlink('source.tar',dir_fd=dfd)\n finally: os.close(dfd)\n os.rmdir(upload)\n` : ''} result=subprocess.run(['/usr/bin/python3','-I',stage+'/script.py','${encode(payload)}'])\n sys.exit(result.returncode)\nfinally:\n${action === 'start' ? " # Successful start hands this private stage to the worker.\n if result is None or result.returncode!=0: cleanup_stage()" : ' cleanup_stage()'}\n`;
    const output = await exec(profile, python(code));
    if (Buffer.byteLength(output) > 65536) throw fail('发布响应超过限制', 503);
    try { return JSON.parse(output); } catch { throw fail('发布响应格式无效', 503); }
  }
  return Object.freeze({ request, close() { closed = true; for (const req of requests) req.destroy(fail('发布连接已关闭', 503)); } });
}

/** Same public operations as server-release-client, but no permanent remote entry.
 * source.resolve({repository,branch}) -> {repository,branch,head};
 * source.prepare({repository,branch,head}) -> {path,sha256,size,cleanup}.
 * Injected transport is a callable(request) or {request,close}; it receives immutable profile.
 */
export function createTemporaryReleaseClient({ port, getUser, profile: inputProfile, source, transport, team = false } = {}) {
  const profile = validateReleaseProfile(inputProfile);
  if (typeof getUser !== 'function') throw new TypeError('Trusted getUser required');
  if (source !== undefined && (typeof source.resolve !== 'function' || typeof source.prepare !== 'function')) throw new TypeError('Trusted source.resolve/prepare required');
  const channel = transport ?? createTemporaryReleaseTransport({ port, team });
  const run = typeof channel === 'function' ? channel : channel?.request?.bind(channel);
  if (typeof run !== 'function') throw new TypeError('Trusted transport required');
  let closed = false;
  const plans = new Map();
  const ensure = () => { if (closed) throw fail('发布连接已关闭', 503); };
  async function owner(environments) {
    const user = await getUser();
    if (typeof user?.name !== 'string' || !user.name.trim() || (!team && environments.some(environment => !profile.allowedNames[environment].includes(user.name)))) throw fail('插件当前登录姓名不在发布授权名单', 403);
    ensure();
  }
  async function call(action, body, bundle) {
    ensure();
    let response;
    try { response = await run({ profile, action, body: structuredClone(body), ...(bundle ? { bundle } : {}) }); }
    catch (error) { throw fail(knownReleaseRefusal(error?.message) || '临时发布入口未明确响应；请查询状态，不要重复提交发布', 503); }
    ensure();
    if (!response || ![Object.prototype, null].includes(Object.getPrototypeOf(response)) || response.ok === false || Object.hasOwn(response, 'error')) throw fail('临时发布入口拒绝或未明确响应；请查询状态', 503);
    return structuredClone(response);
  }
  function remember(response, environment, expectedHead) {
    id(response.planId);
    const remote = response.remote;
    if (response.environment !== environment || !remote || remote.repository !== profile.repository || remote.branch !== profile.branch || !SHA.test(remote.head || '') || (expectedHead && remote.head !== expectedHead) || !Number.isFinite(response.expiresAt)) throw fail('服务器发布计划与检查源码不匹配', 503);
    plans.set(response.planId, { environment, head: remote.head, expiresAt: response.expiresAt, restore: response.operation === 'restore' });
    if (plans.size > 100) plans.delete(plans.keys().next().value);
    return response;
  }
  return Object.freeze({
    async check(input = {}) {
      object(input, []); ensure();
      if (!source) throw fail('未配置本地安全源码打包器', 503);
      const remote = await source.resolve({ repository: profile.repository, branch: profile.branch }); ensure();
      if (remote?.repository !== profile.repository || remote?.branch !== profile.branch || !SHA.test(remote?.head || '')) throw fail('远程分支源码身份无效', 503);
      const head = remote.head;
      return remember(await call('check', { head }), 'dev', head);
    },
    async promotion(input = {}) {
      const body = object(input, ['releaseId']); id(body.releaseId); ensure(); await owner(['test']);
      return remember(await call('promote', body), 'test');
    },
    async restore(input = {}) {
      const body = object(input, ['environment', 'jobId']); id(body.jobId);
      if (!['dev', 'test'].includes(body.environment)) throw fail('无效恢复环境');
      ensure(); await owner([body.environment]);
      const response = await call('restore', body);
      if (response.operation !== 'restore') throw fail('服务器不支持历史恢复，请升级发布入口', 503);
      return remember(response, body.environment);
    },
    async start(input = {}) {
      const body = object(input, ['planId', 'confirmation', 'databaseRiskAccepted']); id(body.planId); ensure();
      if (body.confirmation !== true || body.databaseRiskAccepted !== true) throw fail('必须明确确认发布及数据库风险');
      // The remembered server plan determines authorization; browser cannot select it.
      const current = await getUser(); ensure();
      if (typeof current?.name !== 'string' || !current.name.trim() || (!team && !['dev', 'test'].some(environment => profile.allowedNames[environment].includes(current.name)))) throw fail('插件当前登录姓名不在发布授权名单', 403);
      const plan = plans.get(body.planId);
      if (!plan) throw fail('计划未在当前连接检查，请重新检查');
      await owner([plan.environment]);
      if (plan.expiresAt <= Date.now() / 1000) throw fail('计划已过期，请重新检查');
      plans.delete(body.planId); // One use before source preparation/upload; never replay writes.
      let bundle;
      try {
        if (plan.environment === 'dev' && !plan.restore) {
          if (!source) throw fail('未配置本地安全源码打包器', 503);
          bundle = await source.prepare({ repository: profile.repository, branch: profile.branch, head: plan.head });
          const metadata = bundleInfo(bundle); ensure(); await owner([plan.environment]);
          return await call('start', body, metadata);
        }
        return await call('start', body);
      } finally { if (typeof bundle?.cleanup === 'function') await bundle.cleanup(); }
    },
    async overview() { return call('overview', {}); },
    async status(jobId) { if (jobId !== undefined) id(jobId); return call('status', jobId === undefined ? {} : { jobId }); },
    async accept(input = {}) { const body = object(input, ['jobId', 'confirmation']); id(body.jobId); if (body.confirmation !== true) throw fail('必须明确确认业务验收'); ensure(); await owner(['dev']); return call('accept', body); },
    async reconcile(input = {}) { const body = object(input, ['jobId']); id(body.jobId); return call('reconcile', body); },
    close() { closed = true; plans.clear(); channel.close?.(); },
  });
}
