"""Private MySQL 8 helper. Only trusted release code may supply SQL/backup metadata.
No command output is logged; failures deliberately discard server diagnostics.
Caller holds operation lock and stops api/web throughout backup/apply/restore.
Supported recovery boundary: InnoDB base tables, no views/routines/events/triggers.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import tempfile
import time


class DatabaseError(ValueError):
    pass


def require(value, message):
    if not value:
        raise DatabaseError(message)


def ident(value):
    require(type(value) is str and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}', value), 'Unsupported database identifier')
    return '`' + value + '`'


class Database:
    def __init__(self, release, environment):
        require(environment in ('dev', 'test'), 'Unsupported environment')
        self.release, self.environment = release, environment
        config = release.config_snapshot(environment, override=release.active_override(environment))
        db = config['services']['db']
        env = db.get('environment', {})
        self.password = env.get('MYSQL_ROOT_PASSWORD')
        self.name = env.get('MYSQL_DATABASE')
        ident(self.name)
        require(self.name.lower() not in ('mysql', 'sys', 'information_schema', 'performance_schema'), 'System database refused')
        require(type(self.password) is str and self.password and '\x00' not in self.password, 'Database credential missing')
        self.config_image = db['image']
        self.config_command = db.get('command', ['mysqld'])
        require(type(self.config_command) is list and self.config_command and
                (self.config_command == ['mysqld'] or all(type(x) is str and re.fullmatch(r'--(?:character-set-server=utf8mb4|collation-server=utf8mb4_0900_bin|innodb-buffer-pool-size=[0-9]+[MG]|max-connections=[0-9]+|binlog-expire-logs-seconds=[0-9]+|max-binlog-size=[0-9]+)', x) for x in self.config_command)), 'Unreviewed database command')
        reviewed = release.env.get('DSH_RELEASE_MYSQL_IMAGE', '')
        pinned_reviewed = (self.config_image == reviewed and re.fullmatch(r'[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}', reviewed) is not None)
        require(pinned_reviewed or re.fullmatch(r'(?:docker.io/library/)?mysql:8(?:\.[0-9]+)*(?:@sha256:[a-f0-9]{64})?', self.config_image) is not None, 'Reviewed MySQL 8 image required')
        self.docker = release.config['docker']
        self.container, self.image = self._identity()
        self.progress = lambda stage: None

    def _command(self, args, data=None, source=None, output=None, password=None, timeout=600):
        env = dict(self.release.env)
        if password is not None:
            env['MYSQL_PWD'] = password
        try:
            with tempfile.TemporaryFile() as captured:
                result = subprocess.run([self.docker, *args], env=env,
                                        input=data, stdin=source,
                                        stdout=output if output is not None else captured,
                                        stderr=subprocess.DEVNULL, timeout=timeout, check=False)
                require(result.returncode == 0, 'Database command failed (output withheld)')
                if output is not None:
                    return ''
                require(captured.tell() <= 16 * 1024 * 1024, 'Database metadata output too large')
                captured.seek(0)
                return captured.read().decode('utf-8')
        except (OSError, subprocess.SubprocessError, UnicodeError):
            raise DatabaseError('Database command unavailable or timed out') from None

    def _identity(self):
        ids = self.release.compose(self.environment, ['ps', '-a', '-q', 'db'], override=self.release.active_override(self.environment)).split()
        require(len(ids) == 1 and re.fullmatch('[a-f0-9]{64}', ids[0]), 'Expected one controlled database container')
        rows = json.loads(self._command(['inspect', ids[0]]))
        require(type(rows) is list and len(rows) == 1, 'Invalid database identity')
        row = rows[0]
        labels = row.get('Config', {}).get('Labels', {})
        require(row.get('Id') == ids[0] and labels.get('com.docker.compose.project') == self.release.projects[self.environment]
                and labels.get('com.docker.compose.service') == 'db'
                and row['Config'].get('Image') == self.config_image
                and row.get('State', {}).get('Running') is True
                and row['Config'].get('Entrypoint') == ['docker-entrypoint.sh']
                and row['Config'].get('Cmd') == self.config_command, 'Database container identity mismatch')
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', row.get('Image', '')), 'Invalid database image identity')
        return ids[0], row['Image']

    def _check_identity(self):
        require(self._identity() == (self.container, self.image), 'Database container changed')

    def _mysql(self, sql=None, source=None, container=None, password=None, database=True):
        args = ['exec', '-i', '-e', 'MYSQL_PWD', container or self.container, 'mysql', '--no-defaults', '--user=root', '--batch', '--raw', '--skip-column-names', '--binary-mode=1', '--default-character-set=utf8mb4']
        if database:
            args += ['--database=' + self.name]
        return self._command(args, data=sql.encode() if sql is not None else None, source=source, password=self.password if password is None else password)

    def _json(self, sql, **kwargs):
        return [json.loads(line) for line in self._mysql(sql, **kwargs).splitlines() if line]

    def _supported(self, **kwargs):
        n = self.name
        sql = "SELECT JSON_OBJECT('version',VERSION(),'unsafe', (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='" + n + "' AND (TABLE_TYPE<>'BASE TABLE' OR ENGINE<>'InnoDB')) + (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='" + n + "') + (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='" + n + "') + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='" + n + "'));"
        row = self._json(sql, **kwargs)
        require(len(row) == 1 and row[0]['version'].startswith('8.') and row[0]['unsafe'] == 0, 'Unsupported database objects or server version')

    def _writers_stopped(self):
        for service in ('api', 'web'):
            ids = self.release.compose(self.environment, ['ps', '-a', '-q', service], override=self.release.active_override(self.environment)).split()
            require(len(ids) == 1 and re.fullmatch('[a-f0-9]{64}', ids[0]), 'Application writer identity unavailable')
            rows = json.loads(self._command(['inspect', ids[0]]))
            require(type(rows) is list and len(rows) == 1, 'Application writer inspect unavailable')
            row = rows[0]
            labels = row.get('Config', {}).get('Labels', {})
            require(row.get('Id') == ids[0] and labels.get('com.docker.compose.project') == self.release.projects[self.environment]
                    and labels.get('com.docker.compose.service') == service and row.get('State', {}).get('Running') is False
                    and not row.get('State', {}).get('Restarting', False), 'Application writers must remain stopped')

    def _network_boundary(self):
        rows = json.loads(self._command(['inspect', self.container]))
        require(type(rows) is list and len(rows) == 1, 'Database network evidence unavailable')
        row = rows[0]
        require(not row.get('HostConfig', {}).get('PortBindings')
                and row.get('HostConfig', {}).get('NetworkMode') not in ('host', 'container')
                and not any(row.get('NetworkSettings', {}).get('Ports', {}).values()), 'Published database access requires manual isolation')
        networks = row.get('NetworkSettings', {}).get('Networks', {})
        require(len(networks) == 1, 'Dedicated Compose database network required')
        network_id = next(iter(networks.values())).get('NetworkID', '')
        require(re.fullmatch('[a-f0-9]{64}', network_id), 'Invalid database network identity')
        evidence = json.loads(self._command(['network', 'inspect', network_id]))
        require(type(evidence) is list and len(evidence) == 1, 'Database network inspection unavailable')
        net = evidence[0]
        require(net.get('Id') == network_id and net.get('Driver') == 'bridge'
                and net.get('Labels', {}).get('com.docker.compose.project') == self.release.projects[self.environment]
                and set(net.get('Containers', {})) == {self.container}, 'Other network clients prevent controlled database recovery')

    def _quiescent(self):
        self._writers_stopped()
        self._check_identity()
        self._network_boundary()
        self._supported()
        inbound = self._json("SELECT JSON_OBJECT('n',COUNT(*)) FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA='" + self.name + "' AND TABLE_SCHEMA<>'" + self.name + "';")
        require(len(inbound) == 1 and inbound[0]['n'] == 0, 'Incoming cross-database foreign key refused')
        rows = self._json("SELECT JSON_OBJECT('events',@@GLOBAL.event_scheduler,'writers',(SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() AND USER NOT IN ('system user','event_scheduler')));")
        require(len(rows) == 1 and rows[0]['events'] in ('OFF', 'DISABLED') and rows[0]['writers'] == 0, 'Other database sessions or scheduler prevent safe recovery')

    def snapshot(self, _container=None, _password=None):
        if _container is None:
            self._check_identity()
        kw = {'container': _container, 'password': _password}
        self._supported(**kw)
        names = self._json("SELECT JSON_OBJECT('name',TABLE_NAME,'engine',ENGINE,'collation',TABLE_COLLATION,'comment',TABLE_COMMENT,'options',CREATE_OPTIONS) FROM information_schema.TABLES WHERE TABLE_SCHEMA='" + self.name + "' ORDER BY TABLE_NAME;", **kw)
        tables = {}
        for row in names:
            name = row.pop('name')
            q = ident(name)
            # JSON avoids mysql batch escaping/newline ambiguities in SHOW CREATE.
            shown = self._mysql('SHOW CREATE TABLE ' + q + ';', **kw)
            require(shown.startswith(name + '\t'), 'Invalid SHOW CREATE output')
            create = shown[len(name) + 1:].rstrip('\n')
            create = re.sub(r' AUTO_INCREMENT=[0-9]+(?= |$)', '', create)
            cols = self._json("SELECT JSON_OBJECT('name',COLUMN_NAME,'type',COLUMN_TYPE,'nullable',IS_NULLABLE='YES','default',COLUMN_DEFAULT,'extra',EXTRA,'comment',COLUMN_COMMENT,'charset',CHARACTER_SET_NAME,'collation',COLLATION_NAME) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='" + self.name + "' AND TABLE_NAME='" + name + "' ORDER BY ORDINAL_POSITION;", **kw)
            columns = {}
            for col in cols:
                cname = col.pop('name')
                ident(cname)
                col['nullable'] = bool(col['nullable'])
                if col['default'] is None and not col['nullable']:
                    del col['default']
                columns[cname] = col
            indexes = self._json("SELECT JSON_OBJECT('name',INDEX_NAME,'unique',NON_UNIQUE=0,'position',SEQ_IN_INDEX,'column',COLUMN_NAME,'collation',COLLATION,'prefix',SUB_PART,'nullable',NULLABLE,'type',INDEX_TYPE,'comment',INDEX_COMMENT,'visible',IS_VISIBLE,'expression',EXPRESSION) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='" + self.name + "' AND TABLE_NAME='" + name + "' ORDER BY INDEX_NAME,SEQ_IN_INDEX;", **kw)
            fks = self._json("SELECT JSON_OBJECT('name',k.CONSTRAINT_NAME,'position',k.ORDINAL_POSITION,'column',k.COLUMN_NAME,'schema',k.REFERENCED_TABLE_SCHEMA,'table',k.REFERENCED_TABLE_NAME,'target',k.REFERENCED_COLUMN_NAME,'update',r.UPDATE_RULE,'delete',r.DELETE_RULE,'match',r.MATCH_OPTION) FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.TABLE_SCHEMA='" + self.name + "' AND k.TABLE_NAME='" + name + "' ORDER BY k.CONSTRAINT_NAME,k.ORDINAL_POSITION;", **kw)
            require(all(fk['schema'] == self.name for fk in fks), 'Cross-database foreign key refused')
            for fk in fks:
                del fk['schema']
            tables[name] = {'createSQL': create, 'columns': columns, 'indexes': indexes, 'foreignKeys': fks, 'options': row}
        return {'tables': tables}

    def _counts(self, snapshot, **kwargs):
        return {name: int(self._mysql('SELECT COUNT(*) FROM ' + ident(name) + ';', **kwargs).strip()) for name in snapshot['tables']}

    def _private_dir(self):
        path = Path(self.release.state) / 'test-backups'
        if not path.exists():
            path.mkdir(mode=0o700)
        st = path.lstat()
        require(stat.S_ISDIR(st.st_mode) and not path.is_symlink() and st.st_uid == os.geteuid() and stat.S_IMODE(st.st_mode) == 0o700, 'Unsafe backup directory')
        return path

    @staticmethod
    def _checksum(path):
        sha = hashlib.sha256()
        with path.open('rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                sha.update(block)
        return sha.hexdigest()

    def _reset(self, **kwargs):
        # Identifiers are fixed at construction, never accepted from backup SQL.
        self._mysql('DROP DATABASE ' + ident(self.name) + '; CREATE DATABASE ' + ident(self.name) + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;', database=False, **kwargs)

    def _verify_scratch(self, path, snapshot, counts):
        self.progress('db-backup-verify')
        password = secrets.token_urlsafe(32)
        env = dict(self.release.env)
        env['MYSQL_ROOT_PASSWORD'] = password
        cid = None
        try:
            # tmpfs shadows image VOLUME: no host mounts, persistent volumes, ports or networks.
            # --pull=never plus exact live image ID prevents substituting an image.
            with tempfile.TemporaryFile() as out:
                result = subprocess.run([self.docker, 'create', '--pull=never', '--network=none', '--label', 'dsh.backup-verification=1', '--tmpfs', '/var/lib/mysql:rw,nosuid,nodev,size=2147483648', '-e', 'MYSQL_ROOT_PASSWORD', self.image, '--skip-networking', '--mysqlx=OFF'], env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.DEVNULL, timeout=60, check=False)
                require(result.returncode == 0, 'Cannot create isolated backup verifier')
                out.seek(0)
                cid = out.read(128).decode().strip()
            require(re.fullmatch('[a-f0-9]{64}', cid), 'Invalid isolated verifier identity')
            self._command(['start', cid])
            for attempt in range(60):
                try:
                    self._mysql('SELECT 1;', container=cid, password=password, database=False)
                    break
                except DatabaseError:
                    if attempt == 59:
                        raise DatabaseError('Isolated verifier did not become ready')
                    time.sleep(1)
            kw = {'container': cid, 'password': password}
            self._mysql('CREATE DATABASE ' + ident(self.name) + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;', database=False, **kw)
            with path.open('rb') as source:
                self._mysql(source=source, **kw)
            require(self.snapshot(cid, password) == snapshot and self._counts(snapshot, **kw) == counts, 'Backup recovery verification mismatch')
        finally:
            if cid is not None and re.fullmatch('[a-f0-9]{64}', cid):
                self._command(['rm', '-f', '-v', cid])

    def backup(self, jobId):
        require(self.environment == 'test' and type(jobId) is str and re.fullmatch('[a-f0-9]{32}', jobId), 'Test backup job required')
        self.progress('db-backup')
        self._quiescent()
        snapshot = self.snapshot()
        counts = self._counts(snapshot)
        created = time.time_ns()
        directory = self._private_dir()
        path = directory / (str(created) + '-' + jobId + '.sql')
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'wb') as output:
                self._command(['exec', '-e', 'MYSQL_PWD', self.container, 'mysqldump', '--no-defaults', '--user=root', '--default-character-set=utf8mb4', '--lock-all-tables', '--quick', '--hex-blob', '--set-gtid-purged=OFF', '--no-tablespaces', '--skip-triggers', '--skip-add-locks', '--skip-comments', self.name], output=output, password=self.password, timeout=1800)
                output.flush()
                os.fsync(output.fileno())
            self._quiescent()
            require(self.snapshot() == snapshot and self._counts(snapshot) == counts, 'Database changed during backup')
            checksum = self._checksum(path)
            self._verify_scratch(path, snapshot, counts)
            require(self._checksum(path) == checksum, 'Backup changed during validation')
        except Exception:
            # Only remove our exact newly-created candidate; retain all older backups.
            if path.exists():
                path.unlink()
            raise
        result = {'id': path.stem, 'createdAt': created // 1000000000, 'checksum': checksum, 'path': str(path), 'database': self.name, 'project': self.release.projects['test'], 'schema': snapshot, 'counts': counts, 'verified': True}
        # Only private files with the exact managed timestamp/job naming convention.
        candidates = []
        for candidate in directory.iterdir():
            if re.fullmatch(r'[0-9]{19,20}-[a-f0-9]{32}\.sql', candidate.name):
                st = candidate.lstat()
                require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.geteuid() and stat.S_IMODE(st.st_mode) == 0o600, 'Unsafe managed backup file')
                candidates.append(candidate)
        newest = max(candidates, key=lambda p: int(p.name.split('-')[0]))
        require(newest == path, 'Backup clock ordering requires manual review; no backups removed')
        self.progress('db-backup-cleanup')
        for candidate in candidates:
            if candidate != newest:
                candidate.unlink()
        return result

    @staticmethod
    def _strict_sql():
        return "SET SESSION sql_mode='STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';\n"

    def apply(self, sqls):
        require(self.environment == 'test' and type(sqls) is list and all(type(sql) is str and sql and '\x00' not in sql for sql in sqls), 'Trusted test SQL list required')
        self._quiescent()
        # SQL comes exclusively from the trusted schema planner, never a member request.
        if sqls:
            self._mysql(self._strict_sql() + '\n'.join(sql.rstrip(';') + ';' for sql in sqls))

    def _validated_backup(self, backup):
        """Check managed backup identity, permissions and checksum without mutation."""
        require(self.environment == 'test' and type(backup) is dict and backup.get('verified') is True and backup.get('database') == self.name and backup.get('project') == self.release.projects['test'], 'Backup database identity mismatch')
        require(type(backup.get('id')) is str and re.fullmatch(r'[0-9]{19,20}-[a-f0-9]{32}', backup['id']), 'Invalid managed backup identity')
        path = self._private_dir() / (backup['id'] + '.sql')
        require(str(path) == backup.get('path'), 'Backup path mismatch')
        st = path.lstat()
        require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.geteuid() and stat.S_IMODE(st.st_mode) == 0o600, 'Unsafe backup file')
        require(self._checksum(path) == backup.get('checksum'), 'Backup checksum mismatch')
        require(type(backup.get('schema')) is dict and type(backup.get('counts')) is dict, 'Backup verification metadata missing')
        return path

    def restore(self, backup):
        path = self._validated_backup(backup)
        self._quiescent()
        self._verify_scratch(path, backup['schema'], backup['counts'])
        self._quiescent()
        self.progress('db-restoring')
        # Recreate the exact controlled schema: this removes tables added by partial DDL.
        self._reset()
        with path.open('rb') as source:
            self._mysql(source=source)
        require(self.snapshot() == backup['schema'] and self._counts(backup['schema']) == backup['counts'], 'Restored database verification mismatch')
