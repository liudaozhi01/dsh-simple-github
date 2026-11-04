import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Python standard library fixture only: every git/docker/spawn/ownership check
// is replaced. Nothing invokes real git, Docker, SSH, installation or a DB.
const source = fileURLToPath(new URL('./server-release.py', import.meta.url));
const fixture = String.raw`
import contextlib, importlib.util, json, pathlib, tempfile, time, unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('release', __import__('sys').argv[1])
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
K='a'*32; J='b'*32; H='c'*40
IM={'api':'sha256:'+'1'*64,'web':'sha256:'+'2'*64}
OLD={'api':'sha256:'+'3'*64,'web':'sha256:'+'4'*64}

def healthy(images=OLD):
 return {s:{'containerId':s+'-container','imageId':images[s] if s!='db' else 'sha256:'+'5'*64,'healthy':True} for s in ('api','web','db')}

class Fake(m.Release):
 def __init__(self, root):
  self.state=root/'state'; self.work=root/'work'; self.state.mkdir(); self.work.mkdir()
  self.user='operator'; self.config={'allowedUnixUsers':{'dev':['operator'],'test':['operator']},'docker':'mock-docker','git':'mock-git','baseImages':{x:'reviewed@sha256:'+'a'*64 for x in ('node','mavenJava21','java','nginx')}}
  self.env={}; self.calls=[]; self.images=OLD.copy(); self.override=False; self.fail=None; self.builds=0
  self.baseline={'services':{'api':{'image':OLD['api']},'web':{'image':OLD['web']},'db':{'image':'mysql:existing'}}}
 def active_override(self,e): return self.override
 def config_snapshot(self,e,images=None,override=False):
  value=json.loads(json.dumps(self.baseline))
  if override:
   for s in ('api','web'):value['services'][s]['image']=(images or self.images)[s]
  return value
 def observe(self,e): return healthy(self.images)
 def inspect_images(self,images):
  m.require(set(images)=={'api','web'} and all(m.IMAGE.fullmatch(x) for x in images.values()),'IDs required')
 def spawn(self,j,t):self.calls.append(('spawn',j,t))
 @contextlib.contextmanager
 def checkout(self,key,head=None):
  self.calls.append(('checkout',key,head)); yield self.work,H
 def build(self,repo,head,key):
  self.builds+=1
  if self.fail=='build':raise m.Refused('mock testcontainer failure')
  return IM.copy()
 def compose(self,e,args,images=None,override=False):
  self.calls.append(('compose',e,args,images,override))
  if self.fail=='up':raise m.Refused('ambiguous compose failure')
  self.images=images.copy(); self.override=True
  return ''

class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name)
  self.secure=patch.object(m,'secure',lambda p,directory=False:pathlib.Path(p));self.secure.start()
  self.roots=patch.object(m,'ROOTS',{e:self.root/e for e in ('dev','test')});self.roots.start()
  for p in m.ROOTS.values():p.mkdir()
  self.r=Fake(self.root)
 def tearDown(self):self.roots.stop();self.secure.stop();self.tmp.cleanup()
 def plan(self):return self.r.check({'environment':'dev'})
 def start(self,p):return self.r.start({'planId':p['planId'],'confirmation':True,'databaseRiskAccepted':True})
 def work(self,j):
  job=self.r.get('job',j['jobId']);self.r.worker(j['jobId'],job['workerToken']);return self.r.get('job',j['jobId'])
 def test_check_contract_sha_ttl(self):
  p=self.plan();self.assertEqual(set(p),{'planId','environment','remote','expiresAt'});self.assertEqual(p['remote']['head'],H);self.assertLessEqual(p['expiresAt'],time.time()+300)
 def test_strict_input(self):
  for request in ({'action':'shell','body':{}},{'action':'check','body':{'name':'admin'}},{'action':'check','body':{},'command':'id'},{'action':'status','body':[]},{'action':[],'body':{}}):
   with self.assertRaises(m.Refused):self.r.dispatch(request)
  with self.assertRaises(m.Refused):m.loads('{"a":1,"a":2}')
  with self.assertRaises(m.Refused):m.loads('{"a":NaN}')
  with self.assertRaises(m.Refused):m.identifier('../unsafe')
 def test_acl_test_requires_release(self):
  self.r.config['allowedUnixUsers']['dev']=[]
  with self.assertRaises(m.Refused):self.plan()
  with self.assertRaises(m.Refused):self.r.check({'environment':'test'})
 def test_confirmation_expiry_and_idempotency(self):
  p=self.plan()
  with self.assertRaises(m.Refused):self.r.start({'planId':p['planId'],'confirmation':1,'databaseRiskAccepted':True})
  plan=self.r.get('plan',p['planId']);plan['expiresAt']=0;self.r.put('plan',p['planId'],plan)
  with self.assertRaises(m.Refused):self.start(p)
  plan['expiresAt']=time.time()+300;self.r.put('plan',p['planId'],plan)
  j=self.start(p);self.assertEqual(self.start(p),j);self.assertEqual(len([c for c in self.r.calls if c[0]=='spawn']),1)
 def test_dev_to_accepted_test_same_image_no_build(self):
  p=self.plan();j=self.start(p);job=self.work(j);self.assertEqual(job['status'],'ready');self.assertEqual(self.r.builds,1)
  call=[c for c in self.r.calls if c[0]=='compose'][0]
  self.assertEqual(call[2],['up','-d','--no-deps','--no-build','--pull','never','api','web']);self.assertEqual(call[3],IM)
  accepted=self.r.accept({'jobId':j['jobId'],'confirmation':True});self.assertEqual(self.r.accept({'jobId':j['jobId'],'confirmation':True}),accepted)
  p2=self.r.promote({'releaseId':accepted['releaseId']});self.assertEqual(p2['environment'],'test');j2=self.start(p2);self.assertEqual(self.work(j2)['status'],'ready');self.assertEqual(self.r.builds,1)
  self.assertEqual(self.r.get('job',j2['jobId'])['images'],IM)
 def test_failed_build_does_not_deploy(self):
  self.r.fail='build';job=self.work(self.start(self.plan()));self.assertEqual(job['status'],'failed');self.assertFalse(any(c[0]=='compose' for c in self.r.calls))
 def test_apply_failure_uncertain_no_rollback_and_readonly_reconcile(self):
  self.r.fail='up';j=self.start(self.plan());job=self.work(j);self.assertEqual(job['status'],'uncertain');n=len(self.r.calls)
  result=self.r.reconcile({'jobId':j['jobId']});self.assertTrue(result['readOnly']);self.assertEqual(len(self.r.calls),n)
  with self.assertRaises(m.Refused):self.r.accept({'jobId':j['jobId'],'confirmation':True})
  with self.assertRaises(m.Refused):self.start(self.plan())
 def test_drift_and_db_health(self):
  j=self.start(self.plan());self.r.images['api']='sha256:'+'8'*64
  self.assertEqual(self.work(j)['status'],'failed')
  job={'images':IM,'previous':healthy()};obs=healthy(IM);self.assertTrue(m.Release.matches(job,obs));obs['db']['containerId']='replacement';self.assertFalse(m.Release.matches(job,obs))
 def test_status_hides_worker_claim(self):
  j=self.start(self.plan());response=self.r.status({'jobId':j['jobId']});self.assertNotIn('workerToken',response);self.assertNotIn('actor',response)
 def test_unaccepted_promotion_refused(self):
  self.r.put('release',K,{'environment':'dev','accepted':False,'images':IM,'head':H})
  with self.assertRaises(m.Refused):self.r.promote({'releaseId':K})
 def test_worker_bad_token(self):
  j=self.start(self.plan())
  with self.assertRaises(m.Refused):self.r.worker(j['jobId'],'bad')
 def test_build_fixed_dockerfile_and_no_host_execution(self):
  repo=self.root/'repo';repo.mkdir();(repo/'backend').mkdir();(repo/'backend/pom.xml').write_text('<project/>');(repo/'package-lock.json').write_text('{}')
  commands=[]
  def fake_run(argv,**kwargs):
   commands.append((argv,kwargs))
   if 'build' in argv:pathlib.Path(argv[argv.index('--iidfile')+1]).write_text(IM['api'] if 'Release.api.Dockerfile' in ' '.join(argv) else IM['web'])
   return ''
  self.r.run=fake_run
  images=m.Release.build(self.r,repo,H,J);self.assertEqual(images,IM)
  self.assertIn('RUN mvn -B package\n',(repo/'Release.api.Dockerfile').read_text());self.assertNotIn('skipTests',(repo/'Release.api.Dockerfile').read_text());self.assertIn('npm ci && npm run build',(repo/'Release.web.Dockerfile').read_text());self.assertEqual(len(commands),2)
 def test_real_checkout_cleanup_success_and_failure(self):
  def git(args,cwd=None):
   if args[0]=='init':pathlib.Path(args[-1]).mkdir()
   if args[0]=='rev-parse':return H+'\n'
   return ''
  self.r.git=git
  with m.Release.checkout(self.r,K,H) as (repo,head):self.assertEqual(head,H);self.assertTrue(repo.is_dir())
  self.assertFalse((self.r.work/('source-'+K)).exists())
  with self.assertRaises(RuntimeError):
   with m.Release.checkout(self.r,J,H):raise RuntimeError('mock build failure')
  self.assertFalse((self.r.work/('source-'+J)).exists())
 def test_real_compose_exact_scoped_arguments(self):
  captured=[]
  self.r.run=lambda argv,**kw: captured.append((argv,kw)) or ''
  m.Release.compose(self.r,'dev',['up','-d','--no-deps','--no-build','--pull','never','api','web'],IM,True)
  argv,kw=captured[0];self.assertEqual(argv[:2],['mock-docker','compose']);self.assertEqual(argv[-8:],['up','-d','--no-deps','--no-build','--pull','never','api','web'])
  self.assertEqual(kw['extra'],{'API_IMAGE':IM['api'],'WEB_IMAGE':IM['web']});self.assertIn(str(m.ROOTS['dev']/'compose.override.yaml'),argv);self.assertNotIn('db',argv)
 def test_run_does_not_inherit_business_credentials(self):
  self.r.env={'PATH':'/usr/bin:/bin','HOME':'/private-state'}
  def subprocess_run(argv,**kw):
   self.assertEqual(kw['env'],self.r.env);self.assertEqual(kw['stdin'],m.subprocess.DEVNULL);self.assertNotIn('shell',kw)
   return type('Result',(),{'returncode':0})()
  with patch.object(m.subprocess,'run',subprocess_run):self.assertEqual(m.Release.run(self.r,['mock-tool']), '')
 def test_cleanup_never_adopts_existing_directory(self):
  p=self.r.work/('source-'+K);p.mkdir();(p/'unrelated').write_text('keep')
  with self.assertRaises(FileExistsError):
   with m.Release.checkout(self.r,K,H):pass
  self.assertTrue((p/'unrelated').exists())

 def test_public_contract_is_small_and_ui_compatible(self):
  j=self.start(self.plan());self.work(j)
  result=self.r.status({});self.assertEqual(result['jobId'],j['jobId']);self.assertEqual(result['status'],'delivered');self.assertFalse(result['accepted'])
  self.assertLess(len(json.dumps(result)),4096);self.assertNotIn('previous',result);self.assertNotIn('workerToken',result)
  accepted=self.r.accept({'jobId':j['jobId'],'confirmation':True});self.assertEqual(accepted['status'],'delivered');self.assertTrue(accepted['accepted']);self.assertEqual(accepted['releaseId'],j['jobId'])
 def test_build_keeps_named_images_and_no_prune(self):
  repo=self.root/'repo';repo.mkdir();(repo/'backend').mkdir();(repo/'backend/pom.xml').write_text('<project/>');(repo/'package-lock.json').write_text('{}')
  commands=[]
  def fake_run(argv,**kw):
   commands.append(argv)
   if 'build' in argv:pathlib.Path(argv[argv.index('--iidfile')+1]).write_text(IM['api'] if 'Release.api.Dockerfile' in ' '.join(argv) else IM['web'])
   return ''
  self.r.run=fake_run;m.Release.build(self.r,repo,H,J)
  self.assertTrue(all('--tag' in c and J in c[c.index('--tag')+1] for c in commands));self.assertFalse(any('prune' in c or 'rm' in c for c in commands))
 def test_cleanup_refuses_replaced_owned_root(self):
  def git(args,cwd=None):
   if args[0]=='init':pathlib.Path(args[-1]).mkdir()
   return H+'\n' if args[0]=='rev-parse' else ''
  self.r.git=git
  with self.assertRaises(m.Refused):
   with m.Release.checkout(self.r,K,H):
    owned=self.r.work/('source-'+K);saved=self.r.work/'saved';owned.rename(saved);owned.mkdir();(owned/'.release-owner').write_text((saved/'.release-owner').read_text())
  self.assertTrue((self.r.work/('source-'+K)).exists());self.assertTrue((self.r.work/'saved').exists())

unittest.main(argv=['fixture'],verbosity=2)
`;
test('server-release Python isolated mocked state machine and safety fixtures', () => {
  const result = spawnSync('python3', ['-I', '-c', fixture, source], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 19 tests/);
});
