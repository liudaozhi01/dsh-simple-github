import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { FIXED_REPOSITORY, createService, runCommand, checkRequest, readJson, repositorySlug, githubRemote, parseStatus, validateMerge, redact, chooseDirectory, normalizeCloneRepository, findGh, repositoryPath, assertDistinctPaths } from './core.js';
import { apply } from './index.js';

test('clone jobs expose real progress, redact logs and retain terminal states',async()=>{
 const parent=await mkdtemp(join(tmpdir(),'clone-progress-'));let finish,optsSeen,argsSeen;
 const service=createService({ghPath:'mock-gh',command:async(cmd,args,opts)=>{argsSeen=args;optsSeen=opts;opts.onOutput('Receiving objects: 42% (42/100) ghp_secret\r');await new Promise(resolve=>{finish=resolve;});return {stdout:'',stderr:''};}});
 const start=await service.route('clone',{repository:'https://github.com/ssal-team/XiAN-OA.git',parentDirectory:parent});
 await new Promise(resolve=>setImmediate(resolve));
 const running=await service.route('clone-status',{id:start.id});assert.equal(running.state,'running');assert.equal(running.percent,42);assert.ok(!running.log.includes('ghp_secret'));assert.ok(argsSeen.includes('--progress'));assert.equal(optsSeen.timeout,600000);
 finish();await new Promise(resolve=>setImmediate(resolve));assert.equal((await service.route('clone-status',{id:start.id})).state,'success');service.close();
 const failing=createService({ghPath:'mock-gh',command:async()=>{throw new Error('network ghp_secret');}});
 const job=await failing.route('clone',{repository:FIXED_REPOSITORY,parentDirectory:parent});await new Promise(resolve=>setImmediate(resolve));
 const failed=await failing.route('clone-status',{id:job.id});assert.equal(failed.state,'error');assert.ok(!failed.error.includes('ghp_secret'));failing.close();
});
test('clone defaults to the fixed repository when repository is omitted',async()=>{
 const parent=await mkdtemp(join(tmpdir(),'clone-fixed-')),calls=[];
 const service=createService({ghPath:'mock-gh',command:async(cmd,args)=>{calls.push({cmd,args});return {stdout:'',stderr:''};}});
 try {
  assert.equal(FIXED_REPOSITORY,'ssal-team/XiAN-OA');
  const job=await service.route('clone',{parentDirectory:parent});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await service.route('clone-status',{id:job.id})).state,'success');
  assert.equal(calls.length,1); assert.equal(calls[0].cmd,'mock-gh');
  assert.deepEqual(calls[0].args.slice(0,4),['repo','clone',`https://github.com/${FIXED_REPOSITORY}.git`,join(await realpath(parent),'XiAN-OA')]);
   assert.deepEqual(calls[0].args.slice(4,8),['--','--branch','dev','--single-branch']);
 } finally { service.close(); }
});
test('clone rejects other repositories before starting any command',async()=>{
 const parent=await mkdtemp(join(tmpdir(),'clone-rejected-')),calls=[];
 const service=createService({ghPath:'mock-gh',command:async(cmd,args)=>{calls.push({cmd,args});return {stdout:'',stderr:''};}});
 try {
  for(const repository of ['fixture/project','https://github.com/fixture/project.git','https://evil.test/ssal-team/XiAN-OA.git','git@github.com:ssal-team/XiAN-OA.git']) {
   await assert.rejects(service.route('clone',{repository,parentDirectory:parent}),undefined,repository);
  }
  assert.equal(calls.length,0);
 } finally { service.close(); }
});
test('clone input accepts canonical GitHub links without weakening remote validation',()=>{
 for(const value of ['ssal-team/XiAN-OA',' ssal-team/XiAN-OA.git ','https://github.com/ssal-team/XiAN-OA','https://github.com/ssal-team/XiAN-OA.git','https://github.com/ssal-team/XiAN-OA.git/']) assert.equal(normalizeCloneRepository(value),'ssal-team/XiAN-OA');
 for(const value of ['https://evil.test/a/b','https://github.com@evil.test/a/b','https://user:pass@github.com/a/b','http://github.com/a/b','https://github.com/a/b/tree/main','https://github.com/a/b?token=x','https://github.com/a/b#main','https://github.com/a/../','https://github.com/a/b\n','a/b;touch x','git@github.com:a/b.git']) assert.throws(()=>normalizeCloneRepository(value),/仓库地址格式/);
 assert.throws(()=>githubRemote('https://github.com/a/b/'));
});
test('Windows discovery uses semicolon PATH, executable extensions, and normalized Path',async()=>{
 const attempts=[];
 const result=await findGh({Path:'C:\\Tools;C:\\Program Files\\GitHub CLI',PATHEXT:'.EXE;.CMD'},{platform:'win32',accessImpl:async p=>{attempts.push(p);if(p!=='C:\\Program Files\\GitHub CLI\\gh.EXE')throw new Error('missing');},statImpl:async()=>({isFile:()=>true})});
 assert.equal(result,'C:\\Program Files\\GitHub CLI\\gh.EXE');assert.ok(attempts.includes('C:\\Tools\\gh.EXE'));
});
test('Windows path aliases and case/Unicode collisions are rejected without filesystem IO',()=>{
 for(const p of ['CON','aux.txt','x/NUL.txt','COM1','lpt².log','x:stream','x.','x ','x/<y>','C:/file','x\\y','git~1/config','.GIT/config'])assert.throws(()=>repositoryPath(p,'win32'),undefined,p);
 assert.equal(repositoryPath('中文 folder/file.txt','win32'),'中文 folder/file.txt');
 for(const paths of [['A.txt','a.txt'],['Dir/a','dir/b'],['caf\u00e9/a','cafe\u0301/b']])assert.throws(()=>assertDistinctPaths(paths,'win32'),/collision/);
});
test('Windows picker uses static encoded STA script and supports cancellation without fake Windows IO',async()=>{
 assert.deepEqual(await chooseDirectory({platform:'win32',command:async(cmd,args)=>{assert.match(cmd,/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);assert.ok(args.includes('-STA'));assert.ok(args.includes('-NoProfile'));const script=Buffer.from(args.at(-1),'base64').toString('utf16le');assert.match(script,/FolderBrowserDialog/);assert.match(script,/UTF8Encoding/);return {stdout:'\r\n'};}}),{cancelled:true});
});
test('Windows login suppresses browser using native no-op command and exposes platform status',async()=>{
 let loginOptions;
 const service=createService({platform:'win32',ghPath:'mock-gh',command:async(_cmd,args,options)=>{if(args[0]==='auth'){loginOptions=options;options.onOutput('code: ABCD-1234\nhttps://github.com/login/device');return {stdout:''};}return {stdout:JSON.stringify({login:'fixture'})};}});
 try{const status=await service.route('status');assert.deepEqual(status.environment,{platform:'win32',label:'Windows',isWindows:true});const started=await service.route('login');await new Promise(r=>setImmediate(r));assert.equal(loginOptions.env.GH_BROWSER,'cmd.exe /d /c exit 0');assert.equal(loginOptions.env.BROWSER,loginOptions.env.GH_BROWSER);assert.equal((await service.route('login',{},new URLSearchParams({id:started.loginId}))).code,'ABCD-1234');}finally{service.close();}
});
test('Windows device code parses localized prompts and fragmented ANSI output without exposing raw logs',async()=>{
  const service=createService({platform:'win32',ghPath:'mock-gh',command:async(_cmd,args,options)=>{
    if(args[0]==='auth'){for(const chunk of ['请输入一次性验证码：\u001b[','1;32mAB','CD-12','34\u001b[0m\r\nsecret-fixture-value'])options.onOutput(chunk);return new Promise(()=>{});}return {stdout:'{}'};
  }});
  try{const started=await service.route('login');await new Promise(r=>setImmediate(r));const state=await service.route('login',{},new URLSearchParams({id:started.loginId}));assert.equal(state.code,'ABCD-1234');assert.equal(state.url,'https://github.com/login/device');assert.equal(state.state,'pending');assert.doesNotMatch(JSON.stringify(state),/secret-fixture-value|一次性/);}finally{await service.close();}
});
test('login failures classify network, timeout and denial without leaking CLI secrets',async()=>{
  for(const [detail,expected] of [['TLS handshake: token secret-fixture-value https://user:password@proxy.invalid',/无法连接 GitHub/],['Command timed out',/已超时/],['access_denied',/取消或授权被拒绝/],['unexpected exit secret-fixture-value',/设备登录失败/]]){
    const service=createService({ghPath:'mock-gh',command:async()=>{throw new Error(detail);}});
    try{const started=await service.route('login');await new Promise(r=>setImmediate(r));const result=await service.route('login',{},new URLSearchParams({id:started.loginId}));assert.equal(result.state,'error');assert.match(result.error,expected);assert.doesNotMatch(result.error,/secret-fixture-value|password|proxy\.invalid/);}finally{await service.close();}
  }
});
test('native directory picker returns validated path, cancellation and platform errors',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'picker test-'));
 const picked=await chooseDirectory({platform:'darwin',command:async(cmd,args)=>{assert.equal(cmd,'/usr/bin/osascript');assert.equal(args[0],'-e');return {stdout:directory+'/\n'};}});
 assert.equal(picked.directory,await realpath(directory));assert.equal(picked.cancelled,false);
 assert.deepEqual(await chooseDirectory({platform:'darwin',command:async()=>({stdout:'\n'})}),{cancelled:true});
 await assert.rejects(chooseDirectory({platform:'linux'}),/macOS/);
 await assert.rejects(chooseDirectory({platform:'darwin',command:async()=>({stdout:'relative\n'})}),/所选目录/);
});
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'simple-git-test-')), directory = join(base, 'repo'); await mkdir(directory);
  const git = args => runCommand('git', ['-C', directory, ...args]);
  await git(['init','-b','main']); await git(['config','core.autocrlf','false']); await git(['config','user.email','test@example.invalid']); await git(['config','user.name','Fixture']);
  await writeFile(join(directory, 'hello.txt'), 'hello\n'); await git(['add','.']); await git(['commit','-m','initial']);
  await git(['remote','add','origin','https://github.com/ssal-team/XiAN-OA.git']);
  return { base, directory, git };
}
test('repository roots accept one fixed HTTPS fetch URL and one matching explicit push URL',async()=>{
 const {directory,git}=await fixture();
 await git(['config','remote.origin.pushurl',`https://github.com/${FIXED_REPOSITORY}.git`]);
 const service=createService();
 try { assert.equal((await service.inspect(directory)).repository,FIXED_REPOSITORY); }
 finally { service.close(); }
});
test('repository roots reject missing, foreign, non-HTTPS and ambiguous origin URLs',async t=>{
 const fixedUrl=`https://github.com/${FIXED_REPOSITORY}.git`;
 const cases=[
  ['missing origin',git=>git(['remote','remove','origin'])],
  ['another GitHub repository',git=>git(['remote','set-url','origin','https://github.com/fixture/project.git'])],
  ['SSH origin',git=>git(['remote','set-url','origin',`git@github.com:${FIXED_REPOSITORY}.git`])],
  ['HTTP origin',git=>git(['remote','set-url','origin',`http://github.com/${FIXED_REPOSITORY}.git`])],
  ['credential-bearing origin',git=>git(['remote','set-url','origin',`https://token@github.com/${FIXED_REPOSITORY}.git`])],
  ['foreign host',git=>git(['remote','set-url','origin',`https://evil.test/${FIXED_REPOSITORY}.git`])],
  ['multiple fetch URLs even when identical',git=>git(['config','--add','remote.origin.url',fixedUrl])],
  ['push URL points elsewhere',git=>git(['config','remote.origin.pushurl','https://github.com/fixture/project.git'])],
  ['multiple push URLs even when identical',async git=>{await git(['config','--add','remote.origin.pushurl',fixedUrl]);await git(['config','--add','remote.origin.pushurl',fixedUrl]);}],
 ];
 for(const [name,configure] of cases) await t.test(name,async()=>{
  const {directory,git}=await fixture(); await configure(git);
  const service=createService();
  try {
   await assert.rejects(service.inspect(directory));
   await assert.rejects(service.route('diff',{directory}));
   await assert.rejects(service.route('branch',{directory,name:'feature/rejected'}));
   assert.equal((await git(['branch','--list','feature/rejected'])).stdout.trim(),'');
  } finally { service.close(); }
 });
});
function expected(info) { return { expectedBranch:info.branch, expectedRepository:info.repository, expectedBaseBranch:info.baseBranch, expectedHead:info.head, expectedFingerprint:info.fingerprint }; }
function devService({ defaultBranch = 'main', fetch = async () => {}, push = async () => {} } = {}) {
  const calls=[];
  const command=async(cmd,args,opts)=>{
    calls.push({cmd,args});
    if(cmd==='mock-gh') return {stdout:JSON.stringify(args[0]==='api'?{login:'fixture'}:{nameWithOwner:'ssal-team/XiAN-OA',defaultBranchRef:{name:defaultBranch}}),stderr:''};
    if(args.includes('fetch')) {await fetch();return {stdout:'',stderr:''};}
    if(args.includes('push')) {await push();return {stdout:'',stderr:''};}
    return runCommand(cmd,args,opts);
  };
  return {service:createService({ghPath:'mock-gh',command}),calls};
}
for (const scenario of ['tls','reset','auth','certificate','invalid-json','mismatch','missing-default','rest-failure']) test('repository metadata network fallback: '+scenario,async()=>{
 const {directory,git}=await fixture(),calls=[];
 await git(['checkout','-b','dev']);
 const service=createService({ghPath:'mock-gh',command:async(cmd,args,opts)=>{
  if(cmd!=='mock-gh'){if(args.includes('fetch'))throw new Error('fixture metadata verified before fetch');return runCommand(cmd,args,opts);}
  calls.push(args);
  if(args[0]==='api'&&args[1]==='user')return {stdout:JSON.stringify({login:'fixture'})};
  if(args[0]==='repo'){
   if(scenario==='invalid-json')return {stdout:'not JSON'};
   throw new Error(scenario==='auth'?'HTTP 403: forbidden':scenario==='certificate'?'x509: certificate signed by unknown authority':scenario==='reset'?'connection reset by peer':'Post "https://api.github.com/graphql": net/http: TLS handshake timeout');
  }
  assert.deepEqual(args,['api',`repos/${FIXED_REPOSITORY}`,'--hostname','github.com','--method','GET']);assert.equal(opts.timeout,30000);
  if(scenario==='rest-failure')throw new Error('REST network unreachable');
  return {stdout:JSON.stringify({full_name:scenario==='mismatch'?'other/repo':FIXED_REPOSITORY,default_branch:scenario==='missing-default'?null:'main'})};
 }});
 try {
  const pattern=['tls','reset'].includes(scenario)?/fixture metadata verified before fetch/:['mismatch','missing-default'].includes(scenario)?/Unable to verify/:scenario==='rest-failure'?/REST network unreachable/:scenario==='invalid-json'?/JSON/:scenario==='auth'?/HTTP 403/:/certificate/;
  await assert.rejects(service.route('sync-dev',{directory,...expected(await service.inspect(directory))}),pattern);
  assert.equal(calls.filter(a=>a[1]===`repos/${FIXED_REPOSITORY}`).length,['auth','certificate','invalid-json'].includes(scenario)?0:1);
 }finally{service.close();}
});
function request(overrides = {}) { return { method: 'POST', headers: { host: '127.0.0.1:12345', origin: 'http://127.0.0.1:12345' }, socket: { remoteAddress: '127.0.0.1', localPort: 12345 }, ...overrides }; }
test('request security rejects non-loopback, DNS rebinding, cross origins and absent mutation Origin', () => {
  checkRequest(request()); checkRequest(request({ method: 'GET', headers: { host: 'localhost:12345' } }));
  checkRequest(request({ headers: { host:'127.0.0.1:12345', 'sec-fetch-site':'same-origin' } }));
  checkRequest(request({headers:{host:'127.0.0.1:12345'}}), {csrfVerified:true});
  for(const headers of [{host:'127.0.0.1:12345',origin:'https://evil.example'},{host:'127.0.0.1:12345','sec-fetch-site':'cross-site'},{host:'evil.example:12345'}]) assert.throws(()=>checkRequest(request({headers}),{csrfVerified:true}));
  for (const site of ['none','same-site','cross-site']) assert.throws(() => checkRequest(request({ headers:{host:'127.0.0.1:12345','sec-fetch-site':site} })));
  assert.throws(() => checkRequest(request({ headers:{host:'127.0.0.1:12345',origin:'https://evil.example','sec-fetch-site':'same-origin'} })));
  for (const bad of [request({ socket: { remoteAddress: '192.168.1.1' } }), request({ headers: { host: 'evil.example:12345', origin: 'http://evil.example:12345' } }), request({ headers: { host: '127.0.0.1:12345', origin: 'http://localhost:12345' } }), request({ headers: { host: '127.0.0.1:12345' } }), request({ headers: { host: '127.0.0.1:12345', origin: 'null' } }), request({ headers: { host: '127.0.0.1:12346', origin: 'http://127.0.0.1:12346' } })]) assert.throws(() => checkRequest(bad));
});
test('JSON media type and body limits', async () => {
  const req = (data, headers = {}) => Object.assign(Readable.from([Buffer.from(data)]), { headers: { 'content-type':'application/json', ...headers } });
  assert.deepEqual(await readJson(req('{}')), {});
  await assert.rejects(readJson(req('{}', { 'content-type': 'text/plain' })), /content type/);
  await assert.rejects(readJson(req(' '.repeat(65537))), /64KB/);
  await assert.rejects(readJson(req('[]')), /object/);
  await assert.rejects(readJson(req('{')), /JSON/);
});
test('strict slugs/remotes, rename parsing, credential redaction', () => {
  assert.equal(repositorySlug('owner/project'), 'owner/project'); assert.equal(githubRemote('https://github.com/owner/project.git'), 'owner/project');
  for (const slug of ['../x','-owner/repo','a/..','a/repo.git','https://github.com/a/b','a/b;touch x']) assert.throws(() => repositorySlug(slug));
  for (const remote of ['git@github.com:a/b.git','https://evil.test/a/b','https://token@github.com/a/b','https://github.com/a/b?x']) assert.throws(() => githubRemote(remote));
  assert.deepEqual(parseStatus('R  new name\0old name\0?? other\0'), [{ path:'new name',status:'R ' },{ path:'other',status:'??' }]);
  assert.equal(redact('ghp_abc123 github_pat_secret Authorization: Bearer abc'), '[REDACTED] [REDACTED] Authorization: Bearer [REDACTED]');
});
test('local repository inspection/diff/branch reject nested roots and dirty branch creation', async () => {
  const { directory, git } = await fixture(), service = createService();
  let info = await service.inspect(directory); assert.equal(info.branch,'main'); assert.equal(info.isClean,true); assert.match(info.fingerprint,/^[a-f0-9]{64}$/);
  await git(['switch','-c','feature/demo']); assert.equal((await service.inspect(directory)).branch,'feature/demo');
  await writeFile(join(directory,'hello.txt'), 'changed\n'); await git(['add','hello.txt']); await writeFile(join(directory,'hello.txt'), 'changed again\n');
  const diff = await service.route('diff',{ directory }); assert.match(diff.diff,/Staged changes/); assert.match(diff.diff,/changed again/);
  const dirty = await service.inspect(directory); assert.notEqual(info.fingerprint,dirty.fingerprint); assert.equal(dirty.changes[0].status,'MM');
  await assert.rejects(service.route('branch',{ directory,name:'feature/no', ...expected(dirty) }), /Legacy mutation disabled/);
  await assert.rejects(service.route('branch',{ directory,name:'--bad' }), /Legacy mutation disabled/);
  await mkdir(join(directory,'nested')); await assert.rejects(service.inspect(join(directory,'nested')), /exact repository root/);
});
test('switch-dev fetches and tracks origin/dev when local dev is absent', async () => {
  const {directory,git}=await fixture();
  const remoteHead=(await git(['rev-parse','HEAD'])).stdout.trim();
  const {service,calls}=devService({fetch:()=>git(['update-ref','refs/remotes/origin/dev',remoteHead])});
  const info=await service.inspect(directory);
  assert.deepEqual(await service.route('switch-dev',{directory,...expected(info)}),{ok:true});
  assert.equal((await service.inspect(directory)).branch,'dev');
  assert.equal((await git(['rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}'])).stdout.trim(),'origin/dev');
  const fetchIndex=calls.findIndex(({args})=>args.includes('fetch'));
  const switchIndex=calls.findIndex(({args})=>args.includes('switch'));
  assert.ok(fetchIndex>=0 && switchIndex>fetchIndex);
  assert.deepEqual(calls[switchIndex].args.slice(-4),['--track','-c','dev','refs/remotes/origin/dev']);
  assert.equal(calls.some(({args})=>args.includes('push')),false);
});
test('switch-dev reuses local dev and rejects dirty or stale previews before switching', async () => {
  const {directory,git}=await fixture(); await git(['branch','dev']);
  const {service,calls}=devService();
  await service.route('switch-dev',{directory,...expected(await service.inspect(directory))});
  assert.equal((await service.inspect(directory)).branch,'dev');
  assert.ok(calls.some(({args})=>args.slice(-4).join(' ')==='switch --no-guess --no-overwrite-ignore dev'));
  assert.equal(calls.some(({args})=>args.includes('--track')),false);
  await git(['switch','main']); await writeFile(join(directory,'hello.txt'),'dirty\n'); calls.length=0;
  await assert.rejects(service.route('switch-dev',{directory,...expected(await service.inspect(directory))}),/本地修改/);
  assert.equal(calls.some(({args})=>args.includes('fetch') || args.includes('switch')),false);
  const stale=await service.inspect(directory); await writeFile(join(directory,'hello.txt'),'changed again\n');
  await assert.rejects(service.route('switch-dev',{directory,...expected(stale)}),/changed/);
  assert.equal((await service.inspect(directory)).branch,'main');
});
test('switch-dev rechecks preview after fetch before changing branches', async () => {
  const {directory,git}=await fixture(); await git(['branch','dev']);
  const {service,calls}=devService({fetch:()=>writeFile(join(directory,'hello.txt'),'external edit\n')});
  await assert.rejects(service.route('switch-dev',{directory,...expected(await service.inspect(directory))}),/changed/);
  assert.equal((await service.inspect(directory)).branch,'main');
  assert.equal(calls.some(({args})=>args.includes('switch')),false);
});
test('sync-dev merges diverged histories normally, retaining both sides and both parents', async () => {
  const {directory,git}=await fixture();
  await git(['switch','-c','remote-dev']); await writeFile(join(directory,'remote.txt'),'remote\n'); await git(['add','.']); await git(['commit','-m','remote work']);
  const remoteHead=(await git(['rev-parse','HEAD'])).stdout.trim();
  await git(['switch','-c','dev','main']); await writeFile(join(directory,'local.txt'),'local\n'); await git(['add','.']); await git(['commit','-m','local work']);
  const localHead=(await git(['rev-parse','HEAD'])).stdout.trim();
  const {service,calls}=devService({fetch:()=>git(['update-ref','refs/remotes/origin/dev',remoteHead])});
  assert.deepEqual(await service.route('sync-dev',{directory,...expected(await service.inspect(directory))}),{ok:true,conflict:false});
  assert.deepEqual((await git(['rev-list','--parents','-n','1','HEAD'])).stdout.trim().split(' ').slice(1),[localHead,remoteHead]);
  assert.equal((await git(['show','HEAD:local.txt'])).stdout,'local\n'); assert.equal((await git(['show','HEAD:remote.txt'])).stdout,'remote\n');
  assert.equal((await service.inspect(directory)).isClean,true);
  assert.ok(calls.some(({args})=>args.includes('update-ref') && (args.includes('HEAD') || args.includes('refs/heads/dev')) && args.at(-1)===localHead));
  assert.equal(calls.some(({args})=>args.includes('merge') && args.includes('--ff-only')),false);
  assert.equal(calls.some(({args})=>args.includes('rebase') || args.includes('push')),false);
});
test('sync-dev returns the exact isolated conflict list without real merge state', async () => {
  const {directory,git}=await fixture();
  await writeFile(join(directory,'other file.txt'),'base\n'); await git(['add','.']); await git(['commit','-m','second file']);
  await git(['switch','-c','remote-dev']);
  for(const file of ['hello.txt','other file.txt']) await writeFile(join(directory,file),'remote\n');
  await git(['add','.']); await git(['commit','-m','remote changes']); const remoteHead=(await git(['rev-parse','HEAD'])).stdout.trim();
  await git(['switch','-c','dev','main']);
  for(const file of ['hello.txt','other file.txt']) await writeFile(join(directory,file),'local\n');
  await git(['add','.']); await git(['commit','-m','local changes']); const localHead=(await git(['rev-parse','HEAD'])).stdout.trim();
  const {service,calls}=devService({fetch:()=>git(['update-ref','refs/remotes/origin/dev',remoteHead])});
  const result=await service.route('sync-dev',{directory,...expected(await service.inspect(directory))});
  assert.equal(result.conflict,true); assert.deepEqual(result.files,['hello.txt','other file.txt']); assert.ok(result.conflictId);
  assert.equal((await git(['rev-parse','HEAD'])).stdout.trim(),localHead);
  await assert.rejects(git(['rev-parse','--verify','MERGE_HEAD']));
  assert.equal((await git(['ls-files','--unmerged'])).stdout,'');
  assert.equal((await service.inspect(directory)).isClean,true);
});
test('sync-dev rejects non-dev branches and edits during fetch', async () => {
  const {directory,git}=await fixture(); const {service,calls}=devService();
  await assert.rejects(service.route('sync-dev',{directory,...expected(await service.inspect(directory))}),/切换到 dev/);
  await git(['switch','-c','dev']); await writeFile(join(directory,'untracked.txt'),'dirty\n');
  assert.equal(calls.some(({args})=>args.includes('fetch') || args.includes('merge')),false);
  await git(['add','.']); await git(['commit','-m','save changes']);
  const duringFetch=devService({fetch:()=>writeFile(join(directory,'hello.txt'),'external edit\n')});
  await assert.rejects(duringFetch.service.route('sync-dev',{directory,...expected(await duringFetch.service.inspect(directory))}),/changed/);
  assert.equal(duringFetch.calls.some(({args})=>args.includes('merge')),false);
});
test('all legacy mutation routes reject without running commands, including task routes', async () => {
 const calls=[]; const service=createService({command:async(...args)=>{calls.push(args);throw new Error('must not run');}});
 for(const route of ['pull','branch','switch-main','pr-create','pr-merge','task-start','task-submit','task-switch','task-list','task-status']) await assert.rejects(service.route(route,{directory:'/unused'}),error=>error.status===403);
 assert.equal(calls.length,0);
});
test('merge policy is strict and binds repository, base, head, approvals and check states', () => {
  const expectedHeadOid = 'a'.repeat(40), context = { number: 7, repository:'ssal-team/XiAN-OA',baseBranch:'main',expectedHeadOid };
  const pr = { number:7,url:'https://github.com/ssal-team/XiAN-OA/pull/7',state:'OPEN',isDraft:false,baseRefName:'main',headRefOid:expectedHeadOid,mergeable:'MERGEABLE',reviewDecision:'APPROVED',statusCheckRollup:[{ __typename:'CheckRun',status:'COMPLETED',conclusion:'SUCCESS' }] };
  validateMerge(pr,context);
  for (const change of [{ isDraft:true },{ baseRefName:'other' },{ headRefOid:'b'.repeat(40) },{ reviewDecision:'' },{ mergeable:'UNKNOWN' },{ url:'https://github.com/evil/project/pull/7' },{ statusCheckRollup:[{ status:'IN_PROGRESS',conclusion:null }] },{ statusCheckRollup:[{ __typename:'StatusContext',state:'FAILURE' }] }]) assert.throws(() => validateMerge({ ...pr,...change },context));
});
test('bounded processes and timeout cannot leak tokens', async () => {
  await assert.rejects(runCommand(process.execPath,['-e','process.stderr.write("ghp_secret");process.exit(1)']), error => !error.message.includes('ghp_secret'));
  const result = await runCommand(process.execPath,['-e','process.stdout.write("x".repeat(5000))'],{ maxOutput:100,truncate:true }); assert.equal(result.stdout.length,100); assert.equal(result.truncated,true);
  await assert.rejects(runCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{ timeout:30 }), /timed out/);
});
test('mock gh device login stays asynchronous and exposes only device code, not tokens', {skip:process.platform === 'win32' ? 'POSIX executable-script fixture; Windows device login is tested with injected command' : false}, async () => {
  const base = await mkdtemp(join(tmpdir(),'simple-gh-mock-')), ghPath = join(base,'gh');
  await writeFile(ghPath, `#!${process.execPath}\nconst a=process.argv.slice(2); if(a[0]==='api'){console.log(JSON.stringify({login:'fixture',avatar_url:'https://avatars.githubusercontent.com/u/1',token:'ghp_secret'}));}else if(a[0]==='auth'&&a[1]==='login'){process.stderr.write('! First copy your one-time code: ABCD-1234\\nOpen https://github.com/login/device\\nghp_secret');setTimeout(()=>process.exit(0),100);}else{console.log('[]');}\n`); await chmod(ghPath,0o755);
  const service = createService({ ghPath });
  const status = await service.route('status'); assert.equal(status.user.login,'fixture'); assert.equal(status.ghAvailable,true); assert.equal(JSON.stringify(status).includes('ghp_secret'),false);
  assert.equal(service.tokenMatches(status.csrfToken),true); assert.equal(service.tokenMatches('bad'),false); assert.equal(service.tokenMatches('é'.repeat(64)),false);
  const { loginId } = await service.route('login');
  assert.deepEqual(await service.route('login'), {ok:true,loginId,resumed:true});
  let login; for (let i=0;i<30;i++) { login = await service.route('login',{},new URLSearchParams({ id:loginId })); if (login.state!=='pending') break; await new Promise(r=>setTimeout(r,20)); }
  assert.equal(login.state,'success'); assert.equal(login.code,'ABCD-1234'); assert.equal(login.url,'https://github.com/login/device'); assert.equal(JSON.stringify(login).includes('ghp_secret'),false); service.close();
});
test('web handler enforces POST, CSRF, Origin, media type before invoking operations', async () => {
  let handler; apply({ effect(fn) { fn(); }, webServer:{port:12345,register(value){handler=value.handler;return()=>{};} } });
  async function invoke(path,method,headers={}) {
    const req=Object.assign(Readable.from([Buffer.from('{}')]),request({url:path,method,headers:{host:'127.0.0.1:12345',origin:'http://127.0.0.1:12345','content-type':'application/json',...headers}}));
    const result={headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(n){this.status=n;},end(body){this.body=body;}}; await handler(req,result); return result;
  }
  assert.equal((await invoke('/simple-github/api/clone','GET')).status,405);
  assert.equal((await invoke('/simple-github/api/clone','POST')).status,403);
  assert.equal((await invoke('/simple-github/api/clone','POST',{origin:'http://evil.test'})).status,403);
  assert.equal((await invoke('/simple-github/api/status','POST')).status,405);
  assert.equal((await invoke('/simple-github/api/unknown','POST')).status,404);
});

