import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(repoRoot, 'test');
const files = fs.readdirSync(testRoot, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
  .map(entry => `test/${entry.name}`)
  .sort();

if (!files.length) throw new Error('No root test files were found.');
if (files.some(filename => filename.includes('/fixtures/'))) throw new Error('A long-lived fixture reached the test file list.');

const requestedTimeout = Number(process.env.CODE_TEST_TIMEOUT_MS);
const hardTimeoutMs = Number.isFinite(requestedTimeout)
  ? Math.max(60_000, Math.min(30 * 60_000, requestedTimeout))
  : 15 * 60_000;

const child = spawn(process.execPath, [
  '--test',
  '--test-concurrency=4',
  '--test-timeout=120000',
  ...files
], {
  cwd: repoRoot,
  env: process.env,
  windowsHide: true,
  shell: false,
  stdio: 'inherit'
});

let timedOut = false;
const terminate = () => terminateTree(child);
const timer = setTimeout(() => {
  timedOut = true;
  terminate();
}, hardTimeoutMs);

const onSignal = () => {
  terminate();
  process.exitCode = 130;
};
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ code, signal }));
});

clearTimeout(timer);
process.removeListener('SIGINT', onSignal);
process.removeListener('SIGTERM', onSignal);

if (timedOut) {
  process.stderr.write(`Test suite exceeded its ${Math.round(hardTimeoutMs / 1000)} second hard timeout.\n`);
  process.exitCode = 124;
} else if (result.signal || result.code !== 0) {
  process.exitCode = Number.isInteger(result.code) ? result.code : 1;
}

function terminateTree(target) {
  if (!target || target.exitCode != null || target.signalCode != null) return;
  if (process.platform === 'win32' && Number.isInteger(target.pid)) {
    spawnSync('taskkill.exe', ['/PID', String(target.pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
      timeout: 10_000
    });
    return;
  }
  try { target.kill('SIGKILL'); } catch {}
}
