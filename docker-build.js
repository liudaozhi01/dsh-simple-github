import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { runCommand } from './core.js';

const HEAD = /^[a-f0-9]{40}$(?![\s\S])/i;
const IMAGE = /^(?:(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)+)(?::[1-9][0-9]{0,4})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*@sha256:[a-f0-9]{64}$(?![\s\S])/;
const LIMITS = Object.freeze({ entries: 10000, bytes: 512 * 1024 * 1024 });
function data(value, keys) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw new TypeError('Only explicit plain data fields are accepted; local source overrides are forbidden.');
  }
}
function base(value) {
  if (typeof value !== 'string' || value.length > 512 || !IMAGE.test(value)) throw new TypeError('Base must be a strict image@sha256 digest (no tag).');
  const port = value.split('/')[0].split(':')[1];
  if (port && Number(port) > 65535) throw new TypeError('Invalid base registry port.');
  return value;
}
function id(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new TypeError('UID/GID must be non-root integers (1..2147483647).');
  return value;
}
function config({ backendBase, frontendBase, uid, gid }) {
  return {
    backendDockerfile: `FROM ${backendBase}\nWORKDIR /app\nCOPY --chown=${uid}:${gid} app.jar /app/app.jar\nUSER ${uid}:${gid}\nENTRYPOINT ["java", "-jar", "/app/app.jar"]\n`,
    frontendDockerfile: `FROM ${frontendBase}\nCOPY --chown=${uid}:${gid} web/ /usr/share/nginx/html/\nUSER ${uid}:${gid}\n# REQUIRED: mount environment-specific /etc/nginx/nginx.conf read-only at runtime.\n# No environment ports or nginx.conf are baked into this promotable image.\nENTRYPOINT ["nginx"]\nCMD ["-g", "daemon off;"]\n`,
  };
}
async function directory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || !(await lstat(path)).isDirectory() || await realpath(path) !== path) {
    throw new Error('Expected a real isolated directory, not a symlink.');
  }
}
// All entries, including directories and ignored target files, consume the shared budget.
async function collect(root, budget, relative = '', depth = 0) {
  if (depth > 64) throw new Error('Artifact directory depth limit exceeded.');
  await directory(root);
  const files = [];
  for await (const entry of await opendir(root)) {
    const name = entry.name;
    if (++budget.entries > LIMITS.entries) throw new Error('Artifact entry limit exceeded.');
    const path = join(root, name), rel = relative ? `${relative}/${name}` : name;
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Artifact symlinks and irregular files are forbidden.');
    if (stat.isDirectory()) files.push(...await collect(path, budget, rel, depth + 1));
    else {
      budget.bytes += stat.size;
      if (!Number.isSafeInteger(budget.bytes) || budget.bytes > LIMITS.bytes) throw new Error('Artifact byte limit exceeded.');
      files.push({ path, rel, stat });
    }
  }
  return files;
}
async function copyArtifact(file, destination) {
  // Recheck canonical parents and identity; O_NOFOLLOW also closes the final-link race.
  if (await realpath(file.path) !== file.path) throw new Error('Artifact path changed.');
  const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== file.stat.ino || stat.dev !== file.stat.dev || stat.size !== file.stat.size || stat.mtimeMs !== file.stat.mtimeMs) throw new Error('Artifact identity changed.');
    // Fixed-length reads avoid unbounded allocation if a file grows during copying.
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('Artifact changed during copy.');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || await realpath(file.path) !== file.path) throw new Error('Artifact changed during copy.');
    await writeFile(destination, bytes, { mode: 0o644, flag: 'wx' });
  } finally { await handle.close(); }
}

/** Trusted internal capability, NOT an HTTP handler or sandbox for hostile source.
 * checkout is the sole source provider: it must return an isolated directory/head/cleanup.
 * Calling build executes that reviewed source on the host (including npm/Maven scripts).
 * makeConfig is a trusted optional template assertion hook, not arbitrary Dockerfile input.
 * This builds local images only: no start, push, database, tests/acceptance or attestation.
 */
