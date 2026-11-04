#!/usr/bin/python3
"""Root systemd socket-activated release broker; no caller-supplied identity/config."""
import base64
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import runpy
import selectors
import shutil
import socket
import stat
import struct
import subprocess
import threading
import time
import uuid

CONFIG = Path('/etc/xian-oa-team-release.json')
ENGINE = Path('/usr/local/libexec/xian-oa-temporary-release.py')
BUILD = Path('/usr/local/libexec/xian-oa-team-build.py')
PIN = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9._/:\-]*@sha256:[a-f0-9]{64}')
SOCKET = '/run/xian-oa-team-release.sock'
MAX_REQUEST = 16384
MAX_RESPONSE = 65536
MAX_BUNDLE = 256 * 1024 * 1024
IO_TIMEOUT = 10
COMMAND_TIMEOUT = 600
MAX_CLIENTS = 4
ACTIONS = {
    'check': ({'head'}, {'head'}),
    'promote': ({'releaseId'}, {'releaseId'}),
    'restore': ({'environment', 'jobId'}, {'environment', 'jobId'}),
    'start': ({'planId', 'confirmation', 'databaseRiskAccepted', 'bundle'}, {'planId', 'confirmation', 'databaseRiskAccepted'}),
    'overview': (set(), set()),
    'status': ({'jobId'}, set()),
    'accept': ({'jobId', 'confirmation'}, {'jobId', 'confirmation'}),
    'reconcile': ({'jobId'}, {'jobId'}),
}

class Refused(Exception):
    pass

def require(ok, message):
    if not ok:
        raise Refused(message)

def unique(pairs):
    value = {}
    for k, v in pairs:
        require(k not in value, 'Duplicate JSON field')
        value[k] = v
    return value

def loads(data):
    return json.loads(data, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(Refused('Invalid JSON number')))

def private(path, directory=False):
    path = Path(path)
    require(path.is_absolute(), 'Absolute path required')
    for p in reversed((path, *path.parents)):
        s = p.lstat()
        require(s.st_uid == 0 and not s.st_mode & 0o022 and not stat.S_ISLNK(s.st_mode), 'Unsafe root-owned path')
    s = path.lstat()
    require(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode), 'Unexpected path type')
    return path

