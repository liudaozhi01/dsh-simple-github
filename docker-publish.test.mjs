import test from 'node:test';
import assert from 'node:assert/strict';
import { createDockerPublisher } from './docker-publish.js';
const head='a'.repeat(40), b='sha256:'+'b'.repeat(64), f='sha256:'+'c'.repeat(64), d='sha256:'+'d'.repeat(64);
const remote={repository:'ssal-team/XiAN-OA',branch:'dev',head};
function fixture(overrides={}) {
 const calls=[], tags=new Map();let builds=0;
 const options={backendRepository:'registry.example/oa/backend',frontendRepository:'registry.example/oa/frontend',dockerConfig:'/isolated/docker-config',build:async input=>{builds++;assert.deepEqual(input,{remote});return {head,localImageId:{backend:b,frontend:f},attested:false};},command:async(cmd,args,opts)=>{
  calls.push({cmd,args,opts});let stdout='';
  if(args[0]==='image'&&args[1]==='tag')tags.set(args[3],args[2]);
  if(args[1]==='inspect')stdout=tags.get(args.at(-1))||args.at(-1);
  if(args[0]==='manifest')stdout=JSON.stringify({Descriptor:{digest:d,mediaType:'application/vnd.docker.distribution.manifest.v2+json'},SchemaV2Manifest:{config:{digest:args.at(-1).includes('/backend')?b:f}}});
  return {code:0,stdout};
 },...overrides};
 return {publisher:createDockerPublisher(options),calls,builds:()=>builds,options};
}
test('publishes trusted build IDs and verifies tag plus pinned remote config identity',async()=>{
 const x=fixture(), result=await x.publisher.buildAndPublish({remote});
 assert.deepEqual(result,{head,backendImage:'registry.example/oa/backend@'+d,frontendImage:'registry.example/oa/frontend@'+d,provenanceVerified:true});
 assert.equal(x.builds(),1);assert.equal(x.calls.filter(c=>c.args[1]==='push').length,2);assert.equal(x.calls.filter(c=>c.args[0]==='manifest').length,4);
 for(const c of x.calls){assert.equal(c.cmd,'docker');assert.equal(c.opts.shell,false);assert.equal(c.opts.timeout,600000);assert.equal(c.opts.maxOutput,1048576);assert.deepEqual(Object.keys(c.opts.env).sort(),['DOCKER_CONFIG','HOME','LANG','LC_ALL','PATH']);assert.equal(c.opts.env.DOCKER_CONFIG,'/isolated/docker-config');assert.ok(!c.args.includes('login'));}
});
test('rejects client config, invalid source and mutable repositories before build',async()=>{
 const x=fixture();for(const input of [{remote,directory:'/local'},{remote:{...remote,branch:'test'}},{remote:{...remote,head:head+'\n'}},{remote:{...remote,url:'file:///local'}}])await assert.rejects(()=>x.publisher.buildAndPublish(input));assert.equal(x.builds(),0);
 for(const repo of ['backend','registry.example/oa:latest','registry.example:99999/oa','registry.example/oa\n'])assert.throws(()=>fixture({backendRepository:repo}));
});
test('changed local IDs prevent any registry write',async()=>{
 const x=fixture({command:async()=>({code:0,stdout:f})});await assert.rejects(()=>x.publisher.buildAndPublish({remote}),/identity/);
});
test('mismatched registry config and multi-platform manifests fail closed',async()=>{
 for(const manifest of [{Descriptor:{digest:d,mediaType:'application/vnd.docker.distribution.manifest.v2+json'},SchemaV2Manifest:{config:{digest:f}}},[]]){
  const x=fixture();const cmd=x.options.command;const y=createDockerPublisher({...x.options,command:async(c,a,o)=>a[0]==='manifest'?{code:0,stdout:JSON.stringify(manifest)}:cmd(c,a,o)});
  await assert.rejects(()=>y.buildAndPublish({remote}),/expected single-platform/);assert.equal(x.calls.filter(c=>c.args[1]==='push').length,1);
 }
});
test('errors suppress raw output and do not retry push',async()=>{
 const x=fixture();const cmd=x.options.command;let pushes=0;const y=createDockerPublisher({...x.options,command:async(c,a,o)=>{if(a[1]==='push'){pushes++;throw new Error('password=SENSITIVE');}return cmd(c,a,o);}});
 await assert.rejects(()=>y.buildAndPublish({remote}),e=>!e.message.includes('SENSITIVE')&&/partial/.test(e.message));assert.equal(pushes,1);
});
test('publisher serializes builds and copies remote snapshot before await',async()=>{
 let release;const gate=new Promise(r=>release=r);const x=fixture();const original=x.options.build;const y=createDockerPublisher({...x.options,build:async v=>{await gate;return original(v);}});
 const mutable={...remote};const pending=y.buildAndPublish({remote:mutable});mutable.head='e'.repeat(40);await assert.rejects(()=>y.buildAndPublish({remote}),/already running/);release();assert.equal((await pending).head,head);
});
