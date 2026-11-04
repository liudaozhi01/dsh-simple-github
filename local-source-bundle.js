import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { repositorySlug, runCommand } from './core.js';

const MAX_BYTES = 256 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$(?![\s\S])/i;

function metadata(input, withHead = false) {
  const keys = withHead ? ['repository', 'branch', 'head'] : ['repository', 'branch'];
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).some(key => !keys.includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(input)).some(d => !Object.hasOwn(d, 'value'))) {
    throw new TypeError('Only repository, branch and locked head metadata are supported; local sources and URLs are forbidden.');
  }
  if (typeof input.repository !== 'string' || /[\x00-\x20\x7f]/.test(input.repository)) throw new TypeError('Invalid GitHub repository slug.');
  const repository = repositorySlug(input.repository);
  const branch = input.branch;
  if (typeof branch !== 'string' || branch.length > 240 || !branch || branch.startsWith('-') ||
      /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) || branch.includes('..') || branch.includes('@{') ||
      branch === '@' || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new TypeError('Invalid remote branch name.');
  }
  if (withHead && (typeof input.head !== 'string' || !SHA.test(input.head))) throw new TypeError('Invalid locked remote head.');
  return { repository, branch, ...(withHead ? { head: input.head.toLowerCase() } : {}) };
}

// Keep local gh authentication, but do not inherit arbitrary debug, proxy, server,
// application, or Git credential settings. Authentication never leaves this process.
function ghEnvironment() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT',
    'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return { ...env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' };
}

/** Trusted implementation seam: writes raw bytes to an already exclusively opened file. */
async function downloadTarball({ args, env, handle, maxBytes }) {
  const child = spawn('gh', args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let size = 0, failure;
  const stop = error => { failure ||= error; child.kill('SIGKILL'); };
  const timer = setTimeout(() => stop(new Error('GitHub source download timed out.')), 120000);
  timer.unref();
  // Never retain or expose gh stderr (it can include authentication diagnostics).
  child.stderr.resume();
  const completion = new Promise((resolveResult, reject) => {
    child.once('error', () => reject(new Error('Unable to start GitHub source download.')));
    child.once('close', code => code === 0 && !failure ? resolveResult() : reject(failure || new Error('GitHub source download failed.')));
  });
  // Attach rejection handling immediately while stdout is being consumed.
  void completion.catch(() => {});
  try {
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('GitHub source archive exceeds 256 MiB.');
      let offset = 0;
      while (offset < chunk.length) {
        const written = await handle.write(chunk, offset, chunk.length - offset);
        if (!written.bytesWritten) throw new Error('Unable to write source archive.');
        offset += written.bytesWritten;
      }
    }
    await completion;
  } catch (error) {
    stop(error);
    await completion.catch(() => {});
    throw failure || error;
  } finally { clearTimeout(timer); }
}

/** Local authenticated GitHub-only archive acquisition. No checkout or build occurs.
 * `download` is a trusted constructor dependency, never request-controlled.
 */
export function createLocalSourceBundle({ command = runCommand, baseDirectory = tmpdir(), download = downloadTarball } = {}) {
  if (typeof command !== 'function' || typeof download !== 'function') throw new TypeError('Invalid trusted source dependency.');
  async function resolveHead(input) {
    const { repository, branch } = metadata(input);
    const endpoint = `repos/${repository}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
    let response;
    try {
      response = await command('gh', ['api', endpoint, '--hostname', 'github.com'], {
        env: ghEnvironment(), shell: false, timeout: 30000, maxOutput: 65536,
      });
    } catch { throw new Error('Unable to resolve authenticated GitHub remote branch.'); }
    let value;
    try { value = JSON.parse(response.stdout); } catch { throw new Error('Invalid GitHub remote branch response.'); }
    if (response.truncated || value?.ref !== `refs/heads/${branch}` || value?.object?.type !== 'commit' ||
        typeof value?.object?.sha !== 'string' || !SHA.test(value.object.sha)) throw new Error('GitHub remote branch binding is invalid.');
    return { repository, branch, head: value.object.sha.toLowerCase() };
  }
  async function prepare(input) {
    const snapshot = metadata(input, true);
    const current = await resolveHead({ repository: snapshot.repository, branch: snapshot.branch });
    if (current.head !== snapshot.head) throw new Error('Remote branch changed from the locked head; refresh the snapshot.');
    const base = await realpath(resolve(baseDirectory));
    if (!(await lstat(base)).isDirectory()) throw new Error('Source bundle base must be a directory.');
    const root = await mkdtemp(join(base, 'xian-oa-source-'));
    const identity = await lstat(root), baseIdentity = await lstat(base);
    let removed = false;
    async function guard() {
      const own = await lstat(root), parent = await lstat(base);
      if (!own.isDirectory() || own.isSymbolicLink() || own.dev !== identity.dev || own.ino !== identity.ino ||
          parent.dev !== baseIdentity.dev || parent.ino !== baseIdentity.ino || dirname(root) !== base ||
          await realpath(root) !== root || await realpath(base) !== base) {
        throw new Error('Refusing source operation: temporary directory identity changed.');
      }
    }
    async function cleanup() {
      if (removed) return;
      try { await guard(); } catch (error) {
        // A missing owned root needs no deletion; never remove a replacement.
        if (error.code === 'ENOENT') {
          try { await lstat(root); } catch (missing) { if (missing.code === 'ENOENT') { removed = true; return; } }
        }
        throw error;
      }
      await rm(root, { recursive: true, force: true });
      removed = true;
    }
    let handle;
    try {
      await guard();
      const path = join(root, 'source.tar.gz');
      handle = await open(path, 'wx+', 0o600);
      const fileIdentity = await handle.stat();
      try {
        await download({ args: ['api', `repos/${snapshot.repository}/tarball/${snapshot.head}`, '--hostname', 'github.com'],
          env: ghEnvironment(), handle, maxBytes: MAX_BYTES });
      } catch { throw new Error('GitHub source archive download failed (maximum 256 MiB).'); }
      await guard();
      const file = await lstat(path), stat = await handle.stat();
      if (!file.isFile() || file.isSymbolicLink() || file.dev !== fileIdentity.dev || file.ino !== fileIdentity.ino ||
          stat.size !== file.size || stat.size < 18 || stat.size > MAX_BYTES) throw new Error('Invalid or oversized GitHub source archive.');
      const hash = createHash('sha256'), buffer = Buffer.alloc(65536);
      let position = 0;
      while (position < stat.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (!bytesRead) throw new Error('Source archive changed during hashing.');
        if (position === 0 && (buffer[0] !== 0x1f || buffer[1] !== 0x8b || buffer[2] !== 8)) throw new Error('GitHub source archive must be gzip.');
        hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      await handle.close(); handle = undefined;
      return { path, sha256: hash.digest('hex'), size: stat.size, cleanup };
    } catch (error) {
      await handle?.close();
      try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Source bundle failed and safe cleanup was refused.'); }
      throw error;
    }
  }
  return { resolve: resolveHead, prepare };
}
