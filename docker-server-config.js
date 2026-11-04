// Configuration generation only. Never uploads, builds, or changes a server.
const DIGEST = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$(?![\s\S])/;
function image(value) {
  if (typeof value !== 'string' || value.length > 512 || !DIGEST.test(value)) throw new TypeError('Reviewed image@sha256 required');
  return value;
}
function data(value, keys) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(k => !keys.includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k), 'value'))) throw new TypeError('Explicit configuration fields only');
}
/** Multi-stage builds run on the SERVER; build contexts must be an isolated remote-dev checkout.
 * No DB env files belong in this context. Maven tests remain enabled: Docker-dependent
 * integration tests require an independently approved test setup, never production DB access.
 */
export function createServerBuildFiles(input) {
  data(input, ['head', 'nodeBase', 'mavenBase', 'javaBase', 'nginxBase']);
  const { head } = input;
  if (typeof head !== 'string' || !/^[a-f0-9]{40}$(?![\s\S])/.test(head)) throw new TypeError('Locked remote dev SHA required');
  const node = image(input.nodeBase), maven = image(input.mavenBase), java = image(input.javaBase), nginx = image(input.nginxBase);
  return {
    backendDockerfile: `FROM ${maven} AS build\nWORKDIR /src\nCOPY backend/ ./\nRUN mvn -B package\nRUN set -eu; set -- target/*.jar; test "$#" -eq 1; cp "$1" /app.jar\nFROM ${java}\nLABEL org.opencontainers.image.revision="${head}"\nWORKDIR /app\nCOPY --from=build --chown=10001:10001 /app.jar /app/app.jar\nUSER 10001:10001\nENTRYPOINT ["java", "-jar", "/app/app.jar"]\n`,
    frontendDockerfile: `FROM ${node} AS build\nWORKDIR /src\nCOPY . .\nRUN npm ci && npm run build\nFROM ${nginx}\nLABEL org.opencontainers.image.revision="${head}"\nCOPY --from=build /src/dist/ /usr/share/nginx/html/\n`,
    dockerignore: '.git\n**/node_modules\n**/target\ndist\n**/.env\n**/.env.*\n**/*.env\n**/.npmrc\n**/settings.xml\n**/*.pem\n**/*.key\n',
    requires: ['Node base compatible with repository engines', 'Maven base with Java 21', 'Reviewed base digests available on server', 'Isolated build tests; no business DB credentials', 'Immutable remote-dev checkout verified before upload'],
  };
}
/** Merge with the existing deployment compose.yaml; never replace the whole project.
 * !override removes ONLY application artifact mounts. Existing env_file, command,
 * networks, ports, db definition and named volumes are inherited unchanged.
 */
export function createApplicationOverride(input) {
  data(input, ['environment', 'backendImage', 'frontendImage']);
  const { environment } = input;
  if (!['dev', 'test'].includes(environment)) throw new TypeError('dev or test required');
  const backend = image(input.backendImage), frontend = image(input.frontendImage);
  const root = `/opt/xian-oa-${environment}-docker`;
  return {
    projectDirectory: root,
    composeYaml: `# Merge with existing compose.yaml. Requires Compose >= 2.24.4 (!override).\nservices:\n  api:\n    image: '${backend}'\n    pull_policy: never\n    volumes: !override []\n    environment:\n      XINGLIAN_DEMO_AUTH_ENABLED: 'false'\n  web:\n    image: '${frontend}'\n    pull_policy: never\n    volumes: !override\n      - type: bind\n        source: ${root}/nginx.conf\n        target: /etc/nginx/conf.d/default.conf\n        read_only: true\n        bind:\n          create_host_path: false\n`,
    updateArguments: ['compose', '--project-directory', root, '-f', `${root}/compose.yaml`, '-f', `${root}/application-release.yaml`, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api', 'web'],
    deployable: false,
    gates: ['Validate merged Compose against inspected live snapshot', 'Verify only api/web artifact mounts change; preserve db/network/volumes', 'Build and verify immutable image identity on server', 'Persist old image pair and recovery marker before applying', 'Explicit confirmation and DB migration risk acknowledgement'],
  };
}
