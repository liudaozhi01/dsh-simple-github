import { randomUUID } from 'node:crypto';
import { createDockerReconciler } from './docker-reconcile.js';

const LIMIT = 128;
const PART = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const IMAGE = new RegExp(`^(?:(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)+)(?::[1-9][0-9]{0,4})?/)?${PART}(?:/${PART})*@sha256:[a-fA-F0-9]{64}$`);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function data(value, keys) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) ||
      keys.some(key => !Object.hasOwn(value, key))) throw fail('请求必须只包含规定的数据字段');
}
function identifier(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) && !/[\s\x00-\x1f\x7f]/.test(value);
}
function image(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\s\x00-\x1f\x7f]/.test(value) || !IMAGE.test(value)) return false;
  const port = value.split('@')[0].split('/')[0].split(':')[1];
  return !port || Number(port) <= 65535;
}

/** In-memory, server-only capability; not a deployment transport or an HTTP router.
 * All dependencies are mandatory trusted backend capabilities. build must close over
 * reviewed base digests/UID/GID itself: only {remote} is passed here, never HTTP config.
 * deliver must provide independently verified immutable digests and real health evidence.
 * No subprocesses, network, logs, credentials, timers, retries or restart recovery.
 * Reuse one executor instance alongside one plans instance; do not recreate per request.
 */
