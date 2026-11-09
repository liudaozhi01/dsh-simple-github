import {errorFeedback} from './error-feedback.js';
import {schemaReviewMessage} from './schema-review-message.js';
export function renderSchemaRefusal(text,make,disclose){
 const marker='数据库结构差异需要人工审查，未执行 SQL、未删除数据。';
 const start=typeof text==='string'?text.indexOf(marker):-1;
 const safe=start>=0?schemaReviewMessage(text.slice(start)):undefined;
 if(!safe)return;
 const lines=safe.split('\n'),items=lines.slice(1,-1),box=make('div');
 box.append(make('p','发布未启动：数据库结构无法安全同步。','sg-warning'),make('p','未执行 SQL，未修改或删除数据。','sg-muted'));
 const details=disclose('schema-refusal-reasons');details.append(make('summary','查看具体原因（'+items.length+' 项）'));
 const list=make('ul');for(const item of items)list.append(make('li',item));details.append(list);box.append(details);return box;
}
const BASE='/simple-github/api';
const createElement=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
export function mount(root,options={}){
 // Errors stay in the panel; never send them to an AI session.
 const makeElement=createElement;
 function showError(node,text){
  const feedback=errorFeedback(text);node.textContent=feedback.message;
  const details=makeElement('details'),summary=makeElement('summary','技术详情（可选中文字复制）'),pre=makeElement('pre','错误分类：'+feedback.code+'\n原始信息：'+feedback.detail);
  details.append(summary,pre);node.append(details);
 }
 function el(tag,text,cls){const n=makeElement(cls==='sg-error'&&tag==='p'?'div':tag,cls==='sg-error'?undefined:text,cls);if(cls==='sg-error'&&text!==undefined)showError(n,text);return n;}
 const link=el('link');link.rel='stylesheet';link.href='/simple-github/panel.css?v=0.15.6';
 const app=el('main',undefined,'sg-app');root.replaceChildren(link,app);
 let environment=null,environmentRequest=null;
 let sourceHistory=null,sourcePreview=null,sourceResult=null,sourcePreviewAnchor=null,focusSourcePreview=false;
 async function loadSourceHistory(page=1){sourcePreview=null;sourceResult=null;const result=await api('/source-history',{directory:state.repo.directory,page,...(page>1?{remoteHead:sourceHistory.remoteHead}:{})});if(disposed)return;sourceHistory=result;disclosureState.set('source-history-list',true);}
 let state={user:null,csrfToken:null,directory:'',repo:null,busy:false,pushing:false,pushResult:null,pulling:false,pullResult:null,login:null,clone:null,tab:'code',diff:null},disposed=false,timer,cloneTimer,loginGeneration=0;
 const errors=el('div',undefined,'sg-notice');errors.setAttribute('role','status');
 function displayText(value){return String(value).replace(/https:\/\/github\.com\/[^\s'"<>]+/gi,'[团队仓库]');}
  function message(text,bad=false){errors.replaceChildren();if(bad)showError(errors,displayText(text));else errors.textContent=displayText(text);errors.className='sg-notice '+(bad?'sg-error':'sg-success');}
 let requestProgress=null;
 const progressLabels={'/source-history':'读取源码历史','/source-restore-preview':'核对源码恢复范围','/source-restore':'恢复远程及本地源码','/push':'提交与推送','/sync-dev':'拉取与隔离合并','/clone':'提交克隆任务','/update-install':'下载校验更新包','/update-check':'检查更新','/environment-inspect':'检测环境','/environment-notify':'发送配置请求','/inspect':'读取项目','/diff':'读取差异','/switch-dev':'切换协作分支','/docker-plan':'核对发布计划','/docker-promote':'核对晋级计划','/docker-restore':'核对恢复计划','/docker-start':'提交发布任务'};
 function progressNode(label,percent,note){const box=el('div',undefined,'sg-operation-progress');box.setAttribute('role','status');box.setAttribute('aria-live','polite');box.append(el('p',label+' · '+percent+'%'),el('small',note,'sg-muted'));const bar=el('progress');bar.max=100;bar.value=percent;bar.style.width='100%';bar.setAttribute('aria-label',label+'阶段进度');box.append(bar);return box;}
 async function api(path,body){
  const tracked=state.busy&&progressLabels[path];const record=tracked?{label:progressLabels[path],percent:10,note:'阶段进度：请求已发出，等待服务端执行；不是传输字节百分比。'}:null;
  if(record){requestProgress=record;render();}
  try{const r=await fetch(BASE+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-Simple-Git-Token':state.csrfToken||''},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(path==='/sync-dev'?600000:180000)});
   const data=await r.json();if(!r.ok||(data.ok===false&&!(path==='/source-restore'&&data.needsAction)))throw new Error(data.error||'请求失败 HTTP '+r.status);
   if(record&&requestProgress===record){record.percent=100;record.note='请求已返回；是否推送、部署或安装成功以具体结果为准。';}
   return data;
  }catch(error){if(record&&requestProgress===record)record.note='客户端未收到成功结果；后台任务可能仍在运行，不会自动重试写操作。';if(path==='/sync-dev'&&['TimeoutError','AbortError','TypeError'].includes(error.name))throw new Error('客户端等待超时或连接中断，后台同步可能仍在运行。请先核对本地分支、文件及后台 Git 任务，不要重复拉取或同时修改仓库。原始信息：'+error.message);throw error;
  }finally{if(record&&!disposed)render();}
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
 function resetProject(){sourceHistory=null;sourcePreview=null;sourceResult=null;dockerPreview=null;remotePlan=null;drafts.delete('remote-db-risk');noticeStatus='';notified.clear();message('');state.pushResult=null;state.pullResult=null;state.repo=null;state.diff=null;drafts.clear();}
 let activeView='project';
 const collaborationBranch=()=>state.project?.branch||'dev';
   const oaAvailable=()=>state.oaDeploymentAvailable!==false;
  const viewNames={project:'项目',code:'代码同步',remote:'远程部署',recovery:'版本恢复',settings:'设置'};
 function section(title){const n=el('section');n.append(el('h3',title.replace(/^\d+ · /,'')));const view=title==='历史源码恢复'||title==='历史镜像恢复'?'recovery':title==='dev 远程部署'?'remote':title.includes('账号')||(title==='插件远程更新'||title==='GitHub 管理后台'||title==='发布服务器连接')?'settings':title.includes('共用分支')||title.includes('提交并推送')?'code':'project';n.hidden=view!==activeView;n.setAttribute('data-view',view);app.append(n);return n;}
 function renderHeader(){
  const header=el('header',undefined,'sg-header'),brand=el('div',undefined,'sg-brand');brand.append(el('span','G','sg-brand-mark'),el('div','GitHub 协作','sg-brand-name'));header.append(brand,el('span',state.busy?'处理中…':'团队开发空间','sg-badge'));
  const status=el('div',undefined,'sg-context');status.append(el('strong',state.directory?state.directory.replace(/\\/g,'/').split('/').filter(Boolean).at(-1):'尚未选择项目'),el('span',state.repo?.branch||'未打开','sg-branch'),el('span',state.user?.name||state.user?.login||'未登录','sg-account'));if(state.directory)status.title=state.directory;
  const nav=el('nav',undefined,'sg-nav');nav.setAttribute('aria-label','协作功能');for(const [view,label] of Object.entries(viewNames)){if((view==='remote'&&!oaAvailable())||(view==='recovery'&&state.user?.name!=='刘道志'))continue;const tab=el('button',label,view===activeView?'sg-nav-active':'');tab.type='button';tab.setAttribute('aria-current',view===activeView?'page':'false');tab.onclick=()=>{activeView=view;clearTimeout(remoteTimer);render();if(['remote','recovery'].includes(view)&&oaAvailable()&&remoteLoaded)void refreshRemote();};nav.append(tab);}
  app.append(header,status,nav);if(activeView!=='remote'&&errors.textContent)app.append(errors);if(requestProgress&&activeView!=='remote'&&state.clone?.state!=='running')app.append(progressNode(requestProgress.label,requestProgress.percent,requestProgress.note));
  if(['code','recovery'].includes(activeView)&&!state.repo){const empty=el('div',undefined,'sg-empty');empty.append(el('h3',activeView==='recovery'?'源码恢复需先打开项目':'先打开一个项目'),el('p',activeView==='recovery'?'选择本地项目后可恢复源码；下方镜像恢复无需打开本地项目。':'选择本地项目或克隆团队 '+collaborationBranch()+' 分支，即可开始协作。','sg-muted'));const open=el('button','选择项目','sg-primary');open.onclick=()=>{activeView='project';render();};empty.append(open);app.append(empty);}
 }
 function row(...nodes){const n=el('div',undefined,'sg-row');n.append(...nodes);return n;}
 function external(label,url){const n=el('a',label);try{const u=new URL(url);if(u.protocol==='https:'&&u.hostname==='github.com'){n.href=u.href;n.target='_blank';n.rel='noopener noreferrer';}}catch{}return n;}
 async function run(action){if(state.busy||state.clone?.state==='running'||disposed)return;state.busy=true;requestProgress=null;message('');render();try{await action();}catch(e){message(e.message,true);}finally{state.busy=false;if(!disposed){render();if(focusSourcePreview){focusSourcePreview=false;sourcePreviewAnchor?.scrollIntoView?.({block:'start'});sourcePreviewAnchor?.focus?.({preventScroll:true});}}}}
 let configuration=null;
 let sshConfiguration=null,sshCandidate='',sshKeyCandidates=[];
 const sshFingerprint=value=>typeof value==='string'&&/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(value);
 function renderSshConfiguration(){
  if(!oaAvailable()||activeView!=='settings')return;
  const box=section('发布服务器连接');
  box.append(el('p','使用 DSH 宿主系统 SSH，无需单独安装 SSH 插件。仅保存 SSH 用户名和本机私钥绝对路径；不上传私钥、不保存口令，公钥应交给管理员配置。加密私钥请先通过系统 ssh-agent 解锁。','sg-muted'));
  box.append(button('读取连接配置',async()=>{const config=await api('/ssh-config-read',{});if(disposed)return;sshConfiguration=config;sshCandidate='';for(const key of ['user','privateKeyPath'])if(!drafts.has('ssh-'+key))drafts.set('ssh-'+key,config[key]||'');}));
  if(!sshConfiguration)return;
  for(const [key,label] of [['host','服务器地址（只读）'],['port','SSH 端口（只读）']]){const field=el('input');field.value=String(sshConfiguration[key]??'');field.readOnly=true;field.setAttribute('aria-label',label);box.append(el('p',label),field);}
  const user=input('SSH 用户名',undefined,'ssh-user');user.setAttribute('aria-label','SSH 用户名');
  const keyPath=input('本机私钥绝对路径',undefined,'ssh-privateKeyPath');keyPath.setAttribute('aria-label','本机私钥绝对路径');keyPath.autocomplete='off';keyPath.spellcheck=false;
  // Reject pasted key material before retaining it in the in-memory form drafts.
  keyPath.oninput=()=>{if(/[\r\n\0]|-----BEGIN|^(?:ssh-|ecdsa-|sk-)/i.test(keyPath.value)){keyPath.value=drafts.get('ssh-privateKeyPath')||'';message('这里只接受私钥文件的绝对路径，不接受公钥或私钥正文。',true);return;}drafts.set('ssh-privateKeyPath',keyPath.value);};
  box.append(el('p','SSH 用户名'),user,el('p','本机私钥绝对路径（不是私钥正文）'),keyPath);
   box.append(button('自动查找私钥路径',async()=>{sshKeyCandidates=[];const result=await api('/ssh-key-discover',{});if(disposed)return;if(!Array.isArray(result.candidates)||result.candidates.length>64||!result.candidates.every(c=>c&&typeof c.privateKeyPath==='string'&&/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(c.privateKeyPath)&&!/[\r\n\0]|-----BEGIN/.test(c.privateKeyPath)))throw new Error('私钥候选路径响应无效。');sshKeyCandidates=result.candidates;const current=drafts.get('ssh-privateKeyPath')||'';if(sshKeyCandidates.length===1&&!current){drafts.set('ssh-privateKeyPath',sshKeyCandidates[0].privateKeyPath);message('已填入唯一候选路径；尚未保存，请确认该密钥用于发布服务器。');}else message(sshKeyCandidates.length?'找到 '+sshKeyCandidates.length+' 个候选路径，请选择用于发布服务器的密钥；不会自动保存或连接。':'未找到通过安全检查的候选私钥；可手动填写绝对路径。');}));
   for(const candidate of sshKeyCandidates)box.append(button('使用路径：'+candidate.privateKeyPath,async()=>{drafts.set('ssh-privateKeyPath',candidate.privateKeyPath);message('候选路径已填入，尚未保存；请确认后保存连接配置。');}));
   box.append(el('p','仅查找本机 SSH 配置及常见位置，不读取私钥正文；候选文件不代表已获得服务器授权。','sg-muted'));
  box.append(el('p',sshConfiguration.configured?'连接配置已保存。':'尚未完成连接配置。','sg-muted'));
  box.append(el('p',sshConfiguration.trusted?'已信任服务器指纹：'+sshConfiguration.fingerprint:'服务器尚未信任；必须先联系管理员核对 SHA256 指纹。','sg-muted'));
  if(sshCandidate)box.append(el('p','未信任候选指纹：'+sshCandidate,'sg-warning'));
  const save=button('保存连接配置',async()=>{const username=user.value.trim(),privateKeyPath=keyPath.value.trim();if(!/^[a-z_][a-z0-9_-]*$/.test(username)||username==='root')throw new Error('请填写有效的非 root SSH 用户名（小写字母、数字、下划线或连字符）。');if(!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(privateKeyPath)||/[\r\n\0]|-----BEGIN/.test(privateKeyPath))throw new Error('请填写本机私钥文件的绝对路径，不接受公钥或私钥正文。');const config=await api('/ssh-config-save',{user:username,privateKeyPath});if(disposed)return;sshConfiguration=config;sshCandidate='';drafts.set('ssh-user',username);drafts.set('ssh-privateKeyPath',privateKeyPath);message('发布服务器连接配置已保存。');},true);
  const scan=button('获取指纹',async()=>{sshCandidate='';const result=await api('/ssh-host-scan',{});if(disposed)return;if(!sshFingerprint(result.fingerprint))throw new Error('服务器未返回有效的 SHA256 指纹，不能信任。');if(sshConfiguration.trusted&&sshConfiguration.fingerprint!==result.fingerprint)throw new Error('服务器 SSH 指纹已变化，已拒绝信任。请联系管理员核实；不会覆盖原有信任。');sshCandidate=result.fingerprint;message('已获取候选指纹；尚未信任，请向管理员核对 SHA256。');});
  const trust=button('核对后信任',async()=>{const fingerprint=sshCandidate;if(!sshFingerprint(fingerprint)||sshConfiguration.trusted)return;if(!confirm('首次信任发布服务器 '+sshConfiguration.host+':'+sshConfiguration.port+'？\n请务必通过可信渠道让管理员核对以下 SHA256 指纹，完全一致后才点击确定：\n'+fingerprint+'\n未核对或不一致请取消；指纹变化将拒绝连接。'))return;const config=await api('/ssh-host-trust',{fingerprint});if(disposed)return;sshConfiguration=config;sshCandidate='';message('已保存服务器信任；可测试连接。');});trust.disabled=trust.disabled||!sshCandidate||sshConfiguration.trusted;
  const test=button('测试连接',async()=>{if(!sshConfiguration.configured||!sshConfiguration.trusted)throw new Error('请先保存连接配置，并向管理员核对后信任服务器指纹。');const result=await api('/ssh-connection-test',{});if(!disposed)message(result.message||'只读连接测试成功；未执行部署。');});test.disabled=test.disabled||!sshConfiguration.configured||!sshConfiguration.trusted;
  box.append(row(save,scan,trust,test),el('p','测试仅执行只读 overview，不会发布或修改服务器。输入修改后请先保存，再测试已保存配置。','sg-muted'));
 }
 function renderGithubAdministration(){
  if(!state.githubAdministrator){configuration=null;return;}
  const box=section('GitHub 管理后台');
  box.append(el('p','配置随安装包分发；保存后须重载插件才影响当前操作。普通成员不能通过后台修改。','sg-muted'));
  box.append(button('读取包内配置',async()=>{configuration=await api('/github-config-read',{});for(const key of ['repository','branch','updateRepository','cloneMode','cloneBranch'])drafts.set('admin-'+key,configuration.config[key]??(key==='cloneMode'?'single':key==='cloneBranch'?configuration.config.branch:''));}));
  if(!configuration)return;
  const fields={};for(const [key,label] of [['repository','项目 GitHub 仓库地址'],['branch','协作分支'],['updateRepository','插件更新 GitHub 仓库地址']]){const field=input(label,undefined,'admin-'+key);field.setAttribute('aria-label',label);fields[key]=field;box.append(el('p',label),field);}
  const mode=el('select');mode.sgDraftKey='admin-cloneMode';mode.setAttribute('aria-label','克隆范围');for(const [value,label] of [['single','仅指定分支'],['all','全部远程分支']]){const option=el('option',label);option.value=value;mode.append(option);}mode.value=drafts.get('admin-cloneMode')||'single';mode.disabled=state.busy||state.clone?.state==='running';mode.onchange=()=>drafts.set('admin-cloneMode',mode.value);fields.cloneMode=mode;
  const cloneBranch=input('单分支克隆时检出的分支',undefined,'admin-cloneBranch');cloneBranch.setAttribute('aria-label','克隆分支');fields.cloneBranch=cloneBranch;box.append(el('p','克隆范围'),mode,el('p','克隆分支（仅单分支克隆使用）'),cloneBranch,el('p','全部模式获取全部远程分支并检出协作分支；单分支模式检出克隆分支，之后协作仍使用上方协作分支。只影响以后新克隆，不改写已有项目。','sg-muted'));
  box.append(button('保存包内配置',async()=>{if(!confirm('保存仓库、分支和插件更新来源？重载后生效。分发前请从已保存配置的插件目录打包；不会自动上传。'))return;const config=Object.fromEntries(Object.entries(fields).map(([key,field])=>[key,field.value.trim()]));configuration=await api('/github-config-save',{config,revision:configuration.revision,confirmed:true});message(configuration.message);},true));
  if(configuration.reloadRequired)box.append(el('p','包内配置与当前运行配置不同，请重载；打包将使用已保存的配置。','sg-warning'));
 }
  let update=null,updatePhase='',updateResult=null;
  const remindedVersions=new Set();
  async function remindUpdate(candidate){
   if(disposed||!candidate?.available||!candidate.version||remindedVersions.has(candidate.version))return;
   remindedVersions.add(candidate.version);
   if(confirm('GitHub 协作插件有新版本 '+candidate.version+'。\n当前版本：'+(candidate.currentVersion||'未知')+'\n点击确定将立即下载、校验并安装你信任的更新包；取消则继续使用。请先确认所有 Agent 任务结束、没有其他插件操作。安装可能重载面板，或需手动重启 DSH，不会自动重启。')){activeView='settings';await installUpdate(candidate);}
  }
  const reconciliation=options.autoInstaller?.reconcile().then(record=>{if(record&&!disposed){updateResult={text:record.message,failed:record.state==='unknown'};render();}}).catch(()=>{});
  async function checkUpdate(){
   update=null;updateResult=null;updatePhase='checking';render();
   try{const result=await api('/update-check',{});if(disposed)return;update=result;updateResult={text:result.available?'发现可用更新，请先阅读版本更新说明。':'检查完成，当前没有可用更新。',failed:false};}
   catch(error){update=null;updateResult={text:'更新检查失败：'+error.message,failed:true};}
   finally{updatePhase='';}
   if(!disposed){render();await remindUpdate(update);}
  }
  async function installUpdate(confirmedCandidate){
   if(updatePhase==='installing')return;
   const candidate=update;if(!candidate?.available||!candidate.checkId)return;
   if(confirmedCandidate!==candidate&&!confirm('确认更新到 '+candidate.version+'？将下载、校验并自动安装你信任的更新包。请确认所有 Agent 任务结束、没有其他插件操作。更新可能重载面板，或需要手动重启 DSH；不会自动重启。')){updateResult={text:'已取消安装更新，未发起安装请求。',failed:false};return;}
   updatePhase='installing';updateResult=null;render();
   try{const result=await api('/update-install',{checkId:candidate.checkId,confirmed:true});if(disposed)return;
    update=null;
    if(result.manualInstallPath&&options.autoInstaller){
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

  async function refreshStatus(generation){const s=await api('/status');if(disposed||(typeof generation==='number'&&generation!==loginGeneration))return;Object.assign(state,{user:s.user,csrfToken:s.csrfToken,ghAvailable:s.ghAvailable,platformInfo:s.environment,project:s.project,githubAdministrator:s.githubAdministrator===true,oaDeploymentAvailable:s.oaDeploymentAvailable!==false});}
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
  if(disposed)return;if(activeView==='recovery'&&state.user?.name!=='刘道志')activeView='project';if(activeView==='remote'&&!oaAvailable())activeView='project';const focused=app.contains(document.activeElement)?document.activeElement:null;const focusKey=focused?.sgDraftKey,selection=focused&&typeof focused.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;for(const node of app.querySelectorAll?.('details')||[]){if(node.sgDisclosureKey)disclosureState.set(node.sgDisclosureKey,node.open);}app.replaceChildren();renderHeader();
  const host=state.platformInfo,isWindows=host?.isWindows===true,isMac=host?.platform==='darwin';
  const account=section('1 · GitHub 账号');
  account.append(el('p','DSH 宿主系统：'+(host?.label||'尚未检测')+'（以运行 DSH 的电脑为准，不是浏览器系统）','sg-muted'));
  if(state.user){account.append(row(el('strong','已登录：'+(state.user.name?state.user.name+'（@'+state.user.login+'）':state.user.login)),button('刷新',refreshStatus),button('退出登录',async()=>{if(!confirm('退出本机 GitHub CLI 的当前账号？这也会影响其他使用 gh 的工具。'))return;++loginGeneration;clearTimeout(timer);await api('/logout',{});await refreshStatus();message('已退出登录。');})));}
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
  renderEnvironmentSetup();
   const project=section('2 · 项目');
  const pathExample=isWindows?'C:\\Users\\你的名字\\Projects\\XiAN-OA':isMac?'/Users/你的名字/Projects/XiAN-OA':'/home/你的名字/Projects/XiAN-OA';
  const dirPlaceholder='项目文件夹绝对路径，例如 '+pathExample;const dir=input(dirPlaceholder,drafts.get('project-directory')??state.directory,'project-directory');
  dir.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();void run(()=>openProject(dir.value));}};
   project.append(row(dir,button('选择目录',()=>pickDirectory(dir,true),true)));
  const details=disclosure('clone-form');details.append(el('summary','还没有项目？克隆 GitHub 仓库'));
  const parent=input('保存到哪个已有文件夹（绝对路径），例如 '+(isWindows?'C:\\Users\\你的名字\\Projects':isMac?'/Users/你的名字/Projects':'/home/你的名字/Projects'),undefined,'clone-parent');
  const cloneDescription=state.project?.cloneMode==='all'?'团队项目已预设，获取全部远程分支并检出 '+collaborationBranch()+' 分支；不会创建或检出所有本地分支。':'团队项目已预设，只克隆 '+(state.project?.cloneBranch||collaborationBranch())+' 分支并直接打开；协作分支为 '+collaborationBranch()+'。';
  details.append(el('p',cloneDescription+'请选择保存位置，会在该位置新建项目文件夹。','sg-muted'),row(parent,button('选择目录',()=>pickDirectory(parent))),button('克隆并打开',async()=>{if(!confirm('将团队项目克隆到 '+parent.value+' 下？'))return;const result=await api('/clone',{parentDirectory:parent.value.trim()});state.clone={...result,phase:'正在连接 GitHub…',percent:null,log:''};message('正在克隆，请勿关闭应用。');void pollClone(result.id);},true));project.append(details);
  if(state.clone){const c=state.clone,done=c.state==='success';const progressBox=el('section');progressBox.setAttribute('aria-live','polite');progressBox.append(el('h3',c.state==='running'?'正在克隆…':done?'✓ 克隆完成':'克隆失败'));
    if(done)progressBox.append(el('p','仓库已下载完成。保存位置：'+c.directory));else progressBox.append(el('p',displayText(c.phase||'正在连接 GitHub…')));
    if(!done){const bar=el('progress');bar.max=100;bar.style.width='100%';bar.value=c.percent??0;
    progressBox.append(bar,el('p',c.state==='error'?'克隆未完成，请查看错误信息':c.percent==null?'等待服务器返回进度…':'当前阶段：'+c.percent+'%（各阶段独立计数）','sg-muted'));}
    if(!done&&c.log){const logs=disclosure('clone-logs');logs.append(el('summary','查看克隆日志'));const pre=el('pre',displayText(c.log).replace(/\r\n?/g,'\n'));pre.style.whiteSpace='pre-wrap';pre.style.overflowWrap='anywhere';pre.style.maxHeight='240px';logs.append(pre);progressBox.append(logs);}project.append(progressBox);}
   if(state.repo){
   const repo=state.repo;project.append(el('p','团队项目 · 当前分支：'+repo.branch,'sg-muted'));
    renderCode(repo);
  }
  renderRemoteDeploy();
  renderUpdate();
  renderGithubAdministration();
   renderSshConfiguration();
   app.setAttribute('aria-busy',String(state.busy));if(focusKey&&!state.busy){const target=[...(app.querySelectorAll?.('input,textarea')||[])].find(n=>n.sgDraftKey===focusKey);target?.focus();if(selection)target?.setSelectionRange(...selection);}
 }
  let remotePlan=null,dockerPreview=null,dockerJob=null,remoteTimer,remoteLoading=false,remoteLoaded=false,remoteFailures=0,remoteHistory=[],remoteReleaseId=null,remotePhase='',remoteProblem='',remoteSubmissionError='',remoteUncertain=false,remotePriorJob=null,remoteSubmittedAt=0;
  const remoteActive=job=>['pending','running','building','uploading','deploying','checking'].includes(job?.status);
  const databaseBlocked=job=>job?.stage==='db-restore-failed'||job?.database?.status==='restore-failed';
   const remoteBlocked=(environment='test')=>environment==='test'&&((dockerJob?.environment==='test'&&databaseBlocked(dockerJob))||remoteHistory.some(job=>job.environment==='test'&&databaseBlocked(job)));
   const stageNames={'db-preflight':'数据库发布前检查','db-maintenance':'进入数据库维护','db-backup':'备份 test 数据库','db-backup-verify':'校验数据库备份','db-backup-cleanup':'清理过期数据库备份','db-migrating':'同步数据库结构','db-restoring':'恢复 test 数据库','db-restored':'数据库已恢复（发布失败）','db-restore-failed':'数据库恢复失败（维护中，禁止重试）',preparing:'准备源码',uploading:'上传源码',pending:'等待服务器',building:'服务器编译',applying:'更新服务',deploying:'更新服务',checking:'健康检查',health:'健康检查','awaiting-acceptance':'部署成功',accepted:'业务验收已登记',failed:'部署失败',uncertain:'结果待核对',ready:'部署成功'};
  function jobLabel(job){if(['pending','running','uncertain'].includes(job?.status)){if(job.activity?.state==='interrupted')return '上次发布已中断，待核对';if(job.activity?.state==='active')return (job.actor||'其他成员')+'正在发布 · '+(stageNames[job.stage]||'服务器执行');return job.status==='uncertain'?'发布结果待核对':'服务器记录：'+(stageNames[job.stage]|| (job.status==='pending'?'等待服务器':'执行中'));}if(job?.accepted||job?.status==='delivered')return '部署成功';if(job?.status==='failed')return '部署失败 · '+(stageNames[job.stage]||job.stage||'服务器执行');if(job?.status==='uncertain')return '结果待核对';return stageNames[job?.stage]||({delivered:'部署成功',accepted:'业务验收已登记',failed:'部署失败',uncertain:'结果待核对',running:'服务器执行中',pending:'等待服务器'}[job?.status])||'等待状态';}
  function rememberRemote(job){if(!job?.jobId)return;dockerJob=job;remoteHistory=[job,...remoteHistory.filter(x=>x.jobId!==job.jobId)].slice(0,20);}
  function scheduleRemote(){clearTimeout(remoteTimer);if(!disposed&&['remote','recovery'].includes(activeView)&&(remoteActive(dockerJob)||remoteHistory.some(remoteActive)||remoteUncertain||remoteFailures>0)&&remoteFailures<5)remoteTimer=setTimeout(()=>void refreshRemote(),3000);}
  async function refreshRemote(){
   if(disposed||!oaAvailable()||remoteLoading||!state.csrfToken)return;remoteLoading=true;
   try{const overview=await api('/docker-overview',{});if(disposed)return;
    remoteHistory=Array.isArray(overview.jobs)?overview.jobs.slice(0,20):[];remoteReleaseId=overview.releaseId||null;
    const current=remoteHistory.find(j=>j.jobId===dockerJob?.jobId);if(current)dockerJob=current;else if(!dockerJob&&remoteHistory[0])dockerJob=remoteHistory[0];
    const submitted=remoteUncertain?remoteHistory.find(j=>j.jobId!==remotePriorJob&&j.createdAt>=remoteSubmittedAt):null;if(submitted)dockerJob=submitted;
    if(remoteUncertain&&submitted?.jobId){dockerJob=await api('/docker-reconcile',{jobId:dockerJob.jobId});if(disposed)return;rememberRemote(dockerJob);if(dockerJob?.jobId===submitted.jobId&&['delivered','failed'].includes(dockerJob.status)){remoteUncertain=false;remoteSubmissionError='';}}
    remoteLoaded=true;remoteFailures=remoteUncertain?remoteFailures+1:0;remoteProblem=remoteUncertain?'提交结果仍未确认，请勿重复发布。尚未找到本次新任务，请联系管理员核对。'+(remoteSubmissionError?' 原始提交错误：'+remoteSubmissionError:''):'';
   }catch(error){if(!disposed){remoteFailures++;remoteProblem='状态获取失败：'+error.message+'。不会自动重发部署；请恢复连接后核对。'+(remoteUncertain&&remoteSubmissionError?' 原始提交错误：'+remoteSubmissionError:'');}}
   finally{remoteLoading=false;if(!disposed){render();scheduleRemote();}}
  }
   const canManageRelease=()=>['刘道志','於天晨'].includes(state.user?.name);
  async function publishRemote(environment){
    if(!oaAvailable())return;
   if(environment==='test'&&!canManageRelease())return;
   if(remotePhase||remoteActive(dockerJob)||remoteHistory.some(remoteActive)||remoteUncertain||remoteBlocked(environment))return;
   remotePhase='正在获取发布计划';remoteProblem='';render();
   try{
    if(environment==='test'){await refreshRemote();if(!remoteReleaseId)throw new Error('没有可发布的成功 dev 版本，或当前 SSH 账号无 test 发布权限。dev 启动成功即可，无需登记业务验收。');}
     const plan=await api(environment==='dev'?'/docker-plan':'/docker-promote',environment==='dev'?{}:{releaseId:remoteReleaseId});if(disposed)return;
    if(!plan.planId)throw new Error('服务器没有返回有效发布计划');
     const version=plan.head||plan.remote?.head;
     if(!confirm('确认发布到 '+environment+' 环境？\n'+(environment==='test'?'使用已成功部署的 dev 程序版本和绑定的数据库结构快照，不复制 dev 业务数据；先备份 test 数据库，再同步结构。':'服务器拉取源码并编译发布。')+'\n版本：'+(version?version.slice(0,12):'成功 dev 同版本')+'\n程序启动时按项目配置执行数据库更新，不会用 dev 数据覆盖 test。\n如需回退程序，数据库变更不会自动撤销。'))return;
    remotePriorJob=dockerJob?.jobId||null;remoteSubmittedAt=Math.floor(Date.now()/1000);remotePhase=environment==='dev'?'正在获取并上传源码（不在本机编译）':'正在提交同镜像发布';render();
    try{const result=await api('/docker-start',{planId:plan.planId,confirmation:true,databaseRiskAccepted:true});if(disposed)return;rememberRemote(result);}
    catch(error){remoteUncertain=true;remoteSubmissionError=error.message;remoteProblem='提交响应未确认：'+remoteSubmissionError+'。禁止重复发布，请先核对服务器任务。';}
   }catch(error){if(!disposed)remoteProblem='发布未启动：'+error.message;}finally{remotePhase='';if(!disposed){render();scheduleRemote();}}
  }
  async function restoreRemote(job){
    if(!oaAvailable())return;
   if(!canManageRelease())return;
   if(remotePhase||remoteActive(dockerJob)||remoteHistory.some(remoteActive)||remoteUncertain||remoteBlocked(job.environment))return;
   const environment=job.environment;remotePhase='正在核对历史版本镜像';remoteProblem='';render();
   try{
    const plan=await api('/docker-restore',{environment,jobId:job.jobId});if(disposed)return;
    if(!plan.planId)throw new Error('服务器没有返回有效恢复计划');
    if(!confirm('确认将 '+environment+' 恢复到版本 '+(job.head?.slice(0,12)||'—')+'？\n原发布人：'+(job.actor||'服务器记录')+'\n复用该环境历史镜像，不重新编译，不影响另一个环境。\n仅恢复程序，数据库变更不会自动撤销；旧程序可能与现有数据库不兼容。'))return;
    remotePriorJob=dockerJob?.jobId||null;remoteSubmittedAt=Math.floor(Date.now()/1000);remotePhase='正在提交 '+environment+' 版本恢复';render();
    try{const result=await api('/docker-start',{planId:plan.planId,confirmation:true,databaseRiskAccepted:true});if(disposed)return;rememberRemote(result);}
    catch(error){remoteUncertain=true;remoteSubmissionError=error.message;remoteProblem='恢复提交响应未确认：'+remoteSubmissionError+'。禁止重复操作，请先核对服务器任务。';}
   }catch(error){if(!disposed)remoteProblem='恢复未启动：'+error.message;}finally{remotePhase='';if(!disposed){render();scheduleRemote();}}
  }
  function environmentLink(environment){const link=el('a','打开 '+environment+' 网站 ↗');link.href=environment==='dev'?'http://119.45.50.213:18081/':'http://119.45.50.213/';link.target='_blank';link.rel='noopener noreferrer';return link;}
  function renderRemoteDeploy(){
    if(!oaAvailable())return;
   const box=section('dev 远程部署');box.className='sg-remote-deploy';box.children[0].textContent='远程部署';
   const help=disclosure('release-help');help.append(el('summary','发布说明与权限'),el('p','dev：普通 SSH 成员可发布；test 与历史恢复按钮：仅刘道志、於天晨显示；test 复用成功 dev 镜像及其绑定结构快照，先备份 test 数据库再同步结构，不复制 dev 业务数据。两环境数据库独立；历史恢复只切换程序，受数据库兼容性审查限制；发布失败后的数据库恢复不代表发布成功。','sg-muted'));box.append(help);
   const dev=button('发布 dev',()=>publishRemote('dev'),true),test=button('发布 test',()=>publishRemote('test'));
   if(remotePhase||remoteActive(dockerJob)||remoteHistory.some(remoteActive)||remoteUncertain){dev.disabled=true;test.disabled=true;}
    if(remoteBlocked())test.disabled=true;
   box.append(canManageRelease()?row(dev,test):row(dev));
    if(oaAvailable()){box.append(row(environmentLink('dev'),environmentLink('test')));help.append(el('p','网站链接访问当前环境，不一定是所选历史版本。','sg-muted'));}
   const status=el('div',undefined,'sg-release-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
   status.append(el('h4','部署情况'));
   if(remotePhase||(!remoteProblem&&!remoteUncertain&&remoteActive(dockerJob)&&dockerJob?.activity?.state==='active')){const percent=remotePhase?10:({'db-preflight':30,'db-maintenance':35,'db-backup':40,'db-backup-verify':50,'db-backup-cleanup':55,'db-migrating':65,'db-restoring':70,preparing:10,uploading:20,pending:25,building:40,applying:75,deploying:75,health:90,checking:90}[dockerJob?.stage]??10);status.append(progressNode('发布阶段',percent,'阶段进度，不代表构建耗时或传输字节比例；健康检查通过后才完成。'));}else if(!remoteProblem&&!remoteUncertain&&dockerJob?.status==='delivered')status.append(progressNode('发布完成',100,'服务器已确认交付成功。'));
   if(remotePhase)status.append(el('p',remotePhase));
   if(remoteProblem)status.append(renderSchemaRefusal(displayText(remoteProblem),el,disclosure)||el('p',errorFeedback(displayText(remoteProblem)).detail,'sg-warning'));
   if(remoteBlocked())status.append(el('p','数据库恢复失败，test 仍处于维护中，禁止重试 test 发布或 test 历史恢复；请联系管理员核对并人工恢复。','sg-warning'));
    if(dockerJob){
     if(remoteProblem||remoteUncertain||remotePhase)status.append(el('p','以下为此前任务记录，不代表本次操作结果。','sg-muted'));
    status.append(el('strong',(dockerJob.environment||'dev')+' · '+jobLabel(dockerJob)),el('p','版本 '+(dockerJob.head?.slice(0,12)||'—')+' · 发布人 '+(dockerJob.actor||dockerJob.user||'服务器记录')+' · '+(dockerJob.createdAt?new Date(dockerJob.createdAt*1000).toLocaleString():'时间待确认'),'sg-muted'));
    if(['pending','running','uncertain'].includes(dockerJob.status)&&dockerJob.activity?.state!=='active'&&dockerJob.activity?.state!=='interrupted')status.append(el('p',dockerJob.activity?'进程活动暂时无法确认；以上阶段来自服务器任务记录，不代表已核验进程仍在执行。':'当前服务器暂不支持进程活动核验；以上阶段来自服务器任务记录。','sg-muted'));
     if(typeof dockerJob.elapsedSeconds==='number')status.append(el('p','耗时 '+Math.round(dockerJob.elapsedSeconds)+' 秒','sg-muted'));
    if(dockerJob.stage==='db-restored'||dockerJob.database?.status==='restored')status.append(el('p','test 数据库已恢复，但本次发布仍然失败；请先排查失败原因，不要将数据库恢复视为发布成功。','sg-warning'));
     if(dockerJob.database?.backup?.id)status.append(el('p','数据库备份：'+dockerJob.database.backup.id+(Number.isSafeInteger(dockerJob.database.backup.createdAt)&&dockerJob.database.backup.createdAt>=0&&dockerJob.database.backup.createdAt<=253402300799?' · '+new Date(dockerJob.database.backup.createdAt*1000).toLocaleString():''),'sg-muted'));
     if(!remoteProblem&&['failed','uncertain'].includes(dockerJob.status))status.append(el('p',dockerJob.errorSummary||'服务器执行未确认成功。请复制排查信息，联系管理员按任务编号查看受控日志。','sg-warning'));
   }else if(!remotePhase)status.append(el('p',remoteLoaded?'暂无部署记录':'打开后自动读取服务器部署状态','sg-muted'));
   if(dockerJob||remoteSubmissionError){
    const detail=disclosure('release-diagnostics');detail.append(el('summary','排查信息'));
    const info=JSON.stringify({...(dockerJob?{jobId:dockerJob.jobId,environment:dockerJob.environment,head:dockerJob.head,status:dockerJob.status,stage:dockerJob.stage,activity:dockerJob.activity,database:dockerJob.database,errorCode:dockerJob.errorCode,errorSummary:dockerJob.errorSummary,errorDetails:dockerJob.errorDetails}:{}),...(remoteSubmissionError?{submissionError:remoteSubmissionError,submissionUncertain:remoteUncertain,priorJobId:remotePriorJob,submittedAt:remoteSubmittedAt}:{})},null,2);
    detail.append(el('pre',info),button('复制排查信息',async()=>{if(!globalThis.navigator?.clipboard?.writeText)throw new Error('剪贴板不可用，请展开排查信息手动复制。');await navigator.clipboard.writeText(info);message('排查信息已复制。');}));status.append(detail);
   }
   if(remoteProblem||remoteUncertain||dockerJob?.status==='uncertain')status.append(button('重新核对状态',async()=>{if(!remoteUncertain&&dockerJob?.jobId)rememberRemote(await api('/docker-reconcile',{jobId:dockerJob.jobId}));remoteFailures=0;await refreshRemote();}));
   const recovery=section('历史镜像恢复');recovery.append(el('p','仅回退服务器运行镜像，不恢复源码或数据库；旧程序必须兼容当前数据库。','sg-muted'),button('刷新镜像历史',refreshRemote));
   if(activeView==='recovery')recovery.append(status);else box.append(status);
    for(const environment of ['dev','test']){const jobs=remoteHistory.filter(job=>job.environment===environment&&job.status==='delivered'&&job.head);if(!jobs.length)continue;const history=disclosure('release-history-'+environment);history.className='sg-release-history';history.append(el('summary',environment+' 版本历史（'+jobs.length+'）'));for(const job of jobs){const entry=el('div',undefined,'sg-release-history-row');const restore=button('恢复到此版本',()=>restoreRemote(job));restore.disabled=state.busy||!!remotePhase||remoteActive(dockerJob)||remoteHistory.some(remoteActive)||remoteUncertain||remoteBlocked(environment);const info=el('div',undefined,'sg-release-history-info');info.append(el('code',job.head.slice(0,12),'sg-release-version'),el('span',job.actor||'服务器记录','sg-release-actor'),el('time',job.createdAt?new Date(job.createdAt*1000).toLocaleString('zh-CN',{hour12:false}):'时间待确认','sg-release-time'));entry.append(info);if(canManageRelease())entry.append(restore);history.append(entry);}recovery.append(history);}
   if(['remote','recovery'].includes(activeView)&&!remoteLoaded&&!remoteLoading&&!remoteFailures&&!state.busy)queueMicrotask(()=>void refreshRemote());
  }
  function renderEnvironmentSetup(){
    if(!oaAvailable())return;
   const box=section('开发环境初始化');box.append(el('p','首次使用？先检测运行 DSH 的电脑，再请当前会话的 AI 帮你配置。无需先安装 Git、登录或打开项目。检测不会安装软件。','sg-muted'));
   box.append(row(button('检测开发环境',async()=>{environment=await api('/environment-inspect',{});message('开发环境检测完成；检测到工具不代表项目已能运行，请核对版本要求。');},true),button('请 AI 帮我配置',async()=>{
    const sessionId=options.getSessionId?.();if(!sessionId)throw new Error('请先打开并保持当前 AI 会话，再发送环境初始化请求。');
    if(!confirm('将重新检测 DSH 宿主的系统、架构及开发工具版本，并发送到当前 AI 会话。AI 会先核对配置方案；安装软件、管理员权限或修改系统设置仍需本人确认。不自动配置数据库、克隆或启动项目。是否发送？'))return;
    if(options.getSessionId?.()!==sessionId)throw new Error('当前会话已切换，请在目标会话重新发送。');
    if(!environmentRequest||environmentRequest.sessionId!==sessionId)environmentRequest={sessionId,requestId:globalThis.crypto.randomUUID()};
    const result=await api('/environment-notify',environmentRequest);message(result.duplicate?'此初始化请求已发送，请查看当前 AI 会话。':'已发送到当前 AI 会话，请按 AI 提示确认操作；完成后点击“检测开发环境”重新验证。');environmentRequest=null;
   })));
   if(environment){box.append(el('p','DSH 宿主：'+environment.platform+' · '+environment.arch,'sg-muted'));const list=el('ul');for(const tool of environment.tools||[])list.append(el('li',tool.label+' · '+(tool.available?(tool.version||'已检测到'):'未检测到')+(tool.required?'':'（按需）')));box.append(list);for(const item of environment.requirements||[])if(!item.satisfied)box.append(el('p',item.label,'sg-warning'));}
   box.append(el('p','仅发送工具与版本信息，不发送密码、Token 或完整环境变量。新安装工具可能需要重启 DSH 才能识别；数据库连接请单独向负责人确认。','sg-muted'));
  }
  function expected(repo){return {expectedHead:repo.head,expectedFingerprint:repo.fingerprint,expectedBranch:repo.branch,expectedRepository:repo.repository,expectedBaseBranch:repo.baseBranch};}
 function loading(box,text){const node=el('div');node.setAttribute('role','status');node.append(el('p',text));box.append(node);}
function renderSourceRestore(repo){
  const branch=collaborationBranch(),box=section('历史源码恢复'),onBranch=repo.branch===branch;
  box.append(el('p',`选择 ${branch} 的历史提交，将完整源码快照作为新的恢复提交推送，再覆盖本地受管文件。不合并当前代码，不强推，不自动部署或回退数据库。`,'sg-muted'));
  const refresh=button('读取历史提交',()=>loadSourceHistory());refresh.disabled=refresh.disabled||!onBranch;box.append(refresh);
  if(!onBranch){box.append(el('p',`请先切换到 ${branch}，再读取和恢复历史源码。`,'sg-warning'));return;}
  if(sourcePreview){
   const preview=sourcePreview;
   sourcePreviewAnchor=el('p',`恢复目标：${preview.target}`);sourcePreviewAnchor.setAttribute('tabindex','-1');
   box.append(sourcePreviewAnchor,el('p',`将更新远程 ${preview.repository} / ${preview.branch}，并覆盖本地 ${repo.directory} 的受管源码。`,'sg-warning'));
   for(const [label,items] of [['远程代码差异',preview.changes],['本地受管文件覆盖清单',preview.localOverwriteChanges||[]],['本地未提交状态（受管修改将被覆盖，未跟踪文件保留）',preview.localChanges]]){
    const details=disclosure('source-restore-'+label);details.append(el('summary',label+'（'+items.length+' 项）'));const list=el('ul');for(const item of items)list.append(el('li',item.status+'  '+item.path));details.append(list);box.append(details);
   }
   box.append(el('p','本地受管文件的未提交修改会被丢弃；本地独有提交不合入恢复结果。未跟踪及忽略文件不主动删除，若与目标路径冲突则拒绝。Git 历史保留。请停止其他程序对该项目的写入。','sg-warning'));
   box.append(row(button('确认恢复并覆盖本地',async()=>{
    if(!confirm(`确认将 ${preview.repository} 的 ${preview.branch} 恢复到 ${preview.target} 的完整源码？\n远程将新增恢复提交，不合并当前代码；本地受管修改将丢弃并覆盖。\n未跟踪及忽略文件保留，路径冲突会停止。服务器镜像和数据库不变。`))return;
    sourcePreview=null;sourceHistory=null;state.diff=null;state.pushResult=null;state.pullResult=null;
    try{const result=await api('/source-restore',{directory:repo.directory,previewId:preview.previewId,confirmedOverwrite:true});
     sourceResult=result.needsAction||!result.localUpdated||!result.remoteUpdated?{text:`恢复尚未全部完成：${result.message||'请核对状态'}\n远程：${result.remoteUpdated===true?'已更新':result.remoteUpdated===false?'未确认更新':'结果未知'}；本地：${result.localUpdated?'已更新':'未完成'}。恢复提交：${result.head||'待核对'}。不要直接再次恢复或点击拉取合并，请先核对远程与本地。`,failed:true}:{text:`✓ 远程 ${branch} 与本地受管源码已恢复为目标快照。恢复提交：${result.head}。未部署、未修改数据库。`,failed:false};
    }catch(error){sourceResult={text:'恢复结果未确认：'+error.message+'。请先核对远程提交和本地状态，不要重复点击恢复或拉取合并。',failed:true};}
    try{await inspect();}catch(error){sourceResult={text:sourceResult.text+' 刷新失败：'+error.message,failed:true};}
    message(sourceResult.text,sourceResult.failed);
   },true),button('取消恢复',async()=>{sourcePreview=null;})));
  }
  if(sourceHistory){
   const historyList=disclosure('source-history-list');historyList.append(el('summary','历史提交列表（第 '+sourceHistory.page+' 页，'+sourceHistory.commits.length+' 项，点击展开/收起）'));box.append(historyList);
   historyList.append(el('p',`远程基线：${sourceHistory.remoteHead} · 第 ${sourceHistory.page} 页`,'sg-muted'));
   if(!sourceHistory.commits.length)historyList.append(el('p','没有可显示的历史提交。','sg-muted'));
   for(const commit of sourceHistory.commits){
    const entry=el('div',undefined,'sg-release-history-row'),info=el('div',undefined,'sg-release-history-info');
    info.append(el('code',commit.sha.slice(0,12),'sg-release-version'),el('span',commit.subject),el('span',commit.author,'sg-release-actor'),el('time',commit.date,'sg-release-time'));
    entry.append(info,button('选择并预览恢复',async()=>{sourcePreview=null;sourceResult=null;sourcePreview=await api('/source-restore-preview',{directory:repo.directory,...expected(repo),target:commit.sha,remoteHead:sourceHistory.remoteHead});focusSourcePreview=true;message('恢复预览已生成，请核对目标和覆盖范围；尚未执行恢复。');}));historyList.append(entry);
   }
   const previous=button('上一页',()=>loadSourceHistory(sourceHistory.page-1)),next=button('下一页',()=>loadSourceHistory(sourceHistory.page+1));previous.disabled=previous.disabled||sourceHistory.page<=1;next.disabled=next.disabled||!sourceHistory.hasMore;historyList.append(row(previous,next));
  }
  if(sourceResult)box.append(el('p',sourceResult.text,sourceResult.failed?'sg-error':'sg-success'));
 }
function renderCode(repo){
 renderSourceRestore(repo);
 const branch=collaborationBranch(),afterPush=oaAvailable()?'再发布 dev 在线测试。':'请按项目要求完成验证。';
  const code=section('3 · 共用分支开发 · '+branch),changes=(repo.changes||[]).filter(c=>!unmerged(c)),onDev=repo.branch===branch;
 code.append(el('p',`开工前可选同步 ${branch} 最新代码 → 开发与自测 → 提交并推送`+(oaAvailable()?' → 发布 dev → 在线测试。':'。请按项目要求完成验证。'),'sg-muted'));
  code.append(el('p',`不必先点同步才能推送：提交并推送会自动获取远程 ${branch} 并检查合并；若整合后代码有变化，会暂停推送，待审查、自测后再次提交推送。`,'sg-muted'));
 if(!onDev){code.append(el('p',`当前不在 ${branch}。请先确认旧分支的工作已保存，再切换。旧分支会保留，但其中独有的代码不会自动带到 ${branch}；有未提交改动时会拦截。`,'sg-warning'),button(`切换到 ${branch}`,async()=>{if(!confirm(`切换到本地 ${branch}（没有则从远程创建）？旧任务分支保留，不自动合并其代码。请先确认没有遗漏旧任务成果。`))return;await api('/switch-dev',{directory:repo.directory,...expected(repo)});state.pushResult=null;state.pullResult=null;await inspect();message(`已切换到 ${branch}，开工前可点击“同步最新代码”。`);},true));}
 const pull=button(state.pulling?'正在同步最新代码…':'同步最新代码',async()=>{
  if(!onDev)throw new Error(`请先切换到 ${branch}。`);
  if(!confirm(`同步远程 ${branch} 的最新代码，保留本地开发成果；此操作不会提交或推送。在隔离环境中连同本地未提交修改检查合并；有冲突只报告，不写入合并结果；无冲突且本地快照未变才安全整合。同步后请审查、自测，再继续开发或提交推送。`))return;
  const sid=options.getSessionId?.();noticeStatus='';state.pushResult=null;
   state.pulling=true;state.pullResult=null;render();
  try{const result=await api('/sync-dev',{directory:repo.directory,...expected(repo)});state.pullResult={text:result.conflict?'拉取的隔离合并检测到冲突，开发目录未写入合并结果：'+result.files.join('、')+'。会话将提出方案，等你确认后再修改代码。':result.needsAction?'已完成隔离检查，尚未整合到开发目录：'+(result.message||result.reason||'当前文件状态无法安全写回，需先确认整合方案。'):`✓ 已从 ${branch} 安全整合最新代码，本地开发成果已保留。请审查后提交推送，${afterPush}`,failed:Boolean(result.conflict||result.needsAction)};await inspect();if(result.conflict)await notifyConflict(result,sid);}
  catch(error){state.pullResult={text:'拉取未确认完成：'+error.message,failed:true};}finally{state.pulling=false;}
 });pull.disabled=state.busy||!onDev;code.append(row(pull,button('刷新改动',inspect)));
 if(state.pulling)loading(code,`正在从 ${branch} 拉取并整合代码，请稍候…`);else if(state.pullResult)code.append(el('p',state.pullResult.text,state.pullResult.failed?'sg-error':'sg-success'));
 code.append(el('p',changes.length?'将提交全部 '+changes.length+' 个改动文件（含已暂存及未跟踪文件）':'没有待提交改动。'));
 if(changes.length){const list=el('ul');for(const c of changes)list.append(el('li',c.status+'  '+c.path));code.append(list);}
 if(!conflicted(repo))code.append(button('查看差异',async()=>{state.diff=await api('/diff',{directory:state.directory});}));
 const hasConflict=conflicted(repo);
  if(noticeStatus)code.append(el('p',noticeStatus,'sg-warning'));
 if(state.diff&&!hasConflict){code.append(el('pre',state.diff.diff||'没有文本差异，请在编辑器检查新文件和二进制内容。'));if(state.diff.truncated)code.append(el('p','差异已截断，请检查完整内容。','sg-warning'));}

  const push=section('5 · 提交并推送');
  const msg=input('提交说明，例如：完成请假审批页面');push.append(msg);
 if(state.pushing)loading(push,`正在提交、获取远程 ${branch} 并检查隔离合并与推送条件，请稍候…`);else if(state.pushResult)push.append(el('p',state.pushResult.text,state.pushResult.failed?'sg-error':'sg-success'));
 const submit=button(state.pushing?'正在提交…':`提交并推送到 ${branch}`,async()=>{
  if(!onDev)throw new Error(`请先切换到 ${branch}。`);
  if(!msg.value.trim())throw new Error('请填写提交说明。');
  if(!confirm(`确认已检查本次改动，提交并推送到共用 ${branch}？整合新代码时会暂停，需审查后重新提交。推送不会自动部署；${afterPush}`))return;
  const sid=options.getSessionId?.();noticeStatus='';
   state.pushing=true;state.pushResult=null;render();
  try{const result=await api('/push',{directory:repo.directory,...expected(repo),message:msg.value.trim(),confirmedSelfTest:true});state.pushResult={text:result.conflict?`本次与最新 ${branch} 的隔离合并发现冲突，开发目录未写入合并结果，未推送：`+result.files.join('、')+'。会话将提出解决方案，等你确认后再修改开发代码、自测重试。':result.needsReview?`已整合同事最新代码，尚未推送。请审查整合后的改动，再提交推送；${afterPush}`:`✓ 已成功推送到共用 ${branch}。`,failed:Boolean(result.conflict)};try{await inspect();if(result.conflict)await notifyConflict(result,sid);}catch(error){state.pushResult={text:state.pushResult.text+' 刷新失败：'+error.message,failed:true};}}
  catch(error){state.pushResult={text:'推送未确认完成，本地提交可能已保存：'+error.message,failed:true};try{await inspect();}catch{}}finally{state.pushing=false;}
 },true);submit.disabled=state.busy||!onDev;push.append(submit);
 push.append(el('p',`DSH 修改的文件已在本机，无需额外点击保存。检查改动后提交推送，${afterPush}不强推；冲突请让 DSH 协助处理。${oaAvailable()?'test / 生产发布仍由负责人操作。':''}`,'sg-muted'));
}
state.directory=savedProject();
 render();void run(async()=>{await refreshStatus();await reconciliation;if(disposed)return;if(!updateResult)await checkUpdate();if(disposed||!state.directory)return;try{await inspect();if(!disposed)message('已恢复上次选择的项目。');}catch(error){if(!disposed)message('无法恢复上次项目，已保留路径，请检查目录或重新选择：'+error.message,true);}});
 return()=>{disposed=true;++loginGeneration;clearTimeout(timer);clearTimeout(cloneTimer);clearTimeout(remoteTimer);root.replaceChildren();};
}
