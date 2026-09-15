import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { mock } from 'node:test';

const failFirst = process.argv[3] === 'fail-first';
const result = { scripts: [], maxActive: 0, failed: false, previewClosed: false };
let active = 0;
let profileRoot;

mock.module('vite', {
  namedExports: {
    preview: async () => ({
      httpServer: { address: () => ({ port: 0 }) },
      close: async () => { result.previewClosed = true; },
    }),
  },
});
mock.module('node:child_process', {
  namedExports: {
    spawn(_command, [script], options) {
      const child = new EventEmitter();
      profileRoot = options.env.REAL_PLAN_AUDIT_PROFILE_ROOT;
      result.scripts.push(basename(script));
      active++;
      result.maxActive = Math.max(result.maxActive, active);
      const code = failFirst && result.scripts.length === 1 ? 1 : 0;
      queueMicrotask(() => {
        active--;
        child.emit('close', code);
      });
      return child;
    },
  },
});
process.env.CHROME_BIN = process.execPath;
try {
  await import('../../scripts/real-plan-browser-audit.mjs');
} catch {
  result.failed = true;
} finally {
  mock.restoreAll();
}
result.profileRemoved = Boolean(profileRoot) && !existsSync(profileRoot);
console.log(JSON.stringify(result));
