import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { terminateProcessTree } from '../scripts/process-tree.mjs';

test('waits for Windows taskkill tree termination', async () => {
  const taskkill = new EventEmitter();
  let settled = false;
  const termination = terminateProcessTree(
    { pid: 123 },
    {
      platform: 'win32',
      spawnProcess(command, args) {
        assert.equal(command, 'taskkill');
        assert.deepEqual(args, ['/pid', '123', '/t', '/f']);
        return taskkill;
      },
    },
  );
  Promise.resolve(termination).then(() => { settled = true; });

  await Promise.resolve();
  assert.equal(settled, false);
  taskkill.emit('close', 0);
  await termination;
});
