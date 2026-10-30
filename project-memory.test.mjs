import test from 'node:test';
import assert from 'node:assert/strict';
import {mount} from './panel.js';
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.textContent='';this.value='';this.style={};}
 append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;}
 setAttribute(){} contains(node){return this===node||this.children.some(n=>n.contains(node));}
 querySelectorAll(tag){return this.children.flatMap(n=>[...(n.tagName===tag?[n]:[]),...n.querySelectorAll(tag)]);}
}
const all=n=>[n,...n.children.flatMap(all)];
const tick=()=>new Promise(r=>setImmediate(r));
test('remount restores last successfully inspected canonical project without mutations; failures and blocked storage stay usable',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,localStorage:globalThis.localStorage};
 const values=new Map(),calls=[];let dispose,fail=false;
 globalThis.document={createElement:tag=>new Element(tag)};
 globalThis.localStorage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
 globalThis.fetch=async(url,opts={})=>{calls.push({url,body:opts.body&&JSON.parse(opts.body)});return {ok:!fail||!url.endsWith('/inspect'),json:async()=>url.endsWith('/status')?{csrfToken:'csrf'}:url.endsWith('/inspect')?fail?{error:'directory missing'}:{directory:'/canonical/project',branch:'dev',changes:[]}: {cancelled:true}};};
 try{
  let root=new Element('root');dispose=mount(root);await tick();
  const input=all(root).find(n=>n.sgDraftKey==='project-directory');input.value='/chosen/project';input.onkeydown({key:'Enter',preventDefault(){}});await tick();
  assert.equal(values.get('simple-github:last-project:v1'),'/canonical/project');dispose();
  root=new Element('root');dispose=mount(root);await tick();
  assert.equal(all(root).find(n=>n.sgDraftKey==='project-directory').value,'/canonical/project');
  assert.ok(all(root).some(n=>n.textContent==='已恢复上次选择的项目。'));
  assert.equal(calls.at(-1).body.directory,'/canonical/project');
  assert.ok(calls.every(c=>/\/(status|inspect)$/.test(c.url)));dispose();
  fail=true;root=new Element('root');dispose=mount(root);await tick();
  assert.ok(all(root).some(n=>n.textContent.includes('无法恢复上次项目')));
  assert.equal(all(root).find(n=>n.sgDraftKey==='project-directory').value,'/canonical/project');
  assert.equal(values.get('simple-github:last-project:v1'),'/canonical/project');dispose();
  globalThis.localStorage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
  fail=false;root=new Element('root');dispose=mount(root);await tick();
  const next=all(root).find(n=>n.sgDraftKey==='project-directory');next.value='/new';next.onkeydown({key:'Enter',preventDefault(){}});await tick();
  assert.ok(all(root).some(n=>n.textContent==='项目已打开。'));
 }finally{dispose?.();Object.assign(globalThis,old);}
});
