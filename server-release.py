#!/usr/bin/python3
"""Fixed, offline-reviewable server entry. No installation or deployment on import.
Installed entry: /usr/local/libexec/xian-oa-release.py (root-owned, not writable).
See server-release-README.md for the deliberately manual provisioning contract.
"""
import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import stat
import subprocess
import sys
import time

CONFIG = Path('/etc/xian-oa-release.json')
ENTRY = Path('/usr/local/libexec/xian-oa-release.py')
REPOSITORY = 'https://github.com/ssal-team/XiAN-OA.git'
ROOTS = {e: Path('/opt/xian-oa-' + e + '-docker') for e in ('dev', 'test')}
ID = re.compile(r'[a-f0-9]{32}\Z')
SHA = re.compile(r'[a-f0-9]{40}\Z')
IMAGE = re.compile(r'sha256:[a-f0-9]{64}\Z')
PIN = re.compile(r'[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}\Z')
OVERRIDE_HEADER = '# xian-oa-release managed images only\n'

class Refused(Exception):
    pass

def require(ok, message):
    if not ok:
        raise Refused(message)

def obj(value, keys, required=()):
    require(type(value) is dict and set(value) <= set(keys) and set(required) <= set(value), 'Invalid object fields')
    return value

def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON field')
        result[key] = value
    return result

def loads(text):
    return json.loads(text, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(Refused('Invalid JSON number')))

