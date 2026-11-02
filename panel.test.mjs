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
test('host status selects Windows guidance and path examples without losing drafts on refresh',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch};let dispose,finishStatus,platform='win32';
 globalThis.document={createElement:tag=>new Element(tag)};
 const firstStatus=new Promise(resolve=>{finishStatus=resolve;});let first=true;
 globalThis.fetch=async()=>{if(first){first=false;await firstStatus;}return {ok:true,json:async()=>({csrfToken:'csrf',ghAvailable:false,environment:{platform,label:platform==='win32'?'Windows':'macOS',isWindows:platform==='win32'}})};};
 try{const root=new Element('root');dispose=mount(root);
 const draft=find(root,n=>n.placeholder?.startsWith('项目文件夹'));draft.value='C:\\work\\我的项目';draft.oninput();
 const parent=find(root,n=>n.placeholder?.startsWith('保存到'));parent.value='D:\\团队项目';parent.oninput();
 finishStatus();await tick();
 assert.ok(all(root).some(n=>n.textContent.includes('DSH 宿主系统：Windows')));
 assert.ok(all(root).some(n=>n.textContent.includes('winget install --id GitHub.cli --exact')));
 assert.ok(!all(root).some(n=>n.textContent.includes('brew install gh')));
 assert.ok(all(root).some(n=>n.textContent.includes('完全退出并重新启动 DSH')));
 assert.ok(find(root,n=>n.placeholder?.startsWith('项目文件夹')).placeholder.includes('C:\\Users\\'));
 assert.equal(find(root,n=>n.placeholder?.startsWith('项目文件夹')).value,'C:\\work\\我的项目');
 assert.equal(find(root,n=>n.placeholder?.startsWith('保存到')).value,'D:\\团队项目');
 platform='darwin';find(root,n=>n.textContent==='检查登录状态').onclick();await tick();
 assert.ok(all(root).some(n=>n.textContent.includes('DSH 宿主系统：macOS')));
 assert.ok(all(root).some(n=>n.textContent.includes('brew install gh')));
 assert.ok(!all(root).some(n=>n.textContent.includes('winget install')));
 assert.ok(find(root,n=>n.placeholder?.startsWith('项目文件夹')).placeholder.includes('/Users/'));
 assert.equal(find(root,n=>n.placeholder?.startsWith('项目文件夹')).value,'C:\\work\\我的项目');
 assert.equal(find(root,n=>n.placeholder?.startsWith('保存到')).value,'D:\\团队项目');
 }finally{dispose?.();Object.assign(globalThis,old);}
});
test('unknown host does not guess browser OS or recommend macOS-only installation',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch};let dispose;
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.fetch=async()=>({ok:true,json:async()=>({ghAvailable:false})});
 try{const root=new Element('root');dispose=mount(root);await tick();assert.ok(all(root).some(n=>n.textContent.includes('DSH 宿主系统：尚未检测')));assert.ok(!all(root).some(n=>n.textContent.includes('brew install')||n.textContent.includes('winget install')));}finally{dispose?.();Object.assign(globalThis,old);}
});
test('project picker opens automatically; cancellation and clone-parent selection never open',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch};let dispose,cancelled=false;const calls=[];
 globalThis.document={createElement:tag=>new Element(tag)};
 globalThis.fetch=async(url,opts={})=>{calls.push({url,body:opts.body&&JSON.parse(opts.body)});return {ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf'}:url.endsWith('/choose-directory')?{cancelled,directory:'/chosen'}:{directory:'/chosen',branch:'dev',changes:[]}};};
 try{const root=new Element('root');dispose=mount(root);await tick();assert.ok(!all(root).some(n=>n.textContent==='打开项目'));const pick=()=>all(root).filter(n=>n.textContent==='选择目录');
 cancelled=true;pick()[0].onclick();await tick();assert.equal(calls.filter(c=>c.url.endsWith('/inspect')).length,0);
 cancelled=false;pick()[0].onclick();await tick();assert.deepEqual(calls.find(c=>c.url.endsWith('/inspect')).body,{directory:'/chosen'});assert.ok(all(root).some(n=>n.textContent==='项目已打开。'));
 pick()[1].onclick();await tick();assert.equal(calls.filter(c=>c.url.endsWith('/inspect')).length,1);assert.ok(!calls.some(c=>c.url.endsWith('/clone')));assert.equal(find(root,n=>n.placeholder?.startsWith('保存到')).value,'/chosen');
 }finally{dispose?.();Object.assign(globalThis,old);}
});
test('panel preserves drafts on actions, escapes filenames, binds push to inspected state',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm};
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.confirm=()=>true;
 let finishPush;const pushGate=new Promise(resolve=>{finishPush=resolve;});
  const calls=[];const repo={directory:'/fixture/repo',branch:'dev',baseBranch:'main',repository:'owner/repo',head:'abc',fingerprint:'snapshot',changes:[{path:'<img onerror=alert(1)>',status:'M'}]};
 globalThis.fetch=async(url,options={})=>{calls.push({url,options});if(url.endsWith('/push'))await pushGate;let data={ok:true};if(url.endsWith('/status'))data={...data,csrfToken:'csrf',user:{login:'alice'},ghAvailable:true};if(url.endsWith('/inspect'))data={...data,...repo};if(url.endsWith('/diff'))data={...data,diff:'safe diff'};return {ok:true,json:async()=>data};};
 try{
  const root=new Element('root');const dispose=mount(root);await tick();
  const dir=find(root,n=>n.placeholder?.startsWith('项目文件夹'));dir.value='/fixture/repo';find(root,n=>n.placeholder?.startsWith('项目文件夹')).onkeydown({key:'Enter',preventDefault(){}});await tick();
  assert.equal(find(root,n=>n.tagName==='li').textContent,'M  <img onerror=alert(1)>');
   const labels=all(root).filter(n=>n.tagName==='button').map(n=>n.textContent);
   for(const removed of ['创建分支','开始新任务','拉取更新','切回主分支','合并 PR','刷新任务状态','保存本地提交（不推送）','运行构建与后端测试','确认页面自测通过'])assert.ok(!labels.includes(removed));
   for(const kept of ['提交并推送到 dev','从 dev 拉取','刷新改动','查看差异'])assert.ok(labels.includes(kept));
   assert.ok(!all(root).some(n=>n.placeholder?.startsWith('PR 标题')));
  const msg=find(root,n=>n.placeholder?.startsWith('提交说明'));msg.value='draft survives';msg.oninput();
  find(root,n=>n.textContent==='查看差异').onclick();await tick();assert.equal(find(root,n=>n.placeholder?.startsWith('提交说明')).value,'draft survives');
  find(root,n=>n.textContent==='提交并推送到 dev').onclick();await tick();const push=calls.find(c=>c.url.endsWith('/push'));assert.equal(push.options.headers['X-Simple-Git-Token'],'csrf');assert.deepEqual(JSON.parse(push.options.body),{directory:'/fixture/repo',message:'draft survives',confirmedSelfTest:true,expectedHead:'abc',expectedFingerprint:'snapshot',expectedBranch:'dev',expectedRepository:'owner/repo',expectedBaseBranch:'main'});
  assert.ok(find(root,n=>n.textContent==='正在提交…').disabled);
   assert.ok(find(root,n=>n.tagName==='progress'));
   assert.ok(all(root).some(n=>n.textContent.includes('正在提交、获取远程 dev')));
    assert.ok(!all(root).some(n=>n.textContent.includes('正在执行推送前构建')));
    find(root,n=>n.textContent==='正在提交…').onclick();await tick();assert.equal(calls.filter(c=>c.url.endsWith('/push')).length,1);
   finishPush();await tick();assert.ok(find(root,n=>n.textContent==='✓ 已成功推送到共用 dev。'));
   assert.ok(!all(root).some(n=>n.tagName==='progress'));
   dispose();assert.equal(root.children.length,0);
 }finally{Object.assign(globalThis,old);}
});
test('shared dev switch preserves old tasks and push integration requires retesting',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm};let dispose,mode='review';
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.confirm=()=>true;
 const repo={directory:'/fixture',branch:'task/alice/old',baseBranch:'main',repository:'owner/repo',head:'abc',fingerprint:'snap',changes:[]},calls=[];
 globalThis.fetch=async(url,options={})=>{calls.push({url,body:options.body&&JSON.parse(options.body)});let data={ok:true};if(url.endsWith('/status'))data={user:{login:'alice'},csrfToken:'csrf'};if(url.endsWith('/inspect'))data={...repo};if(url.endsWith('/switch-dev'))repo.branch='dev';if(url.endsWith('/push'))data=mode==='review'?{needsReview:true}:mode==='conflict'?{conflict:true,files:['shared.js']}:{ok:true};return {ok:true,json:async()=>data};};
 try{const root=new Element('root');dispose=mount(root);await tick();find(root,n=>n.placeholder?.startsWith('项目文件夹')).value='/fixture';find(root,n=>n.placeholder?.startsWith('项目文件夹')).onkeydown({key:'Enter',preventDefault(){}});await tick();assert.equal(find(root,n=>n.textContent==='提交并推送到 dev').disabled,true);assert.ok(all(root).some(n=>n.textContent.includes('旧分支会保留')));
 find(root,n=>n.textContent==='切换到 dev').onclick();await tick();assert.equal(calls.find(c=>c.url.endsWith('/switch-dev')).body.expectedBranch,'task/alice/old');assert.ok(!calls.some(c=>c.url.includes('/task-')));
 const msg=find(root,n=>n.placeholder?.startsWith('提交说明'));msg.value='save';msg.oninput();for(const outcome of ['review','conflict','success']){mode=outcome;find(root,n=>n.textContent==='提交并推送到 dev').onclick();await tick();const needle=outcome==='review'?'尚未推送':outcome==='conflict'?'shared.js':'✓ 已成功推送到共用 dev';assert.ok(all(root).some(n=>n.textContent.includes(needle)));}
 assert.ok(!all(root).some(n=>n.tagName==='button'&&n.textContent==='保存本地提交（不推送）'));assert.ok(!calls.some(c=>c.url.endsWith('/commit-local')));
 }finally{dispose?.();Object.assign(globalThis,old);}
});
test('dev pull shows loading, blocks duplicates and reports success, conflict and failure',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm};let finish,mode='success',count=0,dispose;
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.confirm=()=>true;
 const repo={directory:'/fixture',branch:'dev',baseBranch:'main',repository:'owner/repo',head:'abc',fingerprint:'snapshot',changes:[]};
 globalThis.fetch=async(url)=>{if(url.endsWith('/sync-dev')){count++;await new Promise(resolve=>{finish=resolve;});return {ok:mode!=='failure',json:async()=>mode==='failure'?{error:'network unavailable'}:mode==='conflict'?{conflict:true,files:['shared.js']}:{conflict:false}};}return {ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf',user:{login:'alice'}}:repo};};
 try{const root=new Element('root');dispose=mount(root);await tick();const dir=find(root,n=>n.placeholder?.startsWith('项目文件夹'));dir.value='/fixture';find(root,n=>n.placeholder?.startsWith('项目文件夹')).onkeydown({key:'Enter',preventDefault(){}});await tick();
 for(const outcome of ['success','conflict','failure']){mode=outcome;const before=count;find(root,n=>n.textContent==='从 dev 拉取').onclick();await tick();assert.ok(find(root,n=>n.textContent==='正在从 dev 拉取…').disabled);assert.ok(find(root,n=>n.tagName==='progress'));find(root,n=>n.textContent==='正在从 dev 拉取…').onclick();await tick();assert.equal(count,before+1);finish();await tick();assert.ok(!all(root).some(n=>n.tagName==='progress'));assert.equal(find(root,n=>n.textContent==='从 dev 拉取').disabled,false);assert.ok(all(root).some(n=>n.textContent.includes(outcome==='success'?'✓ 已从 dev 安全整合最新代码':outcome==='conflict'?'shared.js':'network unavailable')));}
 }finally{dispose?.();Object.assign(globalThis,old);}
});
test('dirty pull notifies only fresh isolated reports and explains unsupported no-integration result',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm};let dispose,mode='conflict';const calls=[];
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.confirm=()=>true;
 globalThis.fetch=async(url,opts={})=>{calls.push({url,body:opts.body&&JSON.parse(opts.body)});return {ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf'}:url.endsWith('/sync-dev')?(mode==='conflict'?{conflict:true,files:['local.txt'],conflictId:'pull-report'}:{needsAction:true,reason:'存在不支持的特殊文件，未修改开发目录'}):url.endsWith('/notify-conflict')?{notified:true}:{directory:'/fixture',branch:'dev',changes:[{status:' M',path:'local.txt'}]}};};
 try{const root=new Element('root');dispose=mount(root,{getSessionId:()=> 'pull-session'});await tick();const dir=find(root,n=>n.placeholder?.startsWith('项目文件夹'));dir.value='/fixture';dir.onkeydown({key:'Enter',preventDefault(){}});await tick();find(root,n=>n.textContent==='从 dev 拉取').onclick();await tick();await tick();assert.deepEqual(calls.find(c=>c.url.endsWith('/notify-conflict')).body,{sessionId:'pull-session',directory:'/fixture',conflictId:'pull-report'});assert.ok(all(root).some(n=>n.textContent.includes('开发目录未写入合并结果')));mode='action';find(root,n=>n.textContent==='从 dev 拉取').onclick();await tick();assert.ok(all(root).some(n=>n.textContent.includes('尚未整合到开发目录')));assert.equal(calls.filter(c=>c.url.endsWith('/notify-conflict')).length,1);assert.ok(!all(root).some(n=>n.textContent.includes('✓ 已从 dev')));
 }finally{dispose?.();Object.assign(globalThis,old);}
});
test('opening and refreshing never display or notify legacy local conflicts',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch};let dispose;const calls=[];
 globalThis.document={createElement:tag=>new Element(tag)};
 const diff='<<<<<<< HEAD\nlocal A <script>\n=======\nremote B\n>>>>>>> origin/dev';
 globalThis.fetch=async url=>{calls.push(url);return {ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf',user:{login:'alice'}}:url.endsWith('/update-check')?{available:false}:url.endsWith('/notify-conflict')?{notified:true}:url.endsWith('/diff')?{diff}:{directory:'/fixture',branch:'dev',changes:[{status:'UU',path:'README.md'}]}};};
 try{const root=new Element('root');dispose=mount(root,{getSessionId:()=> 'session-test'});await tick();find(root,n=>n.placeholder?.startsWith('项目文件夹')).value='/fixture';find(root,n=>n.placeholder?.startsWith('项目文件夹')).onkeydown({key:'Enter',preventDefault(){}});await tick();find(root,n=>n.textContent==='刷新改动').onclick();await tick();assert.ok(!calls.some(url=>url.endsWith('/notify-conflict')||url.endsWith('/diff')));assert.ok(!all(root).some(n=>n.textContent.includes('<<<<<<< HEAD')||n.textContent.includes('UU')||n.textContent.includes('检测到冲突')));assert.equal(find(root,n=>n.textContent==='提交并推送到 dev').disabled,false);
 }finally{dispose?.();Object.assign(globalThis,old);}
});
test('only a fresh isolated push conflict notifies its captured session and next push uses a fresh report',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm};let dispose,sequence=0;const calls=[];
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.confirm=()=>true;
 globalThis.fetch=async(url,opts={})=>{calls.push({url,body:opts.body&&JSON.parse(opts.body)});return {ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf',user:{login:'alice'}}:url.endsWith('/push')?{conflict:true,files:['shared.js'],conflictId:'report-'+(++sequence)}:url.endsWith('/notify-conflict')?{notified:true}:{directory:'/fixture',branch:'dev',head:'abc',fingerprint:'snap',changes:[]}};};
 try{const root=new Element('root');dispose=mount(root,{getSessionId:()=> 'session-test'});await tick();find(root,n=>n.placeholder?.startsWith('项目文件夹')).value='/fixture';find(root,n=>n.placeholder?.startsWith('项目文件夹')).onkeydown({key:'Enter',preventDefault(){}});await tick();assert.ok(!calls.some(c=>c.url.endsWith('/notify-conflict')));const msg=find(root,n=>n.placeholder?.startsWith('提交说明'));msg.value='save';msg.oninput();for(let i=1;i<=2;i++){find(root,n=>n.textContent==='提交并推送到 dev').onclick();await tick();await tick();assert.deepEqual(calls.filter(c=>c.url.endsWith('/notify-conflict')).at(-1).body,{sessionId:'session-test',directory:'/fixture',conflictId:'report-'+i});assert.ok(all(root).some(n=>n.textContent.includes('等你确认后才修改')));}assert.equal(calls.filter(c=>c.url.endsWith('/push')).length,2);assert.ok(!calls.some(c=>c.url.endsWith('/diff')));find(root,n=>n.placeholder?.startsWith('项目文件夹')).onkeydown({key:'Enter',preventDefault(){}});await tick();assert.ok(!all(root).some(n=>n.textContent.includes('隔离合并发现冲突')||n.textContent.includes('已通知当前会话')));}finally{dispose?.();Object.assign(globalThis,old);}
});
test('clone log disclosure survives polling, preserves manual closing and ignores detached toggle events',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};let nextPoll,dispose;
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.confirm=()=>true;
 globalThis.setTimeout=fn=>{nextPoll=fn;return 123;};globalThis.clearTimeout=()=>{};
 globalThis.fetch=async(url)=>({ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf',user:{login:'alice'}}:url.endsWith('/clone')?{id:'clone1',state:'running'}:{id:'clone1',state:'running',percent:32,log:'Receiving objects: 32%'}});
 try{const root=new Element('root');dispose=mount(root);await tick();
 const form=find(root,n=>n.sgDisclosureKey==='clone-form');form.open=true;
 assert.ok(!all(root).some(n=>n.placeholder?.startsWith('仓库链接')));find(root,n=>n.placeholder?.startsWith('保存到')).value='/fixture';
 find(root,n=>n.textContent==='克隆并打开').onclick();await tick();
 let logs=find(root,n=>n.sgDisclosureKey==='clone-logs');logs.open=true;
 await nextPoll();logs=find(root,n=>n.sgDisclosureKey==='clone-logs');assert.equal(logs.open,true);assert.equal(find(root,n=>n.sgDisclosureKey==='clone-form').open,true);
 const detached=logs;logs.open=false;await nextPoll();logs=find(root,n=>n.sgDisclosureKey==='clone-logs');assert.equal(logs.open,false);
 detached.open=true;detached.ontoggle();await nextPoll();assert.equal(find(root,n=>n.sgDisclosureKey==='clone-logs').open,false);
 }finally{dispose?.();Object.assign(globalThis,old);}
});
test('deployment actions carry source identity and display local ready link',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};let dispose;const calls=[];
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.confirm=()=>true;globalThis.setTimeout=()=>1;globalThis.clearTimeout=()=>{};
 const repo={directory:'/fixture',branch:'dev',head:'abc',fingerprint:'snap',changes:[]};
 globalThis.fetch=async(url,opts={})=>{calls.push({url,body:opts.body&&JSON.parse(opts.body)});return {ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf',user:{login:'alice'}}:url.includes('/deploy-')?{state:'running',frontend:{ready:true},checks:{state:'passed'},logs:'build ok'}:repo};};
 try{const root=new Element('root');dispose=mount(root);await tick();find(root,n=>n.placeholder?.startsWith('项目文件夹')).value='/fixture';find(root,n=>n.placeholder?.startsWith('项目文件夹')).onkeydown({key:'Enter',preventDefault(){}});await tick();find(root,n=>n.textContent==='启动本地环境').onclick();await tick();assert.ok(calls.some(c=>c.url.endsWith('/deploy-start')));assert.equal(find(root,n=>n.textContent==='打开本地测试页面 ↗').href,'http://127.0.0.1:5180');assert.deepEqual(calls.find(c=>c.url.endsWith('/deploy-start')).body,{directory:'/fixture',head:'abc',fingerprint:'snap'});assert.ok(!calls.some(c=>c.url.endsWith('/deploy-confirm')||c.url.endsWith('/deploy-check')||c.url.endsWith('/commit-local')));const headings=all(root).filter(n=>n.tagName==='h3').map(n=>n.textContent);assert.deepEqual(headings,['GitHub 账号','开发环境初始化','项目','共用 dev 开发','本地部署与测试','提交并推送','插件远程更新']);const sections=all(root).filter(n=>n.tagName==='section');assert.ok(sections.find(n=>n.children[0]?.textContent==='本地部署与测试').contains(find(root,n=>n.textContent==='启动本地环境')));assert.ok(sections.find(n=>n.children[0]?.textContent==='提交并推送').contains(find(root,n=>n.textContent==='提交并推送到 dev')));}finally{dispose?.();Object.assign(globalThis,old);}
});
test('deployment reports progress, opens only once both services ready, and handles blocked popup or failure',async()=>{
 for(const scenario of ['success','blocked','failure']){
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm,open:globalThis.open,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};let dispose,phase='starting',opened=0,closed=0;const navigated=[];
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.confirm=()=>true;globalThis.setTimeout=()=>1;globalThis.clearTimeout=()=>{};
 globalThis.open=()=>{opened++;return scenario==='blocked'?null:{closed:false,document:{body:{}},location:{replace:url=>navigated.push(url)},close:()=>closed++};};
 globalThis.fetch=async url=>({ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf'}:url.includes('/deploy-')?{state:phase,frontend:{ready:true},backend:{ready:phase==='running'},checks:{state:'idle'},...(phase==='failed'?{error:'backend failed'}:{})}:{directory:'/fixture',branch:'dev',changes:[]}});
 try{const root=new Element('root');dispose=mount(root);await tick();const dir=find(root,n=>n.placeholder?.startsWith('项目文件夹'));dir.value='/fixture';dir.onkeydown({key:'Enter',preventDefault(){}});await tick();find(root,n=>n.textContent==='启动本地环境').onclick();await tick();assert.equal(opened,1);assert.equal(navigated.length,0);assert.ok(all(root).some(n=>n.textContent.includes('正在启动本地前后端')));
 phase=scenario==='failure'?'failed':'running';find(root,n=>n.textContent==='刷新运行状态').onclick();await tick();if(scenario==='success'){assert.deepEqual(navigated,['http://127.0.0.1:5180']);assert.ok(all(root).some(n=>n.textContent.includes('已自动打开测试页')));}else if(scenario==='blocked')assert.ok(all(root).some(n=>n.textContent.includes('浏览器未允许自动打开')));else{assert.equal(closed,1);assert.ok(all(root).some(n=>n.textContent.includes('失败：backend failed')));}
 find(root,n=>n.textContent==='刷新运行状态').onclick();await tick();assert.equal(opened,1);assert.equal(navigated.length,scenario==='success'?1:0);
 }finally{dispose?.();Object.assign(globalThis,old);}
 }
});
test('cancelling self-test confirmation never submits or confirms deployment',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm};let dispose;const calls=[];
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.confirm=()=>false;
 globalThis.fetch=async url=>{calls.push(url);return {ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf',user:{login:'alice'}}:{directory:'/fixture',branch:'dev',head:'abc',fingerprint:'snap',changes:[]}};};
 try{const root=new Element('root');dispose=mount(root);await tick();find(root,n=>n.placeholder?.startsWith('项目文件夹')).value='/fixture';find(root,n=>n.placeholder?.startsWith('项目文件夹')).onkeydown({key:'Enter',preventDefault(){}});await tick();const msg=find(root,n=>n.placeholder?.startsWith('提交说明'));msg.value='save';msg.oninput();find(root,n=>n.textContent==='提交并推送到 dev').onclick();await tick();assert.ok(!calls.some(url=>url.endsWith('/push')||url.endsWith('/commit-local')||url.endsWith('/deploy-confirm')));}finally{dispose?.();Object.assign(globalThis,old);}
});
test('automatic then manual update checks without GitHub login, renders plain text and guards duplicate check/install',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm};let dispose,finishCheck,finishInstall,holdCheck=false;const calls=[],prompts=[];
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.confirm=text=>{prompts.push(text);return true;};
 const notes='<img src=x onerror=alert(1)>\nRelease notes';
 globalThis.fetch=async(url,opts={})=>{calls.push({url,opts});if(holdCheck&&url.endsWith('/update-check'))await new Promise(resolve=>{finishCheck=resolve;});if(url.endsWith('/update-install'))await new Promise(resolve=>{finishInstall=resolve;});return {ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf',user:null,ghAvailable:false}:url.endsWith('/update-check')?{currentVersion:'0.1.0',version:'0.2.0',available:true,notes,checkId:'check-1'}:{message:'安装完成',installed:true,restartRequired:true}};};
 try{const root=new Element('root');dispose=mount(root);await tick();assert.equal(calls.length,2);assert.ok(calls[0].url.endsWith('/status'));assert.ok(calls[1].url.endsWith('/update-check'));assert.equal(find(root,n=>n.tagName==='link').href,'/simple-github/panel.css?v=0.10.0');assert.equal(find(root,n=>n.textContent==='检查插件更新').disabled,false);calls.length=0;holdCheck=true;
 find(root,n=>n.textContent==='检查插件更新').onclick();await tick();assert.equal(find(root,n=>n.textContent==='正在检查更新…').disabled,true);find(root,n=>n.textContent==='正在检查更新…').onclick();await tick();assert.equal(calls.filter(c=>c.url.endsWith('/update-check')).length,1);finishCheck();await tick();
 const check=calls.find(c=>c.url.endsWith('/update-check'));assert.equal(check.opts.method,'POST');assert.equal(check.opts.headers['X-Simple-Git-Token'],'csrf');assert.deepEqual(JSON.parse(check.opts.body),{});assert.equal(find(root,n=>n.tagName==='pre'&&n.textContent===notes).textContent,notes);assert.ok(all(root).some(n=>n.textContent==='当前版本：0.1.0 · 远程版本：0.2.0'));assert.ok(!all(root).some(n=>n.tagName==='img'));
 find(root,n=>n.textContent==='更新插件（自动安装）').onclick();await tick();assert.equal(prompts.length,1);for(const text of ['信任','所有 Agent 任务结束','重启 DSH','不会自动重启'])assert.ok(prompts[0].includes(text));assert.equal(find(root,n=>n.textContent==='正在下载校验…').disabled,true);find(root,n=>n.textContent==='正在下载校验…').onclick();find(root,n=>n.textContent==='检查插件更新').onclick();await tick();assert.equal(calls.filter(c=>c.url.endsWith('/update-install')).length,1);assert.equal(calls.filter(c=>c.url.endsWith('/update-check')).length,1);assert.deepEqual(JSON.parse(calls.find(c=>c.url.endsWith('/update-install')).opts.body),{checkId:'check-1',confirmed:true});finishInstall();await tick();assert.ok(all(root).some(n=>n.textContent.includes('更新操作成功：安装完成')&&n.textContent.includes('手动重启')));assert.ok(!all(root).some(n=>n.textContent==='更新插件（自动安装）'));assert.ok(!calls.some(c=>/restart/.test(c.url)));
 }finally{dispose?.();Object.assign(globalThis,old);}
});
test('cancelling update install makes no install request and manual path is plain text',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm};let dispose,confirmed=false;const calls=[],manualInstallPath='/absolute/更新包/<trusted>.tgz';
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.confirm=()=>confirmed;
 globalThis.fetch=async(url,opts={})=>{calls.push({url,opts});return {ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf'}:url.endsWith('/update-check')?{currentVersion:'0.1.0',version:'0.2.0',available:true,notes:'safe',checkId:'manual'}:{message:'交由 DSH 管理安装',installed:false,manualInstallPath}};};
 try{const root=new Element('root');dispose=mount(root);await tick();find(root,n=>n.textContent==='检查插件更新').onclick();await tick();find(root,n=>n.textContent==='更新插件（自动安装）').onclick();await tick();assert.ok(!calls.some(c=>c.url.endsWith('/update-install')));assert.ok(all(root).some(n=>n.textContent.includes('已取消安装更新')));assert.equal(find(root,n=>n.textContent==='更新插件（自动安装）').disabled,false);
 confirmed=true;find(root,n=>n.textContent==='更新插件（自动安装）').onclick();await tick();assert.ok(all(root).some(n=>n.textContent==='请通过 DSH 管理手动安装此绝对路径的更新包：'+manualInstallPath));assert.ok(all(root).some(n=>n.textContent.includes('尚未自动安装')));assert.ok(!all(root).some(n=>n.tagName==='a'&&n.href?.includes(manualInstallPath)));
 }finally{dispose?.();Object.assign(globalThis,old);}
});
test('update failures clear stale candidates; no update and explicit not-installed results are clear',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm};let dispose,mode='available';const calls=[];
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.confirm=()=>true;
 globalThis.fetch=async(url,opts={})=>{calls.push({url,opts});const failed=mode==='check-failure'&&url.endsWith('/update-check')||mode==='install-failure'&&url.endsWith('/update-install');return {ok:!failed,status:503,json:async()=>failed?{error:'remote unavailable'}:url.endsWith('/status')?{csrfToken:'csrf'}:url.endsWith('/update-check')?{currentVersion:'0.1.0',version:'0.2.0',available:mode!=='none',notes:'notes',checkId:'candidate'}:{message:'安装被拒绝',installed:false}};};
 try{const root=new Element('root');dispose=mount(root);await tick();const check=async()=>{find(root,n=>n.textContent==='检查插件更新').onclick();await tick();};await check();const staleInstall=find(root,n=>n.textContent==='更新插件（自动安装）');mode='check-failure';await check();assert.ok(all(root).some(n=>n.textContent.includes('更新检查失败：remote unavailable')));assert.ok(!all(root).some(n=>n.textContent==='更新插件（自动安装）'||n.textContent.startsWith('当前版本：')));staleInstall.onclick();await tick();assert.ok(!calls.some(c=>c.url.endsWith('/update-install')));
 mode='none';await check();assert.ok(all(root).some(n=>n.textContent.includes('当前没有可用更新')));assert.ok(!all(root).some(n=>n.textContent==='更新插件（自动安装）'));
 mode='available';await check();mode='install-failure';find(root,n=>n.textContent==='更新插件（自动安装）').onclick();await tick();assert.ok(all(root).some(n=>n.textContent.includes('更新安装失败或未确认完成：remote unavailable')));assert.ok(!all(root).some(n=>n.textContent==='更新插件（自动安装）'));assert.equal(find(root,n=>n.textContent==='检查插件更新').disabled,false);
 mode='available';await check();find(root,n=>n.textContent==='更新插件（自动安装）').onclick();await tick();assert.ok(all(root).some(n=>n.textContent.includes('更新未安装完成：安装被拒绝')&&n.className==='sg-error'));
 }finally{dispose?.();Object.assign(globalThis,old);}
});
test('verified download is handed to automatic installer and remount result is displayed',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm};let dispose;const installs=[];
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.confirm=()=>true;
 globalThis.fetch=async url=>({ok:true,json:async()=>url.endsWith('/status')?{csrfToken:'csrf'}:url.endsWith('/update-check')?{available:true,version:'0.3.0',checkId:'c'}:{installed:false,manualInstallPath:'/tmp/verified.tgz'}});
 try{const root=new Element('root');dispose=mount(root,{autoInstaller:{reconcile:async()=>({state:'done',message:'上次安装已完成'}),install:async body=>{installs.push(body);return {installed:true,message:'安装完成，请重启'};}}});await tick();assert.ok(all(root).some(n=>n.textContent==='上次安装已完成'));find(root,n=>n.textContent==='检查插件更新').onclick();await tick();find(root,n=>n.textContent==='更新插件（自动安装）').onclick();await tick();assert.deepEqual(installs,[{manualInstallPath:'/tmp/verified.tgz',version:'0.3.0'}]);assert.ok(all(root).some(n=>n.textContent==='安装完成，请重启'));}finally{dispose?.();Object.assign(globalThis,old);}
});
test('client declares matching tab registration and bundle metadata',async()=>{
 const fs=await import('node:fs/promises');assert.ok((await fs.readFile(new URL('./client.js',import.meta.url),'utf8')).includes("import('/simple-github/panel.js?v=0.10.0')"));const p=JSON.parse(await fs.readFile(new URL('./package.json',import.meta.url)));assert.equal(p.dsh.client.platform,'web');assert.ok(p.files.includes('platform.js'));let registration;
 const old=globalThis.window;globalThis.window={__ModuleLoader__:{load:module=>{registration=module;}}};
 try{await import('./client.js');const plugin=registration.factory(()=>({}));const tabs=[],slots=[];plugin.apply({effect:f=>f(),sidebarRightTabs:{register:t=>tabs.push(t)},slots:{inject:(name,fn)=>fn(),register:s=>slots.push(s)}});assert.equal(tabs[0].id,slots[0].key);assert.equal(tabs[0].guide[0].title(),'GitHub 协作');}finally{globalThis.window=old;}
});
