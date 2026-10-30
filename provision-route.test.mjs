import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDeploy } from './local-deploy.js';

test('only startup supplies installer runner and occupied ports reject before tool discovery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'provision-route-'));
  await mkdir(join(root, 'backend'));
  await writeFile(join(root, 'package.json'), '{"scripts":{"build":"vite build"},"dependencies":{"react":"19","vite":"6"}}');
  await writeFile(join(root, 'backend/pom.xml'), '<project/>');
  t.after(() => rm(root, {recursive:true,force:true}));
  const inspected = [];
  async function exercise(route, occupied) {
    const deploy = createLocalDeploy({inspect: async () => ({directory:root,head:'head',fingerprint:'fp'})}, {
      platform:'win32', env:{}, portAvailable:async () => !occupied,
      discover:async (_env, options) => { inspected.push(options); throw new Error('test discovery boundary'); },
    });
    try {
      await deploy.route(route,{directory:root});
      for(let i=0;i<100;i++) {
        const status=await deploy.route('deploy-status');
        if(status.state==='failed' || status.error) return status;
        await new Promise(resolve=>setTimeout(resolve,5));
      }
      assert.fail('deployment did not finish');
    } finally { await deploy.close(); }
  }
  await exercise('deploy-start',false);
  assert.equal(typeof inspected[0].run,'function');
  await exercise('deploy-check',false);
  assert.equal(inspected[1].run,undefined);
  const occupied=await exercise('deploy-start',true);
  assert.match(occupied.error,/端口/);
  assert.equal(inspected.length,2);
});
