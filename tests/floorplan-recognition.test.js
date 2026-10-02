import test from 'node:test';
import assert from 'node:assert/strict';
import { recognizeFloorplan } from '../src/floorplan-recognition.js';
import { pointInPolygon, zoneFromPoints } from '../src/space-geometry.js';
import { apartmentPlan, fillRect, raster, stroke, twoRooms } from './fixtures/floorplan-raster.js';

const roomAt = (result, x, y) => result.rooms.find(room => pointInPolygon({ x, y }, room.points));
const validate = result => {
  const ids = new Set(result.rooms.map(room => room.id));
  assert.equal(ids.size, result.rooms.length);
  for (const room of result.rooms) {
    assert.ok(room.points.length >= 3 && room.points.length <= 128);
    assert.doesNotThrow(() => zoneFromPoints({}, room.points));
    assert.ok(room.area > 0);
    for (const point of room.points) assert.ok(point.x >= 0 && point.x <= result.width && point.y >= 0 && point.y <= result.height);
  }
  for (const opening of result.openings) {
    assert.ok(opening.roomIds.length >= 1 && opening.roomIds.length <= 2);
    assert.ok(opening.roomIds.every(id => ids.has(id)));
  }
};

test('colored rooms, actual door gaps, labels and thin furniture yield two valid interiors', () => {
  const result = recognizeFloorplan(twoRooms());
  assert.equal(result.rooms.length, 2);
  assert.notEqual(roomAt(result, 80, 80).id, roomAt(result, 175, 80).id);
  assert.equal(roomAt(result, 5, 5), undefined);
  assert.equal(roomAt(result, 20, 70), undefined);
  assert.ok(result.rooms.every(room => room.area > 10500 && room.area < 11600));
  assert.equal(result.openings.length, 2);
  assert.equal(result.openings.filter(opening => opening.roomIds.length === 2).length, 1);
  assert.ok(result.repairedPixels > 0);
  validate(result);
});

test('openings need a repaired wall gap and are not invented between touching rooms', () => {
  const result = recognizeFloorplan(twoRooms({ gaps: false, noise: false }));
  assert.equal(result.rooms.length, 2);
  assert.equal(result.openings.length, 0);
  assert.equal(result.repairedPixels, 0);
  const unclosed = recognizeFloorplan(twoRooms({ noise: false }), { gapClosing: 0 });
  assert.equal(unclosed.rooms.length, 0);
  assert.equal(unclosed.openings.length, 0);
});

test('automatic thresholds recover a room behind a long gray window without inventing an opening', () => {
  const image = twoRooms({ gaps: false, noise: false });
  fillRect(image, 35, 18, 110, 22, [165, 165, 165, 255]);
  const darkOnly = recognizeFloorplan(image, { threshold: 150 });
  assert.equal(darkOnly.rooms.length, 1);
  assert.equal(roomAt(darkOnly, 60, 60), undefined);
  const result = recognizeFloorplan(image);
  assert.equal(result.rooms.length, 2);
  assert.ok(roomAt(result, 60, 60));
  assert.equal(result.openings.length, 0);
  validate(result);
});

test('documented generated apartment retains eight uneven spaces and evidence-based door locations', () => {
  const { image, doorCenters, source } = apartmentPlan();
  const result = recognizeFloorplan(image, { gapClosing: 0.08 });
  assert.equal(result.rooms.length, 8);
  assert.equal(result.openings.length, 8);
  assert.equal(roomAt(result, 30, 35), undefined, 'the stepped exterior is not a bounding rectangle');
  for (const opening of result.openings) {
    const x = (opening.start.x + opening.end.x) / 2, y = (opening.start.y + opening.end.y) / 2;
    assert.ok(doorCenters.some(center => Math.hypot(center.x - x, center.y - y) < 5), 'every candidate corresponds to a drawn door gap');
  }
  assert.equal(source.planType, '74A');
  validate(result);
});

test('concave L interior follows the inner wall and excludes the missing corner', () => {
  const image = raster(220, 180);
  stroke(image, [[20, 20], [200, 20], [200, 70], [95, 70], [95, 160], [20, 160]], 4, undefined, true);
  const result = recognizeFloorplan(image);
  assert.equal(result.rooms.length, 1);
  const room = result.rooms[0];
  assert.equal(room.points.length, 6);
  // The 4px stroke leaves a 176x136 interior minus the 105x90 corner void.
  assert.ok(Math.abs(room.area - (176 * 136 - 105 * 90)) < 120);
  assert.equal(pointInPolygon({ x: 150, y: 110 }, room.points), false);
  assert.equal(pointInPolygon({ x: 50, y: 110 }, room.points), true);
  assert.equal(pointInPolygon({ x: 150, y: 40 }, room.points), true);
  assert.ok(room.points.some(p => Math.abs(p.x - 93) <= 1 && Math.abs(p.y - 68) <= 1));
  validate(result);
});

