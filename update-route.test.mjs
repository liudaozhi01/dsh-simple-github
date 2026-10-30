import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { apply } from './index.js';

test('update routes retain loopback, origin, method and CSRF guards', async () => {
  let handler; const disposers=[];
  const ctx={effect:f=>{const d=f();if(typeof d==='function')disposers.push(d);},webServer:{port:51234,register:route=>{handler=route.handler;return ()=>{};}}};
  apply(ctx);
  async function request(path, {method='POST',headers={},address='127.0.0.1'}={}) {
    const req=Readable.from([Buffer.from('{}')]);Object.assign(req,{method,url:'/simple-github/api/'+path,headers:{host:'127.0.0.1:51234',origin:'http://127.0.0.1:51234','content-type':'application/json',...headers},socket:{remoteAddress:address,localPort:51234}});
    let status,body;await handler(req,{setHeader(){},writeHead:s=>status=s,end:s=>body=JSON.parse(s)});return {status,body};
  }
  try {
    for(const path of ['update-check','update-install']) {
      assert.equal((await request(path)).status,403);
      assert.equal((await request(path,{method:'GET'})).status,405);
      assert.equal((await request(path,{headers:{origin:'https://evil.example'}})).status,403);
      assert.equal((await request(path,{address:'192.168.1.2'})).status,403);
      assert.equal((await request(path,{headers:{'x-simple-git-token':'forged'}})).status,403);
    }
  } finally {for(const dispose of disposers.reverse())dispose();}
});
