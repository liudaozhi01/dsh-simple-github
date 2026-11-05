import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService, runCommand } from './core.js';

const repository='example/application', branch='release/team-v2';
const localRef=`refs/heads/${branch}`, trackingRef=`refs/remotes/origin/${branch}`;
const expected=i=>({directory:i.directory,expectedBranch:i.branch,expectedRepository:i.repository,expectedBaseBranch:i.baseBranch,expectedHead:i.head,expectedFingerprint:i.fingerprint});
async function fixture(t) {
  const parent=await mkdtemp(join(tmpdir(),'github-config-core-')),directory=join(parent,'repo');await mkdir(directory);
  const git=async args=>(await runCommand('git',['-C',directory,...args])).stdout.trim();
  await git(['init','-b','main']);await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@example.invalid']);await git(['config','core.autocrlf','false']);
  await writeFile(join(directory,'local.txt'),'base\n');await git(['add','.']);await git(['commit','-m','base']);const base=await git(['rev-parse','HEAD']);
  await git(['remote','add','origin',`https://github.com/${repository}.git`]);await git(['update-ref','refs/remotes/origin/main',base]);await git(['symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/main']);
  await git(['switch','-c','incoming']);await writeFile(join(directory,'remote.txt'),'incoming\n');await git(['add','.']);await git(['commit','-m','incoming']);let remote=await git(['rev-parse','HEAD']);await git(['switch','main']);
  const calls=[];
  const service=createService({repository,branch,ghPath:'mock-gh',command:async(cmd,args,options)=>{
    calls.push({cmd,args});
    if(cmd==='mock-gh')return {stdout:JSON.stringify(args[0]==='api'?{login:'fixture'}:{nameWithOwner:repository,defaultBranchRef:{name:'main'}}),stderr:''};
    if(args.includes('fetch')){await git(['update-ref',trackingRef,remote]);return {stdout:'',stderr:''};}
    if(args.includes('push'))return {stdout:'',stderr:''};
    return runCommand(cmd,args,options);
  }});
  t.after(async()=>{service.close();await rm(parent,{recursive:true,force:true});});
  return {parent,directory,git,service,calls,base,get remote(){return remote;},setRemote:oid=>{remote=oid;}};
}

