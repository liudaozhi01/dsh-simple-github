import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerBuildFiles, createApplicationOverride } from './docker-server-config.js';
const base = n => `example.com/base/${n}@sha256:${'a'.repeat(64)}`;
test('server multi-stage builds use pinned bases and retain tests, without host npm or Maven', () => {
  const p = createServerBuildFiles({head:'b'.repeat(40),nodeBase:base('node'),mavenBase:base('maven'),javaBase:base('java'),nginxBase:base('nginx')});
  assert.match(p.backendDockerfile,/RUN mvn -B package/);
  assert.doesNotMatch(p.backendDockerfile,/skipTests|docker.sock/);
  assert.match(p.backendDockerfile,/USER 10001:10001/);
  assert.match(p.frontendDockerfile,/RUN npm ci && npm run build/);
  assert.doesNotMatch(p.frontendDockerfile,/COPY.*nginx.conf/);
  assert.match(p.dockerignore,/\*\*\/\*\.env/);
});
test('application override targets only existing api/web and preserves runtime nginx mount', () => {
  for(const environment of ['dev','test']) {
    const p = createApplicationOverride({environment,backendImage:base('api'),frontendImage:base('web')});
    assert.match(p.composeYaml,/volumes: !override \[\]/);
    assert.match(p.composeYaml,/target: \/etc\/nginx\/conf.d\/default.conf/);
    assert.match(p.composeYaml,/XINGLIAN_DEMO_AUTH_ENABLED: 'false'/);
    assert.doesNotMatch(p.composeYaml,/\n  db:|network_mode|mysql-data|app.jar|\/web\n/);
    assert.deepEqual(p.updateArguments.slice(-2),['api','web']);
    assert.ok(p.updateArguments.includes('--no-deps'));
    assert.equal(p.deployable,false);
  }
});
test('reject local overrides, mutable bases and command injection', () => {
  assert.throws(()=>createApplicationOverride({environment:'dev',backendImage:'java:21',frontendImage:base('web')}));
  assert.throws(()=>createApplicationOverride({environment:'dev',backendImage:base('api'),frontendImage:base('web'),directory:'/tmp/local'}));
  assert.throws(()=>createServerBuildFiles({head:'b'.repeat(40),nodeBase:base('node')+'\nRUN whoami',mavenBase:base('maven'),javaBase:base('java'),nginxBase:base('nginx')}));
});
