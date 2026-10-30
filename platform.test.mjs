import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeEnv, findTool, isWithin, platformInfo, spawnPortable, terminateTree } from './platform.js';

function spawner() {
  const calls = [], children = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter(); child.pid = 23000 + calls.length; child.kill = signal => calls.push({ signal });
    calls.push({ command, args, options }); children.push(child);
    if (/taskkill\.exe$/i.test(command)) queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  return { calls, children, spawnImpl };
}
const windows = { platform: 'win32', env: { Path: 'C:\\Tools', SystemRoot: 'C:\\Windows' } };

test('Windows parent exit during failed taskkill does not falsely confirm descendant cleanup', async () => {
  let service;
  const spawnImpl = command => {
    const child = new EventEmitter(); child.pid = 25001;
    if (/taskkill\.exe$/i.test(command)) queueMicrotask(() => { service.emit('close', 0); child.emit('close', 1); });
    else service = child;
    return child;
  };
  const child = spawnPortable('C:\\Tools\\service.exe', [], { ...windows, spawnImpl });
  await assert.rejects(terminateTree(child), /cleanup could not be confirmed/);
});

test('platform labels and copied Windows case-insensitive environment', () => {
  const original = { Path: 'old', PATH: 'new', java_home: 'jdk', SystemRoot: 'root' };
  assert.deepEqual(normalizeEnv(original, 'win32'), { PATH: 'new', JAVA_HOME: 'jdk', SYSTEMROOT: 'root' });
  assert.equal(original.Path, 'old');
  assert.deepEqual(normalizeEnv(original, 'darwin'), original);
  assert.deepEqual(platformInfo('win32'), { platform: 'win32', label: 'Windows', isWindows: true });
  assert.equal(platformInfo('darwin').label, 'macOS'); assert.equal(platformInfo('linux').isWindows, false);
});

test('Windows containment is case insensitive, drive/UNC aware, and component bounded', () => {
  assert.equal(isWithin('C:\\Work', 'c:\\work\\child', 'win32'), true);
  assert.equal(isWithin('C:\\Work', 'C:\\WORK', 'win32'), true);
  for (const candidate of ['C:\\Work2', 'C:\\Work\\..\\else', 'D:\\Work', 'C:relative']) assert.equal(isWithin('C:\\Work', candidate, 'win32'), false);
  assert.equal(isWithin('\\\\server\\share\\root', '\\\\SERVER\\SHARE\\ROOT\\child', 'win32'), true);
  assert.equal(isWithin('/Users/project', '/Users/project-evil', 'darwin'), false);
  assert.equal(isWithin('/Users/project', '/Users/project/src', 'darwin'), true);
  assert.equal(isWithin('/Users/project', '/users/project', 'darwin'), false);
});

test('findTool Windows PATH/PATHEXT and Unix executable discovery without subprocesses', async () => {
  const seen = [];
  const accessImpl = async (file, mode) => { seen.push([file, mode]); if (!['C:\\Program Files\\Java\\bin\\java.EXE', 'C:\\工具\\mvn.CMD', '/opt/homebrew/bin/npm'].includes(file)) throw new Error('missing'); };
  const statImpl = async () => ({ isFile: () => true });
  assert.equal(await findTool('java', { platform: 'win32', env: { Path: 'relative;"C:\\Program Files\\Java\\bin"', Pathext: '.EXE;.CMD' }, accessImpl, statImpl }), 'C:\\Program Files\\Java\\bin\\java.EXE');
  assert.equal(await findTool('mvn', { platform: 'win32', env: { Path: 'C:\\工具', PATHEXT: '.EXE;.CMD' }, accessImpl, statImpl }), 'C:\\工具\\mvn.CMD');
  assert.equal(await findTool('npm', { platform: 'darwin', env: { PATH: '/missing' }, extraPaths: ['/opt/homebrew/bin/npm'], accessImpl, statImpl }), '/opt/homebrew/bin/npm');
  assert.equal(await findTool('missing', { platform: 'win32', env: { PATH: 'relative;;.' }, accessImpl, statImpl }), null);
  assert.equal(seen.some(([file]) => file.startsWith('relative')), false);
  assert.equal(await findTool('mvn', { platform: 'win32', env: { PATH: 'C:\\工具' }, accessImpl, statImpl: async () => ({ isFile: () => false }) }), null);
});

test('Windows Maven ignores colocated Unix extensionless launcher', async () => {
  const examined = [];
  const result = await findTool('mvn', { platform: 'win32', env: { Path: 'C:\\Maven\\bin' },
    accessImpl: async file => { examined.push(file); if (!['C:\\Maven\\bin\\mvn', 'C:\\Maven\\bin\\mvn.CMD'].includes(file)) throw new Error('missing'); },
    statImpl: async () => ({ isFile: () => true }),
  });
  assert.equal(result, 'C:\\Maven\\bin\\mvn.CMD');
  assert.equal(examined.includes('C:\\Maven\\bin\\mvn'), false);
});