async function sharedFixture(options = {}) {
 const f=await fixture(); await f.git(['switch','-c','dev']);
 const initial=(await f.git(['rev-parse','HEAD'])).stdout.trim();
 await f.git(['update-ref','refs/remotes/origin/dev',initial]);
 const calls=[];let fetch=async()=>{},account=async()=>{},login='fixture';
 const command=async(cmd,args,opts)=>{
  calls.push({cmd,args});
  if(cmd==='mock-gh') {
   if(args[0]==='api') {await account();if(!login) throw new Error('signed out');return {stdout:JSON.stringify({login})};}
   return {stdout:JSON.stringify({nameWithOwner:FIXED_REPOSITORY,defaultBranchRef:{name:'main'}})};
  }
  if(args.includes('fetch')) {await fetch();return {stdout:''};}
  if(args.includes('push')) {await options.push?.();return {stdout:''};}
  return runCommand(cmd,args,opts);
 };
 const service=createService({ghPath:'mock-gh',command,deploymentFactory:()=>({route:async()=>({}),assertVerified:async()=>{},rebindVerified:async()=>{},close(){}})});
 const invoke=async(name='push',message='Save shared work',info)=>service.route(name,{directory:f.directory,message,confirmedSelfTest:true,...expected(info||await service.inspect(f.directory))});
 return {...f,service,calls,initial,invoke,setFetch:fn=>{fetch=fn;},setAccount:fn=>{account=fn;},setLogin:value=>{login=value;}};
}
test('shared dev push commits all files then fetches, merges and normal pushes explicit dev',async()=>{
 const f=await sharedFixture();await writeFile(join(f.directory,'hello.txt'),'edit');await writeFile(join(f.directory,'new.txt'),'new');
 // Push itself saves the verified dirty worktree; no separate save action.
 assert.deepEqual(await f.invoke(),{ok:true});
 assert.equal((await f.git(['show','HEAD:new.txt'])).stdout,'new');assert.equal((await f.service.inspect(f.directory)).isClean,true);
 const mutations=f.calls.filter(c=>!c.args.includes('worktree')&&c.args.some(a=>['add','commit','fetch','merge','push'].includes(a)));
 assert.deepEqual(mutations.map(c=>c.args.find(a=>['add','commit','fetch','merge','push'].includes(a))),['add','commit','fetch','merge','push']);
 assert.deepEqual(mutations.at(-1).args.slice(-4),['push','--set-upstream','origin','refs/heads/dev:refs/heads/dev']);
 assert.deepEqual(mutations[2].args.slice(-3),['fetch','origin','+refs/heads/dev:refs/remotes/origin/dev']);
 assert.equal(f.calls.some(c=>(!c.args.includes('worktree')&&c.args.some(a=>a.startsWith('--force')))||c.args[0]==='pr'),false);
});
test('remote integration requires review, and next unchanged click pushes without another commit',async()=>{
 for(const divergent of [false,true]) {
  const f=await sharedFixture();await f.git(['switch','-c','remote-side']);await writeFile(join(f.directory,'remote.txt'),'remote');await f.git(['add','.']);await f.git(['commit','-m','remote']);const remote=(await f.git(['rev-parse','HEAD'])).stdout.trim();await f.git(['switch','dev']);
  if(divergent) { await writeFile(join(f.directory,'local.txt'),'local'); await f.invoke('commit-local'); }
  f.setFetch(()=>f.git(['update-ref','refs/remotes/origin/dev',remote]));
  assert.deepEqual(await f.invoke(),{ok:true,needsReview:true});assert.equal(f.calls.some(c=>c.args.includes('push')),false);
  const integrated=(await f.git(['rev-parse','HEAD'])).stdout.trim();assert.notEqual(integrated,f.initial);
  if(divergent) assert.equal((await f.git(['rev-list','--parents','-n','1','HEAD'])).stdout.trim().split(' ').length,3);
  f.calls.length=0;assert.deepEqual(await f.invoke(),{ok:true});assert.equal(f.calls.some(c=>c.args.includes('commit')),false);assert.equal(f.calls.some(c=>c.args.includes('push')),true);
 }
});
test('push conflicts preserve local commit and leave dev clean without a merge operation',async()=>{
 const f=await sharedFixture();await f.git(['switch','-c','remote-side']);await writeFile(join(f.directory,'hello.txt'),'remote');await f.git(['add','.']);await f.git(['commit','-m','remote']);const remote=(await f.git(['rev-parse','HEAD'])).stdout.trim();await f.git(['switch','dev']);
 await writeFile(join(f.directory,'hello.txt'),'local');await f.invoke('commit-local');f.setFetch(()=>f.git(['update-ref','refs/remotes/origin/dev',remote]));
 const result=await f.invoke();assert.equal(result.ok,true);assert.equal(result.conflict,true);assert.deepEqual(result.files,['hello.txt']);assert.ok(result.conflictId);assert.equal(f.calls.some(c=>c.args.includes('push')),false);
 const local=(await f.git(['rev-parse','HEAD'])).stdout.trim();assert.notEqual(local,f.initial);assert.equal(result.localHead,local);assert.equal(result.remoteHead,remote);
 await assert.rejects(f.git(['rev-parse','--verify','MERGE_HEAD']));assert.equal((await f.service.inspect(f.directory)).isClean,true);
 assert.equal((await f.git(['ls-files','--unmerged'])).stdout,'');assert.equal(await readFile(join(f.directory,'hello.txt'),'utf8'),'local');
 const report=await f.service.getConflictReport({directory:f.directory,conflictId:result.conflictId});assert.equal(report.isolated,true);assert.match(report.diff,/<<<<<<<|=======|>>>>>>>/);
 f.calls.length=0;assert.deepEqual(await f.invoke('commit-local'),{ok:true});assert.equal(f.calls.some(c=>c.args.includes('push')||c.args.includes('fetch')),false);
});
test('commit-local saves staged, unstaged and untracked changes without networking git',async()=>{
 const f=await sharedFixture();await writeFile(join(f.directory,'hello.txt'),'staged');await f.git(['add','.']);await writeFile(join(f.directory,'hello.txt'),'unstaged');await writeFile(join(f.directory,'new.txt'),'new');
 assert.deepEqual(await f.invoke('commit-local'),{ok:true});assert.equal((await f.git(['show','HEAD:hello.txt'])).stdout,'unstaged');assert.equal((await f.git(['show','HEAD:new.txt'])).stdout,'new');
 const head=(await f.git(['rev-parse','HEAD'])).stdout;assert.deepEqual(await f.invoke('commit-local'),{ok:true});assert.equal((await f.git(['rev-parse','HEAD'])).stdout,head);
 assert.equal(f.calls.some(c=>c.args.includes('push')||c.args.includes('fetch')),false);
});
test('dev mutations reject every non-dev branch, detached HEAD, stale files and unauthenticated accounts',async()=>{
 const f=await sharedFixture();
 for(const branch of ['main','task/fixture/old','task/other/old','feature/demo','test','prod']) {
  await f.git(['switch',...(branch==='main'?[]:['-c']),branch]);
  for(const name of ['push','commit-local','sync-dev']) await assert.rejects(f.invoke(name),/切换到 dev/);
 }
 await f.git(['checkout','--detach']);for(const name of ['push','commit-local','sync-dev']) await assert.rejects(f.invoke(name),/切换到 dev/);
 await f.git(['switch','dev']);const old=await f.service.inspect(f.directory);await writeFile(join(f.directory,'hello.txt'),'one');await assert.rejects(f.invoke('push','save',old),/changed/);
 f.setLogin(null);await assert.rejects(f.invoke(),/Sign in/);
 assert.equal(f.calls.some(c=>c.args.includes('add')||c.args.includes('push')||c.args.includes('fetch')),false);
});
test('push failure retains local commits and redacts errors without force',async()=>{
 const f=await sharedFixture({push:()=>{throw new Error('non-fast-forward ghp_secret');}});await writeFile(join(f.directory,'hello.txt'),'keep');await f.invoke('commit-local');
 await assert.rejects(f.invoke(),e=>{assert.match(e.message,/本地提交已保留/);assert.match(e.message,/不要强推/);assert.ok(!e.message.includes('ghp_secret'));return true;});
 assert.notEqual((await f.git(['rev-parse','HEAD'])).stdout.trim(),f.initial);assert.equal((await f.service.inspect(f.directory)).isClean,true);
 assert.equal(f.calls.some(c=>!c.args.includes('worktree')&&c.args.some(a=>a.startsWith('--force'))),false);
});
test('push rechecks preview after account and clean commit snapshot after fetch',async()=>{
 const f=await sharedFixture();f.setAccount(()=>writeFile(join(f.directory,'hello.txt'),'external'));
 await assert.rejects(f.invoke(),/changed/);assert.equal(f.calls.some(c=>c.args.includes('add')||c.args.includes('fetch')),false);
 f.setAccount(async()=>{});await f.invoke('commit-local');f.setFetch(()=>writeFile(join(f.directory,'hello.txt'),'during fetch'));f.calls.length=0;
 await assert.rejects(f.invoke(),/changed/);assert.notEqual((await f.git(['rev-parse','HEAD'])).stdout.trim(),f.initial);
 assert.equal(f.calls.some(c=>c.args.includes('merge')||c.args.includes('push')),false);
});
test('all shared dev mutations reject in-progress operations; commit-local permits only resolved merges',async()=>{
 const f=await sharedFixture();
 for(const marker of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer']) {
  const path=join(f.directory,'.git',marker);await writeFile(path,f.initial+'\n');
  for(const name of ['push','sync-dev','switch-dev',...(marker==='MERGE_HEAD'?[]:['commit-local'])]) await assert.rejects(f.invoke(name),/Git 操作/);
  const {unlink}=await import('node:fs/promises');await unlink(path);
 }
 assert.equal(f.calls.some(c=>c.args.includes('add')||c.args.includes('fetch')||c.args.includes('push')),false);
});
test('switch-dev protects ignored files and preserves existing task branch tips',async()=>{
 const f=await sharedFixture();await writeFile(join(f.directory,'local-only.txt'),'tracked dev');await f.git(['add','.']);await f.git(['commit','-m','dev file']);
 await f.git(['switch','-c','task/fixture/old',f.initial]);const task=(await f.git(['rev-parse','HEAD'])).stdout;
 await writeFile(join(f.directory,'.git','info','exclude'),'local-only.txt\n');await writeFile(join(f.directory,'local-only.txt'),'ignored work');
 await assert.rejects(f.invoke('switch-dev'));assert.equal(await readFile(join(f.directory,'local-only.txt'),'utf8'),'ignored work');assert.equal((await f.git(['rev-parse','task/fixture/old'])).stdout,task);
 assert.equal((await f.service.inspect(f.directory)).branch,'task/fixture/old');assert.equal(f.calls.some(c=>c.args.includes('reset')||c.args.includes('-D')),false);
});
test('shared dev binds every expected tuple field and rejects changed origins before writes',async()=>{
 const f=await sharedFixture();const info=await f.service.inspect(f.directory);
 for(const key of Object.keys(expected(info))) {
  const body={directory:f.directory,message:'save',...expected(info),[key]:'wrong'};
  await assert.rejects(f.service.route('push',body),e=>e.status===409);
  delete body[key];await assert.rejects(f.service.route('commit-local',body),e=>e.status===409);
 }
 await f.git(['config','remote.origin.pushurl','https://github.com/other/repository.git']);
 await assert.rejects(f.invoke(),/指定团队项目/);
 assert.equal(f.calls.some(c=>c.args.includes('add')||c.args.includes('fetch')||c.args.includes('push')),false);
});
test('switch-dev refuses detached state and detects operation started during fetch',async()=>{
 const f=await sharedFixture();await f.git(['checkout','--detach']);await assert.rejects(f.invoke('switch-dev'),/clean, attached/);
 await f.git(['switch','main']);f.setFetch(()=>writeFile(join(f.directory,'.git','MERGE_HEAD'),f.initial+'\n'));
 await assert.rejects(f.invoke('switch-dev'),/changed|Git 操作/);
 assert.equal(f.calls.some(c=>c.args.includes('switch')),false);
});
test('operation state is fingerprinted and lock stays held through network lookup',async()=>{
 const f=await sharedFixture(),before=await f.service.inspect(f.directory);await writeFile(join(f.directory,'.git','MERGE_HEAD'),f.initial+'\n');
 await assert.rejects(f.invoke('commit-local','save',before),/changed/);await f.git(['merge','--quit']);
 let release,entered;const ready=new Promise(r=>{entered=r;});f.setAccount(async()=>{entered();await new Promise(r=>{release=r;});});
 const first=f.invoke('commit-local');await ready;await assert.rejects(f.invoke('push'),/Another operation/);f.setAccount(async()=>{});release();await first;
});
