import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const WEB_VERSION = '0.15.29';
export const updateFiles = [
  'core.js', 'platform.js', 'github-config.js', 'github-config-store.js',
  'panel.js', 'panel.css', 'error-feedback.js', 'schema-review-message.js',
  'native-ssh.js', 'local-source-bundle.js', 'release-profile.js',
  'release-progress.js', 'temporary-release-client.js', 'local-deploy.js',
  'web/server.js', 'web/index.html', 'web/start.js', 'web/release.js',
  'web/release-profile.json', 'web/setup-release.js', 'web/README.md',
  'web/update.js', 'web/launch.js', 'README.md', 'package.json',
  'start.cmd', 'start.command',
];
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
export const digest = data => createHash('sha256').update(data).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function sourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('请填写完整的更新清单 HTTPS 地址'); }
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    fail('更新地址需要 HTTPS；本机调试可使用 localhost HTTP');
  }
  return url;
}
export function manifestUrl(value) {
  const url = sourceUrl(value);
  if (['github.com', 'www.github.com'].includes(url.hostname)) {
    fail('请填写已发布的 manifest.json 文件直链。GitHub 仓库主页不能用于更新；请先发布网页版更新资源，再填写清单的 Raw 地址或静态站点地址。');
  }
  return url;
}
export function newerVersion(candidate, current) {
  const parse = value => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) fail('版本号需要使用 x.y.z 格式');
    return value.split('.').map(Number);
  };
  const a = parse(candidate), b = parse(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function validateManifest(value, base) {
  if (!value || value.format !== 1 || value.name !== 'xian-oa-github-web' || !Array.isArray(value.files)) fail('更新清单格式不正确');
  newerVersion(value.version, '0.0.0');
  if (value.files.length !== updateFiles.length) fail('更新文件清单不完整');
  const seen = new Set();
  let total = 0;
  for (const file of value.files) {
    if (!file || typeof file.url !== 'string' || !file.url || !updateFiles.includes(file.path) || seen.has(file.path) || !Number.isInteger(file.size) || file.size < 0 || file.size > MAX_FILE || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('更新文件路径或校验值不正确');
    const url = sourceUrl(new URL(file.url, base).href);
    if (url.origin !== base.origin) fail('更新文件必须与清单来自同一站点');
    seen.add(file.path);
    total += file.size;
  }
  if (total > MAX_TOTAL) fail('更新包超过大小限制');
  return value;
}
async function download(url, limit, manifest = false) {
  const response = await fetch(sourceUrl(url), { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) fail('更新下载失败 HTTP ' + response.status);
  if (manifest && /text\/html/i.test(response.headers.get('content-type') || '')) fail('更新地址返回了网页，请填写 manifest.json 文件直链');
  if (Number(response.headers.get('content-length')) > limit) fail('更新下载超过大小限制');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) fail('更新下载超过大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function plainFilePath(root, relative) {
  let current = root;
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('更新安装目录无效');
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile()))) fail('更新目标包含链接或非普通文件');
  }
  return current;
}
export function createUpdater({ root, version, canInstall, restart }) {
  const settingsPath = join(root, 'web', 'update.local.json');
  let busy = false, checked = null, requesting = false;
  async function settings() {
    const saved = await readFile(settingsPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
    return { url: saved.url || '', autoCheck: saved.autoCheck !== false };
  }
  async function state() { return { ...await settings(), version, canInstall, busy }; }
  return {
    get busy() { return busy; },
    async request(name, body = {}) {
      if (name === 'web-update-read') return state();
      if (requesting) throw Object.assign(new Error('更新操作进行中，请稍候'), { status: 409 });
      requesting = true;
      try { return await request(name, body); } finally { requesting = false; }
    },
  };
  async function request(name, body) {
    if (busy) throw Object.assign(new Error('更新正在安装，请等待重启'), { status: 409 });
    if (name === 'web-update-save') {
      if (typeof body.url !== 'string' || typeof body.autoCheck !== 'boolean') fail('更新设置格式不正确');
      const url = body.url.trim();
      if (url) manifestUrl(url);
      const temp = settingsPath + '.' + randomUUID();
      await plainFilePath(root, 'web/update.local.json');
      await writeFile(temp, JSON.stringify({ url, autoCheck: body.autoCheck }) + '\n', { mode: 0o600 });
      await rename(temp, settingsPath);
      checked = null;
      return state();
    }
    if (name === 'web-update-check') {
      const { url } = await settings();
      if (!url) fail('请先保存远程更新清单地址');
      const base = manifestUrl(url);
      const bytes = await download(base.href, 65536, true);
      let data;
      try { data = JSON.parse(bytes.toString('utf8')); } catch { fail('更新地址未返回有效 JSON 清单，请核对 manifest.json 文件直链'); }
      const manifest = validateManifest(data, base);
      checked = { manifest, base, id: randomUUID() };
      return { version, available: newerVersion(manifest.version, version), latestVersion: manifest.version, notes: String(manifest.notes || '').slice(0, 4000), checkId: checked.id };
    }
    if (name !== 'web-update-install') fail('未知更新操作');
    if (!canInstall) fail('请使用 start.cmd、start.command 或 node web/launch.js 启动分发版以安装更新');
    if (!checked || body.checkId !== checked.id || body.confirmation !== true || !newerVersion(checked.manifest.version, version)) fail('请重新检查更新并确认安装');
    busy = true;
    const stage = join(root, '.web-update-stage');
    let created = false;
    try {
      if (await lstat(stage).catch(() => null)) fail('存在待恢复的更新，请重新启动程序');
      await mkdir(stage, { mode: 0o700 });
      created = true;
      const { manifest, base } = checked;
      for (const file of manifest.files) {
        const bytes = await download(new URL(file.url, base).href, Math.max(file.size, 1));
        if (bytes.length !== file.size || digest(bytes) !== file.sha256) fail('更新文件校验失败：' + file.path);
        const destination = join(stage, file.path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, bytes, { mode: file.path === 'start.command' ? 0o755 : 0o644 });
      }
      const pkg = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
      if (pkg.name !== 'xian-oa-github-web' || pkg.version !== manifest.version) fail('更新包版本与清单不一致');
      await writeFile(join(stage, 'manifest.json'), JSON.stringify({ manifest, base: base.href }));
      restart();
      return { restarting: true, version: manifest.version, message: '文件校验完成，正在安装并重启；启动失败将恢复上一版。' };
    } catch (error) {
      busy = false;
      if (created) await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }
}
