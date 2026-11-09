import { spawn as systemSpawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, isAbsolute, parse, win32, posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_UPLOAD = 256 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const UNKNOWN = 'SSH 操作未明确完成；本地连接已停止，远端状态未知，请查询状态，不要重复发布';
export const NATIVE_SSH_MESSAGES = Object.freeze([
  UNKNOWN,
  '请先保存 SSH 账号并核对信任主机指纹',
  '系统 OpenSSH 不可用或连接失败，请核对配置和授权',
  'SSH 连接或授权失败，请核对账号、私钥和系统密钥代理',
  'SSH 连接已关闭；远端状态未知，请查询状态',
  'SSH 已存主机指纹不一致，禁止覆盖，请联系管理员核对',
  '私钥文件安全校验失败',
  'SSH 配置目录安全校验失败',
  'SSH 配置目录必须属于当前用户且权限为 700',
  'SSH 配置文件安全校验失败',
  '源码上传未明确成功；远端状态未知，请查询状态',
  'SSH 文件或目录权限安全校验失败',
]);
const INTERNAL = Symbol('native-ssh-safe-error');
const failure = (message = 'SSH 配置或操作不可用，请核对配置和授权', status = 400) => Object.assign(new Error(message), { status, [INTERNAL]: true });
const plain = (v, keys) => {
  if (!v || ![Object.prototype, null].includes(Object.getPrototypeOf(v)) || Reflect.ownKeys(v).some(k => !keys.includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(v, k), 'value'))) throw failure();
  return v;
};
const safePath = p => typeof p === 'string' && isAbsolute(p) && p === resolve(p) && !/[\x00-\x1f\x7f]/.test(p);
const configQuote = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const fingerprintOf = key => 'SHA256:' + createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '');
function keyLine(line) {
  const fields = line.trim().split(/\s+/);
  if (fields.length !== 3 || fields[1] !== 'ssh-ed25519' || !/^[A-Za-z0-9+/]+={0,2}$/.test(fields[2])) throw failure();
  const bytes = Buffer.from(fields[2], 'base64');
  if (bytes.length !== 51 || bytes.readUInt32BE(0) !== 11 || bytes.subarray(4, 15).toString() !== 'ssh-ed25519' || bytes.readUInt32BE(15) !== 32) throw failure();
  return fields[2];
}

/** Trusted construction only: target and spawn never come from HTTP input.
 * Keys remain in their original files. System agent may sign ONLY the selected
 * identity (IdentitiesOnly); no password, askpass, forwarding, or user ssh config.
 * Every method is async except close(). close/timeout cannot cancel remote work.
 */
