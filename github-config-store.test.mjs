import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGithubConfigStore} from './github-config-store.js';
const initial={repository:'example/app',branch:'main',cloneMode:'single',cloneBranch:'main',updateRepository:'example/plugin'};
test('admin saves packaged config atomically, with revision check and immutable active config',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'github-config-')),path=join(dir,'github-project.json');
 try{await writeFile(path,JSON.stringify(initial));let user={login:'member',name:'liudaozhi01'};
 const store=createGithubConfigStore({path,activeConfig:initial,getUser:async()=>user});
 await assert.rejects(store.read(),{status:403});await assert.rejects(store.save({}),{status:403});
 assert.deepEqual(JSON.parse(await readFile(path,'utf8')),initial);
 user={login:'liudaozhi01'};const old=await store.read();assert.equal(old.reloadRequired,false);
 const next={...initial,branch:'release/shared',updateRepository:'example/new-updates'};
 const saved=await store.save({config:next,revision:old.revision,confirmed:true});assert.equal(saved.reloadRequired,true);
 assert.deepEqual(JSON.parse(await readFile(path,'utf8')),next);assert.equal(initial.branch,'main');
 await assert.rejects(store.save({config:initial,revision:old.revision,confirmed:true}),{status:409});
 await assert.rejects(store.save({config:{...next,administratorLogin:'member'},revision:saved.revision,confirmed:true}));
 assert.deepEqual(JSON.parse(await readFile(path,'utf8')),next);
 }finally{await rm(dir,{recursive:true,force:true});}
});
