import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {apply} from './index.js';
test('source restore routes are registered POST-only behind CSRF without touching repositories',async()=>{
 let handler;const disposers=[];const port=51235;
 apply({effect(fn){const close=fn();if(typeof close==='function')disposers.push(close);},webServer:{port,register(value){handler=value.handler;return ()=>{};}}},{dockerRuntime:null});
 async function request(name,method){let status,data;const req=Readable.from([Buffer.from('{}')]);Object.assign(req,{method,url:'/simple-github/api/'+name,headers:{host:'127.0.0.1:'+port,origin:'http://127.0.0.1:'+port,'content-type':'application/json'},socket:{remoteAddress:'127.0.0.1',localPort:port}});await handler(req,{setHeader(){},writeHead(value){status=value;},end(value){data=JSON.parse(value);}});return {status,data};}
 try{for(const name of ['source-history','source-restore-preview','source-restore']){assert.equal((await request(name,'GET')).status,405);const denied=await request(name,'POST');assert.equal(denied.status,403);assert.match(denied.data.error,/CSRF/);}}finally{for(const close of disposers.reverse())close();}
});
