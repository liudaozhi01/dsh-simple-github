import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createService,runCommand} from './core.js';

async function fixture(t, intercept = async()=>{}) {
 const parent=await mkdtemp(join(tmpdir(),'source-restore-test-')),directory=join(parent,'repo');await mkdir(directory);
 const git=async args=>(await runCommand('git',['-C',directory,...args])).stdout;
 await git(['init','-b','dev']);await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@localhost']);await git(['config','core.autocrlf','false']);
 await writeFile(join(directory,'source.txt'),'good\n');await writeFile(join(directory,'deleted.txt'),'restore me\n');await git(['add','.']);await git(['commit','-m','good']);const target=(await git(['rev-parse','HEAD'])).trim();
 await writeFile(join(directory,'source.txt'),'broken shared\n');await git(['rm','deleted.txt']);await writeFile(join(directory,'bad.txt'),'bad\n');await git(['add','.']);await git(['commit','-m','broken']);let remoteHead=(await git(['rev-parse','HEAD'])).trim();
 await git(['remote','add','origin','https://github.com/ssal-team/XiAN-OA.git']);await writeFile(join(directory,'local-only.txt'),'never merge\n');await git(['add','.']);await git(['commit','-m','local problem']);
 const calls=[];
 const service=createService({ghPath:'mock-gh',command:async(cmd,args,options)=>{
  calls.push({cmd,args,options});if(cmd==='mock-gh')return {stdout:JSON.stringify(args[0]==='api'?{login:'fixture'}:{nameWithOwner:'ssal-team/XiAN-OA',defaultBranchRef:{name:'main'}}),stderr:''};
  const action=await intercept({args,options,git,directory,setRemote:sha=>{remoteHead=sha;}});if(action)return action;
  if(args.includes('fetch')){await git(['update-ref','refs/remotes/origin/dev',remoteHead]);return {stdout:'',stderr:''};}
  if(args.includes('push')){const head=args.at(-1).split(':')[0];await git(['merge-base','--is-ancestor',remoteHead,head]);remoteHead=head;return {stdout:'',stderr:''};}
  return runCommand(cmd,args,options);
 }});
 t.after(async()=>{service.close();await rm(parent,{recursive:true,force:true});});
 const preview=async()=>{const info=await service.inspect(directory);return service.route('source-restore-preview',{directory,expectedBranch:info.branch,expectedRepository:info.repository,expectedBaseBranch:info.baseBranch,expectedHead:info.head,expectedFingerprint:info.fingerprint,target,remoteHead});};
 const execute=p=>service.route('source-restore',{directory,previewId:p.previewId,confirmedOverwrite:true});
 return {directory,git,target,calls,service,preview,execute,remote:()=>remoteHead,setRemote:sha=>{remoteHead=sha;}};
}

test('exact target tree and unique remote parent; dirty managed overwrite; untracked and ignored preservation',async t=>{
 const f=await fixture(t),oldRemote=f.remote();await writeFile(join(f.directory,'source.txt'),'staged broken\n');await f.git(['add','source.txt']);await writeFile(join(f.directory,'source.txt'),'dirty broken\n');await writeFile(join(f.directory,'untracked.txt'),'keep\n');await writeFile(join(f.directory,'.git/info/exclude'),'ignored.txt\n');await writeFile(join(f.directory,'ignored.txt'),'keep ignored\n');
 const p=await f.preview();assert.ok(p.localOverwriteChanges.some(x=>x.path==='local-only.txt'&&x.status==='D'));assert.ok(p.localChanges.some(x=>x.path==='source.txt'));assert.ok(p.changes.some(x=>x.path==='deleted.txt'&&x.status==='A'));
 const r=await f.execute(p);assert.equal(r.ok,true);assert.equal(r.localUpdated,true);assert.equal(f.remote(),r.head);assert.equal((await f.git(['rev-parse','HEAD^{tree}'])).trim(),(await f.git(['rev-parse',f.target+'^{tree}'])).trim());assert.equal((await f.git(['rev-list','--parents','-n','1','HEAD'])).trim(),`${r.head} ${oldRemote}`);
 assert.equal(await readFile(join(f.directory,'source.txt'),'utf8'),'good\n');assert.equal(await readFile(join(f.directory,'deleted.txt'),'utf8'),'restore me\n');await assert.rejects(readFile(join(f.directory,'local-only.txt')),{code:'ENOENT'});assert.equal(await readFile(join(f.directory,'untracked.txt'),'utf8'),'keep\n');assert.equal(await readFile(join(f.directory,'ignored.txt'),'utf8'),'keep ignored\n');assert.ok(!f.calls.some(c=>c.args.includes('merge')||c.args.includes('reset')||c.args.includes('--force')||c.args.includes('--force-with-lease')));await assert.rejects(f.execute(p),/expired restore preview/);
});

