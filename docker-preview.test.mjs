import test from 'node:test';
import assert from 'node:assert/strict';
import { createDockerPreview } from './docker-preview.js';
const source = () => ({directory:'/project',head:'a'.repeat(40),fingerprint:'b'.repeat(64),branch:'dev',repository:'ssal-team/XiAN-OA',changes:[]});
const body = () => ({directory:'/project',head:'a'.repeat(40),fingerprint:'b'.repeat(64),environment:'dev',backendImage:'example/oa-api@sha256:'+'c'.repeat(64),frontendImage:'example/oa-web@sha256:'+'d'.repeat(64),uid:1001,gid:1001});
test('Docker preview validates two source snapshots without declaring release verified', async()=>{
 let calls=0;const preview=createDockerPreview({inspect:async directory=>{calls++;assert.equal(directory,'/project');return source();}});
 const result=await preview(body());assert.equal(calls,2);assert.equal(result.status,'preview-only');assert.equal(result.deployable,false);assert.equal(result.imagesVerified,false);assert.equal(result.sourceVerified,true);assert.equal(result.publicationPolicy,'same-image-owner-only');
});
test('Docker preview rejects invalid directory, missing snapshot and stale source',async()=>{
 const preview=createDockerPreview({inspect:async()=>source()});
 for(const input of [{...body(),directory:'relative'}, {...body(),head:''},{...body(),fingerprint:'c'.repeat(64)}])await assert.rejects(()=>preview(input));
});
test('Docker preview rejects wrong repository, branch, dirty tree and changes during generation',async()=>{
 for(const override of [{repository:'other/oa'},{branch:'main'},{changes:[{status:'M'}]},{changes:null}])await assert.rejects(()=>createDockerPreview({inspect:async()=>({...source(),...override})})(body()));
 let calls=0;await assert.rejects(()=>createDockerPreview({inspect:async()=>({...source(),...(++calls===2?{branch:'other'}:{})})})(body()),/生成期间/);
});
test('request boundary rejects credentials, execution options and malformed objects before inspection',async()=>{
 let calls=0;const preview=createDockerPreview({inspect:async()=>{calls++;return source();}});
 for(const input of [null,[],new Date(),'dev',...['password','env','confirmation','deployable','command','repository'].map(key=>({...body(),[key]:'denied'})),{...body(),[Symbol('credential')]:'denied'},...['\t','\x01','\x7f'].map(control=>({...body(),directory:'/project'+control}))])await assert.rejects(()=>preview(input));
 assert.equal(calls,0);
 const result=await preview(Object.assign(Object.create(null),body()));assert.equal(result.sourceVerified,true);
});
test('test environment preview does not imply promotion approval',async()=>{
 const result=await createDockerPreview({inspect:async()=>source(),getUser:async()=>({name:'刘道志'})})({...body(),environment:'test'});assert.equal(result.environment,'test');assert.equal(result.deployable,false);assert.equal(result.publicationPolicy,'same-image-owner-only');
});
