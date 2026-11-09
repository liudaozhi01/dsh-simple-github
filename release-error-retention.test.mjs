import test from 'node:test';
import assert from 'node:assert/strict';
import {mount} from './panel.js';

class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.style={};this.textContent='';}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=nodes;}
 setAttribute(key,value){this.attributes[key]=value;}
 contains(node){return this===node||this.children.some(child=>child.contains(node));}
 querySelectorAll(){return [];}
}
const all=node=>[node,...node.children.flatMap(all)];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const originalError='source upload failed: retained submission detail';
const oldJob={jobId:'old1',environment:'dev',head:'a'.repeat(40),createdAt:1,status:'delivered'};

async function fixture({history=true,initialJobs},exercise){
 const keys=['document','fetch','confirm','setTimeout','clearTimeout','navigator'];
 const saved=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const calls=[],timers=new Map(),copies=[];let next=0,dispose;
 let jobs=initialJobs??(history?[oldJob]:[]),overviewError=false,reconciled=null;
 globalThis.document={createElement:tag=>new Element(tag)};
 globalThis.confirm=()=>true;
 globalThis.setTimeout=(fn,ms)=>{timers.set(++next,{fn,ms});return next;};
 globalThis.clearTimeout=id=>timers.delete(id);
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async text=>copies.push(text)}}});
 globalThis.fetch=async(url,options={})=>{
  const body=options.body&&JSON.parse(options.body);calls.push({url,body});
  if(url.endsWith('/docker-start'))throw Error(originalError);
  if(url.endsWith('/docker-overview')&&overviewError)throw Error('overview disconnected');
  const data=url.endsWith('/status')?{csrfToken:'csrf',user:{name:'刘道志'}}:
   url.endsWith('/update-check')?{available:false}:
   url.endsWith('/docker-overview')?{jobs,releaseId:'dev1'}:
   url.endsWith('/docker-reconcile')?reconciled:{planId:'plan1',head:'b'.repeat(40)};
  return {ok:true,json:async()=>data};
 };
 const root=new Element('root');
 const node=label=>{const result=all(root).find(node=>node.textContent===label);assert.ok(result,'missing '+label);return result;};
 const click=async label=>{node(label).onclick();await tick();await tick();};
 const warning=()=>all(root).filter(node=>node.className==='sg-warning').map(node=>node.textContent).join('\n');
 const diagnostics=()=>JSON.parse(all(root).find(node=>node.tagName==='pre'&&node.textContent.includes('submissionError')).textContent);
 try{
  dispose=mount(root);await tick();await tick();await click('远程部署');
  await exercise({root,node,click,calls,copies,warning,diagnostics,
   setJobs:value=>jobs=value,setOverviewError:value=>overviewError=value,setReconciled:value=>reconciled=value,
   async poll(){const entry=[...timers.entries()].find(([,timer])=>timer.ms===3000);assert.ok(entry,'poll scheduled');timers.delete(entry[0]);await entry[1].fn();await tick();}
  });
 }finally{
  dispose?.();assert.equal(timers.size,0);
  for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
 }
}

for(const action of ['发布 dev','发布 test','恢复到此版本']){
 test(action+' preserves original error through automatic/manual refresh and copied diagnostics',()=>fixture({},async({node,click,calls,copies,warning,diagnostics,poll,setOverviewError})=>{
  await click(action);assert.match(warning(),new RegExp(originalError));
  for(let attempt=0;attempt<2;attempt++){
   await poll();assert.match(warning(),/提交结果仍未确认，请勿重复发布。尚未找到本次新任务，请联系管理员核对。/);
   assert.match(warning(),new RegExp(originalError));assert.equal(diagnostics().submissionError,originalError);
   assert.equal(diagnostics().jobId,'old1');assert.equal(diagnostics().submissionUncertain,true);
  }
  setOverviewError(true);await click('重新核对状态');
  assert.match(warning(),/overview disconnected/);assert.match(warning(),new RegExp(originalError));
  setOverviewError(false);await click('重新核对状态');assert.match(warning(),new RegExp(originalError));
  for(const label of ['发布 dev','发布 test','恢复到此版本']){assert.equal(node(label).disabled,true);await click(label);}
  await click('复制排查信息');assert.equal(JSON.parse(copies.at(-1)).submissionError,originalError);
  assert.equal(calls.filter(call=>call.url.endsWith('/docker-start')).length,1);
  assert.ok(!calls.some(call=>call.url.endsWith('/docker-reconcile')));
 }));
}

test('first publish with no historical job still exposes retained diagnostics',()=>fixture({history:false},async({click,warning,diagnostics,poll,copies})=>{
 await click('发布 dev');assert.equal(diagnostics().submissionError,originalError);
 await poll();assert.match(warning(),new RegExp(originalError));assert.equal(diagnostics().priorJobId,null);
 await click('复制排查信息');assert.equal(JSON.parse(copies.at(-1)).submissionError,originalError);
}));

for(const [activity,label] of [[{state:'active'},'张三正在发布 · 服务器编译'],[{state:'interrupted'},'上次发布已中断，待核对'],[{state:'unknown'},'服务器记录：服务器编译'],[undefined,'服务器记录：服务器编译']]){
 test('release activity label '+(activity?.state||'legacy'),()=>fixture({initialJobs:[{...oldJob,status:'running',stage:'building',actor:'张三',activity}]},async({root,node,calls})=>{
  assert.ok(all(root).some(n=>n.textContent==='dev · '+label));assert.equal(node('发布 dev').disabled,true);
  if(activity?.state!=='active')assert.ok(!all(root).some(n=>n.textContent==='发布阶段'));
   if(activity?.state==='unknown')assert.ok(all(root).some(n=>n.textContent.includes('进程活动暂时无法确认')));
   if(!activity)assert.ok(all(root).some(n=>n.textContent.includes('当前服务器暂不支持进程活动核验')));
  assert.ok(!calls.some(c=>c.url.endsWith('/docker-start')));
 }));
}

for(const status of ['uncertain','running','delivered','failed']){
 test('matching '+status+' reconciliation '+(['delivered','failed'].includes(status)?'resolves':'retains')+' submission uncertainty',()=>fixture({},async({root,node,click,calls,warning,diagnostics,poll,setJobs,setReconciled})=>{
  await click('发布 dev');
  const job={jobId:'new1',environment:'dev',createdAt:Math.floor(Date.now()/1000)+1,status,stage:status==='failed'?'building':'checking',errorSummary:status==='failed'?'authoritative build failure':undefined};
  setJobs([job,oldJob]);setReconciled(job);await poll();
  assert.ok(calls.some(call=>call.url.endsWith('/docker-reconcile')&&call.body.jobId==='new1'));
  if(['delivered','failed'].includes(status)){
   assert.equal(node('发布 dev').disabled,false);assert.doesNotMatch(warning(),new RegExp(originalError));
   assert.ok(!all(root).some(node=>node.tagName==='pre'&&node.textContent.includes('submissionError')));
   if(status==='failed')assert.match(warning(),/authoritative build failure/);
  }else{
   assert.equal(node('发布 dev').disabled,true);assert.equal(diagnostics().submissionError,originalError);
   await click('发布 dev');assert.match(warning(),new RegExp(originalError));
  }
  assert.equal(calls.filter(call=>call.url.endsWith('/docker-start')).length,1);
 }));
}
