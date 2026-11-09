import test from 'node:test';
import assert from 'node:assert/strict';
import {mount} from './panel.js';
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.textContent='';this.attributes={};this.style={};this.value='';}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}
 setAttribute(k,v){this.attributes[k]=v;}contains(n){return this===n||this.children.some(c=>c.contains(n));}
 querySelectorAll(tag){return this.children.flatMap(c=>[...(c.tagName===tag?[c]:[]),...c.querySelectorAll(tag)]);}
}
const all=n=>[n,...n.children.flatMap(all)],tick=()=>new Promise(r=>setImmediate(r));
for(const errorName of ['TimeoutError','TypeError','GitHubTLS'])test('sync wait budget and unknown backend result: '+errorName,async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm},timeout=AbortSignal.timeout,calls=[],budgets=[];let dispose;
 AbortSignal.timeout=ms=>{budgets.push(ms);return new AbortController().signal;};globalThis.document={createElement:t=>new Element(t)};globalThis.confirm=()=>true;
 const repo={directory:'/fixture',branch:'dev',repository:'owner/repo',head:'a'.repeat(40),fingerprint:'f',changes:[]};
 globalThis.fetch=async(url,options={})=>{calls.push(url);if(url.endsWith('/sync-dev')){assert.equal(budgets.at(-1),600000);const error=new Error('test disconnect');error.name=errorName;if(errorName==='GitHubTLS')return {ok:false,json:async()=>({error:'Post "https://api.github.com/graphql": net/http: TLS handshake timeout'})};throw error;}assert.equal(budgets.at(-1),180000);return {ok:true,json:async()=>url.endsWith('/status')?{user:{login:'test'},csrfToken:'csrf',oaDeploymentAvailable:false}:url.endsWith('/inspect')?repo:{available:false}};};
 try{const root=new Element('root');dispose=mount(root);await tick();const dir=all(root).find(n=>n.sgDraftKey==='project-directory');dir.value='/fixture';dir.onkeydown({key:'Enter',preventDefault(){}});await tick();assert.ok(all(root).some(n=>n.textContent.includes('不必先点同步才能推送')));assert.ok(!calls.some(url=>url.endsWith('/sync-dev')));all(root).find(n=>n.textContent==='同步最新代码').onclick();await tick();
 assert.equal(all(root).filter(n=>n.className==='sg-error').length,1);assert.ok(!all(root).some(n=>n.className==='sg-notice sg-error'));if(errorName!=='GitHubTLS'){assert.ok(all(root).some(n=>n.textContent.includes('后台同步可能仍在运行')));assert.ok(all(root).some(n=>n.textContent.includes('不要重复拉取')));}else assert.ok(all(root).some(n=>n.tagName==='pre'&&n.textContent.includes('TLS handshake timeout')));assert.ok(!all(root).some(n=>n.textContent.includes('已停止')));assert.equal(calls.filter(x=>x.endsWith('/sync-dev')).length,1);
 }finally{dispose?.();AbortSignal.timeout=timeout;Object.assign(globalThis,old);}
});
