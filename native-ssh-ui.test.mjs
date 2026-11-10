import test from 'node:test';
import assert from 'node:assert/strict';
import {mount} from './panel.js';
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.textContent='';this.value='';this.attributes={};this.style={};}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=[...nodes];}
 setAttribute(k,v){this.attributes[k]=v;}
 contains(node){return this===node||this.children.some(child=>child.contains(node));}
 querySelectorAll(tag){return this.children.flatMap(child=>[...(child.tagName===tag?[child]:[]),...child.querySelectorAll(tag)]);}
}
const all=n=>[n,...n.children.flatMap(all)];
const find=(root,predicate)=>{const result=all(root).find(predicate);assert.ok(result,'element exists');return result;};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const fingerprint='SHA256:'+ 'a'.repeat(43);
async function fixture(fn,{oa=true}={}){
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm,localStorage:globalThis.localStorage};
 const calls=[],writes=[],prompts=[];let dispose;
 const model={host:'example.invalid',port:2222,user:'deploy',privateKeyPath:'/fixture/id_ed25519',configured:true,trusted:false,fingerprint:null};
 const control={fail:'',scan:fingerprint,confirmed:false,hold:null,candidates:[]};
 globalThis.document={createElement:tag=>new Element(tag)};
 globalThis.localStorage={getItem:()=>null,setItem:(...args)=>writes.push(args)};
 globalThis.confirm=text=>{prompts.push(text);return control.confirmed;};
 globalThis.fetch=async(url,options={})=>{
  const path=url.replace('/simple-github/api','');const body=options.body&&JSON.parse(options.body);calls.push({path,body,options});
  if(control.hold&&path==='/ssh-config-save')await control.hold;
  if(control.fail===path)return {ok:false,json:async()=>({error:'mock denied: '+path})};
  let data=path==='/status'?{csrfToken:'csrf-fixture',oaDeploymentAvailable:oa}:path==='/update-check'?{available:false}:{};
  if(path==='/ssh-key-discover')data={candidates:control.candidates};
   if(path==='/ssh-config-read')data={...model};
  if(path==='/ssh-config-save'){Object.assign(model,body);data={...model};}
  if(path==='/ssh-host-scan')data={fingerprint:control.scan};
  if(path==='/ssh-host-trust'){Object.assign(model,{trusted:true,fingerprint:body.fingerprint});data={...model};}
  if(path==='/ssh-connection-test')data={ok:true,message:'只读 overview 成功'};
  return {ok:true,json:async()=>data};
 };
 const root=new Element('root'),button=label=>find(root,n=>n.tagName==='button'&&n.textContent===label),field=label=>find(root,n=>n.attributes['aria-label']===label);
 const click=async label=>{button(label).onclick();await tick();};
 try{dispose=mount(root);await tick();await fn({root,button,field,click,calls,writes,prompts,model,control});}finally{dispose?.();Object.assign(globalThis,old);}
}
for (const oa of [true,false]) test(`standalone SSH settings removed (OA=${oa})`,async()=>{
 await fixture(async({root,click,calls})=>{
  await click('设置');
  const forbidden=['发布服务器连接','读取连接配置','保存连接配置','获取指纹','核对后信任','测试连接','自动查找私钥路径'];
  for(const label of forbidden) assert.ok(!all(root).some(n=>n.textContent===label),label);
  assert.ok(!all(root).some(n=>n.attributes['aria-label']==='SSH 用户名'||n.attributes['aria-label']==='本机私钥绝对路径'));
  assert.ok(!calls.some(c=>c.path.startsWith('/ssh-')));
 },{oa});
});