def read_json(path):
    private(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as f:
        require(os.fstat(f.fileno()).st_size <= 1024 * 1024, 'State/config too large')
        data = f.read(1024 * 1024 + 1)
    require(len(data) <= 1024 * 1024, 'State/config too large')
    return loads(data)

def load_config():
    require(os.geteuid() == 0, 'Root broker required')
    private(CONFIG)
    require(stat.S_IMODE(CONFIG.stat().st_mode) == 0o600, 'Config must be root-owned 0600')
    value = read_json(CONFIG)
    require(type(value) is dict and set(value) == {'profile', 'allowedUsers', 'mysqlImage'}, 'Invalid broker config')
    require(type(value['mysqlImage']) is str and PIN.fullmatch(value['mysqlImage']), 'Reviewed MySQL digest required')
    private(BUILD)
    private(ENGINE)
    engine = runpy.run_path(str(ENGINE), run_name='broker_validation')
    engine['validate_profile'](value['profile'])
    users = value['allowedUsers']
    require(type(users) is dict and set(users) == {'dev', 'test'}, 'Invalid allowedUsers')
    for environment, names in users.items():
        if environment == 'dev' and names == 'all-ssh-users':
            continue
        require(type(names) is list and len(names) <= 128 and len(set(names)) == len(names), 'Invalid Unix user list')
        for name in names:
            require(type(name) is str and re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', name), 'Invalid Unix user')
            require(pwd.getpwnam(name).pw_uid > 0, 'Non-root Unix users required')
    require(users['dev'], 'At least one dev user required')
    return value

def request_object(data):
    require(len(data) <= MAX_REQUEST, 'Request too large')
    value = loads(data)
    require(type(value) is dict and set(value) == {'action', 'body'}, 'Only action/body accepted')
    action, body = value['action'], value['body']
    require(type(action) is str and action in ACTIONS and type(body) is dict, 'Invalid action/body')
    keys, mandatory = ACTIONS[action]
    require(set(body) <= keys and mandatory <= set(body), 'Invalid action fields')
    return value

def identifier(value):
    require(type(value) is str and re.fullmatch(r'[a-f0-9]{32}', value), 'Invalid identifier')
    return value

def ordinary_login_user(user):
    """Local Unix identity policy, not a substitute for sshd authentication.

    SSH authenticates the caller before entry invocation; reject root, service
    UIDs and non-login shells even when the socket is accessible to all users.
    Re-evaluate NSS passwd each request so new login accounts need no restart.
    """
    account = pwd.getpwnam(user)
    limits = {'UID_MIN': 1000, 'UID_MAX': 60000}
    for line in Path('/etc/login.defs').read_text().splitlines():
        parts = line.split('#', 1)[0].split()
        if len(parts) == 2 and parts[0] in limits:
            limits[parts[0]] = int(parts[1])
    shells = {line.strip() for line in Path('/etc/shells').read_text().splitlines()
              if line.strip() and not line.lstrip().startswith('#')}
    return (limits['UID_MIN'] <= account.pw_uid <= limits['UID_MAX']
            and account.pw_uid != 65534 and account.pw_shell in shells
            and Path(account.pw_shell).name not in ('nologin', 'false', 'sync', 'shutdown', 'halt'))


def permitted(config, user, environment):
    if environment not in ('dev', 'test'):
        return False
    users = config['allowedUsers'][environment]
    if environment == 'dev' and users == 'all-ssh-users':
        return ordinary_login_user(user)
    return user in users


def authorize(config, user, environment):
    require(permitted(config, user, environment), 'Unix user not authorized for environment')

class Broker:
    def __init__(self, config):
        self.config = config
        self.profile = config['profile']
        self.state = Path(self.profile['stateRoot'])

    def record(self, kind, key):
        private(self.state, True)
        require(stat.S_IMODE(self.state.stat().st_mode) == 0o700, 'Private state required')
        return read_json(self.state / (kind + '-' + identifier(key) + '.json'))

    def environment(self, request, user):
        action, body = request['action'], request['body']
        if action == 'overview':
            require(any(permitted(self.config, user, env) for env in ('dev', 'test')), 'Unix user not authorized')
            return 'dev'  # read-only aggregate; filter each record after trusted engine read
        if action == 'check':
            environment = 'dev'
        elif action == 'promote':
            environment = 'test'
        elif action == 'restore':
            job = self.record('job', body['jobId'])
            environment = job.get('environment')
            require(environment == body.get('environment'), 'Restore environment mismatch')
        elif action == 'start':
            plan = self.record('plan', body['planId'])
            require(plan.get('actor') == user, 'Plan belongs to another Unix user')
            environment = plan.get('environment')
        elif body.get('jobId') is not None:
            job = self.record('job', body['jobId'])
            require(job.get('actor') == user, 'Job belongs to another Unix user')
            environment = job.get('environment')
        else:
            # Status without id follows the existing engine's latest-own-job rule,
            # but must authorize the actual environment before executing it.
            jobs = []
            if self.state.exists():
                private(self.state, True)
                for n, path in enumerate(self.state.glob('job-*.json')):
                    require(n < 4096, 'Too many jobs; query explicit jobId')
                    job = read_json(path)
                    if job.get('actor') == user:
                        jobs.append(job)
            if not jobs:
                require(any(permitted(self.config, user, env) for env in ('dev', 'test')), 'Unix user not authorized')
                return None
            latest = max(jobs, key=lambda x: x['createdAt'])
            body['jobId'] = identifier(latest['jobId'])
            environment = latest.get('environment')
        authorize(self.config, user, environment)
        return environment

    def public_overview(self, result, user):
        return {'jobs': [job for job in result['jobs'] if job.get('environment') in ('dev', 'test')][:20],
                'releaseId': result['releaseId'] if permitted(self.config, user, 'test') else None}

    def dispatch(self, request, uid):
        user = pwd.getpwuid(uid).pw_name
        require(uid > 0, 'Non-root peer required')
        environment = self.environment(request, user)
        if environment is None:
            return {'status': 'idle'}
        body = dict(request['body'])
        if request['action'] == 'overview':
            body['authorizedEnvironments'] = ['dev', 'test']
        previous_job = self.record('plan', body['planId']).get('jobId') if request['action'] == 'start' else None
        stage = Path('/var/tmp') / ('dsh-release-' + str(uuid.uuid4()))
        stage.mkdir(mode=0o700)
        handed = False
        try:
            # Source is installed root-owned code, never an uploaded script.
            private(ENGINE)
            with ENGINE.open('rb') as src, (stage / 'script.py').open('xb') as dst:
                shutil.copyfileobj(src, dst)
            (stage / 'script.py').chmod(0o600)
            private(BUILD)
            with BUILD.open('rb') as src, (stage / 'build.py').open('xb') as dst:
                shutil.copyfileobj(src, dst)
            (stage / 'build.py').chmod(0o600)
            if request['action'] == 'start':
                if environment == 'dev' and self.record('plan', body['planId']).get('operation') != 'restore':
                    require('bundle' in body, 'Dev requires bundle')
                    body['bundle'] = copy_bundle(body['bundle'], uid, stage)
                else:
                    require('bundle' not in body, 'Test must reuse existing images')
            result = execute(stage, self.profile, request['action'], body, user, uid, self.config['mysqlImage'])
            if request['action'] == 'overview':
                result = self.public_overview(result, user)
            # A durable job+stage match, NOT response success alone, transfers
            # ownership. On timeout the worker may already have started.
            if request['action'] == 'start':
                plan = self.record('plan', body['planId'])
                if plan.get('jobId'):
                    job = self.record('job', plan['jobId'])
                    handed = job.get('bundle', {}).get('path') == str(stage / 'archive.tar.gz') if environment == 'dev' and plan.get('operation') != 'restore' else bool(job.get('jobId') and not previous_job)
            return result
        finally:
            if request['action'] == 'start' and not handed:
                # Unknown outcome: consult durable state before deleting a stage.
                try:
                    plan = self.record('plan', body['planId'])
                    if plan.get('jobId'):
                        job = self.record('job', plan['jobId'])
                        handed = job.get('bundle', {}).get('path') == str(stage / 'archive.tar.gz') if environment == 'dev' and plan.get('operation') != 'restore' else not previous_job
                except Exception:
                    # Preserve uncertain stages for administrator inspection.
                    handed = True
            if not handed and stage.exists():
                shutil.rmtree(stage)

def copy_bundle(bundle, uid, stage):
    require(type(bundle) is dict and set(bundle) == {'path', 'sha256', 'size'}, 'Invalid bundle')
    path = bundle['path']
    require(type(path) is str and re.fullmatch(r'/tmp/dsh-upload-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/source\.tar', path), 'Fixed upload path required')
    require(type(bundle['size']) is int and 0 < bundle['size'] <= MAX_BUNDLE, 'Bundle size out of bounds')
    require(type(bundle['sha256']) is str and re.fullmatch(r'[a-f0-9]{64}', bundle['sha256']), 'Invalid SHA256')
    directory = Path(path).parent
    dfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    identity = os.fstat(dfd)
    try:
        require(identity.st_uid == uid and stat.S_IMODE(identity.st_mode) == 0o700, 'Private peer-owned upload directory required')
        fd = os.open('source.tar', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
        try:
            initial = os.fstat(fd)
            require(stat.S_ISREG(initial.st_mode) and initial.st_uid == uid and initial.st_nlink == 1 and stat.S_IMODE(initial.st_mode) == 0o600 and initial.st_size == bundle['size'], 'Unsafe uploaded archive')
            sha = hashlib.sha256()
            remaining = bundle['size']
            with (stage / 'archive.tar.gz').open('xb') as dst:
                os.chmod(dst.name, 0o600)
                while remaining:
                    chunk = os.read(fd, min(1024 * 1024, remaining))
                    require(chunk, 'Truncated archive')
                    remaining -= len(chunk)
                    sha.update(chunk)
                    dst.write(chunk)
                require(not os.read(fd, 1), 'Archive grew during copy')
            after = os.fstat(fd)
            require((initial.st_size, initial.st_mtime_ns, initial.st_ctime_ns, initial.st_nlink) == (after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink) and sha.hexdigest() == bundle['sha256'], 'Archive changed or SHA256 mismatch')
        finally:
            os.close(fd)
        current = os.stat('source.tar', dir_fd=dfd, follow_symlinks=False)
        require((current.st_dev, current.st_ino) == (initial.st_dev, initial.st_ino), 'Upload identity changed')
        os.unlink('source.tar', dir_fd=dfd)
        current_dir = directory.lstat()
        if (current_dir.st_dev, current_dir.st_ino) == (identity.st_dev, identity.st_ino):
            try:
                directory.rmdir()
            except OSError:
                pass  # Never recursively delete a caller-controlled directory.
    finally:
        os.close(dfd)
    return {**bundle, 'path': str(stage / 'archive.tar.gz')}

def execute(stage, profile, action, body, user, uid, mysql_image):
    payload = base64.b64encode(json.dumps({'profile': profile, 'action': action, 'body': body}, separators=(',', ':')).encode()).decode()
    require(len(payload) <= 32768, 'Engine request too large')
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'SUDO_USER': user, 'SUDO_UID': str(uid), 'DSH_RELEASE_BROKER': '1', 'DSH_RELEASE_MYSQL_IMAGE': mysql_image}
    process = subprocess.Popen(['/usr/bin/python3', '-I', str(stage / 'script.py'), payload], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True)
    output = bytearray()
    deadline = time.monotonic() + COMMAND_TIMEOUT
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                require(time.monotonic() < deadline, 'Release request timed out; query status, do not replay')
                for key, _ in selector.select(min(1, max(0, deadline - time.monotonic()))):
                    chunk = os.read(key.fileobj.fileno(), 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        output.extend(chunk)
                        require(len(output) < MAX_RESPONSE, 'Release output too large')
            process.wait(timeout=max(0.1, deadline - time.monotonic()))
        result = loads(output)
        require(type(result) is dict, 'Invalid release response')
        # Engine errors are intentionally secret-free; no stderr is forwarded.
        return result
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()

def receive(connection):
    data = bytearray()
    deadline = time.monotonic() + IO_TIMEOUT
    while True:
        connection.settimeout(max(0.001, deadline - time.monotonic()))
        require(time.monotonic() < deadline, 'Request timed out')
        chunk = connection.recv(min(4096, MAX_REQUEST + 1 - len(data)))
        if not chunk:
            return request_object(bytes(data))
        data.extend(chunk)
        require(len(data) <= MAX_REQUEST, 'Request too large')

def handle(connection, broker):
    try:
        _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
        request = receive(connection)
        result = broker.dispatch(request, uid)
    except Exception as error:
        result = {'error': str(error) if isinstance(error, Refused) else 'Broker refused request; inspect administrator diagnostics'}
    try:
        output = json.dumps(result, separators=(',', ':')).encode()
        if len(output) >= MAX_RESPONSE:
            output = b'{"error":"Broker response too large"}'
        connection.settimeout(IO_TIMEOUT)
        connection.sendall(output)
    except OSError:
        pass
    finally:
        connection.close()

def main():
    config = load_config()
    require(os.environ.get('LISTEN_PID') == str(os.getpid()) and os.environ.get('LISTEN_FDS') == '1', 'One systemd socket required')
    listener = socket.socket(fileno=3)
    require(listener.family == socket.AF_UNIX and listener.getsockname() == SOCKET and listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN), 'Unexpected listening socket')
    metadata = Path(SOCKET).lstat()
    expected_mode = 0o666 if config['allowedUsers']['dev'] == 'all-ssh-users' else 0o660
    require(stat.S_ISSOCK(metadata.st_mode) and metadata.st_uid == 0 and stat.S_IMODE(metadata.st_mode) == expected_mode, 'Root-owned policy-matched socket required')
    broker = Broker(config)
    slots = threading.BoundedSemaphore(MAX_CLIENTS)
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_CLIENTS) as pool:
        while True:
            connection, _ = listener.accept()
            if not slots.acquire(blocking=False):
                try:
                    connection.settimeout(0.1)
                    connection.sendall(b'{"error":"Broker busy; query status before retrying start"}')
                except OSError:
                    pass
                connection.close()
                continue
            future = pool.submit(handle, connection, broker)
            future.add_done_callback(lambda _: slots.release())

if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Team release broker startup refused (configuration/permissions)')
