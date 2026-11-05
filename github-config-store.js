import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ApiError } from './core.js';
import { githubProjectConfig, githubConfigRevision, requireGithubAdministrator } from './github-config.js';

export const GITHUB_ADMINISTRATOR = 'liudaozhi01';
export function createGithubConfigStore({ path, getUser, activeConfig, administratorLogin = GITHUB_ADMINISTRATOR }) {
  let busy = false;
  const activeRevision = githubConfigRevision(activeConfig);
  const authorize = () => requireGithubAdministrator(getUser, administratorLogin);
  async function snapshot() {
    const config = githubProjectConfig(JSON.parse(await readFile(path, 'utf8')));
    const revision = githubConfigRevision(config);
    return {ok:true, config, revision, reloadRequired:revision !== activeRevision};
  }
  return {
    async read() { await authorize(); return snapshot(); },
    async save(body) {
      await authorize();
      if (!body || Object.keys(body).sort().join(',') !== 'config,confirmed,revision' || body.confirmed !== true) throw new ApiError('保存配置需要确认和当前版本');
      const config = githubProjectConfig(body.config);
      if (busy) throw new ApiError('配置正在保存，请稍后重试', 409);
      busy = true;
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const previous = await snapshot();
        if (body.revision !== previous.revision) throw new ApiError('配置已变化，请重新读取后保存', 409);
        await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', {flag:'wx', mode:0o644});
        await rename(temporary, path);
        return {...await snapshot(), message:'配置已写入插件包内配置文件；当前会话继续使用原配置。重载后生效，打包时会包含此配置。'};
      } finally { busy = false; await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    },
  };
}
