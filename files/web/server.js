import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { API_BASE, ApiError, checkRequest, chooseDirectory, createService, readJson, redact } from '../core.js';
import { githubProjectConfig } from '../github-config.js';
import { createGithubConfigStore, GITHUB_ADMINISTRATOR } from '../github-config-store.js';
import { createWebRelease, profile, releasePostRoutes, releaseProgressRoute } from './release.js';

import { createUpdater, WEB_VERSION } from './update.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const distribution = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const updater = createUpdater({ root, version: WEB_VERSION, canInstall: Boolean(process.send && distribution.name === 'xian-oa-github-web'), restart() { setTimeout(() => process.send?.({ type: 'web-update-restart' }), 300); } });
let activeOperations = 0;
const clones = new Set();
const host = '127.0.0.1';
const port = Number(process.argv[2] ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('请指定 0 至 65535 之间的端口。');
}

const explicitConfig = process.env.SIMPLE_GITHUB_WEB_CONFIG;
const configPath = explicitConfig || fileURLToPath(new URL('./github-project.local.json', import.meta.url));
async function readProject(path) {
  return githubProjectConfig(JSON.parse(await readFile(path, 'utf8')));
}
const fallbackConfig = explicitConfig ? undefined : await readProject(new URL('../github-project.json', import.meta.url));
const project = await readProject(configPath).catch(error => {
  if (error.code === 'ENOENT' && fallbackConfig) return fallbackConfig;
  throw error;
});
const service = createService({
  ...project,
  deploymentFactory: () => ({ close() {} }),
});
const getUser = async () => (await service.route('status')).user;
const configStore = createGithubConfigStore({ path: configPath, activeConfig: project, fallbackConfig, getUser });
const release = project.repository.toLowerCase() === profile.repository && project.branch === profile.branch
  ? createWebRelease({ getUser })
  : null;
const assets = new Map(await Promise.all([
  ['/', './index.html', 'text/html'],
  ['/start.js', './start.js', 'text/javascript'],
  ['/simple-github/panel.js', '../panel.js', 'text/javascript'],
  ['/simple-github/panel.css', '../panel.css', 'text/css'],
  ['/simple-github/error-feedback.js', '../error-feedback.js', 'text/javascript'],
  ['/simple-github/schema-review-message.js', '../schema-review-message.js', 'text/javascript'],
].map(async ([path, file, type]) => [
  path, { type: `${type}; charset=utf-8`, data: await readFile(new URL(file, import.meta.url)) },
])));
const postRoutes = new Set([
  'login', 'logout', 'clone', 'clone-status', 'inspect', 'diff', 'choose-directory',
  'switch-dev', 'sync-dev', 'push', 'source-history', 'source-restore-preview', 'source-restore',
  'github-config-read', 'github-config-save',
  'web-update-read', 'web-update-save', 'web-update-check', 'web-update-install',
]);

function reply(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  let operation = false;
  try {
    const localPort = req.socket.localPort;
    if (req.headers.host !== `${host}:${localPort}`) throw new ApiError('Invalid local Host', 403);
    const csrfVerified = service.tokenMatches(req.headers['x-simple-git-token']);
    checkRequest(req, { port: localPort, csrfVerified });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const asset = assets.get(url.pathname);
    if (asset) {
      if (req.method !== 'GET') throw new ApiError('GET required', 405);
      reply(res, 200, asset.data, asset.type);
      return;
    }
    if (!url.pathname.startsWith(`${API_BASE}/`)) throw new ApiError('Not found', 404);
    const name = url.pathname.slice(API_BASE.length + 1);
    const releaseRoute = release && (name === releaseProgressRoute || releasePostRoutes.has(name));
    const readOnly = name === 'status' || (name === 'login' && Boolean(url.searchParams.get('id')))
      || (releaseRoute && name === releaseProgressRoute);
    if (!readOnly && !releaseRoute && !postRoutes.has(name)) throw new ApiError('Not found', 404);
    const method = readOnly ? 'GET' : 'POST';
    if (req.method !== method) throw new ApiError(`${method} required`, 405);
    if (!readOnly && !csrfVerified) throw new ApiError('会话已失效，请刷新页面后重试', 403);
    const body = readOnly ? undefined : await readJson(req);
    if (!readOnly && !name.startsWith('web-update-')) {
      if (updater.busy) throw new ApiError('正在安装更新，请等待服务重启', 409);
      activeOperations++; operation = true;
    }
    if (name.startsWith('web-update-')) {
      if (name === 'web-update-install') {
        for (const id of clones) {
          if ((await service.route('clone-status', { id })).state !== 'running') clones.delete(id);
        }
        const publishing = release && (await release.request(releaseProgressRoute)).progress.state === 'running';
        if (activeOperations || clones.size || publishing) throw new ApiError('请等待当前克隆、同步或发布操作完成后再更新', 409);
      }
      reply(res, 200, await updater.request(name, body));
      return;
    }
    if (releaseRoute) {
      if (url.search) throw new ApiError('发布请求不接受查询参数', 400);
      reply(res, 200, await release.request(name, body));
      return;
    }
    if (name === 'github-config-read' || name === 'github-config-save') {
      const result = name === 'github-config-read' ? await configStore.read() : await configStore.save(body);
      if (name === 'github-config-save') result.message = '配置已保存。请关闭并重新启动本机 Web 服务。';
      reply(res, 200, result);
      return;
    }
    const result = name === 'choose-directory' ? await chooseDirectory() : await service.route(name, body, url.searchParams);
    if (name === 'clone') clones.add(result.id);
    if (name === 'status') {
      result.webVersion = WEB_VERSION;
      result.oaDeploymentAvailable = Boolean(release);
      result.githubAdministrator = result.user?.login?.toLowerCase() === GITHUB_ADMINISTRATOR;
    }
    reply(res, 200, result);
  } catch (error) {
    const status = error instanceof ApiError || [400, 403, 404, 409, 429, 503, 504].includes(error.status) ? error.status : 400;
    reply(res, status, {
      ok: false, error: redact(error.message || '操作失败').slice(0, 1000),
      ...(status === 409 && error.code === 'RELEASE_PREPARATION_RUNNING' ? { code: error.code } : {}),
    });
  } finally {
    if (operation) activeOperations--;
  }
});

function closeServices() {
  release?.close();
  service.close();
}
server.on('close', closeServices);
server.on('error', error => {
  closeServices();
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请指定其他端口。` : error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  process.send?.({ type: 'web-ready', version: WEB_VERSION });
  console.log(`GitHub 协作 Web 版：http://${host}:${server.address().port}/`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { server.close(() => process.exit(0)); server.closeIdleConnections(); });
}

process.on('message', message => {
  if (message?.type === 'web-update-stop') {
    closeServices();
    server.close(() => process.exit(0));
    server.closeAllConnections();
  }
});
