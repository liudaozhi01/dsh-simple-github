import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

const SHA = /^[a-f0-9]{40}$/;
const ID = /^sha256:[a-f0-9]{64}$/;
const REPO = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)+)(?::[1-9][0-9]{0,4})?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
function data(value, keys) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(k => !keys.includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k), 'value'))) throw new TypeError('Explicit plain data fields required.');
}
function match(pattern, value) { return typeof value === 'string' && !/[\r\n\x00]/.test(value) && pattern.test(value); }
/** Internal capability only. No default runner, registry, credentials or HTTP route.
 * A failure after push may have published images; never retry automatically.
 * Provenance here binds remote HEAD to the injected trusted build and verified image IDs;
 * it is not a signature, vulnerability scan or independent supply-chain attestation.
 */
export function createDockerPublisher(options) {
  data(options, ['command', 'build', 'backendRepository', 'frontendRepository', 'dockerConfig', 'path']);
  const { command, build, backendRepository, frontendRepository, dockerConfig, path = '/usr/local/bin:/usr/bin:/bin' } = options;
  if (typeof command !== 'function' || typeof build !== 'function') throw new TypeError('Trusted build and command capabilities required.');
  for (const repo of [backendRepository, frontendRepository]) {
    if (!match(REPO, repo) || repo.length > 240 || Number(repo.split('/')[0].split(':')[1] || 1) > 65535) throw new TypeError('Explicit registry repository required.');
  }
  if (backendRepository === frontendRepository) throw new TypeError('Separate image repositories required.');
  if (typeof dockerConfig !== 'string' || !isAbsolute(dockerConfig) || /[\x00-\x1f\x7f]/.test(dockerConfig) || typeof path !== 'string' || /[\x00-\x1f\x7f]/.test(path)) throw new TypeError('Explicit server Docker config and PATH required.');
  const env = Object.freeze({ PATH: path, HOME: '/nonexistent', DOCKER_CONFIG: dockerConfig, LANG: 'C', LC_ALL: 'C' });
  let busy = false;
  async function run(args) {
    let result;
    try { result = await command('docker', args, { cwd: '/', env: { ...env }, shell: false, timeout: 600000, maxOutput: 1048576 }); }
    catch { throw new Error('Registry operation failed; publication may be partial. No automatic retry.'); }
    if (!result || (result.code !== undefined && result.code !== 0) || (result.exitCode !== undefined && result.exitCode !== 0) || result.truncated === true || typeof result.stdout !== 'string' || result.stdout.length > 1048576) throw new Error('Registry operation failed; publication may be partial. No automatic retry.');
    return result.stdout;
  }
  async function local(ref, expected) {
    const actual = (await run(['image', 'inspect', '--format', '{{.Id}}', ref])).trim();
    if (actual !== expected) throw new Error('Local image identity changed.');
  }
  async function manifest(ref, expectedId) {
    let value;
    try { value = JSON.parse(await run(['manifest', 'inspect', '--verbose', ref])); } catch { throw new Error('Cannot verify registry manifest; publication may be partial.'); }
    if (!value || Array.isArray(value) || !match(ID, value.Descriptor?.digest) || value.SchemaV2Manifest?.config?.digest !== expectedId || !['application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.oci.image.manifest.v1+json'].includes(value.Descriptor?.mediaType)) throw new Error('Registry image is not the expected single-platform build.');
    return value.Descriptor.digest;
  }
  async function buildAndPublish(input) {
    data(input, ['remote']);
    data(input.remote, ['repository', 'branch', 'head', 'sourceOrigin']);
    const r = input.remote;
    if (r.repository !== 'ssal-team/XiAN-OA' || r.branch !== 'dev' || !match(SHA, r.head) || (r.sourceOrigin !== undefined && r.sourceOrigin !== 'github-remote-dev')) throw new TypeError('Fixed remote dev snapshot required.');
    if (busy) throw new Error('Publication already running.');
    busy = true;
    try {
      const remote = Object.freeze({ repository: r.repository, branch: r.branch, head: r.head });
      const artifact = await build({ remote });
      if (artifact?.head !== remote.head || artifact.attested !== false || !match(ID, artifact.localImageId?.backend) || !match(ID, artifact.localImageId?.frontend)) throw new Error('Trusted build evidence invalid.');
      const token = randomUUID(), refs = {};
      // Tag image IDs, never mutable caller-supplied tags. Validate both before any push.
      const ids = { backend: artifact.localImageId.backend, frontend: artifact.localImageId.frontend };
      for (const role of ['backend', 'frontend']) await local(ids[role], ids[role]);
      for (const [role, repo] of [['backend', backendRepository], ['frontend', frontendRepository]]) {
        const tag = `${repo}:dev-${remote.head}-${token}`;
        await run(['image', 'tag', ids[role], tag]);
        await local(tag, ids[role]);
        await run(['image', 'push', tag]);
        const digest = await manifest(tag, ids[role]);
        const pinned = `${repo}@${digest}`;
        if (await manifest(pinned, ids[role]) !== digest) throw new Error('Pinned manifest mismatch.');
        refs[role] = pinned;
      }
      return Object.freeze({ head: remote.head, backendImage: refs.backend, frontendImage: refs.frontend, provenanceVerified: true });
    } finally { busy = false; }
  }
  return Object.freeze({ buildAndPublish });
}
