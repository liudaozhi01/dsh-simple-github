const BASE='/simple-github/api';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
export function mount(root,options={}){
 const link=el('link');link.rel='stylesheet';link.href='/simple-github/panel.css?v=0.6.0';
 const app=el('main',undefined,'sg-app');root.replaceChildren(link,app);
 let deploy=null,deployTimer,testWindow=null,awaitingTestPage=false;
  function closePendingTestPage(){try{testWindow?.close();}catch{}testWindow=null;awaitingTestPage=false;}
 let state={user:null,csrfToken:null,directory:'',repo:null,busy:false,pushing:false,pushResult:null,pulling:false,pullResult:null,login:null,clone:null,tab:'code',diff:null},disposed=false,timer,cloneTimer,loginGeneration=0;
 const errors=el('div',undefined,'sg-notice');errors.setAttribute('role','status');
 function displayText(value){return String(value).replace(/https:\/\/github\.com\/[^\s'"<>]+/gi,'[团队仓库]');}
  function message(text,bad=false){errors.textContent=displayText(text);errors.className='sg-notice '+(bad?'sg-error':'sg-success');}
 async function api(path,body){
  const r=await fetch(BASE+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-Simple-Git-Token':state.csrfToken||''},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(180000)});
  const data=await r.json();if(!r.ok||data.ok===false)throw new Error(data.error||'请求失败 HTTP '+r.status);return data;
 }
 function button(label,action,primary=false){const n=el('button',label,primary?'sg-primary':'');n.type='button';n.disabled=state.busy||state.clone?.state==='running';n.onclick=()=>run(action);return n;}
 const projectStorageKey='simple-github:last-project:v1';
 function savedProject(){try{const value=globalThis.localStorage?.getItem(projectStorageKey);return typeof value==='string'&&value.length<=32768&&!/[\0\r\n]/.test(value)?value:'';}catch{return '';}}
 function rememberProject(directory){try{globalThis.localStorage?.setItem(projectStorageKey,directory);}catch{/* Storage can be unavailable; opening a project must still work. */}}
 const drafts=new Map();
  const disclosureState=new Map();
  function disclosure(key){const node=el('details');node.sgDisclosureKey=key;node.open=disclosureState.get(key)||false;node.ontoggle=()=>{if(app.contains(node))disclosureState.set(key,node.open);};return node;}
 function input(placeholder,value,key=placeholder){const n=el('input');n.placeholder=placeholder;n.sgDraftKey=key;n.value=value===undefined?(drafts.get(key)||''):value;n.disabled=state.busy||state.clone?.state==='running';n.oninput=()=>drafts.set(key,n.value);return n;}
 async function pickDirectory(field,autoOpen=false){const result=await api('/choose-directory',{});if(disposed||result.cancelled)return;drafts.set(field.sgDraftKey,result.directory);if(autoOpen)await openProject(result.directory);else message('已选择保存目录，点击“克隆并打开”开始克隆。');}
  async function openProject(directory){state.directory=directory.trim();resetProject();await inspect();message('项目已打开。');}
 function resetProject(){closePendingTestPage();noticeStatus='';notified.clear();message('');deploy=null;clearTimeout(deployTimer);state.pushResult=null;state.pullResult=null;state.repo=null;state.diff=null;drafts.clear();}
 function section(title){const n=el('section');n.append(el('h3',title));app.append(n);return n;}
 function row(...nodes){const n=el('div',undefined,'sg-row');n.append(...nodes);return n;}
 function external(label,url){const n=el('a',label);try{const u=new URL(url);if(u.protocol==='https:'&&u.hostname==='github.com'){n.href=u.href;n.target='_blank';n.rel='noopener noreferrer';}}catch{}return n;}
 async function run(action){if(state.busy||state.clone?.state==='running'||disposed)return;state.busy=true;render();try{await action();}catch(e){message(e.message,true);}finally{state.busy=false;if(!disposed)render();}}
 let update=null,updatePhase='',updateResult=null;
  const reconciliation=options.autoInstaller?.reconcile().then(record=>{if(record&&!disposed){updateResult={text:record.message,failed:record.state==='unknown'};render();}}).catch(()=>{});
  async function checkUpdate(){
   update=null;updateResult=null;updatePhase='checking';render();
   try{const result=await api('/update-check',{});if(disposed)return;update=result;updateResult={text:result.available?'发现可用更新，请先阅读版本更新说明。':'检查完成，当前没有可用更新。',failed:false};}
   catch(error){update=null;updateResult={text:'更新检查失败：'+error.message,failed:true};}
   finally{updatePhase='';}
  }
  async function installUpdate(){
   const candidate=update;if(!candidate?.available||!candidate.checkId)return;
   if(deploy&&['running','starting','checking'].includes(deploy.state))throw new Error('请先停止本地部署再安装更新');
   if(!confirm('确认更新到 '+candidate.version+'？将下载、校验并自动安装你信任的更新包。请确认所有 Agent 任务结束、本地部署已停止且没有其他插件操作。更新可能重载面板，或需要手动重启 DSH；不会自动重启。')){updateResult={text:'已取消安装更新，未发起安装请求。',failed:false};return;}
   updatePhase='installing';updateResult=null;render();
   try{const result=await api('/update-install',{checkId:candidate.checkId,confirmed:true});if(disposed)return;
    update=null;
    if(result.manualInstallPath&&options.autoInstaller){
     if(deploy&&['running','starting','checking'].includes(deploy.state))throw new Error('请先停止本地部署再安装更新');
     const installed=await options.autoInstaller.install({manualInstallPath:result.manualInstallPath,version:candidate.version});
     updateResult={text:installed.message,failed:false};return;
    }
    const manual=Boolean(result.manualInstallPath),failed=!manual&&result.installed===false;
    updateResult={text:(manual?'更新包已准备，尚未自动安装。':failed?'更新未安装完成：':'更新操作成功：')+(result.message||'请求已完成。')+(result.restartRequired?' 需要你手动重启 DSH。':'')+' 不会自动重启 DSH。',failed,manualInstallPath:result.manualInstallPath};
   }catch(error){update=null;updateResult={text:'更新安装失败或未确认完成：'+error.message+'。若已提交安装，请先在插件管理核对结果，勿重复安装；不会自动重启 DSH。',failed:true};}
   finally{updatePhase='';}
  }
  function renderUpdate(){
   const box=section('插件远程更新');
   box.append(el('p','打开面板时自动检查一次新版本，也可手动重新检查。仅在确认更新后下载安装，可能重载面板；需要重启时会提示，不自动重启 DSH。','sg-muted'));
   box.append(row(button(updatePhase==='checking'?'正在检查更新…':'检查插件更新',checkUpdate),...((update?.available&&update.checkId)?[button(updatePhase==='installing'?'正在下载校验…':'更新插件（自动安装）',installUpdate)]:[])));
   if(update){box.append(el('p','当前版本：'+update.currentVersion+' · 远程版本：'+update.version));box.append(el('p','版本更新说明'),el('pre',update.notes||'暂无更新说明。'));}
   if(updatePhase)loading(box,updatePhase==='checking'?'正在检查远程更新，请稍候…':'正在下载并校验更新包，请等待完成…');
   if(updateResult){box.append(el('p',updateResult.text,updateResult.failed?'sg-error':'sg-success'));if(updateResult.manualInstallPath)box.append(el('p','请通过 DSH 管理手动安装此绝对路径的更新包：'+updateResult.manualInstallPath));}
  }
  let noticeStatus='';
 const notified=new Set();
  const unmerged=change=>['DD','AU','UD','UA','DU','AA','UU'].includes(change.status.trim());
 const conflicted=repo=>repo?.changes?.some(c=>['DD','AU','UD','UA','DU','AA','UU'].includes(c.status.trim()));
 async function notifyConflict(report,sessionId){
  if(!report.conflictId)return;
  state.diff=null;
  if(!sessionId||options.getSessionId?.()!==sessionId){noticeStatus='检测到冲突，但未绑定当前会话；请在项目对应会话中打开面板。';return;}
  const directory=state.directory,key=JSON.stringify([sessionId,directory,report.conflictId]);if(notified.has(key))return;
  try{const result=await api('/notify-conflict',{sessionId,directory,conflictId:report.conflictId});if(disposed||options.getSessionId?.()!==sessionId)return;
   if(result.notified||result.duplicate){notified.add(key);noticeStatus='本次隔离合并检测到冲突，已通知当前会话提出解决方案；等你确认后才修改开发代码，尚未推送。';}
   else noticeStatus='冲突状态已改变，请刷新改动。';
  }catch(error){noticeStatus='检测到冲突，会话通知未送达：'+error.message;}
 }
 async function inspect(){if(!state.directory.trim())throw new Error('请先填写项目文件夹的绝对路径。');state.repo=await api('/inspect',{directory:state.directory});state.directory=state.repo.directory;rememberProject(state.directory);state.diff=null;}
 
  async function refreshStatus(generation){const s=await api('/status');if(disposed||(typeof generation==='number'&&generation!==loginGeneration))return;Object.assign(state,{user:s.user,csrfToken:s.csrfToken,ghAvailable:s.ghAvailable,platformInfo:s.environment});}
 async function pollClone(id){
  try{const result=await api('/clone-status',{id});if(disposed)return;state.clone=result;
   if(result.state==='success'){state.directory=result.directory;resetProject();await inspect();if(disposed)return;message('克隆完成，项目已打开。');render();return;}
   if(result.state==='error'){message(result.error+'（可能留下未完成目录，请检查后再重试；不会自动删除。）',true);render();return;}
   render();cloneTimer=setTimeout(()=>pollClone(id),800);
  }catch(e){if(disposed)return;message('克隆状态暂时无法获取，将继续查询：'+e.message,true);cloneTimer=setTimeout(()=>pollClone(id),2000);}
 }
 async function pollLogin(id,generation){
  try{const s=await api('/login?id='+encodeURIComponent(id));if(disposed||generation!==loginGeneration)return;const changed=JSON.stringify(state.login)!==JSON.stringify(s);state.login=s;if(s.state==='success'){await refreshStatus(generation);if(disposed||generation!==loginGeneration)return;state.login=null;message('已登录 GitHub，可以选择项目了。');render();return;}if(s.state==='error'){message(s.error||'登录失败，请重试。',true);render();return;}if(changed&&!state.busy)render();timer=setTimeout(()=>pollLogin(id,generation),2000);}catch(e){if(!disposed&&generation===loginGeneration){message('登录状态检查暂时失败，将自动重试：'+e.message,true);timer=setTimeout(()=>pollLogin(id,generation),4000);}}
 }
 function render(){
  if(disposed)return;const focused=app.contains(document.activeElement)?document.activeElement:null;const focusKey=focused?.sgDraftKey,selection=focused&&typeof focused.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;for(const node of app.querySelectorAll?.('details')||[]){if(node.sgDisclosureKey)disclosureState.set(node.sgDisclosureKey,node.open);}app.replaceChildren();app.append(el('h2','GitHub 协作'),el('p','打开项目 → 从 dev 拉取 → 开发 → 本地部署与自测 → 提交推送','sg-muted'),errors);
  const host=state.platformInfo,isWindows=host?.isWindows===true,isMac=host?.platform==='darwin';
  const account=section('1 · GitHub 账号');
  account.append(el('p','DSH 宿主系统：'+(host?.label||'尚未检测')+'（以运行 DSH 的电脑为准，不是浏览器系统）','sg-muted'));
  if(state.user){account.append(row(el('strong','已登录：'+state.user.login),button('刷新',refreshStatus),button('退出登录',async()=>{if(!confirm('退出本机 GitHub CLI 的当前账号？这也会影响其他使用 gh 的工具。'))return;++loginGeneration;clearTimeout(timer);await api('/logout',{});await refreshStatus();message('已退出登录。');})));}
  else{
   account.append(el('p','点击登录，在 GitHub 官方网页完成授权。无需配置 SSH。'));
   if(state.ghAvailable===false){const install=isWindows?'请在 PowerShell 或终端运行 winget install --id GitHub.cli --exact。':isMac?'请在终端运行 brew install gh。':'请安装适合 DSH 宿主系统的官方 GitHub CLI（gh）。';account.append(el('p','DSH 宿主未找到 GitHub CLI（gh）。'+install+'安装后完全退出并重新启动 DSH，再检查登录状态，以加载更新后的 PATH。','sg-error'));}
   account.append(row(button(state.login?.state==='pending'?'继续登录 / 显示验证码':'登录 GitHub',async()=>{clearTimeout(timer);const generation=++loginGeneration;const s=await api('/login',{});state.login={state:'pending'};message(s.resumed?'已恢复上次授权，请使用下方验证码继续。':'正在获取 GitHub 登录验证码…');void pollLogin(s.loginId,generation);},true),button('检查登录状态',refreshStatus)));
   if(state.login?.state==='pending'){
    account.append(el('p','在 GitHub 官方页面输入下面的验证码（不要发给他人）：'));
    account.append(el('code',state.login.code||'正在获取验证码…','sg-code'));
    if(!state.login.code)account.append(el('p','授权网页能打开，不代表 DSH 宿主上的 gh 已成功连接授权接口。若持续没有验证码，可在运行 DSH 的电脑终端执行 gh auth login --hostname github.com --git-protocol https --web，自行完成授权后点击“检查登录状态”。不要把验证码或 Token 发到会话中。','sg-muted'));
     if(state.login.url)account.append(external('打开 GitHub 授权页面 ↗',state.login.url));
   }
  }
  const project=section('2 · 项目');
  const pathExample=isWindows?'C:\\Users\\你的名字\\Projects\\XiAN-OA':isMac?'/Users/你的名字/Projects/XiAN-OA':'/home/你的名字/Projects/XiAN-OA';
  const dirPlaceholder='项目文件夹绝对路径，例如 '+pathExample;const dir=input(dirPlaceholder,drafts.get('project-directory')??state.directory,'project-directory');
  dir.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();void run(()=>openProject(dir.value));}};
   project.append(row(dir,button('选择目录',()=>pickDirectory(dir,true),true)));
  const details=disclosure('clone-form');details.append(el('summary','还没有项目？克隆 GitHub 仓库'));
  const parent=input('保存到哪个已有文件夹（绝对路径），例如 '+(isWindows?'C:\\Users\\你的名字\\Projects':isMac?'/Users/你的名字/Projects':'/home/你的名字/Projects'),undefined,'clone-parent');
  details.append(el('p','团队项目已预设，只克隆 dev 分支并直接打开；请选择保存位置，会在该位置新建项目文件夹。','sg-muted'),row(parent,button('选择目录',()=>pickDirectory(parent))),button('克隆并打开',async()=>{if(!confirm('将团队项目克隆到 '+parent.value+' 下？'))return;const result=await api('/clone',{parentDirectory:parent.value.trim()});state.clone={...result,phase:'正在连接 GitHub…',percent:null,log:''};message('正在克隆，请勿关闭应用。');void pollClone(result.id);},true));project.append(details);
  if(state.clone){const c=state.clone,done=c.state==='success';const progressBox=el('section');progressBox.setAttribute('aria-live','polite');progressBox.append(el('h3',c.state==='running'?'正在克隆…':done?'✓ 克隆完成':'克隆失败'));
    if(done)progressBox.append(el('p','仓库已下载完成。保存位置：'+c.directory));else progressBox.append(el('p',displayText(c.phase||'正在连接 GitHub…')));
    if(!done){const bar=el('progress');bar.max=100;bar.style.width='100%';if(c.percent!==null&&c.percent!==undefined)bar.value=c.percent;
    progressBox.append(bar,el('p',c.state==='error'?'克隆未完成，请查看错误信息':c.percent==null?'等待服务器返回进度…':'当前阶段：'+c.percent+'%（各阶段独立计数）','sg-muted'));}
    if(!done&&c.log){const logs=disclosure('clone-logs');logs.append(el('summary','查看克隆日志'));const pre=el('pre',displayText(c.log).replace(/\r\n?/g,'\n'));pre.style.whiteSpace='pre-wrap';pre.style.overflowWrap='anywhere';pre.style.maxHeight='240px';logs.append(pre);progressBox.append(logs);}project.append(progressBox);}
   if(state.repo){
   const repo=state.repo;project.append(el('p','团队项目 · 当前分支：'+repo.branch,'sg-muted'));
    renderCode(repo);
  }
  renderUpdate();
   app.setAttribute('aria-busy',String(state.busy));if(focusKey&&!state.busy){const target=[...(app.querySelectorAll?.('input,textarea')||[])].find(n=>n.sgDraftKey===focusKey);target?.focus();if(selection)target?.setSelectionRange(...selection);}
 }
 async function refreshDeploy(){const directory=state.directory;const result=await api('/deploy-status',{directory});if(disposed||directory!==state.directory)return;const previous=deploy;deploy=result;
   const ready=result.state==='running'&&result.frontend?.ready&&result.backend?.ready;
   if(ready&&awaitingTestPage){awaitingTestPage=false;let opened=false;try{if(testWindow&&!testWindow.closed){testWindow.location.replace('http://127.0.0.1:5180');opened=true;}}catch{}testWindow=null;message(opened?'✓ 本地环境启动成功，前后端已就绪，已自动打开测试页。请完成页面自测。':'✓ 本地环境启动成功，前后端已就绪。浏览器未允许自动打开，请点击“打开本地测试页面”。');}
   else if(result.state==='failed'){if(awaitingTestPage)closePendingTestPage();if(previous?.state!=='failed'||previous?.error!==result.error)message('本地环境启动或运行失败：'+(result.error||'请查看运行日志'),true);}
   clearTimeout(deployTimer);if(!state.busy)render();if(result.task||result.state==='starting'||result.state==='running'||result.state==='stopping'||result.checks?.state==='pending'||result.checks?.state==='running')deployTimer=setTimeout(()=>refreshDeploy().catch(e=>message(e.message,true)),2000);}
  async function deployAction(name){
    if(name==='start'){closePendingTestPage();awaitingTestPage=true;try{testWindow=globalThis.open?.('about:blank','_blank')||null;if(testWindow){testWindow.opener=null;testWindow.document.title='本地环境启动中';testWindow.document.body.textContent='正在启动当前本地代码；缺少依赖时会自动安装。前后端就绪后将自动进入本地测试页面；失败请查看 DSH 运行日志。';}}catch{}message('正在启动当前本地代码（缺少依赖时自动安装），不等待构建与测试，请稍候…');}
    if(name==='stop'){closePendingTestPage();message('正在停止本地环境…');}
    try{deploy=await api('/deploy-'+name,{directory:state.directory,head:state.repo?.head,fingerprint:state.repo?.fingerprint});await refreshDeploy();}catch(error){if(name==='start')closePendingTestPage();throw error;}
   }
  function renderDeploy(repo){
   const box=section('4 · 本地部署与测试');
   box.append(el('p','启动本地环境只运行当前磁盘上的代码，不要求先拉取、提交或更新，不先跑构建和测试；缺失项目依赖时自动安装，Windows 还会自动补齐缺少的 Node.js/npm、Maven、JDK 21+，安装进度见运行日志。仅监听本机，不发布到服务器。打开页面完成自测后再提交推送；推送只执行 Git 提交、同步与冲突检查，不额外运行构建和后端测试。启动成功不代表完整测试通过。','sg-muted'));
   box.append(row(button('启动本地环境',async()=>{if(!confirm('检查并自动安装缺少的项目依赖（可能联网下载并执行 npm 安装脚本），随后运行 Vite、Maven 并创建/使用本地 H2 测试数据？仅启动可信项目；Windows 会自动补齐缺少的 Node.js/npm、Maven 和 JDK 21+（联网下载，可能需要本人确认 UAC；不会绕过权限）。macOS 系统工具仍需自行安装。'))return;await deployAction('start');}),button('停止本地环境',()=>deployAction('stop')),button('刷新运行状态',refreshDeploy)));
   
   if(deploy){const names={starting:'启动中',running:'运行中',failed:'失败',stopping:'停止中',stopped:'已停止',pending:'等待中',passed:'通过',idle:'未运行'};if(deploy.state==='starting')loading(box,'正在启动本地前后端，缺少依赖时下载依赖，等待服务就绪…');if(deploy.state==='running'&&deploy.frontend?.ready&&deploy.backend?.ready)box.append(el('p','✓ 本地环境启动成功，前后端已就绪。请打开测试页完成页面自测。','sg-success'));box.append(el('p','环境：'+(names[deploy.state]||deploy.state)+' · 自动检查：'+(names[deploy.checks?.state]||deploy.checks?.state||'未运行')+' · 页面自测请在浏览器完成，推送时确认'));if(deploy.error)box.append(el('p',deploy.error,'sg-error'));if(deploy.frontend?.ready){const a=el('a','打开本地测试页面 ↗');a.href='http://127.0.0.1:5180';a.target='_blank';a.rel='noopener noreferrer';box.append(a);}if(deploy.logs){const details=disclosure('deploy-logs');details.append(el('summary','查看本地运行与检查日志'));const logs=el('pre',typeof deploy.logs==='string'?deploy.logs:JSON.stringify(deploy.logs,null,2));logs.style.maxHeight='300px';logs.style.overflow='auto';details.append(logs);box.append(details);}}
   else box.append(el('p','尚未读取本地运行状态。'));
  }
  function expected(repo){return {expectedHead:repo.head,expectedFingerprint:repo.fingerprint,expectedBranch:repo.branch,expectedRepository:repo.repository,expectedBaseBranch:repo.baseBranch};}
 function loading(box,text){const node=el('div');node.setAttribute('role','status');node.append(el('p',text));const bar=el('progress');bar.style.width='100%';node.append(bar);box.append(node);}
function renderCode(repo){
 const code=section('3 · 共用 dev 开发'),changes=(repo.changes||[]).filter(c=>!unmerged(c)),onDev=repo.branch==='dev';
 code.append(el('p','先从 dev 拉取并开发，再到下方启动本地环境、自测通过后提交推送。','sg-muted'));
 if(!onDev){code.append(el('p','当前不在 dev。请先确认旧分支的工作已保存，再切换。旧分支会保留，但其中独有的代码不会自动带到 dev；有未提交改动时会拦截。','sg-warning'),button('切换到 dev',async()=>{if(!confirm('切换到本地 dev（没有则从远程创建）？旧任务分支保留，不自动合并其代码。请先确认没有遗漏旧任务成果。'))return;await api('/switch-dev',{directory:repo.directory,...expected(repo)});state.pushResult=null;state.pullResult=null;await inspect();message('已切换到 dev，请先从 dev 拉取。');},true));}
 const pull=button(state.pulling?'正在从 dev 拉取…':'从 dev 拉取',async()=>{
  if(!onDev)throw new Error('请先切换到 dev。');
  if(!confirm('获取最新 dev，在隔离环境中连同本地未提交修改检查合并。有冲突只报告并等待确认，不写入开发目录；无冲突且本地快照未变才安全整合，随后需重新部署、自测。'))return;
  const sid=options.getSessionId?.();noticeStatus='';state.pushResult=null;
   state.pulling=true;state.pullResult=null;render();
  try{const result=await api('/sync-dev',{directory:repo.directory,...expected(repo)});state.pullResult={text:result.conflict?'拉取的隔离合并检测到冲突，开发目录未写入合并结果：'+result.files.join('、')+'。会话将提出方案，等你确认后再修改代码。':result.needsAction?'已完成隔离检查，尚未整合到开发目录：'+(result.message||result.reason||'当前文件状态无法安全写回，需先确认整合方案。'):'✓ 已从 dev 安全整合最新代码，本地开发成果已保留。请重新部署、自测。',failed:Boolean(result.conflict||result.needsAction)};message(state.pullResult.text,state.pullResult.failed);await inspect();if(result.conflict)await notifyConflict(result,sid);}
  catch(error){state.pullResult={text:'拉取未确认完成：'+error.message,failed:true};throw error;}finally{state.pulling=false;}
 });pull.disabled=state.busy||!onDev;code.append(row(pull,button('刷新改动',inspect)));
 if(state.pulling)loading(code,'正在从 dev 拉取并整合代码，请稍候…');else if(state.pullResult)code.append(el('p',state.pullResult.text,state.pullResult.failed?'sg-error':'sg-success'));
 code.append(el('p',changes.length?'将提交全部 '+changes.length+' 个改动文件（含已暂存及未跟踪文件）':'没有待提交改动。'));
 if(changes.length){const list=el('ul');for(const c of changes)list.append(el('li',c.status+'  '+c.path));code.append(list);}
 if(!conflicted(repo))code.append(button('查看差异',async()=>{state.diff=await api('/diff',{directory:state.directory});}));
 const hasConflict=conflicted(repo);
  if(noticeStatus)code.append(el('p',noticeStatus,'sg-warning'));
 if(state.diff&&!hasConflict){code.append(el('pre',state.diff.diff||'没有文本差异，请在编辑器检查新文件和二进制内容。'));if(state.diff.truncated)code.append(el('p','差异已截断，请检查完整内容。','sg-warning'));}
 renderDeploy(repo);
  const push=section('5 · 提交并推送');
  const msg=input('提交说明，例如：完成请假审批页面');push.append(msg);
 if(state.pushing)loading(push,'正在提交、获取远程 dev 并检查隔离合并与推送条件，请稍候…');else if(state.pushResult)push.append(el('p',state.pushResult.text,state.pushResult.failed?'sg-error':'sg-success'));
 const submit=button(state.pushing?'正在提交…':'提交并推送到 dev',async()=>{
  if(!onDev)throw new Error('请先切换到 dev。');
  if(!msg.value.trim())throw new Error('请填写提交说明。');
  if(!confirm('确认已打开本地页面，测试本次修改及相关功能并通过？继续将暂存全部改动、提交并推送到共用 dev。整合新代码时会暂停，须重新启动本地环境并自测。本次不会额外执行构建或后端测试，请自行确认本地功能正常。'))return;
  const sid=options.getSessionId?.();noticeStatus='';
   state.pushing=true;state.pushResult=null;render();
  try{const result=await api('/push',{directory:repo.directory,...expected(repo),message:msg.value.trim(),confirmedSelfTest:true});state.pushResult={text:result.conflict?'本次与最新 dev 的隔离合并发现冲突，开发目录未写入合并结果，未推送：'+result.files.join('、')+'。会话将提出解决方案，等你确认后再修改开发代码、自测重试。':result.needsReview?'已整合同事最新代码，尚未推送。请停止并重新启动本地环境、自测通过后，再点“提交并推送到 dev”。':'✓ 已成功推送到共用 dev。',failed:Boolean(result.conflict)};message(state.pushResult.text,state.pushResult.failed);try{await inspect();if(result.conflict)await notifyConflict(result,sid);}catch(error){message(state.pushResult.text+' 刷新失败：'+error.message,true);}}
  catch(error){state.pushResult={text:'推送未确认完成，本地提交可能已保存：'+error.message,failed:true};try{await inspect();}catch{}throw error;}finally{state.pushing=false;}
 },true);submit.disabled=state.busy||!onDev;push.append(submit);
 push.append(el('p','DSH 修改的文件已在本机，无需额外点击保存。自测完成后，使用“提交并推送到 dev”分享给团队。不强推；冲突请让 DSH 协助处理。test / 生产发布仍由负责人操作。','sg-muted'));
}
state.directory=savedProject();
 render();void run(async()=>{await refreshStatus();await reconciliation;if(disposed)return;if(!updateResult)await checkUpdate();if(disposed||!state.directory)return;try{await inspect();if(!disposed)message('已恢复上次选择的项目。');}catch(error){if(!disposed)message('无法恢复上次项目，已保留路径，请检查目录或重新选择：'+error.message,true);}});
 return()=>{closePendingTestPage();disposed=true;++loginGeneration;clearTimeout(timer);clearTimeout(cloneTimer);clearTimeout(deployTimer);root.replaceChildren();};
}
