import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const chrome = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => candidate && existsSync(candidate));
if (!chrome) throw new Error('Chrome or Chromium is required');

const root = resolve(import.meta.dirname, '..');
const outputRoot = resolve(process.argv[2] ?? '.omx/artifacts/real-plan-navigation');
const preview = spawn(process.execPath, [
  resolve(root, 'node_modules/vite/bin/vite.js'),
  'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort',
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
}

async function run(script, output) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve(root, script), 'http://127.0.0.1:4173/', output], {
      cwd: root,
      stdio: 'inherit',
    });
    child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`${script} exited ${code}`)));
  });
}

let failure;
try {
  await rm(outputRoot, { recursive: true, force: true });
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('Vite preview did not start within 20 seconds')), 20_000);
    let output = '';
    const onOutput = (chunk) => {
      output += chunk;
      if (!output.includes('http://127.0.0.1:4173/')) return;
      clearTimeout(timeout);
      resolveReady();
    };
    preview.stdout.setEncoding('utf8');
    preview.stderr.setEncoding('utf8');
    preview.stdout.on('data', onOutput);
    preview.stderr.on('data', onOutput);
    preview.once('exit', (code) => reject(new Error(`Vite preview exited before readiness: ${code}`)));
  });
  await Promise.all([
    run('.omo/evidence/real-plan-navigation/door-visibility-qa.mjs', join(outputRoot, 'visibility')),
    run('.omo/evidence/real-plan-navigation/responsive-qa.mjs', join(outputRoot, 'responsive')),
    run('.omo/evidence/real-plan-navigation/browser-qa.mjs', join(outputRoot, 'traversal')),
  ]);
} catch (error) {
  failure = error;
} finally {
  await stop(preview);
}
if (failure) throw failure;
