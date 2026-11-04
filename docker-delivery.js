import { createDockerReleasePreview } from './docker-release.js';

const SHA = /^[a-f0-9]{40}$(?![\s\S])/;
const IMAGE = /^(?:(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)+)(?::[1-9][0-9]{0,4})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*@sha256:[a-f0-9]{64}$(?![\s\S])/;
const PLACEHOLDER_BACKEND = `xian-oa/backend@sha256:${'a'.repeat(64)}`;
const PLACEHOLDER_FRONTEND = `xian-oa/frontend@sha256:${'b'.repeat(64)}`;
const TEMPLATES = Object.fromEntries(['dev', 'test'].map(environment => [environment,
  createDockerReleasePreview({ environment, head: '0'.repeat(40), fingerprint: '0'.repeat(64), backendImage: PLACEHOLDER_BACKEND, frontendImage: PLACEHOLDER_FRONTEND, uid: 10001, gid: 10001 }).composeYaml]));

function plain(value, allowed) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw new TypeError('Expected explicit plain data fields only.');
  }
}
function image(value) {
  if (typeof value !== 'string' || value.length > 512 || !IMAGE.test(value)) throw new TypeError('Registry publication required: real repository@sha256 only; local image IDs/tags cannot be promoted.');
  const port = value.split('/')[0].split(':')[1];
  if (port && Number(port) > 65535) throw new TypeError('Invalid registry port.');
  return value;
}

// Fixed reviewed script. Dynamic inputs are strictly validated positional arguments,
// never Python/shell source. No env file contents, config JSON or stderr are emitted.
const SCRIPT = `import os, sys, stat, json, subprocess, platform, fcntl, re
TEMPLATES = json.loads(${JSON.stringify(JSON.stringify(TEMPLATES))})
BACKEND = ${JSON.stringify(PLACEHOLDER_BACKEND)}
FRONTEND = ${JSON.stringify(PLACEHOLDER_FRONTEND)}
def require(ok):
    if not ok: raise RuntimeError('preflight rejected')
def metadata(path, secret=False, directory=False):
    require(os.path.realpath(path) == path)
    s = os.lstat(path)
    require((stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode)) and s.st_uid == 0)
    require((s.st_mode & (0o077 if secret else 0o022)) == 0)
    return s
def run(args):
    p = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/nonexistent','LANG':'C','LC_ALL':'C'},
        cwd='/', timeout=20, check=False)
    require(p.returncode == 0 and len(p.stdout) <= 1048576)
    return p.stdout.decode('utf-8')
def main():
    require(os.geteuid() == 0 and platform.system() == 'Linux' and len(sys.argv) == 5)
    environment, head, backend, frontend = sys.argv[1:]
    require(environment in ('dev','test') and re.fullmatch('[a-f0-9]{40}',head) is not None)
    require(all(re.fullmatch('[a-z0-9./:_-]+@sha256:[a-f0-9]{64}', v) for v in (backend,frontend)))
    root='/opt/xian-oa-'+environment
    etc='/etc/xian-oa-'+environment
    for directory in ['/opt',root,root+'/docker','/etc',etc,'/run','/run/lock']:
        metadata(directory,directory=True)
    config=root+'/docker/compose.yaml'
    metadata(config)
    metadata(etc+'/container.env',secret=True)
    metadata(etc+'/nginx-container.conf')
    lockpath='/run/lock/xian-oa-'+environment+'-docker.lock'
    metadata(lockpath)
    # Lock must be independently provisioned. Never create/write lock or marker files.
    fd=os.open(lockpath,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        require(os.fstat(fd).st_ino == os.lstat(lockpath).st_ino)
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        expected=TEMPLATES[environment].replace(BACKEND,backend).replace(FRONTEND,frontend)
        with open(config,'rb') as handle:
            require(handle.read(65537) == expected.encode('utf-8'))
        version=json.loads(run(['docker','version','--format','{{json .Server.Os}}']))
        require(version == 'linux')
        v=run(['docker','compose','version','--short']).strip().lstrip('v')
        m=re.fullmatch(r'(\\d+)\\.(\\d+)\\.(\\d+)(?:[-+][a-zA-Z0-9.-]+)?',v)
        require(m is not None and tuple(map(int,m.groups())) >= (2,30,0))
        # No automatic systemd stop, including activating/failed/unknown units.
        for unit in ['xian-oa-'+environment+'.service','xian-oa-'+environment+'-backend.service','xian-oa-'+environment+'-frontend.service']:
            state=run(['systemctl','show','--property=LoadState,ActiveState','--value',unit]).splitlines()
            require(len(state)==2 and 'loaded' in state and 'inactive' in state)
        desired=[backend,frontend]
        for ref in desired:
            images=json.loads(run(['docker','image','inspect',ref]))
            require(len(images)==1 and ref in images[0].get('RepoDigests',[]))
            require(re.fullmatch('sha256:[a-f0-9]{64}',images[0].get('Id','')) is not None)
        # Compose may resolve env_file internally; capture only in remote memory.
        # Explicit /dev/null disables implicit project .env discovery/interpolation.
        resolved=json.loads(run(['docker','compose','--project-directory',root+'/docker','--env-file','/dev/null','-p','xian-oa-'+environment,'-f',config,'config','--format','json']))
        services=resolved.get('services',{})
        require(set(services)=={'backend','frontend'})
        require(services['backend'].get('image')==backend and services['frontend'].get('image')==frontend)
        print(json.dumps({'schema':1,'status':'preflight-only','environment':environment,'head':head,
            'checks':{'linux':True,'compose':True,'metadata':True,'fixedTemplate':True,'imagesPresent':True,'composeImages':True,'legacyInactive':True}}))
    finally:
        os.close(fd)
try:
    main()
except Exception:
    print(json.dumps({'schema':1,'status':'rejected'}))
    sys.exit(1)
`;
const CHECKS = ['linux', 'compose', 'metadata', 'fixedTemplate', 'imagesPresent', 'composeImages', 'legacyInactive'];

