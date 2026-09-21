import test from 'node:test';
import assert from 'node:assert/strict';
import * as g from '../src/geometry.js';

const polygon = (coordinates, metadata = {}) => ({
  id: 'polygon', x: 0, y: 0, width: 300, depth: 300, ...metadata,
  points: coordinates.map(([x, y]) => ({ x, y })),
});
const l = polygon([[0, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300]]);
const u = polygon([[0, 0], [100, 0], [100, 200], [200, 200], [200, 0], [300, 0], [300, 300], [0, 300]]);
const triangle = polygon([[0, 0], [300, 0], [0, 300]]);
const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const rectangle = (x, y, width, depth, id = 'rect') => ({ id, x, y, width, depth });
const footprint = (x, y, width, depth) => ({ id: 'item', x, y, width, depth, rotation: 0 });

test('concave L/U containment, exact union, footprints and navigation exclude their voids', () => {
  assert.equal(g.pointInZone({ x: 200, y: 200 }, l), false);
  assert.equal(g.pointInZone({ x: 150, y: 100 }, u), false);
  assert.equal(g.calculateUnionArea([l]), 50000);
  assert.equal(g.calculateUnionArea([u]), 70000);
  assert.equal(g.calculateUnionArea([l, l, rectangle(100, 100, 100, 100)]), 60000);
  assert.equal(g.itemInsideZones(footprint(150, 150, 200, 200), [u]), false);
  assert.equal(g.isWalkablePoint({ x: 150, y: 150 }, [u], 100), false);
  assert.equal(g.calculateCoverage([footprint(200, 200, 100, 100)], [l]), 0);
  assert.equal(g.calculateCoverage([footprint(150, 150, 300, 300)], [u]), 100);
  assert.equal(g.calculateCoverage([footprint(150, 150, 200, 200)], [u]), 36);
  assert.equal(g.zonesOverlap(l, rectangle(150, 150, 100, 100)), false);
  for (const zone of [l, u]) assert.equal(g.pointInZone(g.zoneInteriorPoint(zone), zone), true);
});

test('slanted boundaries and intersecting polygons have exact union and clipped coverage', () => {
  const other = polygon([[0, 0], [300, 300], [0, 300]], { id: 'other' });
  assert.equal(g.calculateUnionArea([triangle]), 45000);
  assert.equal(g.calculateUnionArea([triangle, other]), 67500);
  assert.equal(g.pointInZone({ x: 200, y: 200 }, triangle), false);
  assert.equal(g.itemInsideZones(footprint(200, 200, 40, 40), [triangle]), false);
  assert.equal(g.calculateCoverage([footprint(150, 150, 100, 100)], [triangle]), 11);
  close(g.getExteriorWallSegments([triangle]).reduce((n, s) => n + g.segmentFrame(s).length, 0), 600 + Math.hypot(300, 300));
});

test('shared angled edges cancel for one space and remain interior for distinct spaces', () => {
  const other = polygon([[300, 0], [300, 300], [0, 300]], { id: 'other' });
  const shared = g.getInteriorWallSegments([triangle, other]);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].orientation, 'diagonal');
  close(g.segmentFrame(shared[0]).length, Math.hypot(300, 300));
  assert.deepEqual(g.getInteriorWallSegments([{ ...triangle, spaceId: 'one' }, { ...other, spaceId: 'one' }]), []);
  assert.equal(g.getExteriorWallSegments([triangle, other]).length, 4);
  assert.equal(g.getInteriorWallSegments([triangle, rectangle(0, -100, 300, 100)]).length, 1);
});

test('normalization preserves world points and input metadata without reordering', () => {
  const original = rectangle(10, 20, 90, 80);
  original.details = { tag: 'retained' };
  const before = structuredClone(original);
  const points = [{ x: -20, y: 30 }, { x: 80, y: 50 }, { x: 0, y: 130 }];
  const normalized = g.zoneFromPoints(original, points);
  assert.deepEqual(g.zonePoints(normalized), points);
  assert.deepEqual([normalized.x, normalized.y, normalized.width, normalized.depth], [-20, 30, 100, 100]);
  normalized.details.tag = 'changed';
  normalized.points[0].x = 1;
  assert.deepEqual(original, before);
  assert.equal(points[0].x, -20);
  const world = g.zonePoints(l); world[0].x = -100;
  assert.equal(l.points[0].x, 0);
});

