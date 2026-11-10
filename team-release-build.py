"""Broker-only server build. Standard library; load explicitly with importlib under -I.

Contract: build(release, repo, head, job_id, mysql_image, run_tests=False) -> {api, web} IDs.
release supplies stage, profile_id, config[baseImages/docker], run(argv, cwd=None,
extra=None, timeout=...), inspect_images(images), and an outer exclusive build lock.
mysql_image is a root-reviewed MySQL 8+ digest, never a client/profile override.
Root-approved dev policy packages with -DskipTests by default; compiler failures
still fail closed. Only explicit operator/regression run_tests=True starts MySQL.
No deployment, Docker socket mount, host source bind, or prune.
"""
import hashlib
import json
import re
import secrets
import shutil
import stat
from pathlib import Path

PIN = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9._/:\-]*@sha256:[a-f0-9]{64}')
ID = re.compile(r'sha256:[a-f0-9]{64}')
CID = re.compile(r'[a-f0-9]{64}')
LABEL = 'io.xian.team-release.build'


def require(value, message):
    if not value:
        raise RuntimeError(message)


def _copy(source, target, frontend=False):
    """Copy data only into a private context; never run source on the host."""
    excluded = {'.git', 'node_modules', 'target', 'dist'}
    if frontend:
        excluded.update({'backend', '.github', 'docs'})
    def ignore(directory, names):
        return [n for n in names if n in excluded or n == '.dockerignore'
                or n.startswith('.env') or n in {'.npmrc', 'settings.xml'}
                or n.endswith(('.pem', '.key'))]
    shutil.copytree(source, target, ignore=ignore)


