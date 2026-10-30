import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, stat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createService, runCommand } from './core.js';

async function fixture(t, remoteFiles = { 'remote.txt':'remote\n' }, intercept = async () => {}) {
  const parent = await mkdtemp(join(tmpdir(), 'isolated-pull-test-')), directory = join(parent, 'repo');
  await mkdir(directory);
  const git = async args => (await runCommand('git', ['-C',directory,...args])).stdout;
  await git(['init','-b','main']); await git(['config','core.autocrlf','false']); await git(['config','user.name','Fixture']); await git(['config','user.email','fixture@localhost']);
  await writeFile(join(directory,'hello.txt'),'base\n'); await writeFile(join(directory,'other.txt'),'other\n');
  await writeFile(join(directory,'layers.txt'),'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n');
  await git(['add','.']); await git(['commit','-m','base']);
  await git(['remote','add','origin','https://github.com/ssal-team/XiAN-OA.git']);
  await git(['switch','-c','remote-dev']);
  for (const [path, content] of Object.entries(remoteFiles)) await writeFile(join(directory,path),content);
  await git(['add','.']); await git(['commit','-m','remote']); const remoteHead=(await git(['rev-parse','HEAD'])).trim();
  await git(['switch','-c','dev','main']);
  const calls=[];
  const service=createService({ghPath:'mock-gh',command:async(cmd,args,options)=>{
    calls.push({cmd,args,options});
    if(cmd==='mock-gh') return {stdout:JSON.stringify(args[0]==='api'?{login:'fixture'}:{nameWithOwner:'ssal-team/XiAN-OA',defaultBranchRef:{name:'main'}}),stderr:''};
    await intercept({args,options,directory,git});
    if(args.includes('fetch')) { await git(['update-ref','refs/remotes/origin/dev',remoteHead]); return {stdout:'',stderr:''}; }
    return runCommand(cmd,args,options);
  }});
  t.after(async()=>{service.close(); await rm(parent,{recursive:true,force:true});});
  const invoke=async()=>{const i=await service.inspect(directory);return service.route('sync-dev',{directory,expectedBranch:i.branch,expectedRepository:i.repository,expectedBaseBranch:i.baseBranch,expectedHead:i.head,expectedFingerprint:i.fingerprint});};
  const state=async()=>({head:await git(['rev-parse','HEAD']),index:await readFile(join(directory,'.git/index')),status:await git(['status','--porcelain=v1','-z']),hello:await readFile(join(directory,'hello.txt'),'utf8')});
  return {directory,git,remoteHead,service,calls,invoke,state};
}

