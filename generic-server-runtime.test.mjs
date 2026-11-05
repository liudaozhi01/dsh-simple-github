import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
// Standard-library fixtures only: no root, installed paths, Docker, SSH or server.
test('generic installed runtime isolation, identity and legacy lock compatibility', () => {
  const fixture = String.raw`
import base64, importlib.util, json, os, pathlib, socket, stat, struct, tempfile, threading, unittest
from types import SimpleNamespace
from unittest.mock import patch

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value
b = module('broker', 'team-release-broker.py')
e = module('entry', 'team-release-entry.py')
m = module('engine', 'temporary-release.py')

class Tests(unittest.TestCase):
    def metadata(self, path):
        return SimpleNamespace(st_uid=0, st_mode=(stat.S_IFREG | 0o644) if path.name.endswith('.py') else (stat.S_IFDIR | 0o755))

    def test_installed_namespaces_and_sibling_code(self):
        for project in ('a', 'team-one', 'a' * 40):
            installed = '/usr/local/libexec/dsh-release-' + project
            with patch.object(e, '__file__', installed + '/entry.py'), patch.object(pathlib.Path, 'lstat', lambda path: self.metadata(path)):
                self.assertEqual(e.installed_project_id(), project)
            with patch.object(b, '__file__', installed + '/broker.py'), patch.object(pathlib.Path, 'lstat', lambda path: self.metadata(path)), patch.multiple(b, PROJECT_ID=None, CONFIG=b.CONFIG, ENGINE=b.ENGINE, BUILD=b.BUILD, SOCKET=b.SOCKET):
                b.configure_runtime()
                self.assertEqual(b.PROJECT_ID, project)
                self.assertEqual(str(b.CONFIG), '/etc/dsh-release-' + project + '.json')
                self.assertEqual(b.SOCKET, '/run/dsh-release-' + project + '.sock')
                self.assertEqual(str(b.ENGINE), installed + '/engine.py')
                self.assertEqual(str(b.BUILD), installed + '/build.py')

    def test_invalid_install_locations_fail_closed(self):
        directories = ('/tmp/dsh-release-valid', '/usr/local/libexec/nested/dsh-release-valid', '/usr/local/libexec/dsh-release-', '/usr/local/libexec/dsh-release-A', '/usr/local/libexec/dsh-release-1a', '/usr/local/libexec/dsh-release-a_b', '/usr/local/libexec/dsh-release-' + 'a'*41, '/usr/local/libexec/dsh-release-valid/../dsh-release-other', '/usr/local/libexec//dsh-release-valid')
        for directory in directories:
            with self.subTest(directory=directory), patch.object(pathlib.Path, 'lstat', lambda path: self.metadata(path)):
                with patch.object(e, '__file__', directory + '/entry.py'):
                    with self.assertRaises(ValueError): e.installed_project_id()
                with patch.object(b, '__file__', directory + '/broker.py'):
                    with self.assertRaises(b.Refused): b.configure_runtime()
        for script, module_value, call in (('other.py', e, e.installed_project_id), ('entry.py', b, b.configure_runtime)):
            with patch.object(module_value, '__file__', '/usr/local/libexec/dsh-release-valid/' + script):
                with self.assertRaises((ValueError, b.Refused)): call()

    def test_all_install_ancestors_are_trusted(self):
        for target in ('/', '/usr', '/usr/local', '/usr/local/libexec', '/usr/local/libexec/dsh-release-one', '/usr/local/libexec/dsh-release-one/entry.py'):
            for attack in ('owner', 'writable', 'symlink'):
                def metadata(path):
                    value = self.metadata(path)
                    if str(path) == target:
                        if attack == 'owner': value.st_uid = 1001
                        if attack == 'writable': value.st_mode |= 0o020
                        if attack == 'symlink': value.st_mode = stat.S_IFLNK | 0o777
                    return value
                with self.subTest(target=target, attack=attack), patch.object(e, '__file__', '/usr/local/libexec/dsh-release-one/entry.py'), patch.object(pathlib.Path, 'lstat', metadata):
                    with self.assertRaises(ValueError): e.installed_project_id()
        with patch.object(b, '__file__', '/usr/local/libexec/dsh-release-one/broker.py'), patch.object(b, 'private', side_effect=b.Refused('unsafe')):
            with self.assertRaises(b.Refused): b.configure_runtime()

    def test_legacy_paths_and_no_request_selectors(self):
        self.assertIsNone(e.installed_project_id())
        b.configure_runtime()
        self.assertIsNone(b.PROJECT_ID)
        self.assertEqual(e.SOCKET, '/run/xian-oa-team-release.sock')
        self.assertEqual(b.SOCKET, e.SOCKET)
        self.assertEqual(str(b.CONFIG), '/etc/xian-oa-team-release.json')
        self.assertEqual(str(b.ENGINE), '/usr/local/libexec/xian-oa-temporary-release.py')
        for key in ('projectId', 'deploymentProjectId', 'profile', 'config', 'socket', 'engine', 'build', 'command', 'shell'):
            for request in ({'action':'overview','body':{},key:'other'}, {'action':'overview','body':{key:'other'}}):
                with self.assertRaises(b.Refused): b.request_object(json.dumps(request).encode())

    def test_entry_connects_derived_socket_and_checks_root_peer(self):
        request = base64.b64encode(b'{"action":"overview","body":{}}').decode()
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def settimeout(self, *args): pass
            def connect(self, endpoint): self.endpoint = endpoint
            def getsockopt(self, *args): return struct.pack('3i', 10, self.uid, 1000)
            def sendall(self, data): self.sent = data
            def shutdown(self, *args): pass
            def recv(self, *args):
                data, self.output = self.output, b''
                return data
        for uid, expected in ((0, 0), (1001, 1)):
            connection = Connection(); connection.uid = uid; connection.output = b'{"status":"idle"}'
            with patch.object(e, 'installed_project_id', return_value='project-one'), patch.object(e.sys, 'argv', ['entry', request]), patch.object(e.os, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFSOCK | 0o660, st_uid=0)), patch.object(e.socket, 'socket', return_value=connection), patch.object(e.socket, 'SO_PEERCRED', 17, create=True), patch.object(e.select, 'select', return_value=([connection], [], [])), patch('builtins.print'):
                self.assertEqual(e.main(), expected)
                self.assertEqual(connection.endpoint, '/run/dsh-release-project-one.sock')

    def test_success_binding_is_root_configuration_not_engine_or_body(self):
        class Broker:
            profile = {'repository':'owner/repo', 'branch':'develop'}
            def dispatch(self, request, uid):
                self.uid = uid
                return {'status':'idle', 'deploymentProjectId':'spoof', 'deploymentProtocolVersion':99, 'deploymentRepository':'spoof', 'deploymentBranch':'spoof'}
        class Connection:
            def getsockopt(self, *args): return struct.pack('3i', 123, 1009, 1009)
            def settimeout(self, *args): pass
            def sendall(self, output): self.output = json.loads(output)
            def close(self): pass
        for project in (None, 'project-one'):
            broker = Broker(); connection = Connection()
            with patch.object(b, 'PROJECT_ID', project), patch.object(b, 'receive', return_value={'action':'overview','body':{}}), patch.object(b.socket, 'SO_PEERCRED', 17, create=True):
                b.handle(connection, broker)
            self.assertEqual(broker.uid, 1009)
            if project:
                self.assertEqual(connection.output, {'status':'idle', 'deploymentProjectId':project, 'deploymentProtocolVersion':1, 'deploymentRepository':'owner/repo', 'deploymentBranch':'develop'})
            else:
                self.assertEqual(connection.output['deploymentProjectId'], 'spoof')
        broker = Broker(); broker.dispatch = lambda *args: {'error':'refused'}
        with patch.object(b, 'PROJECT_ID', 'project-one'), patch.object(b, 'receive', return_value={}), patch.object(b.socket, 'SO_PEERCRED', 17, create=True):
            b.handle(connection, broker)
        self.assertEqual(connection.output, {'error':'refused'})

    def test_project_environment_is_controlled_and_not_json(self):
        real = b.subprocess.Popen
        for project in (None, 'one'):
            def launch(argv, **kwargs):
                self.assertEqual(kwargs['env'].get('DSH_RELEASE_PROJECT_ID'), project)
                self.assertNotIn('projectId', json.loads(base64.b64decode(argv[-1])))
                return real(['/usr/bin/env', 'python3', '-I', '-c', 'print("{}")'], **kwargs)
            with patch.object(b, 'PROJECT_ID', project), patch.object(b.subprocess, 'Popen', side_effect=launch), patch.dict(os.environ, {'DSH_RELEASE_PROJECT_ID':'attacker'}):
                self.assertEqual(b.execute(pathlib.Path('/unused'), {}, 'overview', {}, 'alice', 1001, 'mysql@sha256:'+'1'*64), {})

    def test_engine_identity_requires_broker_and_worker_retains_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage = pathlib.Path(tmp)
            for environment in ({'DSH_RELEASE_PROJECT_ID':'one'}, {'DSH_RELEASE_BROKER':'1','DSH_RELEASE_PROJECT_ID':'../two'}, {'DSH_RELEASE_BROKER':'1','DSH_RELEASE_PROJECT_ID':''}):
                with patch.dict(os.environ, environment, clear=True), patch.object(m, 'validate_stage', return_value=stage), patch.object(m.os, 'geteuid', return_value=0):
                    with self.assertRaisesRegex(m.Refused, 'Invalid broker project identity'):
                        m.Release({})
            value = m.Release.__new__(m.Release)
            value.profile = {'canonical':'fixed'}; value.entry = stage/'script.py'; value.user = 'alice'
            value.env = {'DSH_RELEASE_BROKER':'1', 'DSH_RELEASE_PROJECT_ID':'one'}
            with patch.object(m.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1001)), patch.object(m.subprocess, 'Popen') as launch:
                value.spawn('a'*32, 'b'*64)
                self.assertEqual(launch.call_args.kwargs['env']['DSH_RELEASE_PROJECT_ID'], 'one')
                self.assertNotIn('projectId', json.loads(base64.b64decode(launch.call_args.args[0][-1])))

    def test_generic_state_locks_are_isolated_but_same_project_excludes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            def release(name, project):
                value = m.Release.__new__(m.Release); value.state = root/name; value.state.mkdir(); value.broker = True; value.project_id = project
                return value
            one = release('one', 'one'); two = release('two', 'two')
            with patch.object(m, 'secure', side_effect=AssertionError('Generic must not inspect OA global lock')):
                with one.lock('operation-dev', blocking=False):
                    with two.lock('operation-dev', blocking=False): pass
                    with self.assertRaisesRegex(m.Refused, 'Another job owns'):
                        with one.lock('operation-dev', blocking=False): pass
            legacy_one = release('legacy-one', None); legacy_two = release('legacy-two', None)
            real_open = os.open
            def redirected(path, *args, **kwargs):
                return real_open(root/'legacy.lock' if str(path) == '/var/lib/xian-oa-release/.release.lock' else path, *args, **kwargs)
            with patch.object(m, 'secure'), patch.object(m.os, 'open', side_effect=redirected):
                with legacy_one.lock('operation-dev', blocking=False):
                    with self.assertRaisesRegex(m.Refused, 'shared server lock'):
                        with legacy_two.lock('operation-test', blocking=False): pass

unittest.main()
`;
  const result = spawnSync('python3', ['-B', '-c', fixture], { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