test('configured clone/status use packaged repository and slash branch; request cannot override',async t=>{
  const parent=await mkdtemp(join(tmpdir(),'github-config-clone-')),calls=[];
  const service=createService({repository,branch,ghPath:'mock-gh',command:async(cmd,args)=>{calls.push(args);return {stdout:JSON.stringify({login:'member'})};}});
  t.after(async()=>{service.close();await rm(parent,{recursive:true,force:true});});
  assert.deepEqual((await service.route('status')).project,{repository,branch});
  await assert.rejects(service.route('clone',{repository:'other/repo',parentDirectory:parent}));
  const result=await service.route('clone',{parentDirectory:parent});await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await service.route('clone-status',{id:result.id})).state,'success');
  const clone=calls.find(args=>args[0]==='repo');assert.equal(clone[2],`https://github.com/${repository}.git`);assert.equal(clone[clone.indexOf('--branch')+1],branch);
});
test('clone modes independently select checkout and remote fetch scope; request cannot override',async t=>{
 for(const cloneMode of ['all','single']){
  const parent=await mkdtemp(join(tmpdir(),'github-clone-mode-')),calls=[];
  const service=createService({repository,branch,cloneMode,cloneBranch:'seed/start',ghPath:'mock-gh',command:async(cmd,args)=>{calls.push(args);return {stdout:JSON.stringify({login:'member'})};}});
  t.after(async()=>{service.close();await rm(parent,{recursive:true,force:true});});
  const result=await service.route('clone',{parentDirectory:parent,cloneMode:cloneMode==='all'?'single':'all',cloneBranch:'attacker'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await service.route('clone-status',{id:result.id})).state,'success');
  const args=calls.find(args=>args[0]==='repo');assert.equal(args[args.indexOf('--branch')+1],cloneMode==='single'?'seed/start':branch);
  assert.equal(args.includes('--single-branch'),cloneMode==='single');assert.equal(args.includes('--no-single-branch'),cloneMode==='all');
 }
 assert.throws(()=>createService({cloneMode:'bad'}));assert.throws(()=>createService({cloneBranch:'a:bad'}));
});
test('configured switch and layered sync preserve main and dirty index/worktree while CAS updates configured ref',async t=>{
  const f=await fixture(t);assert.equal((await f.service.inspect(f.directory)).baseBranch,'main');
  // A previous --single-branch clone only maps dev, even after the new ref is fetched.
  const originalFetch='+refs/heads/dev:refs/remotes/origin/dev';
  await f.git(['config','--replace-all','remote.origin.fetch',originalFetch]);
  await f.service.route('switch-dev',expected(await f.service.inspect(f.directory)));
  assert.deepEqual((await f.git(['config','--get-all','remote.origin.fetch'])).split('\n'),[originalFetch,`+${localRef}:${trackingRef}`]);
  assert.equal(await f.git(['config',`branch.${branch}.remote`]),'origin');
  assert.equal(await f.git(['config',`branch.${branch}.merge`]),`refs/heads/${branch}`);
  assert.equal(await f.git(['symbolic-ref','--short','HEAD']),branch);
  assert.ok(f.calls.some(c=>c.args.includes('switch')&&c.args.includes(trackingRef)));
  await f.git(['reset','--hard',f.base]);
  await writeFile(join(f.directory,'local.txt'),'staged\n');await f.git(['add','local.txt']);await writeFile(join(f.directory,'local.txt'),'unstaged\n');
  assert.deepEqual(await f.service.route('sync-dev',expected(await f.service.inspect(f.directory))),{ok:true,conflict:false});
  assert.equal(await f.git(['rev-parse',localRef]),f.remote);assert.equal(await f.git(['rev-parse','main']),f.base);
  assert.equal(await f.git(['show',':local.txt']),'staged');assert.equal(await readFile(join(f.directory,'local.txt'),'utf8'),'unstaged\n');
  const cas=f.calls.find(c=>c.args.includes('update-ref')&&c.args.includes(localRef));assert.ok(cas);assert.deepEqual(cas.args.slice(-3),[localRef,f.remote,f.base]);
  assert.ok(f.calls.filter(c=>c.args.includes('fetch')).every(c=>c.args.at(-1)===`+${localRef}:${trackingRef}`));
});
test('configured push uses non-force explicit configured refs and rejects wrong branch',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.route('push',{...expected(await f.service.inspect(f.directory)),message:'test',confirmedSelfTest:true}),/release\/team-v2/);
  await f.git(['switch','-c',branch]);f.setRemote(f.base);
  assert.deepEqual(await f.service.route('push',{...expected(await f.service.inspect(f.directory)),message:'test',confirmedSelfTest:true}),{ok:true});
  const push=f.calls.find(c=>c.args.includes('push'));assert.ok(push);assert.deepEqual(push.args.slice(-4),['push','--set-upstream','origin',`${localRef}:${localRef}`]);
  await f.git(['remote','set-url','origin','https://github.com/ssal-team/XiAN-OA.git']);await assert.rejects(f.service.inspect(f.directory),/指定团队项目/);
});
test('foreign project or branch cannot call OA deployment source or local deployment routes',async()=>{
  for(const config of [{repository,branch:'dev'},{repository:'ssal-team/XiAN-OA',branch}]){
    let calls=0;const service=createService({...config,command:async()=>{calls++;throw new Error('must not call');},deploymentFactory:()=>({route(){calls++;},close(){}})});
    try{for(const name of ['docker-remote-source','deploy-status','deploy-start','deploy-stop','deploy-confirm'])await assert.rejects(service.route(name),{status:409});assert.equal(calls,0);}finally{service.close();}
  }
});
test('missing configured remote branch fails without switching or falling back to main/dev',async t=>{
  const f=await fixture(t),before=await f.git(['rev-parse','HEAD']);
  const service=createService({repository,branch,ghPath:'mock-gh',command:async(cmd,args,options)=>{
    if(cmd==='mock-gh')return {stdout:JSON.stringify({login:'fixture',nameWithOwner:repository,defaultBranchRef:{name:'main'}})};
    if(args.includes('fetch'))throw new Error('configured branch not found');
    return runCommand(cmd,args,options);
  }});
  try{
    await assert.rejects(service.route('switch-dev',expected(await service.inspect(f.directory))),/configured branch not found/);
    assert.equal(await f.git(['symbolic-ref','--short','HEAD']),'main');assert.equal(await f.git(['rev-parse','HEAD']),before);
    await assert.rejects(f.git(['rev-parse','--verify',localRef]));
  }finally{service.close();}
});
test('invalid configured branches fail before commands',()=>{
  for(const branch of ['', '-dev', 'refs/heads/main', 'a..b', 'a:b', 'a@{1}', 'a.lock', 'a//b'])assert.throws(()=>createService({repository,branch}),/Invalid configured branch/);
});
