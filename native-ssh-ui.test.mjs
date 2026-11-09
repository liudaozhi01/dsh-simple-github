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
test('SSH settings are OA-only and explicitly lazy without extra startup requests',async()=>{
 await fixture(async({root,click,calls,field,button})=>{
  assert.deepEqual(calls.map(c=>c.path),['/status','/update-check']);
  assert.ok(!all(root).some(n=>n.textContent==='发布服务器连接'));
  await click('设置');assert.equal(calls.length,2);assert.ok(all(root).some(n=>n.textContent==='发布服务器连接'));
  await click('读取连接配置');assert.equal(field('服务器地址（只读）').value,'example.invalid');assert.equal(field('SSH 端口（只读）').value,'2222');assert.equal(field('服务器地址（只读）').readOnly,true);assert.equal(field('SSH 端口（只读）').readOnly,true);assert.equal(button('测试连接').disabled,true);assert.equal(button('核对后信任').disabled,true);
 });
 await fixture(async({root,click,calls})=>{await click('设置');assert.ok(!all(root).some(n=>n.textContent==='发布服务器连接'));assert.ok(!calls.some(c=>c.path.startsWith('/ssh-')));},{oa:false});
});
test('SSH save preserves failed input, rejects key bodies and relative paths, never persists frontend secrets',async()=>{
 await fixture(async({root,click,calls,writes,field,control,button})=>{
  await click('设置');await click('读取连接配置');
  const set=(label,value)=>{const n=field(label);n.value=value;n.oninput();};
  set('SSH 用户名','alice');set('本机私钥绝对路径','/fixture/alice_key');
  control.fail='/ssh-config-save';await click('保存连接配置');assert.equal(field('SSH 用户名').value,'alice');assert.equal(field('本机私钥绝对路径').value,'/fixture/alice_key');
  const count=calls.filter(c=>c.path==='/ssh-config-save').length;
  for(const invalid of ['root','Alice','alice.ssh','alice$']){set('SSH 用户名',invalid);await click('保存连接配置');assert.equal(calls.filter(c=>c.path==='/ssh-config-save').length,count);}
  set('SSH 用户名','alice');
  set('本机私钥绝对路径','relative/key');await click('保存连接配置');assert.equal(calls.filter(c=>c.path==='/ssh-config-save').length,count);
  for(const body of ['-----BEGIN OPENSSH PRIVATE KEY-----\nfixture','ssh-ed25519 AAAA fixture','ecdsa-sha2-nistp256 AAAA']){set('本机私钥绝对路径',body);assert.equal(field('本机私钥绝对路径').value,'relative/key');}
  control.fail='';set('本机私钥绝对路径','C:\\Users\\fixture\\id_ed25519');let finish;control.hold=new Promise(resolve=>{finish=resolve;});button('保存连接配置').onclick();await tick();assert.equal(button('保存连接配置').disabled,true);button('保存连接配置').onclick();await tick();assert.equal(calls.filter(c=>c.path==='/ssh-config-save').length,count+1);finish();await tick();
  assert.deepEqual(calls.filter(c=>c.path==='/ssh-config-save').at(-1).body,{user:'alice',privateKeyPath:'C:\\Users\\fixture\\id_ed25519'});
  assert.deepEqual(writes,[]);assert.ok(!calls.some(c=>JSON.stringify(c.body??{}).includes('BEGIN OPENSSH')));assert.ok(!all(root).some(n=>n.tagName==='textarea'||n.type==='file'||n.type==='password'));
  for(const call of calls.filter(c=>c.path.startsWith('/ssh-'))){assert.equal(call.options.method,'POST');assert.equal(call.options.headers['X-Simple-Git-Token'],'csrf-fixture');}
 });
});
test('first trust requires explicit administrator SHA256 confirmation; changed fingerprints are refused',async()=>{
 await fixture(async({root,click,calls,prompts,control,button})=>{
  await click('设置');await click('读取连接配置');await click('获取指纹');assert.ok(!calls.some(c=>c.path==='/ssh-host-trust'));
  await click('核对后信任');assert.ok(!calls.some(c=>c.path==='/ssh-host-trust'));assert.ok(prompts[0].includes('管理员'));assert.ok(prompts[0].includes(fingerprint));assert.ok(prompts[0].includes('example.invalid:2222'));
  control.confirmed=true;await click('核对后信任');assert.deepEqual(calls.find(c=>c.path==='/ssh-host-trust').body,{fingerprint});assert.equal(button('测试连接').disabled,false);
  await click('测试连接');assert.deepEqual(calls.find(c=>c.path==='/ssh-connection-test').body,{});assert.ok(all(root).some(n=>n.textContent==='只读 overview 成功'));assert.ok(!calls.some(c=>c.path.startsWith('/docker-')));
  control.scan='SHA256:'+'b'.repeat(43);await click('获取指纹');assert.ok(all(root).some(n=>n.textContent.includes('指纹已变化')));assert.equal(button('核对后信任').disabled,true);assert.equal(calls.filter(c=>c.path==='/ssh-host-trust').length,1);
 });
});
test('scan and trust failures preserve inputs and never grant trust or trigger deployment',async()=>{
 await fixture(async({root,click,field,calls,control,button})=>{
  await click('设置');await click('读取连接配置');const path=field('本机私钥绝对路径');path.value='/fixture/unsaved';path.oninput();
  control.fail='/ssh-host-scan';await click('获取指纹');assert.equal(button('核对后信任').disabled,true);assert.equal(field('本机私钥绝对路径').value,'/fixture/unsaved');
  control.fail='';control.scan='invalid';await click('获取指纹');assert.equal(button('核对后信任').disabled,true);
  control.scan=fingerprint;await click('获取指纹');control.confirmed=true;control.fail='/ssh-host-trust';await click('核对后信任');assert.equal(button('测试连接').disabled,true);assert.equal(field('本机私钥绝对路径').value,'/fixture/unsaved');assert.ok(all(root).some(n=>n.textContent.includes('mock denied')));assert.ok(!calls.some(c=>c.path==='/ssh-connection-test'||c.path.startsWith('/docker-')));
 });
});

