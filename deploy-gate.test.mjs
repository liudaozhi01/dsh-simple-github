import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,unlink,rm} from 'node:fs/promises';
import {createLocalDeploy} from './local-deploy.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createService,runCommand,FIXED_REPOSITORY} from './core.js';

const expected = info => ({ expectedHead:info.head, expectedFingerprint:info.fingerprint, expectedBranch:info.branch, expectedRepository:info.repository, expectedBaseBranch:info.baseBranch });
async function sourceFixture(t, options = {}) {
 const directory=await mkdtemp(join(tmpdir(),'source-push-'));
 const git=args=>runCommand('git',['-C',directory,...args]);
 await git(['init','-b','dev']);await git(['config','core.autocrlf','false']);await git(['config','user.email','fixture@example.invalid']);await git(['config','user.name','Fixture']);
 // Deliberately unusable build/test scripts: source-only push must never launch them.
 await writeFile(join(directory,'package.json'),JSON.stringify({scripts:{build:'exit 91',test:'exit 92'}}));
 await writeFile(join(directory,'file.txt'),'initial');await git(['add','.']);await git(['commit','-m','initial']);await git(['remote','add','origin','https://github.com/'+FIXED_REPOSITORY+'.git']);
 const initial=(await git(['rev-parse','HEAD'])).stdout.trim();await git(['update-ref','refs/remotes/origin/dev',initial]);
 const calls=[],deploymentCalls=[],launches=[];
 const forbidden=name=>(...args)=>{deploymentCalls.push({name,args});throw new Error('Push must not call deployment.'+name);};
 const service=createService({ghPath:'mock-gh',command:async(cmd,args,opts)=>{
  calls.push({cmd,args});
  if(cmd==='mock-gh')return {stdout:JSON.stringify(args[0]==='api'?{login:'fixture'}:{nameWithOwner:FIXED_REPOSITORY,defaultBranchRef:{name:'main'}})};
  assert.equal(cmd,'git','Only Git and mocked GitHub metadata may run');
  if(args.includes('fetch')){await options.fetch?.({git,directory});return {stdout:''};}
  if(args.includes('push'))return {stdout:''};
  await options.beforeGit?.({args,git,directory});
  const result=await runCommand(cmd,args,opts);
  await options.afterGit?.({args,git,directory});
  return result;
 },deploymentFactory:api=>options.realDeployment?createLocalDeploy(api,{
  spawn(...args){launches.push(args);throw new Error('No build, test, or service may launch during push');},
  discover:forbidden('discover'),health:forbidden('health'),portAvailable:forbidden('portAvailable'),env:{},
 }):new Proxy({close(){}},{get(target,name){return name in target?target[name]:forbidden(name);}})});
 t.after(async()=>{service.close();await rm(directory,{recursive:true,force:true});});
 const push=async(confirmation=true,info)=>service.route('push',{directory,message:'save source',...expected(info||await service.inspect(directory)),confirmedSelfTest:confirmation});
 return {directory,git,initial,calls,deploymentCalls,launches,service,push};
}
const hasCommand=(f,name)=>f.calls.some(call=>call.args.includes(name));
const noNetwork=f=>assert.equal(f.calls.some(call=>call.args.includes('fetch')||call.args.includes('push')),false);
const noDeployment=f=>{assert.deepEqual(f.deploymentCalls,[]);assert.deepEqual(f.launches,[]);};

test('dirty source push commits staged, unstaged, untracked and deleted files without any deployment calls',async t=>{
 const f=await sourceFixture(t);
 await writeFile(join(f.directory,'new.txt'),'staged');await f.git(['add','.']);await writeFile(join(f.directory,'new.txt'),'current');await unlink(join(f.directory,'file.txt'));
 await writeFile(join(f.directory,'untracked.txt'),'new');
 const before=await f.service.inspect(f.directory);assert.equal(before.isClean,false);
 assert.deepEqual(await f.push(),{ok:true});
 const after=await f.service.inspect(f.directory);assert.equal(after.isClean,true);assert.notEqual(after.head,before.head);assert.equal(after.contentFingerprint,before.contentFingerprint);
 assert.equal((await f.git(['show','HEAD:new.txt'])).stdout,'current');assert.equal((await f.git(['show','HEAD:untracked.txt'])).stdout,'new');await assert.rejects(f.git(['show','HEAD:file.txt']));
 assert.equal(f.calls.filter(call=>call.args.includes('push')).length,1);noDeployment(f);
});

test('stopped, unverified local deployment permits clean and dirty source pushes without build/test/health/service launch',async t=>{
 const f=await sourceFixture(t,{realDeployment:true});
 const before=await f.service.route('deploy-status');assert.equal(before.state,'stopped');
 assert.deepEqual(await f.push(),{ok:true});
 await writeFile(join(f.directory,'file.txt'),'source changed after any prior manual testing');
 assert.deepEqual(await f.push(),{ok:true});
 const after=await f.service.route('deploy-status');assert.equal(after.state,'stopped');assert.deepEqual(after.checks,before.checks);
 noDeployment(f);assert.ok(f.calls.every(call=>['git','mock-gh'].includes(call.cmd)));
});