test('npm.cmd prefers node npm-cli.js, with no shell parsing of user arguments', () => {
  const fake = spawner();
  spawnPortable('C:\\Program Files\\nodejs\\npm.cmd', ['run', 'a&b'], { ...windows, ...fake, nodePath: 'C:\\node.exe', existsImpl: () => true });
  assert.equal(fake.calls[0].command, 'C:\\node.exe');
  assert.deepEqual(fake.calls[0].args, ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'run', 'a&b']);
  assert.equal(fake.calls[0].options.shell, false);
  assert.equal(fake.calls[0].options.env.PATH, 'C:\\Tools');
});

test('Maven batch invocation safely quotes spaces, Chinese and parentheses with fixed argv', () => {
  const fake = spawner();
  spawnPortable('C:\\Program Files (x86)\\工具\\mvn.cmd', ['-f', 'pom.xml', 'spring-boot:run', '-Dspring-boot.run.arguments=--server.address=127.0.0.1'], { ...windows, ...fake, shell: true });
  const call = fake.calls[0];
  assert.equal(call.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(call.args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
  assert.equal(call.args[4], '""C:\\Program Files (x86)\\工具\\mvn.cmd" "-f" "pom.xml" "spring-boot:run" "-Dspring-boot.run.arguments=--server.address=127.0.0.1""');
  assert.equal(call.options.windowsVerbatimArguments, true); assert.equal(call.options.shell, false);
});

test('batch expansion and metacharacters are rejected before any spawn', () => {
  const fake = spawner();
  for (const bad of ['a&calc', '%PATH%', '!VAR!', 'a|b', 'a>b', 'a<b', 'a^b', 'a"b', 'a\nb', 'a\0b']) {
    assert.throws(() => spawnPortable('C:\\mvn.cmd', [bad], { ...windows, ...fake }), /Unsafe/);
    assert.throws(() => spawnPortable(`C:\\${bad}\\mvn.cmd`, [], { ...windows, ...fake }), /Unsafe/);
  }
  assert.equal(fake.calls.length, 0);
});

test('Windows stop targets only owned live PID and descendants, never names/ports/shell', async () => {
  const fake = spawner(), child = spawnPortable('C:\\node.exe', [], { ...windows, ...fake });
  await Promise.all([terminateTree(child), terminateTree(child)]);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[1].args, ['/PID', String(child.pid), '/T', '/F']);
  assert.equal(fake.calls[1].command, 'C:\\Windows\\System32\\taskkill.exe');
  assert.equal(fake.calls[1].options.shell, false);
  await assert.rejects(terminateTree({ pid: 1 }), /unowned/);
});

test('closed Windows parent is not taskkilled: reused PID must never hit unrelated processes', async () => {
  const fake = spawner(), child = spawnPortable('C:\\node.exe', [], { ...windows, ...fake });
  child.emit('close', 1);
  await terminateTree(child);
  assert.equal(fake.calls.length, 1);
});

test('Windows taskkill launch errors and nonzero exits surface without fallback broad kills', async () => {
  for (const mode of ['error', 'exit']) {
    const fake = spawner(), child = spawnPortable('C:\\node.exe', [], { ...windows, ...fake });
    const attempts = [];
    await assert.rejects(terminateTree(child, { spawnImpl: (command, args, options) => {
      attempts.push({ command, args, options });
      const killer = new EventEmitter();
      queueMicrotask(() => mode === 'error' ? killer.emit('error', new Error('taskkill unavailable')) : killer.emit('close', 5));
      return killer;
    } }), /taskkill/);
    assert.equal(attempts.length, 1); assert.deepEqual(attempts[0].args, ['/PID', String(child.pid), '/T', '/F']);
  }
});

test('batch UNC working directory fails clearly rather than running in the wrong directory', () => {
  const fake = spawner();
  assert.throws(() => spawnPortable('C:\\mvn.cmd', ['test'], { ...windows, ...fake, cwd: '\\\\server\\share\\project' }), /UNC project paths are not supported/);
  assert.equal(fake.calls.length, 0);
});

test('hung taskkill has a bounded timeout and kills only its own helper', async () => {
  const fake = spawner(), child = spawnPortable('C:\\node.exe', [], { ...windows, ...fake });
  let helperKilled = 0;
  await assert.rejects(terminateTree(child, { taskkillTimeout: 5, spawnImpl: () => {
    const helper = new EventEmitter(); helper.kill = () => { helperKilled++; }; return helper;
  } }), /taskkill timed out/);
  assert.equal(helperKilled, 1); assert.equal(fake.calls.length, 1);
});

test('failed spawns and invalid PIDs never invoke taskkill', async () => {
  const fake = spawner(), child = spawnPortable('C:\\node.exe', [], { ...windows, ...fake });
  child.emit('error', new Error('ENOENT'));
  await terminateTree(child); assert.equal(fake.calls.length, 1);
  const invalid = spawnPortable('C:\\node.exe', [], { ...windows, ...fake }); invalid.pid = -42;
  await terminateTree(invalid); assert.equal(fake.calls.length, 2);
});

test('Unix detached children retain process-group TERM then KILL semantics', async () => {
  const fake = spawner(), signals = [];
  const child = spawnPortable('/usr/bin/java', [], { platform: 'darwin', detached: true, ...fake });
  await terminateTree(child, { killImpl: (pid, signal) => signals.push([pid, signal]), delayImpl: async () => {} });
  assert.deepEqual(signals, [[-child.pid, 'SIGTERM'], [-child.pid, 'SIGKILL']]);
});
