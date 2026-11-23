import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ApiError } from '../core.js';
import { createLocalSourceBundle } from '../local-source-bundle.js';
import { createNativeSsh } from '../native-ssh.js';
import { createReleaseProgress } from '../release-progress.js';
import { validateReleaseProfile } from '../release-profile.js';
import { createTemporaryReleaseClient, createTemporaryReleaseTransport } from '../temporary-release-client.js';

export const profile = validateReleaseProfile(JSON.parse(await readFile(new URL('./release-profile.json', import.meta.url), 'utf8')));
const approvedHostKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEsD7+QgQtN+5MA6zxzkTYUtUfptKX9AQ+MjHpWP85nQ';
export const openReleaseSsh = () => createNativeSsh({
  directory: join(homedir(), '.simple-github-web-ssh'), target: profile.target, includeLegacyDsh: false,
  pinnedHostKey: approvedHostKey,
});
const approvedFingerprint = 'SHA256:SFzJDwY4+rZvFRRXO7WHtH8+rS/+YTZueV86sYYWHmI';
const scanErrors = new Set([
  '主机指纹扫描失败，请核对固定服务器连接',
  '主机指纹扫描响应无效',
  '系统 OpenSSH 不可用或连接失败，请核对配置和授权',
]);
const sshRoutes = ['ssh-config-read', 'ssh-key-discover', 'ssh-config-save', 'ssh-connection-test'];
export const releaseProgressRoute = 'docker-progress';
const methods = new Map([
  ['docker-plan', 'check'], ['docker-promote', 'promotion'], ['docker-start', 'start'],
  ['docker-overview', 'overview'], ['docker-status', 'status'], ['docker-accept', 'accept'],
  ['docker-reconcile', 'reconcile'], ['docker-restore', 'restore'],
  ['docker-migration-report', 'migrationReport'], ['docker-migration-retry', 'migrationRetry'],
]);
export const releasePostRoutes = new Set([...methods.keys(), ...sshRoutes]);

async function scanReleaseHost(ssh) {
  try {
    return await ssh.scan();
  } catch (error) {
    if (!scanErrors.has(error.message)) throw error;
    const { host, port } = profile.target;
    const endpoint = host + ':' + port;
    const diagnostic = process.platform === 'win32'
      ? '。可在 PowerShell 运行 Test-NetConnection ' + host + ' -Port ' + port
      : '';
    throw new ApiError('无法扫描发布服务器指纹。请检查本机 OpenSSH 和到 ' + endpoint + ' 的网络连接' + diagnostic, 503);
  }
}

export function createWebRelease({ getUser, ssh = openReleaseSsh(), source = createLocalSourceBundle() }) {
  const transport = createTemporaryReleaseTransport({ bridge: ssh.bridge, team: true });
  const client = createTemporaryReleaseClient({ getUser, profile, source, transport, team: true });
  const progress = createReleaseProgress();
  let savingConnection = false;
  async function checkedConnection() {
    const connection = await ssh.read();
    if (!connection.configured || !connection.trusted) {
      throw new ApiError('请先在设置中的「发布服务器连接」配置 SSH', 409);
    }
    if (connection.fingerprint !== approvedFingerprint) {
      throw new ApiError('已保存指纹与发布配置不一致，请联系管理员核对', 409);
    }
  }
  return {
    async request(name, body) {
      if (name === releaseProgressRoute) return { ok: true, progress: progress.snapshot() };
      if (sshRoutes.includes(name)) {
        if (name !== 'ssh-config-save' && Object.keys(body).length) throw new ApiError('此操作不接受参数', 400);
        if (name === 'ssh-config-read') return ssh.read();
        if (name === 'ssh-key-discover') return ssh.discover();
        if (name === 'ssh-connection-test') {
          await checkedConnection();
          return ssh.test();
        }
        if (savingConnection || progress.snapshot().state === 'running') throw new ApiError('正在保存连接或准备发布，请稍后重试', 409);
        if (Object.keys(body).length !== 2 || !Object.hasOwn(body, 'user') || !Object.hasOwn(body, 'privateKeyPath')
            || typeof body.user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(body.user) || body.user === 'root'
            || typeof body.privateKeyPath !== 'string' || !isAbsolute(body.privateKeyPath)) {
          throw new ApiError('请填写 SSH 用户名和本机私钥路径', 400);
        }
        savingConnection = true;
        try {
          const keyFile = await lstat(body.privateKeyPath).catch(() => null);
          if (!keyFile?.isFile()) {
            throw new ApiError('请选择本机已有的私钥文件，请填写包含文件名的绝对路径', 400);
          }
          const saved = await ssh.read();
          if (saved.trusted && saved.fingerprint !== approvedFingerprint) {
            throw new ApiError('已保存指纹与发布配置不一致，请联系管理员核对', 409);
          }
          if (!saved.trusted) {
            const scan = await scanReleaseHost(ssh);
            if (scan.fingerprint !== approvedFingerprint) {
              throw new ApiError('服务器指纹校验失败，请联系发布管理员', 409);
            }
            await ssh.trust({ fingerprint: approvedFingerprint });
          }
          return await ssh.save(body);
        } finally {
          savingConnection = false;
        }
      }
      const method = methods.get(name);
      if (!method) throw new ApiError('Not found', 404);
      if (name === 'docker-overview' && Object.keys(body).length) throw new ApiError('部署概览不接受参数', 400);
      if (name === 'docker-status' && Object.keys(body).some(key => key !== 'jobId')) throw new ApiError('只允许 jobId 查询', 400);
      await checkedConnection();
      if (name !== 'docker-start') return client[method](name === 'docker-status' ? body.jobId : body);
      if (savingConnection) throw new ApiError('正在保存 SSH 配置，请完成后再发布', 409);
      const onProgress = progress.begin();
      try {
        const result = await client.start(body, { onProgress });
        progress.finish(true, result);
        return result;
      } catch (error) {
        progress.finish(false);
        throw error;
      }
    },
    close() { client.close(); ssh.close(); },
  };
}