test('manual browser confirmation must be literal true even with no deployment gate',async t=>{
 const f=await sourceFixture(t);await writeFile(join(f.directory,'file.txt'),'manual review');
 const info=await f.service.inspect(f.directory);
 const body={directory:f.directory,message:'save source',...expected(info)};
 await assert.rejects(f.service.route('push',body),/明确确认/);
 for(const value of [null,false,'true',1])await assert.rejects(f.push(value),/明确确认/);
 assert.equal(hasCommand(f,'commit'),false);noNetwork(f);noDeployment(f);
 assert.deepEqual(await f.push(),{ok:true});noDeployment(f);
});

test('commit hook mutations cannot change the previewed staged tree or reach network',async t=>{
 const f=await sourceFixture(t);await writeFile(join(f.directory,'file.txt'),'previewed');
 const hook=join(f.directory,'.git/hooks/pre-commit');await writeFile(hook,'#!/bin/sh\nprintf altered > file.txt\ngit add file.txt\n');await chmod(hook,0o755);
 await assert.rejects(f.push(),/Committed content differs from the previewed source/);
 noNetwork(f);noDeployment(f);
});

test('index flags hiding worktree edits still block source push before commit or network',async t=>{
 for(const flag of ['--assume-unchanged','--skip-worktree']){
  const f=await sourceFixture(t);await f.git(['update-index',flag,'file.txt']);await writeFile(join(f.directory,'file.txt'),'hidden source');
  await assert.rejects(f.push(),/flags prevent safe push/);
  assert.equal(hasCommand(f,'commit'),false);noNetwork(f);noDeployment(f);
 }
});

test('stale preview and concurrent staging changes remain blocked without deployment',async t=>{
 const stale=await sourceFixture(t);const info=await stale.service.inspect(stale.directory);await writeFile(join(stale.directory,'file.txt'),'later edit');
 await assert.rejects(stale.push(true,info),/changed/);assert.equal(hasCommand(stale,'add'),false);noNetwork(stale);noDeployment(stale);
 const staging=await sourceFixture(t,{afterGit:async({args,directory})=>{if(args.includes('add'))await writeFile(join(directory,'file.txt'),'concurrent edit');}});
 await writeFile(join(staging.directory,'file.txt'),'previewed');
 await assert.rejects(staging.push(),/Files changed during staging/);assert.equal(hasCommand(staging,'commit'),false);noNetwork(staging);noDeployment(staging);
});

test('concurrent fetch edits are blocked before integration and push',async t=>{
 const f=await sourceFixture(t,{fetch:({directory})=>writeFile(join(directory,'file.txt'),'concurrent fetch edit')});
 await assert.rejects(f.push(),/changed/);assert.equal(hasCommand(f,'fetch'),true);assert.equal(hasCommand(f,'merge'),false);assert.equal(hasCommand(f,'push'),false);noDeployment(f);
});

test('final expected snapshot catches edits after isolated integration before normal push',async t=>{
 let integrated=false,changed=false;
 const f=await sourceFixture(t,{afterGit:async({args,directory})=>{
  if(args.includes('worktree')&&args.includes('remove'))integrated=true;
  // Mutate after the post-merge inspection/noOperation, leaving only the final
  // expectedState snapshot to catch the change before the normal push.
  if(integrated&&!changed&&args.includes('ls-files')&&args.includes('--unmerged')){changed=true;await writeFile(join(directory,'file.txt'),'late concurrent edit');}
 }});
 await assert.rejects(f.push(),/changed/);assert.equal(changed,true);assert.equal(hasCommand(f,'push'),false);noDeployment(f);
});

test('remote integration requires manual review then permits a fresh confirmed source push without deployment',async t=>{
 let remote;
 const f=await sourceFixture(t,{fetch:({git})=>git(['update-ref','refs/remotes/origin/dev',remote])});
 await f.git(['switch','-c','remote-side']);await writeFile(join(f.directory,'remote.txt'),'remote');await f.git(['add','.']);await f.git(['commit','-m','remote']);remote=(await f.git(['rev-parse','HEAD'])).stdout.trim();await f.git(['switch','dev']);
 await writeFile(join(f.directory,'file.txt'),'local source');
 assert.deepEqual(await f.push(),{ok:true,needsReview:true});assert.equal(hasCommand(f,'push'),false);noDeployment(f);
 f.calls.length=0;assert.deepEqual(await f.push(),{ok:true});assert.equal(hasCommand(f,'commit'),false);assert.equal(hasCommand(f,'push'),true);noDeployment(f);
});

test('isolated conflict preserves committed source and leaves dev free of merge state',async t=>{
 let remote;
 const f=await sourceFixture(t,{fetch:({git})=>git(['update-ref','refs/remotes/origin/dev',remote])});
 await f.git(['switch','-c','remote-side']);await writeFile(join(f.directory,'file.txt'),'remote');await f.git(['add','.']);await f.git(['commit','-m','remote']);remote=(await f.git(['rev-parse','HEAD'])).stdout.trim();await f.git(['switch','dev']);
 await writeFile(join(f.directory,'file.txt'),'local source');
 const result=await f.push();assert.equal(result.conflict,true);assert.ok(result.conflictId);
 const current=await f.service.inspect(f.directory);assert.equal(current.isClean,true);assert.equal(current.head,result.localHead);
 await assert.rejects(f.git(['rev-parse','--verify','MERGE_HEAD']));assert.equal(hasCommand(f,'push'),false);noDeployment(f);
});