test('boundary validation rejects bowties, duplicate vertices, nonfinite and excessive outlines', () => {
  for (const points of [
    [[0, 0], [100, 100], [0, 100], [100, 0]],
    [[0, 0], [100, 0], [100, 0], [0, 100]],
    [[0, 0], [100, 0], [0, Infinity]],
    [[0, 0], [100, 0], [200, 0]],
  ]) assert.throws(() => g.zoneFromPoints({}, points.map(([x, y]) => ({ x, y }))), /invalid.*outline/i);
  assert.equal(g.POLYGON_LIMITS.maxVertices, 128);
  assert.throws(() => g.zoneFromPoints({}, Array.from({ length: 129 }, (_, i) => ({ x: Math.cos(i / 129 * Math.PI * 2) * 100, y: Math.sin(i / 129 * Math.PI * 2) * 100 }))), /invalid.*outline/i);
  assert.throws(() => g.pointInZone({ x: 0, y: 0 }, { ...l, points: null }), /invalid.*outline/i);
});

test('pure edge and vertex edits preserve indices and numeric length keeps the selected endpoint', () => {
  const before = structuredClone(triangle);
  const original = g.zonePoints(triangle);
  const changed = g.setZoneEdgeLength(triangle, 1, 200);
  const points = g.zonePoints(changed);
  assert.deepEqual(points[1], original[1]);
  close(Math.hypot(points[2].x - points[1].x, points[2].y - points[1].y), 200);
  close((points[2].y - points[1].y) / (points[2].x - points[1].x), -1);
  const fixedEnd = g.zonePoints(g.setZoneEdgeLength(triangle, 1, 200, 'end'));
  assert.deepEqual(fixedEnd[2], original[2]);
  assert.deepEqual(g.zonePoints(g.moveZoneEdge(triangle, 0, { x: 10, y: 20 })).slice(0, 2), [{ x: 10, y: 20 }, { x: 310, y: 20 }]);
  assert.equal(g.moveZoneVertex(l, 1, { x: 50, y: 250 }), null);
  assert.equal(g.setZoneEdgeLength(triangle, 0, -10), null);
  assert.deepEqual(triangle, before);
});

test('directed frames, angled opening splits and collision use the same wall endpoints', () => {
  const wall = { id: 'wall', type: 'wall', x: 150, y: 150, length: Math.hypot(300, 300), angle: 45, orientation: 'horizontal' };
  const segment = g.structureSegment(wall);
  const frame = g.segmentFrame(segment);
  close(frame.start.x, 0); close(frame.end.y, 300); close(frame.angle, 45);
  assert.equal(g.structureAngle({ angle: 225, orientation: 'vertical' }), 225);
  const snapped = g.snapDoorToWallSegments({ id: 'door', type: 'door', x: 150, y: 155, width: 100 }, [{ ...segment, wallId: wall.id }]);
  close(snapped.x, snapped.y); close(snapped.angle, 45);
  const split = g.splitWallSegment({ ...segment, wallId: wall.id, source: 'retained' }, [snapped]);
  assert.equal(split.spans.length, 2);
  assert.equal(split.spans[0].wallId, wall.id);
  assert.equal(split.spans[0].source, 'retained');
  close(split.openings[0].end - split.openings[0].start, 100);
  close(split.spans.reduce((sum, span) => sum + g.segmentFrame(span).length, 0), wall.length - 100);
  assert.equal(g.isPointBlockedByInteriorWall(snapped, split.spans, 5), false);
  assert.equal(g.isPointBlockedByInteriorWall({ x: 30, y: 30 }, split.spans, 5), true);
  const leaves = g.getDoorLeafSegments([{ ...snapped, openAngle: 90, openSide: 1 }]);
  const midpoint = { x: (leaves[0].start.x + leaves[0].end.x) / 2, y: (leaves[0].start.y + leaves[0].end.y) / 2 };
  assert.equal(g.isPointBlockedByDoorLeaves(midpoint, leaves, 1), true);
  assert.equal(g.isPointBlockedByDoorLeaves(snapped, leaves, 1), false);
  const reverse = g.segmentFrame(g.structureSegment({ ...wall, angle: 225 }));
  close(reverse.start.x, 300); close(reverse.end.x, 0);
});

test('zone opening attachments reproject atomically, clamp fitting offsets and delete with owners', () => {
  const zone = g.zoneFromPoints({ id: 'room' }, [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }, { x: 0, y: 300 }]);
  const door = g.attachOpeningToZoneEdge({ id: 'door', type: 'door', x: 100, y: 10, width: 80 }, zone, 0);
  assert.deepEqual(door.wallAttachment, { zoneId: 'room', edgeIndex: 0, offset: 100 });
  const before = { zones: [zone], structures: [door], items: [] };
  const moved = { ...zone, x: 50, y: 70 };
  const after = { ...before, zones: [moved] };
  const repaired = g.reconcileZoneOpenings(before, after);
  assert.deepEqual([repaired.structures[0].x, repaired.structures[0].y], [150, 70]);
  assert.deepEqual([before.structures[0].x, before.structures[0].y], [100, 0]);
  assert.deepEqual([after.structures[0].x, after.structures[0].y], [100, 0]);
  const short = g.setZoneEdgeLength(zone, 0, 120);
  const clamped = g.reconcileZoneOpenings(before, { ...before, zones: [short] });
  assert.equal(clamped.structures[0].wallAttachment.offset, 80);
  assert.equal(clamped.structures[0].x, 80);
  const tooShort = g.setZoneEdgeLength(zone, 0, 60);
  assert.equal(g.reconcileZoneOpenings(before, { ...before, zones: [tooShort] }), null);
  assert.deepEqual(g.reconcileZoneOpenings(before, { ...before, zones: [] }).structures, []);
});

