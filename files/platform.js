import { spawn as nodeSpawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { constants } from 'node:fs';
import path from 'node:path';

const owned = new WeakMap();
const pathsFor = platform => platform === 'win32' ? path.win32 : path.posix;
export function platformInfo(platform = process.platform) {
  return { platform, label: platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform, isWindows: platform === 'win32' };
}
export function normalizeEnv(env, platform = process.platform) {
  if (platform !== 'win32') return { ...env };
  const result = {};
  // Fold *all* keys: Node otherwise chooses one arbitrary case variant on Windows.
  for (const [key, value] of Object.entries(env || {})) result[key.toUpperCase()] = value;
  return result;
}
export function isWithin(root, candidate, platform = process.platform) {
  if (typeof root !== 'string' || typeof candidate !== 'string' || /[\0\r\n]/.test(root + candidate)) return false;
  const p = pathsFor(platform);
  if (!p.isAbsolute(root) || !p.isAbsolute(candidate)) return false;
  const relative = p.relative(p.resolve(root), p.resolve(candidate));
  return relative === '' || (!p.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${p.sep}`));
}
/** No shell/which/where execution. Tests may inject accessImpl/statImpl. */
export async function findTool(name, { env = process.env, platform = process.platform, accessImpl = access, statImpl = stat, extraPaths = [] } = {}) {
  const p = pathsFor(platform), windows = platform === 'win32';
  env = normalizeEnv(env, platform);
  if (typeof name !== 'string' || !name || /[\0\r\n]/.test(name)) return null;
  const extensions = windows && !p.extname(name) ? (env.PATHEXT || '.EXE;.COM;.CMD;.BAT').split(';').filter(ext => /^\.(?:exe|com|cmd|bat)$/i.test(ext)) : [''];
  const directories = (env.PATH || '').split(windows ? ';' : ':').map(value => value.replace(/^"(.*)"$/, '$1')).filter(value => p.isAbsolute(value));
  const candidates = p.isAbsolute(name) ? extensions.map(ext => name + ext) : /[\\/]/.test(name) ? [] : [...directories.flatMap(dir => extensions.map(ext => p.join(dir, name + ext))), ...extraPaths];
  for (const candidate of candidates) {
    if (!p.isAbsolute(candidate)) continue;
    try { await accessImpl(candidate, windows ? constants.F_OK : constants.X_OK); if ((await statImpl(candidate)).isFile()) return candidate; } catch {}
  }
  return null;
}
function systemTool(name, env) {
  const root = env.SYSTEMROOT || 'C:\\Windows';
  if (!path.win32.isAbsolute(root) || /[\0\r\n"%!*?&|<>^]/.test(root)) throw new Error('Unsafe Windows system directory');
  return path.win32.join(root, 'System32', name);
}
/** .cmd is never launched with shell:true. npm uses its JS entrypoint where available;
 * other batch tools accept only controlled argv with no cmd expansion/metacharacters.
 */
export function spawnPortable(command, args = [], options = {}) {
  const { platform = process.platform, spawnImpl = nodeSpawn, existsImpl = existsSync, nodePath = process.execPath, ...config } = options;
  const env = normalizeEnv(config.env || process.env, platform);
  let executable = command, argv = [...args];
  const windows = platform === 'win32';
  if (windows && /\.(?:cmd|bat)$/i.test(command)) {
    const cli = path.win32.join(path.win32.dirname(command), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (/^npm\.cmd$/i.test(path.win32.basename(command)) && existsImpl(cli)) { executable = nodePath; argv = [cli, ...args]; }
    else {
      if (typeof config.cwd === 'string' && /^\\\\/.test(config.cwd)) throw new Error('Windows batch tools require a local drive working directory; UNC project paths are not supported');
      // cmd performs expansions even inside quotes. Reject rather than attempt unsafe escaping.
      for (const value of [command, ...args]) if (typeof value !== 'string' || /[\0\r\n"%!*?&|<>^]/.test(value)) throw new Error('Unsafe Windows batch argument: batch tool paths and arguments cannot contain quotes, %, !, &, |, <, >, ^ or control characters; move the tool to a simple path');
      executable = systemTool('cmd.exe', env);
      argv = ['/d', '/s', '/v:off', '/c', `"${[command, ...args].map(value => `"${value}"`).join(' ')}"`];
      config.windowsVerbatimArguments = true;
    }
  }
  const child = spawnImpl(executable, argv, { ...config, env, shell: false, windowsHide: true });
  const record = { platform, env, spawnImpl, exited: false, stopping: null, detached: !!config.detached };
  owned.set(child, record);
  child.once('close', () => { record.exited = true; });
  child.once('error', () => { record.exited = true; });
  return child;
}
/** Only accepts children returned by spawnPortable; never selects processes by name/port.
 * taskkill /T /F targets one still-owned live PID (no wildcard or shell). Already exited
 * Windows parents are not signalled because their PID may have been reused.
 */
export async function terminateTree(child, { platform, spawnImpl, killImpl = process.kill.bind(process), grace = 500, taskkillTimeout = 5000, delayImpl = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const record = owned.get(child);
  if (!record) throw new Error('Refusing to terminate an unowned process');
  if (record.stopping) return record.stopping;
  if (platform && platform !== record.platform) throw new Error('Process platform mismatch');
  record.stopping = (async () => {
    const pid = child.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    if (record.platform === 'win32') {
      if (record.exited || child.exitCode != null || child.signalCode != null) return;
      await new Promise((resolve, reject) => {
        const killer = (spawnImpl || record.spawnImpl)(systemTool('taskkill.exe', record.env), ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore', env: record.env });
        const timer = setTimeout(() => {
          // This helper is itself our owned child; never fall back to broad process selection.
          try { killer.kill(); } catch {}
          reject(new Error('taskkill timed out; process tree cleanup could not be confirmed'));
        }, taskkillTimeout);
        killer.once('error', error => { clearTimeout(timer); reject(error); });
        killer.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`taskkill failed (${code}); process tree cleanup could not be confirmed`)); });
      });
      return;
    }
    const signal = name => { try { if (record.detached) killImpl(-pid, name); else if (!record.exited) child.kill(name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    signal('SIGTERM'); await delayImpl(grace); signal('SIGKILL');
  })();
  try { return await record.stopping; }
  catch (error) { record.stopping = null; throw error; }
}
