import { createHash } from 'node:crypto';
import { ApiError, normalizeCloneRepository } from './core.js';

// Git ref validation without invoking a shell. Slash-separated branch names are
// supported; refspecs, revision expressions and option-like names are not.
export function githubBranch(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || value !== value.trim()
      || value.startsWith('-') || value.startsWith('refs/') || value === '@'
      || /[\x00-\x20\x7f~^:?*\[\\]/.test(value) || value.includes('..') || value.includes('@{')
      || value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new ApiError('分支名称无效，请填写完整分支名，不要填写 URL、refspec 或提交表达式');
  }
  return value;
}

export function githubProjectConfig(value) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || !['branch,repository,updateRepository','branch,cloneBranch,cloneMode,repository,updateRepository'].includes(Object.keys(value).sort().join(','))) {
    throw new ApiError('配置只允许项目仓库、协作分支、克隆模式、克隆分支和插件更新仓库');
  }
  const legacy = Object.keys(value).length === 3;
  const cloneMode = legacy ? 'single' : value.cloneMode;
  if (!['all','single'].includes(cloneMode)) throw new ApiError('克隆模式必须是 all 或 single');
  return Object.freeze({
    repository: normalizeCloneRepository(value.repository),
    branch: githubBranch(value.branch),
    cloneMode,
    cloneBranch: githubBranch(legacy ? value.branch : value.cloneBranch),
    updateRepository: normalizeCloneRepository(value.updateRepository),
  });
}

export function githubConfigRevision(value) {
  return createHash('sha256').update(JSON.stringify(githubProjectConfig(value))).digest('hex');
}

// Administrator identity is supplied by trusted bootstrap, never the request or
// the editable project configuration. An unconfigured identity fails closed.
export async function requireGithubAdministrator(getUser, administratorLogin) {
  const account = await getUser();
  if (typeof administratorLogin !== 'string' || !administratorLogin
      || !account?.login || account.login.toLowerCase() !== administratorLogin.toLowerCase()) {
    throw new ApiError('只有已核验的插件管理员可以修改 GitHub 配置', 403);
  }
  return account;
}