test('generated source-edge metadata survives splitting and short ownership-run fragments', () => {
  const wall = g.getExteriorWallSegments([triangle]).find(segment => segment.orientation === 'diagonal');
  assert.deepEqual(wall.sources, [{ zoneId: triangle.id, edgeIndex: 1 }]);
  const source = { sources: [{ zoneId: 'room', edgeIndex: 2 }] };
  const run = { ...source, orientation: 'horizontal', x1: 100, x2: 180, y: 200 };
  const door = { type: 'door', x: 100, y: 200, width: 20, orientation: 'horizontal' };
  const local = g.splitWallSegmentLocal(run, [door]);
  const legacy = g.splitWallSegment(run, [door]);
  assert.deepEqual(local.openings.map(({ start, end }) => [start, end]), [[0, 10]]);
  assert.deepEqual(legacy.openings.map(({ start, end }) => [start, end]), [[100, 110]]);
  assert.deepEqual(local.spans, legacy.spans);
  assert.deepEqual(local.spans[0].sources, source.sources);
  local.spans[0].sources[0].edgeIndex = 9;
  assert.equal(run.sources[0].edgeIndex, 2);
  const reversed = g.splitWallSegmentLocal({ ...run, x1: 180, x2: 100 }, [door]);
  assert.deepEqual(reversed.openings.map(({ start, end }) => [start, end]), [[70, 80]]);
});

test('compound polygon/rectangle unions preserve enclosed holes', () => {
  const parts = [
    polygon([[0, 0], [300, 0], [300, 50], [0, 50]], { id: 'top', spaceId: 'ring' }),
    { ...rectangle(0, 50, 50, 200, 'left'), spaceId: 'ring' },
    { ...rectangle(250, 50, 50, 200, 'right'), spaceId: 'ring' },
    { ...rectangle(0, 250, 300, 50, 'bottom'), spaceId: 'ring' },
  ];
  assert.equal(g.calculateUnionArea(parts), 50000);
  assert.equal(g.itemInsideZones(footprint(150, 150, 300, 300), parts), false);
  assert.equal(g.isWalkablePoint({ x: 150, y: 150 }, parts, 0), false);
  assert.equal(g.calculateCoverage([footprint(150, 150, 100, 100)], parts), 0);
  close(g.getExteriorWallSegments(parts).reduce((sum, segment) => sum + g.segmentFrame(segment).length, 0), 2000);
  assert.deepEqual(g.getInteriorWallSegments(parts), []);
});

test('reconciliation rejects buried or partially removed supporting boundaries atomically', () => {
  const zone = { ...triangle, spaceId: 'one' };
  const door = g.attachOpeningToZoneEdge({ type: 'door', x: 150, y: 150, width: 80 }, zone, 1);
  const before = { zones: [zone], structures: [door] };
  const touching = polygon([[300, 0], [300, 300], [0, 300]], { id: 'other', spaceId: 'one' });
  assert.equal(g.reconcileZoneOpenings(before, { ...before, zones: [zone, touching] }), null);
  assert.ok(g.reconcileZoneOpenings(before, { ...before, zones: [zone, { ...touching, spaceId: 'different' }] }));
  assert.equal(g.reconcileZoneOpenings(before, { ...before, zones: [zone, { ...rectangle(0, 0, 400, 400, 'cover'), spaceId: 'one' }] }), null);
  assert.deepEqual(before.structures[0], door);
});

test('attached openings do not cut nearby parallel automatic boundaries or other source edges', () => {
  const door = g.attachOpeningToZoneEdge({ type: 'door', x: 150, y: 150, width: 80 }, triangle, 1);
  const wall = g.getExteriorWallSegments([triangle]).find(segment => segment.orientation === 'diagonal');
  const unrelated = { ...wall, sources: [{ zoneId: 'other', edgeIndex: 1 }] };
  assert.deepEqual(g.doorsForAutomaticWallSegment(unrelated, [door]), []);
  assert.equal(g.splitWallSegmentLocal(unrelated, [door]).openings.length, 0);
  const parallel = { orientation: 'diagonal', x1: wall.x1 + 5, y1: wall.y1 + 5, x2: wall.x2 + 5, y2: wall.y2 + 5 };
  assert.equal(g.splitWallSegmentLocal(parallel, [door]).openings.length, 0);
  assert.equal(g.splitWallSegmentLocal(wall, [door]).openings.length, 1);
});
