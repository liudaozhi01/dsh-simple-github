// Enumerate tests in Node instead of depending on Unix shell glob expansion.
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('.', import.meta.url));
const files = (await readdir(directory)).filter(name => name.endsWith('.test.mjs')).sort();
if (!files.length) throw new Error('No test files found');
const child = spawn(process.execPath, ['--test', ...files], { cwd:directory, stdio:'inherit', shell:false });
child.once('error', error => { console.error(error); process.exitCode=1; });
child.once('exit', (code,signal) => { process.exitCode=code ?? (signal ? 1 : 0); });
