// Trusted startup configuration only. Never accept a profile from an HTTP request.
const fields = (value, keys) => {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) || Reflect.ownKeys(value).some(key => !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw new TypeError('Explicit complete release profile fields required');
};
const text = (value, pattern, label) => { if (typeof value !== 'string' || value.length > 512 || !pattern.test(value)) throw new TypeError(`Invalid release profile ${label}`); return value; };
const path = value => { text(value, /^\/[A-Za-z0-9_./-]+$(?![\s\S])/, 'path'); if (value === '/' || value.split('/').slice(1).some(p => !p || p === '.' || p === '..')) throw new TypeError('Canonical non-root release path required'); return value; };
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };
export const DEFAULT_RELEASE_PROFILE = freeze({
  repository: 'ssal-team/xian-oa', branch: 'dev',
  target: { alias: 'xian-oa-test', host: '119.45.50.213', user: 'liudaozhi', port: 22 },
  roots: { dev: '/opt/xian-oa-dev-docker', test: '/opt/xian-oa-test-docker' },
  projects: { dev: 'xian-oa-dev', test: 'xian-oa-test' },
  stateRoot: '/var/lib/xian-oa-release',
  // Intentionally unconfigured: no invented or mutable image pins.
  baseImages: { node: null, mavenJava21: null, java: null, nginx: null },
  allowedNames: { dev: ['刘道志'], test: ['刘道志'] },
});
export function validateReleaseProfile(input) {
  fields(input, ['repository', 'branch', 'target', 'roots', 'projects', 'stateRoot', 'baseImages', 'allowedNames']);
  text(input.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$(?![\s\S])/, 'repository');
  if (input.repository.endsWith('.git')) throw new TypeError('Repository slug must omit .git');
  text(input.branch, /^[A-Za-z0-9][A-Za-z0-9_/-]*$(?![\s\S])/, 'branch');
  if (input.branch.includes('//') || input.branch.endsWith('/')) throw new TypeError('Invalid release branch');
  fields(input.target, ['alias', 'host', 'user', 'port']);
  text(input.target.alias, /^[A-Za-z0-9][A-Za-z0-9_.-]*$(?![\s\S])/, 'alias');
  text(input.target.host, /^[A-Za-z0-9][A-Za-z0-9.:-]*$(?![\s\S])/, 'host');
  text(input.target.user, /^[a-z_][a-z0-9_-]*$(?![\s\S])/, 'user');
  if (!Number.isInteger(input.target.port) || input.target.port < 1 || input.target.port > 65535) throw new TypeError('Invalid release SSH port');
  for (const key of ['roots', 'projects', 'allowedNames']) fields(input[key], ['dev', 'test']);
  path(input.stateRoot);
  if (!/^\/(?:opt|var\/lib)\/[A-Za-z0-9_/-]+$/.test(input.stateRoot)) throw new TypeError('Controlled /opt or /var/lib state path required');
  for (const environment of ['dev', 'test']) {
    path(input.roots[environment]);
    if (!/^\/opt\/[A-Za-z0-9_/-]+$/.test(input.roots[environment])) throw new TypeError('Controlled /opt deployment root required');
    text(input.projects[environment], /^[a-z0-9][a-z0-9_-]*$(?![\s\S])/, 'project');
    const names = input.allowedNames[environment];
    if (!Array.isArray(names) || !names.length || names.length > 32 || Object.keys(names).length !== names.length || Reflect.ownKeys(names).some(key => key !== 'length' && (!/^\d+$/.test(String(key)) || !Object.hasOwn(Object.getOwnPropertyDescriptor(names, key), 'value'))) || names.some(name => typeof name !== 'string' || !name.trim() || name !== name.trim() || /[\x00-\x1f\x7f]/.test(name) || name.length > 100) || new Set(names).size !== names.length) throw new TypeError('Exact nonempty allowedNames required');
  }
  const paths = [input.roots.dev, input.roots.test, input.stateRoot];
  if (paths.some((a, i) => paths.some((b, j) => i !== j && (a === b || a.startsWith(b + '/')))) || input.projects.dev === input.projects.test) throw new TypeError('Release environments and state must be disjoint');
  fields(input.baseImages, ['node', 'mavenJava21', 'java', 'nginx']);
  for (const image of Object.values(input.baseImages)) text(image, /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$(?![\s\S])/, 'baseImages: reviewed digest pins required; default is unconfigured');
  return freeze(structuredClone(input));
}
