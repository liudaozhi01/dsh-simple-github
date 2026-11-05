import { normalizeEnv, findTool, isWithin, platformInfo, spawnPortable, terminateTree } from './platform.js';
import { createLocalDeploy } from './local-deploy.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve, win32 } from 'node:path';

export const API_BASE = '/simple-github/api';
export const FIXED_REPOSITORY = 'ssal-team/XiAN-OA';
const MAX_OUTPUT = 1024 * 1024;
export function redact(value) {
  return String(value).replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[REDACTED]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@').replace(/(authorization\s*[:=]\s*(?:bearer|token)\s+)\S+/ig, '$1[REDACTED]');
}
export class ApiError extends Error { constructor(message, status = 400) { super(redact(message)); this.status = status; } }
function text(value, label, max = 4096) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new ApiError(`Invalid ${label}`); return value; }
export function repositorySlug(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(value) || value.split('/').some(s => s === '.' || s === '..') || value.endsWith('.git')) throw new ApiError('Use a GitHub owner/repository slug, without URL or .git suffix');
  return value;
}
export function normalizeCloneRepository(value) {
  const invalid = () => new ApiError('仓库地址格式不正确。请输入 组织名/仓库名 或 https://github.com/组织名/仓库名.git；不支持其他网站、账号密码、查询参数或子页面。');
  if (typeof value !== 'string' || value.length > 2048 || /[\0\r\n]/.test(value)) throw invalid();
  let slug = value.trim();
  if (/^https:\/\/github\.com\//i.test(slug)) {
    const match = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/?$/i.exec(slug);
    if (!match) throw invalid();
    slug = `${match[1]}/${match[2]}`;
  }
  slug = slug.replace(/\.git$/, '');
  try { return repositorySlug(slug); } catch { throw invalid(); }
}
export function githubRemote(value) {
  const match = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?$/.exec(value);
  if (!match) throw new ApiError('Only canonical HTTPS github.com origin is supported for writes; existing remotes are never rewritten');
  return repositorySlug(`${match[1]}/${match[2]}`);
}
export function runCommand(command, args, { cwd, env = process.env, timeout = 30000, maxOutput = MAX_OUTPUT, truncate = false, signal, onOutput, encoding = 'utf8' } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawnPortable(command, args, { cwd, env: normalizeEnv(env), detached:process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), total = 0, truncated = false, failure;
    let killTimer;
    const stop = error => { failure ||= error; void terminateTree(child).catch(() => { try { child.kill(); } catch {} }); };
    const timer = setTimeout(() => stop(new ApiError('Command timed out', 504)), timeout); timer.unref();
    const abort = () => stop(new ApiError('Command cancelled', 409));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const collect = key => chunk => {
      onOutput?.(chunk.toString('utf8'));
      total += chunk.length;
      const current = key === 'stdout' ? stdout : stderr;
      const remaining = Math.max(0, maxOutput - stdout.length - stderr.length);
      const next = Buffer.concat([current, chunk.subarray(0, remaining)]);
      if (key === 'stdout') stdout = next; else stderr = next;
      if (total > maxOutput) { truncated = true; if (!truncate) stop(new ApiError('Command output exceeded safe limit')); }
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.on('error', error => { cleanup(); reject(new ApiError(error.code === 'ENOENT' ? 'Required executable not found' : 'Unable to start command')); });
    child.on('close', code => { cleanup(); if (failure) reject(failure); else if (code !== 0) reject(new ApiError(redact(stderr.toString('utf8') || stdout.toString('utf8') || `Command failed (${code})`).slice(0, 2000))); else resolveResult({ stdout: encoding === null ? stdout : stdout.toString(encoding), stderr: stderr.toString('utf8'), truncated }); });
  });
}
export async function chooseDirectory({ platform = process.platform, command = runCommand } = {}) {
  if (!['darwin', 'win32'].includes(platform)) throw new ApiError('当前目录选择器仅支持 macOS 和 Windows；其他系统请手动输入绝对路径');
  const script = 'try\nreturn POSIX path of (choose folder with prompt "选择项目文件夹或克隆保存位置")\non error number -128\nreturn ""\nend try';
  // Static script only: no request data enters PowerShell source or shell syntax.
  const windowsScript = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = "选择项目文件夹或克隆保存位置"; try { if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.SelectedPath) } } finally { $dialog.Dispose() }';
  const result = platform === 'win32'
    ? await command(win32.join(normalizeEnv(process.env, 'win32').SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(windowsScript, 'utf16le').toString('base64')], { timeout:150000, maxOutput:16384 })
    : await command('/usr/bin/osascript', ['-e', script], { timeout: 150000, maxOutput: 16384 });
  const selected = result.stdout.replace(/\r?\n$/, '');
  if (!selected) return { cancelled: true };
  if (!isAbsolute(selected) || /[\0\r\n]/.test(selected)) throw new ApiError('无法使用所选目录，请选择其他文件夹');
  const directory = await realpath(selected);
  if (!(await stat(directory)).isDirectory()) throw new ApiError('所选路径不是文件夹');
  return { directory, cancelled: false };
}
export async function findGh(env = process.env, options = {}) {
  const platform = options.platform || process.platform;
  return findTool('gh', { env, extraPaths:platform === 'darwin' ? ['/opt/homebrew/bin/gh', join(homedir(), '.local/bin/gh')] : [], ...options });
}
export function repositoryPath(path, platform = process.platform) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || /[\\\0]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new ApiError('Unsafe repository path');
  if (platform === 'win32' && path.split('/').some(part => /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part) || /^git~[1-9]/i.test(part) || /^\.git[ .]/i.test(part))) throw new ApiError('Unsafe Windows repository path (reserved name, alternate stream or path alias)');
  return path;
}
export function assertDistinctPaths(paths, platform = process.platform) {
  if (platform !== 'win32' && platform !== 'darwin') return;
  const seen = new Map();
  for (const path of paths) {
    repositoryPath(path, platform);
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join('/'), key = name.normalize('NFC').toLowerCase();
      if (seen.has(key) && seen.get(key) !== name) throw new ApiError('Case or Unicode path collision prevents safe repository access: ' + name);
      seen.set(key, name);
    }
  }
}
export function parseStatus(raw) {
  const records = raw.split('\0'), changes = [];
  for (let i = 0; i < records.length; i++) {
    const line = records[i]; if (!line) continue;
    const status = line.slice(0, 2), path = line.slice(3);
    changes.push({ path, status }); if (/[RC]/.test(status)) i++;
  }
  return changes;
}
export function validateMerge(pr, { number, repository, baseBranch, expectedHeadOid }) {
  if (!/^[0-9a-f]{40}$/i.test(expectedHeadOid || '')) throw new ApiError('Explicit expected PR head SHA is required');
  if (pr.number !== number || pr.state !== 'OPEN' || pr.isDraft || pr.baseRefName !== baseBranch || pr.headRefOid !== expectedHeadOid || pr.mergeable !== 'MERGEABLE' || pr.reviewDecision !== 'APPROVED') throw new ApiError('PR must be open, approved, non-draft, mergeable, target the default branch, and match the displayed head SHA');
  const url = new URL(pr.url); if (url.origin !== 'https://github.com' || url.pathname.toLowerCase() !== `/${repository}/pull/${number}`.toLowerCase()) throw new ApiError('PR repository mismatch');
  if (!Array.isArray(pr.statusCheckRollup) || pr.statusCheckRollup.some(c => c.__typename === 'StatusContext' ? !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.state) : c.status !== 'COMPLETED' || !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion))) throw new ApiError('All checks must complete successfully (or neutral/skipped)');
}
export function createService({ ghPath, env = process.env, command = runCommand, defaultDirectory = process.cwd(), deploymentFactory = createLocalDeploy, platform = process.platform, repository = FIXED_REPOSITORY, branch = 'dev', cloneMode = 'single', cloneBranch = branch } = {}) {
  repository = repositorySlug(repository);
  if (typeof branch !== 'string' || !branch || branch.startsWith('-') || branch.startsWith('refs/') || branch === '@' || branch.length > 240 || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) || branch.includes('..') || branch.includes('@{') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) throw new ApiError('Invalid configured branch');
  if (!['all','single'].includes(cloneMode)) throw new ApiError('Invalid configured clone mode');
  if (typeof cloneBranch !== 'string' || !cloneBranch || cloneBranch.startsWith('-') || cloneBranch.startsWith('refs/') || cloneBranch === '@' || cloneBranch.length > 240 || /[\x00-\x20\x7f~^:?*\[\\]/.test(cloneBranch) || cloneBranch.includes('..') || cloneBranch.includes('@{') || cloneBranch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) throw new ApiError('Invalid configured clone branch');
  const localRef = `refs/heads/${branch}`, trackingRef = `refs/remotes/origin/${branch}`, fetchRefspec = `+${localRef}:${trackingRef}`;
  const csrfToken = randomBytes(32).toString('hex'), locks = new Set(), logins = new Map(), clones = new Map(), controllers = new Set();
  const conflictReports = new Map();
  let ghPromise, hooksPromise;
  const hooksDirectory = () => hooksPromise ||= mkdtemp(join(tmpdir(), 'simple-github-hooks-')).then(realpath);
  const cleanEnv = { ...normalizeEnv(env), GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GH_PAGER: 'cat', PAGER: 'cat' };
  for (const key of ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete cleanEnv[key];
  async function executable() { const value = ghPath ?? await (ghPromise ||= findGh(env)); if (!value) throw new ApiError('GitHub CLI (gh) is not installed', 503); return value; }
  async function gh(args, options = {}) { return command(await executable(), args, { env: cleanEnv, ...options }); }
  async function git(directory, args, options = {}) { return command('git', ['--no-optional-locks', '-C', directory, ...args], { env: cleanEnv, ...options }); }
  const out = async (dir, args) => (await git(dir, args)).stdout.trim();
  async function user() { try { const data = JSON.parse((await gh(['api', 'user', '--hostname', 'github.com'])).stdout); return { login: text(data.login, 'GitHub login', 100), name: typeof data.name === 'string' ? data.name.trim().slice(0, 200) : '', avatarUrl: /^https:\/\/avatars\.githubusercontent\.com\//.test(data.avatar_url) ? data.avatar_url : '' }; } catch { return null; } }
  async function root(value) {
    text(value, 'directory'); if (!isAbsolute(value)) throw new ApiError('Directory must be absolute');
    const directory = await realpath(value); if (!(await stat(directory)).isDirectory()) throw new ApiError('Directory does not exist');
    const top = await realpath(await out(directory, ['rev-parse', '--show-toplevel']));
    if (!isWithin(directory, top) || !isWithin(top, directory)) throw new ApiError('Select the exact repository root, not a nested directory');
    const fetchUrls=(await out(directory,['remote','get-url','--all','origin'])).split('\n');
    const pushUrls=(await out(directory,['remote','get-url','--push','--all','origin'])).split('\n');
    if(fetchUrls.length!==1||pushUrls.length!==1||[...fetchUrls,...pushUrls].some(url=>githubRemote(url).toLowerCase()!==repository.toLowerCase())) throw new ApiError('此插件仅支持指定团队项目，请选择正确的项目目录');
    return directory;
  }
  async function fingerprint(directory, head, changes) {
    const hash = createHash('sha256').update(head).update(JSON.stringify(changes)).update((await git(directory, ['ls-files','--stage','-z'])).stdout).update((await git(directory, ['ls-files','-v','-z'])).stdout);
    // Independent of HEAD/index/status, but still binds every deployable file and mode.
    // Missing tracked paths are omitted so committing a deletion preserves identity.
    const content = createHash('sha256'); let bytes = 0;
    const paths = (await git(directory, ['ls-files','--cached','--others','--exclude-standard','-z'])).stdout.split('\0').filter(Boolean);
    assertDistinctPaths(paths);
    for (const path of [...new Set(paths)].sort()) {
      repositoryPath(path);
      hash.update(path).update('\0'); const absolute = join(directory, path);
      try {
        const info = await lstat(absolute), file = createHash('sha256').update(path).update('\0').update(String(info.mode));
        if (info.isSymbolicLink()) file.update(await readlink(absolute));
        else if (info.isFile()) { bytes += info.size; if (bytes > 64 * 1024 * 1024) throw new ApiError('Repository preview exceeds 64MB safety budget'); const parent = await realpath(resolve(absolute, '..')); if (!isWithin(directory, parent)) throw new ApiError('Repository path escapes root'); file.update(await readFile(absolute)); }
        else throw new ApiError('Unsupported file type (including submodules)');
        const digest = file.digest('hex'); hash.update(digest); content.update(digest);
      } catch (error) { if (error.code === 'ENOENT') hash.update('missing'); else throw error; }
      hash.update('\0');
    }
    for (const marker of operationMarkers) {
      const path = resolve(directory, await out(directory, ['rev-parse','--git-path',marker]));
      try {
        const info = await lstat(path); hash.update(marker).update(String(info.mtimeMs));
        if (info.isFile()) hash.update(await readFile(path));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { fingerprint: hash.digest('hex'), contentFingerprint: content.digest('hex') };
  }
  async function inspect(directory) {
    directory = await root(directory);
    const safeGit = await isolatedCommands(directory);
    const changes = parseStatus((await safeGit(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout);
    const head = await out(directory, ['rev-parse', '--verify', 'HEAD']);
    let branch = '', baseBranch = null, remote = '', repository = null, ahead = 0, behind = 0;
    try { branch = await out(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']); } catch {}
    try { baseBranch = (await out(directory, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, ''); } catch {}
    try { remote = await out(directory, ['remote', 'get-url', 'origin']); repository = githubRemote(remote); } catch {}
    try { const counts = (await out(directory, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).split(/\s+/).map(Number); [ahead, behind] = counts; } catch {}
    return { directory, branch, baseBranch, remote: redact(remote), repository, changes, ahead, behind, isClean: changes.length === 0, head, ...await fingerprint(directory, head, changes) };
  }
  async function locked(directory, fn) { directory = await root(directory); if (locks.has(directory)) throw new ApiError('Another operation is running in this repository', 409); locks.add(directory); try { return await fn(directory); } finally { locks.delete(directory); } }
  async function remoteContext(directory) {
    const info = await inspect(directory);
    const urls = (await out(directory, ['remote', 'get-url', '--all', 'origin'])).split('\n');
    const pushUrls = (await out(directory, ['remote', 'get-url', '--push', '--all', 'origin'])).split('\n');
    if (urls.length !== 1 || pushUrls.length !== 1 || githubRemote(urls[0]).toLowerCase() !== githubRemote(pushUrls[0]).toLowerCase()) throw new ApiError('Origin fetch and push must identify one matching HTTPS GitHub repository');
    const repository = githubRemote(urls[0]);
    if (!await user()) throw new ApiError('Sign in to GitHub first', 401);
    const metadata = JSON.parse((await gh(['repo', 'view', repository, '--json', 'nameWithOwner,defaultBranchRef'])).stdout);
    if (metadata.nameWithOwner?.toLowerCase() !== repository.toLowerCase() || !metadata.defaultBranchRef?.name) throw new ApiError('Unable to verify canonical GitHub repository/default branch');
    const baseBranch = metadata.defaultBranchRef.name;
    return { ...info, repository, baseBranch };
  }
  async function credentialHelper() {
    const path = (await executable()).replace(/\\/g, '/');
    // Git invokes its credential helper through a shell; only a shell-quoted installed executable is interpolated, never request data.
    return `!'${path.replace(/'/g, `'\\''`)}' auth git-credential`;
  }
  async function networkGit(directory, args) {
    return git(directory, ['-c','credential.helper=', '-c',`credential.helper=${await credentialHelper()}`, ...args], { timeout: 120000 });
  }
  function assertExpected(info, body) {
    for (const [field, expected] of [['branch','expectedBranch'],['repository','expectedRepository'],['baseBranch','expectedBaseBranch'],['head','expectedHead'],['fingerprint','expectedFingerprint']]) {
      if (!Object.hasOwn(body, expected) || body[expected] !== info[field]) throw new ApiError('Repository, branch, HEAD or files changed; refresh the preview before continuing', 409);
    }
  }
  async function expectedState(directory, body) { const current = await inspect(directory); assertExpected(current, body); return current; }
  const operationMarkers = ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer'];
  async function noOperation(directory, allowMerge = false) {
    let merging = false;
    for (const marker of operationMarkers) {
      const path = await out(directory, ['rev-parse','--git-path',marker]);
      try { await access(resolve(directory, path)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (allowMerge && marker === 'MERGE_HEAD') { merging = true; continue; }
      throw new ApiError(marker === 'MERGE_HEAD' ? 'Blocked legacy merge state：当前 Git 操作尚未完成；不会自动中止或重置，请先人工确认并处理已有合并' : '请先完成或中止当前合并、变基等 Git 操作', 409);
    }
    if (await out(directory, ['ls-files','--unmerged'])) throw new ApiError('Resolve merge conflicts first');
    return merging;
  }
  function requireDev(info) { if (info.branch !== branch) throw new ApiError(`请先切换到 ${branch}；只允许提交、同步或推送共享 ${branch} 分支`); }
  function snapshot(info) { return { expectedBranch:info.branch, expectedRepository:info.repository, expectedBaseBranch:info.baseBranch, expectedHead:info.head, expectedFingerprint:info.fingerprint }; }
  async function getConflictReport({ directory, conflictId } = {}) {
    text(conflictId, 'conflict ID', 128);
    const saved = conflictReports.get(conflictId);
    if (!saved) throw new ApiError('Unknown or expired conflict report; retry push for a fresh report', 404);
    directory = await root(directory);
    if (directory !== saved.directory || await out(directory, ['rev-parse','--verify','HEAD']) !== saved.localHead) throw new ApiError('Conflict report no longer matches this repository HEAD', 409);
    return structuredClone(saved);
  }
  async function isolatedCommands(directory) {
    // Override all configured external drivers (including tracked .gitattributes),
    // hooks, rerere and signing. Never run repository merge tooling to detect conflicts.
    const keys = (await git(directory, ['config','--null','--name-only','--list'])).stdout.split('\0');
    const config = ['-c',`core.hooksPath=${await hooksDirectory()}`, '-c','core.fsmonitor=false','-c','commit.gpgSign=false','-c','merge.gpgSign=false','-c','rerere.enabled=false','-c','rerere.autoupdate=false','-c','merge.autoStash=false','-c','merge.renormalize=false','-c','merge.conflictStyle=diff3','-c','merge.default=text'];
    for (const key of new Set(keys)) {
      if (/^merge\..+\.driver$/i.test(key)) config.push('-c', `${key}=false`);
      if (/^filter\..+\.(?:clean|smudge|process)$/i.test(key)) config.push('-c', `${key}=`);
      if (/^filter\..+\.required$/i.test(key)) config.push('-c', `${key}=false`);
    }
    return (dir, args, options) => git(dir, [...config, ...args], options);
  }
  async function isolatedMerge(directory, localHead, remoteHead, snapshotHead, provenance) {
    const isolatedGit = await isolatedCommands(directory);
    const mergeHead = snapshotHead || localHead;
    // Validate before Git materializes either tree (including push-only merges).
    const checkoutPaths = [];
    for (const head of [mergeHead, remoteHead]) checkoutPaths.push(...(await isolatedGit(directory,['ls-tree','-r','--name-only','-z',head])).stdout.split('\0').filter(Boolean));
    checkoutPaths.forEach(path => repositoryPath(path)); assertDistinctPaths(checkoutPaths);
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'simple-github-merge-')));
    const temporary = join(parent, 'worktree');
    try {
      await isolatedGit(directory, ['worktree','add','--detach',temporary,mergeHead]);
      let mergeError;
      try { await isolatedGit(temporary, ['merge','--no-edit','--no-gpg-sign','--no-verify',remoteHead]); } catch (error) { mergeError = error; }
      const conflicts = parseStatus((await isolatedGit(temporary, ['status','--porcelain=v1','-z','--untracked-files=all'])).stdout).filter(item => /U/.test(item.status) || ['AA','DD'].includes(item.status));
      if (conflicts.length) {
        const captured = await isolatedGit(temporary, ['diff','--cc','--no-ext-diff','--no-textconv','--no-color','--'], { maxOutput:256 * 1024, truncate:true });
        let baseHead = null;
        try { baseHead = (await isolatedGit(temporary, ['merge-base',localHead,provenance?.remoteHead || remoteHead])).stdout.trim(); } catch {}
        const report = { directory, conflicts:conflicts.slice(0,512), diff:redact(captured.stdout).replace(/\0/g, '\uFFFD'), truncated:!!captured.truncated || conflicts.length > 512, localHead, remoteHead:provenance?.remoteHead || remoteHead, baseHead, isolated:true, ...(snapshotHead ? { snapshotHead } : {}), ...(provenance ? { layer:provenance.layer, syntheticIncomingHead:remoteHead } : {}) };
        report.fingerprint = createHash('sha256').update(JSON.stringify(report)).digest('hex');
        const conflictId = randomUUID(); conflictReports.set(conflictId, report);
        while (conflictReports.size > 20) conflictReports.delete(conflictReports.keys().next().value);
        return { ok:true, conflict:true, files:report.conflicts.map(item => item.path), conflictId, localHead, remoteHead:report.remoteHead };
      }
      if (mergeError) throw mergeError;
      return { head:(await isolatedGit(temporary, ['rev-parse','--verify','HEAD'])).stdout.trim() };
    } finally {
      // Only the canonical mkdtemp container and its fixed child are ours. Never
      // abort/reset/prune any workspace or recursively remove a request path.
      if (!isAbsolute(parent) || temporary !== join(parent, 'worktree') || await realpath(parent) !== parent || (await lstat(parent)).isSymbolicLink()) throw new ApiError('Unsafe temporary worktree cleanup path', 500);
      try { await isolatedGit(directory, ['worktree','remove','--force',temporary]); }
      catch (error) {
        await rm(temporary, { recursive:true, force:true });
        // A failed add/remove can leave only registration metadata. Remove only
        // a non-symlink entry whose gitdir points at this exact owned child.
        const common = await realpath(resolve(directory, await out(directory, ['rev-parse','--git-common-dir'])));
        const registry = join(common, 'worktrees');
        let entries = [];
        try { if (!(await lstat(registry)).isSymbolicLink() && await realpath(registry) === registry) entries = await readdir(registry); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
        for (const entry of entries) {
          const metadata = join(registry, entry);
          if ((await lstat(metadata)).isSymbolicLink() || await realpath(metadata) !== metadata) continue;
          let gitdir;
          try { gitdir = (await readFile(join(metadata, 'gitdir'), 'utf8')).trim(); } catch (failure) { if (failure.code === 'ENOENT') continue; throw failure; }
          if (isWithin(join(temporary, '.git'), gitdir) && isWithin(gitdir, join(temporary, '.git'))) await rm(metadata, { recursive:true, force:true });
        }
      } finally { await rmdir(parent); }
    }
  }
  const safePath = path => repositoryPath(path);
  const sameMode = (actual, expected) => process.platform === 'win32' || actual === expected;
  const setMode = async (path, mode) => { if (process.platform !== 'win32') await chmod(path, mode); };
  async function regularTree(directory, tree, safeGit) {
    const result = new Map();
    for (const record of (await safeGit(directory, ['ls-tree','-r','-z',tree])).stdout.split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
      if (!match) throw new ApiError('Safe sync requires regular-file trees; symlinks and submodules are unsupported');
      result.set(safePath(match[3]), { mode:match[1], oid:match[2] });
    }
    assertDistinctPaths(result.keys());
    return result;
  }
  async function pathInfo(directory, path) {
    const parts = safePath(path).split('/');
    for (let i = 1; i <= parts.length; i++) {
      try {
        const info = await lstat(join(directory, ...parts.slice(0,i)));
        if (info.isSymbolicLink() || (i < parts.length ? !info.isDirectory() : !info.isFile())) throw new ApiError('Unsafe sync path: only regular files and directory parents are supported');
        if (i === parts.length) return info;
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
  }
  async function layeredSync(directory, current, body, remoteHead, layers) {
    const safeGit = await isolatedCommands(directory), originalHead = current.head;
    const options = { env:{ ...cleanEnv, GIT_AUTHOR_NAME:'Local snapshot', GIT_AUTHOR_EMAIL:'snapshot@localhost', GIT_COMMITTER_NAME:'Local snapshot', GIT_COMMITTER_EMAIL:'snapshot@localhost' } };
    const commit = async (tree, parent) => (await safeGit(directory, ['commit-tree',(await safeGit(directory,['rev-parse',tree + '^{tree}'])).stdout.trim(),...(parent ? ['-p',parent] : []),'-m','Isolated layer (never integrated)'], options)).stdout.trim();
    await regularTree(directory, remoteHead, safeGit);
    const baseline = await isolatedMerge(directory, originalHead, remoteHead);
    await expectedState(directory, body); await noOperation(directory);
    if (baseline.conflict) return baseline;
    await regularTree(directory, baseline.head, safeGit);
    // Explicit synthetic ancestry fixes each merge base, independent of the real
    // branch graph. Only B, never one of these layer commits, reaches dev.
    const mergeLayer = async (baseTree, localTree, incomingTree, layer) => {
      const base = await commit(baseTree), local = await commit(localTree, base), incoming = await commit(incomingTree, base);
      return isolatedMerge(directory, originalHead, incoming, local, { remoteHead, layer });
    };
    const indexResult = await mergeLayer(originalHead, layers.indexTree, baseline.head, 'staged');
    await expectedState(directory, body); await noOperation(directory);
    if (indexResult.conflict) return indexResult;
    const workResult = await mergeLayer(layers.indexTree, layers.workTree, indexResult.head, 'worktree');
    await expectedState(directory, body); await noOperation(directory);
    if (workResult.conflict) return workResult;
    const target = await regularTree(directory, workResult.head, safeGit);
    const original = await regularTree(directory, layers.workTree, safeGit);
    const targetIndex = await regularTree(directory, indexResult.head, safeGit);
    const tracked = await regularTree(directory, originalHead, safeGit);
    const localIndex = await regularTree(directory, layers.indexTree, safeGit);
    // Reject collisions even when an add/add happens to have identical content.
    const incoming = await regularTree(directory, baseline.head, safeGit);
    for (const path of incoming.keys()) if (!tracked.has(path) && !localIndex.has(path) && original.has(path)) throw new ApiError('Untracked collision prevents safe sync: ' + path, 409);
    const paths = [...new Set([...original.keys(), ...target.keys()])];
    assertDistinctPaths([...paths, ...targetIndex.keys(), ...localIndex.keys(), ...tracked.keys()]);
    for (const path of paths) {
      const attrs = (await safeGit(directory,['check-attr','-z','ident','working-tree-encoding','--',path])).stdout.split('\0');
      for (let i = 0; i + 2 < attrs.length; i += 3) if (!['unspecified','unset'].includes(attrs[i + 2])) throw new ApiError('Safe sync does not support ident or working-tree-encoding conversion; no project files were changed',409);
    }
    // Conversion must use the same attribute rules during capture and install.
    // Changing those rules mid-transaction needs a separate, explicit checkout.
    for (const path of paths) if (path.split('/').at(-1) === '.gitattributes' && original.get(path)?.oid !== target.get(path)?.oid) throw new ApiError('Safe sync cannot change .gitattributes conversion rules; integrate attributes separately before retrying', 409);
    const changes = [], createdDirectories = [];
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'simple-github-install-')));
    const indexPath = resolve(directory, await out(directory, ['rev-parse','--git-path','index']));
    let lock, newIndex, ownedLock = false, replacedIndex = false, updatedHead = false, retainRecovery = false;
    const matchesFile = async (path, expected) => {
      const info = await pathInfo(directory,path);
      return expected ? !!info && sameMode(info.mode & 0o777, expected.mode) && (await readFile(join(directory,path))).equals(expected.bytes) : !info;
    };
    const indexInfo = await lstat(indexPath);
    if (!indexInfo.isFile() || indexInfo.isSymbolicLink()) throw new ApiError('Safe sync requires a regular index file');
    const indexBytes = await readFile(indexPath);
    try {
      // Validate every target, including ignored files missing from the snapshot.
      for (const path of new Set([...target.keys(), ...targetIndex.keys(), ...original.keys()])) {
        const info = await pathInfo(directory, path);
        if (info && !original.has(path)) throw new ApiError('Ignored/untracked collision prevents safe sync: ' + path, 409);
      }
      for (const path of paths) {
        const before = original.get(path), after = target.get(path);
        if (before?.oid === after?.oid && before?.mode === after?.mode) continue;
        const info = await pathInfo(directory, path);
        const backup = info ? { bytes:await readFile(join(directory,path)), mode:info.mode & 0o777 } : null;
        const bytes = after ? (await safeGit(directory, ['cat-file','--filters',`--path=${path}`,after.oid], { encoding:null, maxOutput:64 * 1024 * 1024 })).stdout : null;
        const executable = after?.mode === '100755';
        // Preserve private/read-write permission bits; only alter executable bits
        // when the merged Git mode actually changes (or for a new file).
        const mode = backup ? before?.mode === after?.mode ? backup.mode : (backup.mode & ~0o111) | (executable ? 0o111 : 0) : (executable ? 0o755 : 0o644) & ~process.umask();
        changes.push({ path, backup, bytes, mode, installed:false });
      }
      const indexOptions = { env:{ ...cleanEnv, GIT_INDEX_FILE:join(parent,'index') } };
      await safeGit(directory, ['read-tree',indexResult.head], indexOptions);
      newIndex = await readFile(join(parent,'index'));
      lock = await open(indexPath + '.lock','wx',0o600); ownedLock = true;
      await expectedState(directory, body); requireDev(await inspect(directory)); await noOperation(directory);
      if (!(await readFile(indexPath)).equals(indexBytes)) throw new ApiError('Index changed during sync',409);
      await lock.writeFile(newIndex); await lock.sync();
      // Recheck after preparing the lock: no real file has changed yet.
      await expectedState(directory, body);
      for (const path of new Set([...target.keys(), ...targetIndex.keys()])) {
        if (await pathInfo(directory,path) && !original.has(path)) throw new ApiError('Ignored/untracked collision prevents safe sync: ' + path,409);
      }
      for (const change of changes) {
        if (!await matchesFile(change.path,change.backup)) throw new ApiError('Files changed during sync installation',409);
        const absolute = join(directory, change.path), parts = change.path.split('/');
        for (let i = 1; i < parts.length; i++) {
          const dir = join(directory,...parts.slice(0,i));
          try { await mkdir(dir); createdDirectories.push(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        if (change.bytes === null) await unlink(absolute);
        else {
          const temporary = absolute + '.sync-' + randomUUID();
          try {
            await writeFile(temporary,change.bytes,{flag:'wx',mode:change.mode}); await setMode(temporary,change.mode);
            if (!await matchesFile(change.path,change.backup)) throw new ApiError('Files changed during sync installation',409);
            await rename(temporary,absolute);
          }
          finally { await rm(temporary,{force:true}); }
        }
        change.installed = true;
      }
      // Retain index.lock through the HEAD CAS and any rollback. The prepared
      // index lives beside the real index so its replacement is atomic.
      const replacement = indexPath + '.sync-' + randomUUID();
      try {
        await writeFile(replacement,newIndex,{flag:'wx',mode:indexInfo.mode & 0o777}); await setMode(replacement,indexInfo.mode & 0o777);
        const info = await lstat(indexPath);
        if (!info.isFile() || info.isSymbolicLink() || !sameMode(info.mode & 0o777, indexInfo.mode & 0o777) || !(await readFile(indexPath)).equals(indexBytes)) throw new ApiError('Index changed during sync installation',409);
        await rename(replacement,indexPath); replacedIndex = true;
      }
      finally { await rm(replacement,{force:true}); }
      if (await out(directory,['symbolic-ref','HEAD']) !== localRef) throw new ApiError('Branch changed during sync',409);
      await safeGit(directory, ['update-ref',localRef,baseline.head,originalHead]); updatedHead = true;
      return { ok:true, conflict:false };
    } catch (error) {
      const failures = [];
      const restore = async action => { try { await action(); } catch (failure) { failures.push(failure.message); } };
      if (!updatedHead) {
        if (replacedIndex) await restore(async () => {
          const info = await lstat(indexPath);
          if (!info.isFile() || info.isSymbolicLink() || !sameMode(info.mode & 0o777, indexInfo.mode & 0o777) || !(await readFile(indexPath)).equals(newIndex)) throw new Error('Concurrent index edit preserved');
          await writeFile(indexPath,indexBytes); await setMode(indexPath,indexInfo.mode & 0o777);
        });
        for (const change of changes.slice().reverse()) if (change.installed) await restore(async () => {
          const absolute = join(directory,change.path);
          if (!await matchesFile(change.path,change.bytes === null ? null : { bytes:change.bytes, mode:change.mode })) throw new Error('Concurrent file edit preserved: ' + change.path);
          if (change.backup) { await writeFile(absolute,change.backup.bytes); await setMode(absolute,change.backup.mode); }
          else await unlink(absolute);
        });
        for (const dir of createdDirectories.reverse()) await restore(() => rmdir(dir));
      }
      if (failures.length) {
        // Keep original bytes available when concurrent edits prevent restoration.
        // The mkdtemp container is private; files are private independently of umask.
        retainRecovery = true;
        try {
          await writeFile(join(parent,'original-index'),indexBytes,{mode:0o600}); await setMode(join(parent,'original-index'),0o600);
          const manifest = { directory, originalHead, remoteHead, indexMode:indexInfo.mode & 0o777, failures, changes:[] };
          for (let i = 0; i < changes.length; i++) {
            const change = changes[i], backupFile = change.backup ? 'original-' + i : null;
            if (backupFile) { await writeFile(join(parent,backupFile),change.backup.bytes,{mode:0o600}); await setMode(join(parent,backupFile),0o600); }
            manifest.changes.push({ path:change.path, backupFile, originalMode:change.backup?.mode, installed:change.installed, installedMode:change.mode, installedHash:change.bytes === null ? null : createHash('sha256').update(change.bytes).digest('hex') });
          }
          await writeFile(join(parent,'recovery.json'),JSON.stringify(manifest,null,2),{mode:0o600});
        } catch (failure) { failures.push('Recovery bundle incomplete: ' + failure.message); }
        throw new ApiError(error.message + '; rollback requires manual recovery at ' + parent + ': ' + failures.join('; '),500);
      }
      throw error;
    } finally {
      if (lock) await lock.close();
      // Only remove our own real index lock (never somebody else's lock).
      if (ownedLock) await rm(indexPath + '.lock',{force:true});
      if (!isAbsolute(parent) || await realpath(parent) !== parent) throw new ApiError('Unsafe install cleanup path',500);
      if (!retainRecovery) await rm(parent,{recursive:true,force:true});
    }
  }
  async function captureLayers(directory, current) {
    const safeGit = await isolatedCommands(directory);
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'simple-github-layers-')));
    try {
      const options = { env:{ ...cleanEnv, GIT_INDEX_FILE:join(parent,'index') } };
      await copyFile(resolve(directory,await out(directory,['rev-parse','--git-path','index'])),join(parent,'index'));
      // Trees cannot represent intent-to-add. Compare Git's explicit ITA views
      // rather than silently dropping those index entries (including empty files).
      const itaNames = async visibility => new Set((await safeGit(directory,['diff','--cached','--name-only','-z','--no-ext-diff','--no-textconv',visibility,'--'],options)).stdout.split('\0').filter(Boolean));
      const visible = await itaNames('--ita-visible-in-index'), invisible = await itaNames('--ita-invisible-in-index');
      if ([...visible].some(path => !invisible.has(path))) throw new ApiError('Intent-to-add entries prevent safe sync; stage or unstage them first',409);
      const indexTree = (await safeGit(directory,['write-tree'],options)).stdout.trim();
      const indexEntries = await regularTree(directory,indexTree,safeGit);
      const fileMode = (await safeGit(directory,['config','--type=bool','--default=true','--get','core.fileMode'])).stdout.trim() !== 'false';
      await regularTree(directory,current.head,safeGit);
      const paths = [...new Set((await safeGit(directory,['ls-files','--cached','--others','--exclude-standard','-z'])).stdout.split('\0').filter(Boolean))];
      assertDistinctPaths(paths);
      // Git's builtin text/eol conversion keeps CRLF worktrees out of the
      // synthetic local-edit layer. External clean/process drivers remain off.
      // ident/encoding are not safely reversible for arbitrary local raw bytes.
      for (const path of paths) {
        const info = await pathInfo(directory,path);
        if (!info) { await safeGit(directory,['update-index','--force-remove','--',path],options); continue; }
        const attributes = (await safeGit(directory, ['check-attr','-z','ident','working-tree-encoding','--',path])).stdout.split('\0');
        for (let i = 0; i + 2 < attributes.length; i += 3) if (!['unspecified','unset'].includes(attributes[i + 2])) throw new ApiError('Safe sync does not support ident or working-tree-encoding conversion; no project files were changed',409);
        const oid = (await safeGit(directory,['hash-object','-w',`--path=${path}`,'--',path])).stdout.trim();
        const roundtrip = (await safeGit(directory, ['cat-file','--filters',`--path=${path}`,oid], {encoding:null,maxOutput:64 * 1024 * 1024})).stdout;
        if (!(await readFile(join(directory,path))).equals(roundtrip)) throw new ApiError('Safe sync cannot round-trip local line endings/conversion without changing raw bytes; normalize or save these files explicitly before retrying: ' + path,409);
        const mode = (!fileMode || process.platform === 'win32') ? indexEntries.get(path)?.mode || '100644' : info.mode & 0o111 ? '100755' : '100644';
        await safeGit(directory,['update-index','--add','--cacheinfo',mode,oid,path],options);
      }
      return { indexTree, workTree:(await safeGit(directory,['write-tree'],options)).stdout.trim() };
    } finally { await rm(parent,{recursive:true,force:true}); }
  }
  const deployment = deploymentFactory({ inspect, redact });
  async function route(name, body = {}, query = new URLSearchParams()) {
    if ((name.startsWith('deploy-') || name === 'docker-remote-source') && (repository.toLowerCase() !== FIXED_REPOSITORY.toLowerCase() || branch !== 'dev')) throw new ApiError('当前项目未配置发布适配，禁止使用 OA 专属发布入口', 409);
    if (name.startsWith('deploy-')) return deployment.route(name, body);
    switch (name) {
      case 'status': { let available = true; try { await executable(); } catch { available = false; } return { ok: true, user: available ? await user() : null, ghAvailable: available, csrfToken, defaultDirectory, project:{repository,branch}, environment:platformInfo(platform) }; }
      case 'docker-remote-source': {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Reflect.ownKeys(body).length) throw new ApiError('Remote source accepts no local directory or revision');
        const data = JSON.parse((await gh(['api','repos/ssal-team/XiAN-OA/git/ref/heads/dev','--hostname','github.com'])).stdout);
        if (data.ref !== 'refs/heads/dev' || data.object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(data.object?.sha || '')) throw new ApiError('Invalid remote dev commit');
        return {repository:'ssal-team/XiAN-OA',branch:'dev',head:data.object.sha,sourceOrigin:'github-remote-dev'};
      }
      case 'login': {
        const id = query.get('id');
        if (id) { const item = logins.get(id); if (!item) throw new ApiError('Unknown or expired login', 404); return { ok: true, ...item }; }
        const pending = [...logins.entries()].find(([, value]) => value.state === 'pending');
        if (pending) return { ok: true, loginId: pending[0], resumed: true };
        await executable(); const loginId = randomUUID(), item = { state: 'pending' }; logins.set(loginId, item);
        if (logins.size > 20) logins.delete(logins.keys().next().value);
        const controller = new AbortController(); controllers.add(controller); let capture = '';
        void gh(['auth','login','--hostname','github.com','--git-protocol','https','--web'], { timeout: 180000, signal: controller.signal, onOutput(chunk) {
          // Strip after accumulating: Windows pipes may split escape sequences and
          // localized gh prompts need not contain the English word "code".
          capture = (capture + chunk).slice(-8192);
          const plain = capture.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
          const code = /(?:^|[^A-Z0-9_-])([A-Z0-9]{4}-[A-Z0-9]{4})(?![A-Z0-9_-])/i.exec(plain);
          if (code) { item.code = code[1].toUpperCase(); item.url = 'https://github.com/login/device'; }
          if (plain.includes('https://github.com/login/device')) item.url = 'https://github.com/login/device';
        }, env: { ...cleanEnv, BROWSER: platform === 'win32' ? 'cmd.exe /d /c exit 0' : '/usr/bin/true', GH_BROWSER: platform === 'win32' ? 'cmd.exe /d /c exit 0' : '/usr/bin/true' } }).then(() => { item.state = 'success'; }, error => {
          item.state = 'error';
          // Classify locally; never expose raw CLI output, URLs, proxy credentials or tokens.
          const detail = `${error?.message || ''}\n${capture}`;
          if (/timed out|timeout|expired|expired_token/i.test(detail)) item.error = 'GitHub 登录授权已超时，请重新点击登录并及时完成网页授权。';
          else if (/TLS|SSL|x509|certificate|connection|connect|network|proxy|dial tcp|lookup|no such host|EOF/i.test(detail)) item.error = '无法连接 GitHub 授权服务（网络、代理或 TLS 连接失败）。请检查运行 DSH 的电脑能否访问 github.com 和 api.github.com；浏览器能访问不代表 DSH/gh 已使用相同代理。调整代理环境后请完全退出并重启 DSH，再重新登录。';
          else if (/cancelled|canceled|access_denied/i.test(detail)) item.error = 'GitHub 登录已取消或授权被拒绝，请重新登录。';
          else item.error = 'GitHub 设备登录失败，请重新登录；如持续失败，请在本机终端检查 gh 的网络连接与授权状态。';
        }).finally(() => controllers.delete(controller));
        return { ok: true, loginId };
      }
      case 'logout': { if ([...logins.values()].some(v => v.state === 'pending')) throw new ApiError('Wait for pending login to finish before logout', 409); const account = await user(); if (!account) throw new ApiError('No authenticated GitHub account'); await gh(['auth','logout','--hostname','github.com','--user',account.login]); return { ok: true }; }
      case 'repos': return { repos: JSON.parse((await gh(['repo','list','--limit','100','--json','nameWithOwner,url,isPrivate'])).stdout) };
      case 'clone-status': {
        const item = clones.get(body.id);
        if (!item) throw new ApiError('克隆任务不存在或已过期，请检查目标目录', 404);
        return { ...item };
      }
      case 'clone': {
        if(body.repository!==undefined&&normalizeCloneRepository(body.repository).toLowerCase()!==repository.toLowerCase()) throw new ApiError('此插件只能克隆指定团队项目');
        if (typeof body.parentDirectory !== 'string' || !body.parentDirectory.trim()) throw new ApiError('请先选择克隆保存目录');
        const parent = text(body.parentDirectory.trim(), '保存目录');
        if (!isAbsolute(parent)) throw new ApiError('保存目录必须是绝对路径，请点击“选择目录”');
        let parentDirectory; try { parentDirectory = await realpath(parent); } catch { throw new ApiError('保存目录不存在或无法访问，请重新选择目录'); }
        if (!(await stat(parentDirectory)).isDirectory()) throw new ApiError('保存位置必须是已有文件夹');
        const directory = join(parentDirectory, repository.split('/')[1]);
        try { await lstat(directory); throw new ApiError('目标文件夹已存在，不会覆盖。若已克隆，请在上方选择该项目并打开；否则请选择其他保存目录。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (locks.has(directory)) throw new ApiError('Clone already running', 409); locks.add(directory);
        const id = randomUUID(), controller = new AbortController();
        const item = { id, state:'running', directory, log:'', phase:'正在连接 GitHub…', percent:null };
        clones.set(id,item); controllers.add(controller);
        for (const [key,value] of clones) { if (clones.size <= 20) break; if (value.state !== 'running') clones.delete(key); }
        void (async()=>{
          try {
            await gh(['repo','clone',`https://github.com/${repository}.git`,directory,'--','--branch',cloneMode === 'single' ? cloneBranch : branch,...(cloneMode === 'single' ? ['--single-branch'] : ['--no-single-branch']),'--progress','-c','credential.helper=','-c',`credential.helper=${await credentialHelper()}`], {
              cwd:parentDirectory, timeout:600000, signal:controller.signal, truncate:true,
              onOutput(chunk) {
                item.log = redact(item.log + chunk.replace(/\x1b\[[0-9;]*m/g,'')).slice(-12000);
                const lines = item.log.split(/[\r\n]+/).filter(Boolean); const last = lines.at(-1);
                if (last) item.phase = last.slice(0,500);
                const match = /(\d{1,3})%/.exec(last || ''); item.percent = match ? Math.min(100,Number(match[1])) : null;
              }
            });
            item.state='success'; item.phase='克隆完成'; item.percent=100;
          } catch(error) { item.state='error';item.phase='克隆失败';item.error=redact(error.message || '克隆失败，请检查网络及仓库权限'); }
          finally { locks.delete(directory); controllers.delete(controller); }
        })();
        return { id, directory, state:'running' };
      }
      case 'inspect': return inspect(body.directory);
      case 'diff': {
        const directory = await root(body.directory); const options = { maxOutput: 256 * 1024, truncate: true };
        const staged = await git(directory, ['diff','--no-ext-diff','--no-textconv','--no-color','--cached','--'], options);
        const unstaged = await git(directory, ['diff','--no-ext-diff','--no-textconv','--no-color','--'], options);
        return { diff: `=== Staged changes ===\n${staged.stdout}\n=== Unstaged changes ===\n${unstaged.stdout}`.replace(/\0/g, '\uFFFD'), truncated: staged.truncated || unstaged.truncated, untrackedNotice: 'Untracked files are listed in the change list, not included in this diff; submitting stages all files including untracked files.' };
      }
      case 'branch': case 'switch-main': case 'pull': case 'pr-create': case 'pr-merge':
        throw new ApiError('Legacy mutation disabled; use configured shared branch workflow', 403);
      case 'task-start': case 'task-submit': case 'task-switch': case 'task-list': case 'task-status':
        throw new ApiError('Task workflow disabled; use configured shared branch workflow', 403);
      case 'commit-local': case 'push': return locked(body.directory, async directory => {
        let current = await expectedState(directory, body);
        requireDev(current);
        await noOperation(directory, name === 'commit-local');
        await remoteContext(directory);
        current = await expectedState(directory, body); requireDev(current);
        const merging = await noOperation(directory, name === 'commit-local');
        const beforeCommit = current;
        if (name === 'push') {
          if (body.confirmedSelfTest !== true) throw new ApiError('请明确确认已在浏览器完成页面自测，再推送', 409);
          // These index flags hide worktree differences from status/add, so a
          // clean-looking commit would not prove it contains the previewed source.
          const entries = (await git(directory, ['ls-files','-v','-z'])).stdout.split('\0').filter(Boolean);
          if (entries.some(entry => entry[0] === 'S' || /^[a-z]/.test(entry))) throw new ApiError('Index skip-worktree/assume-unchanged flags prevent safe push; clear them and refresh the preview', 409);
          await expectedState(directory, body); await noOperation(directory);
        }
        const message = text(body.message, 'commit message', 2000);
        let stagedTree;
        if (!current.isClean || merging) {
          await git(directory, ['add','-A','--','.']);
          if (name === 'push') {
            const staged = await inspect(directory);
            if (staged.head !== current.head || staged.contentFingerprint !== current.contentFingerprint) throw new ApiError('Files changed during staging; refresh the preview before pushing', 409);
            stagedTree = await out(directory, ['write-tree']);
          }
          if (merging || (await git(directory, ['diff','--cached','--name-only','-z'])).stdout) await git(directory, ['commit','-m',message], { timeout:120000 });
        }
        current = await inspect(directory); requireDev(current); await noOperation(directory);
        if (!current.isClean) throw new ApiError('Files changed during commit; refresh the preview', 409);
        if (name === 'commit-local') return { ok:true };
        if (current.contentFingerprint !== beforeCommit.contentFingerprint || (stagedTree && await out(directory, ['rev-parse','HEAD^{tree}']) !== stagedTree)) throw new ApiError('Committed content differs from the previewed source; refresh the preview before pushing', 409);
        const committed = snapshot(current), localHead = current.head;
        await networkGit(directory, ['fetch','origin',fetchRefspec]);
        current = await expectedState(directory, committed); requireDev(current); await noOperation(directory);
        const remoteHead = await out(directory, ['rev-parse','--verify',`${trackingRef}^{commit}`]);
        const merged = await isolatedMerge(directory, localHead, remoteHead);
        if (merged.conflict) return merged;
        current = await expectedState(directory, committed); requireDev(current); await noOperation(directory);
        if (!current.isClean) throw new ApiError('Files changed during merge; refresh the preview', 409);
        if (merged.head !== localHead) {
          await git(directory, ['-c',`core.hooksPath=${await hooksDirectory()}`,'merge','--ff-only','--no-overwrite-ignore',merged.head]);
          current = await inspect(directory); requireDev(current); await noOperation(directory);
          if (!current.isClean || current.head !== merged.head) throw new ApiError('Files changed during integration; refresh the preview', 409);
          return { ok:true, needsReview:true };
        }
        // Revalidate the clean post-merge snapshot before the normal, explicit push.
        await expectedState(directory, committed); await noOperation(directory);
        try { await networkGit(directory, ['push','--set-upstream','origin',`${localRef}:${localRef}`]); }
        catch (error) { throw new ApiError(`推送失败：本地提交已保留。请刷新并同步 ${branch}、解决冲突后重试；不要强推。详情：` + redact(error.message)); }
        return { ok:true };
      });
      case 'switch-dev': return locked(body.directory, async directory => {
        let current = await expectedState(directory, body);
        if (!current.isClean || !current.branch) throw new ApiError(`请先提交或妥善保存本地修改；切换 ${branch} 需要 clean, attached worktree`);
        await noOperation(directory); await remoteContext(directory);
        await expectedState(directory, body); await noOperation(directory);
        await networkGit(directory, ['fetch','origin',fetchRefspec]);
        current = await expectedState(directory, body);
        if (!current.isClean || !current.branch) throw new ApiError('A clean, attached worktree is required');
        await noOperation(directory);
        let local = true;
        try { await git(directory, ['show-ref','--verify','--quiet',localRef]); } catch { local = false; }
        if (local) await git(directory, ['switch','--no-guess','--no-overwrite-ignore',branch]);
        else {
          await git(directory, ['show-ref','--verify','--quiet',trackingRef]);
          // --single-branch clones only map their original branch. An explicit
          // fetch creates the ref but does not teach Git its tracking mapping.
          const mappings = (await out(directory, ['config','--get-all','remote.origin.fetch'])).split('\n');
          if (!mappings.includes(fetchRefspec) && !mappings.includes(fetchRefspec.slice(1)) && !mappings.includes('+refs/heads/*:refs/remotes/origin/*') && !mappings.includes('refs/heads/*:refs/remotes/origin/*')) {
            await git(directory, ['config','--local','--add','remote.origin.fetch',fetchRefspec]);
          }
          await expectedState(directory, body); await noOperation(directory);
          await git(directory, ['switch','--no-overwrite-ignore','--track','-c',branch,trackingRef]);
        }
        return { ok:true };
      });
      case 'sync-dev': return locked(body.directory, async directory => {
        let current = await expectedState(directory, body); requireDev(current);
        await noOperation(directory); await remoteContext(directory);
        current = await expectedState(directory, body); await noOperation(directory);
        const entries = (await git(directory, ['ls-files','-v','-z'])).stdout.split('\0').filter(Boolean);
        if (entries.some(entry => entry[0] === 'S' || /^[a-z]/.test(entry))) throw new ApiError('Index skip-worktree/assume-unchanged flags prevent safe sync; clear them before retrying', 409);
        const layers = await captureLayers(directory, current);
        await expectedState(directory, body); await noOperation(directory);
        await networkGit(directory, ['fetch','origin',fetchRefspec]);
        current = await expectedState(directory, body); requireDev(current); await noOperation(directory);
        const remoteHead = await out(directory, ['rev-parse','--verify',`${trackingRef}^{commit}`]);
        return layeredSync(directory, current, body, remoteHead, layers);
      });
      case 'prs': { const directory = await root(body.directory), repository = githubRemote(await out(directory, ['remote','get-url','origin'])); return { prs: JSON.parse((await gh(['pr','list','--repo',repository,'--state','open','--limit','100','--json','number,title,url,headRefName,baseRefName,state,isDraft,mergeable,reviewDecision,headRefOid,statusCheckRollup'])).stdout) }; }
      default: throw new ApiError('Not found', 404);
    }
  }
  return { csrfToken, route, inspect, getConflictReport, close() { if (hooksPromise) void hooksPromise.then(path => rmdir(path)).catch(() => {}); conflictReports.clear(); deployment.close(); for (const c of controllers) c.abort(); }, tokenMatches(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(csrfToken)); } };
}

export function checkRequest(req, { port, csrfVerified = false } = {}) {
  if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) throw new ApiError('Loopback connections only', 403);
  const host = req.headers?.host;
  if (typeof host !== 'string' || !/^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(host)) throw new ApiError('Invalid local Host', 403);
  const hostPort = Number(host.slice(host.lastIndexOf(':') + 1));
  if (hostPort < 1 || hostPort > 65535 || (port && hostPort !== Number(port)) || (req.socket.localPort && hostPort !== req.socket.localPort)) throw new ApiError('Host port mismatch', 403);
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) throw new ApiError('Cross-origin request denied', 403);
  if (req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site'])) throw new ApiError('Cross-site request denied', 403);
  // The desktop transport can omit both Origin and Fetch Metadata.
  // Only a verified per-instance CSRF capability permits that fallback.
  // Explicit foreign Origin/Fetch Metadata remain rejected above.
  if (req.method === 'POST' && origin === undefined && req.headers['sec-fetch-site'] !== 'same-origin' && !csrfVerified) throw new ApiError('Same-origin request metadata or valid CSRF token required', 403);
}
export async function readJson(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw new ApiError('application/json content type required', 415);
  const length = Number(req.headers['content-length']); if (Number.isFinite(length) && length > 65536) throw new ApiError('Request body exceeds 64KB', 413);
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw new ApiError('Request body exceeds 64KB', 413); chunks.push(chunk); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError('Invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('JSON object required'); return body;
}
