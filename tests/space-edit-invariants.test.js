import test from 'node:test';
import assert from 'node:assert/strict';
import { zoneFromPoints, attachOpeningToZoneEdge, reconcileZoneOpenings } from '../src/geometry.js';
import { createStudioEditSession } from '../src/studio3d-edit.js';
import { createLayoutClipboard, pasteLayoutClipboard } from '../src/layout-tools.js';

const fixture = () => {
  const zone = zoneFromPoints({ id: 'room', spaceId: 'room' }, [
    { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 },
  ]);
  const door = attachOpeningToZoneEdge({ id: 'door', type: 'door', x: 150, y: 0, width: 90 }, zone, 0);
  return { zones: [zone], items: [], structures: [door], dimensions: [], wallHeight: 240 };
};

test('a locked attached opening prevents moving or deleting its supporting space', () => {
  const before = fixture();
  before.structures[0].locked = true;
  assert.equal(reconcileZoneOpenings(before, { ...before, zones: [{ ...before.zones[0], x: 40 }] }), null);
  assert.equal(reconcileZoneOpenings(before, { ...before, zones: [] }), null);
  assert.deepEqual(reconcileZoneOpenings(before, before), before);
});

test('moving an opening from a space edge to an explicit wall removes the old owner', () => {
  const layout = fixture();
  layout.structures.push({ id: 'manual', type: 'wall', x: 600, y: 150, length: 300, orientation: 'vertical' });
  const session = createStudioEditSession({ layout, onEdit: () => {} });
  session.preview({ type: 'update-structure', id: 'door', updates: { wallId: 'manual' } });
  const door = session.layout.structures.find(entry => entry.id === 'door');
  assert.equal(door.wallId, 'manual');
  assert.equal(door.x, 600);
  assert.ok(!door.wallAttachment, 'an opening cannot keep both explicit and space-edge ownership');
});

test('copying a polygon includes and remaps its attached openings without shared vertices', () => {
  const layout = fixture();
  const clipboard = createLayoutClipboard(layout, [{ kind: 'zone', id: 'room' }]);
  assert.equal(clipboard.structures.length, 1);
  let id = 0;
  const pasted = pasteLayoutClipboard(layout, clipboard, { offset: 30, idFactory: prefix => `${prefix}-${++id}` });
  const room = pasted.layout.zones.at(-1);
  const door = pasted.layout.structures.at(-1);
  assert.equal(door.wallAttachment.zoneId, room.id);
  assert.equal(door.wallAttachment.offset, 150);
  assert.deepEqual([door.x, door.y], [180, 30]);
  assert.notStrictEqual(room.points, clipboard.zones[0].points);
  assert.deepEqual(layout, fixture());
});
