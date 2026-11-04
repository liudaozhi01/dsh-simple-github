import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerReleaseClient } from './server-release-client.js';
function fixture(name = '刘道志') {
  const calls = [];
  const client = createServerReleaseClient({getUser: async () => ({name}), exec: async request => {
    calls.push(request);
    return {exitCode:0,stdout:JSON.stringify({status:'pending',jobId:'job-1'})};
  }});
  return {client,calls};
}
test('fixed SSH entry transports only structured operations without local source or session',async()=>{
  const {client,calls}=fixture();
  await client.check({}); await client.start({planId:'plan-1',confirmation:true,databaseRiskAccepted:true});
  await client.status(); await client.status('job-1'); await client.accept({jobId:'job-1',confirmation:true});
  await client.promotion({releaseId:'release-1'}); await client.reconcile({jobId:'job-1'});
  const messages=calls.map(c=>{
    assert.equal(c.alias,'xian-oa-test');assert.equal(c.timeoutMs,180000);
    assert.match(c.command,/^sudo -n \/usr\/bin\/python3 -I \/usr\/local\/libexec\/xian-oa-release\.py '[A-Za-z0-9+/]+=*'$/);
    return JSON.parse(Buffer.from(c.command.split("'")[1],'base64').toString());
  });
  assert.deepEqual(messages.map(m=>m.action),['check','start','status','status','accept','promote','reconcile']);
  assert.deepEqual(messages[0].body,{});assert.deepEqual(messages[2].body,{});
});
test('rejects arbitrary command, path, identity and missing confirmations before SSH',async()=>{
 const {client,calls}=fixture();
 for(const input of [{directory:'/tmp/x'},{command:'rm -rf /'},{name:'刘道志'},null,[],{environment:'test'}]) await assert.rejects(async()=>client.check(input));
 await assert.rejects(async()=>client.start({planId:'x',confirmation:true}));
 await assert.rejects(async()=>client.status('job\n'));
 await assert.rejects(async()=>client.promotion({releaseId:'x',name:'刘道志'}));
 assert.equal(calls.length,0);
});
test('name gate covers all starts and acceptance; status remains read only',async()=>{
 const {client,calls}=fixture('other');
 await assert.rejects(client.start({planId:'x',confirmation:true,databaseRiskAccepted:true}),{status:403});
 await assert.rejects(client.promotion({releaseId:'x'}),{status:403});
 await assert.rejects(client.accept({jobId:'x',confirmation:true}),{status:403});
 await client.status();assert.equal(calls.length,1);
});
test('response loss is not retried; closed client rejects',async()=>{
 let n=0;
 const client=createServerReleaseClient({getUser:async()=>({name:'刘道志'}),exec:async()=>{n++;throw Error('secret stderr');}});
 await assert.rejects(client.check(),e=>e.status===503&&!e.message.includes('secret'));assert.equal(n,1);
 client.close();await assert.rejects(client.status(),{status:503});assert.equal(n,1);
});