export function createDockerExecutor({ plans, build, deliver, getUser, query, now = Date.now } = {}) {
  if (!plans || typeof plans.getPlan !== 'function' || typeof plans.recordDevRelease !== 'function' ||
      typeof build !== 'function' || typeof deliver !== 'function' || typeof getUser !== 'function' || typeof now !== 'function') {
    throw new TypeError('Trusted plans, build, deliver, getUser and now functions are required');
  }
  const reconciler = query === undefined ? null : createDockerReconciler({ query, now });
  const jobs = new Map(), usedIds = new Map(), expectations = new Map();
  let busy = false, latest, lastTime = -1;
  function clock() {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0 || time < lastTime) throw fail('服务端时钟无效', 503);
    lastTime = time;
    return time;
  }
  function prune(time) {
    // Never evict a still-valid consumed ID: capacity exhaustion must fail closed.
    // plans.getPlan remains authoritative and must reject expired plans.
    for (const [id, expiresAt] of usedIds) if (expiresAt <= time) usedIds.delete(id);
  }
  function view(job) {
    if (!job) return { status: 'idle' };
    const result = {};
    for (const key of ['id', 'jobId', 'planId', 'environment', 'head', 'status', 'createdAt', 'updatedAt', 'delivered', 'accepted', 'backendImage', 'frontendImage', 'errorCode']) {
      if (Object.hasOwn(job, key)) result[key] = job[key];
    }
    return result;
  }
  function status(jobId) {
    prune(clock());
    if (jobId === undefined) return view(jobs.get(latest));
    if (!identifier(jobId)) throw fail('无效的 jobId');
    const job = jobs.get(jobId);
    if (!job) throw fail('任务不存在', 404);
    return view(job);
  }
  async function identity(environment) {
    let user;
    try { user = await getUser(); } catch { throw fail('无法验证插件当前登录身份', 403); }
    if (typeof user?.name !== 'string' || !user.name.trim() || (environment === 'test' && user.name !== '刘道志')) {
      throw fail(environment === 'test' ? '仅插件当前登录姓名为刘道志时可执行 test 晋级' : '需要有效的插件当前登录姓名', 403);
    }
  }
  function snapshot(planId) {
    const plan = plans.getPlan(planId), time = clock();
    if (!plan || plan.planId !== planId || !['dev', 'test'].includes(plan.environment) ||
        !Number.isSafeInteger(plan.expiresAt) || plan.expiresAt <= time ||
        plan.remote?.repository !== 'ssal-team/XiAN-OA' || plan.remote?.branch !== 'dev' ||
        typeof plan.remote?.head !== 'string' || !/^[a-fA-F0-9]{40}$/.test(plan.remote.head) || /\s/.test(plan.remote.head)) throw fail('可信计划无效或已过期', 409);
    const remote = Object.freeze({ repository: plan.remote.repository, branch: plan.remote.branch, head: plan.remote.head });
    if (plan.environment === 'test' && (plan.delivered !== true || plan.accepted !== true || !image(plan.backendImage) || !image(plan.frontendImage) || plan.head !== remote.head)) throw fail('test 计划缺少已验收的固定镜像', 409);
    return Object.freeze({ planId, environment: plan.environment, expiresAt: plan.expiresAt, remote,
      ...(plan.environment === 'test' ? { backendImage: plan.backendImage, frontendImage: plan.frontendImage } : {}) });
  }
  async function execute(job, plan) {
    let delivering = false;
    try {
      await identity(plan.environment);
      job.status = 'running';
      job.updatedAt = clock();
      const artifact = plan.environment === 'dev' ? await build({ remote: plan.remote }) : Object.freeze({ backendImage: plan.backendImage, frontendImage: plan.frontendImage });
      if (plan.environment === 'dev' && (artifact?.head !== plan.remote.head || artifact?.provenanceVerified !== true || !image(artifact?.backendImage) || !image(artifact?.frontendImage))) throw fail('构建发布证据缺少锁定源码和固定镜像', 409);
      const expectedBackend = artifact.backendImage, expectedFrontend = artifact.frontendImage;
      // Do not start delivery under an identity that changed during a long build.
      await identity(plan.environment);
      expectations.set(job.jobId, Object.freeze({ jobId: job.jobId, environment: job.environment, head: job.head, backendImage: expectedBackend, frontendImage: expectedFrontend }));
      delivering = true;
      const evidence = await deliver({ jobId: job.jobId, environment: plan.environment, remote: plan.remote, artifact });
      // Delivery may have happened even if transport, health or identity checks fail.
      await identity(plan.environment);
      const backendImage = evidence?.backendImage, frontendImage = evidence?.frontendImage;
      if (evidence?.delivered !== true || evidence?.healthy !== true || !image(backendImage) || !image(frontendImage) ||
          (backendImage !== expectedBackend || frontendImage !== expectedFrontend)) throw fail('交付证明无效', 409);
      Object.assign(job, { status: 'delivered', delivered: true, backendImage, frontendImage });
    } catch {
      job.status = delivering ? 'uncertain' : 'failed';
      job.errorCode = delivering ? 'DELIVERY_UNCERTAIN' : 'EXECUTION_FAILED';
    } finally {
      // A broken clock must never strand the mutex or leak raw callback errors.
      try { job.updatedAt = clock(); } catch { /* preserve last verified timestamp */ }
      busy = false;
    }
  }
  async function start(body) {
    data(body, ['planId', 'confirmation', 'databaseRiskAccepted']);
    if (!identifier(body.planId) || body.confirmation !== true || body.databaseRiskAccepted !== true) throw fail('需要有效 planId、明确确认和数据库风险确认');
    const planId = body.planId;
    prune(clock());
    if (busy) throw fail('已有任务正在执行', 409);
    if (usedIds.has(planId)) throw fail('计划已使用，不允许重放', 409);
    if (usedIds.size >= LIMIT) throw fail('已使用计划容量已满，请等待计划过期', 429);
    busy = true;
    try {
      const initial = snapshot(planId);
      await identity(initial.environment);
      const plan = snapshot(planId);
      if (JSON.stringify(initial) !== JSON.stringify(plan)) throw fail('计划已变化', 409);
      if (jobs.size >= LIMIT) {
        const disposable = [...jobs.values()].find(job => job.status !== 'pending' && job.status !== 'running' && !(job.environment === 'dev' && job.status === 'delivered' && !job.accepted));
        if (!disposable) throw fail('任务容量已满，请先完成验收', 429);
        jobs.delete(disposable.jobId);
        expectations.delete(disposable.jobId);
      }
      const time = clock(), jobId = randomUUID();
      const job = { id: jobId, jobId, planId, environment: plan.environment, head: plan.remote.head, status: 'pending', createdAt: time, updatedAt: time, delivered: false, accepted: false };
      usedIds.set(planId, plan.expiresAt);
      jobs.set(jobId, job);
      latest = jobId;
      const result = view(job);
      // All rejections are handled inside execute; no detached rejecting promise.
      void execute(job, plan);
      return result;
    } catch (error) { busy = false; throw error; }
  }
  async function accept(body) {
    data(body, ['jobId', 'confirmation']);
    if (!identifier(body.jobId) || body.confirmation !== true) throw fail('需要有效 jobId 和明确验收确认');
    if (busy) throw fail('已有任务正在执行', 409);
    const job = jobs.get(body.jobId);
    if (!job) throw fail('任务不存在', 404);
    if (job.environment !== 'dev' || job.status !== 'delivered' || job.accepted) throw fail('仅已交付且未验收的 dev 任务可验收', 409);
    busy = true;
    try {
      // Acceptance may be performed by any currently valid named login, not a client name.
      await identity('dev');
      try {
        await plans.recordDevRelease({ releaseId: job.jobId, head: job.head, backendImage: job.backendImage, frontendImage: job.frontendImage, delivered: true, accepted: true });
      } catch {
        job.status = 'uncertain';
        job.errorCode = 'RECORD_UNCERTAIN';
        throw fail('验收登记结果不确定，请人工核查；不会自动重试', 409);
      }
      job.accepted = true;
      job.status = 'accepted';
      job.updatedAt = clock();
      return view(job);
    } finally { busy = false; }
  }
  async function reconcile(body) {
    data(body, ['jobId']);
    if (!identifier(body.jobId)) throw fail('无效的 jobId');
    if (!reconciler) throw fail('只读核对能力未配置', 409);
    if (busy) throw fail('已有任务正在执行', 409);
    const job = jobs.get(body.jobId), expected = expectations.get(body.jobId);
    if (!job || !expected || job.status !== 'uncertain' || job.errorCode !== 'DELIVERY_UNCERTAIN') throw fail('仅交付结果不确定的原任务可核对', 409);
    busy = true;
    try {
      await identity(job.environment);
      const result = await reconciler.reconcile(expected);
      await identity(job.environment);
      if (result.status === 'delivered') {
        Object.assign(job, { status: 'delivered', delivered: true, accepted: false, backendImage: expected.backendImage, frontendImage: expected.frontendImage });
        delete job.errorCode;
      }
      job.updatedAt = clock();
      return view(job);
    } finally { busy = false; }
  }
  return Object.freeze({ start, status, accept, reconcile });
}
