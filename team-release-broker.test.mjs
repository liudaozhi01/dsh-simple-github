import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
test('team broker isolated Python security and protocol fixtures (no root/server)', () => {
  const script = String.raw`
import base64, hashlib, importlib.util, json, os, pathlib, socket, struct, tempfile, threading, unittest
from unittest.mock import patch

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value
b = module('broker', 'team-release-broker.py')
e = module('entry', 'team-release-entry.py')

class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.config = {'profile': {'stateRoot': '/var/lib/example'}, 'allowedUsers': {'dev': ['alice'], 'test': ['reviewer']}}
        self.broker = b.Broker(self.config)

    def test_protocol_rejects_identity_and_profile(self):
        for value in ({'action':'check','body':{},'actor':'alice'}, {'action':'check','body':{},'profile':{}}, {'action':'_worker','body':{}}, {'action':'query','body':{}}, {'action':'check','body':{'head':'a','profile':{}}}):
            with self.assertRaises(b.Refused): b.request_object(json.dumps(value).encode())
        with self.assertRaises(b.Refused): b.request_object(b'{"action":"check","action":"start","body":{}}')
        with self.assertRaises(b.Refused): b.request_object(b'x' * (b.MAX_REQUEST+1))
        self.assertEqual(b.request_object(b'{"action":"status","body":{}}')['action'], 'status')

    def test_start_authorizes_root_plan_not_payload(self):
        request = {'action':'start', 'body':{'planId':'a'*32}}
        with patch.object(self.broker,'record',return_value={'actor':'alice','environment':'test'}):
            with self.assertRaises(b.Refused): self.broker.environment(request, 'alice')
        with patch.object(self.broker,'record',return_value={'actor':'someone','environment':'dev'}):
            with self.assertRaises(b.Refused): self.broker.environment(request, 'alice')
        with patch.object(self.broker,'record',return_value={'actor':'alice','environment':'dev'}):
            self.assertEqual(self.broker.environment(request,'alice'), 'dev')

    def test_restore_uses_root_environment_and_current_acl(self):
        request={'action':'restore','body':{'environment':'dev','jobId':'a'*32}}
        with patch.object(self.broker,'record',return_value={'actor':'other','environment':'dev'}):
            self.assertEqual(self.broker.environment(request,'alice'),'dev')
        with patch.object(self.broker,'record',return_value={'environment':'test'}):
            with self.assertRaises(b.Refused):self.broker.environment(request,'alice')
            request['body']['environment']='test'
            with self.assertRaises(b.Refused):self.broker.environment(request,'alice')
            self.assertEqual(self.broker.environment(request,'reviewer'),'test')
        with self.assertRaises(b.Refused):b.request_object(json.dumps({'action':'restore','body':{'environment':'dev','jobId':'a'*32,'images':{}}}).encode())

    def test_actions_environment_authorization(self):
        with self.assertRaises(b.Refused): self.broker.environment({'action':'promote','body':{}},'alice')
        with self.assertRaises(b.Refused): self.broker.environment({'action':'check','body':{}},'reviewer')
        for action in ('status','accept','reconcile'):
            with patch.object(self.broker,'record',return_value={'environment':'test'}):
                with self.assertRaises(b.Refused): self.broker.environment({'action':action,'body':{'jobId':'a'*32}},'alice')

    def test_all_login_users_dev_only_and_dynamic_accounts(self):
        from types import SimpleNamespace
        self.config['allowedUsers'] = {'dev':'all-ssh-users', 'test':[]}
        def account(uid, shell): return SimpleNamespace(pw_uid=uid, pw_shell=shell)
        real_read = pathlib.Path.read_text
        def read(path, *args, **kwargs):
            if str(path) == '/etc/login.defs': return 'UID_MIN 1000\nUID_MAX 60000\n'
            if str(path) == '/etc/shells': return '/bin/bash\n/usr/sbin/nologin\n/bin/false\n'
            return real_read(path,*args,**kwargs)
        with patch.object(b.Path,'read_text',read):
            for uid,shell,expected in ((1003,'/bin/bash',True),(1015,'/bin/bash',True),(0,'/bin/bash',False),(999,'/bin/bash',False),(65534,'/bin/bash',False),(1004,'/usr/sbin/nologin',False),(1004,'/bin/false',False),(1004,'/unknown',False)):
                with patch.object(b.pwd,'getpwnam',return_value=account(uid,shell)):
                    self.assertEqual(b.permitted(self.config,'newmember','dev'),expected)
                    self.assertFalse(b.permitted(self.config,'newmember','test'))
                    if expected:
                        self.assertIsNone(self.broker.environment({'action':'status','body':{}},'newmember'))

    def test_bundle_fixed_path_and_limits(self):
        for value in ({'path':'/tmp/evil','size':1,'sha256':'a'*64}, {'path':'/tmp/dsh-upload-11111111-1111-1111-1111-111111111111/source.tar','size':True,'sha256':'a'*64}):
            with self.assertRaises(b.Refused): b.copy_bundle(value,os.getuid(),pathlib.Path('/unused'))

    def fixture_bundle(self, directory):
        source = directory/'source.tar'
        source.write_bytes(b'archive bytes')
        source.chmod(0o600)
        return {'path':str(source),'size':source.stat().st_size,'sha256':hashlib.sha256(source.read_bytes()).hexdigest()}

    def test_copy_owned_upload_cleanup_and_sha(self):
        # Redirect only the fixed /tmp fixture name matcher; real descriptor,
        # NOFOLLOW, digest, ownership and unlink code are exercised.
        with tempfile.TemporaryDirectory() as tmp:
            parent = pathlib.Path(tmp)
            upload = parent/'upload'; upload.mkdir(mode=0o700)
            stage = parent/'stage'; stage.mkdir(mode=0o700)
            bundle = self.fixture_bundle(upload)
            original = b.re.fullmatch
            def match(pattern, value):
                return True if pattern.startswith('/tmp/dsh-upload-') and value == bundle['path'] else original(pattern,value)
            with patch.object(b.re,'fullmatch',side_effect=match):
                result = b.copy_bundle(bundle,os.getuid(),stage)
            self.assertEqual((stage/'archive.tar.gz').read_bytes(),b'archive bytes')
            self.assertEqual(result['path'],str(stage/'archive.tar.gz'))
            self.assertFalse(upload.exists())

    def test_upload_symlink_hardlink_and_wrong_sha_rejected(self):
        for attack in ('symlink','hardlink','digest','directory-mode','file-mode'):
            with self.subTest(attack=attack), tempfile.TemporaryDirectory() as tmp:
                parent = pathlib.Path(tmp)
                upload = parent/'upload'; upload.mkdir(mode=0o700)
                stage = parent/'stage'; stage.mkdir(mode=0o700)
                bundle = self.fixture_bundle(upload)
                source = upload/'source.tar'
                if attack == 'symlink':
                    other = parent/'other'; source.rename(other); source.symlink_to(other)
                elif attack == 'hardlink': os.link(source,parent/'other')
                elif attack == 'digest': bundle['sha256']='0'*64
                elif attack == 'directory-mode': upload.chmod(0o755)
                elif attack == 'file-mode': source.chmod(0o644)
                original = b.re.fullmatch
                def match(pattern,value):
                    return True if pattern.startswith('/tmp/dsh-upload-') and value == bundle['path'] else original(pattern,value)
                with patch.object(b.re,'fullmatch',side_effect=match):
                    with self.assertRaises((b.Refused,OSError)): b.copy_bundle(bundle,os.getuid(),stage)
                self.assertTrue(source.exists())

    def test_bounded_socket_receive(self):
        one,two = socket.socketpair()
        try:
            two.sendall(b'{"action":"status","body":{}}'); two.shutdown(socket.SHUT_WR)
            self.assertEqual(b.receive(one)['action'],'status')
        finally: one.close(); two.close()
        one,two=socket.socketpair()
        try:
            def writer():
                try:
                    two.sendall(b'x'*(b.MAX_REQUEST+1)); two.shutdown(socket.SHUT_WR)
                except OSError: pass
            thread=threading.Thread(target=writer); thread.start()
            with self.assertRaises(b.Refused): b.receive(one)
            one.close(); thread.join(2)
        finally: one.close(); two.close()

    def test_peer_identity_kernel_not_json(self):
        one,two = socket.socketpair()
        got=[]
        class Fake:
            def dispatch(self,request,uid): got.append(uid); return {'status':'idle'}
        class PeerSocket:
            def getsockopt(self,*args): return struct.pack('3i',123,os.getuid(),os.getgid())
            def __getattr__(self,name): return getattr(one,name)
        with patch.object(b.socket,'SO_PEERCRED',17,create=True):
            t=threading.Thread(target=b.handle,args=(PeerSocket(),Fake())); t.start()
            two.sendall(b'{"action":"status","body":{}}'); two.shutdown(socket.SHUT_WR)
            output=two.recv(8192); t.join(3); two.close()
        self.assertEqual(json.loads(output),{'status':'idle'})
        self.assertEqual(got,[os.getuid()])
        self.assertFalse(t.is_alive())

    def test_entry_argument_limit_and_invalid_encoding(self):
        for arg in ('!', 'a'*32769):
            with patch.object(e.sys,'argv',['entry',arg]), patch('builtins.print') as output:
                self.assertEqual(e.main(),1)
                self.assertNotIn(arg,output.call_args.args[0])

    def test_engine_subprocess_bounded_output_and_timeout(self):
        # Exercise real pipes/selector/kill with a substitute Python program;
        # never launch the actual release engine or Docker.
        real = b.subprocess.Popen
        with tempfile.TemporaryDirectory() as tmp:
            stage=pathlib.Path(tmp)
            for program, message in (("print('x'*70000)",'Release output too large'), ("import time; time.sleep(5)",'timed out')):
                def launch(argv, **kwargs):
                    return real(['/usr/bin/env','python3','-I','-c',program],**kwargs)
                with patch.object(b.subprocess,'Popen',side_effect=launch), patch.object(b,'COMMAND_TIMEOUT',0.3 if 'sleep' in program else 3):
                    with self.assertRaisesRegex(b.Refused,message):
                        b.execute(stage,{},'status',{},'alice',1001,'mysql@sha256:'+'1'*64)
            def launch(argv, **kwargs):
                self.assertEqual(kwargs['env']['SUDO_UID'],'1001')
                self.assertEqual(kwargs['env']['DSH_RELEASE_BROKER'],'1')
                self.assertEqual(kwargs['env']['DSH_RELEASE_MYSQL_IMAGE'],'mysql@sha256:'+'1'*64)
                self.assertNotIn('HOME',kwargs['env'])
                request=json.loads(base64.b64decode(argv[-1]))
                self.assertEqual(request['profile'],{'canonical':'fixed'})
                return real(['/usr/bin/env','python3','-I','-c',"print('{\\\"status\\\":\\\"idle\\\"}')"],**kwargs)
            with patch.object(b.subprocess,'Popen',side_effect=launch):
                self.assertEqual(b.execute(stage,{'canonical':'fixed'},'status',{},'alice',1001,'mysql@sha256:'+'1'*64),{'status':'idle'})

    def test_dispatch_copies_only_installed_build_helper(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);engine=root/'engine.py';engine.write_text('# trusted engine')
            helper=root/'helper.py';helper.write_text('# trusted build')
            self.config['mysqlImage']='mysql@sha256:'+'1'*64
            real_path=pathlib.Path
            def path(value): return root if value=='/var/tmp' else real_path(value)
            def execute(stage,profile,action,body,user,uid,mysql):
                self.assertEqual((stage/'build.py').read_text(),'# trusted build')
                self.assertEqual((stage/'build.py').stat().st_mode & 0o777,0o600)
                self.assertEqual(mysql,self.config['mysqlImage'])
                self.assertEqual(user,'alice'); return {'planId':'a'*32}
            with patch.object(b,'Path',side_effect=path),patch.object(b,'ENGINE',engine),patch.object(b,'BUILD',helper),patch.object(b,'private'),patch.object(b.pwd,'getpwuid',return_value=SimpleNamespace(pw_name='alice')),patch.object(b,'execute',side_effect=execute):
                self.assertEqual(self.broker.dispatch({'action':'check','body':{'head':'c'*40}},1001),{'planId':'a'*32})
            self.assertEqual(sorted(p.name for p in root.iterdir()),['engine.py','helper.py'])

    def test_dev_restore_start_retains_worker_stage_without_bundle(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);engine=root/'engine.py';engine.write_text('# engine');helper=root/'helper.py';helper.write_text('# build')
            self.config['mysqlImage']='mysql@sha256:'+'1'*64
            real_path=pathlib.Path;plan={'actor':'alice','environment':'dev','operation':'restore'}
            def record(kind,key):return plan if kind=='plan' else {'jobId':'b'*32}
            def execute(stage,profile,action,body,user,uid,mysql):
                self.assertNotIn('bundle',body);plan['jobId']='b'*32;return {'jobId':'b'*32}
            with patch.object(b,'Path',side_effect=lambda v:root if v=='/var/tmp' else real_path(v)),patch.object(b,'ENGINE',engine),patch.object(b,'BUILD',helper),patch.object(b,'private'),patch.object(b.pwd,'getpwuid',return_value=SimpleNamespace(pw_name='alice')),patch.object(b,'execute',side_effect=execute),patch.object(self.broker,'record',side_effect=record):
                self.broker.dispatch({'action':'start','body':{'planId':'a'*32,'confirmation':True,'databaseRiskAccepted':True}},1001)
            self.assertEqual(len([p for p in root.iterdir() if p.is_dir()]),1)

    def test_bad_identifiers_rejected_before_path_access(self):
        for key in ('../evil','a'*31,True,None):
            with self.assertRaises(b.Refused): b.identifier(key)

    def test_config_requires_private_root_permissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            config=pathlib.Path(tmp)/'config.json'; config.write_text('{}'); config.chmod(0o644)
            with patch.object(b,'CONFIG',config), patch.object(b.os,'geteuid',return_value=0), patch.object(b,'private'):
                with self.assertRaisesRegex(b.Refused,'0600'): b.load_config()

    def test_engine_installed_code_and_identity_environment(self):
        text=pathlib.Path('team-release-broker.py').read_text()
        self.assertIn("'DSH_RELEASE_BROKER': '1'",text)
        self.assertIn("'SUDO_UID': str(uid)",text)
        self.assertIn('max_workers=MAX_CLIENTS',text)
        self.assertIn('slots.acquire(blocking=False)',text)
        self.assertIn('process.kill()',text)
        self.assertNotIn('shell=True',text)
        compile(text,'broker','exec')
        compile(pathlib.Path('team-release-entry.py').read_text(),'entry','exec')

unittest.main(verbosity=2)
`;
  const result = spawnSync('python3', ['-I', '-c', script], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 17 tests/);
});
