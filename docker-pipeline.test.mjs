import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createDockerPipeline } from './docker-pipeline.js';
const head='a'.repeat(40), ids={backend:'sha256:'+'b'.repeat(64),frontend:'sha256:'+'c'.repeat(64)}, digest='sha256:'+'d'.repeat(64);
function fixture({delivery,failManifest=false,journal}={}) {
 let name='刘道志',builds=0,pushes=0,fetches=0;const deliveries=[],tags=new Map();
 const pipeline=createDockerPipeline({journal,resolveDev:async()=>{fetches++;return {repository:'ssal-team/XiAN-OA',branch:'dev',head};},getUser:async()=>({name}),backendRepository:'registry.example/oa/backend',frontendRepository:'registry.example/oa/frontend',dockerConfig:'/isolated/config',
 build:async({remote})=>{builds++;assert.equal(remote.head,head);return {head,localImageId:ids,attested:false};},
 command:async(_cmd,args)=>{let stdout='';if(args[1]==='tag')tags.set(args[3],args[2]);if(args[1]==='inspect')stdout=tags.get(args.at(-1))||args.at(-1);if(args[1]==='push')pushes++;if(args[0]==='manifest')stdout=JSON.stringify({Descriptor:{digest,mediaType:'application/vnd.docker.distribution.manifest.v2+json'},SchemaV2Manifest:{config:{digest:failManifest?'sha256:'+'e'.repeat(64):args.at(-1).includes('/backend')?ids.backend:ids.frontend}}});return {stdout};},
 deliver:async input=>{deliveries.push(input);assert.equal(input.artifact.provenanceVerified,true);assert.equal(input.artifact.head,head);return delivery?delivery(input):{...input.artifact,delivered:true,healthy:true};}});
 return {pipeline,deliveries,stats:()=>({builds,pushes,fetches}),user:n=>name=n};
}
async function settled(pipeline,id){for(let n=0;n<30;n++){const s=pipeline.status(id);if(!['pending','running'].includes(s.status))return s;await setImmediate();}throw Error('mock job did not settle');}
test('accepted journal restore permits same-image test without rebuilding; persistence failure blocks promotion',async()=>{
 const records=[];const journal={list:()=>records.map(r=>({...r})),append:async r=>records.push({...r})};
 const first=fixture({journal}),dev=await runDev(first);await first.pipeline.accept({jobId:dev.jobId,confirmation:true});assert.equal(records.length,1);
 const second=fixture({journal});const plan=await second.pipeline.promotion({releaseId:dev.jobId});const job=await second.pipeline.start({planId:plan.planId,confirmation:true,databaseRiskAccepted:true});assert.equal((await settled(second.pipeline,job.jobId)).status,'delivered');assert.deepEqual(second.stats(),{builds:0,pushes:0,fetches:0});
 const broken=fixture({journal:{list:()=>[],append:async()=>{throw Error('uncertain disk');}}});const d=await runDev(broken);await assert.rejects(()=>broken.pipeline.accept({jobId:d.jobId,confirmation:true}),/不确定/);await assert.rejects(()=>broken.pipeline.promotion({releaseId:d.jobId}));
});
async function runDev(x){const plan=await x.pipeline.check({});const job=await x.pipeline.start({planId:plan.planId,confirmation:true,databaseRiskAccepted:true});return settled(x.pipeline,job.jobId);}
test('remote dev build -> verified registry pair -> dev acceptance -> same-image test without rebuild',async()=>{
 const x=fixture();const dev=await runDev(x);assert.equal(dev.status,'delivered');
 await assert.rejects(()=>x.pipeline.promotion({releaseId:dev.jobId}),/未找到/);
 await x.pipeline.accept({jobId:dev.jobId,confirmation:true});
 const promotion=await x.pipeline.promotion({releaseId:dev.jobId});
 assert.equal(promotion.backendImage,dev.backendImage);const job=await x.pipeline.start({planId:promotion.planId,confirmation:true,databaseRiskAccepted:true});const result=await settled(x.pipeline,job.jobId);
 assert.equal(result.status,'delivered');assert.deepEqual(x.stats(),{builds:1,pushes:2,fetches:1});assert.equal(x.deliveries.length,2);assert.strictEqual(x.deliveries[0].artifact,x.deliveries[1].artifact);assert.equal(x.deliveries[1].environment,'test');
});
test('registry mismatch prevents delivery and acceptance',async()=>{
 const x=fixture({failManifest:true}),dev=await runDev(x);assert.equal(dev.status,'failed');assert.equal(x.deliveries.length,0);await assert.rejects(()=>x.pipeline.accept({jobId:dev.jobId,confirmation:true}));
});
test('preflight is never treated as actual delivery or promotion evidence',async()=>{
 const x=fixture({delivery:()=>({status:'preflight-only',delivered:false,deployable:false})}),dev=await runDev(x);assert.equal(dev.status,'uncertain');await assert.rejects(()=>x.pipeline.accept({jobId:dev.jobId,confirmation:true}));await assert.rejects(()=>x.pipeline.promotion({releaseId:dev.jobId}));
});
test('name authorization remains enforced by composition before test execution',async()=>{
 const x=fixture(),dev=await runDev(x);await x.pipeline.accept({jobId:dev.jobId,confirmation:true});const plan=await x.pipeline.promotion({releaseId:dev.jobId});x.user('liudaozhi01');await assert.rejects(()=>x.pipeline.start({planId:plan.planId,confirmation:true,databaseRiskAccepted:true}),/刘道志/);assert.equal(x.deliveries.length,1);
});
