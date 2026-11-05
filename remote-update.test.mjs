import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteUpdater, newerVersion, releaseCandidate, UPDATE_REPOSITORY } from './remote-update.js';
import { gzipSync } from 'node:zlib';
import { validateUpdatePackage } from './remote-update.js';
function packageBytes(name='@local/dsh-simple-github',version='0.3.0'){
 const content=Buffer.from(JSON.stringify({name,version})),header=Buffer.alloc(512);
 header.write('package/package.json');header.write(content.length.toString(8),124);header[156]=48;
 return gzipSync(Buffer.concat([header,content,Buffer.alloc((512-content.length%512)%512),Buffer.alloc(1024)]));
}
const bytes = packageBytes();
test('package identity validated before install',()=>{validateUpdatePackage(bytes,'0.3.0');assert.throws(()=>validateUpdatePackage(packageBytes('other'),'0.3.0'));assert.throws(()=>validateUpdatePackage(bytes,'0.4.0'));assert.throws(()=>validateUpdatePackage(Buffer.from('bad'),'0.3.0'));});
const release = () => ({draft:false, prerelease:false, tag_name:'v0.3.0', body:'<img onerror=alert(1)>', assets:[{name:'local-dsh-simple-github-0.3.0.tgz', id:123, size:bytes.length, digest:'sha256:' + createHash('sha256').update(bytes).digest('hex')}]});
test('strict stable versions compare numerically and reject malformed metadata', () => {
  assert.equal(newerVersion('0.10.0','0.2.0'),true);
  assert.equal(newerVersion('0.2.0','0.2.0'),false);
  assert.equal(newerVersion('0.1.9','0.2.0'),false);
  for (const v of ['01.2.0','v0.3.0','0.3.0-beta','1.2','1.2.3;rm']) assert.throws(() => newerVersion(v,'0.2.0'));
  const mutate = fn => { const r=release();fn(r);assert.throws(()=>releaseCandidate(r,'0.2.0')); };
  mutate(r=>r.draft=true);mutate(r=>r.prerelease=true);mutate(r=>r.assets=[]);
  mutate(r=>r.assets.push({...r.assets[0]}));mutate(r=>r.assets[0].digest=null);
  mutate(r=>r.assets[0].id='../evil');mutate(r=>r.assets[0].size=17*1024*1024);
});
test('private gh API downloads fixed asset, verifies checksum and never installs', async () => {
  const dir=await mkdtemp(join(tmpdir(),'update-test-')), calls=[];
  const updater=createRemoteUpdater({currentVersion:'0.2.0',tempDirectory:dir,locateGh:async()=>'/tool/gh',command:async(cmd,args,opts)=>{calls.push({cmd,args,opts});return {stdout:args.includes('Accept: application/octet-stream')?bytes:JSON.stringify(release())};}});
  try {
    assert.equal(calls.length,0);
    const check=await updater.check();assert.equal(check.available,true);assert.equal(check.currentVersion,'0.2.0');assert.equal(check.notes,'<img onerror=alert(1)>');
    await assert.rejects(updater.install({checkId:check.checkId}),/重新检查/);
    await assert.rejects(updater.install({checkId:'fake',confirmed:true}),/重新检查/);
    const result=await updater.install({checkId:check.checkId,confirmed:true});
    assert.equal(result.installed,false);assert.deepEqual(await readFile(result.manualInstallPath),bytes);
    assert.ok(calls.every(c=>c.cmd==='/tool/gh'&&c.args.includes('github.com')&&c.args.some(a=>a.startsWith(`repos/${UPDATE_REPOSITORY}/releases/`))));
    assert.equal(calls.at(-1).opts.encoding,null);
    await assert.rejects(updater.install({checkId:check.checkId,confirmed:true}),/重新检查/);
  } finally {updater.close();await rm(dir,{recursive:true,force:true});}
});
test('expired, changed release, failed check and corrupted bytes never yield install path',async()=>{
  let now=0, data=release(), fail=false, corrupt=false;
  const updater=createRemoteUpdater({currentVersion:'0.2.0',now:()=>now,locateGh:async()=>'/gh',command:async(cmd,args)=>{if(fail)throw Error('ghp_abcdefghij');return {stdout:args.includes('Accept: application/octet-stream')?(corrupt?Buffer.from('bad'):bytes):JSON.stringify(data)};}});
  let c=await updater.check();now=900000;await assert.rejects(updater.install({checkId:c.checkId,confirmed:true}),/重新检查/);
  c=await updater.check();data.assets[0].id=124;await assert.rejects(updater.install({checkId:c.checkId,confirmed:true}),/已变化/);
  c=await updater.check();corrupt=true;await assert.rejects(updater.install({checkId:c.checkId,confirmed:true}),/校验失败/);
  await assert.rejects(updater.install({checkId:c.checkId,confirmed:true}),/重新检查/);
  fail=true;await assert.rejects(updater.check(),e=>!e.message.includes('ghp_abcdefghij'));
  await assert.rejects(updater.install({checkId:c.checkId,confirmed:true}),/重新检查/);
  updater.close();await assert.rejects(updater.check(),/已关闭/);
});
test('configured update source is pinned for metadata and verified asset download',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'update-config-')),calls=[];
 const updater=createRemoteUpdater({repository:'https://github.com/example/plugin-feed.git',currentVersion:'0.2.0',tempDirectory:directory,locateGh:async()=>'/gh',command:async(cmd,args)=>{calls.push(args);return {stdout:args.includes('Accept: application/octet-stream')?bytes:JSON.stringify(release())};}});
 try{const candidate=await updater.check();await updater.install({checkId:candidate.checkId,confirmed:true});assert.equal(calls.length,3);assert.ok(calls.every(args=>args.some(arg=>arg.startsWith('repos/example/plugin-feed/releases/'))));}
 finally{updater.close();await rm(directory,{recursive:true,force:true});}
 assert.throws(()=>createRemoteUpdater({repository:'https://evil.example/a/b'}));
});
test('duplicate requests rejected, missing gh and no-update handled without installs',async()=>{
  let finish;const gate=new Promise(r=>finish=r);
  const updater=createRemoteUpdater({currentVersion:'0.3.0',locateGh:async()=>'/gh',command:async()=>{await gate;return {stdout:JSON.stringify(release())};}});
  const pending=updater.check();await assert.rejects(updater.check(),/进行中/);finish();assert.equal((await pending).available,false);updater.close();
  const missing=createRemoteUpdater({currentVersion:'0.2.0',locateGh:async()=>null});await assert.rejects(missing.check(),/GitHub CLI/);missing.close();
});
