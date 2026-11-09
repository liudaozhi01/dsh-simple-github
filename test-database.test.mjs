import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// All Docker/MySQL I/O is mocked inside Python. Never contacts a real database.
test('private database helper: streaming backup, verified retention, restore and fail-closed contracts', () => {
  const modulePath = fileURLToPath(new URL('./test-database.py', import.meta.url));
  const script = String.raw`
import importlib.util, json, os, pathlib, subprocess, sys, tempfile, unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('helper',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
CID='a'*64; IMAGE='sha256:'+'b'*64; JOB='c'*32
class Release:
    def __init__(self,state):
        self.state=pathlib.Path(state); self.env={'PATH':'/usr/bin:/bin'}; self.config={'docker':'/mock/docker'}; self.projects={'test':'oa-test','dev':'oa-dev'}
    def active_override(self,e): return False
    def config_snapshot(self,e,override=False): return {'services':{'db':{'image':'mysql:8.0','environment':{'MYSQL_ROOT_PASSWORD':'synthetic-secret','MYSQL_DATABASE':'oa_test'}}}}
    def compose(self,e,args,override=False):
        assert args==['ps','-a','-q','db']; return CID
class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.r=Release(self.tmp.name)
        row={'Id':CID,'Image':IMAGE,'State':{'Running':True},'Config':{'Image':'mysql:8.0','Entrypoint':['docker-entrypoint.sh'],'Cmd':['mysqld'],'Labels':{'com.docker.compose.project':'oa-test','com.docker.compose.service':'db'}}}
        self.identity=patch.object(m.Database,'_command',return_value=json.dumps([row])); self.identity.start(); self.addCleanup(self.identity.stop)
        self.db=m.Database(self.r,'test'); self.identity.stop()
    def test_reviewed_mirror_pin_and_exact_safe_command(self):
        pin='mirror.example/library/mysql@sha256:'+'d'*64
        self.r.env['DSH_RELEASE_MYSQL_IMAGE']=pin
        config={'image':pin,'command':['--character-set-server=utf8mb4','--innodb-buffer-pool-size=512M'],'environment':{'MYSQL_ROOT_PASSWORD':'synthetic-secret','MYSQL_DATABASE':'oa_test'}}
        self.r.config_snapshot=lambda *a,**k:{'services':{'db':config}}
        row={'Id':CID,'Image':IMAGE,'State':{'Running':True},'Config':{'Image':pin,'Entrypoint':['docker-entrypoint.sh'],'Cmd':config['command'],'Labels':{'com.docker.compose.project':'oa-test','com.docker.compose.service':'db'}}}
        with patch.object(m.Database,'_command',return_value=json.dumps([row])):
            self.assertEqual(m.Database(self.r,'test').image,IMAGE)
            self.r.env['DSH_RELEASE_MYSQL_IMAGE']='different'
            with self.assertRaises(m.DatabaseError):m.Database(self.r,'test')
            self.r.env['DSH_RELEASE_MYSQL_IMAGE']=pin
            config['command']=['--init-file=/tmp/unsafe.sql']
            with self.assertRaises(m.DatabaseError):m.Database(self.r,'test')
    def prepared(self):
        self.db._quiescent=lambda:None; self.db.snapshot=lambda *a:{'tables':{}}; self.db._counts=lambda *a,**k:{}
        self.db._verify_scratch=lambda *a:None
        def dump(args,**kw):
            assert 'mysqldump' in args; assert 'synthetic-secret' not in str(args); assert kw['password']=='synthetic-secret'; kw['output'].write(b'-- synthetic dump\n')
        self.db._command=dump
    def test_stream_retention_permissions(self):
        self.prepared(); d=self.db._private_dir(); old=d/('1000000000000000000-'+JOB+'.sql'); old.write_bytes(b'old'); old.chmod(0o600)
        stages=[]; self.db.progress=stages.append; b=self.db.backup(JOB)
        self.assertFalse(old.exists()); self.assertEqual(pathlib.Path(b['path']).stat().st_mode&0o777,0o600); self.assertEqual(d.stat().st_mode&0o777,0o700)
        self.assertEqual(b['checksum'],m.Database._checksum(pathlib.Path(b['path']))); self.assertTrue(b['verified']); self.assertIn('db-backup-cleanup',stages)
    def test_failed_validation_preserves_old(self):
        self.prepared(); d=self.db._private_dir(); old=d/('1000000000000000000-'+JOB+'.sql'); old.write_bytes(b'old'); old.chmod(0o600)
        def fail(*a): raise m.DatabaseError('verification failed')
        self.db._verify_scratch=fail
        with self.assertRaises(m.DatabaseError): self.db.backup(JOB)
        self.assertEqual(list(d.iterdir()),[old])
    def test_future_backup_never_deletes_current(self):
        self.prepared(); d=self.db._private_dir(); future=d/('9999999999999999999-'+JOB+'.sql'); future.write_bytes(b'future'); future.chmod(0o600)
        with self.assertRaises(m.DatabaseError): self.db.backup(JOB)
        self.assertEqual(len(list(d.iterdir())),2); self.assertTrue(future.exists())
    def test_restore_checksum_before_mutation(self):
        self.prepared(); b=self.db.backup(JOB); pathlib.Path(b['path']).write_bytes(b'tamper'); calls=[]; self.db._reset=lambda:calls.append('reset')
        with self.assertRaises(m.DatabaseError): self.db.restore(b)
        self.assertEqual(calls,[])
    def test_restore_reset_full_schema_then_stdin(self):
        self.prepared(); b=self.db.backup(JOB); calls=[]; self.db._reset=lambda:calls.append('reset')
        def mysql(**kw): calls.append(kw['source'].read())
        self.db._mysql=mysql; self.db.restore(b); self.assertEqual(calls,['reset',b'-- synthetic dump\n'])
        b['database']='other'
        with self.assertRaises(m.DatabaseError): self.db.restore(b)
    def test_apply_failure_propagates(self):
        self.prepared()
        def fail(*a): raise m.DatabaseError('failed')
        self.db._mysql=fail
        with self.assertRaises(m.DatabaseError): self.db.apply(['ALTER TABLE t ADD x INT'])
        self.db.environment='dev'
        with self.assertRaises(m.DatabaseError): self.db.apply([])
    def test_command_credentials_stdin_and_failure_redaction(self):
        seen=[]
        def run(args,**kw):
            seen.append((args,kw)); kw['stdout'].write(b'ok'); return subprocess.CompletedProcess(args,0)
        with patch.object(m.subprocess,'run',run):
            self.assertEqual(self.db._mysql('SELECT 1;'),'ok')
        args,kw=seen[0]; self.assertNotIn('synthetic-secret',str(args)); self.assertEqual(kw['env']['MYSQL_PWD'],'synthetic-secret'); self.assertEqual(kw['input'],b'SELECT 1;'); self.assertIsNone(kw['stdin']); self.assertEqual(kw['stderr'],subprocess.DEVNULL)
        with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],1)):
            with self.assertRaisesRegex(m.DatabaseError,'output withheld'): self.db._mysql('secret data')
    def test_snapshot_metadata_contract(self):
        self.db._check_identity=lambda:None; self.db._supported=lambda **k:None
        def query(sql,**kw):
            if 'information_schema.TABLES' in sql: return [{'name':'t','engine':'InnoDB','collation':'utf8mb4_0900_bin','comment':'','options':''}]
            if 'information_schema.COLUMNS' in sql: return [{'name':'id','type':'bigint','nullable':0,'default':None,'extra':'auto_increment','comment':'','charset':None,'collation':None}]
            return []
        self.db._json=query; self.db._mysql=lambda *a,**k:'t\tCREATE TABLE '+chr(96)+'t'+chr(96)+' (\n  '+chr(96)+'id'+chr(96)+' bigint NOT NULL AUTO_INCREMENT\n) ENGINE=InnoDB AUTO_INCREMENT=21 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin\n'
        table=self.db.snapshot()['tables']['t']; self.assertNotIn('AUTO_INCREMENT=21',table['createSQL']); self.assertNotIn('default',table['columns']['id']); self.assertFalse(table['columns']['id']['nullable'])
    def test_quiescent_rejects_other_sessions_and_inbound_fk(self):
        self.db._network_boundary=lambda:None; self.db._writers_stopped=lambda:None; self.db._check_identity=lambda:None; self.db._supported=lambda:None
        self.db._json=lambda sql: [{'n':1}] if 'KEY_COLUMN_USAGE' in sql else [{'events':'OFF','writers':0}]
        with self.assertRaises(m.DatabaseError): self.db._quiescent()
        self.db._json=lambda sql: [{'n':0}] if 'KEY_COLUMN_USAGE' in sql else [{'events':'ON','writers':0}]
        with self.assertRaises(m.DatabaseError): self.db._quiescent()
    def test_network_rejects_published_ports_and_other_clients(self):
        netid='e'*64
        row={'HostConfig':{'PortBindings':{}},'NetworkSettings':{'Ports':{'3306/tcp':None},'Networks':{'oa':{'NetworkID':netid}}}}
        net={'Id':netid,'Driver':'bridge','Labels':{'com.docker.compose.project':'oa-test'},'Containers':{CID:{}}}
        self.db._command=lambda args:json.dumps([net if args[0]=='network' else row])
        self.db._network_boundary()
        net['Containers']['f'*64]={}
        with self.assertRaises(m.DatabaseError): self.db._network_boundary()
        net['Containers']={CID:{}}; row['HostConfig']['PortBindings']={'3306/tcp':[{'HostPort':'3306'}]}
        with self.assertRaises(m.DatabaseError): self.db._network_boundary()
    def test_writers_must_be_stopped(self):
        self.r.compose=lambda e,args,override=False:CID
        def inspect(args):
            return json.dumps([{'Id':CID,'Config':{'Labels':{'com.docker.compose.project':'oa-test','com.docker.compose.service':self.service}},'State':{'Running':True}}])
        self.service='api'; self.db._command=inspect
        with self.assertRaises(m.DatabaseError): self.db._writers_stopped()
    def test_scratch_isolated_and_removed_exact_id(self):
        self.db.progress=lambda s:None; commands=[]; self.db._mysql=lambda *a,**kw:'1'; self.db.snapshot=lambda *a:{'tables':{}}; self.db._counts=lambda *a,**kw:{}
        self.db._command=lambda a,**kw:commands.append(a)
        scratch='d'*64
        def create(args,**kw):
            self.assertIn('--network=none',args); self.assertIn('--tmpfs',args); self.assertIn(IMAGE,args); self.assertNotIn('synthetic-secret',str(args)); self.assertNotIn('-p',args); self.assertNotIn('-v',args); kw['stdout'].write((scratch+'\n').encode()); return subprocess.CompletedProcess(args,0)
        p=pathlib.Path(self.tmp.name)/'fixture.sql'; p.write_bytes(b'-- fixture')
        with patch.object(m.subprocess,'run',create): self.db._verify_scratch(p,{'tables':{}},{})
        self.assertEqual(commands[-1],['rm','-f','-v',scratch])
unittest.main(argv=['tests'],verbosity=2)
`;
  const result = spawnSync('python3', ['-B', '-c', script, modulePath], {encoding:'utf8', timeout:30000});
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
