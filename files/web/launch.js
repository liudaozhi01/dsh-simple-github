import { readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, plainFilePath, updateFiles, validateManifest } from './update.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const backup = join(root, '.web-update-backup');
const journal = join(backup, 'transaction.json');
const stage = join(root, '.web-update-stage');
const lock = join(root, 'web/.launcher.lock');
let ownsLock = false;
async function acquireLock() {
  try {
    await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    ownsLock = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('启动锁文件无效，请核对是否已有服务运行');
    try { process.kill(pid, 0); } catch (probe) {
      if (probe.code !== 'ESRCH') throw probe;
      await rm(lock);
      return acquireLock();
    }
    throw Error('此目录已有 Web 服务运行，请使用已打开的服务窗口');
  }
}
function releaseLock() {
  if (!ownsLock) return;
  if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock);
  ownsLock = false;
}
process.on('exit', () => { try { releaseLock(); } catch {} });
let child, stopping = false, changing = false;
async function exists(path) { return Boolean(await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; })); }
async function restore() {
  if (!await exists(journal)) return;
  const transaction = JSON.parse(await readFile(journal, 'utf8'));
  for (const item of transaction.files) {
    if (!updateFiles.includes(item.path)) throw Error('Invalid recovery path');
    const destination = await plainFilePath(root, item.path);
    if (item.existed) {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(backup, item.path), destination);
      if (item.path === 'start.command') await chmod(destination, 0o755);
    } else await rm(destination, { force: true });
  }
  await rm(backup, { recursive: true, force: true });
  await rm(stage, { recursive: true, force: true });
  console.log('更新未完成，已恢复上一版本。');
}
async function install() {
  const saved = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8'));
  const manifest = validateManifest(saved.manifest, new URL(saved.base));
  if (await exists(backup)) throw Error('存在上次更新备份，请重新启动');
  await mkdir(backup);
  const files = [];
  for (const item of manifest.files) {
    const source = await plainFilePath(stage, item.path);
    const bytes = await readFile(source);
    if (bytes.length !== item.size || digest(bytes) !== item.sha256) throw Error('更新暂存文件校验失败');
    const destination = await plainFilePath(root, item.path);
    const existed = await exists(destination);
    if (existed) {
      const saved = join(backup, item.path);
      await mkdir(dirname(saved), { recursive: true });
      await copyFile(destination, saved);
    }
    files.push({ path: item.path, existed });
  }
  // Persist recovery before modifying any installed file.
  await writeFile(journal, JSON.stringify({ files }));
  for (const item of files) {
    const destination = await plainFilePath(root, item.path);
    await mkdir(dirname(destination), { recursive: true });
    const temp = destination + '.' + randomUUID();
    await writeFile(temp, await readFile(join(stage, item.path)), { flag: 'wx' });
    if (item.path === 'start.command') await chmod(temp, 0o755);
    await rename(temp, destination);
  }
  return manifest.version;
}
function start() {
  child = fork(join(root, 'web/server.js'), process.argv.slice(2), { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  child.on('message', message => {
    if (message?.type === 'web-update-restart' && !changing && !stopping) {
      changing = true;
      child.send({ type: 'web-update-stop' });
    }
  });
  child.once('exit', async code => {
    if (stopping) return;
    if (!changing) { process.exitCode = code || 0; return; }
    try {
      const expectedVersion = await install();
      const boot = fork(join(root, 'web/server.js'), process.argv.slice(2), { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
      child = boot;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { boot.once('exit', () => reject(Error('新版启动超时'))); boot.kill(); }, 20000);
        boot.once('exit', () => { clearTimeout(timeout); reject(Error('新版启动失败')); });
        boot.on('message', message => {
          if (message?.type === 'web-ready') {
            clearTimeout(timeout);
            if (message.version !== expectedVersion) { boot.once('exit', () => reject(Error('新版版本号不一致'))); boot.kill(); }
            else resolve();
          }
        });
      });
      await rm(backup, { recursive: true, force: true });
      await rm(stage, { recursive: true, force: true });
      console.log('更新安装完成。');
      // Restart the supervisor so its updater code also uses the new version.
      stopping = true;
      boot.send({ type: 'web-update-stop' });
      await new Promise(resolve => boot.once('exit', resolve));
      releaseLock();
      const next = fork(join(root, 'web/launch.js'), process.argv.slice(2), { stdio: 'inherit' });
      child = next;
      next.once('exit', code => { process.exitCode = code || 0; });
    } catch (error) {
      console.error('更新失败：' + error.message);
      await restore();
      if (!await exists(journal)) {
        await rm(backup, { recursive: true, force: true });
        await rm(stage, { recursive: true, force: true });
      }
      changing = false;
      start();
    }
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; child?.kill(signal); });
await acquireLock();
await restore();
// A download interrupted before installation is safe to discard.
await rm(stage, { recursive: true, force: true });
if (await exists(backup)) await rm(backup, { recursive: true, force: true });
start();