export function createNativeSsh({ directory, target, spawn = systemSpawn, platform = process.platform, home = homedir() } = {}) {
  if (!safePath(directory) || typeof spawn !== 'function' || !target || typeof target.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/.test(target.host) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target.alias || '')) throw failure();
  const host = target.host, port = target.port, alias = target.alias;
  const entryPath = target.entryPath ?? '/usr/local/libexec/xian-oa-team-entry.py';
  if (!/^\/usr\/local\/libexec\/[A-Za-z0-9_./-]+\.py$/.test(entryPath) || entryPath.split('/').includes('..')) throw failure();
  const root = resolve(directory), configPath = join(root, 'config.json'), knownPath = join(root, 'known_hosts');
  const hostToken = port === 22 ? host : `[${host}]:${port}`;
  const uid = process.getuid?.();
  const windows = platform === 'win32';
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const binary = name => windows ? win32.join(systemRoot, 'System32', 'OpenSSH', name + '.exe') : '/usr/bin/' + name;
  // All paths are environment data, never interpolated into PowerShell source.
  async function windowsSecurity(path, { create = false, directory: isDirectory = false } = {}) {
    const script = `$ErrorActionPreference='Stop'\n$p=$env:DSH_SSH_SECURE_PATH\n$me=[Security.Principal.WindowsIdentity]::GetCurrent().User\n$allowed=@($me.Value,'S-1-5-18','S-1-5-32-544')\nfunction Check($item,$strict) {\n if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }\n $a=Get-Acl -LiteralPath $item.FullName\n if ($allowed -notcontains $a.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'unsafe' }\n foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {\n  if ($r.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $allowed -notcontains $r.IdentityReference.Value) {\n   if ($strict -or (([int]$r.FileSystemRights -band 0xD0156) -ne 0)) { throw 'unsafe' }\n  }\n }\n}\n$chain=New-Object 'System.Collections.Generic.List[string]'\n$q=$p\nwhile($q) { $chain.Insert(0,$q); $parent=[IO.Path]::GetDirectoryName($q); if($parent -eq $q){break}; $q=$parent }\nforeach($q in $chain) {\n if(-not [IO.Directory]::Exists($q) -and -not [IO.File]::Exists($q)) {\n  if($env:DSH_SSH_CREATE -ne '1') { throw 'missing' }\n  $acl=New-Object Security.AccessControl.DirectorySecurity\n  $acl.SetOwner($me); $acl.SetAccessRuleProtection($true,$false)\n  $rule=New-Object Security.AccessControl.FileSystemAccessRule($me,'FullControl','ContainerInherit,ObjectInherit','None','Allow')\n  $acl.AddAccessRule($rule)\n  [IO.Directory]::CreateDirectory($q,$acl) | Out-Null\n }\n $item=Get-Item -Force -LiteralPath $q\n if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }\n if($q -eq $p -or $q -eq [IO.Path]::GetDirectoryName($p)) { Check $item ($q -eq $p) }\n}\n$i=Get-Item -Force -LiteralPath $p\nif(($env:DSH_SSH_DIRECTORY -eq '1') -ne $i.PSIsContainer) { throw 'unsafe' }\nWrite-Output 'DSH_ACL_OK'`;
    const result = await run(win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { DSH_SSH_SECURE_PATH: path, DSH_SSH_CREATE: create ? '1' : '0', DSH_SSH_DIRECTORY: isDirectory ? '1' : '0' } });
    if (result.exitCode !== 0 || result.stdout.trim() !== 'DSH_ACL_OK') throw failure('SSH 文件或目录权限安全校验失败');
  }
  let closed = false, pendingKey = null, queue = Promise.resolve();
  const processes = new Set();
  const ensure = () => { if (closed) throw failure('SSH 连接已关闭；远端状态未知，请查询状态', 503); };
  const guarded = fn => async (...args) => { try { ensure(); return await fn(...args); } catch (e) { if (e?.[INTERNAL]) throw e; throw failure(); } };
  const serial = fn => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };
  async function directoryReady(create = true) {
    if (windows) {
      if (!create) { try { await lstat(root); } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
      await windowsSecurity(root, { create, directory: true }); return true;
    }
    let current = parse(root).root;
    for (const part of root.slice(current.length).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
      let s;
      try { s = await lstat(current); } catch (e) { if (!create && e.code === 'ENOENT') return false; throw e; }
      if (!s.isDirectory() || s.isSymbolicLink() || (uid !== undefined && s.uid !== uid && s.uid !== 0) || ((s.mode & 0o022) && !(s.uid === 0 && (s.mode & 0o1000)))) throw failure('SSH 配置目录安全校验失败');
      if (current === root && ((uid !== undefined && s.uid !== uid) || (s.mode & 0o777) !== 0o700)) throw failure('SSH 配置目录必须属于当前用户且权限为 700');
    }
  }
  async function secureRead(path, max = 16384) {
    let fd;
    try {
      fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const s = await fd.stat();
      if (!s.isFile() || s.nlink !== 1 || (!windows && ((uid !== undefined && s.uid !== uid) || (s.mode & 0o777) !== 0o600)) || s.size > max) throw failure('SSH 配置文件安全校验失败');
      if (windows) await windowsSecurity(path);
      return await fd.readFile('utf8');
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    finally { await fd?.close(); }
  }
  async function atomic(path, text) {
    await secureRead(path);
    const temp = join(root, '.' + randomUUID());
    let fd;
    try {
      fd = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      if (windows) await windowsSecurity(temp);
      await fd.writeFile(text); await fd.sync(); await fd.close(); fd = null;
      ensure(); await rename(temp, path);
    } finally { await fd?.close(); await unlink(temp).catch(() => {}); }
  }
  async function locked(fn) {
    await directoryReady();
    let lock;
    try { lock = await open(join(root, '.lock'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch { throw failure('SSH 配置正在操作或锁文件异常，请稍后核对', 409); }
    try { return await fn(); } finally { await lock.close(); await unlink(join(root, '.lock')); }
  }
  async function load() {
    await directoryReady(false);
    const text = await secureRead(configPath), known = await secureRead(knownPath);
    let c = text === null ? {} : JSON.parse(text);
    plain(c, ['user', 'privateKeyPath', 'fingerprint', 'updatedAt']);
    if (c.user !== undefined && (!/^[a-z_][a-z0-9_-]{0,31}$/.test(c.user) || c.user === 'root' || !safePath(c.privateKeyPath))) throw failure();
    if (known !== null) {
      const key = keyLine(known);
      if (known.trim().split(/\s+/)[0] !== hostToken || fingerprintOf(key) !== c.fingerprint) throw failure('SSH 已存主机指纹不一致，禁止覆盖，请联系管理员核对', 409);
    } else if (c.fingerprint) throw failure('SSH 已存主机指纹不一致，禁止覆盖，请联系管理员核对', 409);
    return { ...c, alias, host, port, configured: Boolean(c.user && c.privateKeyPath), trusted: Boolean(c.fingerprint && known), fingerprint: c.fingerprint ?? null, user: c.user ?? '', privateKeyPath: c.privateKeyPath ?? '' };
  }
  async function privateKey(path) {
    if (!safePath(path)) throw failure('私钥仅支持本机绝对路径');
    // Never read key bytes. Reject symlink components, foreign ownership and broad permissions.
    if (windows) { await windowsSecurity(path); const s = await lstat(path); if (!s.isFile() || s.nlink !== 1) throw failure('私钥文件安全校验失败'); return; }
    let current = parse(path).root;
    for (const part of path.slice(current.length).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      const s = await lstat(current);
      if (s.isSymbolicLink() || (current !== path && (!s.isDirectory() || (uid !== undefined && s.uid !== uid && s.uid !== 0) || ((s.mode & 0o022) && !(s.uid === 0 && (s.mode & 0o1000)))))) throw failure('私钥文件安全校验失败');
      if (current === path && (!s.isFile() || s.nlink !== 1 || (uid !== undefined && s.uid !== uid) || (s.mode & 0o077))) throw failure('私钥文件安全校验失败');
    }
  }
  function run(program, args, { timeoutMs = 15000, input, file, env } = {}) {
    ensure();
    return new Promise((resolveRun, reject) => {
      let child, timer, source, settled = false, length = 0, output = [];
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); processes.delete(abort);
        source?.destroy();
        if (error) { try { child?.kill('SIGKILL'); } catch {} reject(error); } else resolveRun(value);
      };
      const abort = () => finish(failure(UNKNOWN, 503));
      processes.add(abort);
      timer = setTimeout(abort, timeoutMs);
      try {
        child = spawn(program, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env, SSH_ASKPASS_REQUIRE: 'never', SSH_ASKPASS: '', DISPLAY: '' } });
        child.on('error', () => finish(failure('系统 OpenSSH 不可用或连接失败，请核对配置和授权', 503)));
        child.stdout.on('data', chunk => { length += Buffer.byteLength(chunk); if (length > MAX_OUTPUT) return abort(); output.push(Buffer.from(chunk)); });
        child.stderr.on('data', chunk => { length += Buffer.byteLength(chunk); if (length > MAX_OUTPUT) abort(); });
        child.on('close', code => finish(null, { exitCode: code, stdout: Buffer.concat(output).toString('utf8'), stderr: '', timedOut: false, truncated: false }));
        child.stdin.on('error', abort);
        if (file) { source = file.createReadStream({ autoClose: false }); source.on('error', abort); let bytes = 0; source.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_UPLOAD) abort(); }); source.pipe(child.stdin); }
        else child.stdin.end(input);
      } catch { finish(failure('系统 OpenSSH 不可用或连接失败，请核对配置和授权', 503)); }
    });
  }
  async function ssh(command, options = {}) {
    const c = await load(); ensure();
    if (!c.configured || !c.trusted) throw failure('请先保存 SSH 账号并核对信任主机指纹');
    await privateKey(c.privateKeyPath); ensure();
    const args = ['-F', windows ? 'NUL' : '/dev/null', '-T', '-p', String(port), '-l', c.user, '-i', c.privateKeyPath];
    for (const value of ['BatchMode=yes', 'StrictHostKeyChecking=yes', `UserKnownHostsFile=${configQuote(knownPath)}`, `GlobalKnownHostsFile=${windows ? 'NUL' : '/dev/null'}`, 'IdentitiesOnly=yes', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'PreferredAuthentications=publickey', 'NumberOfPasswordPrompts=0', 'ForwardAgent=no', 'ClearAllForwardings=yes', 'ControlMaster=no', 'ControlPath=none', 'ProxyCommand=none', 'ProxyJump=none', 'PermitLocalCommand=no', 'UpdateHostKeys=no', 'VerifyHostKeyDNS=no', 'ConnectTimeout=10', 'ConnectionAttempts=1']) args.push('-o', value);
    args.push('--', host, command);
    const result = await run(binary('ssh'), args, options);
    if (result.exitCode === 255 || result.exitCode === null) throw failure('SSH 连接或授权失败，请核对账号、私钥和系统密钥代理', 503);
    return result;
  }
  // Bounded, read-only hints: never open candidate keys or execute SSH config directives.
  const discover = guarded(() => serial(async () => {
    if (!safePath(home)) throw failure();
    const candidates = [], seen = new Set();
    const add = async (path, source) => {
      if (candidates.length >= 64 || !safePath(path) || seen.has(path)) return;
      const name = (windows ? win32 : posix).basename(path);
      if (/\.pub$/i.test(name) || /^(?:config|known_hosts(?:\..*)?|authorized_keys(?:\..*)?|environment|rc)$/i.test(name)) return;
      seen.add(path);
      try { await privateKey(path); candidates.push({ privateKeyPath: path, source }); } catch { /* Unsafe/missing candidates are not suggestions. */ }
    };
    const text = async path => {
      let fd;
      try {
        const before = await lstat(path);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 65536 || (!windows && (before.uid !== uid || (before.mode & 0o022)))) return null;
        fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const after = await fd.stat();
        if (before.dev !== after.dev || before.ino !== after.ino || after.size > 65536) return null;
        const bytes = Buffer.alloc(65537);
        const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
        return bytesRead <= 65536 ? bytes.subarray(0, bytesRead).toString('utf8') : null;
      } catch { return null; } finally { await fd?.close(); }
    };
    try { const saved = await load(); await add(saved.privateKeyPath, '已保存的发布连接'); } catch { /* Other sources remain useful when saved config is invalid. */ }
    const old = await text(join(home, '.dsh', 'dsh-ssh.json'));
    if (old !== null) {
      try {
        const records = JSON.parse(old)?.hosts;
        if (Array.isArray(records)) for (const record of records.slice(0, 64)) {
          if (record?.host === host && (record.port ?? 22) === port && record.auth?.kind === 'key') await add(record.auth.keyPath, '已有匹配服务器 SSH 配置');
        }
      } catch { /* Never return config contents, including credentials. */ }
    }
    const sshDirectory = join(home, '.ssh');
    const config = await text(join(sshDirectory, 'config'));
    const expand = value => value.startsWith('~/') || (windows && value.startsWith('~\\')) ? join(home, value.slice(2)) : value;
    if (config !== null) {
      let block = null, blocked = false;
      const flush = async () => {
        if (!blocked && block && block.names.some(name => name === alias || name === host) && block.hostname === host && (block.port ?? '22') === String(port)) {
          for (const identity of block.identities) await add(expand(identity), '匹配服务器的 OpenSSH 配置');
        }
      };
      for (const raw of config.split(/\r?\n/).slice(0, 512)) {
        const m = raw.trim().match(/^([A-Za-z]+)(?:\s+|\s*=\s*)(.*?)\s*$/);
        if (!m || m[1].startsWith('#')) continue;
        const key = m[1].toLowerCase(), value = m[2];
        if (key === 'include' || key === 'match') { block = null; blocked = true; continue; }
        if (key === 'host') {
          await flush();
          const names = value.split(/\s+/);
          block = names.every(name => /^[A-Za-z0-9_.:-]+$/.test(name)) ? { names, identities: [], hostname: names.length === 1 && names[0] === host ? host : null } : null;
        } else if (block && key === 'hostname') block.hostname = value;
        else if (block && key === 'port') block.port = value;
        else if (block && key === 'identityfile' && block.identities.length < 64) {
          const identity = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
          if (!/[%$`\x00-\x1f\x7f]/.test(identity)) block.identities.push(identity);
        }
      }
      await flush();
    }
    for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa']) await add(join(sshDirectory, name), '本机 .ssh 常见密钥候选');
    try {
      const stat = await lstat(sshDirectory);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        let count = 0;
        for await (const entry of await opendir(sshDirectory)) {
          if (++count > 64) break;
          if (!entry.isFile() || entry.name.endsWith('.pub') || /^(?:config|known_hosts(?:\..*)?|authorized_keys(?:\..*)?|environment|rc)$/.test(entry.name)) continue;
          const path = join(sshDirectory, entry.name);
          let paired = false;
          try { const pub = await lstat(path + '.pub'); paired = pub.isFile() && !pub.isSymbolicLink(); } catch { /* No matching public key. */ }
          if (/^id_(?:ed25519|rsa|ecdsa|dsa)$/.test(entry.name) || paired) await add(path, '本机 .ssh 密钥候选');
        }
      }
    } catch { /* Missing/inaccessible .ssh is normal. */ }
    if (windows) await add('D:\\keys', 'Windows 常见自定义密钥位置');
    ensure();
    return { candidates, message: '仅发现路径候选，未读取私钥正文、保存配置、信任主机或连接服务器；请选择后核对。' };
  }));
  const read = guarded(() => serial(load));
  const save = guarded(input => serial(() => locked(async () => {
    plain(input, ['user', 'privateKeyPath']);
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(input.user || '') || input.user === 'root') throw failure('SSH 账号必须是规范的非 root 用户名');
    await privateKey(input.privateKeyPath);
    const c = await load();
    await atomic(configPath, JSON.stringify({ user: input.user, privateKeyPath: input.privateKeyPath, ...(c.fingerprint ? { fingerprint: c.fingerprint } : {}), updatedAt: new Date().toISOString() }) + '\n');
    return load();
  })));
  const scan = guarded(() => serial(async () => {
    pendingKey = null;
    const result = await run(binary('ssh-keyscan'), ['-T', '10', '-p', String(port), '-t', 'ed25519', host]);
    if (result.exitCode !== 0) throw failure('主机指纹扫描失败，请核对固定服务器连接', 503);
    const lines = result.stdout.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
    if (!lines.length || lines.length > 8) throw failure('主机指纹扫描响应无效', 503);
    const keys = [...new Set(lines.map(keyLine))];
    if (keys.length !== 1) throw failure('主机指纹扫描不一致，禁止信任', 409);
    pendingKey = { key: keys[0], fingerprint: fingerprintOf(keys[0]) };
    return { alias, host, port, fingerprint: pendingKey.fingerprint, trusted: false, pending: true };
  }));
  const trust = guarded(input => serial(() => locked(async () => {
    plain(input, ['fingerprint']);
    const c = await load();
    if (!pendingKey || input.fingerprint !== pendingKey.fingerprint) throw failure('请先扫描并核对本次主机指纹', 409);
    if (c.trusted) {
      if (c.fingerprint !== input.fingerprint) throw failure('已信任主机指纹变化，禁止覆盖，请联系管理员核对', 409);
      pendingKey = null; return c;
    }
    const picked = pendingKey; pendingKey = null;
    // Config-first crash leaves a fail-closed inconsistent state; never silently re-trust.
    await atomic(configPath, JSON.stringify({ ...(c.user ? { user: c.user, privateKeyPath: c.privateKeyPath } : {}), fingerprint: picked.fingerprint, updatedAt: new Date().toISOString() }) + '\n');
    await atomic(knownPath, `${hostToken} ssh-ed25519 ${picked.key}\n`);
    return load();
  })));
  const bridge = guarded(async (path, options = {}) => {
    plain(options, ['json', 'file']);
    if (path === '/api/dsh-ssh/hosts') {
      if (options.json !== undefined || options.file !== undefined) throw failure();
      const c = await read();
      if (!c.configured || !c.trusted) throw failure('请先保存 SSH 账号并核对信任主机指纹');
      return { hosts: [{ alias, host, port, user: c.user, auth: 'key', proxyJump: [], proxyCommand: '', updatedAt: c.updatedAt }] };
    }
    if (path === '/api/dsh-ssh/exec') {
      const j = plain(options.json, ['alias', 'command', 'timeoutMs']);
      const timeoutMs = j.timeoutMs ?? 180000;
      if (options.file !== undefined || j.alias !== alias || typeof j.command !== 'string' || !j.command.trim() || j.command.includes('\0') || Buffer.byteLength(j.command) > 65536 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) throw failure();
      return { result: await ssh(j.command, { timeoutMs }) };
    }
    if (typeof path !== 'string' || !path.startsWith('/api/dsh-ssh/upload?') || options.json !== undefined || !safePath(options.file)) throw failure();
    const params = new URLSearchParams(path.slice(path.indexOf('?') + 1));
    const remotePath = params.get('remotePath');
    if ([...params.keys()].length !== 2 || params.getAll('alias').length !== 1 || params.getAll('remotePath').length !== 1 || params.get('alias') !== alias || !/^\/tmp\/dsh-upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/source\.tar$/.test(remotePath || '')) throw failure('仅允许上传到本次临时源码路径');
    let file;
    try {
      file = await open(options.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const s = await file.stat();
      if (!s.isFile() || s.nlink !== 1 || (uid !== undefined && s.uid !== uid) || s.size <= 0 || s.size > MAX_UPLOAD) throw failure('源码包必须是当前用户的普通文件且不超过 256MiB');
      const code = `import os,sys,stat\np='${posix.dirname(remotePath)}'\ns=os.lstat(p)\nassert stat.S_ISDIR(s.st_mode) and s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o700\nd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)\ntry:\n s=os.fstat(d)\n assert s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o700\n f=os.open('source.tar',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=d)\n n=0\n with os.fdopen(f,'wb') as out:\n  os.fchmod(out.fileno(),0o600)\n  while True:\n   b=sys.stdin.buffer.read(1048576)\n   if not b: break\n   n+=len(b)\n   assert n<=${MAX_UPLOAD}\n   out.write(b)\n  assert n==${s.size}\nfinally: os.close(d)\n`;
      // Quote only for the remote login shell; local spawn never invokes a shell.
      const quoted = `/usr/bin/python3 -I -c '${code.replace(/'/g, `'"'"'`)}'`;
      const result = await ssh(quoted, { file, timeoutMs: 180000 });
      if (result.exitCode !== 0) throw failure('源码上传未明确成功；远端状态未知，请查询状态', 503);
      return { type: 'result', ok: true };
    } finally { await file?.close(); }
  });
  const test = guarded(async () => {
    const payload = Buffer.from(JSON.stringify({ action: 'overview', body: {} })).toString('base64');
    const result = await ssh(`/usr/bin/python3 -I ${entryPath} '${payload}'`, { timeoutMs: 30000 });
    if (result.exitCode !== 0) throw failure('团队入口连接或授权检查失败', 503);
    let response; try { response = JSON.parse(result.stdout); } catch { throw failure('团队入口检查响应无效', 503); }
    if (!response || typeof response !== 'object' || Array.isArray(response) || response.error || response.ok === false || !Array.isArray(response.jobs)) throw failure('团队入口连接或授权检查失败', 503);
    return { ok: true, connected: true, authorized: true, message: 'SSH 连接与团队入口授权检查通过，未执行部署' };
  });
  return Object.freeze({ read, discover, save, scan, trust, test, bridge, close() { closed = true; pendingKey = null; for (const abort of [...processes]) abort(); } });
}
