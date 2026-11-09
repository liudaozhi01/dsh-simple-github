import http from 'node:http';
import { schemaReviewMessage } from './schema-review-message.js';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { validateReleaseProfile } from './release-profile.js';
import { NATIVE_SSH_MESSAGES } from './native-ssh.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/;
const SHA = /^[a-f0-9]{40}$(?![\s\S])/;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const releaseRefusals = new Map([
  ['Preflight service failure: 预设超管初始化冲突：admin账号已绑定其他人员，请人工核对，不会自动换绑', '发布前检查失败：后端启动失败。预设超管初始化冲突：admin账号已绑定其他人员，请人工核对，不会自动换绑；本次发布尚未启动。'],
  ['Test database recovery failed; manual recovery required before retry', 'test 数据库自动恢复失败，环境仍处于维护中，禁止重试；须由管理员完成恢复和核对后才能重试。'],
  ['Dev release has no bound schema snapshot; publish dev first', '当前 dev 发布记录没有绑定数据库结构快照，请先重新发布 dev，再发布 test；本次未修改 test 数据库。'],
  ['Dev schema changed since verified release; publish dev first', 'dev 数据库结构已不同于已验证版本，请先重新发布 dev，再发布 test；本次未修改 test 数据库。'],
  ['Dev images changed since schema snapshot', '当前 dev 镜像已不同于结构快照绑定版本，请选择当前已验证的 dev 版本；本次未修改 test 数据库。'],
  ['Database schema difference requires manual review; no SQL executed', '数据库结构差异需要人工审查，未执行 SQL、未修改数据库；请联系管理员核对后再发布。'],
  ['Test image-only restore requires database compatibility review', 'test 历史恢复仅切换程序镜像，需要人工审查数据库兼容性；本次恢复尚未启动。'],
  ['Existing services must be healthy', '发布前检查失败：当前环境服务不健康，请先排查并恢复服务；本次发布尚未启动。'],
  ['Expected one existing container per service', '发布前检查失败：当前环境存在缺失或未运行的服务容器；本次发布尚未启动。'],
  ['Another release operation is active', '服务器已有发布操作正在执行，请先查询状态，不要重复发布。'],
  ['Unresolved job blocks new deployment', '当前环境有旧的未解决发布任务阻止新部署，请先查询任务状态并只读核对；本次发布尚未启动，不要重复发布。'],
]);
function knownReleaseRefusal(text) {
  if (typeof text !== 'string' || text.length > 65536) return;
  const schema = schemaReviewMessage(text);
  if (schema) return schema;
  const foreignKey = text.match(/Referencing column '([A-Za-z0-9_]+)' and referenced column '([A-Za-z0-9_]+)' in foreign key constraint '([A-Za-z0-9_]+)' are incompatible\./);
  if (foreignKey) return `发布前检查失败：后端启动失败，外键字段类型不兼容（引用字段 ${foreignKey[1]}，被引用字段 ${foreignKey[2]}，约束 ${foreignKey[3]}）。实际错误：${foreignKey[0]} 请先修复数据库结构与代码的兼容问题；本次发布尚未启动。`;
  for (const [source, message] of releaseRefusals) {
    if (text.split(/\r?\n/).some(line => line === source || line.endsWith(': ' + source) || line === message)) return message;
  }
}
function refusalStatus(reason) {
  return reason === releaseRefusals.get('Unresolved job blocks new deployment') ? 409 : 503;
}
const releaseStageLabels = Object.freeze({
  'db-preflight': '数据库发布前检查', 'db-maintenance': '进入数据库维护',
  'db-backup': '备份 test 数据库', 'db-backup-verify': '校验数据库备份',
  'db-backup-cleanup': '清理过期数据库备份', 'db-migrating': '同步数据库结构',
  'db-restoring': '恢复 test 数据库', 'db-restored': '数据库已恢复（发布失败）',
  'db-restore-failed': '数据库恢复失败（维护中，禁止重试）',
  queued: '排队中', preflight: '发布前检查', building: '服务器编译',
  applying: '更新服务', health: '健康检查', 'awaiting-acceptance': '等待验收',
});
function unresolvedActivityMessage(job) {
  // Failure diagnostics explain why the environment is blocked; activity metadata
  // must not hide them. Keep the no-replay guard and never echo arbitrary logs.
  if (job.status === 'uncertain') {
    const text = [job.errorSummary, ...(Array.isArray(job.errorDetails) ? job.errorDetails : [])].filter(x => typeof x === 'string').join('\n').slice(0, 65536);
    const admin = '预设超管初始化冲突：admin账号已绑定其他人员，请人工核对，不会自动换绑';
    const foreignKey = text.match(/Referencing column '[A-Za-z0-9_]+' and referenced column '[A-Za-z0-9_]+' in foreign key constraint '[A-Za-z0-9_]+' are incompatible\./);
    const reason = text.includes(admin) ? admin : foreignKey?.[0];
    if (reason) return `上次发布失败，结果仍待核对。实际错误：${reason}。本次发布尚未启动；请先处理故障并核对旧任务，不要重复发布。`;
  }
  if (!Object.hasOwn(job, 'activity')) return '任务记录未完成，服务器尚未提供活动核验，请核对/升级';
  const activity = job.activity;
  if (!activity || ![Object.prototype, null].includes(Object.getPrototypeOf(activity)) ||
    !['active', 'interrupted', 'unknown', 'finished'].includes(activity.state)) return '无法确认发布活动，暂不发布';
  if (activity.state === 'interrupted') return '上次发布已中断，待核对';
  // Activity is diagnostic only: even "finished" cannot resolve an unfinished job.
  if (activity.state !== 'active') return '无法确认发布活动，暂不发布';
  const actor = typeof job.actor === 'string'
    ? Array.from(job.actor.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim()).slice(0, 80).join('') : '';
  const details = [];
  if (typeof job.stage === 'string' && Object.hasOwn(releaseStageLabels, job.stage)) details.push('阶段：' + releaseStageLabels[job.stage]);
  if (Number.isSafeInteger(job.createdAt) && job.createdAt >= 0 && job.createdAt <= 253402300799) details.push('创建时间：' + new Date(job.createdAt * 1000).toISOString());
  return `${actor || '某位成员'}正在发布 ${job.environment}${details.length ? '（' + details.join('；') + '）' : ''}；暂不重复发布`;
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
export function createTemporaryReleaseTransport({ port, bridge: injectedBridge, script: injectedScript, team = false, projectId } = {}) {
  if (projectId !== undefined && (!team || typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{0,39}$(?![\s\S])/.test(projectId))) throw new TypeError('Invalid controlled deployment project ID');
  const entryPath = projectId === undefined ? '/usr/local/libexec/xian-oa-team-entry.py' : `/usr/local/libexec/dsh-release-${projectId}/entry.py`;
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
      if (reason) throw fail(reason, refusalStatus(reason));
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
      if (projectId !== undefined) {
        const handshake = await exec(profile, `/usr/bin/python3 -I ${entryPath} '${encode({action:'overview',body:{}})}'`);
        let info; try { info = JSON.parse(handshake); } catch { throw fail('服务器部署身份响应无效', 503); }
        if (info?.error || info?.deploymentProjectId !== projectId || info?.deploymentProtocolVersion !== 1 || info?.deploymentRepository !== profile.repository || info?.deploymentBranch !== profile.branch) throw fail('服务器部署身份或协议不匹配，未上传源码或提交发布', 503);
        if (await host(profile) !== identity) throw fail('SSH 配置已变化', 503);
      }
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
      const output = await exec(profile, `/usr/bin/python3 -I ${entryPath} '${encode(payload)}'`);
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
export function createTemporaryReleaseClient({ port, getUser, profile: inputProfile, source, transport, team = false, projectId } = {}) {
  const profile = validateReleaseProfile(inputProfile);
  if (typeof getUser !== 'function') throw new TypeError('Trusted getUser required');
  if (source !== undefined && (typeof source.resolve !== 'function' || typeof source.prepare !== 'function')) throw new TypeError('Trusted source.resolve/prepare required');
  if (projectId !== undefined && (!team || typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{0,39}$(?![\s\S])/.test(projectId))) throw new TypeError('Invalid controlled deployment project ID');
  const channel = transport ?? createTemporaryReleaseTransport({ port, team, projectId });
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
    catch (error) {
      const reason = knownReleaseRefusal(error?.message);
      const connectionReason = NATIVE_SSH_MESSAGES.includes(error?.message) ? error.message : undefined;
      throw fail(reason || connectionReason || '临时发布入口未明确响应；请查询状态，不要重复提交发布', reason ? refusalStatus(reason) : connectionReason && [400,409,503].includes(error.status) ? error.status : 503);
    }
    ensure();
    if (!response || ![Object.prototype, null].includes(Object.getPrototypeOf(response))) throw fail('临时发布入口拒绝或未明确响应；请查询状态', 503);
    if (response.ok === false || Object.hasOwn(response, 'error')) {
      const reason = knownReleaseRefusal(response.error);
      throw fail(reason || '临时发布入口拒绝或未明确响应；请查询状态', reason ? refusalStatus(reason) : 503);
    }
    if (projectId !== undefined && (response.deploymentProjectId !== projectId || response.deploymentProtocolVersion !== 1 || response.deploymentRepository !== profile.repository || response.deploymentBranch !== profile.branch)) throw fail('服务器部署项目身份不匹配，请核对初始化配置', 503);
    return structuredClone(response);
  }
  async function preflight(environment) {
    if (!team) return;
    const overview = await call('overview', {});
    // Missing or ambiguous history must never be interpreted as an idle environment.
    if (!Array.isArray(overview.jobs) || !overview.jobs.every(job => job &&
      [Object.prototype, null].includes(Object.getPrototypeOf(job)) &&
      typeof job.jobId === 'string' && ID.test(job.jobId) &&
      ['dev', 'test'].includes(job.environment) &&
      ['pending', 'running', 'uncertain', 'delivered', 'failed', 'ready', 'accepted'].includes(job.status))) throw fail('发布任务概览格式无效；未准备源码或启动发布，请先查询状态', 503);
    const unresolved = overview.jobs.filter(job => job.environment === environment && ['pending', 'running', 'uncertain'].includes(job.status));
    if (unresolved.length) {
      // Prefer a positively verified active publisher over stale history in the same environment.
      const job = unresolved.find(job => job.activity?.state === 'active') || unresolved[0];
      throw fail(unresolvedActivityMessage(job), 409);
    }
  }
  function remember(response, environment, expectedHead) {
    id(response.planId);
    const remote = response.remote;
    if (response.environment !== environment || !remote || remote.repository !== profile.repository || remote.branch !== profile.branch || !SHA.test(remote.head || '') || (expectedHead && remote.head !== expectedHead) || !Number.isFinite(response.expiresAt)) throw fail('服务器发布计划与检查源码不匹配', 503);
    if (['databaseMode', 'databasePreview', 'databaseForcePlan', 'databaseForcePreview'].some(key => Object.hasOwn(response, key))) throw fail('服务器发布计划包含未知数据库字段，请重新获取安全计划', 503);
    plans.set(response.planId, { environment, head: remote.head, expiresAt: response.expiresAt, restore: response.operation === 'restore' });
    if (plans.size > 100) plans.delete(plans.keys().next().value);
    return response;
  }
  return Object.freeze({
    async check(input = {}) {
      object(input, []); ensure();
      if (!source) throw fail('未配置本地安全源码打包器', 503);
      await preflight('dev');
      const remote = await source.resolve({ repository: profile.repository, branch: profile.branch }); ensure();
      if (remote?.repository !== profile.repository || remote?.branch !== profile.branch || !SHA.test(remote?.head || '')) throw fail('远程分支源码身份无效', 503);
      const head = remote.head;
      return remember(await call('check', { head }), 'dev', head);
    },
    async promotion(input = {}) {
      const body = object(input, ['releaseId']); id(body.releaseId);
      ensure(); await owner(['test']);
      const response = await call('promote', body);
      return remember(response, 'test');
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
      await preflight(plan.environment);
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
