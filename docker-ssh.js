import http from 'node:http';

const ALIAS = 'xian-oa-test';
const HOSTS = '/api/dsh-ssh/hosts';
const EXEC = '/api/dsh-ssh/exec';
const MAX_TIMEOUT = 180000;
const MAX_RESPONSE = 64 * 1024;
const PREFIX = 'sudo -n /usr/bin/python3 -I - ';
const ERROR = 'Docker SSH operation unavailable (details suppressed; remote state unknown; do not retry).';
const failure = () => new Error(ERROR);

/** Fixed-target transport only; construction never executes anything.
 * bridge is a trusted test hook, not an HTTP destination or user-supplied input.
 * close aborts local waiting/HTTP only; it does NOT cancel remote execution.
 */
export function createDockerSsh(options = {}) {
  let port, bridge;
  try { ({ port, bridge } = options); } catch { throw failure(); }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (bridge !== undefined && typeof bridge !== 'function')) throw failure();
  let closed = false;
  const pending = new Set();
  const ensureOpen = () => { if (closed) throw failure(); };

  function request(path, { json, timeoutMs }) {
    ensureOpen();
    return new Promise((resolve, reject) => {
      let req, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(abort);
        if (error) { req?.destroy(); reject(failure()); }
        else resolve(value);
      };
      const abort = () => finish(failure());
      const timer = setTimeout(abort, timeoutMs);
      pending.add(abort);
      try {
        if (bridge) {
          Promise.resolve(bridge(path, { json, timeoutMs })).then(value => {
            try {
              if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESPONSE) throw failure();
              finish(null, value);
            } catch { finish(failure()); }
          }, abort);
          return;
        }
        // No URL input, proxy, credentials, cookie, redirect, or pooled agent.
        req = http.request({ hostname: '127.0.0.1', port, path, method: json === undefined ? 'GET' : 'POST', agent: false,
          headers: json === undefined ? {} : { 'content-type': 'application/json' } }, res => {
          res.on('error', abort);
          res.on('aborted', abort);
          if (res.statusCode !== 200) { res.resume(); return abort(); }
          let length = 0;
          const chunks = [];
          res.on('data', chunk => {
            length += chunk.length;
            if (length > MAX_RESPONSE) return abort();
            chunks.push(chunk);
          });
          res.on('end', () => {
            try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { abort(); }
          });
          res.on('close', () => { if (!res.complete) abort(); });
        });
        req.on('error', abort);
        req.end(json === undefined ? undefined : JSON.stringify(json));
      } catch { abort(); }
    });
  }

  async function exec(input) {
    try {
      ensureOpen();
      if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).some(key =>
        !['alias', 'command', 'timeoutMs'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value'))) throw failure();
      const { alias, command, timeoutMs = MAX_TIMEOUT } = input;
      const releaseCommand = typeof command === 'string' && /^sudo -n \/usr\/bin\/python3 -I \/usr\/local\/libexec\/xian-oa-release\.py '[A-Za-z0-9+/]+={0,2}'$(?![\s\S])/.test(command);
      if (alias !== ALIAS || typeof command !== 'string' || (!releaseCommand && (!command.startsWith(PREFIX) || command.length <= PREFIX.length)) || command.includes('\0') || Buffer.byteLength(command) > 65536 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) throw failure();
      const hosts = await request(HOSTS, { timeoutMs });
      ensureOpen();
      if (!Array.isArray(hosts?.hosts)) throw failure();
      const matches = hosts.hosts.filter(item => item?.alias === ALIAS);
      if (matches.length !== 1) throw failure();
      const host = matches[0];
      if (host.host !== '119.45.50.213' || host.user !== 'liudaozhi' || host.port !== 22 || !['key', 'password', 'agent'].includes(host.auth) || !Array.isArray(host.proxyJump) || host.proxyJump.length !== 0 || (host.proxyCommand !== undefined && host.proxyCommand !== null && host.proxyCommand !== '')) throw failure();
      const data = await request(EXEC, { json: { alias: ALIAS, command, timeoutMs }, timeoutMs });
      ensureOpen();
      const result = data?.result;
      if (!result || result.exitCode !== 0 || result.timedOut !== false || result.truncated !== false || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 4096) throw failure();
      return { exitCode: 0, stdout: result.stdout };
    } catch { throw failure(); }
  }

  function close() {
    closed = true;
    for (const abort of [...pending]) abort();
  }
  return { exec, close };
}
