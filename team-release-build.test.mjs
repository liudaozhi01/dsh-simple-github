import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('./team-release-build.py', import.meta.url));
const fixture = String.raw`
import importlib.util,json,pathlib,tempfile,unittest,sys
from unittest.mock import patch
s=importlib.util.spec_from_file_location('team_build',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
PIN='example/image@sha256:'+'a'*64
class Release:
 def __init__(self,root):
  self.stage=root/'stage'; self.stage.mkdir(); self.profile_id='profile-one'; self.calls=[]; self.containers={}; self.volumes={}; self.fail=None
  self.config={'docker':'mock-docker','baseImages':{k:PIN for k in ['node','mavenJava21','java','nginx']}}
 def run(self,argv,timeout=120,extra=None):
  a=argv[1:];self.calls.append((a,extra,timeout))
  if a[0]=='build':
   if self.fail=='build':raise RuntimeError('build failed')
   pathlib.Path(a[a.index('--iidfile')+1]).write_text('sha256:'+'b'*64)
  if a[:2]==['volume','create']:
   label=a[a.index('--label')+1];k,v=label.split('=',1);self.volumes[a[-1]]={'Name':a[-1],'Driver':'local','Options':None,'Labels':{k:v}}
  if a[:2]==['volume','inspect']:
   v=self.volumes[a[-1]].copy()
   if self.fail=='volume':v['Options']={'type':'none','o':'bind','device':'/business'}
   return json.dumps([v])
  if a[0]=='exec' and self.fail=='mysql':raise RuntimeError('not ready')
  if a[0]=='create':
   cid=format(len(self.containers)+1,'064x');label=a[a.index('--label')+1];k,v=label.split('=',1)
   self.containers[cid]={'Id':cid,'Config':{'Labels':{k:v}},'State':{'ExitCode':0,'OOMKilled':False}}
   return cid+'\n'
  if a[0]=='inspect':
   value=self.containers[a[-1]].copy()
   if self.fail=='identity':value={**value,'Config':{'Labels':{}}}
   return json.dumps([value])
  if a[0]=='wait':
   if self.fail=='timeout':raise RuntimeError('timeout')
   return '1' if self.fail in ('tests','compile') else '0'
  if a[0]=='cp':
   target=pathlib.Path(a[-1]); (target/'TEST-example.xml' if target.is_dir() else target).write_bytes(b'jar')
  return ''
 def inspect_images(self,images):assert set(images)=={'api','web'}
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name); self.r=Release(self.root);self.repo=self.root/'repo';self.repo.mkdir()
  (self.repo/'backend').mkdir();(self.repo/'backend/pom.xml').write_text('<project/>');(self.repo/'backend/README.md').write_text('backend')
  for f in ['package.json','package-lock.json']:(self.repo/f).write_text('{}')
  (self.repo/'docs').mkdir();(self.repo/'docs/large').write_text('no')
 def tearDown(self):self.tmp.cleanup()
 def build(self,pin=PIN,run_tests=False):
  args=(self.r,self.repo,'c'*40,'d'*32,pin)
  return m.build(*args,True) if run_tests else m.build(*args)
 def test_success_isolation_and_cache_layers(self):
  self.assertEqual(set(self.build(run_tests=True)),{'api','web'})
  creates=[(a,e) for a,e,t in self.r.calls if a[0]=='create'];self.assertEqual(len(creates),2)
  db,de=creates[0]; runner,re=creates[1]
  self.assertEqual(de['MYSQL_ROOT_PASSWORD'],re['MYSQL_TEST_PASSWORD'])
  self.assertEqual(re['MYSQL_TEST_URL'],'jdbc:mysql://127.0.0.1:3306');self.assertEqual(re['ALLOW_CREATE_DATABASE'],'true')
  self.assertIn('container:'+format(1,'064x'),runner)
  for a,e in creates:
   self.assertNotIn(de['MYSQL_ROOT_PASSWORD'],' '.join(a))
   for flag in ['--cpus','--memory','--pids-limit','--cap-drop','--security-opt']:self.assertIn(flag,a)
   self.assertNotIn('--privileged',a);self.assertNotIn('-p',a);self.assertNotIn('--publish',a)
   self.assertNotIn('docker.sock',' '.join(a));self.assertNotIn('type=bind',' '.join(a))
  self.assertIn('/var/lib/mysql:rw,nosuid,nodev,noexec,mode=1777,size=1g',db)
  self.assertIn('mvn -B -s /opt/team-maven-settings.xml -Dmaven.repo.local=/home/builder/.m2/repository package',runner[-1]);self.assertNotIn('skipTests',runner[-1])
  work=next(self.r.stage.iterdir());front=(work/'web/Dockerfile').read_text();back=(work/'backend/Dockerfile').read_text()
  self.assertLess(front.index('RUN npm ci'),front.index('COPY . .'));self.assertLess(back.index('dependency:go-offline'),back.index('COPY --chown=10001:10001 . .'))
  self.assertFalse((work/'web/backend').exists());self.assertFalse((work/'web/docs').exists())
  self.assertEqual([a[-1] for a,e,t in self.r.calls if a[0]=='rm'],[format(2,'064x'),format(1,'064x')])
  self.assertFalse(any('prune' in a for a,e,t in self.r.calls))
 def test_default_packages_without_mysql_and_cleans_only_builder(self):
  self.assertEqual(set(self.build()),{'api','web'})
  creates=[(a,e) for a,e,t in self.r.calls if a[0]=='create'];self.assertEqual(len(creates),1)
  runner,env=creates[0];self.assertIsNone(env)
  self.assertEqual(runner[runner.index('--network')+1],'bridge')
  self.assertIn('-DskipTests package',runner[-1]);self.assertNotIn('maven.test.skip',runner[-1])
  self.assertFalse(any('MYSQL' in ' '.join(a) or 'ALLOW_CREATE_DATABASE' in ' '.join(a) for a,e,t in self.r.calls))
  self.assertTrue(all(e is None for a,e,t in self.r.calls))
  self.assertFalse(any(a[0]=='exec' for a,e,t in self.r.calls))
  for flag in ['--cpus','--memory','--memory-swap','--pids-limit','--cap-drop','--security-opt']:self.assertIn(flag,runner)
  self.assertIn('type=volume,src=', ' '.join(runner));self.assertNotIn('type=bind',' '.join(runner))
  self.assertEqual([a[-1] for a,e,t in self.r.calls if a[0]=='rm'],[format(1,'064x')])
  work=next(self.r.stage.iterdir());front=(work/'web/Dockerfile').read_text()
  self.assertIn('RUN npm ci',front);self.assertIn('RUN npm run build',front)
  self.assertFalse(any('prune' in a for a,e,t in self.r.calls))
 def test_default_compile_failure_stops_before_artifact_and_frontend(self):
  self.r.fail='compile'
  with self.assertRaisesRegex(RuntimeError,'Maven build/tests failed'):self.build()
  self.assertEqual(len([1 for a,e,t in self.r.calls if a[0]=='create']),1)
  self.assertEqual([a[-1] for a,e,t in self.r.calls if a[0]=='rm'],[format(1,'064x')])
  self.assertFalse(any(a[0]=='cp' for a,e,t in self.r.calls))
  self.assertEqual(len([1 for a,e,t in self.r.calls if a[0]=='build']),1)
  self.assertFalse(any('MYSQL' in ' '.join(a) for a,e,t in self.r.calls))
 def test_failed_tests_fail_closed_and_cleanup(self):
  self.r.fail='tests'
  with self.assertRaisesRegex(RuntimeError,'tests failed'):self.build(run_tests=True)
  self.assertEqual(len([1 for a,e,t in self.r.calls if a[0]=='rm']),2)
  self.assertFalse(any(a[0]=='cp' and ':/out/app.jar' in a[1] for a,e,t in self.r.calls))
 def test_timeout_cleans_both_containers(self):
  self.r.fail='timeout'
  with self.assertRaisesRegex(RuntimeError,'timeout'):self.build(run_tests=True)
  self.assertEqual(len([1 for a,e,t in self.r.calls if a[0]=='rm']),2)
 def test_unpinned_mysql_is_rejected_before_commands(self):
  with self.assertRaises(RuntimeError):self.build('mysql:8.4')
  self.assertEqual(self.r.calls,[])
 def test_source_symlink_is_rejected(self):
  (self.repo/'backend/leak').symlink_to('/etc/passwd')
  with self.assertRaises(RuntimeError):self.build()
  self.assertEqual(self.r.calls,[])
 def test_ownership_mismatch_never_removes_container(self):
  self.r.fail='identity'
  with self.assertRaisesRegex(RuntimeError,'cleanup incomplete'):self.build()
  self.assertFalse(any(a[0]=='rm' for a,e,t in self.r.calls))
 def test_readiness_timeout_cleans_mysql(self):
  self.r.fail='mysql'
  with patch('time.sleep'),self.assertRaisesRegex(RuntimeError,'readiness timeout'):self.build(run_tests=True)
  self.assertEqual(len([1 for a,e,t in self.r.calls if a[0]=='rm']),1)
  self.assertEqual(len([1 for a,e,t in self.r.calls if a[0]=='create']),1)
 def test_cache_cannot_be_a_host_bind_volume(self):
  self.r.fail='volume'
  with self.assertRaisesRegex(RuntimeError,'cache identity mismatch'):self.build()
  self.assertFalse(any(a[0]=='create' for a,e,t in self.r.calls))
 def test_compile_failure_never_starts_mysql(self):
  self.r.fail='build'
  with self.assertRaisesRegex(RuntimeError,'build failed'):self.build()
  self.assertFalse(any(a[0]=='create' for a,e,t in self.r.calls))
unittest.main(argv=['fixture'])
`;
test('broker build: default skipTests, opt-in MySQL, cache layers and fail-closed cleanup', () => {
  const p = spawnSync('python3', ['-I', '-c', fixture, source], { encoding: 'utf8', timeout: 30000 });
  assert.equal(p.status, 0, `${p.stdout}\n${p.stderr}`);
  assert.match(p.stderr, /Ran 11 tests/);
});
