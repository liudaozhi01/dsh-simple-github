import test from 'node:test';
import assert from 'node:assert/strict';
import {mount} from './panel.js';
class Element{constructor(tag){this.tagName=tag;this.children=[];this.style={};this.textContent='';}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}setAttribute(){}contains(node){return this===node||this.children.some(c=>c.contains(node));}querySelectorAll(){return [];}}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
for(const accepted of [true,false])test('update prompt '+(accepted?'installs once after a single confirmation':'cancel does not install'),async()=>{
 const keys=['document','fetch','confirm'],saved=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));let dispose;const calls=[],prompts=[],installs=[];
 try{
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.confirm=text=>{prompts.push(text);return accepted;};
 globalThis.fetch=async(url,options={})=>{calls.push({url,body:options.body&&JSON.parse(options.body)});const data=url.endsWith('/status')?{csrfToken:'csrf'}:url.endsWith('/update-check')?{available:true,version:'99.0.0',currentVersion:'0.15.11',checkId:'check1'}:url.endsWith('/update-install')?{manualInstallPath:'/tmp/verified.tgz'}:{jobs:[]};return {ok:true,json:async()=>data};};
 dispose=mount(new Element('root'),{autoInstaller:{reconcile:async()=>null,install:async body=>{installs.push(body);return {message:'installed'};}}});
 for(let i=0;i<8;i++)await tick();
 assert.equal(prompts.length,1);assert.match(prompts[0],/立即下载、校验并安装/);assert.equal(calls.filter(c=>c.url.endsWith('/update-install')).length,accepted?1:0);
 assert.equal(installs.length,accepted?1:0);if(accepted){assert.deepEqual(calls.find(c=>c.url.endsWith('/update-install')).body,{checkId:'check1',confirmed:true});assert.equal(installs[0].version,'99.0.0');}
 }finally{dispose?.();for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}}
});