test('CRLF builtin conversion preserves dirty staged/unstaged raw bytes and converts incoming files',async t=>{
 const f=await fixture(t,{'remote.txt':'remote\n','other.txt':'REMOTE\n'});
 await f.git(['config','core.autocrlf','true']);
 for(const p of ['hello.txt','other.txt','layers.txt'])await writeFile(join(f.directory,p),(await readFile(join(f.directory,p),'utf8')).replace(/\r?\n/g,'\r\n'));
 await f.git(['add','--renormalize','.']);
 await writeFile(join(f.directory,'hello.txt'),'staged\r\n');await f.git(['add','hello.txt']);await writeFile(join(f.directory,'hello.txt'),'unstaged\r\n');
 const status=await f.git(['status','--porcelain=v1','-z']);
 assert.deepEqual(await f.invoke(),{ok:true,conflict:false});
 assert.equal(await f.git(['status','--porcelain=v1','-z']),status);
 assert.equal(await f.git(['show',':hello.txt']),'staged\n');assert.equal(await readFile(join(f.directory,'hello.txt'),'utf8'),'unstaged\r\n');
 assert.equal(await readFile(join(f.directory,'remote.txt'),'utf8'),'remote\r\n');assert.equal(await readFile(join(f.directory,'other.txt'),'utf8'),'REMOTE\r\n');
});
test('mixed local line endings and nonreversible conversion fail closed without changing raw bytes',async t=>{
 for(const kind of ['mixed','ident','encoding']){
  const f=await fixture(t);await f.git(['config','core.autocrlf','true']);
  if(kind!=='mixed')await writeFile(join(f.directory,'.gitattributes'),`*.txt ${kind==='ident'?'ident':'working-tree-encoding=UTF-16'}\n`);
  await writeFile(join(f.directory,'hello.txt'),'one\r\ntwo\n');const before=await f.state();
  await assert.rejects(f.invoke(),/round-trip|ident|encoding/);assert.deepEqual(await f.state(),before);assert.ok(!f.calls.some(c=>c.args.includes('fetch')));
 }
});
test('dirty same-line pull conflict preserves real HEAD, index bytes, staged/unstaged and untracked files',async t=>{
  const f=await fixture(t,{'hello.txt':'remote\n'});
  await writeFile(join(f.directory,'hello.txt'),'staged\n'); await f.git(['add','hello.txt']);
  await writeFile(join(f.directory,'hello.txt'),'local worktree\n'); await writeFile(join(f.directory,'new.txt'),'untracked\n');
  const before=await f.state(), result=await f.invoke();
  assert.equal(result.conflict,true); assert.deepEqual(result.files,['hello.txt']); assert.deepEqual(await f.state(),before);
  assert.equal(await readFile(join(f.directory,'new.txt'),'utf8'),'untracked\n');
  const report=await f.service.getConflictReport({directory:f.directory,conflictId:result.conflictId});
  assert.equal(report.localHead,before.head.trim()); assert.notEqual(report.snapshotHead,report.localHead); assert.match(report.diff,/staged/); assert.equal(report.remoteHead,f.remoteHead); assert.equal(result.remoteHead,f.remoteHead); assert.equal(report.layer,'staged'); assert.notEqual(report.syntheticIncomingHead,f.remoteHead); assert.equal(report.baseHead,(await f.git(['merge-base',before.head.trim(),f.remoteHead])).trim());
  assert.equal((await f.git(['ls-files','--unmerged'])).trim(),''); await assert.rejects(f.git(['rev-parse','--verify','MERGE_HEAD']));
  assert.equal((await f.git(['worktree','list','--porcelain'])).split('worktree ').length,2);
});

test('disjoint remote update preserves partially staged edits and untracked data without committing snapshot',async t=>{
  const f=await fixture(t);
  await writeFile(join(f.directory,'hello.txt'),'staged\n'); await f.git(['add','hello.txt']); await writeFile(join(f.directory,'hello.txt'),'unstaged\n');
  await writeFile(join(f.directory,'new.txt'),'new\n'); const status=await f.git(['status','--porcelain=v1','-z']);
  assert.deepEqual(await f.invoke(),{ok:true,conflict:false}); assert.equal((await f.git(['rev-parse','HEAD'])).trim(),f.remoteHead);
  assert.equal(await f.git(['status','--porcelain=v1','-z']),status); assert.equal(await f.git(['show',':hello.txt']),'staged\n');
  assert.equal(await readFile(join(f.directory,'hello.txt'),'utf8'),'unstaged\n'); assert.equal(await readFile(join(f.directory,'new.txt'),'utf8'),'new\n');
  assert.equal(await readFile(join(f.directory,'remote.txt'),'utf8'),'remote\n');
  assert.ok(f.calls.some(c=>c.args.includes('read-tree')&&c.options.env.GIT_INDEX_FILE));
  assert.ok(!f.calls.some(c=>c.args.includes('reset')||c.args.includes('clean')||c.args.includes('stash')));
});

test('staged conflict is detected even when worktree restores the base',async t=>{
  const f=await fixture(t,{'hello.txt':'remote\n'});
  // A staged edit restored in the worktree is absent from the snapshot, but its
  // original index semantics still prohibit integrating this remote path.
  await writeFile(join(f.directory,'hello.txt'),'staged\n'); await f.git(['add','hello.txt']); await writeFile(join(f.directory,'hello.txt'),'base\n');
  const before=await f.state(), result=await f.invoke(); assert.equal(result.conflict,true); assert.deepEqual(result.files,['hello.txt']); assert.deepEqual(await f.state(),before);
});

