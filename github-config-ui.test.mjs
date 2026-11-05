import test from 'node:test';
import assert from 'node:assert/strict';
import {mount} from './panel.js';
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.style={};this.textContent='';}
 append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;}
 setAttribute(k,v){this.attributes[k]=v;} contains(n){return this===n||this.children.some(c=>c.contains(n));} querySelectorAll(){return [];}
}
const all=n=>[n,...n.children.flatMap(all)],tick=()=>new Promise(r=>setImmediate(r));
async function fixture({branch='release/team-v2',localBranch=branch,oa=false,administrator=false,cloneMode='single',cloneBranch=branch}={},exercise){
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm,localStorage:globalThis.localStorage};
 const calls=[],confirmations=[];let dispose;
 globalThis.document={createElement:t=>new Element(t)};globalThis.localStorage={getItem:()=>'/project',setItem(){}};
 globalThis.confirm=s=>{confirmations.push(s);return true;};
 globalThis.fetch=async(url,opt={})=>{calls.push({url,body:opt.body&&JSON.parse(opt.body)});return {ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf',user:{login:'member'},project:{repository:'example/app',branch,cloneMode,cloneBranch},githubAdministrator:administrator,oaDeploymentAvailable:oa}:url.endsWith('/inspect')?{directory:'/project',branch:localBranch,changes:[],head:'a'.repeat(40),fingerprint:'fp',repository:'example/app',baseBranch:'main'}:url.endsWith('/update-check')?{available:false}:url.endsWith('/sync-dev')?{ok:true}:url.endsWith('/github-config-read')?{config:{repository:'example/app',branch,updateRepository:'example/plugins',cloneMode,cloneBranch},revision:'old'}:url.endsWith('/github-config-save')?{config:JSON.parse(opt.body).config,revision:'new',reloadRequired:true,message:'saved'}:{}};};
 const root=new Element('root'),node=label=>{const n=all(root).find(n=>n.textContent===label);assert.ok(n,'missing '+label);return n;};
 const click=async label=>{await node(label).onclick();await tick();await tick();};
 try{dispose=mount(root);await tick();await tick();await exercise({root,node,click,calls,confirmations});}finally{dispose?.();Object.assign(globalThis,old);}
}
test('configured branch drives collaboration labels and sync alias without OA controls',()=>fixture({},async({root,node,click,calls,confirmations})=>{
 assert.equal(node('从 release/team-v2 拉取').disabled,false);
 assert.equal(node('提交并推送到 release/team-v2').disabled,false);
 assert.ok(all(root).some(n=>n.textContent.includes('只克隆 release/team-v2 分支')));
 for(const label of ['远程部署','发布 dev','检测开发环境','GitHub 管理后台'])assert.ok(!all(root).some(n=>n.textContent===label));
 await click('从 release/team-v2 拉取');
 assert.ok(calls.some(c=>c.url.endsWith('/sync-dev')));
 assert.match(confirmations[0],/获取最新 release\/team-v2/);assert.doesNotMatch(confirmations[0],/发布 dev/);
 assert.ok(!calls.some(c=>/\/docker-|\/environment-/.test(c.url)));
}));
test('configured branch mismatch disables pull and offers compatible switch route',()=>fixture({localBranch:'other'},async({node,click,calls})=>{
 assert.equal(node('从 release/team-v2 拉取').disabled,true);
 assert.equal(node('提交并推送到 release/team-v2').disabled,true);
 await click('切换到 release/team-v2');assert.ok(calls.some(c=>c.url.endsWith('/switch-dev')));
}));
test('administrator edits and saves preconfigured fields across busy rerenders',()=>fixture({administrator:true},async({root,node,click,calls})=>{
 node('GitHub 管理后台');await click('读取包内配置');
 const field=key=>all(root).find(n=>n.sgDraftKey==='admin-'+key);
 assert.equal(field('repository').value,'example/app');
 for(const [key,value] of Object.entries({repository:'other/project',branch:'release/next',updateRepository:'other/plugins',cloneBranch:'seed/branch'})){field(key).value=value;field(key).oninput();}
 field('cloneMode').value='all';field('cloneMode').onchange();
 await click('保存包内配置');
 assert.deepEqual(calls.find(c=>c.url.endsWith('/github-config-save')).body,{config:{repository:'other/project',branch:'release/next',updateRepository:'other/plugins',cloneMode:'all',cloneBranch:'seed/branch'},revision:'old',confirmed:true});
 node('包内配置与当前运行配置不同，请重载；打包将使用已保存的配置。');
}));
test('all clone description fetches remote branches and checks out collaboration branch only',()=>fixture({cloneMode:'all',cloneBranch:'seed'},async({root})=>{
 assert.ok(all(root).some(n=>n.textContent.includes('获取全部远程分支并检出 release/team-v2 分支')));
 assert.ok(all(root).some(n=>n.textContent.includes('不会创建或检出所有本地分支')));
}));
test('single clone branch may differ from collaboration branch',()=>fixture({cloneBranch:'seed'},async({root,node})=>{
 assert.ok(all(root).some(n=>n.textContent.includes('只克隆 seed 分支并直接打开；协作分支为 release/team-v2')));
 node('从 release/team-v2 拉取');node('提交并推送到 release/team-v2');
}));
