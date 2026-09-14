import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioEditSession, studioItemFromAsset, studioWallRuns } from '../src/studio3d-edit.js';

const layout = () => ({
  zones: [{ id: 'room', x: 0, y: 0, width: 500, depth: 400 }],
  items: [{ id: 'sofa', x: 150, y: 180, width: 220, depth: 94, height: 84, rotation: 0 }],
  structures: [],
  wallHeight: 240,
});
test('preview/cancel never mutates canonical layout; one commit refreshes authoritative arrays', () => {
  let canonical = layout();
  const original = structuredClone(canonical);
  const actions = [];
  const previews = [];
  const session = createStudioEditSession({
    layout: canonical,
    getLayout: () => canonical,
    onPreview: (value) => previews.push(value),
    onEdit(action) {
      actions.push(action);
      canonical = {
        ...canonical,
        items: canonical.items.map((item) => ({ ...item, ...action.updates, x: 222 })),
      };
    },
  });
  session.preview({ type: 'update-item', id: 'sofa', updates: { x: 200 } });
  session.preview({ type: 'update-item', id: 'sofa', updates: { rotation: 30 } });
  assert.deepEqual(canonical, original);
  assert.equal(actions.length, 0);
  assert.equal(session.layout.items[0].x, 200);
  assert.equal(session.layout.items[0].rotation, 30);
  session.cancel();
  assert.deepEqual(session.layout, original);
  assert.equal(actions.length, 0);
  session.preview({ type: 'update-item', id: 'sofa', updates: { x: 201 } });
  session.commit();
  assert.equal(actions.length, 1);
  assert.equal(session.layout.items[0].x, 222);
  assert.notEqual(session.layout.items, canonical.items);
  assert.equal(previews.at(-1).items[0].x, 222);
  assert.equal(session.pending, false);
});
test('locks, no-op changes, callback rejection and add previews obey transaction boundaries', () => {
  let calls = 0;
  const canonical = layout();
  canonical.items[0].locked = true;
  const session = createStudioEditSession({
    layout: canonical,
    onEdit() {
      calls++;
      throw new Error('Rejected');
    },
  });
  assert.equal(session.preview({ type: 'update-item', id: 'sofa', updates: { x: 300 } }), false);
  assert.equal(session.commit(), false);
  assert.equal(calls, 0);
  session.preview({ type: 'add-item', item: { id: 'new', x: 10, y: 20, width: 40, depth: 40, height: 50 } });
  session.preview({ type: 'update-item', id: 'new', updates: { rotation: 45 } });
  assert.throws(() => session.commit(), /Rejected/);
  assert.equal(session.pending, true);
  assert.equal(session.layout.items.at(-1).rotation, 45);
  session.cancel();
  assert.equal(session.layout.items.length, 1);
});
test('finish previews cover the same compound space as the canonical zone commit', () => {
  const canonical = layout();
  canonical.zones[0].spaceId = 'living-kitchen';
  canonical.zones.push({ id: 'kitchen', spaceId: 'living-kitchen', x: 500, y: 0, width: 200, depth: 400 });
  canonical.zones.push({ id: 'bedroom', x: 0, y: 400, width: 300, depth: 300 });
  const session = createStudioEditSession({ layout: canonical, onEdit() {} });
  session.preview({ type: 'update-zone', id: 'room', updates: { floorMaterialId: 'tile-slate' } });
  assert.deepEqual(
    session.layout.zones.map((zone) => zone.floorMaterialId),
    ['tile-slate', 'tile-slate', undefined],
  );
  assert.equal(canonical.zones[0].floorMaterialId, undefined);
  session.cancel();
  assert.deepEqual(session.layout, canonical);
});

test('asset placement converts catalog meters to canonical centimeters at the boundary', () => {
  const item = studioItemFromAsset(
    {
      id: 'a',
      name: 'A',
      category: 'sofa',
      legacyTypes: ['sofa'],
      dimensions: { width: 2.2, depth: 0.94, height: 0.84 },
    },
    { x: 200, y: 190 },
    'new',
  );
  assert.equal(item.width, 220);
  assert.equal(item.depth, 94);
  assert.equal(item.height, 84);
  assert.equal(item.assetId, 'a');
  assert.equal(item.x, 200);
});
test('wall finishes split merged walls by room boundary with independent inward faces', () => {
  const zones = [
    { id: 'a', x: 0, y: 0, width: 200, depth: 200 },
    { id: 'b', x: 200, y: 0, width: 200, depth: 200 },
  ];
  const runs = studioWallRuns({ orientation: 'horizontal', x1: 0, x2: 400, y: 0 }, zones);
  assert.deepEqual(
    runs.map((run) => [run.segment.x1, run.segment.x2, run.positive?.id, run.negative?.id]),
    [
      [0, 200, 'a', undefined],
      [200, 400, 'b', undefined],
    ],
  );
  const shared = studioWallRuns({ orientation: 'vertical', x: 200, y1: 0, y2: 200 }, zones)[0];
  assert.equal(shared.positive.id, 'b');
  assert.equal(shared.negative.id, 'a');
});