test('slanted inner boundaries stay slanted rather than becoming axis-aligned rectangles', () => {
  const image = raster(240, 190);
  stroke(image, [[20, 20], [210, 20], [185, 160], [65, 160], [20, 105]], 4, undefined, true);
  const result = recognizeFloorplan(image);
  assert.equal(result.rooms.length, 1);
  const room = result.rooms[0];
  assert.ok(room.points.length >= 5 && room.points.length <= 12);
  assert.ok(room.points.some((p, i) => {
    const q = room.points[(i + 1) % room.points.length];
    return Math.abs(p.x - q.x) > 10 && Math.abs(p.y - q.y) > 10;
  }));
  assert.equal(pointInPolygon({ x: 200, y: 150 }, room.points), false);
  assert.equal(pointInPolygon({ x: 120, y: 100 }, room.points), true);
  validate(result);
});

test('small scan ripples do not become a row of short walls in the editable room', () => {
  const image = raster(400, 260);
  const outline = [[20, 20]];
  for (let x = 40; x <= 380; x += 20) outline.push([x, 20 + (x / 20 % 2) * 2]);
  outline.push([380, 240], [20, 240]);
  stroke(image, outline, 4, undefined, true);
  const result = recognizeFloorplan(image);
  assert.equal(result.rooms.length, 1);
  assert.ok(result.rooms[0].points.length <= 6, `Scan noise created ${result.rooms[0].points.length} wall segments`);
  assert.ok(roomAt(result, 200, 100));
  validate(result);
});

test('relative wall and gap thresholds give matching rooms at 1x, 2x and 4x resolution', () => {
  const reference = recognizeFloorplan(twoRooms({ noise: false }));
  for (const scale of [2, 4]) {
    const result = recognizeFloorplan(twoRooms({ scale, noise: false }));
    assert.equal(result.rooms.length, reference.rooms.length);
    assert.equal(result.openings.length, reference.openings.length);
    for (let i = 0; i < result.rooms.length; i += 1) {
      assert.equal(result.rooms[i].id, reference.rooms[i].id);
      assert.ok(Math.abs(result.rooms[i].area / scale ** 2 - reference.rooms[i].area) < 35);
    }
    validate(result);
  }
});

test('single-pixel partition walls remain valid and do not require thick-wall erosion', () => {
  const result = recognizeFloorplan(twoRooms({ thickness: 1, gaps: false, noise: false }));
  assert.equal(result.rooms.length, 2);
  assert.equal(result.openings.length, 0);
  validate(result);
});

test('blank, transparent, tiny, texture and unclosed outlines return no invented rooms', () => {
  const texture = raster(180, 140);
  let seed = 42;
  for (let i = 0; i < texture.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const value = 45 + seed % 185;
    texture.data.set([value, value + 15, value + 20, 255], i);
  }
  const unclosed = raster(220, 180);
  stroke(unclosed, [[20, 70], [20, 20], [200, 20], [200, 160], [20, 160], [20, 125]], 4);
  const smallNoise = raster(220, 180);
  stroke(smallNoise, [[60, 60], [65, 60], [65, 65], [60, 65]], 1, undefined, true);
  const broadPhotoShadow = raster(220, 180);
  fillRect(broadPhotoShadow, 20, 20, 200, 160, [50, 70, 80, 255]);
  fillRect(broadPhotoShadow, 65, 65, 120, 125, [210, 205, 190, 255]);
  for (const image of [raster(100, 100), raster(100, 100, [0, 0, 0, 0]), raster(8, 8), texture, unclosed, smallNoise, broadPhotoShadow]) {
    const result = recognizeFloorplan(image);
    assert.equal(result.rooms.length, 0);
    assert.equal(result.openings.length, 0);
  }
});

test('image bytes and options are immutable and repeated results have deterministic IDs and polygons', () => {
  const image = twoRooms();
  const bytes = image.data.slice(), options = { threshold: 145, gapClosing: 0.07 };
  const before = structuredClone(options);
  const first = recognizeFloorplan(image, options), second = recognizeFloorplan(image, options);
  assert.deepEqual(first, second);
  assert.deepEqual(image.data, bytes);
  assert.deepEqual(options, before);
  first.rooms[0].points[0].x = -999;
  assert.deepEqual(recognizeFloorplan(image, options), second);
});

test('threshold and gap options have bounded explicit behavior and malformed input is rejected', () => {
  const image = twoRooms({ noise: false, gaps: false });
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i] === 25) image.data.set([170, 170, 170, 255], i);
  }
  assert.equal(recognizeFloorplan(image, { threshold: 150 }).rooms.length, 0);
  assert.equal(recognizeFloorplan(image).rooms.length, 2);
  assert.equal(recognizeFloorplan(image, { threshold: 180 }).rooms.length, 2);
  for (const options of [{ threshold: -1 }, { threshold: 256 }, { threshold: NaN }, { gapClosing: -0.01 }, { gapClosing: 0.13 }]) {
    assert.throws(() => recognizeFloorplan(image, options), RangeError);
  }
  assert.throws(() => recognizeFloorplan({ width: 2, height: 2, data: new Uint8ClampedArray(3) }), TypeError);
  assert.throws(() => recognizeFloorplan({ width: 1001, height: 1, data: new Uint8ClampedArray(4004) }), TypeError);
});
