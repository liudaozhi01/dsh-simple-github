import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,chmod,readFile,writeFile,rm,symlink,unlink,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDockerJournal} from './docker-journal.js';
const release={releaseId:'release-1',head:'a'.repeat(40),backendImage:'registry.example/oa/backend@sha256:'+'b'.repeat(64),frontendImage:'registry.example/oa/frontend@sha256:'+'c'.repeat(64),delivered:true,accepted:true};
async function fixture(t){const dir=await realpath(await mkdtemp(join(tmpdir(),'xian-journal-test-')));await chmod(dir,0o700);t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('durable accepted releases reopen, copy safely and preserve immutable IDs',async t=>{
 const directory=await fixture(t);let j=await openDockerJournal({directory});await Promise.all([j.append(release),j.append(release)]);assert.equal(j.list().length,1);const list=j.list();list[0].head='x';assert.equal(j.list()[0].head,release.head);await assert.rejects(()=>j.append({...release,head:'d'.repeat(40)}),/rebound/);await j.close();j=await openDockerJournal({directory});assert.deepEqual(j.list(),[release]);await j.close();
});
test('directory permission changes poison writes and retain reconciliation lock',async t=>{
 const directory=await fixture(t),j=await openDockerJournal({directory});await chmod(directory,0o755);await assert.rejects(()=>j.append(release),/uncertain/);await chmod(directory,0o700);await j.close();await assert.rejects(()=>openDockerJournal({directory}));assert.equal((await readFile(join(directory,'docker-releases.jsonl'),'utf8')),'');
});
test('exclusive lock and private directory enforced',async t=>{
 const directory=await fixture(t),j=await openDockerJournal({directory});await assert.rejects(()=>openDockerJournal({directory}));await j.close();await chmod(directory,0o755);await assert.rejects(()=>openDockerJournal({directory}),/private/);
});
test('unaccepted records and client fields never persist',async t=>{
 const directory=await fixture(t),j=await openDockerJournal({directory});for(const value of [{...release,accepted:false},{...release,password:'sensitive'},{...release,head:release.head+'\n'}])assert.throws(()=>j.append(value));assert.deepEqual(j.list(),[]);await j.close();
});
test('truncated and changed hash chain reject restore without silent repair',async t=>{
 const directory=await fixture(t);let j=await openDockerJournal({directory});await j.append(release);await j.close();const p=join(directory,'docker-releases.jsonl'),original=await readFile(p,'utf8');for(const corrupt of [original.slice(0,-1),original.replace('release-1','release-2')]){await writeFile(p,corrupt,{mode:0o600});await assert.rejects(()=>openDockerJournal({directory}));assert.equal(await readFile(p,'utf8'),corrupt);}
});
test('symlink refused and external append poisons writer',async t=>{
 const directory=await fixture(t),p=join(directory,'docker-releases.jsonl'),target=join(directory,'other');await writeFile(target,'',{mode:0o600});await symlink(target,p);await assert.rejects(()=>openDockerJournal({directory}));await unlink(p);const j=await openDockerJournal({directory});await writeFile(p,'outside\n',{mode:0o600});await assert.rejects(()=>j.append(release),/uncertain/);assert.throws(()=>j.list(),/unavailable/);await j.close();assert.equal((await lstat(join(directory,'docker-releases.lock'))).isFile(),true);await assert.rejects(()=>openDockerJournal({directory}));
});
