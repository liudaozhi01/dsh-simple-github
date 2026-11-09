import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './panel.js';
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.textContent='';this.value='';this.attributes={};this.style={};}
 append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;}
 scrollIntoView(){this.scrolled=true;} focus(){this.focused=true;}
 setAttribute(k,v){this.attributes[k]=v;} contains(n){return n===this||this.children.some(c=>c.contains(n));}
 querySelectorAll(tag){return this.children.flatMap(c=>[...(c.tagName===tag?[c]:[]),...c.querySelectorAll(tag)]);}
}
const all=n=>[n,...n.children.flatMap(all)];
const tick=()=>new Promise(r=>setImmediate(r));
const find=(root,label)=>{const node=all(root).find(n=>n.textContent===label);assert.ok(node,label);return node;};
test('history preview cancellation, pinned pagination, explicit overwrite and partial results',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm};
 const calls=[],head='a'.repeat(40),target='b'.repeat(40);let dispose,confirmed=false,partial=false,disconnected=false,previewFailure=false;
 const repo={directory:'/fixture',branch:'dev',repository:'owner/repo',baseBranch:'main',head,fingerprint:'snap',changes:[{path:'source.js',status:' M'}]};
 globalThis.document={createElement:t=>new Element(t)};globalThis.confirm=()=>confirmed;
 globalThis.fetch=async(url,opts={})=>{const body=opts.body&&JSON.parse(opts.body);calls.push({url,body,headers:opts.headers});let data={};
 if(url.endsWith('/status'))data={user:{login:'alice',name:'刘道志'},csrfToken:'csrf'};
 if(url.endsWith('/inspect'))data=repo;
 if(url.endsWith('/source-history'))data={remoteHead:head,page:body.page,hasMore:body.page===1,commits:[{sha:target,subject:'<script>not html</script>',author:'Tester',date:'2026-11-06'}]};
 if(url.endsWith('/source-restore-preview')&&previewFailure)throw new Error('旧预览错误');
 if(url.endsWith('/source-restore-preview'))data={previewId:'preview',target,remoteHead:head,repository:'owner/repo',branch:'dev',changes:[{path:'source.js',status:'M'}],localOverwriteChanges:[{path:'local-only.js',status:'D'}],localChanges:repo.changes};
 if(url.endsWith('/source-restore')&&disconnected)throw new Error('connection lost');
 if(url.endsWith('/source-restore'))data=partial?{ok:false,needsAction:true,remoteUpdated:true,localUpdated:false,head:'c'.repeat(40),message:'本地并发变化'}:{ok:true,remoteUpdated:true,localUpdated:true,head:'c'.repeat(40)};
 return {ok:true,json:async()=>data};};
 try{
  const root=new Element('root');dispose=mount(root);await tick();const dir=all(root).find(n=>n.sgDraftKey==='project-directory');dir.value='/fixture';dir.onkeydown({key:'Enter',preventDefault(){}});await tick();
  assert.ok(!calls.some(c=>c.url.endsWith('/source-history')));
  find(root,'版本恢复').onclick();await tick();const sourceSection=all(root).find(n=>n.tagName==='section'&&n.children.some(c=>c.textContent==='历史源码恢复'));assert.equal(sourceSection.attributes['data-view'],'recovery');assert.equal(sourceSection.hidden,false);
  find(root,'代码同步').onclick();assert.equal(all(root).find(n=>n.tagName==='section'&&n.children.some(c=>c.textContent==='历史源码恢复')).hidden,true);find(root,'版本恢复').onclick();
  find(root,'读取历史提交').onclick();await tick();assert.ok(all(root).some(n=>n.textContent==='<script>not html</script>'));
  const historyList=all(root).find(n=>n.sgDisclosureKey==='source-history-list');assert.equal(historyList.open,true);historyList.open=false;historyList.ontoggle();find(root,'代码同步').onclick();find(root,'版本恢复').onclick();assert.equal(all(root).find(n=>n.sgDisclosureKey==='source-history-list').open,false);all(root).find(n=>n.sgDisclosureKey==='source-history-list').open=true;all(root).find(n=>n.sgDisclosureKey==='source-history-list').ontoggle();
  find(root,'下一页').onclick();await tick();assert.equal(calls.filter(c=>c.url.endsWith('/source-history')).at(-1).body.remoteHead,head);
  previewFailure=true;find(root,'选择并预览恢复').onclick();await tick();assert.ok(all(root).some(n=>n.textContent.includes('旧预览错误')));
  previewFailure=false;find(root,'选择并预览恢复').onclick();assert.ok(!all(root).some(n=>n.textContent.includes('旧预览错误')));await tick();const anchor=find(root,'恢复目标：'+target);assert.equal(anchor.scrolled,true);assert.equal(anchor.focused,true);assert.ok(all(root).indexOf(find(root,'确认恢复并覆盖本地'))<all(root).indexOf(find(root,'<script>not html</script>')));assert.ok(all(root).some(n=>n.textContent.includes('恢复预览已生成')));const preview=calls.find(c=>c.url.endsWith('/source-restore-preview'));assert.equal(preview.body.expectedFingerprint,'snap');assert.equal(preview.body.target,target);find(root,'本地受管文件覆盖清单（1 项）');find(root,'D  local-only.js');
  find(root,'确认恢复并覆盖本地').onclick();await tick();assert.ok(!calls.some(c=>c.url.endsWith('/source-restore')));
  find(root,'取消恢复').onclick();await tick();assert.ok(!all(root).some(n=>n.textContent==='确认恢复并覆盖本地'));
  find(root,'选择并预览恢复').onclick();await tick();confirmed=true;find(root,'确认恢复并覆盖本地').onclick();await tick();
  const execution=calls.find(c=>c.url.endsWith('/source-restore'));assert.deepEqual(execution.body,{directory:'/fixture',previewId:'preview',confirmedOverwrite:true});assert.equal(execution.headers['X-Simple-Git-Token'],'csrf');
  assert.ok(all(root).some(n=>n.textContent.includes('远程 dev 与本地受管源码已恢复')));
  partial=true;find(root,'读取历史提交').onclick();await tick();find(root,'选择并预览恢复').onclick();await tick();find(root,'确认恢复并覆盖本地').onclick();await tick();
  assert.ok(all(root).some(n=>n.textContent.includes('本地并发变化')));assert.ok(!all(root).some(n=>n.textContent.includes('✓ 远程 dev 与本地受管源码已恢复')));
  disconnected=true;find(root,'读取历史提交').onclick();await tick();find(root,'选择并预览恢复').onclick();await tick();find(root,'确认恢复并覆盖本地').onclick();await tick();
  assert.ok(all(root).some(n=>n.textContent.includes('恢复结果未确认：connection lost')));assert.ok(!all(root).some(n=>n.textContent==='确认恢复并覆盖本地'));
  assert.ok(!calls.some(c=>/\/(push|sync-dev|docker-start)$/.test(c.url)));
 }finally{dispose?.();Object.assign(globalThis,old);}
});
