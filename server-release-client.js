import { createDockerSsh } from './docker-ssh.js';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/;
function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
function body(value, keys) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(k => !keys.includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k), 'value'))) throw fail('发布请求字段无效');
}
function id(value) { if (typeof value !== 'string' || !ID.test(value)) throw fail('需要有效的任务或发布编号'); }
/** Lightweight transport. No checkout/build/publish/journal, and never sends a session message.
 * exec is trusted injection for tests; production uses the existing fixed-target DSH SSH bridge.
 * The remote entry must be installed separately. Constructing this client sends no commands.
 */
export function createServerReleaseClient({ port, getUser, exec } = {}) {
  if (typeof getUser !== 'function' || (exec !== undefined && typeof exec !== 'function')) throw new TypeError('Trusted getUser and optional exec required');
  const ssh = exec ? null : createDockerSsh({ port });
  const run = exec || ssh.exec;
  let closed = false;
  async function call(action, input, keys, owner = false) {
    if (closed) throw fail('发布连接已关闭', 503);
    body(input, keys);
    const request = { ...input };
    // Defensive copy before awaiting identity; caller mutation cannot alter the request.
    if (owner && (await getUser())?.name !== '刘道志') throw fail('仅插件当前登录姓名刘道志可执行此操作', 403);
    if (closed) throw fail('发布连接已关闭', 503);
    const encoded = Buffer.from(JSON.stringify({ action, body: request }), 'utf8').toString('base64');
    const command = `sudo -n /usr/bin/python3 -I /usr/local/libexec/xian-oa-release.py '${encoded}'`;
    let response;
    try {
      const result = await run({ alias: 'xian-oa-test', command, timeoutMs: 180000 });
      if (result?.exitCode !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 4096) throw new Error();
      response = JSON.parse(result.stdout);
      if (!response || ![Object.prototype, null].includes(Object.getPrototypeOf(response)) || response.ok === false) throw new Error();
    } catch { throw fail('服务器发布入口未明确响应；请查询状态，不要重复提交发布。请确认入口已安装。', 503); }
    return response;
  }
  return Object.freeze({
    check(input = {}) { return call('check', input, []); },
    promotion(input = {}) { body(input, ['releaseId']); id(input.releaseId); return call('promote', input, ['releaseId'], true); },
    start(input = {}) {
      body(input, ['planId', 'confirmation', 'databaseRiskAccepted']); id(input.planId);
      if (input.confirmation !== true || input.databaseRiskAccepted !== true) throw fail('必须明确确认发布及数据库风险');
      // Plans are authoritative on the server; a client-supplied environment is forbidden.
      // Require the owner for ALL starts so a test plan cannot bypass the local name gate.
      return call('start', input, ['planId', 'confirmation', 'databaseRiskAccepted'], true);
    },
    status(jobId) { if (jobId !== undefined) id(jobId); return call('status', jobId === undefined ? {} : { jobId }, ['jobId']); },
    accept(input = {}) { body(input, ['jobId', 'confirmation']); id(input.jobId); if (input.confirmation !== true) throw fail('必须明确确认业务验收'); return call('accept', input, ['jobId', 'confirmation'], true); },
    reconcile(input = {}) { body(input, ['jobId']); id(input.jobId); return call('reconcile', input, ['jobId']); },
    close() { closed = true; ssh?.close(); },
  });
}