test('snapshot and isolated merge failures clean only their owned temporary data',async t=>{
  for(const failure of ['write-tree','add-worktree','merge']) {
    const f=await fixture(t,undefined,async({args})=>{if(args.includes(failure) || failure==='add-worktree' && args.includes('worktree') && args.includes('add')) throw new Error('injected '+failure);});
    await writeFile(join(f.directory,'hello.txt'),'local\n'); const before=await f.state();
    await assert.rejects(f.invoke(),new RegExp('injected '+failure)); assert.deepEqual(await f.state(),before);
    assert.equal((await f.git(['worktree','list','--porcelain'])).split('worktree ').length,2);
    const index=f.calls.find(c=>c.args.includes('write-tree')).options.env.GIT_INDEX_FILE; await assert.rejects(readFile(index),{code:'ENOENT'});
  }
});

test('edits during snapshot, fetch or isolated merge are detected before real integration',async t=>{
  for(const point of ['write-tree','fetch','merge','index-flags']) {
    let changed=false;
    const f=await fixture(t,undefined,async({args,directory,git})=>{if(!changed&&(args.includes(point)||point==='index-flags'&&args.includes('fetch'))){changed=true;if(point==='index-flags') await git(['update-index','--assume-unchanged','other.txt']); else await writeFile(join(directory,'other.txt'),'racing edit\n');}});
    await writeFile(join(f.directory,'hello.txt'),'local\n'); const head=await f.git(['rev-parse','HEAD']), index=await readFile(join(f.directory,'.git/index'));
    await assert.rejects(f.invoke(),/changed/); assert.equal(await f.git(['rev-parse','HEAD']),head); if(point!=='index-flags') assert.deepEqual(await readFile(join(f.directory,'.git/index')),index);
    assert.equal(await readFile(join(f.directory,'other.txt'),'utf8'),point==='index-flags'?'other\n':'racing edit\n');
  }
});

test('snapshot and isolated integration disable hooks, filters, signing and external drivers',async t=>{
  const f=await fixture(t); const marker=join(f.directory,'executed').replace(/\\/g,'/');
  await writeFile(join(f.directory,'.gitattributes'),'*.txt filter=trap merge=trap\n');
  await f.git(['config','filter.trap.clean',`touch '${marker}'; cat`]); await f.git(['config','filter.trap.smudge',`touch '${marker}'; cat`]);
  await f.git(['config','filter.trap.required','true']); await f.git(['config','merge.trap.driver',`touch '${marker}'; false`]);
  await f.git(['config','commit.gpgSign','true']); await f.git(['config','gpg.program',`/nonexistent-signing-program`]);
  const hook=join(f.directory,'.git/hooks/post-merge'); await writeFile(hook,`#!/bin/sh\ntouch '${marker}'\n`); await chmod(hook,0o755);
  await writeFile(join(f.directory,'hello.txt'),'dirty\n');
  assert.equal((await f.invoke()).conflict,false); await assert.rejects(readFile(marker),{code:'ENOENT'});
});

test('untracked add/add collision produces isolated report without overwriting either version',async t=>{
  const f=await fixture(t); await writeFile(join(f.directory,'remote.txt'),'local untracked\n');
  const before=await f.state(), result=await f.invoke(); assert.equal(result.conflict,true); assert.deepEqual(result.files,['remote.txt']);
  assert.deepEqual(await f.state(),before); assert.equal(await readFile(join(f.directory,'remote.txt'),'utf8'),'local untracked\n');
});

test('staged rename receives remote edits while untracked source collision stays isolated',async t=>{
  const f=await fixture(t,{'hello.txt':'remote\n'});
  await f.git(['mv','hello.txt','renamed.txt']); await writeFile(join(f.directory,'hello.txt'),'remote\n');
  assert.deepEqual(await f.invoke(),{ok:true,conflict:false});
  assert.equal(await f.git(['show',':renamed.txt']),'remote\n');
  assert.equal(await readFile(join(f.directory,'hello.txt'),'utf8'),'remote\n');
});

