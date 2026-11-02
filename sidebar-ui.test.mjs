import test from 'node:test';
import assert from 'node:assert/strict';
import {mount} from './panel.js';
class Element{
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.style={};this.textContent='';}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=[...nodes];}
 setAttribute(k,v){this.attributes[k]=v;}contains(n){return this===n||this.children.some(c=>c.contains(n));}querySelectorAll(){return [];}
}
const all=n=>[n,...n.children.flatMap(all)];
test('navigation changes visible sections without API calls and preserves project draft',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch};let dispose;const calls=[];
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.fetch=async url=>{calls.push(url);return {ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf'}:{available:false}};};
 try{
 const root=new Element('root');dispose=mount(root);await new Promise(r=>setImmediate(r));
 const sections=()=>all(root).filter(n=>n.tagName==='section'&&!n.hidden).map(n=>n.attributes['data-view']);
 assert.deepEqual(sections(),['project']);const field=all(root).find(n=>n.sgDraftKey==='project-directory');field.value='/draft';field.oninput();
 const before=calls.length;const select=view=>all(root).find(n=>n.tagName==='nav').children.find(n=>n.textContent===view).onclick();
 select('设置');assert.deepEqual(sections(),['settings','settings']);
 select('代码同步');assert.deepEqual(sections(),[]);assert.ok(all(root).some(n=>n.textContent==='先打开一个项目'));
 select('项目');assert.equal(all(root).find(n=>n.sgDraftKey==='project-directory').value,'/draft');assert.equal(calls.length,before);
 }finally{dispose?.();Object.assign(globalThis,old);}
});
