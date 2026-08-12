import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { preview } from 'vite';
import { safeArtifactPath } from '../.omo/evidence/real-plan-navigation/artifact-path.mjs';

const chrome = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => candidate && existsSync(candidate));
if (!chrome) throw new Error('Chrome or Chromium is required');

const root = resolve(import.meta.dirname, '..');
const outputRoot = safeArtifactPath(process.argv[2], '.omx/artifacts/real-plan-navigation');
let previewServer;

async function run(script, url, output) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve(root, script), url, output], {
      cwd: root,
      env: { ...process.env, CHROME_BIN: chrome },
      stdio: 'inherit',
    });
    child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`${script} exited ${code}`)));
  });
}

let failure;
try {
  await rm(outputRoot, { recursive: true, force: true });
  previewServer = await preview({
    root,
    preview: {
      host: '127.0.0.1',
      port: 0,
    },
  });
  const address = previewServer.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite preview did not expose a TCP port');
  const previewUrl = `http://127.0.0.1:${address.port}/`;
  await Promise.all([
    run('.omo/evidence/real-plan-navigation/door-visibility-qa.mjs', previewUrl, join(outputRoot, 'visibility')),
    run('.omo/evidence/real-plan-navigation/responsive-qa.mjs', previewUrl, join(outputRoot, 'responsive')),
    run('.omo/evidence/real-plan-navigation/browser-qa.mjs', previewUrl, join(outputRoot, 'traversal')),
  ]);
} catch (error) {
  failure = error;
} finally {
  await previewServer?.close();
}
if (failure) throw failure;
