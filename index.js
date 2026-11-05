import { readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { githubProjectConfig } from './github-config.js';
import { createGithubConfigStore, GITHUB_ADMINISTRATOR } from './github-config-store.js';
import { API_BASE, ApiError, checkRequest, createService, readJson, redact, chooseDirectory } from './core.js';

import { createConflictNotifier } from './conflict-notice.js';
import { createRemoteUpdater } from './remote-update.js';
import { createEnvironmentSetup } from './environment-setup.js';
import { createRemoteDeploy } from './remote-deploy.js';
import { createNativeDevDeploy } from './native-dev-deploy.js';
import { createDockerPreview } from './docker-preview.js';
import { createTemporaryReleaseClient } from './temporary-release-client.js';
import { createLocalSourceBundle } from './local-source-bundle.js';
export const inject = ['webServer'];
export function apply(ctx, config = {}) {
  // Trusted startup capability only; never read runtime/config from HTTP input.
  const projectPath = fileURLToPath(new URL('./github-project.json', import.meta.url));
  const project = githubProjectConfig(JSON.parse(readFileSync(projectPath, 'utf8')));
  const service = createService({ repository:project.repository, branch:project.branch, cloneMode:project.cloneMode, cloneBranch:project.cloneBranch });
  const configStore = createGithubConfigStore({path:projectPath, activeConfig:project, getUser:async () => (await service.route('status')).user});
  const oaProject = project.repository.toLowerCase() === 'ssal-team/xian-oa' && project.branch === 'dev';
  const getUser = async () => (await service.route('status')).user;
  const runtimeProfile = oaProject ? config.releaseProfile : null;
  const dockerRuntime = config.dockerRuntime === undefined ? (runtimeProfile ? createTemporaryReleaseClient({ port: ctx.webServer.port, team: true, profile: runtimeProfile, source: createLocalSourceBundle(), getUser }) : null) : config.dockerRuntime;
  if (dockerRuntime !== null && (!dockerRuntime || ['check','promotion','start','status','accept','reconcile'].some(key => typeof dockerRuntime[key] !== 'function'))) throw new TypeError('Trusted Docker runtime capability required.');
  if (config.dockerRuntime === undefined && dockerRuntime) ctx.effect(() => () => dockerRuntime.close());
  const dockerPreview = createDockerPreview({ inspect: service.inspect, getUser: async () => (await service.route('status')).user });
  const updater = createRemoteUpdater({repository:project.updateRepository});
  ctx.effect(() => () => updater.close());
  const notifier = createConflictNotifier(ctx, service);
  const environment = createEnvironmentSetup(ctx);
  const remoteDeploy = createRemoteDeploy(ctx);
  const nativeDev = createNativeDevDeploy({ inspect: service.inspect, port: ctx.webServer.port, redact });
  ctx.effect(() => () => nativeDev.close());
  ctx.effect(() => () => service.close());
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/simple-github', async handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const reply = (status, value) => { res.setHeader('Content-Type','application/json; charset=utf-8'); res.writeHead(status); res.end(JSON.stringify(value)); };
    try {
      checkRequest(req, { port: ctx.webServer.port, csrfVerified: service.tokenMatches(req.headers['x-simple-git-token']) });
      const url = new URL(req.url, 'http://localhost');
      const assets = { '/simple-github/error-feedback.js': ['error-feedback.js','text/javascript; charset=utf-8'], '/simple-github/auto-install.js': ['auto-install.js','text/javascript; charset=utf-8'], '/simple-github/panel.js': ['panel.js','text/javascript; charset=utf-8'], '/simple-github/panel.css': ['panel.css','text/css; charset=utf-8'] };
      if (assets[url.pathname]) {
        if (req.method !== 'GET') throw new ApiError('GET required', 405);
        const [file, type] = assets[url.pathname]; const data = await readFileAsync(new URL(file, import.meta.url));
        res.setHeader('Content-Type', type); res.writeHead(200); res.end(data); return;
      }
      if (!url.pathname.startsWith(`${API_BASE}/`)) throw new ApiError('Not found', 404);
      const name = url.pathname.slice(API_BASE.length + 1);
      const get = name === 'status' || (name === 'login' && url.searchParams.has('id'));
      const routes = ['github-config-read','github-config-save','docker-overview','docker-status','docker-accept','docker-reconcile','docker-start','docker-plan','docker-promote','docker-restore','docker-preview','error-notify','remote-dev-check','remote-dev-start','remote-dev-status','remote-deploy-notify','environment-inspect','environment-notify','update-check','update-install','choose-directory','status','login','logout','repos','clone','clone-status','inspect','diff','switch-dev','sync-dev','commit-local','push','notify-conflict','deploy-status','deploy-start','deploy-stop','deploy-check','deploy-confirm'];
      if (!routes.includes(name)) throw new ApiError('Not found', 404);
      if (req.method !== (get ? 'GET' : 'POST')) throw new ApiError(get ? 'GET required' : 'POST required', 405);
      let body = {};
      if (!get) { if (!service.tokenMatches(req.headers['x-simple-git-token'])) throw new ApiError('Missing or invalid CSRF token; refresh status', 403); body = await readJson(req); }
      if (name === 'status') { const status = await service.route('status'); reply(200, {...status, project, githubAdministrator:status.user?.login?.toLowerCase() === GITHUB_ADMINISTRATOR, oaDeploymentAvailable:oaProject}); return; }
      if (name === 'github-config-read') { reply(200, await configStore.read()); return; }
      if (name === 'github-config-save') { reply(200, await configStore.save(body)); return; }
      if (!oaProject && (name.startsWith('docker-') || name.startsWith('deploy-') || name.startsWith('remote-dev-') || ['remote-deploy-notify','environment-inspect','environment-notify'].includes(name))) throw new ApiError('当前项目未适配 OA 专属部署功能，不能使用原项目部署目标', 409);
      if (['docker-plan','docker-promote','docker-restore','docker-start','docker-overview','docker-status','docker-accept','docker-reconcile'].includes(name) && !dockerRuntime) throw new ApiError('尚未配置受控项目发布参数 releaseProfile；团队发布需管理员一次性配置受控入口，成员无需 sudo', 409);
      if (dockerRuntime && ['docker-plan','docker-promote','docker-restore','docker-start','docker-overview','docker-status','docker-accept','docker-reconcile'].includes(name)) {
        if (name === 'docker-status') {
          if (!body || ![Object.prototype,null].includes(Object.getPrototypeOf(body)) || Object.keys(body).some(key => key !== 'jobId') || (body.jobId !== undefined && (typeof body.jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.jobId) || /[\s\x00-\x1f\x7f]/.test(body.jobId)))) throw new ApiError('只允许 jobId 查询',400);
        }
        if (name === 'docker-overview') {
          if (!body || ![Object.prototype,null].includes(Object.getPrototypeOf(body)) || Object.keys(body).length) throw new ApiError('部署概览不接受参数',400);
          if (typeof dockerRuntime.overview !== 'function') throw new ApiError('当前发布入口尚不支持部署概览，请更新受控入口',409);
        }
        if (name === 'docker-restore' && typeof dockerRuntime.restore !== 'function') throw new ApiError('当前发布入口不支持恢复，请更新受控入口',409);
        const method = {'docker-overview':'overview','docker-plan':'check','docker-promote':'promotion','docker-restore':'restore','docker-start':'start','docker-status':'status','docker-accept':'accept','docker-reconcile':'reconcile'}[name];
        reply(200,await dockerRuntime[method](name === 'docker-status' ? body.jobId : body));return;
      }
      if (['remote-dev-check','remote-dev-start'].includes(name)) throw new ApiError('旧本地构建上传链路已停用：远程部署仅允许 GitHub 远程 dev 提交', 409);
      if (name === 'error-notify') throw new ApiError('报错自动发送功能已移除，请在面板查看错误详情', 410);
      reply(200, name === 'docker-preview' ? await dockerPreview(body) : name === 'remote-dev-check' ? await nativeDev.check(body) : name === 'remote-dev-start' ? await nativeDev.start(body) : name === 'remote-dev-status' ? await nativeDev.status(body) : name === 'remote-deploy-notify' ? await remoteDeploy.notify(body) : name === 'environment-inspect' ? await environment.inspect() : name === 'environment-notify' ? await environment.notify(body) : name === 'update-check' ? await updater.check() : name === 'update-install' ? await updater.install(body) : name === 'choose-directory' ? await chooseDirectory() : name === 'notify-conflict' ? await notifier.notify(body) : await service.route(name, body, url.searchParams));
    } catch (error) { reply(error instanceof ApiError ? error.status : [400,403,404,409,429,503,504].includes(error.status) ? error.status : 400, { ok: false, error: error instanceof ApiError ? error.message : redact(error.message || 'Operation failed').slice(0, 1000) }); }
  } }));
}
