import test from 'node:test';
import assert from 'node:assert/strict';
import {createDockerPreview} from './docker-preview.js';
const source={directory:'/project',head:'a'.repeat(40),fingerprint:'b'.repeat(64),branch:'dev',repository:'ssal-team/XiAN-OA',changes:[]};
const body={directory:source.directory,head:source.head,fingerprint:source.fingerprint,environment:'test',backendImage:'example/api@sha256:'+'c'.repeat(64),frontendImage:'example/web@sha256:'+'d'.repeat(64),uid:1001,gid:1001};
test('test preview fails closed for absent, wrong and whitespace display names before source access',async()=>{
 for(const user of [null,{}, {login:'liudaozhi01'},{name:'其他人'},{name:'刘道志 '}]){
  let calls=0;const preview=createDockerPreview({inspect:async()=>{calls++;return source;},getUser:async()=>user});
  await assert.rejects(()=>preview(body),/刘道志/);assert.equal(calls,0);
 }
});
test('identity is refreshed on every request; payload cannot impersonate permitted publisher',async()=>{
 let user={name:'刘道志'};const preview=createDockerPreview({inspect:async()=>source,getUser:async()=>user});
 assert.equal((await preview(body)).deployable,false);
 user={name:'其他人'};await assert.rejects(()=>preview(body),/刘道志/);
 await assert.rejects(()=>preview({...body,name:'刘道志'}),/额外字段/);
});
