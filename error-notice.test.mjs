import test from 'node:test';
import assert from 'node:assert/strict';
import { createErrorNotifier } from './error-notice.js';

const body = (extra = {}) => ({ sessionId: 'session-1', context: '同步 dev', message: 'ECONNREFUSED', ...extra });
function fixture(followup) {
  const messages = [];
  const agent = { session: { id: 'session-1' }, followup: followup || (async message => { messages.push(message); }) };
  const agents = new Map([['session-1', agent]]);
  return { agent, agents, messages, notifier: createErrorNotifier({ get: key => key === 'agents' ? agents : undefined }) };
}
const status = expected => error => error.status === expected;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('delivers immutable user notice with only classified sanitized payload and read-only authorization', async () => {
  const { notifier, messages } = fixture();
  assert.deepEqual(await notifier.notify(body({ directory: '/must/not/read', log: 'DO NOT SEND', env: { SECRET: 'DO NOT SEND' } })), { ok: true, notified: true, duplicate: false });
  assert.equal(messages.length, 1);
  const notice = messages[0];
  assert.equal(notice.role, 'user');
  assert.ok(notice.id);
  assert.equal(notice.source.form, 'notice');
  assert.ok(Object.isFrozen(notice.content));
  assert.match(notice.content[0].text, /不可信数据/);
  assert.match(notice.content[0].text, /只授权分析错误与只读排查/);
  assert.match(notice.content[0].text, /不授权修改.*部署.*自动重试/);
  assert.deepEqual(JSON.parse(notice.content[1].text), { code: 'CONNECTION_FAILED', detail: 'ECONNREFUSED', context: '同步 dev' });
  assert.doesNotMatch(JSON.stringify(notice), /must\/not\/read|DO NOT SEND/);
});

test('server redacts credentials in context and detail and removes CSI/OSC ANSI sequences', async () => {
  const { notifier, messages } = fixture();
  const secrets = ['ghp_ABC123', 'password=abc123', 'Bearer bearersecret', 'https://user:pass@example.com?token=querysecret'];
  await notifier.notify(body({ context: '同步 token=contextsecret', message: '\x1b[31m' + secrets.join(' ') + '\x1b[0m\x1b]0;title\x07' }));
  const text = JSON.stringify(messages);
  for (const secret of ['ghp_ABC123', 'abc123', 'bearersecret', 'user:pass', 'querysecret', 'contextsecret', '\u001b']) assert.ok(!text.includes(secret), secret);
  assert.doesNotMatch(messages[0].content[1].text, /title/);
});

test('duplicates and simultaneous calls coalesce using sanitized details, context and session', async () => {
  const gate = deferred(); let calls = 0;
  const { notifier } = fixture(async () => { calls++; await gate.promise; });
  const first = notifier.notify(body({ message: 'token=one' }));
  const second = notifier.notify(body({ message: 'token=two' }));
  await Promise.resolve();
  assert.equal(calls, 1);
  gate.resolve();
  assert.equal((await first).notified, true);
  assert.equal((await second).duplicate, true);
  assert.equal((await notifier.notify(body({ message: 'token=three' }))).duplicate, true);
  assert.equal((await notifier.notify(body({ context: '另一功能', message: 'token=three' }))).notified, true);
  assert.equal(calls, 2);
});

test('rejects missing, mismatched or unavailable session', async () => {
  for (const change of [f => f.agents.clear(), f => { f.agent.session.id = 'other'; }, f => { f.agent.followup = null; }]) {
    const f = fixture(); change(f);
    await assert.rejects(f.notifier.notify(body()), error => [409, 503].includes(error.status));
    assert.equal(f.messages.length, 0);
  }
});

test('followup failure is sanitized and retryable including coalesced failure', async () => {
  let calls = 0;
  const { notifier } = fixture(async () => { if (++calls === 1) throw new Error('password=private'); });
  const results = await Promise.allSettled([notifier.notify(body()), notifier.notify(body())]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.status, 503);
    assert.doesNotMatch(result.reason.message, /private/);
  }
  assert.equal((await notifier.notify(body())).notified, true);
  assert.equal(calls, 2);
});

test('rejects agent/session/followup object switches before asynchronous delivery', async () => {
  for (const change of [f => f.agents.set('session-1', { ...f.agent }), f => { f.agent.session = { id: 'session-1' }; }, f => { f.agent.followup = async () => {}; }]) {
    const f = fixture();
    const attempt = f.notifier.notify(body());
    change(f);
    await assert.rejects(attempt, status(409));
    assert.equal(f.messages.length, 0);
  }
});

test('checks identity after followup and does not cache changed-session success', async () => {
  const gate = deferred(); let calls = 0;
  const f = fixture(async () => { calls++; if (calls === 1) await gate.promise; });
  const attempt = f.notifier.notify(body());
  await Promise.resolve();
  const original = f.agent.session;
  f.agent.session = { id: 'session-1' };
  gate.resolve();
  await assert.rejects(attempt, status(409));
  f.agent.session = original;
  assert.equal((await f.notifier.notify(body())).notified, true);
  assert.equal(calls, 2);
});

test('validates input types, length, empty and control characters', async () => {
  const { notifier, messages } = fixture();
  for (const input of [null, [], 1, 'text', {}, body({ sessionId: '../session' }), body({ sessionId: 'a'.repeat(129) }), body({ sessionId: 'session-1\n' }), body({ sessionId: 1 }), ...['', ' ', null, 1, 'x'.repeat(101), 'x\ny', 'x\x1by'].map(context => body({ context })), ...['', ' ', null, {}, 'x'.repeat(12001), 'x\0y', '\x1b[31m'].map(message => body({ message }))]) {
    await assert.rejects(notifier.notify(input), status(400));
  }
  assert.equal(messages.length, 0);
  assert.equal((await notifier.notify(body({ context: 'x'.repeat(100), message: 'x'.repeat(12000) }))).notified, true);
});

test('five-minute deduplication expires and delivered cache is bounded to 128', async () => {
  const original = Date.now; let now = original();
  Date.now = () => now;
  try {
    const { notifier, messages } = fixture();
    await notifier.notify(body());
    now += 299999;
    assert.equal((await notifier.notify(body())).duplicate, true);
    now++;
    assert.equal((await notifier.notify(body())).notified, true);
    for (let i = 0; i < 128; i++) await notifier.notify(body({ message: `error ${i}` }));
    assert.equal((await notifier.notify(body())).notified, true);
    assert.equal(messages.length, 131);
  } finally { Date.now = original; }
});

test('pending cap rejects new keys but permits coalescing and releases after completion', async () => {
  const gate = deferred(); let calls = 0;
  const { notifier } = fixture(async () => { calls++; await gate.promise; });
  const pending = Array.from({ length: 128 }, (_, i) => notifier.notify(body({ message: `error ${i}` })));
  const duplicate = notifier.notify(body({ message: 'error 0' }));
  await assert.rejects(notifier.notify(body({ message: 'overflow' })), status(429));
  assert.equal(calls, 128);
  gate.resolve();
  await Promise.all(pending);
  assert.equal((await duplicate).duplicate, true);
  assert.equal((await notifier.notify(body({ message: 'overflow' }))).notified, true);
});
