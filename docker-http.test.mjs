import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {apply} from './index.js';
test('trusted startup runtime exposes protected methods, never accepts browser capabilities',async()=>{
 let handler;const disposers=[],calls=[];const runtime=Object.fromEntries(['check','promotion','start','status','accept','reconcile','overview','restore'].map(method=>[method,async body=>{calls.push({method,body});return {status:'mock-only'};}]));
 apply({effect:f=>{const d=f();if(typeof d==='function')disposers.push(d);},webServer:{port:51234,register:r=>{handler=r.handler;return ()=>{};}}},{dockerRuntime:runtime});
 async function request(path,body={},token,method='POST'){const req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{method,url:'/simple-github/api/'+path,headers:{host:'127.0.0.1:51234',origin:'http://127.0.0.1:51234','content-type':'application/json',...(token?{'x-simple-git-token':token}:{})},socket:{remoteAddress:'127.0.0.1',localPort:51234}});let status,value;await handler(req,{setHeader(){},writeHead:s=>status=s,end:s=>value=JSON.parse(s)});return {status,value};}
 try{
  const token=(await request('status',{},undefined,'GET')).value.csrfToken;
  for(const [route,method]of [['docker-overview','overview'],['docker-plan','check'],['docker-promote','promotion'],['docker-restore','restore'],['docker-start','start'],['docker-status','status'],['docker-accept','accept'],['docker-reconcile','reconcile']]){
   assert.equal((await request(route,{},undefined)).status,403);assert.equal((await request(route,{},token)).status,200);assert.equal(calls.at(-1).method,method);
  }
  assert.equal((await request('docker-status',{jobId:'safe-job-1'},token)).status,200);assert.equal(calls.at(-1).body,'safe-job-1');
  assert.equal((await request('docker-overview',{},token,'GET')).status,405);
  assert.equal((await request('docker-overview',{actor:'other'},token)).status,400);
  const count=calls.length;assert.equal((await request('docker-status',{jobId:'../bad',dockerRuntime:{}},token)).status,400);assert.equal(calls.length,count);
  assert.equal((await request('remote-dev-start',{},token)).status,409);
   assert.equal((await request('error-notify',{sessionId:'session1',message:'failure'},token)).status,410);
 }finally{for(const d of disposers.reverse())d();}
});

test('missing trusted project profile disables release and browser cannot supply it',async()=>{
 let handler;const disposers=[];apply({effect:f=>{const d=f();if(typeof d==='function')disposers.push(d);},webServer:{port:51234,register:r=>{handler=r.handler;return ()=>{};}}});
 async function request(name,method,token,body={}){const req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{method,url:'/simple-github/api/'+name,headers:{host:'127.0.0.1:51234',origin:'http://127.0.0.1:51234','content-type':'application/json',...(token?{'x-simple-git-token':token}:{})},socket:{remoteAddress:'127.0.0.1',localPort:51234}});let status,value;await handler(req,{setHeader(){},writeHead:s=>status=s,end:s=>value=JSON.parse(s)});return {status,value};}
 try{const token=(await request('status','GET')).value.csrfToken;for(const route of ['docker-plan','docker-start','docker-promote']){const result=await request(route,'POST',token,{releaseProfile:{target:{host:'attacker.example'}},command:'ignored'});assert.equal(result.status,409);assert.match(result.value.error,/releaseProfile/);}}
 finally{for(const d of disposers.reverse())d();}
});

test('legacy local-upload endpoints reject authenticated requests before any deployment',async()=>{
 let handler;const disposers=[];apply({effect:f=>{const d=f();if(typeof d==='function')disposers.push(d);},webServer:{port:51234,register:r=>{handler=r.handler;return ()=>{};}}},{dockerRuntime:null});
 async function request(path,method='POST',token){const req=Readable.from([Buffer.from('{}')]);Object.assign(req,{method,url:'/simple-github/api/'+path,headers:{host:'127.0.0.1:51234',origin:'http://127.0.0.1:51234','content-type':'application/json',...(token?{'x-simple-git-token':token}:{})},socket:{remoteAddress:'127.0.0.1',localPort:51234}});let status,body;await handler(req,{setHeader(){},writeHead:s=>status=s,end:s=>body=JSON.parse(s)});return {status,body};}
 try{const status=await request('status','GET');assert.equal(status.status,200);for(const route of ['docker-start','docker-status','docker-accept','docker-reconcile','remote-dev-check','remote-dev-start']){const result=await request(route,'POST',status.body.csrfToken);assert.equal(result.status,409);assert.match(result.body.error,route.startsWith('docker-')?/releaseProfile/:/远程 dev/);}}
 finally{for(const d of disposers.reverse())d();}
});
