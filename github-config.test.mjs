import test from 'node:test';
import assert from 'node:assert/strict';
import { githubBranch, githubProjectConfig, githubConfigRevision, requireGithubAdministrator } from './github-config.js';

const project = { repository:'https://github.com/example/application.git', branch:'feature/shared', updateRepository:'example/plugin-updates' };
test('normalizes GitHub repository URLs and preserves slash branch names', () => {
  assert.deepEqual(githubProjectConfig(project), { repository:'example/application', branch:'feature/shared', cloneMode:'single', cloneBranch:'feature/shared', updateRepository:'example/plugin-updates' });
  assert.equal(githubConfigRevision(project), githubConfigRevision({...project, repository:'example/application'}));
  assert.notEqual(githubConfigRevision(project), githubConfigRevision({...project, branch:'main'}));
});
test('rejects unsafe ref expressions, invalid branch components and non GitHub URLs', () => {
  for (const branch of ['', '-main', 'refs/heads/main', 'a:b', 'a..b', 'a@{1}', 'a b', 'a\nb', 'a\\b', 'a[1]', 'a*', 'a?', 'a^', 'a~', 'a/', '/a', 'a//b', '.hidden', 'a.lock', 'a/b.', '@']) {
    assert.throws(() => githubBranch(branch), undefined, branch);
  }
  assert.throws(() => githubProjectConfig({...project, repository:'https://evil.example/a/b'}));
  assert.throws(() => githubProjectConfig({...project, updateRepository:'https://token@github.com/a/b'}));
  assert.throws(() => githubProjectConfig({...project, administratorLogin:'intruder'}));
});
test('clone settings support legacy defaults and validate independent branch',()=>{
 const legacy=githubProjectConfig(project);assert.equal(legacy.cloneMode,'single');assert.equal(legacy.cloneBranch,project.branch);
 const all=githubProjectConfig({...project,cloneMode:'all',cloneBranch:'seed/base'});assert.equal(all.cloneMode,'all');assert.equal(all.cloneBranch,'seed/base');
 assert.notEqual(githubConfigRevision(all),githubConfigRevision(legacy));
 for(const change of [{cloneMode:'bad',cloneBranch:'main'},{cloneMode:'single',cloneBranch:'a:b'},{cloneMode:'all'}])assert.throws(()=>githubProjectConfig({...project,...change}));
});
test('admin authorization fails closed and ignores mutable display names', async () => {
  await assert.rejects(requireGithubAdministrator(async () => null, 'admin'), {status:403});
  await assert.rejects(requireGithubAdministrator(async () => ({login:'member', name:'admin'}), 'admin'), {status:403});
  await assert.rejects(requireGithubAdministrator(async () => ({login:'admin'}), undefined), {status:403});
  assert.equal((await requireGithubAdministrator(async () => ({login:'Admin'}), 'admin')).login, 'Admin');
});
