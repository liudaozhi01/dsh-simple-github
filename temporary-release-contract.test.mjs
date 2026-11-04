import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RELEASE_PROFILE, validateReleaseProfile } from './release-profile.js';
import { createTemporaryReleaseClient } from './temporary-release-client.js';
const script = fileURLToPath(new URL('./temporary-release.py', import.meta.url));
const profile = () => { const p = structuredClone(DEFAULT_RELEASE_PROFILE); for (const k of Object.keys(p.baseImages)) p.baseImages[k] = `reviewed/${k.toLowerCase()}@sha256:${'a'.repeat(64)}`; return p; };
test('complete JS startup profile is accepted unchanged by actual Python validator', () => {
  const p = validateReleaseProfile(profile());
  const result = spawnSync('python3', ['-I', '-c', 'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("r",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); p=json.load(sys.stdin); print(json.dumps(m.validate_profile(p)))', script], { input: JSON.stringify(p), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), p);
});
test('disjoint display-name roles authorize only the remembered environment and expired plans cannot prepare source', async () => {
  const p = profile(); p.allowedNames.dev = ['Dev']; p.allowedNames.test = ['Test'];
  let name = 'Dev', prepared = 0, starts = 0, expired = false;
  const client = createTemporaryReleaseClient({ profile: p, getUser: async () => ({ name }), source: {
    resolve: async input => ({ ...input, head: 'a'.repeat(40) }),
    prepare: async () => { prepared++; return { path: '/tmp/trusted', size: 1, sha256: 'a'.repeat(64), cleanup: async () => {} }; },
  }, transport: async ({ action }) => {
    if (action === 'check' || action === 'promote') return { planId: action, environment: action === 'check' ? 'dev' : 'test', remote: { repository: p.repository, branch: p.branch, head: 'a'.repeat(40) }, expiresAt: expired ? 1 : Math.floor(Date.now()/1000)+300 };
    if (action === 'start') starts++;
    return { status: 'pending' };
  } });
  const start = planId => client.start({ planId, confirmation: true, databaseRiskAccepted: true });
  await client.check(); await start('check'); assert.equal(prepared, 1);
  name = 'Test'; await client.promotion({ releaseId: 'release' }); await start('promote'); assert.equal(prepared, 1); assert.equal(starts, 2);
  name = 'Dev'; await client.check(); name = 'Test'; await assert.rejects(start('check'), { status: 403 });
  name = 'Dev'; expired = true; await client.check(); await assert.rejects(start('check'), /过期/); assert.equal(prepared, 1);
});
