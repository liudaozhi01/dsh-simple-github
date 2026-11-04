import { isAbsolute } from 'node:path';
import { createDockerReleasePreview } from './docker-release.js';

const REQUEST_KEYS = new Set(['directory', 'head', 'fingerprint', 'environment', 'backendImage', 'frontendImage', 'uid', 'gid']);

// Read-only source snapshot verification; never grants permission to deploy.
export function createDockerPreview({ inspect, getUser = async () => null }) {
  if (typeof inspect !== 'function') throw new TypeError('inspect is required');
  return async function preview(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || ![Object.prototype, null].includes(Object.getPrototypeOf(body))) throw new TypeError('预览请求必须为普通对象');
    if (Reflect.ownKeys(body).some(key => !REQUEST_KEYS.has(key))) throw new TypeError('预览请求不接受额外字段、凭据或执行参数');
    if (typeof body.directory !== 'string' || !isAbsolute(body.directory) || /[\x00-\x1f\x7f]/.test(body.directory)) throw new Error('需要源码仓库绝对路径');
    if (!/^[a-f0-9]{40}$/i.test(body.head || '') || !/^[a-f0-9]{64}$/i.test(body.fingerprint || '')) throw new Error('需要已检查的源码快照');
    // Resolve identity on the server, never trust a name/login supplied by the browser.
    if (body.environment === 'test' && (await getUser())?.name !== '刘道志') throw new Error('仅插件当前登录姓名为刘道志时可申请 test 晋级计划');
    const original = await inspect(body.directory);
    if (original.directory !== body.directory || original.head !== body.head || original.fingerprint !== body.fingerprint) throw new Error('源码快照已变化，请重新检查项目');
    if (original.repository?.toLowerCase() !== 'ssal-team/xian-oa') throw new Error('仅支持已核定的 XiAN-OA 仓库');
    if (original.branch !== 'dev' || !Array.isArray(original.changes) || original.changes.length) throw new Error('预览需使用干净的 dev 源码快照；test 仅预览环境差异，不授权发布');
    const result = createDockerReleasePreview({ environment: body.environment, head: original.head, fingerprint: original.fingerprint, backendImage: body.backendImage, frontendImage: body.frontendImage, uid: body.uid, gid: body.gid });
    const latest = await inspect(body.directory);
    if (latest.directory !== original.directory || latest.head !== original.head || latest.fingerprint !== original.fingerprint || latest.branch !== original.branch || latest.repository !== original.repository || !Array.isArray(latest.changes) || latest.changes.length) throw new Error('生成期间源码发生变化，请重新检查');
    if (body.environment === 'test' && (await getUser())?.name !== '刘道志') throw new Error('生成期间登录身份已变化，请重新登录后申请');
    return { ...result, sourceDirectory: original.directory, sourceVerified: true, imagesVerified: false, deployable: false, status: 'preview-only', publicationPolicy: 'same-image-owner-only', notice: '本地快照仅供配置草稿，不是发布来源。镜像摘要为用户输入，未验证镜像存在或来源；发布计划只接受远程 dev。test 须刘道志申请且使用已验收 dev 同镜像。没有执行构建、上传或部署。' };
  };
}
