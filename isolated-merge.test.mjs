import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService, runCommand, FIXED_REPOSITORY } from './core.js';
const expected = i => ({expectedHead:i.head,expectedFingerprint:i.fingerprint,expectedBranch:i.branch,expectedRepository:i.repository,expectedBaseBranch:i.baseBranch});
async function fixture(t, { conflicting = true, intercept } = {}) {
 const directory=await realpath(await mkdtemp(join(tmpdir(),'isolated-push-test-')));
 const git=args=>runCommand('git',['-C',directory,...args]);
 await git(['init','-b','dev']);await git(['config','core.autocrlf','false']);await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@example.invalid']);
 await writeFile(join(directory,'file.txt'),'base\n');await git(['add','.']);await git(['commit','-m','base']);
 const base=(await git(['rev-parse','HEAD'])).stdout.trim();
 await git(['switch','-c','remote-side']);await writeFile(join(directory,conflicting?'file.txt':'remote.txt'),'remote\n');await git(['add','.']);await git(['commit','-m','remote']);const remote=(await git(['rev-parse','HEAD'])).stdout.trim();await git(['switch','dev']);
 await writeFile(join(directory,'file.txt'),'local\n');await git(['add','.']);await git(['commit','-m','local']);
 const local=(await git(['rev-parse','HEAD'])).stdout.trim();await git(['remote','add','origin',`https://github.com/${FIXED_REPOSITORY}.git`]);await git(['update-ref','refs/remotes/origin/dev',base]);
 const calls=[];
 const service=createService({ghPath:'mock-gh',command:async(cmd,args,opts)=>{
  calls.push({cmd,args});
  if(cmd==='mock-gh')return {stdout:JSON.stringify(args[0]==='api'?{login:'fixture'}:{nameWithOwner:FIXED_REPOSITORY,defaultBranchRef:{name:'main'}})};
  if(args.includes('fetch')){await git(['update-ref','refs/remotes/origin/dev',remote]);return {stdout:''};}
  if(args.includes('push'))throw new Error('must not push');
  await intercept?.({directory,git,args});return runCommand(cmd,args,opts);
 },deploymentFactory:()=>({assertVerified:async()=>{},rebindVerified:async()=>{},close(){}})});
 t.after(async()=>{service.close();await rm(directory,{recursive:true,force:true});});
 return {directory,git,base,remote,local,service,calls,push:async()=>service.route('push',{directory,message:'save',confirmedSelfTest:true,...expected(await service.inspect(directory))})};
}
async function assertCleaned(f) {
 const worktrees=(await f.git(['worktree','list','--porcelain'])).stdout;
 assert.equal(worktrees.split('\n').filter(line=>line.startsWith('worktree ')).length,1);
 for(const {args} of f.calls.filter(c=>c.args.includes('worktree')&&c.args.includes('add'))){const path=args[args.indexOf('--detach')+1];await assert.rejects(access(path));await assert.rejects(access(join(path,'..')));}
}
test('isolated conflicts expose authoritative cloned reports without changing dev files or index',async t=>{
 const f=await fixture(t),before=await f.service.inspect(f.directory),index=(await f.git(['ls-files','--stage'])).stdout;
 const result=await f.push();assert.equal(result.conflict,true);assert.equal(result.localHead,f.local);assert.equal(result.remoteHead,f.remote);
 const report=await f.service.getConflictReport({directory:f.directory,conflictId:result.conflictId});
 assert.equal(report.directory,f.directory);assert.equal(report.localHead,f.local);assert.equal(report.remoteHead,f.remote);assert.equal(report.baseHead,f.base);assert.equal(report.isolated,true);assert.equal(report.truncated,false);assert.match(report.fingerprint,/^[a-f0-9]{64}$/);assert.deepEqual(report.conflicts,[{path:'file.txt',status:'UU'}]);assert.match(report.diff,/<<<<<<< HEAD/);assert.match(report.diff,/>>>>>>>/);
 report.diff='forged';report.conflicts[0].path='forged';assert.notEqual((await f.service.getConflictReport({directory:f.directory,conflictId:result.conflictId})).diff,'forged');
 assert.equal((await f.service.inspect(f.directory)).fingerprint,before.fingerprint);assert.equal((await f.git(['ls-files','--stage'])).stdout,index);assert.equal(await readFile(join(f.directory,'file.txt'),'utf8'),'local\n');await assert.rejects(f.git(['rev-parse','--verify','MERGE_HEAD']));
 await writeFile(join(f.directory,'file.txt'),'user fix\n');assert.equal((await f.service.getConflictReport({directory:f.directory,conflictId:result.conflictId})).localHead,f.local);
 await f.git(['add','.']);await f.git(['commit','-m','user fix']);await assert.rejects(f.service.getConflictReport({directory:f.directory,conflictId:result.conflictId}),/HEAD/);
 await assert.rejects(f.service.getConflictReport({directory:f.directory,conflictId:'forged'}),/Unknown/);await assertCleaned(f);
});
test('clean isolated merge integrates only fast-forward and returns review without pushing',async t=>{
 const f=await fixture(t,{conflicting:false});assert.deepEqual(await f.push(),{ok:true,needsReview:true});
 assert.deepEqual((await f.git(['rev-list','--parents','-n','1','HEAD'])).stdout.trim().split(' ').slice(1),[f.local,f.remote]);assert.equal((await f.service.inspect(f.directory)).isClean,true);
 const integrations=f.calls.filter(c=>c.args.includes('merge')&&c.args[2]===f.directory);assert.equal(integrations.length,1);assert.ok(integrations[0].args.includes('--ff-only'));assert.equal(f.calls.some(c=>c.args.includes('push')),false);await assertCleaned(f);
});
test('edit during isolated merge rejects integration and preserves the edit',async t=>{
 let edited=false;
 const f=await fixture(t,{conflicting:false,intercept:async({directory,args})=>{if(args.includes('merge')&&args[2]!==directory&&!edited){edited=true;await writeFile(join(directory,'file.txt'),'external edit\n');}}});
 await assert.rejects(f.push(),/changed/);assert.equal((await f.git(['rev-parse','HEAD'])).stdout.trim(),f.local);assert.equal(await readFile(join(f.directory,'file.txt'),'utf8'),'external edit\n');assert.equal(f.calls.some(c=>c.args.includes('--ff-only')),false);await assertCleaned(f);
});
test('merge failures and worktree setup failures clean only their temporary directory',async t=>{
 for(const failure of ['merge','add']) {
  const f=await fixture(t,{intercept:async({args})=>{if((failure==='merge'&&args.includes('merge'))||(failure==='add'&&args.includes('worktree')&&args.includes('add')))throw new Error('injected '+failure);}});
  await assert.rejects(f.push(),new RegExp('injected '+failure));assert.equal((await f.git(['rev-parse','HEAD'])).stdout.trim(),f.local);assert.equal((await f.service.inspect(f.directory)).isClean,true);await assertCleaned(f);
 }
});
test('failed worktree removal falls back to exact owned path and matching registration cleanup',async t=>{
 const f=await fixture(t,{intercept:async({args})=>{if(args.includes('worktree')&&args.includes('remove'))throw new Error('injected remove');}});
 assert.equal((await f.push()).conflict,true);await assertCleaned(f);assert.equal((await f.service.inspect(f.directory)).isClean,true);
});
test('legacy unresolved merge blocks push without abort or reset',async t=>{
 const f=await fixture(t);await assert.rejects(f.git(['merge','--no-edit',f.remote]));const contents=await readFile(join(f.directory,'file.txt'),'utf8');
 await assert.rejects(f.push(),/Blocked legacy merge state/);assert.equal(await readFile(join(f.directory,'file.txt'),'utf8'),contents);assert.equal((await f.git(['rev-parse','MERGE_HEAD'])).stdout.trim(),f.remote);assert.equal(f.calls.some(c=>c.args.includes('--abort')||c.args.includes('reset')||c.args.includes('fetch')),false);
});
test('isolated detection suppresses repository hooks and external merge drivers',async t=>{
 const f=await fixture(t),sentinel=join(f.directory,'driver-ran').replace(/\\/g,'/');
 await f.git(['config','merge.hostile.driver',`touch '${sentinel}'`]);await f.git(['config','core.hooksPath',join(f.directory,'.git','hooks')]);
 await writeFile(join(f.directory,'.gitattributes'),'file.txt merge=hostile\n');await f.git(['add','.']);await f.git(['commit','-m','attributes']);
 const {chmod}=await import('node:fs/promises');await writeFile(join(f.directory,'.git/hooks/pre-merge-commit'),`#!/bin/sh\ntouch '${sentinel}'\n`);await chmod(join(f.directory,'.git/hooks/pre-merge-commit'),0o755);
 assert.equal((await f.push()).conflict,true);await assert.rejects(access(sentinel));await assertCleaned(f);
});
