import test from 'node:test';
import assert from 'node:assert/strict';
import {mount} from './panel.js';
class Element{
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.style={};this.textContent='';}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=[...nodes];}
 setAttribute(k,v){this.attributes[k]=v;}contains(n){return this===n||this.children.some(c=>c.contains(n));}querySelectorAll(){return [];}
}
const all=n=>[n,...n.children.flatMap(all)];
for(const name of ['刘道志','',null])test('account display name fallback: '+String(name),async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch};let dispose;
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.fetch=async url=>({ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf',user:{login:'liudaozhi01',name}}:{available:false}});
 try{const root=new Element('root');dispose=mount(root);await new Promise(r=>setImmediate(r));assert.equal(all(root).find(n=>n.className==='sg-account').textContent,name||'liudaozhi01');assert.ok(all(root).some(n=>n.textContent==='已登录：'+(name?name+'（@liudaozhi01）':'liudaozhi01')));}finally{dispose?.();Object.assign(globalThis,old);}
});
test('setup notice requires active session and confirmation, sends only request identity',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm};let dispose,sid=null,accept=false;const calls=[];
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.confirm=()=>accept;globalThis.fetch=async(url,opts={})=>{calls.push({url,body:opts.body&&JSON.parse(opts.body)});return {ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf'}:{ok:true,notified:true}};};
 try{const root=new Element('root');dispose=mount(root,{getSessionId:()=>sid});await new Promise(r=>setImmediate(r));const click=async()=>{all(root).find(n=>n.textContent==='请 AI 帮我配置').onclick();await new Promise(r=>setImmediate(r));};await click();assert.ok(!calls.some(c=>c.url.endsWith('/environment-notify')));sid='session1';await click();assert.ok(!calls.some(c=>c.url.endsWith('/environment-notify')));accept=true;await click();const sent=calls.find(c=>c.url.endsWith('/environment-notify'));assert.equal(sent.body.sessionId,sid);assert.deepEqual(Object.keys(sent.body).sort(),['requestId','sessionId']);assert.match(sent.body.requestId,/^[a-f0-9-]+$/);}finally{dispose?.();Object.assign(globalThis,old);}
});
test('navigation changes visible sections without API calls and preserves project draft',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch};let dispose;const calls=[];
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.fetch=async url=>{calls.push(url);return {ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf'}:{available:false}};};
 try{
 const root=new Element('root');dispose=mount(root);await new Promise(r=>setImmediate(r));
 const sections=()=>all(root).filter(n=>n.tagName==='section'&&!n.hidden).map(n=>n.attributes['data-view']);
 assert.deepEqual(sections(),['project','project']);const field=all(root).find(n=>n.sgDraftKey==='project-directory');field.value='/draft';field.oninput();
 const before=calls.length;const select=view=>all(root).find(n=>n.tagName==='nav').children.find(n=>n.textContent===view).onclick();
 select('设置');assert.deepEqual(sections(),['settings','settings']);
 select('项目');assert.equal(all(root).filter(n=>n.tagName==='section'&&!n.hidden)[0].children[0].textContent,'开发环境初始化');select('本地环境');assert.deepEqual(sections(),[]);select('代码同步');assert.deepEqual(sections(),[]);assert.ok(all(root).some(n=>n.textContent==='先打开一个项目'));
 select('项目');assert.equal(all(root).find(n=>n.sgDraftKey==='project-directory').value,'/draft');assert.equal(calls.length,before);
 }finally{dispose?.();Object.assign(globalThis,old);}
});
