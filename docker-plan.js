import { randomUUID } from 'node:crypto';

const TTL_MS = 5 * 60 * 1000;
const LIMIT = 128;
const REPOSITORY = 'ssal-team/XiAN-OA';
const HEX40 = /^[a-f0-9]{40}$/i;
const PART = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const IMAGE = new RegExp(`^(?:(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)+)(?::[1-9][0-9]{0,4})?/)?${PART}(?:/${PART})*@sha256:[a-fA-F0-9]{64}$`);
const RELEASE_KEYS = ['releaseId', 'head', 'backendImage', 'frontendImage', 'delivered', 'accepted'];

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
function plainData(value, keys, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail(message);
  if (Reflect.ownKeys(value).some(key => !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw fail(message);
}
function identifier(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) && !/[\s\x00-\x1f\x7f]/.test(value);
}
function head(value) {
  return typeof value === 'string' && value.length === 40 && HEX40.test(value);
}
function image(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\s\x00-\x1f\x7f]/.test(value) || !IMAGE.test(value)) return false;
  const port = value.split('@')[0].split('/')[0].split(':')[1];
  return !port || Number(port) <= 65535;
}
function copyPlan(plan) {
  return { ...plan, remote: { ...plan.remote } };
}

/**
 * Server-only, in-memory planning, NOT an executor or release attestation system.
 * resolveDev and getUser must be trusted backend callbacks, never request fields.
 * recordDevRelease is a capability for a separately verified internal delivery/
 * acceptance flow ONLY. Never expose it as an HTTP route or call it with a body.
 * No files, credentials, processes, Docker commands, network clients or timers.
 */
export function createDockerPlans({ resolveDev, getUser, now = Date.now, randomId = randomUUID }) {
  if (typeof resolveDev !== 'function' || typeof getUser !== 'function' || typeof now !== 'function' || typeof randomId !== 'function') throw new TypeError('resolveDev, getUser, now and randomId must be server functions');
  const plans = new Map();
  const releases = new Map();
  function clock() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - TTL_MS) throw fail('Invalid server clock', 503);
    return value;
  }
  function prune(time) {
    for (const [id, plan] of plans) if (plan.expiresAt <= time) plans.delete(id);
  }
  function save(fields) {
    const createdAt = clock();
    prune(createdAt);
    const planId = randomId();
    if (!identifier(planId) || plans.has(planId)) throw fail('Invalid or duplicate server planId', 503);
    const plan = { ...fields, planId, sourceOrigin: 'github-remote-dev', status: 'awaiting-executor', deployable: false, createdAt, expiresAt: createdAt + TTL_MS };
    while (plans.size >= LIMIT) plans.delete(plans.keys().next().value);
    plans.set(planId, plan);
    return copyPlan(plan);
  }
  async function check(body = {}) {
    plainData(body, [], '检查请求严格只接受空对象，不接受本地目录、HEAD、镜像或执行参数');
    prune(clock());
    const snapshot = await resolveDev();
    if (!snapshot || snapshot.repository !== REPOSITORY || snapshot.branch !== 'dev' || !head(snapshot.head)) throw fail('可信后端未返回有效的 XiAN-OA 远程 dev 快照', 409);
    return save({ environment: 'dev', remote: { repository: REPOSITORY, branch: 'dev', head: snapshot.head } });
  }
  function getPlan(planId) {
    if (!identifier(planId)) throw fail('无效的 planId');
    const plan = plans.get(planId);
    const time = clock();
    prune(time);
    if (plan && plan.expiresAt <= time) throw fail('计划已过期，请重新检查', 410);
    if (!plan) throw fail('计划不存在或已过期，请重新检查', 404);
    return copyPlan(plan);
  }
  function recordDevRelease(record) {
    plainData(record, RELEASE_KEYS, '内部 dev 发布记录字段无效');
    if (RELEASE_KEYS.some(key => !Object.hasOwn(record, key)) || !identifier(record.releaseId) || !head(record.head) || !image(record.backendImage) || !image(record.frontendImage)) throw fail('内部 dev 发布记录必须包含有效 releaseId、HEAD 和两个固定镜像 digest');
    if (record.delivered !== true || record.accepted !== true) throw fail('dev 必须已经交付并验收，才可登记晋级来源', 409);
    // Snapshot primitives only: caller mutation must never change trusted records.
    const saved = Object.fromEntries(RELEASE_KEYS.map(key => [key, record[key]]));
    const previous = releases.get(saved.releaseId);
    if (previous) {
      if (RELEASE_KEYS.some(key => previous[key] !== saved[key])) throw fail('releaseId 已登记，不允许替换已验证的镜像或发布记录', 409);
      return { ...previous };
    }
    while (releases.size >= LIMIT) releases.delete(releases.keys().next().value);
    releases.set(saved.releaseId, saved);
    return { ...saved };
  }
  async function requirePromoter() {
    if ((await getUser())?.name !== '刘道志') throw fail('仅插件当前登录姓名为刘道志时可申请 test 晋级计划', 403);
  }
  async function promotion(body = {}) {
    plainData(body, ['releaseId'], '晋级请求只接受 releaseId，不接受身份、镜像、HEAD 或验收证明');
    if (!Object.hasOwn(body, 'releaseId') || !identifier(body.releaseId)) throw fail('晋级请求需要有效 releaseId');
    const releaseId = body.releaseId;
    await requirePromoter();
    const record = releases.get(releaseId);
    if (!record || record.delivered !== true || record.accepted !== true) throw fail('未找到已交付并验收的 dev 发布记录', 409);
    // Re-resolve identity after reading the trusted record; do not reuse a stale login.
    await requirePromoter();
    if (releases.get(releaseId) !== record) throw fail('已验证的 dev 发布记录已变化，请重试', 409);
    return save({ environment: 'test', ...record, remote: { repository: REPOSITORY, branch: 'dev', head: record.head } });
  }
  return Object.freeze({ check, getPlan, promotion, recordDevRelease });
}
