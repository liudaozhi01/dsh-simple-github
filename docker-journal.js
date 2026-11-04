import { constants } from 'node:fs';
import { lstat, realpath, open, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';

const KEYS = ['releaseId', 'head', 'backendImage', 'frontendImage', 'delivered', 'accepted'];
const MAX_BYTES = 1024 * 1024;
function record(input) {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== KEYS.length || Reflect.ownKeys(input).some(k => !KEYS.includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, k), 'value'))) throw new Error('Invalid release journal record.');
  const out = Object.fromEntries(KEYS.map(k => [k, input[k]]));
  if (typeof out.releaseId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(out.releaseId) || /\s/.test(out.releaseId) || typeof out.head !== 'string' || !/^[a-f0-9]{40}$/.test(out.head) || out.head.length !== 40 || out.delivered !== true || out.accepted !== true) throw new Error('Only accepted delivered dev releases can be journaled.');
  for (const ref of [out.backendImage, out.frontendImage]) if (typeof ref !== 'string' || ref.length > 512 || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(ref) || /[\s\x00-\x1f\x7f]/.test(ref)) throw new Error('Fixed image digests required.');
  return out;
}
function hash(previous, release) { return createHash('sha256').update(JSON.stringify({ previous, release })).digest('hex'); }
/** Internal accepted-dev journal, not a general log or deployment proof.
 * Caller must supply a dedicated canonical owner-only existing directory.
 * Exclusive lock is deliberately NOT auto-reclaimed after crash: operator review required.
 * Hash chaining detects accidental corruption, not a malicious local owner editing history.
 */
export async function openDockerJournal({ directory } = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || /[\x00-\x1f\x7f]/.test(directory) || await realpath(directory) !== directory) throw new Error('Canonical journal directory required.');
  const dir = await lstat(directory), uid = process.getuid?.();
  if (!dir.isDirectory() || (dir.mode & 0o077) !== 0 || (uid !== undefined && dir.uid !== uid)) throw new Error('Journal directory must be private and owned by current user.');
  const lockPath = join(directory, 'docker-releases.lock'), filePath = join(directory, 'docker-releases.jsonl');
  let lock, file, fileIdentity, lockIdentity, poisoned = false, closed = false, chain = '0'.repeat(64), bytes = 0;
  let queue = Promise.resolve();const releases = new Map();
  async function same(path, expected) { const s = await lstat(path);return s.dev === expected.dev && s.ino === expected.ino && s.isFile() && s.nlink === 1 && (s.mode & 0o077) === 0 && (uid === undefined || s.uid === uid); }
  async function sameDirectory() {
    const current = await lstat(directory);
    return current.isDirectory() && current.dev === dir.dev && current.ino === dir.ino && (current.mode & 0o077) === 0 && (uid === undefined || current.uid === uid) && await realpath(directory) === directory;
  }
  async function cleanup() {
    await file?.close();file = undefined;
    await lock?.close();lock = undefined;
    if (!poisoned && lockIdentity && await same(lockPath, lockIdentity)) await unlink(lockPath);
  }
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);lockIdentity = await lock.stat();
    try { file = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600); }
    catch (e) { if(e.code !== 'EEXIST')throw e;file = await open(filePath, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW); }
    fileIdentity = await file.stat();
    if (!await same(filePath, fileIdentity) || fileIdentity.nlink !== 1 || fileIdentity.size > MAX_BYTES) throw new Error('Unsafe or oversized journal.');
    const text = await file.readFile({ encoding: 'utf8' });bytes = Buffer.byteLength(text);
    if (text && !text.endsWith('\n')) throw new Error('Incomplete journal; operator reconciliation required.');
    for (const line of text ? text.slice(0,-1).split('\n') : []) {
      const entry = JSON.parse(line), release = record(entry.release);
      if (Object.keys(entry).sort().join(',') !== 'hash,previous,release' || entry.previous !== chain || entry.hash !== hash(chain, release) || releases.has(release.releaseId) || releases.size >= 128) throw new Error('Journal integrity or capacity rejected.');
      releases.set(release.releaseId, release);chain = entry.hash;
    }
  } catch (error) { await cleanup();throw error; }
  function list() {
    if (closed || poisoned) throw new Error('Journal unavailable; reconciliation required.');
    return [...releases.values()].map(r => ({ ...r }));
  }
  function append(input) {
    const release = record(input);
    if (closed) return Promise.reject(new Error('Journal closed.'));
    const task = queue.then(async () => {
      if (poisoned) throw new Error('Journal unavailable; reconciliation required.');
      const prior = releases.get(release.releaseId);
      if (prior) { if(JSON.stringify(prior) !== JSON.stringify(release))throw new Error('Release ID cannot be rebound.');return {...prior}; }
      if (releases.size >= 128) throw new Error('Journal capacity reached; explicit archival required.');
      const next = hash(chain,release), line = JSON.stringify({previous:chain,release,hash:next})+'\n';
      if (bytes + Buffer.byteLength(line) > MAX_BYTES) throw new Error('Journal capacity exceeded.');
      try {
        if (!await same(filePath,fileIdentity) || !await same(lockPath,lockIdentity) || !await sameDirectory()) throw new Error('Journal identity changed.');
        const stat = await file.stat();if(stat.size !== bytes || stat.nlink !== 1)throw new Error('Journal changed outside owner.');
        await file.writeFile(line,'utf8');await file.sync();
      } catch { poisoned = true;throw new Error('Journal write uncertain; no automatic retry.'); }
      bytes += Buffer.byteLength(line);chain = next;releases.set(release.releaseId,release);return {...release};
    });
    queue = task.catch(()=>{});return task;
  }
  async function close() { if(closed)return;closed=true;await queue;await cleanup(); }
  return Object.freeze({list,append,close});
}
