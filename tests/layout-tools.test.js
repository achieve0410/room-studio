import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrateBackgroundPlan,
  createLayoutClipboard,
  formatMeasurement,
  measurementLength,
  pasteLayoutClipboard,
} from '../src/layout-tools.js';

test('two-point calibration scales a background around its first reference point', () => {
  const calibrated = calibrateBackgroundPlan(
    { x: 0, y: 0, width: 400, depth: 300 },
    { x: 100, y: 50 },
    { x: 300, y: 50 },
    500,
  );
  assert.deepEqual(calibrated, { x: -150, y: -75, width: 1000, depth: 750 });
  assert.equal(calibrateBackgroundPlan({}, { x: 0, y: 0 }, { x: 0, y: 0 }, 100), null);
});

test('measurement helpers preserve diagonal precision and readable units', () => {
  assert.equal(measurementLength({ x: 0, y: 0 }, { x: 30, y: 40 }), 50);
  assert.equal(formatMeasurement(50), '50cm');
  assert.equal(formatMeasurement(250), '2.5m');
  assert.equal(formatMeasurement(123.45), '1.24m');
});

test('copy and paste preserve compound spaces and wall openings with fresh unlocked ids', () => {
  const layout = {
    zones: [
      { id: 'z1', spaceId: 'living', x: 0, y: 0, locked: true },
      { id: 'z2', spaceId: 'living', x: 100, y: 0 },
    ],
    items: [{ id: 'i1', x: 20, y: 30, locked: true }],
    structures: [
      { id: 'w1', type: 'wall', x: 0, y: 0, locked: true },
      { id: 'd1', type: 'door', wallId: 'w1', x: 10, y: 0 },
    ],
    dimensions: [{ id: 'm1', x1: 0, y1: 0, x2: 100, y2: 0, locked: true }],
  };
  const clipboard = createLayoutClipboard(layout, [
    { kind: 'zone', id: 'z1' },
    { kind: 'zone', id: 'z2' },
    { kind: 'item', id: 'i1' },
    { kind: 'structure', id: 'w1' },
    { kind: 'dimension', id: 'm1' },
  ]);
  assert.deepEqual(clipboard.structures.map(({ id }) => id), ['w1', 'd1']);
  let nextId = 0;
  const pasted = pasteLayoutClipboard(layout, clipboard, {
    offset: 20,
    idFactory: (prefix) => `${prefix}-${++nextId}`,
  });
  const [firstZone, secondZone] = pasted.layout.zones.slice(-2);
  const [wall, door] = pasted.layout.structures.slice(-2);
  assert.equal(firstZone.spaceId, secondZone.spaceId);
  assert.notEqual(firstZone.spaceId, 'living');
  assert.deepEqual({ x: firstZone.x, y: firstZone.y, locked: firstZone.locked }, { x: 20, y: 20, locked: false });
  assert.equal(door.wallId, wall.id);
  assert.equal(pasted.layout.items.at(-1).locked, false);
  assert.equal(pasted.layout.dimensions.at(-1).locked, false);
  assert.equal(pasted.selection.length, 6);
});
