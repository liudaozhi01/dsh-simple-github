import http from 'node:http';
import { createReadStream } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnPortable, terminateTree, normalizeEnv } from './platform.js';
import { discover } from './local-deploy.js';

const TARGET = Object.freeze({ alias: 'xian-oa-test', host: '119.45.50.213', user: 'liudaozhi', root: '/opt/xian-oa-dev', service: 'xian-oa-dev.service', backendPort: 8082, frontendPort: 18081 });
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => ['directory', 'head', 'fingerprint', 'branch'].every(key => a[key] === b[key]);
const redactDefault = value => String(value).replace(/(?:gh[pousr]_[\w]+|github_pat_[\w]+)/g, '[REDACTED]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@').replace(/((?:authorization|password|passwd|secret|[\w-]*token|api[_-]?key)\s*[=:]\s*["']?)(?:bearer\s+|token\s+)?[^\s,"'}]+/ig, '$1[REDACTED]');

// These programs are static except for internally generated UUIDs and hashes.
// Validate only fixed dev config/port, never output environment values or credentials.
const PY_PREFLIGHT = String.raw`
import os, stat, subprocess, json, re, hashlib, urllib.request
ROOT='/opt/xian-oa-dev'
def safe(p, kind=None):
    assert os.path.isabs(p) and os.path.normpath(p)==p, 'noncanonical path'
    parts=p.split('/')[1:]; cur=''
    for part in parts:
        cur += '/' + part
        s=os.lstat(cur)
        assert not stat.S_ISLNK(s.st_mode), 'symlink path'
    if kind=='dir': assert stat.S_ISDIR(s.st_mode), 'directory required'
    if kind=='file': assert stat.S_ISREG(s.st_mode), 'regular file required'
    return s

def tree(p):
    safe(p,'dir')
    for base,dirs,files in os.walk(p,followlinks=False):
        for n in dirs: safe(base+'/'+n,'dir')
        for n in files: safe(base+'/'+n,'file')

def preflight():
    assert os.geteuid()==0 and os.environ.get('SUDO_USER')=='liudaozhi', 'sudo remote identity mismatch'
    safe('/tmp','dir'); safe(ROOT,'dir'); safe(ROOT+'/app.jar','file'); tree(ROOT+'/web')
    assert os.access(ROOT,os.W_OK|os.X_OK), 'deployment root not writable'
    for name in ['.dsh-native-deploy.lock']:
        p=ROOT+'/'+name
        if os.path.lexists(p): safe(p,'file')
    unit='/etc/systemd/system/xian-oa-dev.service'
    safe(unit,'file')
    props={}
    for key in ['LoadState','FragmentPath','WorkingDirectory','ExecStart','DropInPaths','ExecStartPre','ExecStartPost','ExecStopPost','User']:
        props[key]=subprocess.check_output(['systemctl','show','xian-oa-dev.service','--property='+key,'--value'],text=True).strip()
    assert props['LoadState']=='loaded' and props['FragmentPath']==unit, 'service identity mismatch'
    assert props['WorkingDirectory']==ROOT, 'service working directory mismatch'
    assert all(not props[k] for k in ['DropInPaths','ExecStartPre','ExecStartPost','ExecStopPost']), 'service overrides/hooks require manual review'
    cmd=props['ExecStart']
    assert re.search(r'(?<![\w/.-])/opt/xian-oa-dev/app\.jar(?![\w/.-])',cmd), 'service jar mismatch'
    assert props['User']=='xian-oa-dev', 'service user mismatch'
    config='/etc/xian-oa-dev/app.env'
    safe(config,'file')
    assert os.stat(config).st_uid==0 and not os.stat(config).st_mode & 0o022, 'unsafe config permissions'
    with open(unit) as f: unit_text=f.read()
    assert re.search(r'(?m)^EnvironmentFile=/etc/xian-oa-dev/app[.]env\s*$',unit_text), 'service config mismatch'
    # Read only SERVER_PORT lines, never return config contents (including credentials).
    with open(config) as f: ports=[line.strip() for line in f if re.match(r'^(?:export\s+)?SERVER_PORT=',line)]
    assert len(ports)==1 and re.fullmatch(r'(?:export\s+)?SERVER_PORT=[\x22\x27]?8082[\x22\x27]?',ports[0]), 'dev port mismatch'
    assert not re.search(r'--server[.]port',cmd), 'unexpected command port override'
    assert not re.search(r'/opt/(?!xian-oa-dev(?:/|\s|;|$))',cmd), 'other deployment path in service'
    subprocess.run(['sudo','-n','-l','/usr/bin/systemctl','restart','xian-oa-dev.service'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    return 'NATIVE_PREFLIGHT_OK'
`;
const pythonCommand = program => `sudo -n /usr/bin/python3 -I -c ${quote(program)}`;
const preflightCommand = pythonCommand(PY_PREFLIGHT + '\nprint(preflight())\n');

function stageCommand(id) {
  return pythonCommand(PY_PREFLIGHT + `\npreflight()\np='/tmp/dsh-xian-oa-dev-${id}'\nos.mkdir(p,0o700)\nimport pwd\nu=pwd.getpwnam('liudaozhi')\nos.chown(p,u.pw_uid,u.pw_gid)\nprint('NATIVE_STAGE_OK')\n`);
}
function applyCommand(id, hash) {
  return pythonCommand(PY_PREFLIGHT + String.raw`
import sys, hashlib, tarfile, shutil, fcntl, time, urllib.request, io
ID='${id}'
HASH='${hash}'
STAGE='/tmp/dsh-xian-oa-dev-'+ID
MARK=ROOT+'/.dsh-native-deploy-'+ID+'.json'
BACKUP=ROOT+'/.dsh-native-backup-'+ID
INCOMING=ROOT+'/.dsh-native-incoming-'+ID

def emit(state):
    print('NATIVE_RESULT '+json.dumps({'id':ID,'hash':HASH,'state':state,'backupPath':BACKUP}),flush=True)

def marker(state):
    # Replace only our regular, private marker under the checked fixed root.
    safe(MARK,'file')
    temp=MARK+'.next'
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f:
        json.dump({'id':ID,'hash':HASH,'state':state,'backupPath':BACKUP},f); f.flush(); os.fsync(f.fileno())
    os.replace(temp,MARK)

preflight()
lockfd=os.open(ROOT+'/.dsh-native-deploy.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
fcntl.flock(lockfd,fcntl.LOCK_EX|fcntl.LOCK_NB)
# Completed/failed/started markers survive DSH restarts and SSH command replays.
if os.path.lexists(MARK):
    safe(MARK,'file')
    with open(MARK) as f: previous=json.load(f)
    assert previous.get('id')==ID and previous.get('hash')==HASH, 'marker identity mismatch'
    emit(previous['state']); sys.exit(0 if previous['state']=='completed' else 1)
fd=os.open(MARK,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'w') as f:
    json.dump({'id':ID,'hash':HASH,'state':'started','backupPath':BACKUP},f); f.flush(); os.fsync(f.fileno())
try:
    safe(STAGE,'dir'); safe(STAGE+'/bundle.tar','file')
    fd=os.open(STAGE+'/bundle.tar',os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        assert stat.S_ISREG(os.fstat(f.fileno()).st_mode), 'regular archive required'
        archive_bytes=f.read(536870913)
        assert len(archive_bytes)<=536870912, 'archive size budget'
        assert hashlib.sha256(archive_bytes).hexdigest()==HASH, 'archive checksum mismatch'
    assert not os.path.lexists(INCOMING) and not os.path.lexists(BACKUP), 'operation paths already exist'
    # Validate every header BEFORE extraction: regular files/directories only,
    # exact app.jar + web subtree, no links/devices/PAX path traversal.
    with tarfile.open(fileobj=io.BytesIO(archive_bytes),mode='r:') as archive:
        members=archive.getmembers(); names=set(); total=0
        assert 0<len(members)<=50000, 'archive entry budget'
        for m in members:
            n=m.name.rstrip('/')
            assert n and not n.startswith('/') and '\\' not in n and all(p not in ('','..','.') for p in n.split('/')), 'unsafe archive path'
            assert n not in names, 'duplicate archive path'
            names.add(n)
            assert (n=='app.jar' and m.isfile()) or (n=='web' and m.isdir()) or (n.startswith('web/') and (m.isfile() or m.isdir())), 'unexpected archive member'
            assert not m.issym() and not m.islnk(), 'archive links forbidden'
            total+=m.size
            assert total<=536870912, 'archive size budget'
        assert 'app.jar' in names and 'web/index.html' in names, 'incomplete archive'
        os.mkdir(INCOMING,0o700)
        # Manual extraction ignores archived ownership/modes and link metadata.
        for m in sorted(members,key=lambda x:(x.name.count('/'),x.name)):
            p=INCOMING+'/'+m.name.rstrip('/')
            if m.isdir(): os.makedirs(p,mode=0o755,exist_ok=True)
            else:
                os.makedirs(os.path.dirname(p),mode=0o755,exist_ok=True)
                with archive.extractfile(m) as src, open(p,'xb') as dst: shutil.copyfileobj(src,dst)
                os.chmod(p,0o644)
    os.chmod(INCOMING,0o755)
    tree(INCOMING+'/web'); safe(INCOMING+'/app.jar','file')
    # Revalidate immediately before backups/switch. Only these two artifacts move.
    preflight()
    os.mkdir(BACKUP,0o700)
    shutil.copy2(ROOT+'/app.jar',BACKUP+'/app.jar',follow_symlinks=False)
    shutil.copytree(ROOT+'/web',BACKUP+'/web',symlinks=False)
    os.replace(INCOMING+'/app.jar',ROOT+'/app.jar')
    os.rename(ROOT+'/web',INCOMING+'/previous-web')
    os.rename(INCOMING+'/web',ROOT+'/web')
    subprocess.run(['sudo','-n','/usr/bin/systemctl','restart','xian-oa-dev.service'],check=True,timeout=60,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs): return None
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    healthy=False
    for attempt in range(30):
        try:
            with opener.open('http://127.0.0.1:8082/api/v1/health',timeout=2) as r: back=200<=r.status<300
            with opener.open('http://127.0.0.1:18081/',timeout=2) as r:
                front=r.status==200 and hashlib.sha256(r.read(8388609)).hexdigest()==hashlib.sha256(open(ROOT+'/web/index.html','rb').read()).hexdigest()
            if back and front: healthy=True; break
        except Exception: pass
        time.sleep(1)
    assert healthy, 'health check failed (requires backend 2xx and frontend 200)'
    marker('completed'); emit('completed')
except BaseException:
    # No rollback, deletion, or second restart. Partial switch must be handled manually.
    marker('failed'); emit('failed'); raise
`);
}
function reconcileCommand(id, hash) {
  return pythonCommand(PY_PREFLIGHT + `\nsafe(ROOT,'dir')\np=ROOT+'/.dsh-native-deploy-${id}.json'\nif not os.path.lexists(p):\n print('NATIVE_RESULT '+json.dumps({'id':'${id}','hash':'${hash}','state':'unknown'}))\nelse:\n safe(p,'file')\n with open(p) as f: m=json.load(f)\n assert m.get('id')=='${id}' and m.get('hash')=='${hash}', 'marker identity mismatch'\n print('NATIVE_RESULT '+json.dumps(m))\n`);
}

/** Native direct dev deployment. deps is a trusted test seam, never HTTP input.
 * check({directory,head,fingerprint}) -> one-use plan; no build/upload/remote writes.
 * start({planId,confirmation:true,databaseRiskAccepted:true}) -> async job snapshot.
 * status({jobId?}) -> bounded snapshot; close() aborts local resources, not remote work.
 */
export function createNativeDevDeploy({ inspect, port, redact = value => value }, dependencies = {}) {
  if (typeof inspect !== 'function') throw new TypeError('inspect is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('loopback port is required');
  const deps = { now: Date.now, uuid: randomUUID, env: process.env, discover, platform: process.platform, planTtl: 5 * 60_000, commandTimeout: 15 * 60_000, bridgeTimeout: 240_000, logLimit: 24_000, ...dependencies };
  let closed = false, checking = false, active = null, last = null;
  const plans = new Map(), requests = new Set(), processes = new Set();
  const env = { ...normalizeEnv(deps.env, deps.platform), COPYFILE_DISABLE: '1' };
  const secrets = Object.entries(env).filter(([key, value]) => value && /password|secret|token|api[_-]?key/i.test(key)).map(([, value]) => String(value)).filter(value => value.length >= 4);
  for (const key of Object.keys(env)) if (/^XINGLIAN_DB_|^GH_|^GITHUB_|^NODE_OPTIONS$|^NPM_CONFIG_SCRIPT_SHELL$|^JAVA_TOOL_OPTIONS$|^JDK_JAVA_OPTIONS$|^MAVEN_OPTS$|^MAVEN_ARGS$/i.test(key)) delete env[key];
  const sanitize = value => {
    let text = String(value); for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return redactDefault(redact(redactDefault(text))).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  };
  const ensureOpen = () => { if (closed) throw fail('原生开发部署已关闭'); };
  const log = (job, text) => { job.logs += sanitize(text); if (job.logs.length > deps.logLimit) { job.logs = job.logs.slice(-deps.logLimit); job.logsTruncated = true; } };
  const snapshot = job => {
    if (!job) return { state: 'idle', target: { ...TARGET } };
    const value = structuredClone(Object.fromEntries(Object.entries(job).filter(([key]) => !['promise', 'controller'].includes(key))));
    if (job.finishedAt === null && job.state !== 'running') { value.state = 'running'; value.phase = 'cleanup'; }
    return value;
  };

  // Only 127.0.0.1 + constructor port. No cookies, credentials, redirects or user URLs.
  async function bridge(path, { json, file, signal, timeout = deps.bridgeTimeout } = {}) {
    if (deps.bridge) return deps.bridge(path, { json, file, signal, timeout });
    ensureOpen();
    return new Promise((resolveResult, reject) => {
      let source, settled = false, length = 0;
      const req = http.request({ hostname: '127.0.0.1', port, path, method: json || file ? 'POST' : 'GET', agent: false, headers: json ? { 'content-type': 'application/json' } : file ? { 'content-type': 'application/octet-stream' } : {} }, res => {
        let output = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { length += Buffer.byteLength(chunk); if (length > 1024 * 1024) req.destroy(fail('SSH 响应超过限制')); else output += chunk; });
        res.on('error', finish);
        res.on('end', () => {
          if (res.statusCode !== 200) return finish(fail(`SSH 桥接失败 (${res.statusCode})`));
          try {
            if (file) {
              const lines = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
              const terminal = lines.filter(line => line.type === 'result');
              if (terminal.length !== 1 || terminal[0].ok !== true || lines.at(-1)?.type !== 'result') throw fail('SSH 上传未得到明确成功结果');
              finish(null, terminal[0]);
            } else finish(null, JSON.parse(output));
          } catch (error) { finish(error); }
        });
      });
      function finish(error, value) {
        if (settled) return; settled = true; clearTimeout(timer); requests.delete(req); signal?.removeEventListener('abort', abort); source?.destroy();
        if (error) { req.destroy(); reject(error); } else resolveResult(value);
      }
      const abort = () => req.destroy(fail('部署已取消；远程执行可能仍在继续'));
      const timer = setTimeout(() => req.destroy(fail('SSH 桥接超时；远程状态未确认', 504)), timeout);
      requests.add(req); req.on('error', finish); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      if (file) { source = createReadStream(file); source.on('error', error => req.destroy(error)); source.pipe(req); }
      else req.end(json ? JSON.stringify(json) : undefined);
    });
  }
  async function host(signal) {
    const data = await bridge('/api/dsh-ssh/hosts', { signal });
    if (!Array.isArray(data?.hosts)) throw fail('SSH 主机列表格式不正确');
    const matches = data.hosts.filter(item => item.alias === TARGET.alias);
    if (matches.length !== 1) throw fail('固定开发主机缺失或重复');
    const item = matches[0];
    if (item.host !== TARGET.host || item.user !== TARGET.user || !Number.isInteger(item.port) || item.port < 1 || item.port > 65535 || !['key', 'password', 'agent'].includes(item.auth) || !Array.isArray(item.proxyJump) || item.proxyJump.length || item.proxyCommand) throw fail('固定开发主机身份不匹配；不允许代理目标');
    return { alias: item.alias, host: item.host, user: item.user, port: item.port, auth: item.auth, updatedAt: item.updatedAt ?? null };
  }
  async function remote(command, signal) {
    const data = await bridge('/api/dsh-ssh/exec', { json: { alias: TARGET.alias, command, timeoutMs: 210_000 }, signal });
    const r = data?.result;
    if (!r || r.exitCode !== 0 || r.timedOut || typeof r.stdout !== 'string' || r.truncated) throw fail('远程命令未明确成功；不自动重试写操作');
    return r.stdout;
  }
  async function inspectExact(body) {
    if (typeof body.directory !== 'string' || !isAbsolute(body.directory) || /[\0\r\n]/.test(body.directory)) throw fail('需要项目绝对目录', 400);
    const info = await inspect(body.directory);
    if (!info || info.directory !== body.directory || info.branch !== 'dev' || !/^[a-f0-9]{40}$/i.test(info.head || '') || !/^[a-f0-9]{64}$/i.test(info.fingerprint || '') || info.head !== body.head || info.fingerprint !== body.fingerprint) throw fail('目录、dev 分支、HEAD 或文件指纹已变化，请重新检查');
    if (!Array.isArray(info.changes) || info.changes.some(item => /U/.test(item.status || '') || ['DD', 'AA'].includes((item.status || '').trim()))) throw fail('Git 冲突未解决');
    return { directory: info.directory, branch: info.branch, head: info.head, fingerprint: info.fingerprint };
  }
  async function check(body = {}) {
    ensureOpen(); if (active || checking) throw fail('已有部署任务或检查正在执行');
    checking = true;
    try {
      const original = await inspectExact(body), identity = await host();
      const output = await remote(preflightCommand);
      if (output.trim() !== 'NATIVE_PREFLIGHT_OK') throw fail('远程预检查结果不正确');
      if (!same(original, await inspectExact(body))) throw fail('检查期间项目发生变化');
      ensureOpen();
      const planId = deps.uuid(), expiresAt = deps.now() + deps.planTtl;
      const summary = { target: { ...TARGET }, directory: original.directory, branch: 'dev', head: original.head, fingerprint: original.fingerprint, builds: ['npm run build', 'mvn -B -f backend/pom.xml package (Java 21，包含测试)'], changes: ['上传仅包含 app.jar 与构建后的 web；不复制配置', '备份并替换 /opt/xian-oa-dev/app.jar 和 web', 'sudo -n 重启 xian-oa-dev.service；检查 8082 健康接口和 18081 首页'] };
      const risks = ['后端启动可能执行数据库初始化/迁移；数据库不在备份范围，必须单独勾选接受风险。', '不自动回滚、不重试远程写操作；失败可能留下部分替换或远程状态不确定，需人工检查备份与标记。', '本机构建执行仓库 npm/Maven 脚本和全部 Maven 测试；不自动安装前端依赖，Maven 可解析依赖。', 'SSH 主机配置可被外部修改；固定别名、地址、用户和快照核对并非服务器主机密钥证明。'];
      plans.clear(); plans.set(planId, { original, identity, expiresAt });
      return { ok: true, planId, expiresAt, summary, risks, databaseRiskRequired: true };
    } finally { checking = false; }
  }
  async function command(executable, args, cwd, job) {
    ensureOpen(); if (job.controller.signal.aborted) throw fail('部署已取消');
    if (deps.command) return deps.command(executable, args, { cwd, env, signal: job.controller.signal, onOutput: value => log(job, value), timeout: deps.commandTimeout });
    const child = spawnPortable(executable, args, { cwd, env, platform: deps.platform, detached: deps.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    processes.add(child);
    let tail = '';
    const output = chunk => { tail += chunk.toString('utf8'); let n; while ((n = tail.indexOf('\n')) >= 0) { log(job, tail.slice(0, n + 1)); tail = tail.slice(n + 1); } if (tail.length > deps.logLimit) tail = tail.slice(-deps.logLimit); };
    child.stdout?.on('data', output); child.stderr?.on('data', output);
    let timer, abort;
    try {
      await new Promise((done, reject) => {
        abort = () => { void terminateTree(child).catch(() => {}); reject(fail('本机构建已取消')); };
        timer = setTimeout(() => { void terminateTree(child).catch(() => {}); reject(fail('本机构建超时')); }, deps.commandTimeout);
        job.controller.signal.addEventListener('abort', abort, { once: true });
        child.once('error', () => reject(fail('无法启动本机构建工具')));
        child.once('close', code => { if (tail) log(job, tail); code === 0 ? done() : reject(fail(`本机构建失败 (${code})`)); });
      });
    } finally { clearTimeout(timer); job.controller.signal.removeEventListener('abort', abort); await terminateTree(child); processes.delete(child); }
  }
  async function regularTree(path, budget = { entries: 0, bytes: 0 }) {
    const s = await lstat(path);
    if (++budget.entries > 50000) throw fail('产物文件数量超过限制');
    if (s.isSymbolicLink()) throw fail('产物路径不允许符号链接');
    if (s.isDirectory()) for (const entry of await readdir(path)) await regularTree(join(path, entry), budget);
    else if (!s.isFile()) throw fail('产物只允许普通文件和目录');
    else if ((budget.bytes += s.size) > 512 * 1024 * 1024) throw fail('产物超过 512MB 限制');
  }
  async function build(original, job) {
    const root = await realpath(original.directory);
    if (root !== original.directory) throw fail('项目目录不是规范路径');
    for (const path of ['backend', 'backend/pom.xml', 'package.json', 'node_modules', 'node_modules/vite']) if ((await lstat(join(root, path))).isSymbolicLink()) throw fail('构建入口不允许符号链接');
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (!pkg.scripts?.build || !({ ...pkg.dependencies, ...pkg.devDependencies }.react) || !({ ...pkg.dependencies, ...pkg.devDependencies }.vite)) throw fail('仅支持现有 React/Vite 项目');
    await access(join(root, 'node_modules/vite/bin/vite.js'));
    const tools = await deps.discover(env, { platform: deps.platform });
    // Maven itself reports the selected JVM, not an unrelated PATH java binary.
    const versionJob = { ...job, logs: '' };
    await command(tools.mvn, ['-version'], root, versionJob);
    // Capture version separately with the same runner; injected runner returns stdout.
    // Real runner logs version output into versionJob; mock runners may return it.
    const versionText = versionJob.logs;
    if (!/Java version:\s*21(?:[.\s,]|$)/i.test(versionText)) throw fail('Maven 必须使用 Java 21；请手动配置 JAVA_HOME');
    log(job, '[build] npm run build\n');
    await command(tools.npm, ['run', 'build'], root, job);
    log(job, '[build] mvn -B -f backend/pom.xml package（不跳过测试）\n');
    await command(tools.mvn, ['-B', '-f', 'backend/pom.xml', 'package'], root, job);
    const dist = join(root, 'dist'), target = join(root, 'backend/target');
    await regularTree(dist); await access(join(dist, 'index.html'));
    if ((await lstat(target)).isSymbolicLink()) throw fail('Maven 产物目录不允许符号链接');
    const jars = (await readdir(target)).filter(name => name.endsWith('.jar') && !/(?:-sources|-javadoc|-tests)\.jar$/.test(name));
    if (jars.length !== 1) throw fail('需要唯一后端可执行 jar 产物');
    await regularTree(join(target, jars[0]));
    return { dist, jar: join(target, jars[0]) };
  }
  function parseMarker(output, id, hash) {
    const lines = output.split('\n').filter(line => line.startsWith('NATIVE_RESULT '));
    if (lines.length !== 1) throw fail('远程完成标记缺失');
    const marker = JSON.parse(lines[0].slice('NATIVE_RESULT '.length));
    if (marker.id !== id || marker.hash !== hash || !['completed', 'failed', 'started', 'unknown'].includes(marker.state)) throw fail('远程完成标记不匹配');
    return marker;
  }
  async function run(job, plan) {
    let temp, writing = false, hash;
    const signal = job.controller.signal;
    const assertSnapshot = async () => { ensureOpen(); await inspectExact(plan.original); if (JSON.stringify(await host(signal)) !== JSON.stringify(plan.identity)) throw fail('SSH 主机身份或配置已变化'); };
    try {
      await assertSnapshot(); job.phase = 'building';
      const artifacts = deps.build ? await deps.build(plan.original, { signal, log: value => log(job, value) }) : await build(plan.original, job);
      await assertSnapshot();
      temp = await mkdtemp(join(tmpdir(), 'dsh-xian-native-'));
      const payload = join(temp, 'payload'); await mkdir(payload);
      await regularTree(artifacts.dist); await regularTree(artifacts.jar);
      // Copy only built artifacts; never repository config, env files or local DB settings.
      async function copyTree(from, to) { await mkdir(to); for (const name of await readdir(from)) { const src = join(from, name), dst = join(to, name); const s = await lstat(src); if (s.isSymbolicLink()) throw fail('产物符号链接'); if (s.isDirectory()) await copyTree(src, dst); else if (s.isFile()) await copyFile(src, dst); else throw fail('不支持的产物类型'); } }
      await copyTree(artifacts.dist, join(payload, 'web')); await copyFile(artifacts.jar, join(payload, 'app.jar'));
      await access(join(payload, 'web/index.html'));
      const archive = join(temp, 'bundle.tar');
      await command('tar', ['-cf', archive, '-C', payload, 'app.jar', 'web'], temp, job);
      const archiveInfo = await lstat(archive);
      if (!archiveInfo.isFile() || archiveInfo.size > 512 * 1024 * 1024) throw fail('部署包超过 512MB 限制');
      // Pin exact bytes; the remote validates this digest before any artifact switch.
      hash = sha(await readFile(archive)); job.artifactSha256 = hash;
      await assertSnapshot();
      const stage = '/tmp/dsh-xian-oa-dev-' + job.jobId;
      job.phase = 'staging'; writing = true; job.remoteState = 'uncertain';
      if ((await remote(stageCommand(job.jobId), signal)).trim() !== 'NATIVE_STAGE_OK') throw fail('远程暂存未明确成功');
      await host(signal).then(identity => { if (JSON.stringify(identity) !== JSON.stringify(plan.identity)) throw fail('SSH 主机配置已变化'); });
      await bridge('/api/dsh-ssh/upload?' + new URLSearchParams({ alias: TARGET.alias, remotePath: stage + '/bundle.tar' }), { file: archive, signal });
      await assertSnapshot(); job.phase = 'switching';
      const output = await remote(applyCommand(job.jobId, hash), signal);
      const marker = parseMarker(output, job.jobId, hash);
      if (marker.state !== 'completed') throw fail('远程未完成；不自动回滚');
      job.remoteState = 'completed'; job.state = 'succeeded'; job.phase = 'completed';
      log(job, '开发部署完成，后端 2xx 与前端 200 已确认。\n');
    } catch (error) {
      job.phase = 'reconciling'; job.error = sanitize(error.message || '部署失败');
      if (writing) {
        job.remoteState = 'uncertain';
        // Read-only reconciliation only. Never resend apply, upload, or restart.
        if (!closed && hash) try {
          const identity = await host(signal);
          if (JSON.stringify(identity) === JSON.stringify(plan.identity)) {
            const marker = parseMarker(await remote(reconcileCommand(job.jobId, hash), signal), job.jobId, hash);
            job.remoteState = marker.state;
            if (marker.state === 'completed') { job.state = 'succeeded'; job.phase = 'completed'; job.error = null; }
          }
        } catch { /* Unknown remains explicit; no automatic writes/rollback. */ }
      }
      if (job.state !== 'succeeded') { job.state = 'failed'; job.phase = 'failed'; }
      log(job, `${job.error || '已通过持久完成标记确认成功'}\n`);
    } finally {
      if (temp) {
        // temp is created by this job, never accepted from HTTP.
        if (resolve(temp).startsWith(resolve(tmpdir()) + '/') && (await lstat(temp)).isDirectory() && !(await lstat(temp)).isSymbolicLink()) await rm(temp, { recursive: true, force: true });
      }
      job.finishedAt = deps.now(); active = null;
    }
  }
  async function start(body = {}) {
    ensureOpen(); if (checking || active) throw fail('已有部署任务或检查正在执行');
    if (body.confirmation !== true || body.databaseRiskAccepted !== true) throw fail('需要明确确认部署，并单独勾选接受数据库初始化/迁移风险', 400);
    const plan = plans.get(body.planId);
    if (!plan || deps.now() >= plan.expiresAt) { plans.delete(body.planId); throw fail('计划不存在、已使用或已过期，请重新检查'); }
    plans.delete(body.planId); // Consume before any await: concurrency and failures cannot replay it.
    const jobId = deps.uuid();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(jobId)) throw fail('无效内部任务标识');
    const job = { jobId, state: 'running', phase: 'queued', target: { ...TARGET }, directory: plan.original.directory, head: plan.original.head, fingerprint: plan.original.fingerprint, startedAt: deps.now(), finishedAt: null, logs: '', logsTruncated: false, error: null, remoteState: 'not-started', backupPath: TARGET.root + '/.dsh-native-backup-' + jobId, databaseRiskAccepted: true, controller: new AbortController() };
    active = last = job;
    job.promise = Promise.resolve().then(() => run(job, plan)).catch(error => { job.state = 'failed'; job.error = sanitize(error.message); job.finishedAt = deps.now(); if (active === job) active = null; });
    return snapshot(job);
  }
  function status(body = {}) {
    if (body.jobId !== undefined && body.jobId !== last?.jobId) throw fail('部署任务不存在', 404);
    return snapshot(last);
  }
  async function close() {
    if (closed) return; closed = true; plans.clear();
    active?.controller.abort();
    for (const request of requests) request.destroy(fail('部署桥接已关闭；远程状态可能未确认'));
    await Promise.allSettled([...processes].map(child => terminateTree(child)));
    if (active?.promise) await active.promise;
  }
  return { check, start, status, close };
}
