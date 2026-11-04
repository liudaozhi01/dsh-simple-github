import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('./temporary-release.py', import.meta.url));
// Pure local standard-library fixtures. No Docker, SSH, network or root writes.
const fixture = String.raw`
import contextlib, importlib.util, json, pathlib, tempfile, time, unittest, io, tarfile, hashlib
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('release',__import__('sys').argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
H='c'*40; J='b'*32
IM={'api':'sha256:'+'1'*64,'web':'sha256:'+'2'*64}
OLD={'api':'sha256:'+'3'*64,'web':'sha256:'+'4'*64}
def profile():
 return {'repository':'example/oa','branch':'dev','target':{'alias':'example','host':'example.test','user':'operator','port':22},'allowedNames':{'dev':['Owner'],'test':['Owner']},'roots':{'dev':'/opt/example-dev','test':'/opt/example-test'},'projects':{'dev':'example-dev','test':'example-test'},'stateRoot':'/opt/example-state','baseImages':{k:'example/image@sha256:'+'a'*64 for k in ('node','mavenJava21','java','nginx')}}
def healthy(images=OLD):
 return {s:{'containerId':s,'imageId':images[s] if s!='db' else 'sha256:'+'5'*64,'healthy':True} for s in ('api','web','db')}
class Fake(m.Release):
 def __init__(self,root):
  self.state=root/'state';self.state.mkdir();self.stage=root/'stage';self.stage.mkdir();self.entry=self.stage/'script.py';self.entry.write_text('mock');self.keep_stage=False
  self.profile=profile();self.profile_id=m.digest(self.profile);self.roots={e:root/e for e in ('dev','test')};self.projects=self.profile['projects'];self.config={'docker':'mock-docker','baseImages':self.profile['baseImages']};self.user='operator';self.env={};self.images=OLD.copy();self.override=False;self.calls=[];self.builds=0;self.fail=None
  for p in self.roots.values():p.mkdir()
 def active_override(self,e):return self.override
 def config_snapshot(self,e,images=None,override=False):return {'services':{s:{'image':(images or self.images)[s] if s!='db' else 'existing-db'} for s in ('api','web','db')}}
 def observe(self,e):return healthy(self.images)
 def inspect_images(self,images):m.require(set(images)=={'api','web'} and all(m.IMAGE.fullmatch(v) for v in images.values()),'IDs required')
 def spawn(self,j,t):self.calls.append(('spawn',j,t))
 @contextlib.contextmanager
 def checkout(self,key,head=None):yield self.stage,head
 def build(self,repo,head,key):
  self.builds+=1
  if self.fail=='build':raise m.Refused('mock build failed')
  return IM.copy()
 def compose(self,e,args,images=None,override=False):
  self.calls.append(('compose',e,args,images,override))
  if self.fail=='up':raise m.Refused('ambiguous failure')
  self.images=images.copy();self.override=True;return ''
class Tests(unittest.TestCase):
 def test_broker_uses_legacy_global_lock_across_environments(self):
  import os
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp); a=m.Release.__new__(m.Release);a.broker=True;a.state=root/'a';a.state.mkdir()
   b=m.Release.__new__(m.Release);b.broker=True;b.state=root/'b';b.state.mkdir()
   real_open=os.open
   def redirected(path,*args,**kwargs):
    return real_open(root/'legacy.lock' if str(path)=='/var/lib/xian-oa-release/.release.lock' else path,*args,**kwargs)
   with patch.object(m,'secure'),patch.object(m.os,'open',side_effect=redirected):
    with a.lock('operation-dev',blocking=False):
     with self.assertRaisesRegex(m.Refused,'shared server lock'):
      with b.lock('operation-test',blocking=False):pass
    with b.lock('operation-test',blocking=False):pass
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);self.secure=patch.object(m,'secure',lambda p,directory=False:pathlib.Path(p));self.secure.start();self.verify=patch.object(m,'verify_bundle',lambda b,s:None);self.verify.start();self.r=Fake(self.root)
 def tearDown(self):self.verify.stop();self.secure.stop();self.tmp.cleanup()
 def plan(self):return self.r.check({'head':H})
 def start(self,p):return self.r.start({'planId':p['planId'],'confirmation':True,'databaseRiskAccepted':True,**({'bundle':{'path':str(self.r.stage/'archive.tar.gz'),'sha256':'a'*64,'size':1}} if p['environment']=='dev' else {})})
 def work(self,j):
  job=self.r.get('job',j['jobId']);self.r.worker(j['jobId'],job['workerToken']);return self.r.get('job',j['jobId'])
 def restore_fixture(self,environment):
  self.r.put('job',J,{'jobId':J,'environment':environment,'status':'ready','head':H,'images':IM,'actor':'other','createdAt':1})
  return self.r.restore({'environment':environment,'jobId':J})
 def test_restore_both_environments_without_build_or_bundle(self):
  for environment in ('dev','test'):
   p=self.restore_fixture(environment)
   j=self.r.start({'planId':p['planId'],'confirmation':True,'databaseRiskAccepted':True})
   self.assertEqual(self.r.start({'planId':p['planId'],'confirmation':True,'databaseRiskAccepted':True})['jobId'],j['jobId'])
   self.assertEqual(self.work(j)['status'],'ready');self.assertEqual(self.r.builds,0)
   self.assertEqual([c[1] for c in self.r.calls if c[0]=='compose'][-1],environment)
 def test_restore_rejects_cross_environment_failed_missing_images_and_bundle(self):
  p=self.restore_fixture('dev')
  with self.assertRaises(m.Refused):self.r.restore({'environment':'test','jobId':J})
  with self.assertRaises(m.Refused):self.start(p)
  source=self.r.get('job',J);source['status']='failed';self.r.put('job',J,source)
  with self.assertRaises(m.Refused):self.r.restore({'environment':'dev','jobId':J})
  source['status']='ready';self.r.put('job',J,source)
  with patch.object(self.r,'inspect_images',side_effect=m.Refused('missing image')):
   with self.assertRaises(m.Refused):self.r.restore({'environment':'dev','jobId':J})
 def test_restore_worker_revalidates_source_before_mutation(self):
  p=self.restore_fixture('test');j=self.r.start({'planId':p['planId'],'confirmation':True,'databaseRiskAccepted':True})
  source=self.r.get('job',J);source['head']='d'*40;self.r.put('job',J,source)
  self.assertEqual(self.work(j)['status'],'failed');self.assertFalse(any(c[0]=='compose' for c in self.r.calls))
 def test_command_failure_keeps_bounded_private_diagnostics(self):
  import sys
  with self.assertRaisesRegex(m.Refused,'output withheld'):
   m.Release.run(self.r,[sys.executable,'-c','print("diagnostic-only"); raise SystemExit(1)'])
  log=self.r.state/'last-command-failure.log'
  self.assertEqual(log.read_text(),'diagnostic-only\n');self.assertEqual(log.stat().st_mode & 0o777,0o600)
 def test_preflight_returns_root_cause_without_creating_job(self):
  message="Referencing column 'employee_id' and referenced column 'id' in foreign key constraint 'rbac_account_ibfk_1' are incompatible."
  def run(argv,**kwargs):
   if argv[1]=='inspect':return json.dumps([{'Config':{'Image':OLD['api'],'Labels':{'com.docker.compose.project':self.r.projects['dev'],'com.docker.compose.service':'api'}}}])
   return 'password=secret\n'+message
  with patch.object(self.r,'observe',side_effect=m.Refused('Expected one existing container per service')),patch.object(self.r,'compose',return_value='a'*64),patch.object(self.r,'run',side_effect=run):
   with self.assertRaisesRegex(m.Refused,'Preflight service failure') as caught:self.plan()
  self.assertIn(message,str(caught.exception));self.assertNotIn('secret',str(caught.exception));self.assertEqual(list(self.r.state.glob('job-*')),[])
 def test_safe_structural_diagnostics(self):
  message="Referencing column 'employee_id' and referenced column 'id' in foreign key constraint 'rbac_account_ibfk_1' are incompatible."
  raw='password=secret SELECT confidential FROM payroll\nCaused by: java.sql.SQLException: '+message+'\nAuthorization: Bearer hidden'
  self.assertEqual(m.failure_details(raw),[message])
  public=m.Release.public_job({'status':'uncertain','stage':'applying','createdAt':1,'errorDetails':[raw]})
  self.assertEqual(public['errorDetails'],[message]);self.assertIn(message,public['errorSummary']);self.assertIn('不要重复发布',public['errorSummary'])
  self.assertNotIn('secret',json.dumps(public));self.assertNotIn('payroll',json.dumps(public))
 def test_diagnostics_validate_container_identity(self):
  message="Referencing column 'employee_id' and referenced column 'id' in foreign key constraint 'rbac_account_ibfk_1' are incompatible."
  self.r.last_failure_details=['dependency failed to start: container example-dev-api-1 is unhealthy']
  job={'environment':'dev','images':IM,'createdAt':123};calls=[]
  def compose(e,args,**kwargs):
   self.assertEqual(args[:3],['ps','-a','-q']);return 'a'*64
  def run(argv,**kwargs):
   calls.append(argv)
   if argv[1]=='inspect':return json.dumps([{'Image':IM['api'],'Config':{'Labels':{'com.docker.compose.project':self.r.projects['dev'],'com.docker.compose.service':'api'}}}])
   return 'password=secret\n'+message
  with patch.object(self.r,'compose',side_effect=compose),patch.object(self.r,'run',side_effect=run):
   details=self.r.deployment_failure_details(job)
  self.assertIn(message,details);self.assertEqual(sum(c[1]=='logs' for c in calls),1)
  self.assertTrue(all(c[1] in ('inspect','logs') for c in calls));self.assertNotIn('secret',json.dumps(details))
 def test_apply_persists_details_and_diagnostic_failure_is_safe(self):
  self.r.fail='up';message='dependency failed to start: container example-dev-api-1 is unhealthy'
  with patch.object(self.r,'deployment_failure_details',return_value=[message]):
   job=self.work(self.start(self.plan()))
  self.assertEqual(job['status'],'uncertain');self.assertEqual(job['errorDetails'],[message]);self.assertIn(message,m.Release.public_job(job)['errorSummary'])
  with patch.object(self.r,'compose',side_effect=RuntimeError('password=secret')):
   self.assertEqual(self.r.deployment_failure_details(job),[])
 def test_legacy_job_safe_fallback(self):
  public=m.Release.public_job({'status':'uncertain','stage':'applying','createdAt':1,'error':'password=secret'})
  self.assertIn('未提取到',public['errorSummary']);self.assertNotIn('secret',json.dumps(public))
 def test_broker_helper_private_stage(self):
  from types import SimpleNamespace
  self.r.broker=True;self.r.env['DSH_RELEASE_MYSQL_IMAGE']='mysql@sha256:'+'a'*64
  helper=self.r.stage/'build.py';helper.write_text('def build(*args): return {"api":"ok"}\n');helper.chmod(0o600)
  actual=pathlib.Path.lstat
  def metadata(path):
   v=actual(path)
   return SimpleNamespace(st_uid=0,st_mode=v.st_mode,st_nlink=v.st_nlink)
  with patch.object(m,'validate_stage') as validate,patch.object(pathlib.Path,'lstat',metadata):
   self.assertEqual(m.Release.build(self.r,self.r.stage,H,J),{'api':'ok'});validate.assert_called_once_with(self.r.entry)
   helper.chmod(0o644)
   with self.assertRaisesRegex(m.Refused,'private build helper'): m.Release.build(self.r,self.r.stage,H,J)
 def test_profile(self):
  p=profile();self.assertEqual(m.validate_profile(p),p)
  for change in ({'token':'secret'},{'stateRoot':'/tmp/state'},{'roots':{'dev':'/opt/a','test':'/opt/a/b'}},{'repository':'https://token@github.com/e/r.git'},{'projects':{'dev':'same','test':'same'}},{'baseImages':{k:'node:latest' for k in p['baseImages']}}):
   with self.assertRaises(m.Refused):m.validate_profile({**p,**change})
 def test_check_strict_sha(self):
  p=self.plan();self.assertEqual(p['remote']['head'],H);self.assertLessEqual(p['expiresAt'],time.time()+300)
  for body in ({},{'head':'dev'},{'head':H,'environment':'dev'}):
   with self.assertRaises(m.Refused):self.r.check(body)
 def test_strict_dispatch_json(self):
  for request in ({'action':'shell','body':{}},{'action':'status','body':[]},{'action':[],'body':{}},{'action':'status','body':{},'token':'x'}):
   with self.assertRaises(m.Refused):self.r.dispatch({'profile':self.r.profile,**request})
  for text in ('{"a":1,"a":2}','{"a":NaN}'):
   with self.assertRaises(m.Refused):m.loads(text)
 def test_start_confirmation_expiry_and_idempotency(self):
  p=self.plan()
  with self.assertRaises(m.Refused):self.r.start({'planId':p['planId'],'confirmation':1,'databaseRiskAccepted':True})
  plan=self.r.get('plan',p['planId']);plan['expiresAt']=0;self.r.put('plan',p['planId'],plan)
  with self.assertRaises(m.Refused):self.start(p)
  plan['expiresAt']=time.time()+300;self.r.put('plan',p['planId'],plan);j=self.start(p);self.assertEqual(self.start(p),j);self.assertEqual(len(self.r.calls),1);self.assertTrue(self.r.keep_stage)
 def test_same_images_accepted_dev_to_test(self):
  j=self.start(self.plan());self.assertEqual(self.work(j)['status'],'ready');accepted=self.r.accept({'jobId':j['jobId'],'confirmation':True});p=self.r.promote({'releaseId':accepted['releaseId']});j2=self.start(p);self.assertEqual(self.work(j2)['status'],'ready');self.assertEqual(self.r.builds,1);self.assertEqual(self.r.get('job',j2['jobId'])['images'],IM)
  for call in self.r.calls:
   if call[0]=='compose':self.assertEqual(call[2],['up','-d','--no-deps','--no-build','--pull','never','api','web'])
 def test_ready_dev_allows_next_without_faking_acceptance(self):
  first=self.start(self.plan());self.assertEqual(self.work(first)['status'],'ready')
  self.assertFalse((self.r.state/('release-'+first['jobId']+'.json')).exists())
  self.r.put('release',first['jobId'],{'environment':'dev','accepted':False})
  promoted=self.r.promote({'releaseId':first['jobId']});testjob=self.start(promoted);self.assertEqual(self.work(testjob)['status'],'ready');self.assertEqual(self.r.builds,1)
  second=self.start(self.plan());self.assertNotEqual(first['jobId'],second['jobId']);self.assertEqual(self.r.get('job',first['jobId'])['status'],'ready')
  with self.assertRaises(m.Refused):self.start(self.plan())
 def test_build_failure_does_not_apply(self):
  self.r.fail='build';self.assertEqual(self.work(self.start(self.plan()))['status'],'failed');self.assertFalse(any(c[0]=='compose' for c in self.r.calls))
 def test_apply_uncertain_no_replay(self):
  self.r.fail='up';j=self.start(self.plan());self.assertEqual(self.work(j)['status'],'uncertain');n=len(self.r.calls);self.assertTrue(self.r.reconcile({'jobId':j['jobId']})['readOnly']);self.assertEqual(len(self.r.calls),n)
  with self.assertRaises(m.Refused):self.r.accept({'jobId':j['jobId'],'confirmation':True})
  with self.assertRaises(m.Refused):self.start(self.plan())
 def test_drift_and_db_identity(self):
  j=self.start(self.plan());self.r.images['api']='sha256:'+'8'*64;self.assertEqual(self.work(j)['status'],'failed');obs=healthy(IM);job={'images':IM,'previous':healthy()};self.assertTrue(m.Release.matches(job,obs));obs['db']['containerId']='changed';self.assertFalse(m.Release.matches(job,obs))
 def test_public_job_and_query(self):
  j=self.start(self.plan());result=self.r.dispatch({'profile':self.r.profile,'action':'query','body':{'jobId':j['jobId']}});self.assertNotIn('workerToken',result);self.assertNotIn('bundle',result);self.assertEqual(result['actor'],'operator');self.assertGreaterEqual(result['elapsedSeconds'],0);self.assertIn('updatedAt',result)
  self.assertEqual(self.r.status({})['jobId'],j['jobId']);self.r.user='another';self.assertEqual(self.r.status({}),{'status':'idle'})
 def test_bundle_required_only_dev(self):
  p=self.plan()
  with self.assertRaises(m.Refused):self.r.start({'planId':p['planId'],'confirmation':True,'databaseRiskAccepted':True})
  j=self.start(p);self.work(j);a=self.r.accept({'jobId':j['jobId'],'confirmation':True});p=self.r.promote({'releaseId':a['releaseId']})
  with self.assertRaises(m.Refused):self.r.start({'planId':p['planId'],'confirmation':True,'databaseRiskAccepted':True,'bundle':{}})
 def test_detached_spawn(self):
  captured=[]
  with patch.object(m.subprocess,'Popen',lambda argv,**kw:captured.append((argv,kw))),patch.object(m.pwd,'getpwnam',lambda u:type('U',(),{'pw_uid':123})()):m.Release.spawn(self.r,J,'a'*64)
  argv,kw=captured[0];self.assertEqual(argv[:2],['/usr/bin/python3','-I']);self.assertTrue(kw['start_new_session']);self.assertTrue(kw['close_fds']);self.assertEqual(kw['stdin'],m.subprocess.DEVNULL);self.assertNotIn('DB_PASSWORD',kw['env']);self.assertEqual(m.loads(m.base64.b64decode(argv[-1]).decode())['action'],'_worker')
 def archive(self,entries):
  path=self.root/('archive-'+str(len(list(self.root.glob('archive-*'))))+'.tar.gz')
  with tarfile.open(path,'w:gz') as tar:
   for name,kind,data in entries:
    i=tarfile.TarInfo(name);i.type=kind;i.size=len(data) if kind==tarfile.REGTYPE else 0;tar.addfile(i,io.BytesIO(data) if kind==tarfile.REGTYPE else None)
  return path
 def test_extract_prefix(self):
  a=self.archive([('prefix/a.txt',tarfile.REGTYPE,b'ok'),('prefix/backend/pom.xml',tarfile.REGTYPE,b'p')]);dest=self.root/'extract';dest.mkdir();m.extract_bundle(a,dest);self.assertEqual((dest/'a.txt').read_bytes(),b'ok');self.assertFalse((dest/'prefix').exists());self.assertTrue(a.exists())
 def test_extract_rejects_traversal_links_devices_secrets(self):
  entries=[('../escape',tarfile.REGTYPE,b'x'),('/absolute/a',tarfile.REGTYPE,b'x'),('p/../escape',tarfile.REGTYPE,b'x'),('p/link',tarfile.SYMTYPE,b''),('p/link',tarfile.LNKTYPE,b''),('p/device',tarfile.CHRTYPE,b''),('p/.env.production',tarfile.REGTYPE,b'x'),('p/id.key',tarfile.REGTYPE,b'x')]
  for n,entry in enumerate(entries):
   d=self.root/('reject'+str(n));d.mkdir()
   with self.assertRaises(m.Refused):m.extract_bundle(self.archive([entry]),d)
 def test_extract_rejects_duplicate_and_multiple_prefix(self):
  for n,entries in enumerate(([('p/a',tarfile.REGTYPE,b'1'),('p/a',tarfile.REGTYPE,b'2')],[('p/a',tarfile.REGTYPE,b'1'),('q/b',tarfile.REGTYPE,b'2')])):
   d=self.root/('duplicate'+str(n));d.mkdir()
   with self.assertRaises(m.Refused):m.extract_bundle(self.archive(entries),d)
 def test_real_bundle_digest_size_path(self):
  self.verify.stop();stage=self.root/'bundle';stage.mkdir();a=stage/'archive.tar.gz';a.write_bytes(b'\x1f\x8bmock');a.chmod(0o600);b={'path':str(a),'sha256':hashlib.sha256(a.read_bytes()).hexdigest(),'size':a.stat().st_size};original=pathlib.Path.lstat
  def owned(path,*args,**kw):
   st=original(path,*args,**kw);return type('S',(),{'st_uid':0,'st_mode':st.st_mode,'st_nlink':st.st_nlink,'st_size':st.st_size})()
  with patch.object(pathlib.Path,'lstat',owned):
   m.verify_bundle(b,stage)
   for change in ({'size':True},{'size':1},{'sha256':'b'*64},{'path':str(self.root/'outside')},{'extra':1}):
    with self.assertRaises(m.Refused):m.verify_bundle({**b,**change},stage)
  self.verify.start()
 def test_generated_multistage_build_no_host_scripts(self):
  repo=self.root/'source';repo.mkdir();(repo/'backend').mkdir();(repo/'backend/pom.xml').write_text('p');(repo/'package-lock.json').write_text('{}');calls=[]
  def run(argv,**kw):
   calls.append(argv)
   if 'build' in argv:pathlib.Path(argv[argv.index('--iidfile')+1]).write_text(IM['api'] if 'Release.api.Dockerfile' in ' '.join(argv) else IM['web'])
   return ''
  self.r.run=run;self.assertEqual(m.Release.build(self.r,repo,H,J),IM);self.assertEqual(len(calls),2);self.assertTrue(all(c[0]=='mock-docker' and '--tag' in c for c in calls));self.assertIn('RUN mvn -B package\n',(repo/'Release.api.Dockerfile').read_text());self.assertIn('npm ci && npm run build',(repo/'Release.web.Dockerfile').read_text());self.assertFalse(any('prune' in c for c in calls))
 def test_run_clean_environment(self):
  self.r.env={'PATH':'/usr/bin:/bin'}
  def run(argv,**kw):self.assertEqual(kw['env'],self.r.env);self.assertEqual(kw['stdin'],m.subprocess.DEVNULL);self.assertNotIn('shell',kw);return type('R',(),{'returncode':0})()
  with patch.object(m.subprocess,'run',run):self.assertEqual(m.Release.run(self.r,['mock']), '')

 def test_cleanup_waits_for_worker_and_refuses_wrong_target(self):
  self.r.stage_identity=self.r.stage.stat();self.r.keep_stage=True
  with patch.object(m,'validate_stage',lambda p:p.parent),patch.object(m.shutil,'rmtree') as remove:
   self.r.cleanup();remove.assert_not_called();self.r.keep_stage=False
   with self.assertRaises(m.Refused):self.r.cleanup()
   remove.assert_not_called()
 def test_cleanup_refuses_replaced_stage_inode(self):
  self.r.stage_identity=type('S',(),{'st_dev':-1,'st_ino':-1})()
  with patch.object(m,'validate_stage',lambda p:p.parent),patch.object(m.shutil,'rmtree') as remove:
   with self.assertRaises(m.Refused):self.r.cleanup()
   remove.assert_not_called()
 def test_stage_contract_refuses_arbitrary_script(self):
  with self.assertRaises(m.Refused):m.validate_stage(self.r.entry)
 def test_worker_claim_and_unaccepted_release(self):
  j=self.start(self.plan())
  with self.assertRaises(m.Refused):self.r.worker(j['jobId'],'bad')
  for status in ('pending','running','failed','uncertain'):
   self.r.put('job',J,{'jobId':J,'environment':'dev','status':status,'images':IM,'head':H})
   with self.assertRaises(m.Refused):self.r.promote({'releaseId':J})

unittest.main(argv=['fixture'],verbosity=2)
`;
test('temporary release isolated Python state machine, archive and lifecycle fixtures', () => {
  const result = spawnSync('python3', ['-I', '-B', '-c', fixture, source], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 33 tests/);
});