/** Trusted internal capability, never an HTTP handler. Deliberately preflight-only.
 * exec/upload must be explicitly injected; no default SSH, shell or process runner.
 * Registry publication, provenance verification, one-use deployment markers, start,
 * container health/HTTP 2xx, acceptance and ingress cutover are NOT implemented.
 * Fixed template uses UID:GID 10001:10001 and requires separate approved provisioning.
 * command/env are reserved local capabilities, never used or forwarded by preflight.
 */
export function createDockerDelivery(options = {}) {
  plain(options, ['exec', 'upload', 'command', 'env']);
  const { exec, upload, command, env } = options;
  if (command !== undefined && typeof command !== 'function') throw new TypeError('command must be a function.');
  if (env !== undefined) plain(env, []);
  async function deliver(input) {
    if (typeof exec !== 'function' || typeof upload !== 'function') throw new Error('Delivery disabled: explicitly inject trusted exec and upload capabilities.');
    plain(input, ['environment', 'remote', 'artifact']);
    const { environment, remote, artifact } = input;
    if (environment !== 'dev' && environment !== 'test') throw new TypeError('Only dev/test app environments are allowed.');
    plain(remote, ['repository', 'branch', 'head', 'sourceOrigin']);
    if (remote.repository !== 'ssal-team/XiAN-OA' || remote.branch !== 'dev' || typeof remote.head !== 'string' || !SHA.test(remote.head) ||
        (remote.sourceOrigin !== undefined && remote.sourceOrigin !== 'github-remote-dev')) throw new TypeError('Expected fixed remote dev snapshot.');
    plain(artifact, ['head', 'backendImage', 'frontendImage', 'provenanceVerified']);
    if (artifact.head !== remote.head || artifact.provenanceVerified !== true) throw new TypeError('Trusted independently verified provenance matching remote HEAD is required.');
    const backend = image(artifact.backendImage), frontend = image(artifact.frontendImage);
    // Immutable local snapshots also prevent mutations across the async exec boundary.
    const head = remote.head;
    const commandText = `sudo -n /usr/bin/python3 -I - ${environment} ${head} ${backend} ${frontend} <<'XIAN_OA_PREFLIGHT_PY'\n${SCRIPT}XIAN_OA_PREFLIGHT_PY`;
    let response;
    try { response = await exec({ alias: 'xian-oa-test', command: commandText, timeoutMs: 180000 }); }
    catch { throw new Error('Remote preflight failed (details suppressed).'); }
    // Do not propagate tool stderr/stdout on failure: they may contain configuration.
    if (!response || !((response.code === 0) || (response.exitCode === 0)) ||
        (response.code !== undefined && response.code !== 0) || (response.exitCode !== undefined && response.exitCode !== 0) ||
        typeof response.stdout !== 'string' || response.stdout.length > 2048) throw new Error('Remote preflight failed (details suppressed).');
    let proof;
    try { proof = JSON.parse(response.stdout); } catch { throw new Error('Invalid preflight response.'); }
    plain(proof, ['schema', 'status', 'environment', 'head', 'checks']);
    plain(proof.checks, CHECKS);
    if (proof.schema !== 1 || proof.status !== 'preflight-only' || proof.environment !== environment || proof.head !== head || CHECKS.some(key => proof.checks[key] !== true)) throw new Error('Remote preflight did not verify all required checks.');
    return { status: 'preflight-only', deployable: false, delivered: false, verified: false, environment, head,
      preflightVerified: true, checks: { ...proof.checks },
      limitations: ['No registry publication or provenance attestation is performed.', 'Local build image IDs/tags are not promotable RepoDigests.',
        'No upload/save/load/pull/start/stop/migration/config write/ingress cutover is performed.',
        'No deployment marker is consumed; no container health, HTTP 2xx, database readiness or acceptance is verified.',
        'An independently approved preprovisioned exact template and lock are required; only existing digest images are checked.'] };
  }
  return Object.freeze({ deliver });
}
