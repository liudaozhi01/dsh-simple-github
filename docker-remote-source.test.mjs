import test from 'node:test';
import assert from 'node:assert/strict';
import {createService} from './core.js';
test('remote source queries fixed GitHub dev ref without reading a local directory',async()=>{
 const calls=[];const service=createService({ghPath:'mock-gh',command:async(cmd,args)=>{calls.push(args);return {stdout:JSON.stringify({ref:'refs/heads/dev',object:{type:'commit',sha:'a'.repeat(40)}}),stderr:''};}});
 try{const result=await service.route('docker-remote-source');assert.equal(result.head,'a'.repeat(40));assert.equal(result.sourceOrigin,'github-remote-dev');assert.deepEqual(calls,[['api','repos/ssal-team/XiAN-OA/git/ref/heads/dev','--hostname','github.com']]);
 for(const body of [{directory:'/local'},{head:'b'.repeat(40)},null,[]])await assert.rejects(()=>service.route('docker-remote-source',body));assert.equal(calls.length,1);
 }finally{service.close();}
});
test('invalid remote ref and network failure never fall back to local code',async()=>{
 for(const response of [{ref:'refs/heads/main',object:{type:'commit',sha:'a'.repeat(40)}},{ref:'refs/heads/dev',object:{type:'tag',sha:'a'.repeat(40)}},{ref:'refs/heads/dev',object:{type:'commit',sha:'bad'}}]){
 const service=createService({ghPath:'mock-gh',command:async()=>({stdout:JSON.stringify(response),stderr:''})});try{await assert.rejects(()=>service.route('docker-remote-source'));}finally{service.close();}
 }
 const service=createService({ghPath:'mock-gh',command:async()=>{throw new Error('offline');}});try{await assert.rejects(()=>service.route('docker-remote-source'),/offline/);}finally{service.close();}
});
