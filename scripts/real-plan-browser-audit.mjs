import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { preview } from 'vite';
import { safeArtifactPath } from '../.omo/evidence/real-plan-navigation/artifact-path.mjs';
import { terminateProcessTree } from './process-tree.mjs';

const chrome = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => candidate && existsSync(candidate));
if (!chrome) throw new Error('Chrome or Chromium is required');

const root = resolve(import.meta.dirname, '..');
const outputRoot = safeArtifactPath(process.argv[2], '.omx/artifacts/real-plan-navigation');
const auditTimeoutMs = Number(process.env.REAL_PLAN_AUDIT_TIMEOUT_MS ?? 25 * 60 * 1000);
const profileParent = process.env.REAL_PLAN_AUDIT_PROFILE_PARENT ?? tmpdir();
const profileRoot = await mkdtemp(join(profileParent, 'room-studio-real-plan-audit-'));
let previewServer;

async function run(script, url, output) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve(root, script), url, output], {
      cwd: root,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        CHROME_BIN: chrome,
        REAL_PLAN_AUDIT_PROFILE_ROOT: profileRoot,
      },
      stdio: 'inherit',
    });
    let timedOut = false;
    let termination = Promise.resolve();
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        termination = terminateProcessTree(child);
      } catch (error) {
        if (error.code !== 'ESRCH') reject(error);
      }
    }, auditTimeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', async (code) => {
      clearTimeout(timer);
      try {
        await termination;
        if (timedOut) reject(new Error(`${script} exceeded ${auditTimeoutMs} ms`));
        else if (code === 0) resolveRun();
        else reject(new Error(`${script} exited ${code}`));
      } catch (error) {
        reject(error);
      }
    });
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
  const audits = await Promise.allSettled([
    run('.omo/evidence/real-plan-navigation/door-visibility-qa.mjs', previewUrl, join(outputRoot, 'visibility')),
    run('.omo/evidence/real-plan-navigation/responsive-qa.mjs', previewUrl, join(outputRoot, 'responsive')),
    run('.omo/evidence/real-plan-navigation/browser-qa.mjs', previewUrl, join(outputRoot, 'traversal')),
  ]);
  const rejected = audits.find(({ status }) => status === 'rejected');
  if (rejected) throw rejected.reason;
} catch (error) {
  failure = error;
} finally {
  await previewServer?.close();
  await rm(profileRoot, { recursive: true, force: true });
}
if (failure) throw failure;