def identifier(value):
    require(type(value) is str and ID.fullmatch(value), 'Invalid identifier')
    return value

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def secure(path, directory=False):
    """Reject symlinks and writable ancestors, including config/entry parents."""
    path = Path(path)
    require(path.is_absolute(), 'Absolute configured path required')
    for item in reversed((path, *path.parents)):
        st = item.lstat()
        require(not stat.S_ISLNK(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022, 'Unsafe ownership or permissions')
    require(path.is_dir() if directory else path.is_file(), 'Unexpected file type')
    return path

def atomic(path, value, raw=False):
    path = Path(path)
    temporary = path.with_name('.' + path.name + '.' + secrets.token_hex(8))
    data = value if raw else json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        if temporary.exists():
            temporary.unlink()

class Release:
    def __init__(self):
        require(os.geteuid() == 0, 'Root fixed entry required')
        secure(ENTRY)
        self.config = loads(secure(CONFIG).read_text())
        obj(self.config, ['stateRoot', 'workRoot', 'allowedUnixUsers', 'baseImages', 'git', 'docker'], ['stateRoot', 'workRoot', 'allowedUnixUsers', 'baseImages', 'git', 'docker'])
        self.state = secure(self.config['stateRoot'], True)
        self.work = secure(self.config['workRoot'], True)
        require(stat.S_IMODE(self.state.stat().st_mode) == 0o700 and stat.S_IMODE(self.work.stat().st_mode) == 0o700, 'Private state/work directories (0700) required')
        docker_config = secure(self.state / 'docker-config', True)
        require(not any(docker_config.iterdir()), 'Dedicated empty Docker config required; no registry credentials')
        require(self.state != self.work and self.state not in self.work.parents and self.work not in self.state.parents, 'Separate state/work required')
        require(self.work not in (Path('/'), Path('/opt'), Path('/tmp')), 'Dedicated work root required')
        obj(self.config['baseImages'], ['node', 'mavenJava21', 'java', 'nginx'], ['node', 'mavenJava21', 'java', 'nginx'])
        for image in self.config['baseImages'].values():
            require(type(image) is str and len(image) <= 512 and PIN.fullmatch(image), 'Reviewed pinned base images required')
        obj(self.config['allowedUnixUsers'], ['dev', 'test'], ['dev', 'test'])
        for users in self.config['allowedUnixUsers'].values():
            require(type(users) is list and all(type(u) is str and re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', u) for u in users), 'Invalid server ACL')
        for tool in ('git', 'docker'):
            secure(self.config[tool])
        self.user = os.environ.get('SUDO_USER', '')
        uid = os.environ.get('SUDO_UID', '')
        require(self.user and uid.isdecimal() and pwd.getpwnam(self.user).pw_uid == int(uid), 'Verified sudo Unix identity required')
        self.env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(self.state), 'DOCKER_CONFIG': str(self.state / 'docker-config'), 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': '/bin/false'}

    def authorize(self, environment):
        require(environment in ROOTS and self.user in self.config['allowedUnixUsers'][environment], 'Server Unix user not authorized')

    @contextlib.contextmanager
    def lock(self, name, blocking=True):
        fd = os.open(self.state / (name + '.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            yield
        except BlockingIOError:
            raise Refused('Another job owns this environment')
        finally:
            os.close(fd)

    def get(self, kind, key):
        return loads(secure(self.state / (kind + '-' + identifier(key) + '.json')).read_text())

    def put(self, kind, key, data):
        atomic(self.state / (kind + '-' + identifier(key) + '.json'), data)

    def run(self, argv, cwd=None, extra=None, timeout=120):
        env = dict(self.env)
        env.update(extra or {})
        # No shell, caller environment, credential forwarding, or source scripts on host.
        with __import__('tempfile').TemporaryFile() as output:
            try:
                result = subprocess.run(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, timeout=timeout, check=False)
            except subprocess.TimeoutExpired:
                raise Refused('Server command timed out; inspect status')
            require(result.returncode == 0, 'Server command failed (output withheld; no business secrets exposed)')
            size = output.tell()
            require(size <= 8 * 1024 * 1024, 'Server command output too large')
            output.seek(0)
            return output.read().decode('utf-8')

    def git(self, args, cwd=None):
        return self.run([self.config['git'], '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'credential.helper=', *args], cwd=cwd)

    @contextlib.contextmanager
    def checkout(self, key, head=None):
        identifier(key)
        path = self.work / ('source-' + key)
        # A preexisting directory is never adopted or removed.
        path.mkdir(mode=0o700)
        identity = path.stat()
        marker = secrets.token_hex(32)
        atomic(path / '.release-owner', {'id': key, 'nonce': marker})
        try:
            self.git(['init', '--quiet', str(path / 'repo')])
            repo = path / 'repo'
            self.git(['fetch', '--no-tags', '--depth=1', REPOSITORY, 'refs/heads/dev'], repo)
            fetched = self.git(['rev-parse', 'FETCH_HEAD'], repo).strip()
            require(SHA.fullmatch(fetched), 'Invalid remote SHA')
            if head is not None:
                require(fetched == head, 'Remote dev changed; create a new plan')
                self.git(['checkout', '--detach', '--force', fetched], repo)
                require(self.git(['rev-parse', 'HEAD'], repo).strip() == head, 'Checkout SHA mismatch')
                require(not self.git(['status', '--porcelain', '--untracked-files=all'], repo).strip(), 'Checkout not clean')
            yield repo, fetched
        finally:
            # Resolve and inspect exact task root BEFORE recursive deletion. Hold the
            # environment/operation lock throughout. Never delete repo-external paths.
            require(path.parent.resolve() == self.work.resolve() and path.name == 'source-' + key and not path.is_symlink(), 'Cleanup identity mismatch')
            secure(path, True)
            observed_identity = path.stat()
            require((identity.st_dev, identity.st_ino) == (observed_identity.st_dev, observed_identity.st_ino), 'Cleanup directory replaced')
            require(loads(secure(path / '.release-owner').read_text()) == {'id': key, 'nonce': marker}, 'Cleanup marker mismatch')
            shutil.rmtree(path)

    def compose(self, environment, args, images=None, override=False):
        root = ROOTS[environment]
        secure(root, True)
        secure(root / 'compose.yaml')
        command = [self.config['docker'], 'compose', '--project-directory', str(root), '-p', 'xian-oa-' + environment, '-f', str(root / 'compose.yaml')]
        if override:
            secure(root / 'compose.override.yaml')
            command += ['-f', str(root / 'compose.override.yaml')]
        extra = {'API_IMAGE': images['api'], 'WEB_IMAGE': images['web']} if images else {}
        return self.run([*command, *args], cwd=root, extra=extra, timeout=180)

    def config_snapshot(self, environment, images=None, override=False):
        value = loads(self.compose(environment, ['config', '--format', 'json'], images, override))
        require(set(value.get('services', {})) == {'api', 'web', 'db'}, 'Unexpected compose service set')
        # Existing mounts must not shadow the new application artifacts.
        require(not value['services']['api'].get('volumes'), 'API artifact mounts need separate manual review')
        root = ROOTS[environment]
        mounts = value['services']['web'].get('volumes', [])
        require(len(mounts) == 1 and mounts[0].get('type') == 'bind' and mounts[0].get('source') == str(root / 'nginx.conf') and mounts[0].get('target') == '/etc/nginx/conf.d/default.conf' and mounts[0].get('read_only') is True, 'Unexpected web mounts')
        return value

    def active_override(self, environment):
        root = ROOTS[environment]
        for name in ('compose.override.yml', 'docker-compose.override.yml', 'docker-compose.override.yaml'):
            require(not (root / name).exists(), 'Unreviewed alternate override')
        path = root / 'compose.override.yaml'
        if not path.exists():
            require(not path.is_symlink(), 'Unsafe override symlink')
            return False
        content = secure(path).read_text()
        require(re.fullmatch(re.escape(OVERRIDE_HEADER) + r'services:\n  api:\n    image: sha256:[a-f0-9]{64}\n  web:\n    image: sha256:[a-f0-9]{64}\n', content), 'Existing override is not release-managed images only')
        return True

    def inspect_images(self, images):
        require(type(images) is dict and set(images) == {'api', 'web'} and all(type(x) is str and IMAGE.fullmatch(x) for x in images.values()), 'Local image IDs required')
        for image in images.values():
            require(self.run([self.config['docker'], 'image', 'inspect', '--format', '{{.Id}}', image]).strip() == image, 'Local image ID not available')

    def observe(self, environment):
        result = {}
        for service in ('api', 'web', 'db'):
            ids = self.compose(environment, ['ps', '-q', service]).split()
            require(len(ids) == 1, 'Expected one existing container per service')
            rows = loads(self.run([self.config['docker'], 'inspect', ids[0]]))
            require(type(rows) is list and len(rows) == 1, 'Invalid container inspect')
            row = rows[0]
            labels = row.get('Config', {}).get('Labels', {})
            require(labels.get('com.docker.compose.project') == 'xian-oa-' + environment and labels.get('com.docker.compose.service') == service, 'Container project identity mismatch')
            result[service] = {'containerId': row['Id'], 'imageId': row['Image'], 'healthy': row.get('State', {}).get('Running') is True and row.get('State', {}).get('Health', {}).get('Status') == 'healthy'}
        return result

    def check(self, body):
        obj(body, ['environment'])
        environment = body.get('environment', 'dev')
        require(environment == 'dev', 'Test requires promote of an accepted dev release')
        self.authorize(environment)
        key = secrets.token_hex(16)
        with self.lock('operation-dev'):
            with self.checkout(key) as (_, head):
                return self.plan(key, environment, head)

    def plan(self, key, environment, head, images=None, release=None):
        override = self.active_override(environment)
        config = self.config_snapshot(environment, override=override)
        observed = self.observe(environment)
        require(all(x['healthy'] for x in observed.values()), 'Existing services must be healthy')
        value = {'planId': key, 'environment': environment, 'remote': {'repository': REPOSITORY, 'branch': 'dev', 'head': head}, 'expiresAt': int(time.time()) + 300, 'actor': self.user, 'fingerprint': digest(config), 'previous': observed, 'images': images, 'sourceReleaseId': release}
        self.put('plan', key, value)
        return {k: value[k] for k in ('planId', 'environment', 'remote', 'expiresAt')}

    def promote(self, body):
        obj(body, ['releaseId'], ['releaseId'])
        self.authorize('test')
        release = self.get('release', body['releaseId'])
        require(release['environment'] == 'dev' and release['accepted'] is True, 'Accepted dev release required')
        self.inspect_images(release['images'])
        with self.lock('operation-test'):
            return self.plan(secrets.token_hex(16), 'test', release['head'], release['images'], body['releaseId'])

    def start(self, body):
        obj(body, ['planId', 'confirmation', 'databaseRiskAccepted'], ['planId', 'confirmation', 'databaseRiskAccepted'])
        require(body['confirmation'] is True and body['databaseRiskAccepted'] is True, 'Explicit confirmation and database risk acknowledgement required')
        key = identifier(body['planId'])
        with self.lock('plans'):
            plan = self.get('plan', key)
            self.authorize(plan['environment'])
            require(plan['actor'] == self.user, 'Plan belongs to another server identity')
            if plan.get('jobId'):
                job = self.get('job', plan['jobId'])
                return self.public_job(job)
            require(time.time() <= plan['expiresAt'], 'Plan expired')
            # Persist before spawn. A crash here leaves a pending record, never a
            # duplicate deployment; reconcile is read-only, recovery is manual.
            with self.lock('operation-' + plan['environment'], blocking=False):
                for path in self.state.glob('job-*.json'):
                    old = loads(secure(path).read_text())
                    require(old['environment'] != plan['environment'] or old['status'] in ('accepted', 'failed') or (old['environment'] == 'test' and old['status'] == 'ready'), 'Unresolved job blocks new deployment')
                job_id = secrets.token_hex(16)
                token = secrets.token_hex(32)
                job = {'jobId': job_id, 'planId': key, 'environment': plan['environment'], 'actor': self.user, 'status': 'pending', 'stage': 'queued', 'createdAt': int(time.time()), 'workerToken': token}
                self.put('job', job_id, job)
                plan['jobId'] = job_id
                self.put('plan', key, plan)
                self.spawn(job_id, token)
            return self.public_job(job)

    def spawn(self, job_id, token):
        subprocess.Popen(['/usr/bin/python3', '-I', str(ENTRY), '--worker', job_id, token], env={**self.env, 'SUDO_USER': self.user, 'SUDO_UID': str(pwd.getpwnam(self.user).pw_uid)}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)

    def build(self, repo, head, job_id):
        require((repo / 'backend/pom.xml').is_file() and (repo / 'package-lock.json').is_file(), 'Expected backend Maven and root npm layout required')
        # Exclude all tracked secret/config files from build context, including
        # malicious symlink paths. Server deployment roots never enter context.
        for path in repo.rglob('*'):
            require(not path.is_symlink(), 'Symlinks in build context require manual review')
        bases = self.config['baseImages']
        backend = f'FROM {bases["mavenJava21"]} AS build\nWORKDIR /src\nCOPY backend/ ./\nRUN mvn -B package\nRUN set -eu; set -- target/*.jar; test "$#" -eq 1; cp "$1" /app.jar\nFROM {bases["java"]}\nLABEL org.opencontainers.image.revision="{head}"\nWORKDIR /app\nCOPY --from=build --chown=10001:10001 /app.jar /app/app.jar\nUSER 10001:10001\nENTRYPOINT ["java","-jar","/app/app.jar"]\n'
        frontend = f'FROM {bases["node"]} AS build\nWORKDIR /src\nCOPY . .\nRUN npm ci && npm run build\nFROM {bases["nginx"]}\nLABEL org.opencontainers.image.revision="{head}"\nCOPY --from=build /src/dist/ /usr/share/nginx/html/\n'
        # Never run repository Dockerfiles or host scripts. npm/Maven run only
        # within reviewed, digest-pinned multi-stage build containers.
        (repo / '.dockerignore').write_text('.git\n**/.git\n**/node_modules\n**/target\ndist\n**/.env\n**/.env.*\n**/*.env\n**/.npmrc\n**/settings.xml\n**/*.pem\n**/*.key\n')
        images = {}
        for service, text in (('api', backend), ('web', frontend)):
            dockerfile = repo / ('Release.' + service + '.Dockerfile')
            dockerfile.write_text(text)
            iid = repo.parent / (service + '.iid')
            # Permanent per-job tags protect rollback images from dangling-image cleanup.
            tag = 'xian-oa-release-' + service + ':' + identifier(job_id)
            self.run([self.config['docker'], 'build', '--pull=false', '--network=default', '--tag', tag, '--iidfile', str(iid), '-f', str(dockerfile), str(repo)], timeout=3600)
            images[service] = iid.read_text().strip()
        self.inspect_images(images)
        return images

    def worker(self, key, token):
        job = self.get('job', key)
        require(secrets.compare_digest(job.get('workerToken', ''), token) and job['status'] == 'pending', 'Invalid worker claim')
        self.authorize(job['environment'])
        require(job['actor'] == self.user, 'Worker identity mismatch')
        with self.lock('operation-' + job['environment']):
            job = self.get('job', key)
            require(job['status'] == 'pending', 'Job already claimed')
            plan = self.get('plan', job['planId'])
            try:
                job.update(status='running', stage='preflight', workerPid=os.getpid())
                self.put('job', key, job)
                require(time.time() <= plan['expiresAt'], 'Plan expired before worker start')
                environment = plan['environment']
                override = self.active_override(environment)
                current = self.config_snapshot(environment, override=override)
                require(digest(current) == plan['fingerprint'] and self.observe(environment) == plan['previous'], 'Compose or containers changed since plan')
                if environment == 'dev':
                    job['stage'] = 'building'
                    self.put('job', key, job)
                    with self.checkout(key, plan['remote']['head']) as (repo, _):
                        images = self.build(repo, plan['remote']['head'], key)
                else:
                    accepted = self.get('release', plan['sourceReleaseId'])
                    require(accepted['accepted'] is True and accepted['environment'] == 'dev' and accepted['images'] == plan['images'], 'Promotion source mismatch')
                    images = plan['images']
                    self.inspect_images(images)
                require(digest(self.config_snapshot(environment, override=override)) == plan['fingerprint'] and self.observe(environment) == plan['previous'], 'Deployment changed during build')
                # Durable intent, previous IDs, config fingerprint and marker precede
                # the first deployment mutation. No automatic rollback on any failure.
                job.update(stage='applying', previous=plan['previous'], fingerprint=plan['fingerprint'], images=images, head=plan['remote']['head'], marker=secrets.token_hex(16))
                self.put('job', key, job)
                text = OVERRIDE_HEADER + 'services:\n  api:\n    image: ' + images['api'] + '\n  web:\n    image: ' + images['web'] + '\n'
                atomic(ROOTS[environment] / 'compose.override.yaml', text, raw=True)
                candidate = self.config_snapshot(environment, images, True)
                baseline = json.loads(json.dumps(current))
                for service in ('api', 'web'):
                    baseline['services'][service]['image'] = images[service]
                require(candidate == baseline, 'Override changed non-image compose configuration')
                job['appliedFingerprint'] = digest(candidate)
                self.put('job', key, job)
                self.compose(environment, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api', 'web'], images, True)
                job['stage'] = 'health'
                self.put('job', key, job)
                deadline = time.monotonic() + 180
                while True:
                    try:
                        observed = self.observe(environment)
                        if self.matches(job, observed):
                            break
                    except Refused:
                        # Containers can be temporarily absent/restarting after up.
                        # Never replay up; only bounded read-only observation.
                        pass
                    require(time.monotonic() < deadline, 'Health or image identity verification timed out')
                    time.sleep(2)
                job.update(status='ready', stage='awaiting-acceptance', observed=observed)
                self.put('job', key, job)
            except Exception:
                # Do not leak command output, config, credentials or source content.
                job.update(status='uncertain' if job.get('stage') in ('applying', 'health') else 'failed', error='Server operation failed; inspect read-only reconcile and server diagnostics', finishedAt=int(time.time()))
                self.put('job', key, job)

    @staticmethod
    def matches(job, observed):
        return all(observed[s]['healthy'] and observed[s]['imageId'] == job['images'][s] for s in ('api', 'web')) and observed['db'] == job['previous']['db']

    def status(self, body):
        obj(body, ['jobId'])
        if 'jobId' in body:
            job = self.get('job', body['jobId'])
            self.authorize(job['environment'])
            return self.public_job(job)
        values = []
        for path in self.state.glob('job-*.json'):
            job = loads(secure(path).read_text())
            if self.user in self.config['allowedUnixUsers'][job['environment']]:
                values.append(job)
        values.sort(key=lambda j: j['createdAt'], reverse=True)
        return self.public_job(values[0]) if values else {'status': 'idle'}

    @staticmethod
    def public_job(job):
        keys = ('jobId', 'environment', 'stage', 'createdAt', 'head', 'images', 'releaseId', 'error')
        result = {k: job[k] for k in keys if k in job}
        result['status'] = 'delivered' if job['status'] in ('ready', 'accepted') else job['status']
        result['accepted'] = job['status'] == 'accepted'
        if job['status'] == 'uncertain':
            result['errorCode'] = 'DELIVERY_UNCERTAIN'
        return result

    def reconcile(self, body):
        obj(body, ['jobId'], ['jobId'])
        job = self.get('job', body['jobId'])
        self.authorize(job['environment'])
        observed = self.observe(job['environment'])
        override = self.active_override(job['environment'])
        config = self.config_snapshot(job['environment'], override=override)
        return {**self.public_job(job), 'observed': observed, 'matchesRecordedImages': self.matches(job, observed) if job.get('images') and job.get('previous') else False, 'matchesRecordedCompose': digest(config) == job.get('appliedFingerprint'), 'readOnly': True}

    def accept(self, body):
        obj(body, ['jobId', 'confirmation'], ['jobId', 'confirmation'])
        require(body['confirmation'] is True, 'Explicit acceptance required')
        key = identifier(body['jobId'])
        job = self.get('job', key)
        self.authorize(job['environment'])
        with self.lock('operation-' + job['environment']):
            job = self.get('job', key)
            require(job['status'] in ('ready', 'accepted'), 'Only a healthy ready job can be accepted')
            result = self.reconcile({'jobId': key})
            require(result['matchesRecordedImages'] and result['matchesRecordedCompose'], 'Acceptance state drift')
            # Deterministic release ID makes acceptance crash-safe and idempotent.
            self.put('release', key, {'releaseId': key, 'environment': job['environment'], 'accepted': True, 'images': job['images'], 'head': job['head'], 'jobId': key, 'acceptedByUnixUser': self.user})
            job.update(status='accepted', releaseId=key)
            self.put('job', key, job)
            return self.public_job(job)

    def dispatch(self, request):
        obj(request, ['action', 'body'], ['action', 'body'])
        require(type(request['action']) is str and request['action'] in ('check', 'promote', 'start', 'status', 'accept', 'reconcile'), 'Unknown fixed action')
        require(type(request['body']) is dict, 'Object body required')
        return getattr(self, request['action'])(request['body'])

def main():
    try:
        service = Release()
        if len(sys.argv) == 4 and sys.argv[1] == '--worker':
            service.worker(identifier(sys.argv[2]), sys.argv[3])
            return
        require(len(sys.argv) == 2 and len(sys.argv[1]) <= 16384, 'One base64 JSON argument required')
        data = base64.b64decode(sys.argv[1], validate=True)
        require(len(data) <= 8192, 'Request too large')
        result = service.dispatch(loads(data.decode('utf-8')))
        require(type(result) is dict, 'Object response required')
        output = json.dumps(result, separators=(',', ':'))
        require(len(output.encode()) < 65536, 'Response too large')
        print(output)
    except Exception as error:
        message = str(error) if isinstance(error, Refused) else 'Fixed release entry refused request; inspect server configuration'
        print(json.dumps({'error': message}, separators=(',', ':')))
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
