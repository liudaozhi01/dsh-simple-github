import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemporaryReleaseClient } from './temporary-release-client.js';
import { DEFAULT_RELEASE_PROFILE } from './release-profile.js';
import { NATIVE_SSH_MESSAGES } from './native-ssh.js';
const profile = structuredClone(DEFAULT_RELEASE_PROFILE);
for (const key of Object.keys(profile.baseImages)) profile.baseImages[key] = 'example/image@sha256:' + 'a'.repeat(64);
for (const message of NATIVE_SSH_MESSAGES) test('release preserves only exact safe SSH diagnostic: ' + message, async () => {
  const client = createTemporaryReleaseClient({ profile, team: true, getUser: async () => ({ name: '成员' }), transport: async () => { throw Object.assign(new Error(message), { status: 503 }); } });
  await assert.rejects(client.overview(), error => error.message === message && error.status === 503);
  client.close();
});
test('untrusted SSH diagnostics remain suppressed', async () => {
  const client = createTemporaryReleaseClient({ profile, team: true, getUser: async () => ({ name: '成员' }), transport: async () => { throw new Error('SECRET private path and server output'); } });
  await assert.rejects(client.overview(), error => !error.message.includes('SECRET'));
  client.close();
});
