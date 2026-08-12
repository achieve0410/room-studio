import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createNumericEditTransaction,
  rankHitCandidates,
  snapPendingPlacement,
} from '../src/editor-interactions.js';

test('snapPendingPlacement snaps furniture and structures without mutating the pending value', () => {
  for (const pending of [
    { kind: 'item', type: 'sofa', x: 0, y: 0, width: 210 },
    { kind: 'structure', type: 'wall', x: 0, y: 0, length: 240 },
  ]) {
    const original = structuredClone(pending);
    const placed = snapPendingPlacement(pending, { x: 126, y: -24 });

    assert.deepEqual(placed, { ...pending, x: 130, y: -20 });
    assert.deepEqual(pending, original);
    assert.notStrictEqual(placed, pending);
  }
});

test('rankHitCandidates deduplicates, ranks, and hides a containing zone for one foreground hit', () => {
  const zone = { kind: 'zone', id: 'living' };
  const item = { kind: 'item', id: 'sofa' };

  assert.deepEqual(rankHitCandidates([zone, item, { ...item }]), [item]);
});

test('rankHitCandidates returns every foreground choice in interaction priority order', () => {
  const hits = [
    { kind: 'zone', id: 'living' },
    { kind: 'item', id: 'sofa' },
    { kind: 'opening', id: 'door-1' },
    { kind: 'structure', id: 'wall-1' },
    { kind: 'control', id: 'resize-se' },
    { kind: 'item', id: 'sofa' },
  ];

  assert.deepEqual(rankHitCandidates(hits), [hits[4], hits[2], hits[3], hits[1]]);
  assert.deepEqual(rankHitCandidates([hits[0]]), [hits[0]]);
});

test('numeric edit transaction previews cumulatively, commits once, and cancels exactly', () => {
  const original = { id: 'sofa', width: 210, depth: 90, height: 85 };
  const transaction = createNumericEditTransaction(original);

  assert.deepEqual(transaction.preview({ width: 220 }), { ...original, width: 220 });
  assert.deepEqual(transaction.preview({ depth: 95 }), { ...original, width: 220, depth: 95 });

  const committed = transaction.commit();
  assert.deepEqual(committed, { ...original, width: 220, depth: 95 });
  assert.strictEqual(transaction.commit(), committed);
  assert.deepEqual(original, { id: 'sofa', width: 210, depth: 90, height: 85 });

  const cancelled = createNumericEditTransaction(original);
  cancelled.preview({ width: 400, height: 120 });
  assert.strictEqual(cancelled.cancel(), original);
});
