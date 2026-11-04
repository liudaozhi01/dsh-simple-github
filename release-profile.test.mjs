import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RELEASE_PROFILE, validateReleaseProfile } from './release-profile.js';
export function fixtureProfile() {
  const profile = structuredClone(DEFAULT_RELEASE_PROFILE);
  for (const name of Object.keys(profile.baseImages)) profile.baseImages[name] = `reviewed/${name.toLowerCase()}@sha256:${'a'.repeat(64)}`;
  return profile;
}
test('profile defaults explicitly fail unconfigured, valid profile deeply cloned and frozen', () => {
  assert.throws(() => validateReleaseProfile(DEFAULT_RELEASE_PROFILE), /baseImages/);
  const input = fixtureProfile(), result = validateReleaseProfile(input);
  input.target.host = 'changed'; input.allowedNames.dev.push('other');
  assert.equal(result.target.host, '119.45.50.213'); assert.deepEqual(result.allowedNames.dev, ['刘道志']);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.allowedNames.dev));
});
test('profile rejects unknown fields, accessors, mutable tags, overlap and invalid names', () => {
  const changes = [p => { p.extra = true; }, p => { p.target.command = 'x'; }, p => { p.baseImages.node = 'node:22'; }, p => { p.roots.test = p.roots.dev + '/nested'; }, p => { p.stateRoot = '/'; }, p => { p.allowedNames.dev = [' owner ']; }, p => { p.projects.test = p.projects.dev; }, p => { p.target.port = '22'; }, p => { p.roots.dev += '/..'; }, p => { p.repository += '\n'; }, p => { Object.defineProperty(p, 'branch', { get() { throw Error('must not execute'); }, enumerable: true }); }];
  for (const change of changes) { const profile = fixtureProfile(); change(profile); assert.throws(() => validateReleaseProfile(profile), TypeError); }
});
