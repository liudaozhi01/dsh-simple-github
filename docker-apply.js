import { createDockerReleasePreview } from './docker-release.js';

const SHA = /^[a-f0-9]{40}$(?![\s\S])/;
const JOB = /^[a-zA-Z0-9._:-]{1,128}$(?![\s\S])/;
const IMAGE = /^(?:(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)+)(?::[1-9][0-9]{0,4})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*@sha256:[a-f0-9]{64}$(?![\s\S])/;
const BACKEND = `xian-oa/backend@sha256:${'a'.repeat(64)}`;
const FRONTEND = `xian-oa/frontend@sha256:${'b'.repeat(64)}`;
const TEMPLATES = Object.fromEntries(['dev', 'test'].map(environment => {
  const preview = createDockerReleasePreview({ environment, head: '0'.repeat(40), fingerprint: '0'.repeat(64), backendImage: BACKEND, frontendImage: FRONTEND, uid: 10001, gid: 10001 });
  return [environment, { compose: preview.composeYaml, nginx: preview.nginxConf }];
}));
const FIELDS = ['jobId', 'environment', 'head', 'backendImage', 'frontendImage'];
const PROOF = ['schema', ...FIELDS, 'phase', 'backendHealthy', 'frontendHealthy', 'observedAt'];
const ERROR = 'Docker apply evidence unavailable (details suppressed; do not retry).';
function plain(value, keys) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(key => !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw new TypeError('Explicit trusted data fields required.');
}
function image(value) {
  if (typeof value !== 'string' || value.length > 512 || !IMAGE.test(value)) throw new TypeError('Immutable repository digest required.');
  const port = value.split('/')[0].split(':')[1];
  if (port && Number(port) > 65535) throw new TypeError('Invalid registry port.');
  return value;
}
function identity(input) {
  plain(input, FIELDS);
  if (typeof input.jobId !== 'string' || !JOB.test(input.jobId) || ['.', '..'].includes(input.jobId) || !['dev', 'test'].includes(input.environment) || typeof input.head !== 'string' || !SHA.test(input.head)) throw new TypeError('Complete trusted job identity required.');
  return Object.freeze({ jobId: input.jobId, environment: input.environment, head: input.head, backendImage: image(input.backendImage), frontendImage: image(input.frontendImage) });
}

