import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTemporaryReleaseClient } from './temporary-release-client.js';
import { DEFAULT_RELEASE_PROFILE } from './release-profile.js';

test('overview client uses readonly protocol without preparing source', async () => {
 const profile=structuredClone(DEFAULT_RELEASE_PROFILE);
 for(const key of Object.keys(profile.baseImages)) profile.baseImages[key]=`reviewed/${key.toLowerCase()}@sha256:${'a'.repeat(64)}`;
 const calls=[];
 const client=createTemporaryReleaseClient({profile,getUser:async()=>({name:'member'}),team:true,transport:async request=>{calls.push(request);return {jobs:[],releaseId:null};}});
 assert.deepEqual(await client.overview(),{jobs:[],releaseId:null});
 assert.equal(calls[0].action,'overview');assert.deepEqual(calls[0].body,{});assert.equal(calls[0].bundle,undefined);
 client.close();await assert.rejects(client.overview());
});

test('overview root state authorization, bounds and safe status fields (no server)', () => {
 const script = String.raw`
import importlib.util, tempfile, pathlib, json, time
from unittest.mock import patch

def load(name, file):
 s=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
m=load('engine','temporary-release.py'); b=load('broker','team-release-broker.py')
with tempfile.TemporaryDirectory() as d:
 r=object.__new__(m.Release);r.state=pathlib.Path(d);r.user='alice'
 with patch.object(m,'secure',side_effect=lambda p:p):
  for i in range(25):
   key=f'{i:032x}';r.put('job',key,dict(jobId=key,actor='alice',environment='dev',status='failed',stage='building',createdAt=100+i,error='PASSWORD=supersecret',workerToken='secret',bundle={'path':'/secret'}))
  r.put('job','f'*32,dict(jobId='f'*32,actor='bob',environment='dev',status='accepted',stage='awaiting-acceptance',createdAt=200,releaseId='f'*32,head='a'*40,images={'api':'sha256:'+'a'*64,'web':'sha256:'+'b'*64}))
  r.put('release','f'*32,dict(releaseId='f'*32,accepted=True,environment='dev'))
  result=r.overview({});assert len(result['jobs'])==20 and result['releaseId']=='f'*32
  assert any(j['actor']=='bob' for j in result['jobs'])
  assert result['jobs'][0]['jobId']=='f'*32
  assert 'supersecret' not in json.dumps(result) and 'workerToken' not in json.dumps(result) and 'bundle' not in json.dumps(result)
  for i in range(30):
   key=f'{100+i:032x}';r.put('job',key,dict(jobId=key,actor='alice',environment='test',status='failed',stage='preflight',createdAt=1000+i))
  onlydev=r.overview({'authorizedEnvironments':['dev']});assert len(onlydev['jobs'])==20 and all(j['environment']=='dev' for j in onlydev['jobs'])
  j=next(j for j in result['jobs'] if j['status']=='failed');assert j['errorCode']=='BUILD_FAILED' and j['updatedAt']>=j['createdAt'] and j['elapsedSeconds']>=0
  assert j['errorSummary']==j['error']
  assert r.public_job(dict(jobId='a'*32,actor='alice',environment='dev',status='running',stage='applying',createdAt=int(time.time())-2))['stage']=='applying'
  c={'profile':{'stateRoot':d},'allowedUsers':{'dev':['alice'],'test':['reviewer']}}
  broker=b.Broker(c)
  assert broker.environment({'action':'overview','body':{}},'alice')=='dev'
  assert broker.public_overview(result,'alice')['releaseId'] is None
  assert broker.public_overview(result,'reviewer')['releaseId']=='f'*32
  assert broker.public_overview(result,'reviewer')['jobs']==result['jobs']
  assert broker.public_overview(result,'alice')['jobs']==result['jobs']
  try:broker.environment({'action':'overview','body':{}},'nobody');raise AssertionError('unauthorized')
  except b.Refused:pass
  for action in ('status','reconcile','accept'):
   with patch.object(broker,'record',return_value={'actor':'bob','environment':'dev'}):
    try:broker.environment({'action':action,'body':{'jobId':'f'*32}},'alice');raise AssertionError('cross-user')
    except b.Refused:pass
  assert b.request_object(b'{"action":"overview","body":{}}')['action']=='overview'
  try:b.request_object(b'{"action":"overview","body":{"actor":"bob"}}');raise AssertionError('spoof')
  except b.Refused:pass
print('bounded shared jobs, test-only release visibility, fixed errors, stage/timing and peer ACL passed')
`;
 const p=spawnSync('python3',['-c',script],{cwd:fileURLToPath(new URL('.',import.meta.url)),encoding:'utf8'});
 assert.equal(p.status,0,p.stdout+p.stderr);
});