test('history pagination pins remote head and rejects unreachable target or changed remote',async t=>{
 const f=await fixture(t),first=await f.service.route('source-history',{directory:f.directory,pageSize:1});assert.equal(first.commits.length,1);assert.equal(first.hasMore,true);const second=await f.service.route('source-history',{directory:f.directory,page:2,pageSize:1,remoteHead:first.remoteHead});assert.equal(second.commits[0].sha,f.target);await assert.rejects(f.service.route('source-history',{directory:f.directory,page:2}),/refresh from page one/);
 const i=await f.service.inspect(f.directory);await assert.rejects(f.service.route('source-restore-preview',{directory:f.directory,expectedBranch:i.branch,expectedRepository:i.repository,expectedBaseBranch:i.baseBranch,expectedHead:i.head,expectedFingerprint:i.fingerprint,target:i.head,remoteHead:f.remote()}),/not reachable/);const p=await f.preview();f.setRemote(f.target);await assert.rejects(f.execute(p),/Remote branch changed/);assert.ok(!f.calls.some(c=>c.args.includes('push')));
});

test('explicit overwrite confirmation and local snapshot binding',async t=>{
 const f=await fixture(t),p=await f.preview();await assert.rejects(f.service.route('source-restore',{directory:f.directory,previewId:p.previewId}),/confirmedOverwrite/);await writeFile(join(f.directory,'source.txt'),'racing\n');await assert.rejects(f.execute(p),/changed/);assert.ok(!f.calls.some(c=>c.args.includes('push')));
});

test('untracked and ignored target collisions refuse preview without deletion',async t=>{
 for(const ignored of [false,true]){const f=await fixture(t);if(ignored)await writeFile(join(f.directory,'.git/info/exclude'),'deleted.txt\n');await writeFile(join(f.directory,'deleted.txt'),'keep local\n');await assert.rejects(f.preview(),/collision/);assert.equal(await readFile(join(f.directory,'deleted.txt'),'utf8'),'keep local\n');}
});

test('missing tracked paths restored and staged additions removed',async t=>{
 const f=await fixture(t);await rm(join(f.directory,'source.txt'));await writeFile(join(f.directory,'added.txt'),'staged\n');await f.git(['add','added.txt']);assert.equal((await f.execute(await f.preview())).ok,true);assert.equal(await readFile(join(f.directory,'source.txt'),'utf8'),'good\n');await assert.rejects(readFile(join(f.directory,'added.txt')),{code:'ENOENT'});
});

test('push failure preserves local; uncertain remote read never claims success',async t=>{
 for(const uncertain of [false,true]){let pushed=false;const f=await fixture(t,async({args})=>{if(args.includes('push')){pushed=true;throw new Error('network disconnected');}if(pushed&&uncertain&&args.includes('fetch'))throw new Error('offline');});const before=await f.git(['rev-parse','HEAD']),r=await f.execute(await f.preview());assert.equal(r.ok,false);assert.equal(r.remoteUpdated,uncertain?null:false);assert.equal(r.localUpdated,false);assert.equal(await f.git(['rev-parse','HEAD']),before);assert.equal(await readFile(join(f.directory,'source.txt'),'utf8'),'broken shared\n');}
});

test('push disconnected after acceptance reconciles before local install',async t=>{
 const f=await fixture(t,async({args,setRemote})=>{if(args.includes('push')){setRemote(args.at(-1).split(':')[0]);throw new Error('reply lost');}}),r=await f.execute(await f.preview());assert.equal(r.ok,true);assert.equal(r.head,f.remote());
});