export function createDockerBuild({ command = runCommand, checkout, makeConfig = config } = {}) {
  if (typeof command !== 'function' || typeof checkout !== 'function' || typeof makeConfig !== 'function') throw new TypeError('command, checkout and makeConfig must be functions.');
  async function build(input) {
    data(input, ['remote', 'backendBase', 'frontendBase', 'uid', 'gid']);
    const { remote } = input;
    data(remote, ['repository', 'branch', 'head', 'sourceOrigin']);
    if (typeof remote.head !== 'string' || !HEAD.test(remote.head) ||
        (remote.repository !== undefined && remote.repository !== 'ssal-team/XiAN-OA') ||
        (remote.branch !== undefined && remote.branch !== 'dev') ||
        (remote.sourceOrigin !== undefined && remote.sourceOrigin !== 'github-remote-dev')) throw new TypeError('Expected fixed remote dev snapshot.');
    const head = remote.head.toLowerCase();
    const snapshot = Object.freeze({ ...remote, head });
    const settings = Object.freeze({ backendBase: base(input.backendBase), frontendBase: base(input.frontendBase), uid: id(input.uid), gid: id(input.gid) });
    const expected = config(settings), generated = await makeConfig(settings);
    data(generated, ['backendDockerfile', 'frontendDockerfile']);
    if (generated.backendDockerfile !== expected.backendDockerfile || generated.frontendDockerfile !== expected.frontendDockerfile) throw new Error('Dockerfiles must use the fixed pinned, artifact-only, non-root templates.');
    let source, context, contextIdentity, result, failure;
    try {
      source = await checkout(snapshot);
      if (!source || typeof source.cleanup !== 'function') throw new Error('Checkout must supply cleanup.');
      if (source.head?.toLowerCase() !== head) throw new Error('Checkout HEAD differs from locked remote HEAD.');
      await directory(source.directory);
      context = await mkdtemp(join(await realpath(tmpdir()), 'xian-oa-docker-build-'));
      contextIdentity = await lstat(context);
      const home = join(context, 'home'), backend = join(context, 'backend'), frontend = join(context, 'frontend');
      await Promise.all([home, backend, frontend].map(path => mkdir(path)));
      // Never spread process.env: no DB/GH tokens, SSH agents, npmrc/Maven/JVM injection.
      const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, LANG: 'C', LC_ALL: 'C' };
      for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT']) if (typeof process.env[key] === 'string') env[key] = process.env[key];
      async function run(executable, args, cwd = source.directory) {
        const out = await command(executable, args, { cwd, env: { ...env }, shell: false, timeout: 600000, maxOutput: 1024 * 1024 });
        if (out?.code !== undefined && out.code !== 0) throw new Error('Build command failed.');
        return out;
      }
      const java = await run('java', ['-version']);
      if (!/(?:openjdk|java) version "21(?:[.\-"])/.test(`${java?.stderr || ''}\n${java?.stdout || ''}`)) throw new Error('Local Maven requires Java version 21.');
      await run('npm', ['ci']);
      await run('npm', ['run', 'build']);
      await run('mvn', ['-B', '-f', 'backend/pom.xml', 'package']);
      const budget = { entries: 0, bytes: 0 };
      const web = await collect(join(source.directory, 'dist'), budget);
      const target = await collect(join(source.directory, 'backend', 'target'), budget);
      const jars = target.filter(file => !file.rel.includes('/') && file.rel.endsWith('.jar') && !file.rel.startsWith('original-'));
      if (jars.length !== 1) throw new Error('Expected exactly one non-original backend target JAR.');
      if (!web.some(file => file.rel === 'index.html')) throw new Error('Frontend dist/index.html is required.');
      await copyArtifact(jars[0], join(backend, 'app.jar'));
      await mkdir(join(frontend, 'web'));
      for (const file of web) {
        const dest = join(frontend, 'web', file.rel);
        const parent = dirname(dest);
        await mkdir(parent, { recursive: true });
        await copyArtifact(file, dest);
      }
      await writeFile(join(backend, 'Dockerfile'), expected.backendDockerfile);
      await writeFile(join(frontend, 'Dockerfile'), expected.frontendDockerfile);
      const unique = randomUUID();
      const backendTag = `xian-oa-local-backend:${unique}`, frontendTag = `xian-oa-local-frontend:${unique}`;
      await run('docker', ['build', '--network=none', '--tag', backendTag, '.'], backend);
      await run('docker', ['build', '--network=none', '--tag', frontendTag, '.'], frontend);
      async function inspect(tag) {
        const out = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], context);
        const value = out?.stdout?.trim();
        if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$(?![\s\S])/.test(value)) throw new Error('Docker inspect did not return a local sha256 image ID.');
        return value;
      }
      result = { head, backendTag, frontendTag, localImageId: { backend: await inspect(backendTag), frontend: await inspect(frontendTag) }, attested: false,
        runtimeConstraint: 'Mount environment-specific /etc/nginx/nginx.conf read-only at runtime; never bake dev/test ports into the image.' };
    } catch (error) { failure = error; }
    const cleanupErrors = [];
    if (context) {
      try {
        const current = await lstat(context);
        if (!current.isDirectory() || current.ino !== contextIdentity.ino || current.dev !== contextIdentity.dev || await realpath(context) !== context) throw new Error('Refusing cleanup: temporary context identity changed.');
        await rm(context, { recursive: true, force: true });
      } catch (error) { cleanupErrors.push(error); }
    }
    if (typeof source?.cleanup === 'function') { try { await source.cleanup(); } catch (error) { cleanupErrors.push(error); } }
    // Never docker image rm: tags/images may already be shared by other internal operations.
    if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Build cleanup failed.');
    if (failure) throw failure;
    return result;
  }
  return Object.freeze({ build });
}
