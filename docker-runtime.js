import { isAbsolute } from 'node:path';
import { createRemoteSource } from './remote-source.js';
import { createDockerBuild } from './docker-build.js';
import { createDockerPublisher } from './docker-publish.js';
import { createDockerApply } from './docker-apply.js';
import { createDockerPipeline } from './docker-pipeline.js';
import { openDockerJournal } from './docker-journal.js';

const KEYS = ['command', 'exec', 'resolveDev', 'getUser', 'backendBase', 'frontendBase', 'backendRepository', 'frontendRepository', 'dockerConfig', 'journalDirectory', 'path', 'now'];
const IMAGE = /^(?:(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)+)(?::[1-9][0-9]{0,4})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*@sha256:[a-f0-9]{64}$(?![\s\S])/;
function base(value) {
  if (typeof value !== 'string' || value.length > 512 || !IMAGE.test(value) || Number(value.split('/')[0].split(':')[1] || 1) > 65535) throw new TypeError('Pinned backendBase/frontendBase digest required.');
  return value;
}

/** Opt-in server-only composition root; importing does not activate anything.
 * ALL options are trusted startup dependencies/configuration, NEVER HTTP input.
 * command implements core.runCommand(executable, args, options), with rejection
 * on process failure; exec implements the trusted SSH capability used by apply.
 * There are no real runner/SSH defaults. Build executes reviewed remote source
 * on the host. Publisher alone receives its explicit registry config/PATH.
 * Mandatory durable journal stores accepted dev releases, not all jobs, transport
 * proof, DB readiness or crash recovery. Its locks are never force-reclaimed here.
 *
 * close stops admission immediately and waits for entered async API calls. Since
 * executor.start returns before its detached execution finishes (including identity
 * awaits), close REJECTS while status is pending/running, retaining source/journal.
 * It does not cancel or poll: callers may observe status and retry close once the
 * job is terminal. Admission stays closed even after that rejection. status remains
 * available for observation. No HTTP routing, automatic activation, retries/timers.
 */
export async function createDockerRuntime(options = {}) {
  if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) || Reflect.ownKeys(options).some(key => !KEYS.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value'))) throw new TypeError('Explicit trusted startup fields required.');
  const { command, exec, resolveDev, getUser, backendRepository, frontendRepository, dockerConfig, journalDirectory, path, now = Date.now } = options;
  for (const dependency of [command, exec, resolveDev, getUser, now]) if (typeof dependency !== 'function') throw new TypeError('Explicit command, exec, resolveDev, getUser and clock functions required.');
  const backendBase = base(options.backendBase), frontendBase = base(options.frontendBase);
  if (typeof journalDirectory !== 'string' || !isAbsolute(journalDirectory) || /[\x00-\x1f\x7f]/.test(journalDirectory)) throw new TypeError('Explicit private canonical journalDirectory required.');
  // Validate the publisher's exact contract before acquiring any persistent lock.
  const publisherOptions = { command, backendRepository, frontendRepository, dockerConfig, ...(path === undefined ? {} : { path }) };
  createDockerPublisher({ ...publisherOptions, build: async () => { throw new Error('Validation only.'); } });
  const apply = createDockerApply({ exec, now });
  const source = createRemoteSource({ command });
  const builder = createDockerBuild({ command, checkout: source.checkout });
  const journal = await openDockerJournal({ directory: journalDirectory });
  let pipeline;
  try {
    pipeline = createDockerPipeline({ ...publisherOptions, resolveDev, getUser, now, journal,
      build: ({ remote }) => builder.build({ remote, backendBase, frontendBase, uid: 10001, gid: 10001 }),
      deliver: apply.deliver, query: apply.query });
  } catch (error) {
    const cleanup = await Promise.allSettled([source.close(), journal.close()]);
    const failures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError([error, ...failures], 'Docker runtime initialization cleanup failed.');
    throw error;
  }
  const active = new Set();
  let stopping = false, closed = false, closing;
  function action(name) {
    return (...args) => {
      if (stopping) return Promise.reject(new Error('Docker runtime is closed to new actions.'));
      // Defer invocation until tracked, including synchronous callback exceptions.
      const task = Promise.resolve().then(() => pipeline[name](...args));
      active.add(task);
      void task.then(() => active.delete(task), () => active.delete(task));
      return task;
    };
  }
  function close() {
    stopping = true;
    if (closed) return Promise.resolve();
    if (closing) return closing;
    const task = (async () => {
      await Promise.allSettled([...active]);
      const state = pipeline.status();
      if (['pending', 'running'].includes(state.status)) throw new Error('Docker execution is pending/running; resources retained. Observe status and retry close after completion; no cancellation performed.');
      const results = await Promise.allSettled([source.close(), journal.close()]);
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Docker runtime cleanup failed.');
      closed = true;
    })();
    closing = task;
    void task.then(() => { closing = undefined; }, () => { closing = undefined; });
    return task;
  }
  return Object.freeze({ check: action('check'), promotion: action('promotion'), start: action('start'), status: pipeline.status, accept: action('accept'), reconcile: action('reconcile'), close });
}
