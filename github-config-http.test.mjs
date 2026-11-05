import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

// Exercise the actual HTTP dispatcher from an isolated install. Neither project
// configuration nor gh credentials in the developer's installation are touched.
test('packaged GitHub configuration HTTP integration (isolated fake gh)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'simple-github-config-http-'));
  const packageDirectory = join(root, 'package');
  const binDirectory = join(root, 'bin');
  const identityPath = join(root, 'identity.json');
  const callsPath = join(root, 'gh-calls.jsonl');
  const sourceDirectory = fileURLToPath(new URL('.', import.meta.url));
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  const originalPath = process.env.PATH;
  const active = { repository:'example-team/product', branch:'feature/shared-work', cloneMode:'single', cloneBranch:'feature/clone-start', updateRepository:'example-team/plugin-releases' };
  const saved = { repository:'next-team/next-product', branch:'release/team-next', cloneMode:'all', cloneBranch:'release/team-next', updateRepository:'next-team/plugin-releases' };
  const disposers = [];
  const runtimeCalls = [];
  let handler;
  const port = 51235;
  const runtime = Object.fromEntries(['check','promotion','start','status','accept','reconcile','overview','restore'].map(method => [method, async body => {
    runtimeCalls.push({method, body});
    return {ok:true};
  }]));
  const setIdentity = value => writeFile(identityPath, JSON.stringify(value));
  const commandCalls = async () => (await readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  async function request(name, {method = 'POST', token, body = {}, origin = `http://127.0.0.1:${port}`} = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, {
      method, url:`/simple-github/api/${name}`,
      headers:{host:`127.0.0.1:${port}`, 'content-type':'application/json', ...(origin === undefined ? {} : {origin}), ...(token === undefined ? {} : {'x-simple-git-token':token})},
      socket:{remoteAddress:'127.0.0.1', localPort:port},
    });
    let status, value;
    await handler(req, {setHeader() {}, writeHead(code) { status = code; }, end(data) { value = JSON.parse(data); }});
    return {status, value};
  }
  function start(apply) {
    apply({
      effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); },
      webServer:{port, register(registration) { handler = registration.handler; return () => {}; }},
    }, {dockerRuntime:runtime});
  }
  function close() { for (const dispose of disposers.splice(0).reverse()) dispose(); }
  try {
    await mkdir(packageDirectory);
    await mkdir(binDirectory);
    for (const file of new Set(['package.json', ...manifest.files])) {
      await copyFile(join(sourceDirectory, file), join(packageDirectory, file));
    }
    await writeFile(join(packageDirectory, 'github-project.json'), JSON.stringify(active));
    await writeFile(callsPath, '');
    await setIdentity({login:'ordinary-developer', name:'liudaozhi01'});
    const fakeGhScript = join(root, 'fake-gh.mjs');
    await writeFile(fakeGhScript, `import {appendFileSync, readFileSync} from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
if (JSON.stringify(args) === JSON.stringify(['api','user','--hostname','github.com'])) {
  const user = JSON.parse(readFileSync(${JSON.stringify(identityPath)}, 'utf8'));
  if (!user) process.exit(1);
  process.stdout.write(JSON.stringify(user));
} else if (args[0] === 'api' && args[1] === '--hostname' && args[2] === 'github.com' && /^repos\\/[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+\\/releases\\/latest$/.test(args[3] || '')) {
  process.stdout.write(JSON.stringify({draft:false, prerelease:false, tag_name:${JSON.stringify('v' + manifest.version)}, body:'isolated fixture', assets:[{name:${JSON.stringify('local-dsh-simple-github-' + manifest.version + '.tgz')}, id:1, size:1, digest:'sha256:' + 'a'.repeat(64)}]}));
} else {
  process.stderr.write('Unexpected fake gh invocation: ' + JSON.stringify(args));
  process.exit(97);
}
`);
    // findTool resolves this executable first; the wrapper launches Node by its
    // absolute path and cannot fall through to a real gh or any network tool.
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(join(binDirectory, 'gh'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fakeGhScript)} "$@"\n`);
    await chmod(join(binDirectory, 'gh'), 0o755);
    process.env.PATH = binDirectory + (originalPath ? ':' + originalPath : '');
    const {apply} = await import(pathToFileURL(join(packageDirectory, 'index.js')).href);
    start(apply);
    let token;
    let revision;

    await t.test('status reads packaged foreign repo, slash branch, updater repo and verified login', async () => {
      const response = await request('status', {method:'GET'});
      assert.equal(response.status, 200);
      assert.deepEqual(response.value.project, active);
      assert.equal(response.value.user.login, 'ordinary-developer');
      assert.equal(response.value.user.name, 'liudaozhi01');
      assert.equal(response.value.githubAdministrator, false);
      assert.equal(response.value.oaDeploymentAvailable, false);
      token = response.value.csrfToken;
      assert.match(token, /^[0-9a-f]{64}$/);
      const update = await request('update-check', {token});
      assert.equal(update.status, 200);
      assert.equal(update.value.currentVersion, manifest.version);
      assert.equal(update.value.available, false);
      assert.ok((await commandCalls()).some(args => args[3] === `repos/${active.updateRepository}/releases/latest`));
    });

    await t.test('configuration read/save require POST, CSRF and same-origin transport', async () => {
      for (const name of ['github-config-read','github-config-save']) {
        assert.equal((await request(name, {method:'GET', token})).status, 405);
        assert.equal((await request(name)).status, 403);
        assert.equal((await request(name, {token:'0'.repeat(64)})).status, 403);
        assert.equal((await request(name, {token, origin:'https://foreign.example'})).status, 403);
      }
    });

    await t.test('display name and request-supplied administrator identities cannot authorize', async () => {
      for (const name of ['github-config-read','github-config-save']) {
        const response = await request(name, {token, body:{login:'liudaozhi01', user:{login:'liudaozhi01'}, administratorLogin:'ordinary-developer'}});
        assert.equal(response.status, 403);
        assert.match(response.value.error, /管理员/);
      }
      await setIdentity(null);
      assert.equal((await request('github-config-read', {token})).status, 403);
      await setIdentity({login:'liudaozhi01', name:'not-the-administrator-display-name'});
      assert.equal((await request('status', {method:'GET'})).value.githubAdministrator, true);
    });

    await t.test('verified administrator reads, confirms save and rejects stale revisions', async () => {
      const read = await request('github-config-read', {token});
      assert.equal(read.status, 200);
      assert.deepEqual(read.value.config, active);
      assert.equal(read.value.reloadRequired, false);
      revision = read.value.revision;
      assert.match(revision, /^[0-9a-f]{64}$/);
      const unconfirmed = await request('github-config-save', {token, body:{config:saved, revision, confirmed:false}});
      assert.equal(unconfirmed.status, 400);
      assert.deepEqual(JSON.parse(await readFile(join(packageDirectory, 'github-project.json'), 'utf8')), active);
      const write = await request('github-config-save', {token, body:{config:saved, revision, confirmed:true}});
      assert.equal(write.status, 200);
      assert.deepEqual(write.value.config, saved);
      assert.equal(write.value.reloadRequired, true);
      assert.notEqual(write.value.revision, revision);
      assert.deepEqual(JSON.parse(await readFile(join(packageDirectory, 'github-project.json'), 'utf8')), saved);
      const stale = await request('github-config-save', {token, body:{config:active, revision, confirmed:true}});
      assert.equal(stale.status, 409);
      assert.deepEqual((await request('github-config-read', {token})).value.config, saved);
    });

    await t.test('current session retains active repo/branch/updater until reload', async () => {
      assert.deepEqual((await request('status', {method:'GET'})).value.project, active);
      const before = (await commandCalls()).length;
      assert.equal((await request('update-check', {token})).status, 200);
      assert.ok((await commandCalls()).slice(before).some(args => args[3] === `repos/${active.updateRepository}/releases/latest`));
      close();
      start(apply);
      const reloaded = await request('status', {method:'GET'});
      assert.deepEqual(reloaded.value.project, saved);
      assert.notEqual(reloaded.value.csrfToken, token);
      token = reloaded.value.csrfToken;
      assert.equal((await request('github-config-read', {token})).value.reloadRequired, false);
      const next = (await commandCalls()).length;
      assert.equal((await request('update-check', {token})).status, 200);
      assert.ok((await commandCalls()).slice(next).some(args => args[3] === `repos/${saved.updateRepository}/releases/latest`));
    });

    await t.test('all foreign-project OA endpoints reject before invoking trusted runtime', async () => {
      const before = (await commandCalls()).length;
      for (const name of ['docker-overview','docker-status','docker-accept','docker-reconcile','docker-start','docker-plan','docker-promote','docker-restore','docker-preview','deploy-status','deploy-start','deploy-stop','deploy-check','deploy-confirm','remote-dev-check','remote-dev-start','remote-dev-status','remote-deploy-notify','environment-inspect','environment-notify']) {
        const response = await request(name, {token});
        assert.equal(response.status, 409, name);
        assert.match(response.value.error, /OA 专属部署|未启用受控 Docker 部署/, name);
      }
      assert.deepEqual(runtimeCalls, []);
      assert.equal((await commandCalls()).length, before);
    });
  } finally {
    close();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    assert.equal(root.startsWith(join(tmpdir(), 'simple-github-config-http-')), true);
    await rm(root, {recursive:true, force:true});
  }
});