test('identical remote content succeeds in unstaged and staged layers',async t=>{
  for (const staged of [false,true]) {
    const f=await fixture(t,{'hello.txt':'remote\n'});
    await writeFile(join(f.directory,'hello.txt'),'remote\n'); if(staged) await f.git(['add','hello.txt']);
    assert.deepEqual(await f.invoke(),{ok:true,conflict:false});
    assert.equal((await f.git(['rev-parse','HEAD'])).trim(),f.remoteHead);
    assert.equal(await f.git(['show',':hello.txt']),'remote\n');
    assert.equal((await f.git(['status','--porcelain'])).trim(),'');
  }
});

test('compatible same-file changes preserve staged and unstaged layers separately',async t=>{
  const base='one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n', remote=base.replace('one','REMOTE');
  for (const layer of ['staged','unstaged','partial']) {
    const f=await fixture(t,{'layers.txt':remote});
    const local=base.replace('five','STAGED'), work=local.replace('nine','UNSTAGED');
    await writeFile(join(f.directory,'layers.txt'),local);
    if(layer!=='unstaged') await f.git(['add','layers.txt']);
    if(layer==='partial') await writeFile(join(f.directory,'layers.txt'),work);
    assert.deepEqual(await f.invoke(),{ok:true,conflict:false});
    assert.equal(await f.git(['show',':layers.txt']),layer==='unstaged'?remote:remote.replace('five','STAGED'));
    assert.equal(await readFile(join(f.directory,'layers.txt'),'utf8'),(layer==='partial'?work:local).replace('one','REMOTE'));
    assert.equal(await f.git(['show','HEAD:layers.txt']),remote);
    assert.equal((await f.git(['rev-parse','HEAD'])).trim(),f.remoteHead);
  }
});

test('worktree-layer conflict leaves real staged content and index bytes untouched',async t=>{
  const f=await fixture(t,{'hello.txt':'remote\n'});
  await writeFile(join(f.directory,'hello.txt'),'worktree\n'); const before=await f.state();
  const result=await f.invoke(); assert.equal(result.conflict,true); assert.deepEqual(await f.state(),before);
  const report=await f.service.getConflictReport({directory:f.directory,conflictId:result.conflictId});
  assert.match(report.diff,/worktree/); assert.equal(report.layer,'worktree'); assert.equal(report.remoteHead,f.remoteHead);
});

test('CAS failure rolls back installed regular files and exact index bytes',async t=>{
  const f=await fixture(t,undefined,async({args,directory})=>{
    if(args.includes('update-ref')&&args.includes('refs/heads/dev')) {
      assert.equal(await readFile(join(directory,'remote.txt'),'utf8'),'remote\n');
      assert.ok((await readFile(join(directory,'.git/index.lock'))).length);
      throw new Error('injected CAS failure');
    }
  });
  await writeFile(join(f.directory,'hello.txt'),'staged\n'); await f.git(['add','hello.txt']);
  await writeFile(join(f.directory,'hello.txt'),'unstaged\n'); const before=await f.state();
  await assert.rejects(f.invoke(),/injected CAS failure/); assert.deepEqual(await f.state(),before);
  await assert.rejects(readFile(join(f.directory,'remote.txt')),{code:'ENOENT'});
  await assert.rejects(readFile(join(f.directory,'.git/index.lock')),{code:'ENOENT'});
});

test('HEAD CAS race preserves competing tip and rolls back worktree and index',async t=>{
  let competing;
  const f=await fixture(t,undefined,async({args,git})=>{
    if(args.includes('update-ref')&&args.includes('refs/heads/dev')) {
      // remote-dev is a different OID from original main/dev.
      competing=(await git(['rev-parse','remote-dev'])).trim();
      await git(['update-ref','refs/heads/dev',competing]);
    }
  });
  const before=await f.state(); await assert.rejects(f.invoke(),/cannot lock ref|expected/);
  assert.equal((await f.git(['rev-parse','HEAD'])).trim(),competing);
  assert.deepEqual(await readFile(join(f.directory,'.git/index')),before.index);
  assert.equal(await readFile(join(f.directory,'hello.txt'),'utf8'),before.hello);
  await assert.rejects(readFile(join(f.directory,'remote.txt')),{code:'ENOENT'});
});

