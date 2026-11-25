"""Private MySQL 8 helper. Only trusted release code may supply SQL/backup metadata.
No command output is logged; failures deliberately discard server diagnostics.
Caller holds operation lock and stops api/web throughout backup/apply/restore.
Supported recovery boundary: InnoDB base tables, no views/routines/events/triggers.
"""
import copy
import hashlib
import ipaddress
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


def canonical_schema(schema):
    schema = copy.deepcopy(schema)
    for table in schema.get('tables', {}).values():
        table['createSQL'] = canonical_create(table['createSQL'], table['columns'], table['options'])
    return schema


def canonical_create(create, columns, row):
    # MySQL 8 may re-emit redundant column CHARACTER SET after dump/restore.
    # Normalize only that exact structural prefix when it equals the table
    # charset; never rewrite SQL literals, defaults, comments or other DDL.
    lines = create.split('\n')
    for cname, col in columns.items():
        charset, collation = col.get('charset'), col.get('collation')
        if not (type(charset) is str and type(collation) is str
                and str(row.get('collation', '')).startswith(charset + '_')):
            continue
        prefix = '  ' + ident(cname) + ' ' + col['type']
        explicit = prefix + ' CHARACTER SET ' + charset + ' COLLATE ' + collation
        implicit = prefix + ' COLLATE ' + collation
        lines = [implicit + line[len(explicit):] if line.startswith(explicit)
                 and line[len(explicit):len(explicit) + 1] in ('', ' ', ',') else line for line in lines]
    create = '\n'.join(lines)
    return create


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

    def _network_row(self):
        rows = json.loads(self._command(['inspect', self.container]))
        require(type(rows) is list and len(rows) == 1 and rows[0].get('Id') == self.container
                and rows[0].get('Image') == self.image, 'Database network identity unavailable')
        return rows[0]

    def _lease_directory(self, create=False):
        # Preflight never creates files. The release engine already owns state as root.
        path = Path(self.release.state) / 'test-backups'
        if not path.exists():
            require(not path.is_symlink(), 'Unsafe network isolation directory')
            return self._private_dir() if create else None
        st = path.lstat()
        require(stat.S_ISDIR(st.st_mode) and not path.is_symlink() and st.st_uid == os.geteuid()
                and stat.S_IMODE(st.st_mode) == 0o700, 'Unsafe network isolation directory')
        return path

    def _lease_files(self):
        directory = self._lease_directory()
        return list(directory.glob('network-lease-*.json')) if directory is not None else []

    def _read_network_lease(self, path):
        st = path.lstat()
        require(stat.S_ISREG(st.st_mode) and not path.is_symlink() and st.st_uid == os.geteuid()
                and st.st_nlink == 1 and stat.S_IMODE(st.st_mode) == 0o600 and st.st_size <= 32768,
                'Unsafe network isolation lease')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            current = os.fstat(fd)
            require((current.st_dev, current.st_ino, current.st_nlink, current.st_uid, current.st_mode, current.st_size)
                    == (st.st_dev, st.st_ino, st.st_nlink, st.st_uid, st.st_mode, st.st_size),
                    'Network isolation lease changed')
            with os.fdopen(fd, 'r') as source:
                fd = None
                lease = json.load(source)
        except (ValueError, UnicodeError):
            raise DatabaseError('Invalid network isolation lease') from None
        finally:
            if fd is not None:
                os.close(fd)
        require(type(lease) is dict and set(lease) == {'version', 'phase', 'token', 'container', 'image', 'database', 'project', 'network', 'endpoint', 'ports', 'bindings', 'mode'}
                and lease.get('phase') in ('prepared', 'disconnecting', 'detached', 'connecting', 'restored')
                and lease['version'] == 1 and type(lease.get('token')) is str and re.fullmatch(r'[a-f0-9]{64}', lease['token'])
                and lease['container'] == self.container and lease['image'] == self.image
                and lease['database'] == self.name and lease['project'] == self.release.projects[self.environment]
                and path.name == 'network-lease-' + self.container + '.json', 'Network isolation lease identity mismatch')
        self._lease_endpoint(lease)
        return lease

    @staticmethod
    def _network_name(value):
        return type(value) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,252}', value) is not None

    def _lease_endpoint(self, lease):
        network, endpoint = lease.get('network'), lease.get('endpoint')
        require(type(network) is dict and set(network) == {'id', 'name'}
                and type(network.get('id')) is str and re.fullmatch(r'[a-f0-9]{64}', network['id']) and self._network_name(network.get('name'))
                and lease.get('mode') in (network['id'], network['name']), 'Invalid leased network identity')
        require(type(endpoint) is dict and set(endpoint) == {'aliases', 'ipv4', 'ipv6'}
                and type(endpoint['aliases']) is list and len(endpoint['aliases']) <= 64
                and all(self._network_name(alias) for alias in endpoint['aliases'])
                and len(set(endpoint['aliases'])) == len(endpoint['aliases']), 'Invalid leased network endpoint')
        for field, version in (('ipv4', 4), ('ipv6', 6)):
            value = endpoint[field]
            require(type(value) is str, 'Invalid leased network address')
            if not value:
                continue
            try:
                address = ipaddress.ip_address(value)
            except ValueError:
                raise DatabaseError('Invalid leased network address') from None
            require(address.version == version and str(address) == value and not (address.is_unspecified
                    or address.is_multicast or address.is_loopback or address.is_link_local), 'Invalid leased network address')
        require(endpoint['ipv4'] or endpoint['ipv6'], 'Leased network address missing')
        self._loopback_ports(lease.get('ports'), lease.get('bindings'))

    @staticmethod
    def _loopback_ports(ports, bindings):
        require(type(ports) is dict and type(bindings) is dict, 'Invalid database port evidence')
        for mapping in (ports, bindings):
            for port, entries in mapping.items():
                require(type(port) is str and re.fullmatch(r'[0-9]{1,5}/(?:tcp|udp)', port), 'Invalid database port evidence')
                if entries is None:
                    continue
                require(type(entries) is list and len(entries) <= 8, 'Invalid database port evidence')
                for entry in entries:
                    require(type(entry) is dict and set(entry) == {'HostIp', 'HostPort'}
                            and entry['HostIp'] in ('127.0.0.1', '::1') and type(entry['HostPort']) is str
                            and entry['HostPort'].isdecimal() and 1 <= int(entry['HostPort']) <= 65535,
                            'Only loopback database publishing can be isolated')

    def _network_evidence(self, row, network_id=None, network_name=None, detached=False):
        networks = row.get('NetworkSettings', {}).get('Networks')
        require(type(networks) is dict, 'Database network evidence unavailable')
        if not detached:
            require(len(networks) == 1, 'Dedicated Compose database network required')
            network_name, endpoint = next(iter(networks.items()))
            network_id = endpoint.get('NetworkID')
        require(type(network_id) is str and re.fullmatch(r'[a-f0-9]{64}', network_id)
                and self._network_name(network_name), 'Invalid database network identity')
        require(row.get('HostConfig', {}).get('NetworkMode') in (network_id, network_name),
                'Uncontrolled database network mode')
        evidence = json.loads(self._command(['network', 'inspect', network_id]))
        require(type(evidence) is list and len(evidence) == 1, 'Database network inspection unavailable')
        net = evidence[0]
        require(net.get('Id') == network_id and net.get('Name') == network_name and net.get('Driver') == 'bridge'
                and net.get('Scope') == 'local' and not net.get('Ingress') and not net.get('ConfigOnly')
                and net.get('Labels', {}).get('com.docker.compose.project') == self.release.projects[self.environment]
                and type(net.get('Containers')) is dict, 'Uncontrolled Compose database network')
        allowed = {self.container}
        services = {}
        for service in ('api', 'web'):
            ids = self.release.compose(self.environment, ['ps', '-a', '-q', service], override=self.release.active_override(self.environment)).split()
            require(len(ids) == 1 and re.fullmatch(r'[a-f0-9]{64}', ids[0]), 'Application network identity unavailable')
            allowed.add(ids[0])
            require(ids[0] not in services and ids[0] != self.container, 'Application network identity mismatch')
            services[ids[0]] = service
        require(set(net['Containers']) <= allowed and (detached or self.container in net['Containers']),
                'Other network clients prevent controlled database recovery')
        for cid in net['Containers']:
            if cid == self.container:
                continue
            peers = json.loads(self._command(['inspect', cid]))
            require(type(peers) is list and len(peers) == 1 and peers[0].get('Id') == cid, 'Application network evidence unavailable')
            peer = peers[0]
            labels = peer.get('Config', {}).get('Labels', {})
            require(labels.get('com.docker.compose.project') == self.release.projects[self.environment]
                    and labels.get('com.docker.compose.service') == services[cid]
                    and peer.get('HostConfig', {}).get('NetworkMode') not in ('host', 'none', 'container')
                    and not str(peer.get('HostConfig', {}).get('NetworkMode', '')).startswith('container:')
                    and any(item.get('NetworkID') == network_id for item in peer.get('NetworkSettings', {}).get('Networks', {}).values()),
                    'Application network identity mismatch')
        return net

    def _attached_lease(self, row):
        net = self._network_evidence(row)
        network_name, ep = next(iter(row['NetworkSettings']['Networks'].items()))
        require(type(ep) is dict and (ep.get('Aliases') is None or type(ep['Aliases']) is list)
                and all(type(alias) is str for alias in (ep.get('Aliases') or []))
                and (ep.get('IPAMConfig') is None or type(ep['IPAMConfig']) is dict), 'Invalid database endpoint evidence')
        require(not ep.get('Links') and not ep.get('DriverOpts') and not (ep.get('IPAMConfig') or {}).get('LinkLocalIPs'),
                'Unsupported database endpoint options')
        lease = {'version': 1, 'phase': 'prepared', 'token': secrets.token_hex(32), 'container': self.container, 'image': self.image,
                 'database': self.name, 'project': self.release.projects[self.environment],
                 'network': {'id': net['Id'], 'name': net['Name']},
                 'endpoint': {'aliases': sorted(ep.get('Aliases') or []), 'ipv4': ep.get('IPAddress') or '', 'ipv6': ep.get('GlobalIPv6Address') or ''},
                 'ports': row.get('NetworkSettings', {}).get('Ports') or {},
                 'bindings': row.get('HostConfig', {}).get('PortBindings') or {}, 'mode': row['HostConfig']['NetworkMode']}
        self._lease_endpoint(lease)
        for field, version in (('ipv4', 4), ('ipv6', 6)):
            if not lease['endpoint'][field]:
                continue
            address = ipaddress.ip_address(lease['endpoint'][field])
            subnets = [item.get('Subnet', '') for item in net.get('IPAM', {}).get('Config', [])]
            try:
                require(any(address in ipaddress.ip_network(subnet, strict=False) for subnet in subnets
                            if subnet and ipaddress.ip_network(subnet, strict=False).version == version),
                        'Database address outside controlled network')
            except ValueError:
                raise DatabaseError('Invalid controlled network address range') from None
        return lease

    def _network_phase(self, path, lease, phase):
        require(self._read_network_lease(path) == lease, 'Network isolation lease changed')
        updated = dict(lease, phase=phase)
        temporary = path.parent / ('network-phase-' + secrets.token_hex(16) + '.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'w') as target:
                json.dump(updated, target, sort_keys=True, separators=(',', ':'))
                target.flush()
                os.fsync(target.fileno())
            require(self._read_network_lease(path) == lease, 'Network isolation lease changed')
            os.replace(temporary, path)
            self._sync_directory(path.parent)
        finally:
            if temporary.exists():
                temporary.unlink()
        self._network_lease = updated
        return updated

    def _owned_network_lease(self):
        files = self._lease_files()
        lease = getattr(self, '_network_lease', None)
        require(len(files) == 1 and lease is not None, 'Database network isolation lease requires recovery')
        require(self._read_network_lease(files[0]) == lease, 'Database network isolation lease changed')
        return files[0], lease

    def _detached_evidence(self, row, lease):
        require(row.get('HostConfig', {}).get('NetworkMode') == lease['mode']
                and row.get('NetworkSettings', {}).get('Networks') == {}, 'Database network isolation incomplete')
        # Docker can retain static port metadata while no endpoint/TCP path exists.
        ports = row.get('NetworkSettings', {}).get('Ports')
        ports = {} if ports is None else ports
        require(type(ports) is dict and (not any(ports.values()) or ports == lease['ports']),
                'Database port evidence changed during isolation')
        require((row.get('HostConfig', {}).get('PortBindings') or {}) == lease['bindings'], 'Database port bindings changed during isolation')

    def preflight(self):
        self._check_identity()
        files = self._lease_files()
        if files:
            _, lease = self._owned_network_lease()
            require(lease['phase'] == 'detached', 'Database network command outcome requires manual verification')
            self._detached_evidence(self._network_row(), lease)
            self._network_evidence(self._network_row(), lease['network']['id'], lease['network']['name'], detached=True)
        else:
            self._attached_lease(self._network_row())
        self._supported()
        self._database_isolation_evidence(require_no_writers=False)

    def isolate_network(self):
        require(self.environment == 'test', 'Only test database network can be isolated')
        self._writers_stopped()
        self.preflight()
        if self._lease_files():
            self._owned_network_lease()
            return
        row = self._network_row()
        lease = self._attached_lease(row)
        directory = self._lease_directory(create=True)
        path = directory / ('network-lease-' + self.container + '.json')
        data = json.dumps(lease, sort_keys=True, separators=(',', ':')).encode('utf-8')
        require(len(data) <= 32768, 'Network isolation lease too large')
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        self._sync_directory(directory)
        self._network_lease = lease
        lease = self._network_phase(path, lease, 'disconnecting')
        # An in-flight command can outlive its CLI: never infer completion from a
        # later snapshot after timeout, process loss or other ambiguous failure.
        self._command(['network', 'disconnect', lease['network']['id'], self.container], timeout=60)
        self._check_identity()
        self._detached_evidence(self._network_row(), lease)
        self._network_phase(path, lease, 'detached')

    def restore_network(self):
        files = self._lease_files()
        if not files:
            require(getattr(self, '_network_lease', None) is None, 'Network isolation lease missing')
            return
        require(len(files) == 1, 'Multiple network isolation leases require recovery')
        lease = self._read_network_lease(files[0])
        owned = getattr(self, '_network_lease', None)
        require(owned is None or owned == lease, 'Network isolation lease changed')
        self._network_lease = lease
        require(lease['phase'] in ('prepared', 'detached', 'restored'),
                'Database network command outcome requires manual verification')
        self._check_identity()
        row = self._network_row()
        self._network_evidence(row, lease['network']['id'], lease['network']['name'], detached=True)
        networks = row.get('NetworkSettings', {}).get('Networks')
        if lease['phase'] == 'detached':
            self._detached_evidence(row, lease)
            args = ['network', 'connect']
            for alias in lease['endpoint']['aliases']:
                args += ['--alias', alias]
            if lease['endpoint']['ipv4']:
                args += ['--ip', lease['endpoint']['ipv4']]
            if lease['endpoint']['ipv6']:
                args += ['--ip6', lease['endpoint']['ipv6']]
            args += [lease['network']['id'], self.container]
            lease = self._network_phase(files[0], lease, 'connecting')
            self._command(args, timeout=60)
            self._check_identity()
            row = self._network_row()
        require(type(networks) is dict, 'Database network restoration evidence unavailable')
        actual = self._attached_lease(row)
        require(actual['network'] == lease['network'] and actual['endpoint'] == lease['endpoint']
                and actual['ports'] == lease['ports'] and actual['bindings'] == lease['bindings']
                and actual['mode'] == lease['mode'], 'Database network restoration verification failed')
        lease = self._network_phase(files[0], lease, 'restored')
        files[0].unlink()
        self._sync_directory(files[0].parent)
        self._network_lease = None

    def _network_boundary(self):
        if self._lease_files():
            _, lease = self._owned_network_lease()
            require(lease['phase'] == 'detached', 'Database network command outcome requires manual verification')
            self._detached_evidence(self._network_row(), lease)
            return
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
        self._cleanup_owned_routines()
        self._supported()
        self._database_isolation_evidence(require_no_writers=True)

    def _database_isolation_evidence(self, require_no_writers):
        inbound = self._json("SELECT JSON_OBJECT('n',COUNT(*)) FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA='" + self.name + "' AND TABLE_SCHEMA<>'" + self.name + "';")
        require(len(inbound) == 1 and type(inbound[0].get('n')) is int and inbound[0]['n'] == 0, 'Incoming cross-database foreign key refused')
        rows = self._json("SELECT JSON_OBJECT('events',@@GLOBAL.event_scheduler,'eventCount',(SELECT COUNT(*) FROM information_schema.EVENTS),'writers',(SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() AND USER NOT IN ('system user','event_scheduler')));")
        require(len(rows) == 1 and rows[0].get('events') in ('ON', 'OFF', 'DISABLED')
                and type(rows[0].get('eventCount')) is int and rows[0]['eventCount'] >= 0
                and type(rows[0].get('writers')) is int and rows[0]['writers'] >= 0,
                'Database isolation check failed: invalid evidence')
        row = rows[0]
        require(not require_no_writers or row['writers'] == 0, 'Database isolation check failed: other sessions')
        # ON alone cannot write: retain the instance-wide boundary when events exist.
        require(row['events'] != 'ON' or row['eventCount'] == 0,
                'Database isolation check failed: scheduler has events')

    def snapshot(self, _container=None, _password=None):
        if _container is None:
            self._check_identity()
        kw = {'container': _container, 'password': _password}
        self._supported(**kw)
        names = self._json("SELECT JSON_OBJECT('name',TABLE_NAME,'engine',ENGINE,'collation',TABLE_COLLATION,'comment',TABLE_COMMENT,'options',CREATE_OPTIONS) FROM information_schema.TABLES WHERE TABLE_SCHEMA='" + self.name + "' ORDER BY TABLE_NAME;", **kw)
        require(len(names) <= 256 and len({row['name'] for row in names}) == len(names), 'Invalid schema table list')
        for row in names:
            ident(row['name'])
        groups = {key: {row['name']: [] for row in names} for key in ('cols', 'indexes', 'fks')}
        for item in self._json("SELECT JSON_OBJECT('_table',TABLE_NAME,'name',COLUMN_NAME,'type',COLUMN_TYPE,'nullable',IS_NULLABLE='YES','default',COLUMN_DEFAULT,'extra',EXTRA,'comment',COLUMN_COMMENT,'charset',CHARACTER_SET_NAME,'collation',COLLATION_NAME) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='" + self.name + "' ORDER BY TABLE_NAME,ORDINAL_POSITION;", **kw):
            table = item.pop('_table')
            require(table in groups['cols'], 'Schema metadata table mismatch')
            groups['cols'][table].append(item)
        for item in self._json("SELECT JSON_OBJECT('_table',TABLE_NAME,'name',INDEX_NAME,'unique',NON_UNIQUE=0,'position',SEQ_IN_INDEX,'column',COLUMN_NAME,'collation',COLLATION,'prefix',SUB_PART,'nullable',NULLABLE,'type',INDEX_TYPE,'comment',INDEX_COMMENT,'visible',IS_VISIBLE,'expression',EXPRESSION) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='" + self.name + "' ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX;", **kw):
            table = item.pop('_table')
            require(table in groups['indexes'], 'Schema metadata table mismatch')
            groups['indexes'][table].append(item)
        for item in self._json("SELECT JSON_OBJECT('_table',k.TABLE_NAME,'name',k.CONSTRAINT_NAME,'position',k.ORDINAL_POSITION,'column',k.COLUMN_NAME,'schema',k.REFERENCED_TABLE_SCHEMA,'table',k.REFERENCED_TABLE_NAME,'target',k.REFERENCED_COLUMN_NAME,'update',r.UPDATE_RULE,'delete',r.DELETE_RULE,'match',r.MATCH_OPTION) FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.TABLE_SCHEMA='" + self.name + "' ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION;", **kw):
            table = item.pop('_table')
            require(table in groups['fks'], 'Schema metadata table mismatch')
            groups['fks'][table].append(item)
        marker = 'DSH_SCHEMA_' + secrets.token_hex(24)
        shown = self._mysql(''.join("SELECT '" + marker + "'; SHOW CREATE TABLE " + ident(row['name']) + ';\n' for row in names) + "SELECT '" + marker + "';", **kw)
        parts = shown.split(marker + '\n')
        require(len(parts) == len(names) + 2 and parts[0] == '' and parts[-1] == '', 'Invalid batched SHOW CREATE framing')
        tables = {}
        for row, shown in zip(names, parts[1:-1]):
            name = row.pop('name')
            require(shown.startswith(name + '\t'), 'Invalid SHOW CREATE output')
            create = shown[len(name) + 1:].rstrip('\n')
            create = re.sub(r' AUTO_INCREMENT=[0-9]+(?= |$)', '', create)
            cols = groups['cols'][name]
            columns = {}
            for col in cols:
                cname = col.pop('name')
                ident(cname)
                col['nullable'] = bool(col['nullable'])
                if col['default'] is None and not col['nullable']:
                    del col['default']
                columns[cname] = col
            create = canonical_create(create, columns, row)
            indexes = groups['indexes'][name]
            fks = groups['fks'][name]
            require(all(fk['schema'] == self.name for fk in fks), 'Cross-database foreign key refused')
            for fk in fks:
                del fk['schema']
            tables[name] = {'createSQL': create, 'columns': columns, 'indexes': indexes, 'foreignKeys': fks, 'options': row}
        if _container is None:
            self._check_identity()
        return {'tables': tables}

    def _counts(self, snapshot, **kwargs):
        return {name: int(self._mysql('SELECT COUNT(*) FROM ' + ident(name) + ';', **kwargs).strip()) for name in snapshot['tables']}

    def _highwater(self, schema, **kwargs):
        result = {}
        for name, table in schema['tables'].items():
            columns = [column for column, meta in table['columns'].items() if 'auto_increment' in meta.get('extra', '').lower()]
            if not columns:
                continue
            rows = self._json("SELECT JSON_OBJECT('value',CAST(AUTO_INCREMENT AS CHAR)) FROM information_schema.TABLES WHERE TABLE_SCHEMA='" + self.name + "' AND TABLE_NAME='" + name + "';", **kwargs)
            require(len(rows) == 1 and type(rows[0].get('value')) is str and re.fullmatch(r'[0-9]{1,20}', rows[0]['value']), 'Auto increment metadata unavailable')
            result[name] = {'column': columns[0], 'value': int(rows[0]['value'])}
        return result

    def _restore_highwater(self, schema, highwater, **kwargs):
        if not highwater:
            return
        current = self._highwater(schema, **kwargs)
        for name, saved in highwater.items():
            require(type(saved) is dict and type(saved.get('value')) is int and 1 <= saved['value'] <= 18446744073709551615, 'Invalid auto increment highwater')
            if name in current and current[name]['column'] == saved.get('column') and current[name]['value'] < saved['value']:
                self._mysql('ALTER TABLE ' + ident(name) + ' AUTO_INCREMENT=' + str(saved['value']) + ';', **kwargs)
        verified = self._highwater(schema, **kwargs)
        require(all(name not in verified or verified[name]['column'] != saved.get('column') or verified[name]['value'] >= saved['value'] for name, saved in highwater.items()), 'Auto increment highwater verification failed')

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

    def _verify_scratch(self, path, snapshot, counts, action=None):
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
            if action is not None:
                return action(kw)
        finally:
            if cid is not None and re.fullmatch('[a-f0-9]{64}', cid):
                self._command(['rm', '-f', '-v', cid])

    def backup(self, jobId):
        require(self.environment == 'test' and type(jobId) is str and re.fullmatch('[a-f0-9]{32}', jobId), 'Test backup job required')
        self.progress('db-backup')
        self._quiescent()
        snapshot = self.snapshot()
        counts = self._counts(snapshot)
        highwater = self._highwater(snapshot)
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
            require(self.snapshot() == snapshot and self._counts(snapshot) == counts and self._highwater(snapshot) == highwater, 'Database changed during backup')
            checksum = self._checksum(path)
            self._verify_scratch(path, snapshot, counts)
            require(self._checksum(path) == checksum, 'Backup changed during validation')
        except Exception:
            # Only remove our exact newly-created candidate; retain all older backups.
            if path.exists():
                path.unlink()
            raise
        result = {'id': path.stem, 'createdAt': created // 1000000000, 'checksum': checksum, 'path': str(path), 'database': self.name, 'project': self.release.projects['test'], 'schema': snapshot, 'counts': counts, 'highwater': highwater, 'verified': True}
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
        # A migration is a durable reference to its original complete backup.
        # Fail closed on damaged manifests rather than deleting recovery evidence.
        retained = self._migration_backup_ids()
        # Full original backups are durable recovery evidence. Retention pruning
        # requires a separate explicit operator policy; never keep only latest.
        require(all(type(value) is str for value in retained), 'Invalid migration backup references')
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

    # Manifests never leave this private directory. Public projections below are
    # deliberately constructed field-by-field, not by subtracting sensitive keys.
    MAX_ROWS = 10000
    MAX_MIGRATION_BYTES = 16 * 1024 * 1024
    MAX_ROW_BYTES = 1024 * 1024
    MAX_SECONDS = 1800
    ROW_ERRORS = {1048: 'required_value', 1062: 'unique_conflict',
                  1264: 'out_of_range', 1265: 'invalid_value', 1292: 'invalid_value',
                  1364: 'required_value', 1365: 'division_by_zero', 1366: 'invalid_value',
                  1690: 'expression_out_of_range',
                  1406: 'value_too_long', 1452: 'foreign_key', 3819: 'check_constraint',
                  3037: 'invalid_value', 3643: 'invalid_value',
                  3140: 'invalid_json', 3141: 'invalid_json', 3144: 'invalid_json',
                  3146: 'invalid_json', 3150: 'invalid_json'}

    def _migration_path(self, migration_id):
        require(type(migration_id) is str and re.fullmatch(r'[a-f0-9]{32}', migration_id), 'Invalid migration identity')
        return self._private_dir() / ('migration-' + migration_id + '.json')

    def _read_migration(self, migration_id):
        path = self._migration_path(migration_id)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as source:
            st = os.fstat(source.fileno())
            require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.geteuid()
                    and stat.S_IMODE(st.st_mode) == 0o600 and st.st_size <= self.MAX_MIGRATION_BYTES, 'Unsafe migration file')
            try:
                document = json.load(source)
            except (ValueError, UnicodeError):
                raise DatabaseError('Invalid private migration manifest') from None
        require(type(document) is dict and document.get('migrationId') == migration_id
                and document.get('database') == self.name and document.get('project') == self.release.projects['test']
                and type(document.get('rows')) is list, 'Migration identity mismatch')
        return document

    def _save_migration(self, document):
        payload = json.dumps(document, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode()
        require(len(payload) <= self.MAX_MIGRATION_BYTES, 'Migration capacity exceeded')
        path = self._migration_path(document['migrationId'])
        temporary = path.parent / ('.migration-' + secrets.token_hex(16))
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'wb') as target:
                target.write(payload)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, path)
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if temporary.exists():
                temporary.unlink()

    def _migration_backup_ids(self):
        retained = set()
        for path in self._private_dir().iterdir():
            if re.fullmatch(r'migration-[a-f0-9]{32}\.json', path.name):
                document = self._read_migration(path.stem[len('migration-'):])
                # Keep complete backups even after all rows are imported: the
                # original records and their schema remain the recovery boundary.
                if document.get('backup') is not None:
                    retained.add(document['backup']['id'])
        return retained

    def _summary(self, document):
        rows = document['rows']
        return {'migrationId': document['migrationId'], 'status': document['status'],
                'total': len(rows), 'imported': sum(row['status'] == 'imported' for row in rows),
                'pending': sum(row['status'] != 'imported' for row in rows),
                'details': [self._public_row(row) for row in rows if row['status'] != 'imported'][:50]}

    @staticmethod
    def _public_row(row):
        return {'rowId': row['rowId'], 'table': row['table'], 'status': row['status'],
                'failedFields': row.get('failedFields', []), 'errorCode': row.get('errorCode'),
                'reason': row.get('reason', 'imported')}

    def migration_report(self, migrationId, offset=0, limit=50):
        require(self.environment == 'test', 'Test migration required')
        require(type(offset) is int and 0 <= offset <= self.MAX_ROWS
                and type(limit) is int and 1 <= limit <= 100, 'Invalid migration pagination')
        document = self._read_migration(migrationId)
        result = self._summary(document)
        result['details'] = [self._public_row(row) for row in document['rows'][offset:offset + limit]]
        result.update({'offset': offset, 'limit': limit, 'hasMore': offset + limit < len(document['rows']), 'nextOffset': offset + limit if offset + limit < len(document['rows']) else None})
        return result

    @staticmethod
    def _generated(column):
        return bool(re.search(r'\b(?:VIRTUAL|STORED) GENERATED\b', column.get('extra', ''), re.I))

    def _create_schema(self, schema, **kwargs):
        require(type(schema) is dict and type(schema.get('tables')) is dict and len(schema['tables']) <= 256, 'Trusted complete schema required')
        sqls = []
        for name, table in schema['tables'].items():
            q = ident(name)
            create = table.get('createSQL')
            # This is provenance/identity checking of trusted SHOW CREATE, not a
            # generic SQL parser or a column whitelist that blocks new dev DDL.
            require(type(create) is str and create.startswith('CREATE TABLE ' + q + ' (') and '\x00' not in create,
                    'Trusted SHOW CREATE required')
            require(type(table.get('columns')) is dict, 'Schema columns missing')
            for column in table['columns']:
                ident(column)
            sqls.append(create.rstrip(';') + ';')
        self._reset(**kwargs)
        # Cyclic table definitions need FK checks disabled only during DDL. Every
        # data INSERT runs in its own session with FK checks explicitly enabled.
        self._mysql(self._strict_sql() + 'SET SESSION FOREIGN_KEY_CHECKS=0;\n' + '\n'.join(sqls)
                    + '\nSET SESSION FOREIGN_KEY_CHECKS=1;', **kwargs)
        require(self.snapshot(kwargs.get('container'), kwargs.get('password')) == schema, 'Target schema creation mismatch')

    def _source_rows(self, schema, counts, **kwargs):
        require(sum(counts.values()) <= self.MAX_ROWS, 'Migration row capacity exceeded')
        rows = []
        used = 0
        for name, table in schema['tables'].items():
            columns = list(table['columns'])
            expressions = ['IF(' + ident(column) + ' IS NULL,NULL,HEX(CAST(' + ident(column) + ' AS BINARY)))' for column in columns]
            source_columns = table['columns']
            # Read each immutable source table in a single bounded query. OFFSET
            # pagination without a unique key can duplicate or omit identical
            # records even when no writers exist. The command output cap, total
            # row cap and manifest byte cap bound this extraction before reset.
            for offset in range(0, counts[name], self.MAX_ROWS):
                batch = self._json("SET SESSION time_zone='+00:00'; SELECT JSON_ARRAY(" + ','.join(expressions) + ') FROM ' + ident(name)
                                   + ' LIMIT ' + str(self.MAX_ROWS + 1) + ';', **kwargs)
                require(len(batch) == counts[name], 'Source row count mismatch')
                for values in batch:
                    require(type(values) is list and len(values) == len(columns)
                            and all(value is None or (type(value) is str and re.fullmatch(r'(?:[A-Fa-f0-9]{2})*', value)) for value in values), 'Invalid lossless source row')
                    data = dict(zip(columns, values))
                    size = len(json.dumps(data))
                    used += size
                    require(size <= self.MAX_ROW_BYTES and used <= self.MAX_MIGRATION_BYTES // 2, 'Migration data capacity exceeded')
                    rows.append({'rowId': secrets.token_hex(16), 'table': name, 'values': data, 'sourceColumns': source_columns,
                                 'status': 'pending', 'mapping': {}, 'failedFields': [], 'errorCode': None, 'reason': 'awaiting_import'})
        require(len(rows) == sum(counts.values()), 'Source accounting mismatch')
        return rows

    @staticmethod
    def _pending(row, reason, fields=(), code=None):
        row.update(status='pending', reason=reason, failedFields=list(fields), errorCode=code)

    def _row_sql(self, row, schema):
        table = schema['tables'].get(row['table'])
        if table is None:
            self._pending(row, 'missing_target_table')
            return None
        columns = table['columns']
        changed_mapping = [name for name, value in row['mapping'].items()
                           if (name in columns and (value == {'$omit': True} or self._generated(columns[name]))) or
                           (name not in columns and value != {'$omit': True})]
        if changed_mapping:
            self._pending(row, 'requires_manual_conversion', changed_mapping)
            return None
        removed = [name for name in row['values'] if name not in columns and row['mapping'].get(name) != {'$omit': True}]
        if removed:
            self._pending(row, 'removed_source_fields', removed)
            return None
        absent_required = [name for name, column in columns.items()
                           if name not in row['values'] and name not in row['mapping']
                           and not self._generated(column) and not column.get('nullable', False)
                           and 'default' not in column and 'auto_increment' not in column.get('extra', '').lower()]
        if absent_required:
            self._pending(row, 'required_value', absent_required, 1364)
            return None
        values = {}
        for name, original in row['values'].items():
            if name in columns and not self._generated(columns[name]):
                # CONVERT forces string semantics: a bare X'3132' in a
                # numeric target context can mean hexadecimal 0x3132, not 12.
                source_column = row['sourceColumns'][name]
                charset = source_column.get('charset') or 'binary'
                require(type(charset) is str and re.fullmatch(r'[a-zA-Z0-9_]+', charset), 'Invalid source charset')
                if charset == 'binary' and not re.match(r'^(?:binary|varbinary|tinyblob|blob|mediumblob|longblob|bit|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b', source_column.get('type', ''), re.I):
                    charset = 'utf8mb4'
                if re.match(r'^(?:geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b', source_column.get('type', ''), re.I) and name not in row['mapping']:
                    self._pending(row, 'requires_manual_conversion', [name])
                    return None
                if re.match(r'^bit\b', source_column.get('type', ''), re.I):
                    values[name] = 'NULL' if original is None else "X'" + original + "'"
                else:
                    values[name] = 'NULL' if original is None else "CONVERT(X'" + original + "' USING " + charset + ')'
        for name, value in row['mapping'].items():
            if name not in columns:
                continue
            require(not self._generated(columns[name]), 'Cannot correct generated column')
            values[name] = self._correction_sql(value)
        if not values:
            return 'INSERT INTO ' + ident(row['table']) + ' () VALUES ();'
        return 'INSERT INTO ' + ident(row['table']) + ' (' + ','.join(ident(name) for name in values) + ') VALUES (' + ','.join(values.values()) + ');'

    @staticmethod
    def _correction_sql(value):
        if value is None:
            return 'NULL'
        if type(value) is dict:
            require(set(value) == {'hex'} and type(value['hex']) is str and len(value['hex']) <= 2 * Database.MAX_ROW_BYTES
                    and re.fullmatch(r'(?:[a-fA-F0-9]{2})*', value['hex']), 'Invalid binary correction')
            return "X'" + value['hex'] + "'"
        require(type(value) in (str, int, float, bool), 'Invalid correction value')
        if type(value) in (int, float):
            try:
                encoded = json.dumps(value, allow_nan=False)
            except (ValueError, OverflowError):
                raise DatabaseError('Invalid numeric correction') from None
        elif type(value) is bool:
            encoded = '1' if value else '0'
        else:
            require(len(value.encode('utf-8')) <= Database.MAX_ROW_BYTES, 'Correction too large')
            encoded = value
        return "CONVERT(X'" + encoded.encode('utf-8').hex() + "' USING utf8mb4)"

    @staticmethod
    def _sync_directory(path):
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def _cleanup_owned_routines(self):
        # Only exact durable identities from this database/image may be removed.
        for path in self._private_dir().iterdir():
            if not re.fullmatch(r'owned-routine-[a-f0-9]{24}\.json', path.name):
                continue
            st = path.lstat()
            require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.geteuid()
                    and stat.S_IMODE(st.st_mode) == 0o600 and st.st_size < 1024, 'Unsafe routine ownership file')
            with path.open() as source:
                owner = json.load(source)
            name = '_dsh_m_' + path.stem[len('owned-routine-'):]
            require(owner == {'name': name, 'database': self.name, 'container': self.container, 'image': self.image}, 'Routine ownership mismatch')
            self._mysql('DROP PROCEDURE IF EXISTS ' + ident(name) + ';')
            path.unlink()
            self._sync_directory(path.parent)

    def _insert_row(self, sql, fields, **kwargs):
        # A short-lived private stored procedure turns server diagnostics into
        # code + a validated metadata column only. MESSAGE_TEXT is never returned.
        # Warnings roll back too (e.g. lossy CHAR coercion), rather than fake success.
        token = secrets.token_hex(12)
        name = '_dsh_m_' + token
        procedure = ident(name)
        owner_path = None
        if not kwargs.get('container'):
            owner_path = self._private_dir() / ('owned-routine-' + token + '.json')
            fd = os.open(owner_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as target:
                json.dump({'name': name, 'database': self.name, 'container': self.container, 'image': self.image}, target)
                target.flush()
                os.fsync(target.fileno())
            self._sync_directory(owner_path.parent)
        field_cases = ' '.join("WHEN field_name=X'" + name.encode().hex() + "' THEN '" + name + "'" for name in fields)
        field_sql = ('CASE ' + field_cases + " ELSE '' END") if field_cases else "''"
        script = self._strict_sql() + "SET SESSION FOREIGN_KEY_CHECKS=1; SET SESSION time_zone='+00:00'; SET SESSION sql_mode=CONCAT(@@SESSION.sql_mode,',NO_AUTO_VALUE_ON_ZERO');\nDELIMITER //\nCREATE PROCEDURE " + procedure + '''() SQL SECURITY INVOKER
BEGIN
DECLARE error_number INT DEFAULT 0;
DECLARE field_name VARCHAR(64) DEFAULT '';
DECLARE EXIT HANDLER FOR SQLEXCEPTION, SQLWARNING
BEGIN
GET DIAGNOSTICS CONDITION 1 error_number=MYSQL_ERRNO,field_name=COLUMN_NAME;
ROLLBACK;
SELECT JSON_OBJECT('code',error_number,'field',FIELD_RESULT);
END;
START TRANSACTION;
''' .replace('FIELD_RESULT', field_sql) + sql + '''
COMMIT;
SELECT JSON_OBJECT('code',0,'field','');
END//
DELIMITER ;
CALL ''' + procedure + '();\nDROP PROCEDURE ' + procedure + ';'
        try:
            result = self._json(script, **kwargs)
        finally:
            # Independent connection also runs after CREATE/CALL connection loss.
            # If this fails the ownership file survives for restore/quiescent.
            self._mysql('DROP PROCEDURE IF EXISTS ' + procedure + ';', **kwargs)
            if owner_path is not None:
                owner_path.unlink()
                self._sync_directory(owner_path.parent)
        require(len(result) == 1 and type(result[0].get('code')) is int, 'Migration insert result unavailable')
        code = result[0]['code']
        require(code == 0 or code in self.ROW_ERRORS, 'Database service or migration operation failed')
        return code, [result[0]['field']] if result[0].get('field') in fields else []

    def _migrate_rows(self, document, persist=False, **kwargs):
        started = time.monotonic()
        rows, schema = document['rows'], document['schema']
        # Parent tables precede dependents. Cycles/self references get bounded
        # additional passes, retried only while another row made progress.
        ranks = {}
        visiting = set()
        def rank(name):
            if name in ranks:
                return ranks[name]
            if name in visiting:
                return 0
            visiting.add(name)
            dependencies = [fk['table'] for fk in schema['tables'].get(name, {}).get('foreignKeys', []) if fk['table'] != name]
            result = 1 + max((rank(target) for target in dependencies), default=0)
            visiting.remove(name)
            ranks[name] = result
            return result
        for name in schema['tables']:
            rank(name)
        candidates = sorted((row for row in rows if row['status'] == 'pending'), key=lambda row: ranks.get(row['table'], 0))
        for attempt in range(len(rows) + 1):
            progress, foreign = False, []
            for row in candidates:
                require(time.monotonic() - started < self.MAX_SECONDS, 'Migration time capacity exceeded')
                sql = self._row_sql(row, schema)
                if sql is None:
                    continue
                if persist:
                    # Durable intent precedes commit. A crash cannot silently
                    # repeat inserts into keyless tables or overwrite new data.
                    row['status'] = 'inflight'
                    self._save_migration(document)
                code, fields = self._insert_row(sql, list(schema['tables'][row['table']]['columns']), **kwargs)
                if code == 0:
                    row.update(status='imported', reason='imported', failedFields=[], errorCode=None)
                    progress = True
                else:
                    self._pending(row, self.ROW_ERRORS[code], fields, code)
                    if code == 1452:
                        foreign.append(row)
                if persist:
                    self._save_migration(document)
            if not progress or not foreign:
                break
            candidates = foreign
        require(sum(row['status'] in ('pending', 'imported') for row in rows) == len(rows), 'Migration accounting incomplete')
        return self._summary(document)

    @staticmethod
    def _fast_definitions(name, table):
        """Extract complete trusted SHOW CREATE column definitions, not request SQL."""
        create = table.get('createSQL')
        require(type(create) is str and create.startswith('CREATE TABLE ' + ident(name) + ' (') and '\x00' not in create, 'Trusted SHOW CREATE required')
        definitions = {}
        for line in create.splitlines()[1:-1]:
            match = re.match(r"  `([A-Za-z_][A-Za-z0-9_]*)` (.+?)(?:,)?$", line)
            if match:
                definitions[match[1]] = match[2]
        require(set(definitions) == set(table['columns']), 'Complete column definitions required')
        return definitions

    def _fast_direct_sql(self, name, source, target, whole_source, whole_target):
        # Only provable additive/growth changes use populated-table ALTER. Other
        # changes are handled by archived table conversion, not guessed casts.
        for key in ('indexes', 'foreignKeys', 'options'):
            if source[key] != target[key]:
                return None
        sc, tc = source['columns'], target['columns']
        if set(tc) - set(sc):
            return None
        definitions = self._fast_definitions(name, source)
        if [c for c in definitions if c in tc] != list(tc):
            return None
        statements, previous = [], None
        for column in definitions:
            new, old = sc[column], tc.get(column)
            position = ' FIRST' if previous is None else ' AFTER ' + ident(previous)
            if old is None:
                if self._generated(new) or new.get('extra') or (not new.get('nullable') and ('default' not in new or new['default'] is None)):
                    return None
                statements.append('ALTER TABLE ' + ident(name) + ' ADD COLUMN ' + ident(column) + ' ' + definitions[column] + position + ';')
            elif old != new:
                a = re.fullmatch(r'varchar\(([1-9][0-9]*)\)', old.get('type', ''))
                b = re.fullmatch(r'varchar\(([1-9][0-9]*)\)', new.get('type', ''))
                if not (a and b and int(b[1]) >= int(a[1]) and all(old.get(k) == new.get(k) for k in set(old) | set(new) if k not in ('type', 'comment'))):
                    return None
                if any(idx.get('column') == column or idx.get('expression') for idx in source['indexes']):
                    return None
                if any((owner == name and fk.get('column') == column) or (fk.get('table') == name and fk.get('target') == column)
                       for snapshot in (whole_source, whole_target) for owner, tab in snapshot['tables'].items() for fk in tab['foreignKeys']):
                    return None
                statements.append('ALTER TABLE ' + ident(name) + ' MODIFY COLUMN ' + ident(column) + ' ' + definitions[column] + ';')
            previous = column
        return statements or None

    def fast_sync(self, desired_schema, jobId, previousMigrationId=None):
        """No full backup/scratch/reset: ALTER safe changes, convert affected tables."""
        require(self.environment == 'test' and type(jobId) is str and re.fullmatch(r'[a-f0-9]{32}', jobId), 'Test inplace migration required')
        self._quiescent()
        desired_schema = canonical_schema(desired_schema)
        source = self.snapshot()
        desired, current = desired_schema['tables'], source['tables']
        require(type(desired) is dict and len(desired) <= 256, 'Trusted complete schema required')
        for name, table in desired.items():
            self._fast_definitions(name, table)
        require(not self._migration_path(jobId).exists(), 'Migration already exists; inspect report')
        changed = {name for name in current if current[name] != desired.get(name)}
        direct = {}
        affected = set()
        for name in changed:
            sql = self._fast_direct_sql(name, desired[name], current[name], desired_schema, source) if name in desired else None
            if sql:
                direct[name] = sql
            else:
                affected.add(name)
        # Evacuate every existing inbound dependent before removing its parent.
        while True:
            extra = {name for name, table in current.items() if any(fk['table'] in affected for fk in table['foreignKeys'])}
            if extra <= affected:
                break
            affected |= extra
        for name in affected:
            direct.pop(name, None)
        subset = {'tables': {name: current[name] for name in sorted(affected)}}
        counts = self._counts(subset)
        highwater = self._highwater(source)
        rows = self._source_rows(subset, counts)
        # A historical migration is an archive, never the next release's input.
        # Keep the optional argument for older callers without replaying its rows.
        carried = []
        rows += carried
        require(len(rows) <= self.MAX_ROWS and len({row['rowId'] for row in rows}) == len(rows), 'Migration row capacity or identity invalid')
        document = {'version': 1, 'mode': 'fast-inplace', 'migrationId': jobId, 'database': self.name,
                    'project': self.release.projects['test'], 'schema': desired_schema, 'sourceSchema': subset,
                    'sourceCounts': counts, 'carriedTotal': len(carried), 'previousMigrationId': previousMigrationId,
                    'highwater': highwater, 'affectedTables': sorted(affected), 'directTables': sorted(direct),
                    'rows': rows, 'status': 'prepared'}
        # All at-risk rows are durable before any DELETE, DROP or ALTER. This is
        # affected-row archival, not a whole-database backup or rollback promise.
        self._save_migration(document)
        self._quiescent()
        require(self.snapshot() == source and self._counts(subset) == counts, 'Source changed before inplace migration')
        document['status'] = 'changing-structure'
        self._save_migration(document)
        self.progress('db-migrating')
        for name in sorted(affected):
            for constraint in sorted({fk['name'] for fk in current[name]['foreignKeys']}):
                self._mysql('ALTER TABLE ' + ident(name) + ' DROP FOREIGN KEY ' + ident(constraint) + ';')
        # No external inbound FK remains: the closure and isolation were checked.
        # DELETE all rows is intentional and exact even for keyless duplicates;
        # archived counts plus ROW_COUNT are checked before each transaction commit.
        for name in sorted(affected):
            expected = counts[name]
            # Reuse the owned, strict transactional routine. A count mismatch
            # SIGNAL rolls back and is not classified as a row compatibility error.
            sql = 'DELETE FROM ' + ident(name) + '; IF ROW_COUNT() <> ' + str(expected) + " THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Inplace row count mismatch'; END IF;"
            code, _ = self._insert_row(sql, [])
            require(code == 0, 'Inplace row evacuation failed')
        require(all(value == 0 for value in self._counts(subset).values()), 'Inplace evacuation incomplete')
        for name in sorted(affected):
            self._mysql('DROP TABLE ' + ident(name) + ';')
        for name in sorted(direct):
            self._mysql(self._strict_sql() + '\n'.join(direct[name]))
        new_names = (set(desired) - set(current)) | (affected & set(desired))
        if new_names:
            ddl = '\n'.join(desired[name]['createSQL'].rstrip(';') + ';' for name in sorted(new_names))
            self._mysql(self._strict_sql() + 'SET SESSION FOREIGN_KEY_CHECKS=0;\n' + ddl + '\nSET SESSION FOREIGN_KEY_CHECKS=1;')
        require(self.snapshot() == desired_schema, 'Inplace target schema mismatch')
        document['status'] = 'importing'
        self._save_migration(document)
        self._migrate_rows(document, persist=True)
        self._restore_highwater(desired_schema, highwater)
        require(self.snapshot() == desired_schema, 'Inplace final schema mismatch')
        self._verify_fast_counts(document)
        document['status'] = 'pending' if any(row['status'] != 'imported' for row in rows) else 'complete'
        self._save_migration(document)
        self._quiescent()
        result = self._summary(document)
        result['affectedTables'] = sorted(affected)
        result['directTables'] = sorted(direct)
        return result

    def _verify_fast_counts(self, document):
        require(len(document['rows']) == sum(document['sourceCounts'].values()) + document.get('carriedTotal', 0), 'Inplace source accounting mismatch')
        for name in document['affectedTables']:
            if name not in document['schema']['tables']:
                continue
            expected = sum(row['status'] == 'imported' and row['table'] == name for row in document['rows'])
            actual = self._counts({'tables': {name: document['schema']['tables'][name]}})[name]
            require(actual == expected, 'Inplace imported row accounting mismatch')

    def rebuild(self, desired_schema, backup, jobId, previousMigrationId=None):
        require(self.environment == 'test' and type(jobId) is str and re.fullmatch(r'[a-f0-9]{32}', jobId), 'Test rebuild job required')
        path = self._validated_backup(backup)
        require(backup['id'].endswith('-' + jobId), 'Backup job mismatch')
        self._quiescent()
        require(self.snapshot() == backup['schema'] and self._counts(backup['schema']) == backup['counts'], 'Source changed after backup')
        migration_id = jobId
        require(not self._migration_path(migration_id).exists(), 'Migration already exists; inspect its report')
        carried = []
        prior_highwater = {}
        if previousMigrationId is not None:
            require(previousMigrationId != migration_id, 'Previous migration must differ')
            previous = self._read_migration(previousMigrationId)
            require(previous['status'] in ('pending', 'complete') and all(row['status'] in ('pending', 'imported') for row in previous['rows']), 'Previous migration requires manual recovery')
            self._validated_backup(previous['backup'])
            require(previous['schema'] == backup['schema'], 'Previous migration schema mismatch')
            carried = copy.deepcopy([row for row in previous['rows'] if row['status'] == 'pending'])
            for row in carried:
                row.setdefault('originMigrationId', previousMigrationId)
            prior_highwater = previous.get('highwater', {})
        require(sum(backup['counts'].values()) + len(carried) <= self.MAX_ROWS, 'Migration row capacity exceeded')
        highwater = copy.deepcopy(backup.get('highwater', {}))
        for name, value in prior_highwater.items():
            if name not in highwater or (highwater[name]['column'] == value['column'] and highwater[name]['value'] < value['value']):
                highwater[name] = copy.deepcopy(value)
        document = {'version': 1, 'migrationId': migration_id, 'database': self.name,
                    'project': self.release.projects['test'], 'backup': backup,
                    'previousMigrationId': previousMigrationId, 'carriedTotal': len(carried),
                    'highwater': highwater, 'schema': desired_schema, 'rows': [], 'status': 'rehearsing'}
        def rehearse(kw):
            self.progress('db-migration-rehearsal')
            # Older verified backups predate explicit highwater metadata; read
            # the restored dump's actual counter before replacing its schema.
            for name, saved in self._highwater(backup['schema'], **kw).items():
                if name not in highwater or (highwater[name]['column'] == saved['column'] and highwater[name]['value'] < saved['value']):
                    highwater[name] = saved
            document['rows'] = self._source_rows(backup['schema'], backup['counts'], **kw) + copy.deepcopy(carried)
            require(len({row['rowId'] for row in document['rows']}) == len(document['rows']), 'Duplicate migration row identity')
            self._create_schema(desired_schema, **kw)
            self._migrate_rows(document, **kw)
            self._restore_highwater(desired_schema, highwater, **kw)
            self._verify_migration_counts(document, **kw)
        self._verify_scratch(path, backup['schema'], backup['counts'], action=rehearse)
        require(self._checksum(path) == backup['checksum'], 'Backup changed during rehearsal')
        # Save *all* source rows before the first destructive live operation.
        for row in document['rows']:
            row.update(status='pending', reason='awaiting_import', errorCode=None, failedFields=[])
        document['status'] = 'prepared'
        self._save_migration(document)
        self._quiescent()
        require(self.snapshot() == backup['schema'] and self._counts(backup['schema']) == backup['counts'], 'Source changed during rehearsal')
        self.progress('db-rebuilding')
        self._create_schema(desired_schema)
        document['status'] = 'importing'
        self._save_migration(document)
        self._migrate_rows(document, persist=True)
        self._restore_highwater(desired_schema, highwater)
        self._verify_migration_counts(document)
        document['status'] = 'pending' if any(row['status'] != 'imported' for row in document['rows']) else 'complete'
        self._save_migration(document)
        self._quiescent()
        return self._summary(document)

    def _verify_migration_counts(self, document, **kwargs):
        counts = self._counts(document['schema'], **kwargs)
        expected = {name: sum(row['status'] == 'imported' and row['table'] == name for row in document['rows']) for name in document['schema']['tables']}
        require(counts == expected and len(document['rows']) == sum(document['backup']['counts'].values()) + document.get('carriedTotal', 0), 'Migration final row accounting mismatch')

    def retry_migration(self, migrationId, corrections):
        require(self.environment == 'test' and type(corrections) is list and len(corrections) <= 100, 'Bounded test corrections required')
        document = self._read_migration(migrationId)
        require(document['status'] in ('pending', 'complete') and
                all(row['status'] in ('pending', 'imported') for row in document['rows']), 'Migration requires manual recovery')
        if document.get('mode') != 'fast-inplace':
            self._validated_backup(document['backup'])
        self._quiescent()
        require(self.snapshot() == document['schema'], 'Migration target schema changed')
        by_id = {row['rowId']: row for row in document['rows']}
        seen = set()
        for correction in corrections:
            require(type(correction) is dict and set(correction) == {'rowId', 'mapping'}, 'Invalid row correction')
            row_id, mapping = correction['rowId'], correction['mapping']
            require(type(row_id) is str and row_id in by_id and row_id not in seen
                    and type(mapping) is dict and len(mapping) <= 256, 'Invalid correction row identity')
            seen.add(row_id)
            row = by_id[row_id]
            require(row['status'] == 'pending', 'Imported or uncertain row cannot be corrected')
            columns = document['schema']['tables'].get(row['table'], {}).get('columns', {})
            for name, value in mapping.items():
                ident(name)
                if name not in columns:
                    require(name in row['values'] and value == {'$omit': True}, 'Unknown correction field')
                else:
                    require(not self._generated(columns[name]), 'Cannot correct generated column')
                    self._correction_sql(value)
            row['mapping'].update(mapping)
        self._save_migration(document)
        self._migrate_rows(document, persist=True)
        self._restore_highwater(document['schema'], document.get('highwater', {}))
        document['status'] = 'pending' if any(row['status'] != 'imported' for row in document['rows']) else 'complete'
        self._save_migration(document)
        self._quiescent()
        return self._summary(document)

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

    def backup_failure_recoverable(self, old, plan, process_identity):
        """Only admit a new verified plan after a proven pre-DDL backup failure."""
        if not (old.get('status') == 'failed' and old.get('stage') in
                ('db-maintenance', 'db-backup', 'db-backup-verify', 'db-backup-cleanup')
                and old.get('maintenance') is True and old.get('database') is None
                and old.get('environment') == 'test'):
            return False
        pid = old.get('workerPid')
        if pid is not None:
            require(type(pid) is int and pid > 1, 'Invalid recorded worker identity')
            identity = process_identity(pid)
            if identity is not None and (not old.get('workerIdentity') or identity == old['workerIdentity']):
                return False
        elif old.get('workerIdentity'):
            return False
        prior = self.release.get('plan', old['planId'])
        if not (prior.get('environment') == plan.get('environment') == 'test'
                and prior.get('fingerprint') == plan.get('fingerprint')
                and type(prior.get('databaseTargetSchema')) is dict
                and canonical_schema(prior['databaseTargetSchema']) == plan.get('databaseTargetSchema')
                and type(plan.get('databaseTargetSchema')) is dict):
            return False
        for service in ('api', 'web', 'db'):
            before = prior.get('previous', {}).get(service, {})
            current = plan.get('previous', {}).get(service, {})
            if not before.get('containerId') or any(before.get(k) != current.get(k) for k in ('containerId', 'imageId')):
                return False
        # No SQL, network mutation, or history rewrite here. The worker checks the
        # fresh plan against actual config, containers and schema before stopping.
        return True

    def recover_release(self, job, plan, old_override, backup, write):
        """Recover pre-release schema and images; never claim success before health."""
        release = self.release
        active = release.active_override('test')
        current_path = release.roots['test'] / 'compose.override.yaml'
        # Stop even candidate writers before re-isolation or restoring any DDL.
        release.compose('test', ['stop', 'web', 'api'], override=active)
        if backup is not None:
            self.isolate_network()
            job['stage'] = 'db-restoring'
            job['database']['status'] = 'restoring'
            release.put('job', job['jobId'], job)
            self.restore(backup)
            require(self.snapshot() == plan['databaseTargetSchema'], 'Recovered schema verification failed')
            job['database']['status'] = 'restored'
            job['stage'] = 'db-restored'
        else:
            require(self.snapshot() == plan['databaseTargetSchema'], 'Database changed before migration')
        # Roll back only the managed image override, never shared Compose config.
        if old_override is None:
            if active:
                st = current_path.lstat()
                require(stat.S_ISREG(st.st_mode) and not current_path.is_symlink() and st.st_nlink == 1
                        and st.st_uid == os.geteuid(), 'Unsafe release override recovery')
                current_path.unlink()
                fd = os.open(current_path.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
        else:
            write(current_path, old_override, raw=True)
        active = release.active_override('test')
        config = release.config_snapshot('test', override=active)
        fingerprint = hashlib.sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        require(fingerprint == plan['fingerprint'], 'Recovered Compose verification failed')
        self.restore_network()
        images = {s: plan['previous'][s]['imageId'] for s in ('api', 'web')}
        release.inspect_images(images)
        release.compose('test', ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api', 'web'], images=images, override=active)
        deadline = time.monotonic() + 180
        while True:
            try:
                observed = release.observe('test')
            except Exception as error:
                # Retry only unavailable observation, never identity/config drift.
                if type(error).__name__ != 'Refused' or str(error) not in ('Expected one existing container per service', 'Invalid container inspect'):
                    raise
                observed = None
            if (observed is not None and all(observed[s]['healthy'] and observed[s]['imageId'] == images[s] for s in images)
                    and observed['db'] == plan['previous']['db']):
                break
            require(time.monotonic() < deadline, 'Recovered application health verification failed')
            time.sleep(2)
        require(self.snapshot() == plan['databaseTargetSchema'], 'Recovered application changed schema')
