import { readdir, readFile } from 'node:fs/promises';
import { win32 as path } from 'node:path';
import { findTool, normalizeEnv } from './platform.js';

// Package IDs verified against microsoft/winget-pkgs. Never accept IDs, URLs,
// commands or installer flags from a repository, HTTP body or package.json.
export const WINDOWS_PACKAGES = Object.freeze({ npm: 'OpenJS.NodeJS.LTS', jdk: 'EclipseAdoptium.Temurin.21.JDK' });
export const MAVEN_VERSION = '3.9.11';
export const MAVEN_SHA512 = '03e2d65d4483a3396980629f260e25cac0d8b6f7f2791e4dc20bc83f9514db8d0f05b0479e699a5f34679250c49c8e52e961262ded468a20de0be254d8207076';
// Apache.Maven is not in winget. Use an official, version-pinned archive with a
// built-in digest, not a downloaded installer script or unverified checksum.
export const MAVEN_INSTALL_SCRIPT = `$ErrorActionPreference='Stop'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$root=Join-Path $env:LOCALAPPDATA 'DeepSeekHarness\\tools'
$stage=Join-Path $root ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  $zip=Join-Path $stage 'maven.zip'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.zip' -OutFile $zip
  if ((Get-FileHash -LiteralPath $zip -Algorithm SHA512).Hash -ne '${MAVEN_SHA512}') { throw 'Maven SHA512 verification failed' }
  Expand-Archive -LiteralPath $zip -DestinationPath $stage
  $target=Join-Path $root 'apache-maven-${MAVEN_VERSION}'
  if (Test-Path -LiteralPath $target) { throw 'Maven target already exists but is unusable; remove or repair it manually' }
  Move-Item -LiteralPath (Join-Path $stage 'apache-maven-${MAVEN_VERSION}') -Destination $target
} finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
`;
const fail = message => Object.assign(new Error(message), { status: 503 });
const safeRoot = value => typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/.test(value) ? value : null;

/** Trusted test seams only. run uses deployment-owned processes/timeouts and
 * must reject on cancellation. Only the caller's private environment is changed.
 * Fixed roots avoid stale GUI PATH without registry scripts or persistent writes.
 */
export async function discoverWindowsTools(env, { findToolImpl = findTool, readFileImpl = readFile, readdirImpl = readdir, run, log = () => {}, check = () => {}, nodePath = process.execPath } = {}) {
  const normalized = normalizeEnv(env, 'win32');
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, normalized);
  const local = safeRoot(env.LOCALAPPDATA), program = safeRoot(env.PROGRAMFILES) || 'C:\\Program Files';
  const system = safeRoot(env.SYSTEMROOT) || 'C:\\Windows';
  const toolsRoot = local && path.join(local, 'DeepSeekHarness', 'tools');
  const find = (name, extraPaths = []) => findToolImpl(name, { env, platform: 'win32', extraPaths });
  async function scan() {
    check();
    const mvn = await find('mvn', [toolsRoot && path.join(toolsRoot, `apache-maven-${MAVEN_VERSION}`, 'bin', 'mvn.cmd'), safeRoot(env.MAVEN_HOME) && path.join(env.MAVEN_HOME, 'bin', 'mvn.cmd')].filter(Boolean));
    const npm = await find('npm', [path.join(program, 'nodejs', 'npm.cmd'), local && path.join(local, 'Programs', 'nodejs', 'npm.cmd')].filter(Boolean));
    const homes = [safeRoot(env.JAVA_HOME)];
    const java = await find('java');
    if (java) homes.push(path.dirname(path.dirname(java)));
    for (const root of [path.join(program, 'Eclipse Adoptium'), path.join(program, 'Java'), path.join(program, 'Microsoft')]) {
      let entries = [];
      try { entries = await readdirImpl(root, { withFileTypes: true }); } catch (cause) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(cause.code)) throw cause; }
      for (const entry of entries.slice(0, 256).sort((a, b) => b.name.localeCompare(a.name))) {
        if (entry.isDirectory() && /^jdk[-\w.+]*$/i.test(entry.name)) homes.push(path.join(root, entry.name));
      }
    }
    let jdk = null;
    for (const home of new Set(homes.filter(Boolean))) {
      if (!await find(path.join(home, 'bin', 'java.exe')) || !await find(path.join(home, 'bin', 'javac.exe'))) continue;
      let release;
      try { release = await readFileImpl(path.join(home, 'release'), 'utf8'); } catch { continue; }
      const version = /^JAVA_VERSION="(\d+)(?:[.\-+_"])/m.exec(release);
      if (version && Number(version[1]) >= 21) { jdk = home; break; }
    }
    check();
    return { mvn, npm, jdk };
  }
  let found = await scan();
  const missing = Object.keys(found).filter(key => !found[key]);
  if (missing.length) {
    if (typeof run !== 'function') throw fail(`Windows 缺少 ${missing.join('、')}；当前检查不安装工具，请点击“启动本地环境”（自动安装运行器仅启动时可用）`);
    log(`\n[tools] Windows 缺少 ${missing.join('、')}；正在自动安装固定工具（可能联网、显示正常 UAC 提示；不会绕过权限）。\n`);
    let winget;
    if (missing.some(key => key !== 'mvn')) {
      winget = await find('winget.exe', [local && path.join(local, 'Microsoft', 'WindowsApps', 'winget.exe')].filter(Boolean));
      if (!winget) throw fail('自动安装需要 Windows App Installer (winget)；请从 Microsoft Store 安装/修复后重试；不会回退到任意安装脚本');
    }
    for (const key of missing) {
      check();
      try {
        if (key === 'mvn') {
          if (!local) throw fail('Maven 自动安装需要有效的 LOCALAPPDATA 绝对目录');
          const powershell = await find(path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
          if (!powershell) throw fail('Maven 自动安装需要 Windows PowerShell；不会绕过执行策略');
          await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', MAVEN_INSTALL_SCRIPT], system, 'Maven verified archive install');
        } else {
          await run(winget, ['install', '--id', WINDOWS_PACKAGES[key], '--exact', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'], system, `${WINDOWS_PACKAGES[key]} install`);
        }
      } catch (cause) {
        check(); // Preserve cancellation rather than disguising it as installer failure.
        throw fail(`Windows 工具 ${key} 自动安装失败: ${cause.message}；请检查网络、winget 来源、UAC/权限或手动安装；不会重试其他脚本`);
      }
      check();
    }
    log('\n[tools] 安装命令完成；重新检查工具（仅一次，不会循环安装）。\n');
    found = await scan();
    const remaining = Object.keys(found).filter(key => !found[key]);
    if (remaining.length) throw fail(`安装后仍未发现 ${remaining.join('、')}（需要完整 JDK 21+）；请检查安装结果或手动配置后重试，不会循环安装`);
  }
  env.JAVA_HOME = found.jdk;
  // Private child environment only: Maven needs JAVA_HOME, npm scripts need PATH.
  env.PATH = [...new Set([path.join(found.jdk, 'bin'), path.dirname(found.npm), path.dirname(found.mvn), env.PATH].filter(Boolean))].join(';');
  log('\n[tools] Maven、npm、JDK 21+ 已就绪，继续本地部署。\n');
  return { mvn: found.mvn, npm: found.npm, node: nodePath };
}