test('foreign index lock is not overwritten or removed',async t=>{
  const f=await fixture(t); const before=await f.state();
  await writeFile(join(f.directory,'.git/index.lock'),'foreign');
  await assert.rejects(f.invoke(),/EEXIST/); assert.deepEqual(await f.state(),before);
  assert.equal(await readFile(join(f.directory,'.git/index.lock'),'utf8'),'foreign');
});

test('last fingerprint check catches racing edits while real index lock is held',async t=>{
  let changed=false;
  const f=await fixture(t,undefined,async({args,directory})=>{
    if(!changed&&args.includes('status')) {
      try { await readFile(join(directory,'.git/index.lock')); } catch { return; }
      changed=true; await writeFile(join(directory,'other.txt'),'last race\n');
    }
  });
  const before=await f.state(); await assert.rejects(f.invoke(),/changed/);
  assert.equal(await f.git(['rev-parse','HEAD']),before.head); assert.deepEqual(await readFile(join(f.directory,'.git/index')),before.index);
  assert.equal(await readFile(join(f.directory,'other.txt'),'utf8'),'last race\n');
  await assert.rejects(readFile(join(f.directory,'remote.txt')),{code:'ENOENT'});
});

test('ignored collisions and symlink parents are refused without mutation',async t=>{
  for(const kind of process.platform === 'win32' ? ['ignored'] : ['ignored','symlink']) {
    const f=await fixture(t); const beforeHead=await f.git(['rev-parse','HEAD']);
    if(kind==='ignored') { await writeFile(join(f.directory,'.git/info/exclude'),'remote.txt\n'); await writeFile(join(f.directory,'remote.txt'),'ignored\n'); }
    else await symlink('hello.txt',join(f.directory,'remote.txt'));
    const beforeIndex=await readFile(join(f.directory,'.git/index'));
    await assert.rejects(f.invoke(),/collision|regular files|regular-file/);
    assert.equal(await f.git(['rev-parse','HEAD']),beforeHead); assert.deepEqual(await readFile(join(f.directory,'.git/index')),beforeIndex);
  }
});

test('intent-to-add including empty files is rejected without mutation or fetch',async t=>{
  for(const content of ['', 'intent\n']) {
    const f=await fixture(t); await writeFile(join(f.directory,'intent.txt'),content); await f.git(['add','-N','intent.txt']);
    const before=await f.state(); await assert.rejects(f.invoke(),/Intent-to-add/); assert.deepEqual(await f.state(),before);
    assert.equal(await readFile(join(f.directory,'intent.txt'),'utf8'),content); assert.ok(!f.calls.some(c=>c.args.includes('fetch')));
  }
});

test('per-file installation check preserves edits after the last fingerprint file read',async t=>{
  let lockedChecks=0, changed=false;
  const f=await fixture(t,{'hello.txt':'remote\n'},async({args,directory})=>{
    if(args.includes('--git-path')&&args.at(-1)==='sequencer') {
      try { await readFile(join(directory,'.git/index.lock')); } catch { return; }
      if(++lockedChecks===4) { changed=true; await writeFile(join(directory,'hello.txt'),'late external\n'); }
    }
  });
  const before=await f.state(); await assert.rejects(f.invoke(),/Files changed during sync installation/); assert.equal(changed,true);
  assert.equal(await f.git(['rev-parse','HEAD']),before.head); assert.deepEqual(await readFile(join(f.directory,'.git/index')),before.index);
  assert.equal(await readFile(join(f.directory,'hello.txt'),'utf8'),'late external\n');
});

