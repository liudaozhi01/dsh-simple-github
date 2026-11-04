import test from 'node:test';
import assert from 'node:assert/strict';
import {createDockerReconciler} from './docker-reconcile.js';
const expected={jobId:'job-1',environment:'dev',head:'a'.repeat(40),backendImage:'registry.example/oa/backend@sha256:'+'b'.repeat(64),frontendImage:'registry.example/oa/frontend@sha256:'+'c'.repeat(64)};
const proof={schema:1,...expected,phase:'applied',backendHealthy:true,frontendHealthy:true,observedAt:100000};
const reconciler=query=>createDockerReconciler({query,now:()=>100000});
test('authoritative exact marker and fresh health can confirm delivery, never acceptance',async()=>{
 let calls=0;const r=reconciler(async input=>{calls++;assert.deepEqual(input,expected);assert.equal(Object.isFrozen(input),true);return proof;});const result=await r.reconcile(expected);assert.equal(result.status,'delivered');assert.equal(result.accepted,false);assert.equal(result.retryAllowed,false);assert.equal(calls,1);
});
test('query failure suppresses details, never retries or calls a write capability',async()=>{
 let calls=0;const r=reconciler(async()=>{calls++;throw Error('password=secret');});const result=await r.reconcile(expected);assert.equal(result.status,'uncertain');assert.equal(result.reason,'QUERY_FAILED');assert.equal(JSON.stringify(result).includes('secret'),false);assert.equal(calls,1);
});
test('all identity components must match, health must be current and true',async()=>{
 for(const change of [{jobId:'other'},{environment:'test'},{head:'d'.repeat(40)},{backendImage:expected.frontendImage},{frontendImage:expected.backendImage},{backendHealthy:false},{frontendHealthy:false},{observedAt:69999},{observedAt:100001},{schema:2},{password:'secret'}]){
 const result=await reconciler(async()=>({...proof,...change})).reconcile(expected);assert.equal(result.status,'uncertain',JSON.stringify(change));assert.equal(result.retryAllowed,false);
 }
});
test('absent, pending and failed markers never authorize apply replay',async()=>{
 for(const phase of ['absent','pending','failed','unknown']){const result=await reconciler(async()=>({...proof,phase})).reconcile(expected);assert.equal(result.status,'uncertain');assert.equal(result.retryAllowed,false);}
});
test('client execution fields, invalid image IDs and getters refused before query',async()=>{
 let calls=0;const r=reconciler(async()=>{calls++;return proof;});for(const input of [{...expected,confirmation:true},{...expected,backendImage:'sha256:'+'b'.repeat(64)},{...expected,head:expected.head+'\n'},Object.defineProperty({...expected},'jobId',{get(){throw Error('getter');}})])await assert.rejects(()=>r.reconcile(input));assert.equal(calls,0);
});
test('query mutation cannot rewrite expected evidence',async()=>{
 const input={...expected};const r=reconciler(async snapshot=>{input.head='e'.repeat(40);return {...proof,head:snapshot.head};});assert.equal((await r.reconcile(input)).head,expected.head);
});
