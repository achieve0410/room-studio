import { spawn } from 'node:child_process';
import process from 'node:process';

export function terminateProcessTree(child, {
  platform = process.platform,
  spawnProcess = spawn,
  killProcess = process.kill,
} = {}) {
  if (platform !== 'win32') {
    killProcess(-child.pid, 'SIGKILL');
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const killer = spawnProcess('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
    });
    killer.once('error', reject);
    killer.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`taskkill exited ${code}`));
    });
  });
}