test('private file and index permissions survive remote integration',{skip:process.platform==='win32'?'POSIX permission bits are not supported by Windows':false},async t=>{
  const f=await fixture(t,{'hello.txt':'remote\n'}); await chmod(join(f.directory,'hello.txt'),0o600); await chmod(join(f.directory,'.git/index'),0o600);
  assert.equal((await f.invoke()).conflict,false);
  assert.equal((await stat(join(f.directory,'hello.txt'))).mode & 0o777,0o600); assert.equal((await stat(join(f.directory,'.git/index'))).mode & 0o777,0o600);
});

test('core.fileMode false preserves index mode and local filesystem mode',{skip:process.platform==='win32'?'POSIX executable bits are not supported by Windows':false},async t=>{
  const f=await fixture(t,{'hello.txt':'remote\n'}); await f.git(['config','core.fileMode','false']); await chmod(join(f.directory,'hello.txt'),0o700);
  assert.equal((await f.invoke()).conflict,false);
  assert.match(await f.git(['ls-files','--stage','hello.txt']),/^100644 /); assert.equal((await stat(join(f.directory,'hello.txt'))).mode & 0o777,0o700);
});

test('rollback preserves concurrent edits to installed new/existing files and index',async t=>{
  for(const kind of process.platform === 'win32' ? ['new','existing','index'] : ['new','existing','index','symlink']) {
    let externalIndex;
    const f=await fixture(t,{'hello.txt':'remote\n','remote.txt':'new remote\n'},async({args,directory})=>{
      if(args.includes('update-ref')&&args.includes('refs/heads/dev')) {
        if(kind==='index') { externalIndex=Buffer.from('external index bytes'); await writeFile(join(directory,'.git/index'),externalIndex); }
        else if(kind==='symlink') { await rm(join(directory,'hello.txt')); await symlink('other.txt',join(directory,'hello.txt')); }
        else await writeFile(join(directory,kind==='new'?'remote.txt':'hello.txt'),'external edit\n');
        throw new Error('injected CAS failure');
      }
    });
    const before=await f.state(); let recovery;
    await assert.rejects(f.invoke(),error=>{ const match=/rollback requires manual recovery at (.+?): /.exec(error.message); assert.ok(match); recovery=match[1]; return true; });
    t.after(async()=>{ assert.match(recovery,/simple-github-install-/); await rm(recovery,{recursive:true,force:true}); });
    const manifest=JSON.parse(await readFile(join(recovery,'recovery.json'),'utf8'));
    assert.equal(manifest.directory,await realpath(f.directory)); assert.deepEqual(await readFile(join(recovery,'original-index')),before.index);
    const originalHello=manifest.changes.find(c=>c.path==='hello.txt'); assert.equal(await readFile(join(recovery,originalHello.backupFile),'utf8'),'base\n');
    assert.equal(await f.git(['rev-parse','HEAD']),before.head);
    if(kind==='index') assert.deepEqual(await readFile(join(f.directory,'.git/index')),externalIndex);
    else assert.deepEqual(await readFile(join(f.directory,'.git/index')),before.index);
    if(kind==='new'||kind==='existing') assert.equal(await readFile(join(f.directory,kind==='new'?'remote.txt':'hello.txt'),'utf8'),'external edit\n');
    if(kind==='symlink') assert.equal(await readFile(join(f.directory,'other.txt'),'utf8'),'other\n');
    if(kind!=='new') await assert.rejects(readFile(join(f.directory,'remote.txt')),{code:'ENOENT'});
    await assert.rejects(readFile(join(f.directory,'.git/index.lock')),{code:'ENOENT'});
  }
});

test('assume-unchanged and skip-worktree entries require action before snapshot or fetch',async t=>{
  for(const flag of ['--assume-unchanged','--skip-worktree']) {
    const f=await fixture(t); await f.git(['update-index',flag,'hello.txt']); await writeFile(join(f.directory,'hello.txt'),'hidden edit\n');
    await assert.rejects(f.invoke(),/flags prevent safe sync/); assert.ok(!f.calls.some(c=>c.args.includes('fetch')||c.args.includes('read-tree')));
    assert.equal(await readFile(join(f.directory,'hello.txt'),'utf8'),'hidden edit\n');
  }
});