// Static reviewed program: arguments are allowlisted tokens, never source code.
// No creation of configuration, lock, directory, image, ingress or systemd state.
const SCRIPT = `import os, sys, stat, json, subprocess, platform, fcntl, re, time, selectors, signal, urllib.request
TEMPLATES = json.loads(${JSON.stringify(JSON.stringify(TEMPLATES))})
BACKEND = ${JSON.stringify(BACKEND)}
FRONTEND = ${JSON.stringify(FRONTEND)}
LIMIT = 1048576
def require(ok):
    if not ok: raise RuntimeError('rejected')
def verify(fd, directory=False, private=False):
    s=os.fstat(fd)
    require(s.st_uid==0 and (stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode)))
    require(stat.S_IMODE(s.st_mode)==(0o700 if directory else 0o600) if private else s.st_mode & 0o022 == 0)
    if not directory: require(s.st_nlink==1)
    return fd
def directory(path, private=False):
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    verify(fd,True)
    for part in path.strip('/').split('/'):
        nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
        os.close(fd)
        verify(nxt,True)
        fd=nxt
    verify(fd,True,private)
    return fd
def filefd(parent,name,flags=os.O_RDONLY,public=False):
    fd=verify(os.open(name,flags|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent),False,not public)
    if public: require(stat.S_IMODE(os.fstat(fd).st_mode)==0o644)
    return fd
def readfd(fd,limit=65536):
    os.lseek(fd,0,os.SEEK_SET)
    data=os.read(fd,limit+1)
    require(len(data)<=limit)
    return data
def run(args):
    # Bound time AND capture while reading, not after an unbounded communicate().
    p=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
        cwd='/',env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/nonexistent','LANG':'C','LC_ALL':'C'},start_new_session=True)
    output=bytearray(); deadline=time.monotonic()+25
    selector=selectors.DefaultSelector(); selector.register(p.stdout,selectors.EVENT_READ)
    try:
        while selector.get_map():
            require(time.monotonic()<deadline)
            for key,_ in selector.select(min(0.25,max(0,deadline-time.monotonic()))):
                chunk=os.read(key.fileobj.fileno(),65536)
                if not chunk: selector.unregister(key.fileobj)
                else:
                    output.extend(chunk); require(len(output)<=LIMIT)
        require(p.wait(timeout=max(0.01,deadline-time.monotonic()))==0)
        return output.decode('utf-8')
    finally:
        selector.close(); p.stdout.close()
        if p.poll() is None:
            os.killpg(p.pid,signal.SIGKILL); p.wait()
def http(port,path):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs): return None
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    with opener.open('http://127.0.0.1:'+str(port)+path,timeout=4) as response:
        require(200<=response.status<300)
def main():
    require(os.geteuid()==0 and platform.system()=='Linux' and len(sys.argv)==8)
    mode,job,environment,head,backend,frontend,stamp=sys.argv[1:]
    require(mode in ('apply','query') and environment in ('dev','test'))
    require(re.fullmatch('[a-zA-Z0-9._:-]{1,128}',job) is not None and job not in ('.','..'))
    require(re.fullmatch('[a-f0-9]{40}',head) is not None and stamp.isdigit())
    require(all(re.fullmatch('[a-z0-9./:_-]+@sha256:[a-f0-9]{64}',v) for v in (backend,frontend)))
    root='/opt/xian-oa-'+environment+'/docker'; etc='/etc/xian-oa-'+environment
    dfd=directory(root,True); efd=directory(etc); mfd=directory(root+'/markers',True); ldir=directory('/run/lock')
    lock=filefd(ldir,'xian-oa-'+environment+'-docker.lock')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    config=filefd(dfd,'compose.yaml'); nginx=filefd(efd,'nginx-container.conf',public=True); secret=filefd(efd,'container.env')
    expected=TEMPLATES[environment]['compose'].replace(BACKEND,backend).replace(FRONTEND,frontend)
    require(readfd(config)==expected.encode('utf-8'))
    require(readfd(nginx)==TEMPLATES[environment]['nginx'].encode('utf-8'))
    # Secret is metadata-only: never read its contents or emit resolved compose config.
    require(json.loads(run(['docker','version','--format','{{json .Server.Os}}']))=='linux')
    version=run(['docker','compose','version','--short']).strip().lstrip('v')
    match=re.fullmatch(r'(\\d+)\\.(\\d+)\\.(\\d+)(?:[-+][a-zA-Z0-9.-]+)?',version)
    require(match is not None and tuple(map(int,match.groups()))>=(2,30,0))
    for unit in ['xian-oa-'+environment+'.service','xian-oa-'+environment+'-backend.service','xian-oa-'+environment+'-frontend.service']:
        state=run(['systemctl','show','--property=LoadState,ActiveState','--value',unit]).splitlines()
        require(len(state)==2 and set(state)=={'loaded','inactive'})
    ids={}
    for ref in (backend,frontend):
        images=json.loads(run(['docker','image','inspect',ref]))
        require(isinstance(images,list) and len(images)==1 and ref in images[0].get('RepoDigests',[]))
        imageid=images[0].get('Id',''); require(re.fullmatch('sha256:[a-f0-9]{64}',imageid) is not None)
        ids[ref]=imageid
    compose=['docker','compose','--project-directory',root,'--env-file','/dev/null','-p','xian-oa-'+environment,'-f',root+'/compose.yaml']
    # Protected directories are non-writable by any non-root actor; verify pinned files again before start.
    def stable():
        for parent,name,fd in [(dfd,'compose.yaml',config),(efd,'nginx-container.conf',nginx),(efd,'container.env',secret)]:
            current=filefd(parent,name,public=(name=='nginx-container.conf'))
            require((os.fstat(current).st_dev,os.fstat(current).st_ino)==(os.fstat(fd).st_dev,os.fstat(fd).st_ino))
            os.close(current)
        require(readfd(config)==expected.encode('utf-8') and readfd(nginx)==TEMPLATES[environment]['nginx'].encode('utf-8'))
    def health():
        try:
            raw=run(compose+['ps','--format','json'])
            try: rows=json.loads(raw)
            except ValueError: rows=[json.loads(line) for line in raw.splitlines() if line.strip()]
            if isinstance(rows,dict): rows=[rows]
            require(isinstance(rows,list) and len(rows)==2 and {r.get('Service') for r in rows}=={'backend','frontend'})
            result={}
            for row in rows:
                service=row['Service']; ref=backend if service=='backend' else frontend
                require(row.get('State')=='running' and re.fullmatch('[a-f0-9]{12,64}',row.get('ID','')) is not None)
                containers=json.loads(run(['docker','container','inspect',row['ID']]))
                require(isinstance(containers,list) and len(containers)==1)
                container=containers[0]
                require(container.get('State',{}).get('Running') is True and container.get('Image')==ids[ref] and container.get('Config',{}).get('Image')==ref)
                actual=json.loads(run(['docker','image','inspect',container['Image']]))
                require(len(actual)==1 and actual[0].get('Id')==ids[ref] and ref in actual[0].get('RepoDigests',[]))
                result[service]=True
            http(8082 if environment=='dev' else 8081,'/api/v1/health')
            http(28081 if environment=='dev' else 28080,'/')
            return True,True
        except Exception: return False,False
    base={'schema':1,'jobId':job,'environment':environment,'head':head,'backendImage':backend,'frontendImage':frontend}
    name=job+'.json' # Exact case retained; no normalization collisions, no path separators.
    def markerwrite(fd,phase):
        data=json.dumps(dict(base,phase=phase),separators=(',',':')).encode('utf-8')
        os.lseek(fd,0,os.SEEK_SET); os.ftruncate(fd,0)
        offset=0
        while offset<len(data):
            written=os.write(fd,data[offset:]); require(written>0); offset+=written
        os.fsync(fd); os.fsync(mfd)
    if mode=='query':
        try: marker=filefd(mfd,name)
        except FileNotFoundError: phase='absent'
        else:
            saved=json.loads(readfd(marker,4096)); os.close(marker)
            require(set(saved)==set(base)|{'phase'} and all(saved[k]==v for k,v in base.items()))
            phase=saved['phase']; require(phase in ('pending','failed','applied'))
        bh,fh=health()
    else:
        stable()
        # up can otherwise implicitly stop/recreate an existing container. Reject
        # any existing project container (including stopped ones), never replace.
        existing=run(compose+['ps','--all','--format','json']).strip()
        require(existing in ('','[]'))
        marker=verify(os.open(name,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=mfd),False,True)
        markerwrite(marker,'pending') # Durable one-use consumption before the sole start attempt.
        try:
            run(compose+['up','-d','--no-build','--pull','never','--no-recreate'])
            bh,fh=health(); require(bh and fh)
            markerwrite(marker,'applied'); phase='applied'
        except Exception:
            markerwrite(marker,'failed')
            raise
    print(json.dumps(dict(base,phase=phase,backendHealthy=bh,frontendHealthy=fh,observedAt=int(time.time()*1000))))
try:
    main()
except Exception:
    print('{"schema":1,"status":"rejected"}')
    sys.exit(1)
`;

