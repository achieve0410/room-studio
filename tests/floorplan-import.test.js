import test from 'node:test';
import assert from 'node:assert/strict';
import { createFloorplanLayout, floorplanScale, floorplanSummary, longestRoomEdge, rectifyFloorplan } from '../src/floorplan-import.js';
import { zonePoints } from '../src/space-geometry.js';
import { serializeProjectFile, parseProjectFile } from '../src/project-file.js';

const room = {
  id: 'a', name: '거실', type: '거실',
  points: [{ x: 20, y: 30 }, { x: 420, y: 30 }, { x: 420, y: 130 },
    { x: 220, y: 130 }, { x: 220, y: 330 }, { x: 20, y: 330 }],
};
const image = { width: 500, height: 400, name: '도면.jpg', dataUrl: 'data:image/jpeg;base64,/9j/2Q==' };
const reference = { start: { x: 20, y: 30 }, end: { x: 420, y: 30 }, length: 4000, unit: 'mm' };

test('a confirmed length scales concave rooms and background together without mutating the draft', () => {
  const input = { rooms: [room, { ...room, id: 'excluded', included: false }], image, reference };
  const original = structuredClone(input);
  const layout = createFloorplanLayout(input);
  assert.deepEqual(input, original);
  assert.equal(layout.zones.length, 1);
  assert.deepEqual(zonePoints(layout.zones[0]), room.points.map(({ x, y }) => ({ x: x - 20, y: y - 30 })));
  assert.equal(layout.backgroundPlan.x, -20);
  assert.equal(layout.backgroundPlan.y, -30);
  assert.equal(layout.backgroundPlan.width, 500);
  assert.equal(layout.dimensions[0].x2 - layout.dimensions[0].x1, 400);
  assert.deepEqual(floorplanSummary(layout), { rooms: 1, area: 8, width: 400, depth: 300 });
  const restored = parseProjectFile(serializeProjectFile({ projectName: '도면', layout })).layout;
  assert.deepEqual(zonePoints(restored.zones[0]), zonePoints(layout.zones[0]));
  assert.deepEqual(restored.backgroundPlan, layout.backgroundPlan);
});

test('scale requires real units and a sufficiently long reference, including diagonal distances', () => {
  assert.equal(floorplanScale(reference), 1);
  assert.equal(floorplanScale({ ...reference, length: 4, unit: 'm' }), 1);
  assert.equal(floorplanScale({ start: { x: 0, y: 0 }, end: { x: 30, y: 40 }, length: 100, unit: 'cm' }), 2);
  for (const update of [{ unit: '' }, { length: 0 }, { length: -10 }, { length: Infinity },
    { end: reference.start }, { end: { x: 22, y: 30 } }]) {
    assert.throws(() => floorplanScale({ ...reference, ...update }), RangeError);
  }
  assert.equal(longestRoomEdge(room).edgeIndex, 0);
});

test('invalid or excluded outlines cannot become a new document', () => {
  assert.throws(() => createFloorplanLayout({ rooms: [], image, reference }), RangeError);
  assert.throws(() => createFloorplanLayout({ rooms: [{ ...room, included: false }], image, reference }), RangeError);
  assert.throws(() => createFloorplanLayout({ rooms: [{ ...room, points: [{ x: -1, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }] }], image, reference }), RangeError);
  assert.throws(() => createFloorplanLayout({ rooms: [{ ...room, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 }] }], image, reference }));
  assert.throws(() => createFloorplanLayout({ rooms: [room], image, reference: { ...reference, length: 10000, unit: 'cm' } }), RangeError);
});

test('only confirmed opening candidates on retained walls become correctly scaled doors', () => {
  const rooms = [
    { id: 'first', points: [{ x: 20, y: 20 }, { x: 220, y: 20 }, { x: 220, y: 200 }, { x: 20, y: 200 }] },
    { id: 'second', points: [{ x: 232, y: 20 }, { x: 432, y: 20 }, { x: 432, y: 200 }, { x: 232, y: 200 }] },
  ];
  const openings = [{ start: { x: 226, y: 80 }, end: { x: 226, y: 120 }, roomIds: ['first', 'second'], included: true }];
  const reference = { start: { x: 20, y: 20 }, end: { x: 220, y: 20 }, length: 400, unit: 'cm' };
  const input = { rooms, image, reference, openings };
  const original = structuredClone(input);
  const layout = createFloorplanLayout(input);
  assert.deepEqual(input, original);
  assert.equal(layout.structures.length, 1);
  assert.equal(layout.structures[0].width, 80);
  assert.equal(layout.structures[0].x, 412);
  assert.equal(layout.structures[0].orientation, 'vertical');
  assert.equal(layout.structures[0].openAngle, 90);
  assert.equal(parseProjectFile(serializeProjectFile({ projectName: '도면', layout })).layout.structures[0].width, 80);
  const offsetOpening = { ...openings[0], start: { x: 228, y: 80 }, end: { x: 228, y: 120 } };
  assert.throws(() => createFloorplanLayout({ ...input, openings: [offsetOpening] }), RangeError);
  assert.equal(createFloorplanLayout({ ...input, openings: [{ ...openings[0], included: false }] }).structures.length, 0);
  assert.throws(() => createFloorplanLayout({ ...input, openings: [{ ...openings[0], start: { x: 100, y: 80 }, end: { x: 100, y: 120 } }] }), RangeError);
});

test('perspective rectification samples the selected photograph and rejects crossed corners', () => {
  const width = 100, height = 80;
  const data = Uint8ClampedArray.from({ length: width * height * 4 }, (_, index) => {
    const pixel = Math.floor(index / 4);
    return index % 4 === 0 ? pixel % width : index % 4 === 1 ? Math.floor(pixel / width) : index % 4 === 3 ? 255 : 0;
  });
  const corners = [{ x: 10, y: 10 }, { x: 90, y: 5 }, { x: 80, y: 70 }, { x: 15, y: 65 }];
  const output = rectifyFloorplan({ width, height, data }, corners);
  const sample = (x, y) => Array.from(output.data.slice((y * output.width + x) * 4, (y * output.width + x) * 4 + 2));
  assert.deepEqual(sample(0, 0), [10, 10]);
  assert.deepEqual(sample(output.width - 1, 0), [90, 5]);
  assert.deepEqual(sample(output.width - 1, output.height - 1), [80, 70]);
  assert.deepEqual(sample(0, output.height - 1), [15, 65]);
  assert.throws(() => rectifyFloorplan({ width, height, data }, [corners[0], corners[2], corners[1], corners[3]]), RangeError);
  const rectangle = rectifyFloorplan({ width, height, data }, [{ x: 0, y: 0 }, { x: 99, y: 0 }, { x: 99, y: 79 }, { x: 0, y: 79 }]);
  assert.deepEqual(Array.from(rectangle.data.slice(0, 4)), [0, 0, 0, 255]);
});
