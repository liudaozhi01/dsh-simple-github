import test from 'node:test';
import assert from 'node:assert/strict';
import {mount} from './panel.js';

// Same minimal DOM contract as remote-release-ui.test.mjs; no browser or server.
class Element {
  constructor(tag) { this.tagName=tag; this.children=[]; this.attributes={}; this.style={}; this.textContent=''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children=nodes; }
  setAttribute(key,value) { this.attributes[key]=value; }
  contains(node) { return node===this||this.children.some(child=>child.contains(node)); }
  querySelectorAll() { return []; }
}
const all=node=>[node,...node.children.flatMap(all)];
const flush=async()=>{ for(let i=0;i<4;i++) await new Promise(resolve=>setImmediate(resolve)); };
function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

async function fixture(exercise) {
  const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm,
    setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
  const oldNow=Date.now,oldSignalTimeout=AbortSignal.timeout;
  const calls=[],timers=new Map(),start=deferred();
  const startedAt=1900000000000;
  let now=startedAt,nextTimer=0,dispose,progress=null,progressError=false,progressRequest=null;
  const root=new Element('root');
  const response=value=>({ok:true,json:async()=>value});
  const result={jobId:'new-job',environment:'dev',status:'running',stage:'building',head:'a'.repeat(40)};
  Date.now=()=>now;
  // Avoid real timeout handles, including the optional final snapshot's abort timer.
  AbortSignal.timeout=()=>new AbortController().signal;
  globalThis.document={createElement:tag=>new Element(tag)};
  globalThis.confirm=()=>true;
  globalThis.setTimeout=(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms,at:now+ms});return id;};
  globalThis.clearTimeout=id=>timers.delete(id);
  globalThis.fetch=async(url,options={})=>{
    calls.push({url,method:options.method||'GET',body:options.body&&JSON.parse(options.body)});
    if(url.endsWith('/docker-start')) return response(await start.promise);
    if(url.endsWith('/docker-progress')) {
      if(progressRequest) return response(await progressRequest.promise);
      if(progressError) throw new Error('progress connection lost');
      return response({progress});
    }
    if(url.endsWith('/status')) return response({csrfToken:'csrf',user:{name:'刘道志',login:'fixture'}});
    if(url.endsWith('/update-check')) return response({available:false});
    if(url.endsWith('/docker-overview')) return response({jobs:[],releaseId:null});
    if(url.endsWith('/docker-plan')) return response({planId:'plan1',head:'a'.repeat(40)});
    throw new Error('Unexpected fixture request: '+url);
  };
  const node=label=>{const found=all(root).find(n=>n.textContent===label);assert.ok(found,'missing '+label);return found;};
  const click=async label=>{node(label).onclick();await flush();};
  const text=()=>all(root).map(n=>n.textContent).join('\n');
  const count=path=>calls.filter(call=>call.url.endsWith(path)).length;
  const advance=async ms=>{
    const target=now+ms;
    for(;;) {
      const entry=[...timers].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!entry) break;
      const [id,timer]=entry;timers.delete(id);now=timer.at;timer.fn();await flush();
    }
    now=target;await flush();
  };
  const stop=()=>{dispose?.();dispose=null;};
  try {
    dispose=mount(root);await flush();await click('远程部署');
    await exercise({root,node,click,text,calls,count,timers,advance,startedAt,result,start,stop,
      setProgress:value=>progress=value,setProgressError:value=>progressError=value,
      setProgressRequest:value=>progressRequest=value});
  } finally {
    stop();
    const remaining=timers.size;
    Object.assign(globalThis,old);Date.now=oldNow;AbortSignal.timeout=oldSignalTimeout;
    assert.equal(remaining,0,'dispose must clear all panel timers');
  }
}

function assertIndeterminate(root) {
  const progress=all(root).filter(node=>node.tagName==='progress');
  assert.ok(progress.length,'preparation should show progress');
  for(const node of progress) {
    assert.equal(Object.hasOwn(node,'value'),false,'preparation must not invent a percentage');
    assert.equal(Object.hasOwn(node.attributes,'value'),false);
  }
  assert.ok(!all(root).some(node=>/10\s*%/.test(node.textContent)),'no synthetic 10% while waiting');
}

test('deferred start polls download/upload names, elapsed time and completed stage timings without fake percentage',()=>fixture(async f=>{
  await f.click('发布 dev');
  assert.equal(f.count('/docker-start'),1);
  assert.equal(f.node('发布 dev').disabled,true);
  assertIndeterminate(f.root);
  f.setProgress({state:'running',startedAt:f.startedAt,stage:'source-downloading',stageElapsedMs:2300,
    bytes:2.5*1048576,completedStages:[{stage:'preflight',durationMs:1200},{stage:'source-resolving',durationMs:400}]});
  await f.advance(300);
  assert.match(f.text(),/从 GitHub 下载源码/);
  assert.match(f.text(),/提交前准备已用 0\.3 秒 · 当前步骤 2\.3 秒/);
  assert.match(f.text(),/服务器发布前检查：1\.2 秒/);
  assert.match(f.text(),/核对远程版本：0\.4 秒/);
  assert.match(f.text(),/已下载 2\.5 MiB/);
  assertIndeterminate(f.root);
  f.setProgress({state:'running',startedAt:f.startedAt,stage:'uploading',stageElapsedMs:800,
    completedStages:[{stage:'source-downloading',durationMs:3400},{stage:'source-hashing',durationMs:600}]});
  await f.advance(1000);
  assert.match(f.text(),/上传源码到服务器/);
  assert.match(f.text(),/提交前准备已用 1\.3 秒 · 当前步骤 0\.8 秒/);
  assert.match(f.text(),/从 GitHub 下载源码：3\.4 秒/);
  assert.match(f.text(),/校验源码完整性：0\.6 秒/);
  assert.doesNotMatch(f.text(),/已下载 2\.5 MiB/);
  assertIndeterminate(f.root);
  assert.ok(f.calls.filter(c=>c.url.endsWith('/docker-progress')).every(c=>c.method==='GET'&&!c.body));
  await f.click('发布 dev');
  assert.equal(f.count('/docker-start'),1,'polling and repeated clicks never resubmit');
}));

