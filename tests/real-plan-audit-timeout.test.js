import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import process from 'node:process';

test('real-plan runner terminates an audit child at its deadline', { timeout: 5_000 }, async () => {
  const outputRoot = '.omx/artifacts/real-plan-audit-timeout-test';
  await rm(outputRoot, { recursive: true, force: true });
  const child = spawn(process.execPath, ['scripts/real-plan-browser-audit.mjs', outputRoot], {
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      REAL_PLAN_AUDIT_TIMEOUT_MS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const result = await new Promise((resolve) => {
    const watchdog = setTimeout(() => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }, 2_000);
    child.once('exit', (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal });
    });
  });

  assert.notEqual(result.code, 0);
  assert.match(output, /exceeded 1 ms/);
  await rm(outputRoot, { recursive: true, force: true });
});
