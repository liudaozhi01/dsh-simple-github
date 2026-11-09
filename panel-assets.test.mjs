import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {apply} from './index.js';
test('every relative panel module dependency is served by the real asset handler',async()=>{
 let handler;const disposers=[];apply({effect:f=>{const d=f();if(typeof d==='function')disposers.push(d);},webServer:{port:51234,register:r=>{handler=r.handler;return ()=>{};}}},{dockerRuntime:null});
 async function get(path){const req=Readable.from([]);Object.assign(req,{method:'GET',url:path,headers:{host:'127.0.0.1:51234',origin:'http://127.0.0.1:51234'},socket:{remoteAddress:'127.0.0.1',localPort:51234}});let status,body;const headers={};await handler(req,{setHeader:(k,v)=>headers[k]=v,writeHead:s=>status=s,end:s=>body=String(s)});assert.equal(status,200,path);assert.match(headers['Content-Type'],/javascript/);return body;}
 try{const seen=new Set(),queue=['/simple-github/panel.js'];while(queue.length){const path=queue.shift();if(seen.has(path))continue;seen.add(path);const body=await get(path);for(const m of body.matchAll(/(?:from\s*|import\s*)['"]([.][/]([^'"]+))['"]/g))queue.push(new URL(m[1],'http://localhost'+path).pathname);}assert.ok(seen.has('/simple-github/schema-review-message.js'));}
 finally{for(const dispose of disposers.reverse())dispose();}
});
