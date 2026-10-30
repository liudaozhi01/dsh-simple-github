import { readFile } from 'node:fs/promises';
import { API_BASE, ApiError, checkRequest, createService, readJson, redact, chooseDirectory } from './core.js';

import { createConflictNotifier } from './conflict-notice.js';
export const inject = ['webServer'];
export function apply(ctx) {
  const service = createService();
  const notifier = createConflictNotifier(ctx, service);
  ctx.effect(() => () => service.close());
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/simple-github', async handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const reply = (status, value) => { res.setHeader('Content-Type','application/json; charset=utf-8'); res.writeHead(status); res.end(JSON.stringify(value)); };
    try {
      checkRequest(req, { port: ctx.webServer.port, csrfVerified: service.tokenMatches(req.headers['x-simple-git-token']) });
      const url = new URL(req.url, 'http://localhost');
      const assets = { '/simple-github/panel.js': ['panel.js','text/javascript; charset=utf-8'], '/simple-github/panel.css': ['panel.css','text/css; charset=utf-8'] };
      if (assets[url.pathname]) {
        if (req.method !== 'GET') throw new ApiError('GET required', 405);
        const [file, type] = assets[url.pathname]; const data = await readFile(new URL(file, import.meta.url));
        res.setHeader('Content-Type', type); res.writeHead(200); res.end(data); return;
      }
      if (!url.pathname.startsWith(`${API_BASE}/`)) throw new ApiError('Not found', 404);
      const name = url.pathname.slice(API_BASE.length + 1);
      const get = name === 'status' || (name === 'login' && url.searchParams.has('id'));
      const routes = ['choose-directory','status','login','logout','repos','clone','clone-status','inspect','diff','switch-dev','sync-dev','commit-local','push','notify-conflict','deploy-status','deploy-start','deploy-stop','deploy-check','deploy-confirm'];
      if (!routes.includes(name)) throw new ApiError('Not found', 404);
      if (req.method !== (get ? 'GET' : 'POST')) throw new ApiError(get ? 'GET required' : 'POST required', 405);
      let body = {};
      if (!get) { if (!service.tokenMatches(req.headers['x-simple-git-token'])) throw new ApiError('Missing or invalid CSRF token; refresh status', 403); body = await readJson(req); }
      reply(200, name === 'choose-directory' ? await chooseDirectory() : name === 'notify-conflict' ? await notifier.notify(body) : await service.route(name, body, url.searchParams));
    } catch (error) { reply(error instanceof ApiError ? error.status : [400,409,503,504].includes(error.status) ? error.status : 400, { ok: false, error: error instanceof ApiError ? error.message : redact(error.message || 'Operation failed').slice(0, 1000) }); }
  } }));
}