test('remote success and local CAS failure is explicit; rollback and retry',async t=>{
 let fail=true;const f=await fixture(t,async({args})=>{if(fail&&args.includes('update-ref')&&args.includes('refs/heads/dev'))throw new Error('injected local failure');});const before=await f.git(['rev-parse','HEAD']);await writeFile(join(f.directory,'source.txt'),'dirty\n');const r=await f.execute(await f.preview());assert.equal(r.ok,false);assert.equal(r.remoteUpdated,true);assert.equal(r.localUpdated,false);assert.match(r.message,/不是原子事务/);assert.equal(await f.git(['rev-parse','HEAD']),before);assert.equal(await readFile(join(f.directory,'source.txt'),'utf8'),'dirty\n');fail=false;assert.equal((await f.execute(await f.preview())).ok,true);
});

test('hooks filters and signing cannot influence restore',async t=>{
 const f=await fixture(t),marker=join(f.directory,'executed');await f.git(['config','commit.gpgSign','true']);await f.git(['config','gpg.program','/no-signing']);await writeFile(join(f.directory,'.gitattributes'),'*.txt filter=trap\n');for(const type of ['smudge','clean'])await f.git(['config',`filter.trap.${type}`,`touch '${marker}'; cat`]);for(const hook of ['pre-push','post-checkout','post-merge']){const path=join(f.directory,'.git/hooks',hook);await writeFile(path,`#!/bin/sh\ntouch '${marker}'\n`);await chmod(path,0o755);}assert.equal((await f.execute(await f.preview())).ok,true);await assert.rejects(readFile(marker),{code:'ENOENT'});assert.equal(await readFile(join(f.directory,'.gitattributes'),'utf8'),'*.txt filter=trap\n');
});

test('symlink paths fail closed',async t=>{
 if(process.platform==='win32')return;const f=await fixture(t);await symlink('source.txt',join(f.directory,'deleted.txt'));await assert.rejects(f.preview(),/regular files/);assert.ok(!f.calls.some(c=>c.args.includes('push')));
});

test('remote advance at push rejects without merging; edits during accepted push stay local',async t=>{
 for(const point of ['remote','local']){const f=await fixture(t,async({args,setRemote,git,directory})=>{if(args.includes('push')){if(point==='remote'){setRemote((await git(['rev-parse','HEAD'])).trim());throw new Error('non-fast-forward');}await writeFile(join(directory,'source.txt'),'late edit\n');}});const before=await f.git(['rev-parse','HEAD']),r=await f.execute(await f.preview());assert.equal(r.ok,false);assert.equal(r.localUpdated,false);assert.equal(await f.git(['rev-parse','HEAD']),before);if(point==='local'){assert.equal(r.remoteUpdated,true);assert.equal(await readFile(join(f.directory,'source.txt'),'utf8'),'late edit\n');}else assert.equal(r.remoteUpdated,null);}
});

test('restore repairs executable bit and writes raw target bytes with autocrlf',async t=>{
 const f=await fixture(t);await f.git(['config','core.autocrlf','true']);await writeFile(join(f.directory,'source.txt'),'dirty\r\n');await chmod(join(f.directory,'source.txt'),0o755);assert.equal((await f.execute(await f.preview())).ok,true);assert.equal(await readFile(join(f.directory,'source.txt'),'utf8'),'good\n');if(process.platform!=='win32'){const {stat}=await import('node:fs/promises');assert.equal((await stat(join(f.directory,'source.txt'))).mode&0o111,0);}
});

test('replace refs and legacy grafts refuse source history and restore',async t=>{
 for(const kind of ['replace','grafts']){const f=await fixture(t);if(kind==='replace')await f.git(['replace',f.target,f.remote()]);else await writeFile(join(f.directory,'.git/info/grafts'),f.remote()+'\n');await assert.rejects(f.service.route('source-history',{directory:f.directory}),/Replacement objects|grafts/);await assert.rejects(f.preview(),/Replacement objects|grafts/);assert.ok(!f.calls.some(c=>c.args.includes('push')));}
});
