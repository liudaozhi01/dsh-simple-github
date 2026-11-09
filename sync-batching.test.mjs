import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createService,runCommand} from './core.js';

test('runCommand stdin preserves binary output, empty input, timeout and write failures',async()=>{
 const bytes=Buffer.from([0,1,255,10]);
 const echo=await runCommand(process.execPath,['-e','process.stdin.pipe(process.stdout)'],{input:bytes,encoding:null});assert.deepEqual(echo.stdout,bytes);
 assert.equal((await runCommand(process.execPath,['-e','process.stdin.pipe(process.stdout)'],{input:''})).stdout,'');
 await assert.rejects(runCommand(process.execPath,['-e','process.stdin.resume();setInterval(()=>{},1000)'],{input:'x',timeout:30}),/timed out/);
 await assert.rejects(runCommand(process.execPath,['-e','process.exit(2)'],{input:Buffer.alloc(4*1024*1024)}),/input|failed|2/i);
 await assert.rejects(runCommand(process.execPath,['-e',''],{input:123}),/input/);
});
async function fixture(t,count=4,intercept=()=>{}){
 const parent=await mkdtemp(join(tmpdir(),'sync-batch-')),directory=join(parent,'repo');await mkdir(directory);
 const git=async args=>(await runCommand('git',['-C',directory,...args])).stdout;
 await git(['init','-b','dev']);await git(['config','core.autocrlf','false']);await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@localhost']);
 const paths=Array.from({length:count},(_,i)=>i===0?(process.platform==='win32'?'space 中文.txt':'space tab\t中文.txt'):i===1?(process.platform==='win32'?'line break.txt':'line\nbreak.txt'):`file-${i}.txt`);
 for(const path of paths)await writeFile(join(directory,path),'base\n');await git(['add','.']);await git(['commit','-m','base']);const head=(await git(['rev-parse','HEAD'])).trim();await git(['remote','add','origin','https://github.com/ssal-team/XiAN-OA.git']);
 const calls=[];const service=createService({ghPath:'mock-gh',command:async(cmd,args,options)=>{
  calls.push({args,options});if(cmd==='mock-gh')return {stdout:JSON.stringify(args[0]==='api'?{login:'fixture'}:{nameWithOwner:'ssal-team/XiAN-OA',defaultBranchRef:{name:'main'}}),stderr:''};
  const injected=await intercept({args,options,directory,git});if(injected)return injected;
  if(args.includes('fetch')){await git(['update-ref','refs/remotes/origin/dev',head]);return {stdout:'',stderr:''};}return runCommand(cmd,args,options);
 }});
 t.after(async()=>{service.close();await rm(parent,{recursive:true,force:true});});
 const invoke=async()=>{const i=await service.inspect(directory);return service.route('sync-dev',{directory,expectedHead:i.head,expectedBranch:i.branch,expectedRepository:i.repository,expectedBaseBranch:i.baseBranch,expectedFingerprint:i.fingerprint});};
 return {directory,paths,git,calls,invoke};
}
test('450-file sync batches attributes and index with NUL paths; preserves staged/worktree/deleted layers',async t=>{
 const f=await fixture(t,450);await writeFile(join(f.directory,f.paths[0]),'staged\n');await f.git(['add','--',f.paths[0]]);await writeFile(join(f.directory,f.paths[0]),'worktree\n');await rm(join(f.directory,f.paths[2]));await writeFile(join(f.directory,'untracked.txt'),'new\n');
 const before=await f.git(['status','--porcelain=v1','-z']);assert.deepEqual(await f.invoke(),{ok:true,conflict:false});assert.equal(await f.git(['status','--porcelain=v1','-z']),before);assert.equal(await readFile(join(f.directory,f.paths[0]),'utf8'),'worktree\n');assert.equal(await f.git(['show',':'+f.paths[0]]),'staged\n');
 const attrs=f.calls.filter(c=>c.args.includes('check-attr')),updates=f.calls.filter(c=>c.args.includes('--index-info'));
 assert.equal(attrs.length,2);assert.equal(updates.length,1);assert.ok(attrs.every(c=>c.args.includes('--stdin')&&c.options.input.includes(f.paths[1]+'\0')));assert.ok(updates[0].options.input.includes('\t'+f.paths[0]+'\0'));assert.ok(updates[0].options.input.includes('0 '+ '0'.repeat(40)+'\tfile-2.txt\0'));
});
test('a missing path appearing during batch attribute query is rejected',async t=>{
 let changed=false;const f=await fixture(t,4,async({args,directory})=>{if(!changed&&args.includes('check-attr')){changed=true;await writeFile(join(directory,'file-2.txt'),'racing new bytes\n');}});
 await rm(join(f.directory,'file-2.txt'));await assert.rejects(f.invoke(),/Files changed during batch attribute/);assert.ok(!f.calls.some(c=>c.args.includes('fetch')||c.args.includes('--index-info')));assert.equal(await readFile(join(f.directory,'file-2.txt'),'utf8'),'racing new bytes\n');
});
for(const kind of ['missing','duplicate','foreign','unsafe'])test('malformed batch attributes fail closed: '+kind,async t=>{
 const f=await fixture(t,4,({args,options})=>{
  if(!args.includes('check-attr'))return;
  const paths=options.input.split('\0').filter(Boolean);let records=paths.flatMap(path=>['ident','working-tree-encoding'].flatMap(attr=>[path,attr,'unspecified']));
  if(kind==='missing')records=records.slice(0,-3);if(kind==='duplicate')records.splice(3,3,...records.slice(0,3));if(kind==='foreign')records[0]='foreign.txt';if(kind==='unsafe')records[2]='set';return {stdout:records.join('\0')+'\0',stderr:''};
 });
 const before=await readFile(join(f.directory,'.git/index'));await assert.rejects(f.invoke(),/attribute|ident|encoding/);assert.deepEqual(await readFile(join(f.directory,'.git/index')),before);assert.ok(!f.calls.some(c=>c.args.includes('fetch')||c.args.includes('--index-info')));
});
