#!/usr/bin/python3
"""Ephemeral root entry: sudo python3 -I /var/tmp/dsh-release-UUID/script.py BASE64.
Trusted profile is selected locally by operator; never accept arbitrary UI profiles.
No import of installed server modules, Git access, or fixed server config.
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
import tarfile
import tempfile
import uuid

ID = re.compile(r'[a-f0-9]{32}\Z')
SHA = re.compile(r'[a-f0-9]{40}\Z')
IMAGE = re.compile(r'sha256:[a-f0-9]{64}\Z')
PIN = re.compile(r'[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}\Z')
OVERRIDE_HEADER = '# xian-oa-release managed images only\n'

class Refused(Exception):
    pass

def failure_details(text):
    """Only publish recognized structural errors, never arbitrary log lines/SQL."""
    patterns = (
        r'预设超管初始化冲突：admin账号已绑定其他人员，请人工核对，不会自动换绑',
        r"Referencing column '[A-Za-z0-9_]+' and referenced column '[A-Za-z0-9_]+' in foreign key constraint '[A-Za-z0-9_]+' are incompatible\.",
        r'dependency failed to start: container [A-Za-z0-9_.-]+ is unhealthy',
        r'Bind for (?:[0-9.]+:)?[0-9]+ failed: port is already allocated',
    )
    # Build logs can echo source, command arguments, registry URLs and secrets.
    # Keep only constrained locations/codes and fixed descriptions, not messages.
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    details = [match.group(0) for pattern in patterns for match in re.finditer(pattern, text)]
    path = r'(?:[A-Za-z0-9_-]{1,80}/){0,20}[A-Za-z0-9_.-]{1,100}'
    ts_descriptions = {'2307': 'Cannot find module', '7006': 'Parameter implicitly has an any type'}
    for match in re.finditer(r'(?<![A-Za-z0-9_./-])(' + path + r'\.(?:tsx?|jsx?))\(([0-9]{1,6}),([0-9]{1,6})\): error TS([0-9]{4,5})\b', text):
        location, line, column, code = match.groups()
        detail = f'{location}({line},{column}): error TS{code}'
        if code in ts_descriptions:
            detail += ': ' + ts_descriptions[code]
        details.append(detail)
    for match in re.finditer(r'(?<![A-Za-z0-9_./-])(/?' + path + r'\.java):\[([0-9]{1,6}),([0-9]{1,6})\]\s+(cannot find symbol|package [A-Za-z0-9_.]{1,150} does not exist|incompatible types|illegal start of expression|reached end of file while parsing)\b', text):
        details.append(f'{match[1]}:[{match[2]},{match[3]}] {match[4]}')
    for match in re.finditer(r'\bnpm (?:ERR!|error) code (ERESOLVE|EUSAGE|ENOENT|EACCES|EPERM|ENOSPC|ENOMEM|EINTEGRITY|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|E401|E403|E404|ELIFECYCLE)\b', text):
        details.append('npm error code ' + match[1])
    for pattern in (r'\bCOMPILATION (?:ERROR|FAILURE)\b', r'\bno space left on device\b',
                    r'\bCannot connect to the Docker daemon\b', r'\bfailed to solve\b',
                    r'\bServer command timed out; inspect status\b'):
        details.extend(match.group(0) for match in re.finditer(pattern, text))
    return list(dict.fromkeys(details))[:4]


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

def process_identity(pid):
    """Linux PID identity only; never inspect command lines or worker arguments.

    None proves the PID absent. Unavailable/malformed proc evidence raises and
    must remain unknown, not be confused with a dead worker.
    """
    require(type(pid) is int and pid > 0, 'Invalid worker PID')
    try:
        text = Path('/proc').joinpath(str(pid), 'stat').read_text()
    except FileNotFoundError:
        # A missing proc mount is not evidence that a particular PID is gone.
        require(Path('/proc/self/stat').is_file(), 'Process evidence unavailable')
        return None
    # comm may contain spaces and parentheses; field 22 is index 19 after comm.
    fields = text.rsplit(')', 1)[1].split()
    require(text.split(' ', 1)[0] == str(pid) and len(fields) >= 20 and fields[19].isdecimal(), 'Invalid process evidence')
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    require(re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', boot), 'Invalid boot evidence')
    return {'bootId': boot, 'startTime': fields[19]}


def opt_root(value):
    require(type(value) is str and re.fullmatch(r'/opt/[A-Za-z0-9_/-]+', value), 'Controlled absolute /opt path required')
    p = Path(value)
    require(str(p) == value and '..' not in p.parts and len(p.parts) >= 3, 'Noncanonical /opt path')
    return p


def validate_profile(profile):
    keys = ['repository', 'branch', 'target', 'roots', 'projects', 'baseImages', 'stateRoot', 'allowedNames']
    obj(profile, keys, keys)
    require(type(profile['repository']) is str and re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', profile['repository']) and not profile['repository'].endswith('.git'), 'GitHub owner/repository slug required')
    target = obj(profile['target'], ['alias', 'host', 'user', 'port'], ['alias', 'host', 'user', 'port'])
    require(type(target['alias']) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', target['alias']), 'Invalid SSH alias')
    require(type(target['host']) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.:-]*', target['host']), 'Invalid SSH host')
    require(type(target['user']) is str and re.fullmatch(r'[a-z_][a-z0-9_-]*', target['user']), 'Invalid SSH user')
    require(type(target['port']) is int and 1 <= target['port'] <= 65535, 'Invalid SSH port')
    obj(profile['allowedNames'], ['dev', 'test'], ['dev', 'test'])
    for names in profile['allowedNames'].values():
        require(type(names) is list and 1 <= len(names) <= 32 and all(type(n) is str and n and n == n.strip() and len(n) <= 100 and not any(ord(c) < 32 or ord(c) == 127 for c in n) for n in names) and len(set(names)) == len(names), 'Invalid display-name authorization list')
    require(type(profile['branch']) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./-]{0,199}', profile['branch']) and '..' not in profile['branch'] and not profile['branch'].endswith('/'), 'Invalid branch')
    obj(profile['roots'], ['dev', 'test'], ['dev', 'test'])
    obj(profile['projects'], ['dev', 'test'], ['dev', 'test'])
    state = profile['stateRoot']
    require(type(state) is str and re.fullmatch(r'/(?:opt|var/lib)/[A-Za-z0-9_/-]+', state) and str(Path(state)) == state and all(p not in ('.', '..') for p in state.split('/')), 'Controlled private state path required')
    paths = [opt_root(v) for v in profile['roots'].values()] + [Path(state)]
    require(all(a != b and a not in b.parents and b not in a.parents for n, a in enumerate(paths) for b in paths[n+1:]), 'Separate state and deployment roots required')
    require(all(type(v) is str and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,62}', v) for v in profile['projects'].values()) and len(set(profile['projects'].values())) == 2, 'Distinct controlled Compose projects required')
    obj(profile['baseImages'], ['node', 'mavenJava21', 'java', 'nginx'], ['node', 'mavenJava21', 'java', 'nginx'])
    require(all(type(v) is str and len(v) <= 512 and PIN.fullmatch(v) for v in profile['baseImages'].values()), 'Digest-pinned base images required')
    return profile


def validate_stage(entry):
    stage = entry.parent
    require(stage.parent == Path('/var/tmp') and re.fullmatch(r'dsh-release-[a-f0-9-]{36}', stage.name) and entry.name == 'script.py', 'Dedicated temporary stage required')
    uuid.UUID(stage.name[len('dsh-release-'):])
    for p, mode, directory in ((stage, 0o700, True), (entry, 0o600, False)):
        st = p.lstat()
        require(st.st_uid == 0 and stat.S_IMODE(st.st_mode) == mode and (stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode)), 'Root-owned private temporary stage required')
    require(not stage.is_symlink() and not entry.is_symlink(), 'No temporary symlinks')
    return stage


def verify_bundle(bundle, stage):
    obj(bundle, ['path', 'sha256', 'size'], ['path', 'sha256', 'size'])
    require(bundle['path'] == str(stage / 'archive.tar.gz'), 'Bundle must be owned stage archive.tar.gz')
    require(type(bundle['sha256']) is str and re.fullmatch(r'[a-f0-9]{64}', bundle['sha256']), 'Invalid bundle SHA256')
    require(type(bundle['size']) is int and 0 < bundle['size'] <= 256 * 1024 * 1024, 'Bundle size out of bounds')
    path = Path(bundle['path'])
    st = path.lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == 0 and stat.S_IMODE(st.st_mode) == 0o600 and st.st_size == bundle['size'], 'Unsafe bundle file or size mismatch')
    with path.open('rb') as stream:
        require(stream.read(2) == b'\x1f\x8b', 'Gzip archive required')
        stream.seek(0)
        sha = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            sha.update(chunk)
    require(sha.hexdigest() == bundle['sha256'], 'Bundle SHA256 mismatch')


def extract_bundle(archive, destination):
    # Manual extraction: no links, special files, duplicates or unsafe paths.
    prefix = None
    seen = set()
    total = 0
    with tarfile.open(archive, 'r:gz') as tar:
        for count, member in enumerate(tar, 1):
            require(count <= 100000, 'Too many archive entries')
            name = member.name.rstrip('/')
            parts = name.split('/')
            require(name and not name.startswith('/') and len(name) <= 1024 and all(p not in ('', '.', '..') for p in parts) and '\\' not in name and all(ord(c) >= 32 for c in name), 'Unsafe archive path')
            require(member.isdir() or member.isfile(), 'Archive links and devices forbidden')
            if prefix is None:
                prefix = parts[0]
            require(parts[0] == prefix, 'Single GitHub archive prefix required')
            if len(parts) == 1:
                require(member.isdir(), 'Archive prefix must be directory')
                continue
            relative = '/'.join(parts[1:])
            require(relative not in seen, 'Duplicate archive entry')
            seen.add(relative)
            require(not any(p in ('.git', '.ssh', 'node_modules', 'target') or p == '.env' or p.startswith('.env.') or p in ('.npmrc', 'settings.xml') or p.endswith(('.pem', '.key', '.env')) for p in parts[1:]), 'Secret or generated paths forbidden in archive')
            target = destination.joinpath(*parts[1:])
            require(destination.resolve() in target.resolve().parents, 'Extraction escaped destination')
            if member.isdir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
                continue
            require(0 <= member.size <= 64 * 1024 * 1024, 'Archive member too large')
            total += member.size
            require(total <= 1024 * 1024 * 1024, 'Expanded archive too large')
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            source = tar.extractfile(member)
            require(source is not None, 'Archive member missing')
            with source, target.open('xb') as output:
                remaining = member.size
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    require(chunk, 'Truncated archive member')
                    output.write(chunk)
                    remaining -= len(chunk)
            target.chmod(0o700 if member.mode & 0o111 else 0o600)
    require(prefix is not None, 'Empty archive')


class Release:
    def __init__(self, profile):
        require(os.geteuid() == 0, 'Root temporary entry required')
        self.entry = Path(__file__).absolute()
        self.stage = validate_stage(self.entry)
        self.stage_identity = self.stage.stat()
        self.keep_stage = False
        broker = os.environ.get('DSH_RELEASE_BROKER') == '1'
        # Only the trusted broker's clean child environment supplies this value;
        # it is not part of the member request/profile schema.
        self.project_id = os.environ.get('DSH_RELEASE_PROJECT_ID')
        require(self.project_id is None or (broker and re.fullmatch(r'[a-z][a-z0-9-]{0,39}', self.project_id)), 'Invalid broker project identity')
        allowed = {'script.py', 'archive.tar.gz', 'build.py', 'database.py', 'schema-plan.py'} if broker else {'script.py', 'archive.tar.gz'}
        require(set(p.name for p in self.stage.iterdir()) <= allowed, 'Unexpected temporary stage contents')
        self.profile = validate_profile(profile)
        self.profile_id = digest(profile)
        self.roots = {k: Path(v) for k, v in profile['roots'].items()}
        self.projects = profile['projects']
        for root in self.roots.values():
            secure(root, True)
        self.state = Path(profile['stateRoot'])
        if not self.state.exists():
            secure(self.state.parent, True)
            self.state.mkdir(mode=0o700)
        secure(self.state, True)
        require(stat.S_IMODE(self.state.stat().st_mode) == 0o700, 'Private state directory required')
        marker = self.state / 'profile.json'
        if marker.exists():
            require(loads(secure(marker).read_text()) == profile, 'State profile mismatch')
        else:
            with self.lock('profile'):
                if marker.exists():
                    require(loads(secure(marker).read_text()) == profile, 'State profile mismatch')
                else:
                    atomic(marker, profile)
        docker_config = self.state / 'docker-config'
        if not docker_config.exists():
            docker_config.mkdir(mode=0o700)
        secure(docker_config, True)
        require(not any(docker_config.iterdir()), 'Empty credential-free Docker config required')
        self.config = {'docker': '/usr/bin/docker', 'baseImages': profile['baseImages']}
        secure(self.config['docker'])
        self.user = os.environ.get('SUDO_USER', '')
        uid = os.environ.get('SUDO_UID', '')
        require(self.user and uid.isdecimal() and pwd.getpwnam(self.user).pw_uid == int(uid), 'Verified sudo identity required')
        self.env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(self.state), 'DOCKER_CONFIG': str(docker_config)}
        self.broker = os.environ.get('DSH_RELEASE_BROKER') == '1'
        require(self.broker or self.user == profile['target']['user'], 'Configured SSH user mismatch')
        if self.broker:
            self.env['DSH_RELEASE_BROKER'] = '1'
            mysql_image = os.environ.get('DSH_RELEASE_MYSQL_IMAGE', '')
            require(PIN.fullmatch(mysql_image), 'Reviewed isolated MySQL image required')
            self.env['DSH_RELEASE_MYSQL_IMAGE'] = mysql_image
            if self.project_id is not None:
                self.env['DSH_RELEASE_PROJECT_ID'] = self.project_id

    def authorize(self, environment):
        require(environment in self.roots, 'Unknown environment')

    def database_enabled(self):
        return getattr(self, 'broker', False) and getattr(self, 'project_id', None) is None

    def database_helper(self, name):
        import importlib.util
        require(self.database_enabled(), 'Database automation requires reviewed OA broker')
        validate_stage(self.entry)
        require(name in ('database.py', 'schema-plan.py'), 'Unknown database helper')
        helper = self.stage / name
        helper_stat = helper.lstat()
        require(stat.S_ISREG(helper_stat.st_mode) and helper_stat.st_uid == 0 and
                stat.S_IMODE(helper_stat.st_mode) == 0o600 and helper_stat.st_nlink == 1,
                'Private database helper required')
        spec = importlib.util.spec_from_file_location(name.replace('-', '_'), helper)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def database(self, environment):
        return self.database_helper('database.py').Database(self, environment)

    def cleanup(self):
        if self.keep_stage:
            return
        validate_stage(self.entry)
        observed = self.stage.stat()
        require((observed.st_dev, observed.st_ino) == (self.stage_identity.st_dev, self.stage_identity.st_ino), 'Stage replaced')
        require(self.stage.resolve() == self.stage and self.stage.parent == Path('/var/tmp'), 'Cleanup target mismatch')
        shutil.rmtree(self.stage)

    @contextlib.contextmanager
    def lock(self, name, blocking=True):
        # Legacy OA must coordinate with its existing release CLI globally.
        # Generic projects instead coordinate through their own stateRoot locks.
        legacy_fd = None
        if getattr(self, 'broker', False) and getattr(self, 'project_id', None) is None and name.startswith('operation-'):
            legacy = Path('/var/lib/xian-oa-release/.release.lock')
            secure(legacy.parent, True)
            legacy_fd = os.open(legacy, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            try:
                secure(legacy)
                fcntl.flock(legacy_fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            except Exception:
                os.close(legacy_fd)
                raise Refused('Another release entry owns the shared server lock')
        fd = None
        try:
            fd = os.open(self.state / (name + '.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            yield
        except BlockingIOError:
            raise Refused('Another job owns this environment')
        finally:
            if fd is not None:
                os.close(fd)
            if legacy_fd is not None:
                os.close(legacy_fd)

    @contextlib.contextmanager
    def operation_lock_observation(self, environment):
        """Observe an existing lock without creating files or waiting for workers."""
        fd = None
        observation = 'unknown'
        try:
            require(environment in ('dev', 'test'), 'Invalid lock environment')
            path = self.state / ('operation-' + environment + '.lock')
            secure(path)
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            before = os.fstat(fd)
            require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'Unsafe operation lock')
            try:
                # A shared probe conflicts with the worker's exclusive flock but
                # not with other readers. Keep it until process evidence is read.
                fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
                observation = 'free'
            except BlockingIOError:
                observation = 'held'
            after = path.lstat()
            require(not stat.S_ISLNK(after.st_mode) and (before.st_dev, before.st_ino) == (after.st_dev, after.st_ino), 'Operation lock replaced')
        except (OSError, Refused, ValueError):
            observation = 'unknown'
        try:
            yield observation
        finally:
            if fd is not None:
                os.close(fd)

    def activity(self, job):
        if job.get('status') in ('ready', 'accepted', 'failed'):
            return {'state': 'finished'}
        state = 'unknown'
        pid = job.get('workerPid')
        if type(pid) is not int or pid <= 0:
            # Includes the persist-before-spawn gap. No PID is not proof of exit.
            return {'state': state}
        try:
            with self.operation_lock_observation(job.get('environment')) as lock:
                current = process_identity(pid)
                recorded = job.get('workerIdentity')
                valid = (type(recorded) is dict and set(recorded) == {'bootId', 'startTime'}
                         and type(recorded['bootId']) is str and type(recorded['startTime']) is str
                         and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', recorded['bootId'])
                         and recorded['startTime'].isdecimal())
                if current is None or (valid and current != recorded):
                    if lock == 'free':
                        state = 'interrupted'
                elif valid and current == recorded and lock == 'held':
                    # Recheck identity after lock evidence to reject exit/reuse races.
                    if process_identity(pid) == recorded:
                        state = 'active'
        except (OSError, Refused, ValueError, IndexError):
            pass
        return {'state': state}

    def observed_public_job(self, job):
        # Enrich the response only: never mutate historical jobs or replay deployment.
        if job.get('status') in ('failed', 'uncertain') and job.get('stage') in ('applying', 'health') and job.get('images'):
            job = {**job, 'errorDetails': self.deployment_failure_details(job)}
        return {**self.public_job(job), 'activity': self.activity(job)}

    def get(self, kind, key):
        return loads(secure(self.state / (kind + '-' + identifier(key) + '.json')).read_text())

    def put(self, kind, key, data):
        if kind == 'job':
            data['updatedAt'] = int(time.time())
            if data.get('status') in ('ready', 'accepted', 'failed', 'uncertain'):
                data.setdefault('finishedAt', data['updatedAt'])
        atomic(self.state / (kind + '-' + identifier(key) + '.json'), data)

    def run(self, argv, cwd=None, extra=None, timeout=120):
        env = dict(self.env)
        env.update(extra or {})
        # No shell, caller environment, credential forwarding, or source scripts on host.
        # Successful inspection/cleanup must not erase the primary build error.
        # Each worker resets its diagnostics when claiming a new job.
        with __import__('tempfile').TemporaryFile() as output:
            timed_out = False
            try:
                result = subprocess.run(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, timeout=timeout, check=False)
            except subprocess.TimeoutExpired:
                timed_out = True
            size = output.seek(0, os.SEEK_END)
            if timed_out or result.returncode != 0:
                # Root-only bounded diagnostics. Retain the tail as compiler errors
                # commonly follow more than 1 MiB of dependency/build progress.
                output.seek(0)
                diagnostic_bytes = output.read(512 * 1024)
                if size > len(diagnostic_bytes):
                    output.seek(max(len(diagnostic_bytes), size - 512 * 1024))
                    diagnostic_bytes += output.read(512 * 1024)
                diagnostic = self.state / 'last-command-failure.log'
                fd = os.open(diagnostic, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
                try:
                    os.fchmod(fd, 0o600)
                    with os.fdopen(fd, 'wb', closefd=False) as log:
                        log.write(diagnostic_bytes)
                finally:
                    os.close(fd)
                self.last_failure_details = failure_details(diagnostic_bytes.decode('utf-8', errors='replace'))
                if timed_out:
                    raise Refused('Server command timed out; inspect status')
                raise Refused('Server command failed (output withheld; no business secrets exposed)')
            require(size <= 8 * 1024 * 1024, 'Server command output too large')
            output.seek(0)
            return output.read().decode('utf-8')

    @contextlib.contextmanager
    def checkout(self, key, head=None):
        job = self.get('job', identifier(key))
        bundle = job['bundle']
        verify_bundle(bundle, self.stage)
        path = self.stage / ('source-' + key)
        path.mkdir(mode=0o700)
        # Entire private stage is removed only in worker finally; never early.
        extract_bundle(Path(bundle['path']), path)
        yield path, head

    def compose(self, environment, args, images=None, override=False):
        root = self.roots[environment]
        secure(root, True)
        secure(root / 'compose.yaml')
        command = [self.config['docker'], 'compose', '--project-directory', str(root), '-p', self.projects[environment], '-f', str(root / 'compose.yaml')]
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
        root = self.roots[environment]
        mounts = value['services']['web'].get('volumes', [])
        require(len(mounts) == 1 and mounts[0].get('type') == 'bind' and mounts[0].get('source') == str(root / 'nginx.conf') and mounts[0].get('target') == '/etc/nginx/conf.d/default.conf' and mounts[0].get('read_only') is True, 'Unexpected web mounts')
        return value

    def active_override(self, environment):
        root = self.roots[environment]
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
            ids = self.compose(environment, ['ps', '-a', '-q', service], override=self.active_override(environment)).split()
            require(len(ids) == 1, 'Expected one existing container per service')
            rows = loads(self.run([self.config['docker'], 'inspect', ids[0]]))
            require(type(rows) is list and len(rows) == 1, 'Invalid container inspect')
            row = rows[0]
            labels = row.get('Config', {}).get('Labels', {})
            require(labels.get('com.docker.compose.project') == self.projects[environment] and labels.get('com.docker.compose.service') == service, 'Container project identity mismatch')
            result[service] = {'containerId': row['Id'], 'imageId': row['Image'], 'healthy': row.get('State', {}).get('Running') is True and row.get('State', {}).get('Health', {}).get('Status') == 'healthy'}
        return result

    def deployment_failure_details(self, job):
        details = list(job.get('errorDetails', [])) + list(getattr(self, 'last_failure_details', []))
        # Read only the exact containers/images attempted by this job, including
        # stopped ones. Never return raw logs, configuration or SQL statements.
        for service in ('api', 'web'):
            try:
                ids = self.compose(job['environment'], ['ps', '-a', '-q', service], override=True).split()
                require(len(ids) == 1 and re.fullmatch(r'[a-f0-9]{64}', ids[0]), 'Invalid diagnostic container')
                rows = loads(self.run([self.config['docker'], 'inspect', ids[0]], timeout=10))
                row = rows[0]
                labels = row.get('Config', {}).get('Labels', {})
                require(row['Image'] == job['images'][service] and labels.get('com.docker.compose.project') == self.projects[job['environment']] and labels.get('com.docker.compose.service') == service, 'Diagnostic container identity mismatch')
                logs = self.run([self.config['docker'], 'logs', '--tail', '200', '--since', str(job['createdAt']), ids[0]], timeout=10)
                details.extend(failure_details(logs))
            except Exception:
                # Diagnostics must not replace the original failure or replay up.
                continue
        return list(dict.fromkeys(details))[:4]

    def check(self, body):
        obj(body, ['head'], ['head'])
        require(type(body['head']) is str and SHA.fullmatch(body['head']), 'Full GitHub commit SHA required')
        self.authorize('dev')
        with self.lock('operation-dev', blocking=False):
            return self.plan(secrets.token_hex(16), 'dev', body['head'])

    def plan(self, key, environment, head, images=None, release=None):
        if environment == 'test' and self.database_enabled():
            for path in self.state.glob('job-*.json'):
                prior = loads(secure(path).read_text())
                require(not (prior.get('environment') == 'test' and prior.get('stage') == 'db-restore-failed'),
                        'Test database recovery failed; manual recovery required before retry')
        override = self.active_override(environment)
        config = self.config_snapshot(environment, override=override)
        try:
            observed = self.observe(environment)
            schema_repair = environment == 'test' and self.database_enabled() and images is not None and release is not None
            require(observed['db']['healthy'] and (schema_repair or all(x['healthy'] for x in observed.values())), 'Existing services must be healthy')
        except Refused as error:
            if str(error) not in ('Expected one existing container per service', 'Existing services must be healthy'):
                raise
            details = []
            for service in ('api', 'web'):
                try:
                    ids = self.compose(environment, ['ps', '-a', '-q', service], override=override).split()
                    require(len(ids) == 1 and re.fullmatch(r'[a-f0-9]{64}', ids[0]), 'Invalid diagnostic container')
                    rows = loads(self.run([self.config['docker'], 'inspect', ids[0]], timeout=10))
                    row = rows[0]
                    labels = row.get('Config', {}).get('Labels', {})
                    require(labels.get('com.docker.compose.project') == self.projects[environment] and labels.get('com.docker.compose.service') == service and row['Config']['Image'] == config['services'][service]['image'], 'Diagnostic container identity mismatch')
                    logs = self.run([self.config['docker'], 'logs', '--tail', '200', ids[0]], timeout=10)
                    details.extend(failure_details(logs))
                except Exception:
                    continue
            if details:
                raise Refused('Preflight service failure: ' + '；'.join(dict.fromkeys(details)))
            raise
        value = {'planId': key, 'environment': environment, 'remote': {'repository': self.profile['repository'], 'branch': self.profile['branch'], 'head': head}, 'expiresAt': int(time.time()) + 300, 'actor': self.user, 'fingerprint': digest(config), 'previous': observed, 'images': images, 'sourceReleaseId': release}
        self.put('plan', key, value)
        return {k: value[k] for k in ('planId', 'environment', 'remote', 'expiresAt')}

    @staticmethod
    def promotion_source(job):
        images = job.get('images')
        head = job.get('head')
        return (job.get('environment') == 'dev' and job.get('status') in ('ready', 'accepted')
                and type(head) is str and SHA.fullmatch(head) is not None
                and type(images) is dict and set(images) == {'api', 'web'}
                and all(type(image) is str and IMAGE.fullmatch(image) for image in images.values()))

    def promote(self, body):
        obj(body, ['releaseId'], ['releaseId'])
        self.authorize('test')
        # Accepted release IDs are already job IDs. Successful delivery, not
        # optional business acceptance, is the prerequisite for reusing images.
        source = self.get('job', body['releaseId'])
        require(self.promotion_source(source), 'Successful dev job with images and head required')
        self.inspect_images(source['images'])
        with self.lock('operation-test', blocking=False):
            result = self.plan(secrets.token_hex(16), 'test', source['head'], source['images'], body['releaseId'])
            if self.database_enabled():
                snapshot = source.get('databaseSchema')
                require(snapshot is None or type(snapshot) is dict, 'Invalid dev schema snapshot')
                observed_dev = self.observe('dev')
                require(all(observed_dev[s]['healthy'] and observed_dev[s]['imageId'] == source['images'][s]
                            for s in ('api', 'web')), 'Dev images changed since schema snapshot')
                current_schema = self.database('dev').snapshot()
                snapshot_origin = 'verified-dev-release'
                if snapshot is None:
                    # Legacy ready jobs predate schema capture. Bind a new plan to
                    # the live healthy matching images; do not rewrite old jobs.
                    snapshot = current_schema
                    snapshot_origin = 'live-healthy-legacy-dev'
                require(current_schema == snapshot, 'Dev schema changed since verified release; publish dev first')
                target = self.database('test')
                safe = self.database_helper('schema-plan.py')
                target_schema = target.snapshot()
                try:
                    schema_plan = safe.plan_schema(snapshot, target_schema)
                except ValueError:
                    details = safe.review_details(snapshot, target_schema) if hasattr(safe, 'review_details') else []
                    if details:
                        # Only the diagnostic helper's structural allowlist crosses the boundary.
                        raise Refused('SCHEMA_REVIEW_V1:' + json.dumps({'force': False, 'details': details}, ensure_ascii=False, separators=(',', ':')))
                    raise Refused('Database schema difference requires manual review; no SQL executed')
                plan = self.get('plan', result['planId'])
                plan.update(databaseSchema=snapshot, databaseStatements=schema_plan, databaseSchemaOrigin=snapshot_origin)
                self.put('plan', result['planId'], plan)
                result['databaseChangeCount'] = len(schema_plan)
            return result

    def restore(self, body):
        obj(body, ['environment', 'jobId'], ['environment', 'jobId'])
        environment = body['environment']
        require(environment in ('dev', 'test'), 'Invalid restore environment')
        self.authorize(environment)
        source = self.get('job', body['jobId'])
        require(not (environment == 'test' and self.database_enabled()), 'Test image-only restore requires database compatibility review')
        require(self.restore_source(source, environment), 'Successful same-environment job required')
        self.inspect_images(source['images'])
        with self.lock('operation-' + environment, blocking=False):
            result = self.plan(secrets.token_hex(16), environment, source['head'], source['images'], body['jobId'])
            plan = self.get('plan', result['planId'])
            plan['operation'] = 'restore'
            self.put('plan', result['planId'], plan)
            return {**result, 'operation': 'restore'}

    @staticmethod
    def restore_source(job, environment):
        return (job.get('environment') == environment and environment in ('dev', 'test')
                and job.get('status') in ('ready', 'accepted')
                and type(job.get('head')) is str and SHA.fullmatch(job['head']) is not None
                and type(job.get('images')) is dict and set(job['images']) == {'api', 'web'}
                and all(type(v) is str and IMAGE.fullmatch(v) for v in job['images'].values()))

    def start(self, body):
        obj(body, ['planId', 'confirmation', 'databaseRiskAccepted', 'bundle'], ['planId', 'confirmation', 'databaseRiskAccepted'])
        require(body['confirmation'] is True and body['databaseRiskAccepted'] is True, 'Explicit confirmation and database risk acknowledgement required')
        key = identifier(body['planId'])
        with self.lock('plans'):
            plan = self.get('plan', key)
            self.authorize(plan['environment'])
            require(plan['actor'] == self.user, 'Plan belongs to another server identity')
            require(not any(k in plan for k in ('databaseMode', 'databaseForcePlan', 'databaseForcePreview', 'databasePreview')), 'Unknown database plan fields; request a new safe plan')
            if plan.get('jobId'):
                job = self.get('job', plan['jobId'])
                return self.public_job(job)
            require(time.time() <= plan['expiresAt'], 'Plan expired')
            if plan['environment'] == 'dev' and plan.get('operation') != 'restore':
                require('bundle' in body, 'Dev requires uploaded bundle')
                verify_bundle(body['bundle'], self.stage)
            else:
                require('bundle' not in body, 'Image reuse must not include bundle')
            # Persist before spawn. A crash here leaves a pending record, never a
            # duplicate deployment; reconcile is read-only, recovery is manual.
            with self.lock('operation-' + plan['environment'], blocking=False):
                for path in self.state.glob('job-*.json'):
                    old = loads(secure(path).read_text())
                    require(old['environment'] != plan['environment'] or old['status'] in ('accepted', 'failed', 'ready'), 'Unresolved job blocks new deployment')
                job_id = secrets.token_hex(16)
                token = secrets.token_hex(32)
                job = {'jobId': job_id, 'planId': key, 'environment': plan['environment'], 'actor': self.user, 'status': 'pending', 'stage': 'queued', 'createdAt': int(time.time()), 'workerToken': token}
                if plan['environment'] == 'dev' and plan.get('operation') != 'restore':
                    job['bundle'] = body['bundle']
                self.put('job', job_id, job)
                plan['jobId'] = job_id
                self.put('plan', key, plan)
                self.spawn(job_id, token)
                self.keep_stage = True
            return self.public_job(job)

    def spawn(self, job_id, token):
        request = {'profile': self.profile, 'action': '_worker', 'body': {'jobId': job_id, 'token': token}}
        encoded = base64.b64encode(json.dumps(request, separators=(',', ':')).encode()).decode()
        subprocess.Popen(['/usr/bin/python3', '-I', str(self.entry), encoded], env={**self.env, 'SUDO_USER': self.user, 'SUDO_UID': str(pwd.getpwnam(self.user).pw_uid)}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)

    def build(self, repo, head, job_id):
        if getattr(self, 'broker', False):
            import importlib.util
            validate_stage(self.entry)
            helper = self.stage / 'build.py'
            metadata = helper.lstat()
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 0 and metadata.st_nlink == 1 and stat.S_IMODE(metadata.st_mode) == 0o600, 'Root-owned private build helper required')
            spec = importlib.util.spec_from_file_location('team_release_build', helper)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module.build(self, repo, head, job_id, self.env['DSH_RELEASE_MYSQL_IMAGE'])
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
            tag = 'dsh-release-' + self.profile_id[:12] + '-' + service + ':' + identifier(job_id)
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
            self.last_failure_details = []
            database = None
            backup = None
            migrating = False
            maintenance = False
            def database_stage(stage):
                job.update(stage=stage)
                self.put('job', key, job)
            try:
                require(not any(k in plan for k in ('databaseMode', 'databaseForcePlan', 'databaseForcePreview', 'databasePreview')), 'Unknown database plan fields; request a new safe plan')
                job.update(status='running', stage='preflight', workerPid=os.getpid())
                try:
                    identity = process_identity(job['workerPid'])
                    if identity is not None:
                        job['workerIdentity'] = identity
                except (OSError, Refused, ValueError, IndexError):
                    # Publishing may proceed if proc is unavailable, but readers
                    # must not label this worker active without identity evidence.
                    pass
                self.put('job', key, job)
                require(time.time() <= plan['expiresAt'], 'Plan expired before worker start')
                environment = plan['environment']
                override = self.active_override(environment)
                current = self.config_snapshot(environment, override=override)
                require(digest(current) == plan['fingerprint'] and self.observe(environment) == plan['previous'], 'Compose or containers changed since plan')
                if environment == 'dev' and plan.get('operation') != 'restore':
                    job['stage'] = 'building'
                    self.put('job', key, job)
                    with self.checkout(key, plan['remote']['head']) as (repo, _):
                        images = self.build(repo, plan['remote']['head'], key)
                else:
                    source = self.get('job', plan['sourceReleaseId'])
                    require((self.restore_source(source, environment) if plan.get('operation') == 'restore' else self.promotion_source(source)) and source['images'] == plan['images'] and source['head'] == plan['remote']['head'], 'Promotion source mismatch')
                    images = plan['images']
                    self.inspect_images(images)
                require(digest(self.config_snapshot(environment, override=override)) == plan['fingerprint'] and self.observe(environment) == plan['previous'], 'Deployment changed during build')
                if environment == 'test' and self.database_enabled():
                    # Bind against the actual running dev images as well as the
                    # recorded successful job; old task IDs are not schema proof.
                    dev_observed = self.observe('dev')
                    require(all(dev_observed[s]['healthy'] and dev_observed[s]['imageId'] == images[s]
                                for s in ('api', 'web')), 'Dev images changed since schema snapshot')
                    require(self.database('dev').snapshot() == plan['databaseSchema'], 'Dev schema changed since verified release; publish dev first')
                    require(plan.get('operation') != 'restore', 'Test image-only restore requires database compatibility review')
                    database_stage('db-preflight')
                    database = self.database('test')
                    database.progress = database_stage
                    def current_database_plan():
                        return self.database_helper('schema-plan.py').plan_schema(plan['databaseSchema'], database.snapshot())
                    statements = current_database_plan()
                    require(statements == plan['databaseStatements'], 'Test database changed since plan')
                    # Stop all application writers before backup, not after it.
                    # External writers must be excluded by the reviewed DB helper.
                    database_stage('db-maintenance')
                    maintenance = True
                    self.compose('test', ['stop', 'web', 'api'], override=override)
                    backup = database.backup(key)
                    job['database'] = {'status': 'backed-up', 'backup': backup}
                    self.put('job', key, job)
                    require(current_database_plan() == statements,
                            'Test database changed during backup')
                    job['database']['status'] = 'migrating'
                    database_stage('db-migrating')
                    migrating = True
                    database.apply(statements)
                    require(self.database_helper('schema-plan.py').plan_schema(plan['databaseSchema'], database.snapshot()) == [], 'Schema verification failed')
                    job['database']['status'] = 'synchronized'
                # Durable intent precedes image mutation. Database rollback is only
                # automatic for a failed structure change, never image-only rollback.
                job.update(stage='applying', previous=plan['previous'], fingerprint=plan['fingerprint'], images=images, head=plan['remote']['head'], marker=secrets.token_hex(16))
                self.put('job', key, job)
                text = OVERRIDE_HEADER + 'services:\n  api:\n    image: ' + images['api'] + '\n  web:\n    image: ' + images['web'] + '\n'
                atomic(self.roots[environment] / 'compose.override.yaml', text, raw=True)
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
                if environment == 'dev' and self.database_enabled():
                    job['databaseSchema'] = self.database('dev').snapshot()
                migrating = False  # Keep rollback armed through candidate image health.
                job.update(status='ready', stage='awaiting-acceptance', observed=observed)
                self.put('job', key, job)
            except Exception as error:
                if migrating and database is not None and backup is not None:
                    # DDL can partially commit. Restore the exact current backup,
                    # while writers stay stopped, before returning any result.
                    database_stage('db-restoring')
                    job['database']['status'] = 'restoring'
                    self.put('job', key, job)
                    try:
                        # Candidate apps may already be running after a failed health check.
                        self.compose('test', ['stop', 'web', 'api'], override=self.active_override('test'))
                        database.restore(backup)
                        job['database']['status'] = 'restored'
                        job.update(status='failed', stage='db-restored')
                    except Exception:
                        job['database']['status'] = 'restore-failed'
                        job.update(status='uncertain', stage='db-restore-failed')
                    self.put('job', key, job)
                    return
                if maintenance and job.get('stage', '').startswith('db-'):
                    # No DDL attempted: retain backup, keep maintenance explicit.
                    job['maintenance'] = True
                # Persist only allowlisted structural diagnostics, not raw output.
                details = self.deployment_failure_details(job) if job.get('stage') in ('applying', 'health') else list(getattr(self, 'last_failure_details', []))
                details = failure_details('\n'.join([*details, str(error)]))
                job.update(status='uncertain' if job.get('stage') in ('applying', 'health') else 'failed', errorDetails=details, error='Server operation failed; inspect read-only reconcile and server diagnostics', finishedAt=int(time.time()))
                self.put('job', key, job)

    @staticmethod
    def matches(job, observed):
        return all(observed[s]['healthy'] and observed[s]['imageId'] == job['images'][s] for s in ('api', 'web')) and observed['db'] == job['previous']['db']

    def status(self, body):
        obj(body, ['jobId'])
        if 'jobId' in body:
            job = self.get('job', body['jobId'])
            self.authorize(job['environment'])
            return self.observed_public_job(job)
        values = []
        for path in self.state.glob('job-*.json'):
            job = loads(secure(path).read_text())
            if job.get('actor') == self.user:
                values.append(job)
        values.sort(key=lambda j: j['createdAt'], reverse=True)
        return self.observed_public_job(values[0]) if values else {'status': 'idle'}

    def overview(self, body):
        obj(body, ['authorizedEnvironments'])
        environments = body.get('authorizedEnvironments', ['dev', 'test'])
        require(type(environments) is list and all(env in ('dev', 'test') for env in environments), 'Invalid overview environments')
        jobs = []
        releases = []
        for n, path in enumerate(self.state.glob('job-*.json')):
            require(n < 4096, 'Too many jobs; query explicit jobId')
            job = loads(secure(path).read_text())
            if job.get('environment') in environments:
                jobs.append(job)
            if self.promotion_source(job):
                releases.append(job)
        jobs.sort(key=lambda j: (j.get('createdAt', 0), j['jobId']), reverse=True)
        releases.sort(key=lambda j: (j.get('updatedAt', j.get('createdAt', 0)), j['jobId']), reverse=True)
        return {'jobs': [self.observed_public_job(job) for job in jobs[:20]], 'releaseId': releases[0]['jobId'] if releases else None}

    @staticmethod
    def public_job(job):
        keys = ('jobId', 'environment', 'stage', 'createdAt', 'head', 'images', 'releaseId', 'actor')
        result = {k: job[k] for k in keys if k in job}
        result['status'] = 'delivered' if job['status'] in ('ready', 'accepted') else job['status']
        result['accepted'] = job['status'] == 'accepted'
        created = job.get('createdAt', 0)
        updated = job.get('updatedAt', job.get('finishedAt', created))
        result['updatedAt'] = updated
        end = job.get('finishedAt', updated if job['status'] in ('ready', 'accepted', 'failed', 'uncertain') else int(time.time()))
        result['elapsedSeconds'] = max(0, end - created)
        if 'database' in job:
            database = job['database']
            result['database'] = {'status': database.get('status')}
            if type(database.get('backup')) is dict:
                result['database']['backup'] = {k: database['backup'][k] for k in ('id', 'createdAt') if k in database['backup']}
        if job.get('stage') in ('db-restored', 'db-restore-failed'):
            restored = job['stage'] == 'db-restored'
            summary = ('test 数据库结构变更失败，已用本次备份恢复数据库；本次发布失败，应用保持停止待核对。'
                       if restored else 'test 数据库结构变更失败，自动恢复也失败；保持维护状态，禁止重复发布，需要人工恢复。')
            result.update(errorCode='DATABASE_RESTORED' if restored else 'DATABASE_RESTORE_FAILED',
                          errorSummary=summary, error=summary, maintenance=True)
            return result
        if job['status'] in ('failed', 'uncertain'):
            code = 'DELIVERY_UNCERTAIN' if job['status'] == 'uncertain' else 'BUILD_FAILED' if job.get('stage') == 'building' else 'RELEASE_FAILED'
            details = failure_details('\n'.join(x for x in job.get('errorDetails', []) if isinstance(x, str)))
            stages = {'building': '服务器编译', 'applying': '更新服务', 'health': '健康检查',
                      'db-preflight': '数据库结构预检查', 'db-maintenance': '进入维护阶段',
                      'db-backup': 'test 数据库备份', 'db-backup-verify': '备份恢复验证',
                      'db-backup-cleanup': '旧备份清理', 'db-migrating': '数据库结构同步'}
            summary = stages.get(job.get('stage'), '服务器执行') + '失败。' + ('实际错误：' + '；'.join(details) + '。' if details else '未提取到可安全展示的具体错误，请按任务编号查看受控日志。')
            if job.get('maintenance'):
                summary += '尚未执行结构变更；test 应用保持停止，请核对后恢复服务。'
                result['maintenance'] = True
            if job['status'] == 'uncertain':
                summary += '服务器状态可能已改变，请只读核对；不要重复发布。'
            result.update(errorCode=code, errorSummary=summary, errorDetails=details, error=summary)
        return result

    def reconcile(self, body):
        obj(body, ['jobId'], ['jobId'])
        job = self.get('job', body['jobId'])
        self.authorize(job['environment'])
        observed = self.observe(job['environment'])
        override = self.active_override(job['environment'])
        config = self.config_snapshot(job['environment'], override=override)
        return {**self.observed_public_job(job), 'observed': observed, 'matchesRecordedImages': self.matches(job, observed) if job.get('images') and job.get('previous') else False, 'matchesRecordedCompose': digest(config) == job.get('appliedFingerprint'), 'readOnly': True}

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
        obj(request, ['profile', 'action', 'body'], ['profile', 'action', 'body'])
        require(request['profile'] == self.profile, 'Profile mismatch')
        action = request['action']
        require(type(action) is str and action in ('check', 'promote', 'start', 'status', 'query', 'overview', 'restore', 'accept', 'reconcile', '_worker'), 'Unknown action')
        require(type(request['body']) is dict, 'Object body required')
        if action == '_worker':
            body = obj(request['body'], ['jobId', 'token'], ['jobId', 'token'])
            require(type(body['token']) is str and re.fullmatch(r'[a-f0-9]{64}', body['token']), 'Invalid worker token')
            self.worker(identifier(body['jobId']), body['token'])
            return {'worker': 'finished'}
        return getattr(self, 'status' if action == 'query' else action)(request['body'])


def main():
    service = None
    try:
        require(len(sys.argv) == 2 and len(sys.argv[1]) <= 32768, 'One base64 JSON argument required')
        data = base64.b64decode(sys.argv[1], validate=True)
        require(len(data) <= 16384, 'Request too large')
        request = loads(data.decode('utf-8'))
        obj(request, ['profile', 'action', 'body'], ['profile', 'action', 'body'])
        service = Release(request['profile'])
        result = service.dispatch(request)
        output = json.dumps(result, separators=(',', ':'))
        require(len(output.encode()) < 65536, 'Response too large')
        print(output)
        return 0
    except Exception as error:
        message = str(error) if isinstance(error, Refused) else 'Temporary release refused; inspect server diagnostics'
        print(json.dumps({'error': message}, separators=(',', ':')))
        return 1
    finally:
        if service is not None:
            service.cleanup()

if __name__ == '__main__':
    sys.exit(main())
