import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Readable} from 'node:stream';

test('deployment administration is removed while OA releases and GitHub administration remain',async()=>{
 const root=await mkdtemp(join(tmpdir(),'deployment-removal-http-')),pkg=join(root,'package'),bin=join(root,'bin');
 const source=fileURLToPath(new URL('.',import.meta.url)),manifest=JSON.parse(await readFile(new URL('./package.json',import.meta.url),'utf8'));
 const oldPath=process.env.PATH,disposers=[],calls=[];let handler;const port=51236;
 const runtime=Object.fromEntries(['check','promotion','start','status','accept','reconcile','overview','restore'].map(method=>[method,async body=>{calls.push({method,body});return {ok:true,method};}]));
 async function request(name,{method='POST',token,body={}}={}){
  const req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{method,url:'/simple-github/api/'+name,headers:{host:'127.0.0.1:'+port,origin:'http://127.0.0.1:'+port,'content-type':'application/json',...(token?{'x-simple-git-token':token}:{})},socket:{remoteAddress:'127.0.0.1',localPort:port}});
  let status,value;await handler(req,{setHeader(){},writeHead:s=>status=s,end:data=>value=JSON.parse(data)});return {status,value};
 }
 try{
  await mkdir(pkg);await mkdir(bin);for(const file of new Set(['package.json',...manifest.files]))await copyFile(join(source,file),join(pkg,file));
  assert.ok(manifest.files.every(name=>!name.startsWith('deployment-')));
  await writeFile(join(pkg,'github-project.json'),JSON.stringify({repository:'ssal-team/XiAN-OA',branch:'dev',updateRepository:'example/plugin'}));
  // A stale installed configuration must neither be read nor enable generic deployment.
  await writeFile(join(pkg,'deployment-project.json'),'INVALID RETIRED CONFIG');
  const fake=join(root,'fake-gh.mjs');await writeFile(fake,"process.stdout.write(JSON.stringify({login:'liudaozhi01',name:'刘道志'}));");
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";await writeFile(join(bin,'gh'),'#!/bin/sh\nexec '+quote(process.execPath)+' '+quote(fake)+' "$@"\n');await chmod(join(bin,'gh'),0o755);process.env.PATH=bin+':'+oldPath;
  const {apply}=await import(pathToFileURL(join(pkg,'index.js')).href);
  const start=()=>apply({effect(fn){const dispose=fn();if(typeof dispose==='function')disposers.push(dispose);},webServer:{port,register(route){handler=route.handler;return ()=>{};}}},{dockerRuntime:runtime});
  start();let status=await request('status',{method:'GET'}),token=status.value.csrfToken;assert.equal(status.value.oaDeploymentAvailable,true);assert.equal(status.value.githubAdministrator,true);assert.equal(status.value.deployment,undefined);
  for(const name of ['deployment-config-read','deployment-config-save','deployment-hosts','deployment-init-notify'])for(const method of ['GET','POST'])assert.equal((await request(name,{method,token})).status,404,name);
  assert.equal((await request('github-config-read',{token})).status,200);
  for(const [name,method,body] of [['docker-plan','check',{}],['docker-promote','promotion',{}],['docker-restore','restore',{}],['docker-start','start',{}],['docker-overview','overview',{}],['docker-status','status',{jobId:'safe-job'}],['docker-accept','accept',{}],['docker-reconcile','reconcile',{}]]){
   assert.equal((await request(name,{token,body})).status,200,name);assert.equal(calls.at(-1).method,method);
  }
  assert.equal((await request('docker-start')).status,403);
  disposers.splice(0).forEach(dispose=>dispose());await writeFile(join(pkg,'github-project.json'),JSON.stringify({repository:'example/foreign',branch:'main',updateRepository:'example/plugin'}));start();status=await request('status',{method:'GET'});token=status.value.csrfToken;assert.equal(status.value.oaDeploymentAvailable,false);
  const before=calls.length;for(const name of ['docker-plan','docker-promote','docker-restore','docker-start','docker-overview','docker-status','docker-accept','docker-reconcile'])assert.equal((await request(name,{token})).status,409,name);assert.equal(calls.length,before);
 }finally{
  if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
  for(const dispose of disposers.reverse())dispose();
  assert.equal(root.startsWith(join(tmpdir(),'deployment-removal-http-')),true);await rm(root,{recursive:true,force:true});
 }
});
