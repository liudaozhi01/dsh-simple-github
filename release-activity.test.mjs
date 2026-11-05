import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Local standard-library fixtures only. No server, Docker, network or deployment.
const fixture = String.raw`
import contextlib, errno, importlib.util, json, os, pathlib, tempfile, unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('release',__import__('sys').argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
IDENTITY={'bootId':'12345678-1234-1234-1234-123456789abc','startTime':'987654'}
OTHER={**IDENTITY,'startTime':'987655'}
J='a'*32
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name)
  self.r=object.__new__(m.Release);self.r.state=self.root;self.r.user='operator';self.r.roots={'dev':self.root,'test':self.root}
  self.job=dict(jobId=J,status='running',environment='dev',actor='operator',stage='building',createdAt=1,workerPid=123,workerIdentity=IDENTITY,workerToken='PRIVATE_TOKEN',bundle={'path':'PRIVATE_PATH'})
  self.secure=patch.object(m,'secure',side_effect=lambda p,*args:pathlib.Path(p));self.secure.start()
 def tearDown(self):
  self.secure.stop();self.tmp.cleanup()
 def activity(self,current=IDENTITY,lock='held',job=None):
  @contextlib.contextmanager
  def observed(environment):yield lock
  with patch.object(self.r,'operation_lock_observation',observed),patch.object(m,'process_identity',return_value=current):
   return self.r.activity(job or self.job)['state']
 def test_evidence_matrix(self):
  for current in (IDENTITY,OTHER,None):
   for lock in ('held','free','unknown'):
    expected='active' if current==IDENTITY and lock=='held' else 'interrupted' if current!=IDENTITY and lock=='free' else 'unknown'
    with self.subTest(current=current,lock=lock):self.assertEqual(self.activity(current,lock),expected)
 def test_pid_reuse_and_reboot_never_active(self):
  for identity in (OTHER,{**IDENTITY,'bootId':'aaaaaaaa-1234-1234-1234-123456789abc'}):
   self.assertEqual(self.activity(identity,'held'),'unknown');self.assertEqual(self.activity(identity,'free'),'interrupted')
 def test_legacy_missing_identity_and_spawn_gap(self):
  legacy={k:v for k,v in self.job.items() if k!='workerIdentity'}
  for lock in ('free','held','unknown'):
   self.assertEqual(self.activity(IDENTITY,lock,legacy),'unknown')
   self.assertEqual(self.activity(None,lock,legacy),'interrupted' if lock=='free' else 'unknown')
  for pid in (None,0,-1,True,'123'):
   job={**self.job,'status':'pending','stage':'queued','workerPid':pid}
   with patch.object(m,'process_identity') as probe:
    self.assertEqual(self.r.activity(job),{'state':'unknown'});probe.assert_not_called()
 def test_stale_uncertain_is_not_automatically_finished(self):
  uncertain={**self.job,'status':'uncertain','stage':'health','finishedAt':1}
  self.assertEqual(self.activity(IDENTITY,'held',uncertain),'active')
  self.assertEqual(self.activity(None,'free',uncertain),'interrupted')
  self.assertEqual(self.activity(None,'held',uncertain),'unknown')
  self.assertEqual(self.activity(IDENTITY,'free',uncertain),'unknown')
 def test_terminal_finished_without_probes(self):
  for status in ('ready','accepted','failed'):
   with patch.object(m,'process_identity') as probe,patch.object(self.r,'operation_lock_observation') as lock:
    self.assertEqual(self.r.activity({**self.job,'status':status}),{'state':'finished'});probe.assert_not_called();lock.assert_not_called()
 def test_permission_and_malformed_evidence_are_unknown(self):
  for error in (PermissionError(errno.EACCES,'PRIVATE_SECRET'),OSError(errno.EIO,'PRIVATE_SECRET'),m.Refused('PRIVATE_SECRET'),ValueError('PRIVATE_SECRET'),IndexError('PRIVATE_SECRET')):
   with self.subTest(error=error),patch.object(m,'process_identity',side_effect=error):
    (self.root/'operation-dev.lock').touch()
    self.assertEqual(self.r.activity(self.job),{'state':'unknown'})
  for identity in ({},'bad',{'bootId':'bad','startTime':'1'},{**IDENTITY,'startTime':1}):
   self.assertEqual(self.activity(IDENTITY,'held',{**self.job,'workerIdentity':identity}),'unknown')
 def test_identity_recheck_catches_exit_or_pid_reuse(self):
  @contextlib.contextmanager
  def observed(environment):yield 'held'
  for after in (None,OTHER):
   with patch.object(self.r,'operation_lock_observation',observed),patch.object(m,'process_identity',side_effect=[IDENTITY,after]):
    self.assertEqual(self.r.activity(self.job),{'state':'unknown'})
 def test_real_readonly_lock_busy_free_missing_symlink_and_directory(self):
  path=self.root/'operation-dev.lock'
  with self.r.operation_lock_observation('dev') as value:self.assertEqual(value,'unknown')
  self.assertFalse(path.exists())
  path.write_bytes(b'unchanged');before=path.stat()
  fd=os.open(path,os.O_RDWR)
  try:
   m.fcntl.flock(fd,m.fcntl.LOCK_EX|m.fcntl.LOCK_NB)
   with self.r.operation_lock_observation('dev') as value:self.assertEqual(value,'held')
  finally:os.close(fd)
  with self.r.operation_lock_observation('dev') as value:self.assertEqual(value,'free')
  self.assertEqual(path.read_bytes(),b'unchanged');self.assertEqual(path.stat().st_mtime_ns,before.st_mtime_ns)
  target=self.root/'target';target.write_bytes(b'protected')
  symlink=self.root/'operation-test.lock';symlink.symlink_to(target)
  with self.r.operation_lock_observation('test') as value:self.assertEqual(value,'unknown')
  self.assertEqual(target.read_bytes(),b'protected')
  self.r.state=self.root/'other';self.r.state.mkdir();(self.r.state/'operation-dev.lock').mkdir()
  with self.r.operation_lock_observation('dev') as value:self.assertEqual(value,'unknown')
 def test_lock_permission_errors_and_replaced_inode_unknown(self):
  path=self.root/'operation-dev.lock';path.touch()
  with patch.object(m.os,'open',side_effect=PermissionError(errno.EACCES,'PRIVATE_SECRET')):
   with self.r.operation_lock_observation('dev') as value:self.assertEqual(value,'unknown')
  original=m.fcntl.flock
  def replaced(fd,flags):
   original(fd,flags);replacement=self.root/'replacement';replacement.touch();os.replace(replacement,path)
  with patch.object(m.fcntl,'flock',side_effect=replaced):
   with self.r.operation_lock_observation('dev') as value:self.assertEqual(value,'unknown')
 def test_process_stat_parser_does_not_read_cmdline(self):
  seen=[]
  def read(path,*args,**kwargs):
   seen.append(str(path))
   if str(path)=='/proc/123/stat':return '123 (worker name ) with parens) '+' '.join(['S']+['0']*18+['987654']+['0']*5)
   if str(path)=='/proc/sys/kernel/random/boot_id':return IDENTITY['bootId']+'\n'
   raise AssertionError('unexpected process read')
  with patch.object(pathlib.Path,'read_text',read):self.assertEqual(m.process_identity(123),IDENTITY)
  self.assertEqual(seen,['/proc/123/stat','/proc/sys/kernel/random/boot_id'])
  with patch.object(pathlib.Path,'read_text',side_effect=FileNotFoundError),patch.object(pathlib.Path,'is_file',return_value=True):self.assertIsNone(m.process_identity(123))
  with patch.object(pathlib.Path,'read_text',side_effect=FileNotFoundError),patch.object(pathlib.Path,'is_file',return_value=False):
   with self.assertRaises(m.Refused):m.process_identity(123)
 def test_public_status_overview_reads_never_modify_records(self):
  self.r.put('job',J,self.job);(self.root/'operation-dev.lock').touch()
  before={p.name:(p.read_bytes(),p.stat().st_mtime_ns) for p in self.root.iterdir()}
  with patch.object(m,'process_identity',return_value=None),patch.object(self.r,'put',side_effect=AssertionError('read wrote record')),patch.object(m.os,'kill',side_effect=AssertionError('read signalled worker')):
   explicit=self.r.status({'jobId':J});latest=self.r.status({});overview=self.r.overview({})
  for result in (explicit,latest,overview['jobs'][0]):
   self.assertEqual(result['activity'],{'state':'interrupted'});self.assertEqual(result['status'],'running');self.assertEqual(result['actor'],'operator');self.assertEqual(result['stage'],'building')
   for secret in ('PRIVATE_TOKEN','PRIVATE_PATH','workerIdentity','workerPid','bootId','startTime','cmdline'):
    self.assertNotIn(secret,json.dumps(result))
  self.assertEqual(before,{p.name:(p.read_bytes(),p.stat().st_mtime_ns) for p in self.root.iterdir()})
  self.assertNotIn('activity',m.Release.public_job(self.job))
 def test_worker_persists_identity_before_preflight(self):
  self.r.put('job',J,{**self.job,'status':'pending','planId':'b'*32})
  self.r.put('plan','b'*32,{'expiresAt':0})
  with patch.object(m,'process_identity',return_value=IDENTITY),patch.object(self.r,'deployment_failure_details',return_value=[]):
   self.r.worker(J,'PRIVATE_TOKEN')
  recorded=self.r.get('job',J)
  self.assertEqual(recorded['workerIdentity'],IDENTITY);self.assertEqual(recorded['workerPid'],os.getpid());self.assertEqual(recorded['status'],'failed')
unittest.main(argv=['fixture'],verbosity=2)
`;

test('release activity uses matching process identity and readonly lock evidence', () => {
  const source = fileURLToPath(new URL('./temporary-release.py', import.meta.url));
  const result = spawnSync('python3', ['-I', '-B', '-c', fixture, source], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 12 tests/);
});
