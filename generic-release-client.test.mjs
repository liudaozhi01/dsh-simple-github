import test from 'node:test';
import assert from 'node:assert/strict';
import {createTemporaryReleaseTransport,createTemporaryReleaseClient} from './temporary-release-client.js';
import {DEFAULT_RELEASE_PROFILE} from './release-profile.js';
function profile(){const p=structuredClone(DEFAULT_RELEASE_PROFILE);for(const k of Object.keys(p.baseImages))p.baseImages[k]='example/image@sha256:'+'a'.repeat(64);return p;}
function identity(p){return {deploymentProjectId:'example',deploymentProtocolVersion:1,deploymentRepository:p.repository,deploymentBranch:p.branch};}
for(const invalid of ['../example','Example','a;id','',null])test('reject invalid generic project '+invalid,()=>assert.throws(()=>createTemporaryReleaseTransport({port:1,team:true,projectId:invalid})));
test('generic transport pins controlled entry and verifies identity before any source upload',async()=>{
 const p=profile(),calls=[];let wrong=true;
 const transport=createTemporaryReleaseTransport({port:1,team:true,projectId:'example',bridge:async(path,args)=>{
  if(path==='/api/dsh-ssh/hosts')return {hosts:[{...p.target,user:'member',auth:'key',proxyJump:[]}]};
  calls.push({path,args});return {result:{exitCode:0,stdout:JSON.stringify({...identity(p),deploymentProjectId:wrong?'other':'example'})}};
 }});
 await assert.rejects(transport.request({profile:p,action:'start',body:{},bundle:{path:'/tmp/never-upload',size:1,sha256:'a'.repeat(64)}}),/身份或协议不匹配/);
 assert.equal(calls.length,1);assert.match(calls[0].args.json.command,/^\/usr\/bin\/python3 -I \/usr\/local\/libexec\/dsh-release-example\/entry.py '/);
 wrong=false;calls.length=0;await transport.request({profile:p,action:'overview',body:{}});assert.equal(calls.length,2);
 for(const c of calls){const payload=JSON.parse(Buffer.from(c.args.json.command.split("'")[1],'base64'));assert.deepEqual(payload,{action:'overview',body:{}});}
 transport.close();
});
test('generic client validates returned root-config project protocol repo branch',async()=>{
 const p=profile();let response={...identity(p),jobs:[]};const client=createTemporaryReleaseClient({team:true,projectId:'example',profile:p,getUser:async()=>({name:'member'}),transport:async()=>response});
 assert.deepEqual((await client.overview()).jobs,[]);
 for(const patch of [{deploymentProjectId:'other'},{deploymentProtocolVersion:2},{deploymentRepository:'other/repo'},{deploymentBranch:'other'}]){response={...identity(p),...patch};await assert.rejects(client.overview(),/身份不匹配/);}
 client.close();
});
