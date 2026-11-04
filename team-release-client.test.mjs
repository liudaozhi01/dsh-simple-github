import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemporaryReleaseTransport, createTemporaryReleaseClient } from './temporary-release-client.js';
import { DEFAULT_RELEASE_PROFILE } from './release-profile.js';
const profile = () => { const p = structuredClone(DEFAULT_RELEASE_PROFILE); for (const k of Object.keys(p.baseImages)) p.baseImages[k] = 'example/image@sha256:' + 'a'.repeat(64); return p; };
test('team transport never invokes sudo or sends privileged profile, uses private ordinary-user upload', async () => {
 const p = profile(), calls = [];
 const transport = createTemporaryReleaseTransport({ port: 1, team: true, bridge: async (path, args) => {
  if (path === '/api/dsh-ssh/hosts') return { hosts: [{ ...p.target, user: 'caoyang', auth: 'key', proxyJump: [] }] };
  calls.push([path, args]); return args.file ? { ok: true } : { result: { exitCode: 0, stdout: '{}' } };
 } });
 await transport.request({ profile: p, action: 'start', body: { planId: 'p', confirmation: true, databaseRiskAccepted: true }, bundle: { path: '/tmp/source.gz', sha256: 'b'.repeat(64), size: 12 } });
 assert.equal(calls.length, 4);
 assert.match(calls[2][1].json.command, /os\.fchmod\(fd,0o600\)/);
 assert.match(calls[2][1].json.command, /O_NOFOLLOW/);
 assert.match(calls[0][1].json.command, /os.mkdir\('\/tmp\/dsh-upload-[a-f0-9-]+',0o700\)/);
 const command = calls[3][1].json.command;
 assert.match(command, /^\/usr\/bin\/python3 -I \/usr\/local\/libexec\/xian-oa-team-entry.py '/);
 assert.doesNotMatch(calls.map(c => c[1].json?.command || '').join('\n'), /sudo|chown|docker.sock/);
 const payload = JSON.parse(Buffer.from(command.split("'")[1], 'base64').toString());
 assert.deepEqual(Object.keys(payload).sort(), ['action', 'body']);
 assert.match(payload.body.bundle.path, /^\/tmp\/dsh-upload-[a-f0-9-]+\/source.tar$/);
});
test('team overview traverses the production transport allowlist without upload', async () => {
 const p=profile(),calls=[];const transport=createTemporaryReleaseTransport({port:1,team:true,bridge:async(path,args)=>{
  if(path==='/api/dsh-ssh/hosts')return {hosts:[{...p.target,user:'caoyang',auth:'key',proxyJump:[]}]};
  calls.push(args);return {result:{exitCode:0,stdout:'{"jobs":[],"releaseId":null}'}};
 }});const client=createTemporaryReleaseClient({profile:p,team:true,getUser:async()=>({name:'成员'}),transport});
 assert.deepEqual(await client.overview(),{jobs:[],releaseId:null});assert.equal(calls.length,1);
 const payload=JSON.parse(Buffer.from(calls[0].json.command.split("'")[1],'base64').toString());assert.deepEqual(payload,{action:'overview',body:{}});client.close();
});
test('team SSH account may differ from canonical profile but changing it mid-request is refused', async () => {
 const p=profile(); let reads=0, executions=0;
 const transport=createTemporaryReleaseTransport({port:1,team:true,bridge:async(path,args)=>{
  if(path==='/api/dsh-ssh/hosts') return {hosts:[{...p.target,user:++reads===1?'caoyang':'xufeng',auth:'key',proxyJump:[]}]};
  executions++;return {result:{exitCode:0,stdout:'{}'}};
 }});
 await assert.rejects(transport.request({profile:p,action:'status',body:{}}),/SSH 配置已变化/);
 assert.equal(executions,0);transport.close();
});
test('team client permits another logged-in member; server remains the authorization boundary', async () => {
 const p = profile(), calls = [], head = 'c'.repeat(40);
 const client = createTemporaryReleaseClient({ profile: p, team: true, getUser: async () => ({ name: '另一位成员' }), source: {
  resolve: async input => ({ ...input, head }), prepare: async () => ({ path: '/tmp/source', sha256: 'b'.repeat(64), size: 12, cleanup: async () => {} })
 }, transport: async request => { calls.push(request); return request.action === 'check' ? { planId: 'p', environment: 'dev', remote: { repository: p.repository, branch: p.branch, head }, expiresAt: Date.now()/1000 + 300 } : { jobId: 'j', status: 'pending' }; } });
 await client.check(); await client.start({ planId: 'p', confirmation: true, databaseRiskAccepted: true });
 assert.equal(calls.length, 2);
});

for(const environment of ['dev','test'])test('restore transport '+environment+' never prepares or uploads source',async()=>{
 const p=profile(),requests=[];let prepared=0;const transport=createTemporaryReleaseTransport({port:1,team:true,bridge:async(path,args)=>{
  if(path==='/api/dsh-ssh/hosts')return {hosts:[{...p.target,user:'caoyang',auth:'key',proxyJump:[]}]};
  assert.ok(!args.file);const request=JSON.parse(Buffer.from(args.json.command.split("'")[1],'base64').toString());requests.push(request);
  return {result:{exitCode:0,stdout:JSON.stringify(request.action==='restore'?{planId:'restore-plan',environment,operation:'restore',remote:{repository:p.repository,branch:p.branch,head:'b'.repeat(40)},expiresAt:Date.now()/1000+300}:{jobId:'new-job',status:'pending'})}};
 }});const client=createTemporaryReleaseClient({profile:p,team:true,transport,getUser:async()=>({name:'成员'}),source:{resolve(){throw Error('must not resolve source');},prepare(){prepared++;throw Error('must not build');}}});
 const plan=await client.restore({environment,jobId:'old-job'});await client.start({planId:plan.planId,confirmation:true,databaseRiskAccepted:true});assert.equal(prepared,0);assert.deepEqual(requests.map(x=>x.action),['restore','start']);assert.ok(!requests[1].body.bundle);client.close();
});
