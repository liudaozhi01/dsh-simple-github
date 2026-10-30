import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, findGh, runCommand } from './core.js';
import { normalizeEnv } from './platform.js';
import { gunzipSync } from 'node:zlib';

export function validateUpdatePackage(bytes, version) {
  let tar;
  try { tar = gunzipSync(bytes, {maxOutputLength:32*1024*1024}); } catch { throw new ApiError('更新包不是有效 tgz'); }
  const manifests=[];
  for(let offset=0;offset+512<=tar.length;){
    const header=tar.subarray(offset,offset+512);
    if(header.every(byte=>byte===0))break;
    const name=header.subarray(0,100).toString().replace(/\0.*$/s,'');
    const raw=header.subarray(124,136).toString().replace(/\0.*$/s,'').trim();
    if(!/^[0-7]+$/.test(raw))throw new ApiError('更新包 tar 大小无效');
    const size=parseInt(raw,8),start=offset+512;
    if(start+size>tar.length)throw new ApiError('更新包 tar 不完整');
    if(name==='package/package.json'){
      if(![0,48].includes(header[156])||size>65536)throw new ApiError('更新包 manifest 无效');
      try { manifests.push(JSON.parse(tar.subarray(start,start+size).toString('utf8'))); } catch { throw new ApiError('更新包 manifest 无效'); }
    }
    offset=start+Math.ceil(size/512)*512;
  }
  if(manifests.length!==1||manifests[0].name!=='@local/dsh-simple-github'||manifests[0].version!==version)throw new ApiError('更新包插件名称或版本不匹配，拒绝安装');
}

export const UPDATE_REPOSITORY = 'liudaozhi01/dsh-simple-github';
const MAX_PACKAGE = 16 * 1024 * 1024;
const TTL = 15 * 60 * 1000;
export function newerVersion(candidate, current) {
  const parse = v => typeof v === 'string' && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(candidate), b = parse(current);
  if (!a || !b) throw new ApiError('更新版本格式无效（仅支持正式三段版本号）');
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function releaseCandidate(release, currentVersion) {
  if (!release || release.draft !== false || release.prerelease !== false || !/^v\d+\.\d+\.\d+$/.test(release.tag_name ?? '')) throw new ApiError('发布信息无效，只接受正式 Release');
  const version = release.tag_name.slice(1), available = newerVersion(version, currentVersion);
  const name = `local-dsh-simple-github-${version}.tgz`;
  const assets = release.assets?.filter(asset => asset.name === name) ?? [];
  if (assets.length !== 1) throw new ApiError('Release 缺少唯一的插件安装包');
  const asset = assets[0];
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_PACKAGE || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) throw new ApiError('安装包大小或 GitHub SHA-256 摘要无效');
  return {version, available, assetId:asset.id, size:asset.size, digest:asset.digest, name, notes:String(release.body ?? '').slice(0, 12000)};
}

// Downloads only. The current host has no agent-idle install transaction; do not
// call installBundle here or mutate the profile while agent tasks may be active.
export function createRemoteUpdater({ command = runCommand, locateGh = findGh, now = Date.now, currentVersion, tempDirectory = tmpdir() } = {}) {
  let candidate = null, busy = false, closed = false;
  const abort = new AbortController();
  // Match the panel's gh credential store; inherited tokens must not silently
  // select another account or leak into updater commands.
  const env = {...normalizeEnv(process.env), GH_HOST:'github.com', GH_PROMPT_DISABLED:'1', GH_PAGER:'cat', PAGER:'cat'};
  for (const key of ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN']) delete env[key];
  async function ghApi(endpoint, binary = false) {
    const gh = await locateGh();
    if (!gh) throw new ApiError('请先在 DSH 宿主安装 GitHub CLI 并登录有权访问插件私有仓库的账号');
    try {
      return (await command(gh, ['api', '--hostname', 'github.com', endpoint, '-H', binary ? 'Accept: application/octet-stream' : 'Accept: application/vnd.github+json'], {env, timeout:60000, maxOutput:binary ? MAX_PACKAGE : 256 * 1024, encoding:binary ? null : 'utf8', signal:abort.signal})).stdout;
    } catch (error) {
      throw new ApiError('无法获取插件更新，请检查宿主网络、gh 登录和私有仓库权限：' + error.message);
    }
  }
  async function latest() {
    let release;
    try { release = JSON.parse(await ghApi(`repos/${UPDATE_REPOSITORY}/releases/latest`)); }
    catch (error) { throw new ApiError('读取插件 Release 失败：' + error.message); }
    return releaseCandidate(release, currentVersion ?? JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version);
  }
  async function exclusive(action) {
    if (closed) throw new ApiError('更新服务已关闭', 409);
    if (busy) throw new ApiError('已有更新操作进行中，请稍候', 409);
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  return {
    check: () => exclusive(async () => {
      candidate = null;
      const release = await latest();
      const current = currentVersion ?? JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version;
      candidate = release.available ? {...release, checkId:randomUUID(), expires:now() + TTL} : null;
      return {ok:true, currentVersion:current, version:release.version, available:release.available, notes:release.notes, checkId:candidate?.checkId ?? null};
    }),
    install: body => exclusive(async () => {
      if (body?.confirmed !== true || !candidate || body.checkId !== candidate.checkId || now() >= candidate.expires) throw new ApiError('请重新检查更新并确认下载', 409);
      const expected = candidate;
      candidate = null; // Consume confirmation even when network or checksum fails.
      const fresh = await latest();
      if (['version','assetId','size','digest','name'].some(key => fresh[key] !== expected[key])) { candidate = null; throw new ApiError('远程版本或安装包已变化，请重新检查更新', 409); }
      const bytes = await ghApi(`repos/${UPDATE_REPOSITORY}/releases/assets/${expected.assetId}`, true);
      if (!Buffer.isBuffer(bytes) || bytes.length !== expected.size || 'sha256:' + createHash('sha256').update(bytes).digest('hex') !== expected.digest) throw new ApiError('安装包 SHA-256 或大小校验失败，未安装');
      validateUpdatePackage(bytes, expected.version);
      if (closed) throw new ApiError('更新服务已关闭', 409);
      const directory = await mkdtemp(join(tempDirectory, 'dsh-simple-github-update-'));
      const path = join(directory, expected.name);
      await writeFile(path, bytes, {flag:'wx', mode:0o600});
      candidate = null;
      return {ok:true, installed:false, manualInstallPath:path, message:'已下载并通过 SHA-256 校验，尚未安装。请等所有 Agent 任务结束后，在 DSH 插件管理中使用下方绝对路径安装；按宿主提示重载或重启，再重新打开协作面板。'};
    }),
    close() { closed = true; candidate = null; abort.abort(); },
  };
}