def build(release, repo, head, job_id, mysql_image, run_tests=False):
    repo = Path(repo)
    require(re.fullmatch(r'[a-f0-9]{40}', head or ''), 'Commit SHA required')
    require(re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', job_id or ''), 'Invalid build job')
    bases = release.config['baseImages']
    require(all(isinstance(v, str) and PIN.fullmatch(v) for v in
                [mysql_image, *(bases[k] for k in ('node', 'mavenJava21', 'java', 'nginx'))]),
            'Reviewed digest-pinned build images required')
    require((repo / 'backend/pom.xml').is_file() and (repo / 'package.json').is_file()
            and (repo / 'package-lock.json').is_file(), 'Expected Maven/npm layout required')
    for path in repo.rglob('*'):
        require(not path.is_symlink() and (path.is_file() or path.is_dir()),
                'Only regular source files/directories permitted')
    namespace = hashlib.sha256(str(release.profile_id).encode()).hexdigest()[:24]
    token = secrets.token_hex(16)
    owner = namespace + ':' + token
    work = Path(release.stage) / ('build-' + token)
    work.mkdir(mode=0o700)
    docker = release.config['docker']
    containers = []

    def run(args, timeout=120, extra=None):
        return release.run([docker, *args], timeout=timeout, extra=extra)

    def identity(cid):
        require(CID.fullmatch(cid or ''), 'Invalid container identity')
        info = json.loads(run(['inspect', '--type', 'container', cid]))
        require(len(info) == 1 and info[0]['Id'] == cid
                and info[0]['Config'].get('Labels', {}).get(LABEL) == owner,
                'Build container ownership mismatch')
        return info[0]

    def create(args, extra=None):
        cid = run(['create', '--label', LABEL + '=' + owner, *args], extra=extra).strip()
        require(CID.fullmatch(cid or ''), 'Invalid created container ID')
        containers.append(cid)
        identity(cid)
        return cid

    def image(context, dockerfile, service):
        (context / 'Dockerfile').write_text(dockerfile)
        iid = work / (service + '.iid')
        run(['build', '--pull=false', '--network=default', '--memory=2g',
             '--cpu-period=100000', '--cpu-quota=200000', '--tag',
             'dsh-team-' + namespace + '-' + service + ':' + job_id,
             '--iidfile', str(iid), '-f', str(context / 'Dockerfile'), str(context)], 3600)
        value = iid.read_text().strip()
        require(ID.fullmatch(value or ''), 'Invalid built image ID')
        return value

    limits = ['--cpus', '2', '--memory', '2g', '--memory-swap', '2g',
              '--pids-limit', '256', '--cap-drop', 'ALL',
              '--security-opt', 'no-new-privileges:true', '--ulimit', 'nofile=4096:4096',
              '--log-driver', 'none']
    try:
        backend = work / 'backend'
        _copy(repo / 'backend', backend)
        # Fixed public dependency mirror, not caller-supplied Maven settings/credentials.
        (backend / 'team-maven-settings.xml').write_text(
            '<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"><mirrors><mirror>'
            '<id>team-public</id><mirrorOf>central</mirrorOf>'
            '<url>https://maven.aliyun.com/repository/central</url>'
            '</mirror></mirrors></settings>')
        runner = image(backend,
            'FROM ' + bases['mavenJava21'] + '\n'
            'RUN mkdir -p /home/builder/.m2 /work /out && chown -R 10001:10001 /home/builder /work /out\n'
            'ENV HOME=/home/builder MAVEN_CONFIG=/home/builder/.m2\n'
            'COPY --chown=10001:10001 team-maven-settings.xml /opt/team-maven-settings.xml\n'
            'WORKDIR /work\nCOPY --chown=10001:10001 pom.xml ./\n'
            'USER 10001:10001\n'
            'RUN mvn -B -s /opt/team-maven-settings.xml -Dmaven.repo.local=/home/builder/.m2/repository dependency:go-offline\n'
            'COPY --chown=10001:10001 . .\n', 'runner')
        # Shared named cache is isolated by profile, never a host filesystem bind.
        cache = 'dsh-team-maven-' + namespace
        run(['volume', 'create', '--label', 'io.xian.team-release.profile=' + namespace, cache])
        volume = json.loads(run(['volume', 'inspect', cache]))
        require(len(volume) == 1 and volume[0]['Name'] == cache
                and volume[0].get('Driver') == 'local'
                and not volume[0].get('Options')
                and volume[0].get('Labels', {}).get('io.xian.team-release.profile') == namespace,
                'Maven cache identity mismatch')
        network = 'bridge'
        test_env = None
        if run_tests:
            password = secrets.token_urlsafe(32)
            db = create([*limits, '--network', 'bridge', '--user', 'mysql', '--read-only',
                         '--tmpfs', '/var/lib/mysql:rw,nosuid,nodev,noexec,mode=1777,size=1g',
                         '--tmpfs', '/var/run/mysqld:rw,nosuid,nodev,noexec,mode=1777,size=16m',
                         '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m',
                         '-e', 'MYSQL_ROOT_PASSWORD', '-e', 'MYSQL_ROOT_HOST', mysql_image,
                          '--max-connections=512'],
                        {'MYSQL_ROOT_PASSWORD': password, 'MYSQL_ROOT_HOST': '%'})
            # Secrets are process environment only, never command arguments or logs.
            run(['start', db])
            ready = False
            for _ in range(30):
                try:
                    identity(db)
                    run(['exec', '-e', 'MYSQL_PWD', db, 'mysql', '-h127.0.0.1', '-uroot',
                         '--connect-timeout=2', '-Nse', 'SELECT 1'], 5,
                        {'MYSQL_PWD': password})
                    ready = True
                    break
                except Exception:
                    __import__('time').sleep(1)
            require(ready, 'Isolated MySQL readiness timeout')
            network = 'container:' + db
            test_env = {'MYSQL_TEST_URL': 'jdbc:mysql://127.0.0.1:3306',
                        'MYSQL_TEST_USERNAME': 'root', 'MYSQL_TEST_PASSWORD': password,
                        'ALLOW_CREATE_DATABASE': 'true'}
        builder = create([*limits, '--user', '10001:10001', '--network', network,
                          '--mount', 'type=volume,src=' + cache + ',dst=/home/builder/.m2',
                          '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
                          *[arg for key in (test_env or {}) for arg in ('-e', key)],
                          '--entrypoint', '/bin/sh', runner, '-ec',
                          'mvn -B -s /opt/team-maven-settings.xml -Dmaven.repo.local=/home/builder/.m2/repository '
                          + ('' if run_tests else '-DskipTests ') + 'package; '
                          'set -- target/*.jar; test "$#" -eq 1; test -f "$1"; cp "$1" /out/app.jar'],
                         test_env)
        # Attach while executing: log-driver=none intentionally persists no Docker
        # logs, so detached start/wait would discard the actual Maven diagnostics.
        try:
            run(['start', '--attach', builder], 3600)
        except Exception:
            primary = list(getattr(release, 'last_failure_details', []))
            if run_tests:
                try:
                    diagnostics = Path(getattr(release, 'state', release.stage)) / ('test-reports-' + job_id)
                    diagnostics.mkdir(mode=0o700, exist_ok=True)
                    run(['cp', builder + ':/work/target/surefire-reports/.', str(diagnostics)])
                except Exception:
                    pass
            release.last_failure_details = primary
            raise
        status = run(['wait', builder], 3600).strip()
        if status != '0' and run_tests:
            # Preserve test diagnostics only in root-owned state, never the member response.
            diagnostics = Path(getattr(release, 'state', release.stage)) / ('test-reports-' + job_id)
            diagnostics.mkdir(mode=0o700)
            run(['cp', builder + ':/work/target/surefire-reports/.', str(diagnostics)])
        require(status == '0', 'Maven build/tests failed')
        info = identity(builder)
        require(info['State']['ExitCode'] == 0 and not info['State'].get('OOMKilled'),
                'Maven container failed')
        api = work / 'api'
        api.mkdir(mode=0o700)
        run(['cp', builder + ':/out/app.jar', str(api / 'app.jar')])
        artifact = api / 'app.jar'
        require(stat.S_ISREG(artifact.lstat().st_mode) and 0 < artifact.stat().st_size <= 256*1024*1024,
                'Invalid Maven artifact')
        api_id = image(api, 'FROM ' + bases['java'] + '\nLABEL org.opencontainers.image.revision="' + head + '"\n'
                       'WORKDIR /app\nCOPY --chown=10001:10001 app.jar /app/app.jar\n'
                       'USER 10001:10001\nENTRYPOINT ["java","-jar","/app/app.jar"]\n', 'api')
        frontend = work / 'web'
        _copy(repo, frontend, frontend=True)
        # The frontend shares this public region dictionary with the backend.
        # Copy only this reviewed data file, never backend code/config/secrets.
        regions = repo / 'backend/src/main/resources/oa-regions.json'
        if regions.is_file():
            target = frontend / 'backend/src/main/resources/oa-regions.json'
            target.parent.mkdir(parents=True)
            shutil.copyfile(regions, target)
        (frontend / '.dockerignore').write_text('.github\ndocs\n.git\n**/node_modules\n**/target\ndist\n')
        web_id = image(frontend, 'FROM ' + bases['node'] + ' AS build\nWORKDIR /src\n'
                       'COPY package*.json ./\nRUN npm ci\nCOPY . .\nRUN npm run build\n'
                       'FROM ' + bases['nginx'] + '\nLABEL org.opencontainers.image.revision="' + head + '"\n'
                       'COPY --from=build /src/dist/ /usr/share/nginx/html/\n', 'web')
        images = {'api': api_id, 'web': web_id}
        release.inspect_images(images)
        return images
    finally:
        # Re-check full immutable ID + per-attempt label before every destruction.
        # Cleanup failure fails closed too; never select by names or broad labels.
        primary_details = list(getattr(release, 'last_failure_details', []))
        failed = False
        for cid in reversed(containers):
            try:
                identity(cid)
                run(['rm', '--force', '--volumes', cid], 60)
            except Exception:
                failed = True
        if primary_details:
            release.last_failure_details = primary_details
        require(not failed, 'Build cleanup incomplete; operator inspection required')
