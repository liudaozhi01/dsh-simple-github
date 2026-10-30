import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutoInstaller,installationOutcome} from './auto-install.js';
const ok=value=>({ok:true,value});
function storage(){let value;return {getItem:()=>value,setItem:(_k,v)=>value=v};}
const bundle='@local/dsh-simple-github';
test('official remote installation inspects first, never uninstalls, and reports actual application',async()=>{
 for(const application of ['applied','restart-required']){
  const calls=[];const s=storage();const manager={inspect:async(...args)=>{assert.equal(args.length,2,'remote inspect requires both business argument slots');assert.deepEqual(args[1],{});calls.push(['inspect',...args]);return ok({status:'accepted'});},installBundle:async(p,o)=>{calls.push(['install',p,o]);return ok({bundle,application});}};
  const i=createAutoInstaller(manager,s),result=await i.install({manualInstallPath:'/tmp/package.tgz',version:'0.4.0'});
  assert.equal(result.installed,true);assert.equal(result.restartRequired,application==='restart-required');assert.equal(i.status().state,'done');assert.equal(calls[0][0],'inspect');assert.equal(calls[1][2].enabled,true);assert.equal(calls[1][2].saveExact,true);assert.ok(calls[1][2].requestId);assert.equal(calls[1][2].approvedBuilds,undefined);
 }
});
test('failure, refused, remote loss, overridden never imply success; unknown blocks retries',async()=>{
 for(const application of ['failed','cancelled','overridden'])assert.throws(()=>installationOutcome({bundle,application}));
 assert.throws(()=>installationOutcome({application:'applied'}));
 for(const reply of [{ok:false,error:{message:'lost'}},ok({bundle,application:'failed'})]){
  const i=createAutoInstaller({inspect:async()=>ok({status:'accepted'}),installBundle:async()=>reply},storage());
  await assert.rejects(i.install({manualInstallPath:'/tmp/package.tgz'}));assert.equal(i.status().state,'unknown');await assert.rejects(i.install({manualInstallPath:'/tmp/package.tgz'}),/勿重复/);
 }
 let installs=0;const i=createAutoInstaller({inspect:async()=>ok({status:'refused',reason:'rejected'}),installBundle:async()=>{installs++;}},storage());await assert.rejects(i.install({manualInstallPath:'/tmp/package.tgz'}),/rejected/);assert.equal(installs,0);
});
test('inspection refusal can retry and unavailable storage never submits installation',async()=>{
 let accepted=false,installs=0;
 const manager={inspect:async()=>ok({status:accepted?'accepted':'refused'}),installBundle:async()=>{installs++;return ok({bundle,application:'applied'});}};
 const i=createAutoInstaller(manager,storage());await assert.rejects(i.install({manualInstallPath:'/tmp/package.tgz'}));assert.equal(i.status().state,'rejected');accepted=true;await i.install({manualInstallPath:'/tmp/package.tgz'});assert.equal(installs,1);
 const denied=createAutoInstaller(manager,{getItem:()=>null,setItem:()=>{throw Error('storage blocked');}});await assert.rejects(denied.install({manualInstallPath:'/tmp/package.tgz'}),/storage blocked/);assert.equal(installs,1);
});
test('remount reconciles host request, null is unknown, no blind installation retry',async()=>{
 for(const result of [null,{bundle,application:'restart-required'}]){
  const s=storage();s.setItem('',JSON.stringify({state:'pending',requestId:'id',version:'0.4.0'}));
  const i=createAutoInstaller({waitForInstall:async id=>{assert.equal(id,'id');return ok(result);}},s);
  const record=await i.reconcile();assert.equal(record.state,result?'done':'unknown');
 }
});