test('stale startedAt is ignored during polling and in the final snapshot',()=>fixture(async f=>{
  f.setProgress({state:'running',startedAt:f.startedAt-60000,stage:'uploading',stageElapsedMs:99000,
    completedStages:[{stage:'preflight',durationMs:99000}]});
  await f.click('发布 dev');await f.advance(300);
  assert.match(f.text(),/正在准备发布（不在本机编译）/);
  assert.doesNotMatch(f.text(),/上传源码到服务器|99\.0 秒|查看提交前各步骤耗时/);
  f.setProgress({state:'completed',startedAt:f.startedAt-60000,elapsedMs:99000,
    completedStages:[{stage:'uploading',durationMs:99000}]});
  f.start.resolve(f.result);await flush();
  assert.doesNotMatch(f.text(),/本次提交前准备耗时|99\.0 秒|查看提交前各步骤耗时/);
}));

test('progress GET failure is nonfatal, retried read-only, and never duplicates the pending start',()=>fixture(async f=>{
  f.setProgressError(true);await f.click('发布 dev');await f.advance(300);
  assert.match(f.text(),/暂时无法读取分步进度，发布请求仍在等待；不会自动重新提交/);
  assert.equal(f.node('发布 dev').disabled,true);
  await f.click('发布 dev');await f.advance(1000);
  assert.equal(f.count('/docker-start'),1);
  assert.equal(f.count('/docker-progress'),2);
  assert.doesNotMatch(f.text(),/提交响应未确认|发布未启动/);
  f.setProgressError(false);
  f.setProgress({state:'running',startedAt:f.startedAt,stage:'uploading',stageElapsedMs:200,completedStages:[]});
  await f.advance(1000);
  assert.match(f.text(),/上传源码到服务器/);
  assert.doesNotMatch(f.text(),/暂时无法读取分步进度/);
  // Even the optional final timing GET may fail without changing successful POST handling.
  f.setProgressError(true);f.start.resolve(f.result);await flush();
  assert.doesNotMatch(f.text(),/提交响应未确认|发布未启动|禁止重复发布/);
  assert.match(f.text(),/服务器记录：服务器编译/);
  assert.equal(f.count('/docker-start'),1);
  assert.ok(![...f.timers.values()].some(timer=>[300,1000].includes(timer.ms)));
}));

test('start response stops preparation timers and reads completed final stage timings once',()=>fixture(async f=>{
  f.setProgress({state:'running',startedAt:f.startedAt,stage:'uploading',stageElapsedMs:300,completedStages:[]});
  await f.click('发布 dev');await f.advance(300);
  f.setProgress({state:'completed',startedAt:f.startedAt,elapsedMs:4200,
    completedStages:[{stage:'uploading',durationMs:2100},{stage:'cleanup',durationMs:400}]});
  f.start.resolve(f.result);await flush();
  assert.match(f.text(),/本次提交前准备耗时 4\.2 秒/);
  assert.match(f.text(),/上传源码到服务器：2\.1 秒/);
  assert.match(f.text(),/清理本地临时源码：0\.4 秒/);
  assert.doesNotMatch(f.text(),/提交前准备已用/);
  assert.equal(f.count('/docker-progress'),2,'one poll plus one final read');
  assert.ok(![...f.timers.values()].some(timer=>[300,1000].includes(timer.ms)));
  await f.advance(1000);
  assert.equal(f.count('/docker-progress'),2,'no preparation GET after start response');
}));

test('dispose cancels scheduled preparation polling while start is still deferred',()=>fixture(async f=>{
  await f.click('发布 dev');assert.ok([...f.timers.values()].some(timer=>timer.ms===300));
  f.stop();assert.equal(f.timers.size,0);
  await f.advance(5000);assert.equal(f.count('/docker-progress'),0);
  f.start.resolve(f.result);await flush();
  assert.equal(f.root.children.length,0);
  assert.equal(f.timers.size,0,'late start response must not restart either poller');
}));

test('dispose ignores an in-flight preparation GET and never schedules another timer',()=>fixture(async f=>{
  const pending=deferred();f.setProgressRequest(pending);
  await f.click('发布 dev');await f.advance(300);
  assert.equal(f.count('/docker-progress'),1);
  f.stop();
  pending.resolve({progress:{state:'running',startedAt:f.startedAt,stage:'uploading',completedStages:[]}});
  await flush();assert.equal(f.timers.size,0);assert.equal(f.root.children.length,0);
  f.setProgressRequest(null);f.start.resolve(f.result);await flush();
  assert.equal(f.timers.size,0);assert.equal(f.root.children.length,0);
}));
