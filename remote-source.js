import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runCommand } from './core.js';

const REPOSITORY = 'ssal-team/XiAN-OA';
const REMOTE = 'https://github.com/ssal-team/XiAN-OA.git';
const KEYS = new Set(['repository', 'branch', 'head', 'sourceOrigin']);
const SHA = /^[a-f0-9]{40}$(?![\s\S])/i;
function lockedHead(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(snapshot)) ||
      Reflect.ownKeys(snapshot).some(key => !KEYS.has(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(snapshot)).some(value => !Object.hasOwn(value, 'value'))) {
    throw new TypeError('Remote snapshot must contain only fixed repository metadata and head; local directory/URL overrides are forbidden.');
  }
  if (typeof snapshot.head !== 'string' || !SHA.test(snapshot.head)) throw new TypeError('Remote head must be exactly 40 hexadecimal characters.');
  for (const [key, value] of [['repository', REPOSITORY], ['branch', 'dev'], ['sourceOrigin', 'github-remote-dev']]) {
    if (Object.hasOwn(snapshot, key) && snapshot[key] !== value) throw new TypeError('Only the fixed GitHub repository remote dev source is supported.');
  }
  return snapshot.head.toLowerCase();
}

/** Public HTTPS only. Never reads gh tokens, local repositories, or caller Git configuration. */
export function createRemoteSource({ command = runCommand, baseDirectory = tmpdir(), env = process.env } = {}) {
  if (typeof command !== 'function') throw new TypeError('command must be a function.');
  const owned = new Set(), pending = new Set();
  let closed = false;
  async function performCheckout(snapshot) {
    const head = lockedHead(snapshot);
    if (closed) throw new Error('Remote source is closed.');
    const base = await realpath(resolve(baseDirectory));
    if (!(await lstat(base)).isDirectory()) throw new Error('Remote source base must be a directory.');
    const root = await mkdtemp(join(base, 'xian-oa-remote-'));
    const identity = await lstat(root);
    let removed = false;
    // Do not accept a path from the caller, nor follow a replaced root/parent symlink.
    async function cleanup() {
      if (removed) return;
      let current;
      try { current = await lstat(root); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        removed = true; owned.delete(cleanup); return;
      }
      if (dirname(root) !== base || !current.isDirectory() || current.isSymbolicLink() ||
          current.dev !== identity.dev || current.ino !== identity.ino ||
          await realpath(root) !== root || await realpath(base) !== base) {
        throw new Error('Refusing cleanup: owned temporary directory identity changed.');
      }
      await rm(root, { recursive: true, force: true });
      removed = true; owned.delete(cleanup);
    }
    owned.add(cleanup);
    try {
      if (closed) throw new Error('Remote source is closed.');
      const directory = join(root, 'repository');
      const home = join(root, 'home'), hooks = join(root, 'hooks'), template = join(root, 'template');
      await Promise.all([directory, home, hooks, template].map(path => mkdir(path)));
      // Whitelist process essentials only: no GH/GIT tokens, askpass, proxy credentials,
      // SSH agent, repository overrides, injected Git config, or application secrets.
      const cleanEnv = {};
      for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT']) {
        if (typeof env[key] === 'string') cleanEnv[key] = env[key];
      }
      Object.assign(cleanEnv, {
        HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ALLOW_PROTOCOL: 'https',
        GIT_NO_REPLACE_OBJECTS: '1', LANG: 'C', LC_ALL: 'C',
      });
      const config = ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false',
        '-c', 'credential.helper=', '-c', 'credential.interactive=false',
        '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.file.allow=never',
        '-c', 'http.followRedirects=false', '-c', 'submodule.recurse=false'];
      const git = args => command('git', [...config, ...args], {
        cwd: directory, env: { ...cleanEnv }, shell: false, timeout: 120000, maxOutput: 1024 * 1024,
      });
      await git(['init', `--template=${template}`, '.']);
      try { await git(['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', REMOTE, 'refs/heads/dev']); }
      catch { throw new Error('Remote dev fetch failed. Private-repository authentication is not supported; no local fallback is allowed.'); }
      const fetched = (await git(['rev-parse', '--verify', 'FETCH_HEAD'])).stdout.trim();
      if (!SHA.test(fetched) || fetched.toLowerCase() !== head) throw new Error('Remote dev branch changed from the locked head; refresh the snapshot.');
      await git(['checkout', '--detach', head]);
      const actual = (await git(['rev-parse', '--verify', 'HEAD'])).stdout.trim();
      if (!SHA.test(actual) || actual.toLowerCase() !== head) throw new Error('Checked-out HEAD does not match the locked head.');
      if ((await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'])).stdout !== '') {
        throw new Error('Remote checkout is not clean.');
      }
      if (closed) throw new Error('Remote source is closed.');
      return { directory, head, cleanup };
    } catch (error) {
      try { await cleanup(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Remote checkout failed and safe cleanup was refused.');
      }
      throw error;
    }
  }
  function checkout(snapshot) {
    const task = performCheckout(snapshot);
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  async function close() {
    closed = true;
    // Do not remove a working directory while an in-flight Git process is using it.
    await Promise.allSettled([...pending]);
    const results = await Promise.allSettled([...owned].map(cleanup => cleanup()));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Remote source safe cleanup failed.');
  }
  return { checkout, close };
}
