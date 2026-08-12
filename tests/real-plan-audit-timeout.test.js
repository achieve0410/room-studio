import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import process from 'node:process';

test('real-plan runner terminates an audit child at its deadline', { timeout: 5_000 }, async () => {
  const outputRoot = '.omx/artifacts/real-plan-audit-timeout-test';
  const normalRoot = '.omx/artifacts/real-plan-navigation';
  const sentinel = join(normalRoot, '.timeout-test-sentinel');
  const profileParent = await mkdtemp(join(tmpdir(), 'room-studio-real-plan-timeout-test-'));
  const profileSentinel = join(profileParent, 'keep');
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(normalRoot, { recursive: true });
  await writeFile(sentinel, 'keep');
  await writeFile(profileSentinel, 'keep');
  try {
    const child = spawn(process.execPath, ['scripts/real-plan-browser-audit.mjs', outputRoot], {
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        REAL_PLAN_AUDIT_PROFILE_PARENT: profileParent,
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
      child.once('close', (code, signal) => {
        clearTimeout(watchdog);
        resolve({ code, signal });
      });
    });

    assert.notEqual(result.code, 0);
    assert.match(output, /exceeded 1 ms/);
    assert.deepEqual(await readdir(profileParent), ['keep']);
    assert.equal(await readFile(profileSentinel, 'utf8'), 'keep');
    assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    await rm(profileParent, { recursive: true, force: true });
    await rm(sentinel, { force: true });
  }
});
