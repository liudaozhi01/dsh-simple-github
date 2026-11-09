import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {mount} from './panel.js';
import {createTemporaryReleaseClient} from './temporary-release-client.js';
import {DEFAULT_RELEASE_PROFILE} from './release-profile.js';
const digest='a'.repeat(64);
class Element{constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.style={};this.textContent='';}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}setAttribute(k,v){this.attributes[k]=v;}contains(n){return n===this||this.children.some(c=>c.contains(n));}querySelectorAll(){return [];}}
const all=n=>[n,...n.children.flatMap(all)],tick=()=>new Promise(r=>setImmediate(r));
async function exercise(answers){const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};const calls=[],prompts=[];let dispose;globalThis.document={createElement:t=>new Element(t)};globalThis.confirm=text=>{prompts.push(text);return answers.shift()??false;};globalThis.setTimeout=()=>1;globalThis.clearTimeout=()=>{};globalThis.fetch=async(url,opt={})=>{const body=opt.body?JSON.parse(opt.body):{};calls.push({url,body});let value={};if(url.endsWith('/status'))value={csrfToken:'x',user:{name:'刘道志'}};if(url.endsWith('/update-check'))value={available:false};if(url.endsWith('/docker-overview'))value={jobs:[],releaseId:'dev1'};if(url.endsWith('/docker-promote'))return{ok:false,json:async()=>({error:'数据库结构差异需要人工审查，未执行 SQL、未修改数据库'})};if(url.endsWith('/docker-start'))value={jobId:'job1',status:'ready'};return{ok:true,json:async()=>value};};const root=new Element('root');try{dispose=mount(root);await tick();all(root).find(n=>n.textContent==='远程部署').onclick();await tick();await tick();all(root).find(n=>n.textContent==='发布 test').onclick();for(let n=0;n<8;n++)await tick();return{calls,prompts,text:all(root).map(n=>n.textContent).join("\n")};}finally{dispose?.();Object.assign(globalThis,old);}}
test('schema refusal displays reason without offering preview or second processing',async()=>{
 const {calls,prompts,text}=await exercise([true,true,true]);
 assert.equal(calls.filter(c=>c.url.endsWith('/docker-promote')).length,1);
 assert.deepEqual(prompts,[]);
 assert.ok(!calls.some(c=>c.url.endsWith('/docker-start')));
 assert.match(text,/数据库结构差异需要人工审查/);
 assert.ok(!calls.some(c=>Object.hasOwn(c.body,'databaseMode')));
});
test('entry broker and engine reject all force request fields as unknown',()=>{
 execFileSync('python3',['-I','-B','-c',String.raw`
import runpy,json
for path in ('team-release-entry.py','team-release-broker.py'):
 m=runpy.run_path(path); parse=m.get('validate_request') or m['request_object']
 parse(json.dumps({'action':'promote','body':{'releaseId':'dev1'}}).encode())
 parse(json.dumps({'action':'start','body':{'planId':'a'*32,'confirmation':True,'databaseRiskAccepted':True}}).encode())
 for action,base in (('promote',{'releaseId':'dev1'}),('start',{'planId':'a'*32,'confirmation':True,'databaseRiskAccepted':True})):
  for field,value in (('databaseMode','force-test'),('databaseMode',None),('databaseConfirmation',{'scopeDigest':'a'*64,'ack':True}),('databasePreview',{}),('databaseForcePlan',{})):
   try:parse(json.dumps({'action':action,'body':{**base,field:value}}).encode())
   except Exception as e:assert str(e)=='Invalid action fields',str(e)
   else:raise AssertionError('unknown force field accepted')
m=runpy.run_path('temporary-release.py');r=m['Release'].__new__(m['Release'])
for action,base in (('promote',{'releaseId':'dev1'}),('start',{'planId':'a'*32,'confirmation':True,'databaseRiskAccepted':True})):
 for field,value in (('databaseMode','force-test'),('databaseConfirmation',{'scopeDigest':'a'*64,'ack':True})):
  try:getattr(r,action)({**base,field:value})
  except m['Refused'] as e:assert 'field' in str(e).lower(),str(e)
  else:raise AssertionError('engine accepted force field')
`],{cwd:import.meta.dirname});
});
function clientFixture(extra={}) {
 const profile=structuredClone(DEFAULT_RELEASE_PROFILE);for(const key of Object.keys(profile.baseImages))profile.baseImages[key]=`reviewed/${key.toLowerCase()}@sha256:${'b'.repeat(64)}`;
 const calls=[];const client=createTemporaryReleaseClient({profile,getUser:async()=>({name:'刘道志'}),transport:async request=>{calls.push(request);return{planId:'safe-plan',environment:'test',remote:{repository:profile.repository,branch:profile.branch,head:'a'.repeat(40)},expiresAt:9999999999,...extra};}});return{client,calls};
}
test('client rejects force fields before any transport request',async()=>{
 const{client,calls}=clientFixture();try{
  for(const databaseMode of ['force-test',null,undefined])await assert.rejects(client.promotion({releaseId:'dev1',databaseMode}),/发布请求字段无效/);
  await assert.rejects(client.start({planId:'safe-plan',confirmation:true,databaseRiskAccepted:true,databaseConfirmation:{scopeDigest:digest,ack:true}}),/发布请求字段无效/);
  assert.deepEqual(calls,[]);
 }finally{client.close();}
});
test('client rejects obsolete force server plans instead of starting safely by accident',async()=>{
 for(const extra of [{databaseMode:'force-test'},{databaseMode:undefined},{databasePreview:{}},{databaseForcePlan:{}},{databaseForcePreview:{}}]){
  const{client,calls}=clientFixture(extra);try{await assert.rejects(client.promotion({releaseId:'dev1'}),/未知数据库字段/);assert.ok(!calls.some(c=>c.action==='start'));}finally{client.close();}
 }
});

test('post-DDL image health failure stops candidate writers before restoring database',()=>{
 // Reuse the existing local-only engine fixture, adding health failure after DDL.
 const source=readFileSync(new URL('./temporary-release.test.mjs',import.meta.url),'utf8');
 const fixture=source.split('const fixture = String.raw`')[1].split('`;')[0];
 assert.ok(fixture.includes('class DatabaseTests'));
 const injected=String.raw`
class HealthRecoveryTests(DatabaseTests):
 def test_health_failure_after_successful_ddl_restores_with_stopped_writers(self):
  self.r.matches=lambda job,observed: (_ for _ in ()).throw(RuntimeError('candidate health failed'))
  job,events=self.database_run()
  self.assertEqual(events,['stop','backup','apply','stop','restore'])
  self.assertEqual(job['stage'],'db-restored')
  self.assertEqual(job['status'],'failed')
  self.assertEqual(job['database']['status'],'restored')
unittest.main(argv=['fixture'],verbosity=2,defaultTest='HealthRecoveryTests.test_health_failure_after_successful_ddl_restores_with_stopped_writers')
`;
 const script=fixture.replace("unittest.main(argv=['fixture'],verbosity=2)",injected);
 const result=execFileSync('python3',['-I','-B','-c',script,decodeURIComponent(new URL('./temporary-release.py',import.meta.url).pathname)],{encoding:'utf8',timeout:30000});
 assert.equal(result,'');
});
