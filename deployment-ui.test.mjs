import test from 'node:test';
import assert from 'node:assert/strict';
import {mount} from './panel.js';
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.style={};this.textContent='';}
 append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;}
 setAttribute(k,v){this.attributes[k]=v;} contains(n){return this===n||this.children.some(c=>c.contains(n));} querySelectorAll(){return [];}
}
const all=n=>[n,...n.children.flatMap(all)],tick=()=>new Promise(r=>setImmediate(r));
async function fixture(settings,exercise){
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm,localStorage:globalThis.localStorage};
 const calls=[];let dispose;
 globalThis.document={createElement:t=>new Element(t)};globalThis.localStorage={getItem:()=>'',setItem(){}};globalThis.confirm=()=>false;
 globalThis.fetch=async(url,opt={})=>{calls.push({url,body:opt.body&&JSON.parse(opt.body)});return {ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf',user:{name:'刘道志'},project:{repository:'ssal-team/XiAN-OA',branch:'dev'},oaDeploymentAvailable:true,githubAdministrator:true,...settings}:url.endsWith('/update-check')?{available:false}:url.endsWith('/github-config-read')?{config:{repository:'ssal-team/XiAN-OA',branch:'dev',updateRepository:'liudaozhi01/dsh-simple-github',cloneMode:'single',cloneBranch:'dev'},revision:'r1'}:url.endsWith('/docker-overview')?{jobs:[{jobId:'old',environment:'dev',status:'delivered',head:'a'.repeat(40)}],releaseId:'dev1'}:url.endsWith('/docker-plan')||url.endsWith('/docker-promote')||url.endsWith('/docker-restore')?{planId:'p1',head:'a'.repeat(40)}:{}};};
 const root=new Element('root'),node=label=>{const n=all(root).find(n=>n.textContent===label);assert.ok(n,'missing '+label);return n;};
 const click=async label=>{node(label).onclick();await tick();await tick();};
 try{dispose=mount(root,{getSessionId:()=> 'session1'});await tick();await tick();await exercise({root,node,click,calls});}finally{dispose?.();Object.assign(globalThis,old);}
}
test('deployment backend settings and initialization are absent even for administrators; GitHub settings remain',()=>fixture({},async({root,node,click,calls})=>{
 await click('设置');node('GitHub 管理后台');await click('读取包内配置');node('克隆范围');node('保存包内配置');
 for(const label of ['Docker 部署管理','读取部署配置','读取部署主机','保存部署配置','请 AI 核对部署初始化'])assert.ok(!all(root).some(n=>n.textContent===label),label);
 assert.ok(!calls.some(c=>/\/deployment-/.test(c.url)));
}));
test('OA dev/test/restore retain existing plan routes and require confirmation before execution',()=>fixture({},async({root,node,click,calls})=>{
 await click('远程部署');node('发布 dev');node('发布 test');node('恢复到此版本');
 await click('发布 dev');await click('发布 test');await click('恢复到此版本');
 for(const route of ['/docker-plan','/docker-promote','/docker-restore'])assert.ok(calls.some(c=>c.url.endsWith(route)),route);
 assert.ok(!calls.some(c=>c.url.endsWith('/docker-start')));
 assert.ok(all(root).some(n=>n.href==='http://119.45.50.213:18081/'));
 assert.ok(!calls.some(c=>/\/deployment-/.test(c.url)));
}));
test('foreign projects cannot enable OA deployment through obsolete generic status fields',()=>fixture({oaDeploymentAvailable:false,deployment:{mode:'docker',available:true},deploymentAvailable:true,deploymentPrivilegedNames:['刘道志']},async({root,click,calls})=>{
 await click('设置');assert.ok(!all(root).some(n=>['远程部署','发布 dev','发布 test','恢复到此版本','检测开发环境'].includes(n.textContent)));
 assert.ok(!calls.some(c=>/\/deployment-|\/docker-|\/environment-/.test(c.url)));
}));
test('obsolete disabled status does not hide OA; only fixed OA names manage test and restore',async()=>{
 await fixture({deployment:{mode:'disabled'},deploymentAvailable:false},async({node,click})=>{await click('远程部署');node('发布 test');node('恢复到此版本');});
 await fixture({user:{name:'普通成员'},deploymentPrivilegedNames:['普通成员']},async({root,node,click})=>{await click('远程部署');node('发布 dev');assert.ok(!all(root).some(n=>['发布 test','恢复到此版本'].includes(n.textContent)));});
 await fixture({user:{name:'於天晨'}},async({node,click})=>{await click('远程部署');node('发布 test');node('恢复到此版本');});
});