/** Trusted internal only, never routed. Requires independently provisioned exact
 * per-release Compose/nginx and preloaded RepoDigests, root 0700 docker/markers,
 * root 0600 compose/env/lock; non-secret nginx config root 0644 for UID10001. Does NOT prepare config or offer general auto-deploy.
 * No pull/push/build/stop, retries, acceptance, ingress cutover or DB-ready claim.
 */
export function createDockerApply(options = {}) {
  plain(options, ['exec', 'now']);
  const { exec, now = Date.now } = options;
  if (typeof exec !== 'function' || typeof now !== 'function') throw new TypeError('Explicit trusted exec and clock required.');
  async function execute(mode, expected) {
    const stamp = now();
    if (!Number.isSafeInteger(stamp) || stamp < 0) throw new TypeError('Invalid trusted clock.');
    const command = `sudo -n /usr/bin/python3 -I - ${mode} ${expected.jobId} ${expected.environment} ${expected.head} ${expected.backendImage} ${expected.frontendImage} ${stamp} <<'XIAN_OA_APPLY_PY'\n${SCRIPT}XIAN_OA_APPLY_PY`;
    try {
      const response = await exec({ alias: 'xian-oa-test', command, timeoutMs: 180000 });
      if (!response || !(response.code === 0 || response.exitCode === 0) || (response.code !== undefined && response.code !== 0) || (response.exitCode !== undefined && response.exitCode !== 0) || typeof response.stdout !== 'string' || response.stdout.length > 4096) throw new Error();
      const proof = JSON.parse(response.stdout);
      plain(proof, PROOF);
      const time = now();
      if (Reflect.ownKeys(proof).length !== PROOF.length || proof.schema !== 1 || FIELDS.some(key => proof[key] !== expected[key]) || !['pending', 'failed', 'applied', 'absent'].includes(proof.phase) || typeof proof.backendHealthy !== 'boolean' || typeof proof.frontendHealthy !== 'boolean' || !Number.isSafeInteger(time) || !Number.isSafeInteger(proof.observedAt) || proof.observedAt < 0 || proof.observedAt > time || time - proof.observedAt > 30000) throw new Error();
      if (mode === 'apply' && (proof.phase !== 'applied' || !proof.backendHealthy || !proof.frontendHealthy)) throw new Error();
      return Object.freeze({ ...proof });
    } catch { throw new Error(ERROR); }
  }
  async function deliver(input) {
    plain(input, ['jobId', 'environment', 'remote', 'artifact']);
    plain(input.remote, ['repository', 'branch', 'head', 'sourceOrigin']);
    plain(input.artifact, ['head', 'backendImage', 'frontendImage', 'provenanceVerified']);
    const { remote, artifact } = input;
    if (remote.repository !== 'ssal-team/XiAN-OA' || remote.branch !== 'dev' || (remote.sourceOrigin !== undefined && remote.sourceOrigin !== 'github-remote-dev') || artifact.head !== remote.head || artifact.provenanceVerified !== true) throw new TypeError('Trusted fixed remote dev provenance required.');
    const expected = identity({ jobId: input.jobId, environment: input.environment, head: remote.head, backendImage: artifact.backendImage, frontendImage: artifact.frontendImage });
    const proof = await execute('apply', expected);
    return Object.freeze({ status: 'delivered', delivered: true, healthy: true, ...expected, observedAt: proof.observedAt, accepted: false, retryAllowed: false });
  }
  async function query(input) { return execute('query', identity(input)); }
  return Object.freeze({ deliver, query });
}