test('private key discovery is explicit, preserves drafts, selects candidates without save/trust/connect',async()=>{
 await fixture(async({click,field,calls,control,root})=>{
  await click('设置');await click('读取连接配置');
  control.candidates=[{privateKeyPath:'/fixture/found'}];
  await click('自动查找私钥路径');assert.equal(field('本机私钥绝对路径').value,'/fixture/id_ed25519');
  await click('使用路径：/fixture/found');assert.equal(field('本机私钥绝对路径').value,'/fixture/found');
  let key=field('本机私钥绝对路径');key.value='';key.oninput();
  await click('自动查找私钥路径');assert.equal(field('本机私钥绝对路径').value,'/fixture/found');
  control.candidates=[{privateKeyPath:'/fixture/a'},{privateKeyPath:'C:\\Users\\fixture\\id_rsa'}];
  await click('自动查找私钥路径');assert.equal(field('本机私钥绝对路径').value,'/fixture/found');
  await click('使用路径：C:\\Users\\fixture\\id_rsa');assert.equal(field('本机私钥绝对路径').value,'C:\\Users\\fixture\\id_rsa');
  control.candidates=[];await click('自动查找私钥路径');assert.ok(all(root).some(n=>n.textContent.includes('未找到通过安全检查')));
  control.candidates=[{privateKeyPath:'-----BEGIN PRIVATE KEY-----'}];await click('自动查找私钥路径');assert.ok(all(root).some(n=>n.textContent.includes('候选路径响应无效')));
  control.fail='/ssh-key-discover';await click('自动查找私钥路径');assert.equal(field('本机私钥绝对路径').value,'C:\\Users\\fixture\\id_rsa');
  assert.ok(!calls.some(c=>['/ssh-config-save','/ssh-host-trust','/ssh-connection-test'].includes(c.path)||c.path.startsWith('/docker-')));
 });
});
