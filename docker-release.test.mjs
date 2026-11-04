import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDockerReleasePreview} from './docker-release.js';
const digest='a'.repeat(64);
const valid={environment:'dev',head:'b'.repeat(40),fingerprint:'c'.repeat(64),backendImage:`registry.example.com/team/backend@sha256:${digest}`,frontendImage:`registry.example.com:5000/team/frontend@sha256:${digest}`,uid:10001,gid:10001};

test('pure deterministic preview and explicit pending gates, no deployment claim',()=>{
 const input=Object.freeze({...valid}),a=createDockerReleasePreview(input),b=createDockerReleasePreview(input);
 assert.deepEqual(a,b);assert.equal(a.status,'preview-only');assert.equal(a.deployable,false);
 assert.equal(a.head,valid.head);assert.equal(a.fingerprint,valid.fingerprint);
 assert.ok(a.gates.length>=9);assert.ok(a.gates.every(g=>g.status==='pending'));
 assert.ok(a.gates.some(g=>g.id==='persistence-review'));
 assert.match(a.risks.join('\n'),/NOT release locks/);assert.match(a.risks.join('\n'),/MySQL BLOBs/);assert.match(a.risks.join('\n'),/XINGLIAN_DEMO_AUTH_ENABLED=false/);assert.match(a.risks.join('\n'),/not database readiness/);
 a.gates[0].status='changed';assert.equal(createDockerReleasePreview(input).gates[0].status,'pending');
 assert.equal('commands' in a,false);
});
test('dev/test are isolated fixed projects and loopback ports without host exposure',()=>{
 for(const [environment,backendPort,frontendPort,otherBackend,otherFrontend] of [['dev',8082,28081,8081,28080],['test',8081,28080,8082,28081]]){
  const p=createDockerReleasePreview({...valid,environment});
  assert.equal(p.projectName,`xian-oa-${environment}`);assert.equal(p.backendPort,backendPort);assert.equal(p.frontendPort,frontendPort);
  assert.match(p.composeYaml,new RegExp(`name: xian-oa-${environment}\\n`));
  assert.equal((p.composeYaml.match(/network_mode: host/g)||[]).length,2);
  assert.doesNotMatch(p.composeYaml,/\bports:|\bbuild:|container_name:|healthcheck:|depends_on:/);
  assert.match(p.composeYaml,new RegExp(`SERVER_PORT: '${backendPort}'`));assert.match(p.composeYaml,/XINGLIAN_BIND_ADDRESS: '127\.0\.0\.1'/);
  assert.match(p.composeYaml,new RegExp(`/etc/xian-oa-${environment}/container\\.env`));assert.match(p.composeYaml,/format: raw/);assert.match(p.composeYaml,/required: true/);
  assert.match(p.nginxConf,new RegExp(`listen 127\\.0\\.0\\.1:${frontendPort};`));assert.match(p.nginxConf,new RegExp(`proxy_pass http://127\\.0\\.0\\.1:${backendPort};`));
  assert.doesNotMatch(p.composeYaml+p.nginxConf,new RegExp(`:${otherBackend}\\b|:${otherFrontend}\\b|0\\.0\\.0\\.0:`));
  assert.match(p.gates.find(g=>g.id==='ports-and-cutover').detail,/NOT been switched/);
   const policy=p.gates.find(g=>g.id==='publication-policy');assert.equal(policy.status,'pending');assert.match(policy.detail,environment==='test'?/does not authorize test publication/:/No automatic test promotion/);
 }
});
test('runtime images are digest-only and services are restricted non-root/read-only',()=>{
 const p=createDockerReleasePreview(valid),c=p.composeYaml;
 assert.match(c,new RegExp(`image: '${valid.backendImage}'`));assert.ok(c.includes(`image: '${valid.frontendImage}'`));
 for(const needle of ["user: '10001:10001'",'read_only: true','cap_drop: [ALL]',"security_opt: ['no-new-privileges:true']","restart: 'no'",'pull_policy: never',"max-size: '10m'","max-file: '3'",'tmpfs:'])assert.equal(c.split(needle).length-1,needle==='read_only: true'?3:2,needle);
 assert.match(c,/noexec,nosuid,nodev,size=64m,mode=1777/);
 assert.match(c,/entrypoint: \['nginx'\]/);assert.match(c,/command: \['-g', 'daemon off;'\]/);
 assert.doesNotMatch(c,/MYSQL|PASSWORD|TOKEN|SECRET|privileged:|restart: always|restart: unless-stopped/);
});
test('documentary Dockerfile templates, SPA proxy/body/temp/logging and allowlisted context',()=>{
 const p=createDockerReleasePreview(valid);
 assert.match(p.backendDockerfile,/FROM eclipse-temurin:21-jre\n/);assert.match(p.backendDockerfile,/COPY app.jar \/app\/app.jar/);assert.match(p.backendDockerfile,/ENTRYPOINT \["java", "-jar", "\/app\/app.jar"\]/);
 assert.match(p.frontendDockerfile,/FROM nginxinc\/nginx-unprivileged:stable-alpine/);assert.match(p.frontendDockerfile,/COPY web \/usr\/share\/nginx\/html/);assert.doesNotMatch(p.frontendDockerfile,/COPY nginx.conf/);assert.match(p.composeYaml,/target: \/etc\/nginx\/nginx.conf/);assert.match(p.composeYaml,/create_host_path: false/);
 for(const text of [p.backendDockerfile,p.frontendDockerfile])assert.match(text,/DOCUMENTATION TEMPLATE ONLY.*pinned/);
 assert.match(p.nginxConf,/location \/api\/ \{/);assert.match(p.nginxConf,/try_files \$uri \$uri\/ \/index.html;/);assert.match(p.nginxConf,/client_max_body_size 3m;/);
 assert.match(p.nginxConf,/pid \/tmp\/nginx.pid;/);for(const type of ['client_body','proxy','fastcgi','uwsgi','scgi'])assert.match(p.nginxConf,new RegExp(`${type}_temp_path /tmp/`));
 assert.match(p.nginxConf,/access_log off;/);assert.match(p.nginxConf,/error_log \/dev\/null crit;/);assert.doesNotMatch(p.nginxConf,/user root|log_format|\$request|\$args/);
 assert.match(p.dockerignore,/\n\*\*\n!app.jar\n!web\/\n!web\/\*\*\n!nginx.conf\n/);assert.match(p.dockerignore,/\*\*\/\*\.env/);assert.match(p.dockerignore,/\*\*\/\.env/);
});
test('reject invalid environments/snapshots, credentials and arbitrary target options',()=>{
 for(const patch of [{environment:'prod'},{environment:'DEV'},{environment:'dev\n'},{head:'a'.repeat(39)},{head:'g'.repeat(40)},{head:'a'.repeat(40)+'\n'},{fingerprint:'f'.repeat(63)},{fingerprint:'f'.repeat(64)+'\n'},{head:12},{password:'not-a-secret'},{env:{}},{backendPort:9000},{projectName:'other'},{deployable:true}])assert.throws(()=>createDockerReleasePreview({...valid,...patch}),TypeError);
 for(const input of [null,undefined,[],new Date(),'dev'])assert.throws(()=>createDockerReleasePreview(input),TypeError);
 assert.throws(()=>createDockerReleasePreview({...valid,[Symbol('credential')]:'denied'}),TypeError);
 const upper=createDockerReleasePreview({...valid,head:'A'.repeat(40),fingerprint:'B'.repeat(64)});assert.equal(upper.head,'a'.repeat(40));
});
test('restricted repository grammar refuses tags, injection, variables and malformed digests',()=>{
 const invalid=['backend:latest',`backend:latest@sha256:${digest}`,`backend@sha256:${digest}\n`,`backend@sha256:${digest}\r`,` backend@sha256:${digest}`,`backend@sha256:${digest} `,`backend@sha256:${digest.slice(1)}`,`backend@sha256:${'z'.repeat(64)}`,`backend@sha512:${digest}`,`backend@sha256:${digest}@sha256:${digest}`,`https://reg.example/backend@sha256:${digest}`,`user:password@reg.example/backend@sha256:${digest}`,`$IMAGE@sha256:${digest}`,`\${IMAGE}@sha256:${digest}`,`repo\nname@sha256:${digest}`,`repo;echo@sha256:${digest}`,`/backend@sha256:${digest}`,`../backend@sha256:${digest}`,`UPPER/backend@sha256:${digest}`,`registry.example:65536/backend@sha256:${digest}`,`registry.example:0/backend@sha256:${digest}`];
 for(const value of invalid)for(const key of ['backendImage','frontendImage'])assert.throws(()=>createDockerReleasePreview({...valid,[key]:value}),TypeError,`${key}: ${JSON.stringify(value)}`);
 for(const repository of ['backend','team/backend','docker.io/team/backend','localhost:5000/backend','registry.example:65535/team/my_backend'])assert.ok(createDockerReleasePreview({...valid,backendImage:`${repository}@sha256:${digest}`}).composeYaml.includes(repository));
});
test('UID/GID never accept root, coercion or invalid integers',()=>{
 for(const key of ['uid','gid'])for(const value of [0,-1,'1000','0',1.5,NaN,Infinity,null,undefined,2147483648,Number.MAX_SAFE_INTEGER])assert.throws(()=>createDockerReleasePreview({...valid,[key]:value}),TypeError);
 assert.match(createDockerReleasePreview({...valid,uid:1,gid:2147483647}).composeYaml,/user: '1:2147483647'/);
});
test('implementation has no IO/imports/environment/process/command execution',async()=>{
 const source=await readFile(new URL('./docker-release.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/^\s*import\b|\bimport\s*\(|\brequire\s*\(|\bprocess\s*\.|\b(?:spawn|exec|execFile|writeFile|readFile|fetch)\s*\(/m);
 assert.doesNotMatch(source,/docker compose (?:pull|build|up|stop)|docker (?:pull|build|run)|\bsudo\b/);
});
