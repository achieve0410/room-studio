import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignDoorToWall,
  calculateCoverage,
  calculateUnionArea,
  doorsForAutomaticWallSegment,
  findCollisions,
  findHeightViolations,
  findOutOfBounds,
  findZoneOverlaps,
  getAnchoredZoomViewBox,
  getPannedViewBox,
  getPinchViewBox,
  getLayoutBounds,
  getExteriorWallSegments,
  getDoorLeafSegments,
  getAlignmentSnap,
  getInteriorWallSegments,
  getRolledBackSelection,
  getZoomViewBox,
  clampZoom,
  isPointBlockedByFurniture,
  isPointBlockedByDoorLeaves,
  isPointBlockedByInteriorWall,
  isWalkablePoint,
  itemFitsZoneHeights,
  itemsOverlap3d,
  resizeItemFromHandle,
  resizeStructureFromEndpoint,
  resizeZoneFromHandle,
  rotationFromPointer,
  rotatedSize,
  snap,
  splitWallSegment,
  snapDoorToWallSegments,
  structureBounds,
  structureSegment,
  zonesShareSpace,
} from '../src/geometry.js';

const assertClose = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
};

const zones = [
  { id: 'living', x: 0, y: 0, width: 300, depth: 200 },
  { id: 'bedroom', x: 0, y: 200, width: 200, depth: 200 },
];
const item = {
  id: 'a', x: 100, y: 100, width: 120, depth: 60, height: 80, elevation: 0, rotation: 0,
};

test('snap rounds coordinates to the nearest grid unit', () => {
  assert.equal(snap(24), 20);
  assert.equal(snap(26), 30);
});

test('rotatedSize swaps footprint dimensions at quarter turns', () => {
  assert.deepEqual(rotatedSize(item), { width: 120, depth: 60 });
  assert.deepEqual(rotatedSize({ ...item, rotation: 90 }), { width: 60, depth: 120 });
  const diagonal = rotatedSize({ ...item, rotation: 45 });
  assertClose(diagonal.width, 127.2792206136);
  assertClose(diagonal.depth, 127.2792206136);
});

test('rotationFromPointer tracks continuous turns, snapping, and wraparound', () => {
  const center = { x: 100, y: 100 };
  const start = { x: 100, y: 40 };
  assert.equal(rotationFromPointer(center, 0, start, { x: 160, y: 100 }), 90);
  assert.equal(rotationFromPointer(center, 350, start, { x: 109, y: 40 }), 359);
  assert.equal(rotationFromPointer(center, 0, start, { x: 149, y: 51 }, 15), 45);
});

test('resizeZoneFromHandle keeps the opposite edges fixed', () => {
  const zone = { id: 'zone', x: 0, y: 0, width: 300, depth: 200 };
  assert.deepEqual(resizeZoneFromHandle(zone, 'nw', { x: 50, y: 40 }), {
    ...zone, x: 50, y: 40, width: 250, depth: 160,
  });
  assert.deepEqual(resizeZoneFromHandle(zone, 'e', { x: 450, y: 100 }), {
    ...zone, width: 450,
  });
});

test('resizeItemFromHandle follows the local axis of a rotated item', () => {
  const rotated = { ...item, rotation: 90 };
  const resized = resizeItemFromHandle(rotated, 'e', { x: 100, y: 200 });
  assert.equal(resized.width, 160);
  assert.equal(resized.depth, 60);
  assert.equal(Math.round(resized.x), 100);
  assert.equal(Math.round(resized.y), 120);
});

test('non-uniformly resizing a circle turns it into an ellipse', () => {
  const circle = { ...item, shape: 'circle', width: 100, depth: 100 };
  const resized = resizeItemFromHandle(circle, 'e', { x: 180, y: 100 });
  assert.equal(resized.shape, 'ellipse');
  assert.equal(resized.width, 130);
  assert.equal(resized.depth, 100);
});

test('alignment snap matches nearby edges and returns guide positions', () => {
  const result = getAlignmentSnap(
    { left: 0, right: 100, top: 0, bottom: 100 },
    [{ left: 150, right: 250, top: 20, bottom: 120 }],
    { x: 42, y: 13 },
  );
  assert.deepEqual(result, {
    x: 50,
    y: 20,
    snapX: true,
    snapY: true,
    guides: [
      { orientation: 'vertical', position: 150 },
      { orientation: 'horizontal', position: 20 },
    ],
  });
});

test('zoom view box keeps its center while changing the visible area', () => {
  assert.deepEqual(
    getZoomViewBox({ left: -70, top: -70, width: 880, height: 700 }, 2, { x: 200, y: 150 }),
    { left: -20, top: -25, width: 440, height: 350 },
  );
});

test('anchored zoom keeps the pointed coordinate at the same viewport ratio', () => {
  const base = { left: -70, top: -70, width: 880, height: 700 };
  const current = getZoomViewBox(base, 1);
  const anchor = { x: 150, y: 105 };
  const next = getAnchoredZoomViewBox(base, current, 2, anchor);
  assert.equal((anchor.x - next.left) / next.width, (anchor.x - current.left) / current.width);
  assert.equal((anchor.y - next.top) / next.height, (anchor.y - current.top) / current.height);
});

test('viewport pan converts screen pixels into viewBox coordinates', () => {
  assert.deepEqual(
    getPannedViewBox({ left: -20, top: -25, width: 440, height: 350 }, { x: 80, y: -40 }, { width: 880, height: 700 }),
    { left: -60, top: -5, width: 440, height: 350 },
  );
});

test('letterboxed viewport pan uses the uniform rendered scale', () => {
  const start = { left: -70, top: -70, width: 880, height: 700 };
  const result = getPannedViewBox(start, { x: 0, y: 100 }, { width: 362, height: 420 });
  assertClose(start.top - result.top, 100 / (362 / 880), 0.01);
  assertClose(start.top - result.top, 243.09, 0.01);
});

test('pinch zoom preserves the midpoint coordinate and clamps zoom', () => {
  const base = { left: -70, top: -70, width: 880, height: 700 };
  const startViewBox = getZoomViewBox(base, 1);
  const anchor = { x: 150, y: 105 };
  const result = getPinchViewBox(base, startViewBox, 1, {
    anchor,
    startDistance: 100,
    currentDistance: 150,
    startMidpoint: { x: 220, y: 175 },
    currentMidpoint: { x: 220, y: 175 },
  }, { width: 880, height: 700 });
  assert.equal(result.zoom, 1.5);
  assert.equal((anchor.x - result.viewBox.left) / result.viewBox.width, (anchor.x - startViewBox.left) / startViewBox.width);
  assert.equal((anchor.y - result.viewBox.top) / result.viewBox.height, (anchor.y - startViewBox.top) / startViewBox.height);

  assert.equal(clampZoom(0.01), 0.05);
  assert.equal(clampZoom(8), 6);
});

test('letterboxed pinch keeps its anchor under a moved midpoint', () => {
  const viewport = { width: 362, height: 420 };
  const base = { left: -70, top: -70, width: 880, height: 700 };
  const anchor = { x: 150, y: 105 };
  const startScale = Math.min(viewport.width / base.width, viewport.height / base.height);
  const letterbox = {
    x: (viewport.width - base.width * startScale) / 2,
    y: (viewport.height - base.height * startScale) / 2,
  };
  const startMidpoint = {
    x: letterbox.x + (anchor.x - base.left) * startScale,
    y: letterbox.y + (anchor.y - base.top) * startScale,
  };
  const currentMidpoint = { x: startMidpoint.x + 24, y: startMidpoint.y + 100 };
  const result = getPinchViewBox(base, base, 1, {
    anchor,
    startDistance: 100,
    currentDistance: 150,
    startMidpoint,
    currentMidpoint,
  }, viewport);
  const resultScale = Math.min(viewport.width / result.viewBox.width, viewport.height / result.viewBox.height);
  const resultLetterbox = {
    x: (viewport.width - result.viewBox.width * resultScale) / 2,
    y: (viewport.height - result.viewBox.height * resultScale) / 2,
  };
  assertClose(resultLetterbox.x + (anchor.x - result.viewBox.left) * resultScale, currentMidpoint.x);
  assertClose(resultLetterbox.y + (anchor.y - result.viewBox.top) * resultScale, currentMidpoint.y);
});

test('gesture rollback selection returns an independent base selection copy', () => {
  const base = new Set(['zone:a']);
  const rolledBack = getRolledBackSelection(base);
  rolledBack.add('item:b');
  assert.deepEqual([...base], ['zone:a']);
  assert.deepEqual([...rolledBack], ['zone:a', 'item:b']);
});

test('getLayoutBounds includes every attached rectangular zone', () => {
  assert.deepEqual(getLayoutBounds(zones), {
    left: 0, top: 0, right: 300, bottom: 400, width: 300, depth: 400,
  });
});

test('calculateUnionArea handles overlapping rectangular zones without double counting', () => {
  assert.equal(calculateUnionArea(zones), 100000);
  assert.equal(calculateUnionArea([...zones, { id: 'overlap', x: 100, y: 100, width: 100, depth: 200 }]), 100000);
});

test('findZoneOverlaps reports invalid overlapping spaces', () => {
  const result = findZoneOverlaps([...zones, { id: 'overlap', x: 100, y: 100, width: 100, depth: 200 }]);
  assert.deepEqual([...result].sort(), ['bedroom', 'living', 'overlap']);
});

test('parts of the same compound space may overlap without a warning', () => {
  const compound = [
    { ...zones[0], spaceId: 'living-space' },
    { id: 'hall', spaceId: 'living-space', x: 200, y: 100, width: 200, depth: 100 },
  ];
  assert.equal(zonesShareSpace(compound[0], compound[1]), true);
  assert.deepEqual([...findZoneOverlaps(compound)], []);
  assert.equal(calculateUnionArea(compound), 70000);
});

test('3D collision requires both footprint and vertical height ranges to overlap', () => {
  const sameFloor = { ...item, id: 'b', x: 140, height: 40 };
  const floatingAbove = { ...sameFloor, id: 'c', elevation: 90 };
  assert.equal(itemsOverlap3d(item, sameFloor), true);
  assert.equal(itemsOverlap3d(item, floatingAbove), false);
  assert.deepEqual([...findCollisions([item, sameFloor, floatingAbove])].sort(), ['a', 'b']);
});

test('findOutOfBounds validates the complete furniture footprint against the zone union', () => {
  const outside = { ...item, id: 'outside', x: 295, y: 195 };
  assert.deepEqual([...findOutOfBounds([item, outside], zones)], ['outside']);
});

test('space height limits account for both furniture height and floor elevation', () => {
  const lowCeilingZones = zones.map((zone) => ({ ...zone, height: 100 }));
  assert.equal(itemFitsZoneHeights(item, lowCeilingZones), true);
  const raised = { ...item, id: 'raised', elevation: 30 };
  assert.equal(itemFitsZoneHeights(raised, lowCeilingZones), false);
  assert.deepEqual([...findHeightViolations([item, raised], lowCeilingZones)], ['raised']);
});

test('calculateCoverage uses the composite home area', () => {
  assert.equal(calculateCoverage([item], zones), 7);
});

test('getExteriorWallSegments follows the union outline without shared interior edges', () => {
  const segments = getExteriorWallSegments(zones);
  const totalLength = segments.reduce((sum, segment) => sum + (
    segment.orientation === 'horizontal' ? segment.x2 - segment.x1 : segment.y2 - segment.y1
  ), 0);
  assert.equal(totalLength, 1400);
  assert.equal(segments.some((segment) => segment.orientation === 'horizontal' && segment.y === 200 && segment.x1 === 0 && segment.x2 === 200), false);
});

test('walkthrough collision helpers keep the camera inside rooms and outside furniture', () => {
  assert.equal(isWalkablePoint({ x: 100, y: 100 }, zones), true);
  assert.equal(isWalkablePoint({ x: 295, y: 100 }, zones), false);
  assert.equal(isPointBlockedByFurniture({ x: 100, y: 100 }, [item]), true);
  assert.equal(isPointBlockedByFurniture({ x: 250, y: 100 }, [item]), false);
});

test('interior walls stay solid until the user places a door', () => {
  const segments = getInteriorWallSegments(zones);
  assert.deepEqual(segments, [{
    orientation: 'horizontal', x1: 0, x2: 200, y: 200,
  }]);
  assert.equal(isPointBlockedByInteriorWall({ x: 20, y: 200 }, segments), true);
  assert.equal(isPointBlockedByInteriorWall({ x: 100, y: 200 }, segments), true);
  const door = { id: 'door', type: 'door', x: 100, y: 200, width: 90, orientation: 'horizontal' };
  const solidSpans = splitWallSegment(segments[0], [door]).spans;
  assert.equal(isPointBlockedByInteriorWall({ x: 100, y: 200 }, solidSpans), false);
});

test('explicit swing and sliding doors split thin horizontal and vertical walls', () => {
  const horizontalWall = { id: 'wall-h', type: 'wall', x: 200, y: 150, length: 300, thickness: 4, orientation: 'horizontal' };
  const verticalWall = { id: 'wall-v', type: 'wall', x: 420, y: 250, length: 240, thickness: 4, orientation: 'vertical' };
  const swingDoor = { id: 'door-s', type: 'door', doorType: 'swing', x: 200, y: 150, width: 90, orientation: 'horizontal' };
  const slidingDoor = { id: 'door-l', type: 'door', doorType: 'sliding', x: 420, y: 250, width: 120, orientation: 'vertical' };
  assert.deepEqual(structureSegment(horizontalWall), { orientation: 'horizontal', x1: 50, x2: 350, y: 150 });
  assert.deepEqual(structureBounds(horizontalWall), { left: 50, right: 350, top: 148, bottom: 152 });
  assert.deepEqual(splitWallSegment(structureSegment(horizontalWall), [swingDoor]).spans, [
    { orientation: 'horizontal', x1: 50, x2: 155, y: 150 },
    { orientation: 'horizontal', x1: 245, x2: 350, y: 150 },
  ]);
  assert.deepEqual(splitWallSegment(structureSegment(verticalWall), [slidingDoor]).spans, [
    { orientation: 'vertical', x: 420, y1: 130, y2: 190 },
    { orientation: 'vertical', x: 420, y1: 310, y2: 370 },
  ]);
});

test('sliding windows use opening width geometry and stay attached to wall axes', () => {
  const wall = { id: 'wall', type: 'wall', x: 200, y: 150, length: 300, orientation: 'horizontal' };
  const windowStructure = { id: 'window', type: 'window', x: 500, y: 210, width: 160, orientation: 'vertical' };
  const aligned = alignDoorToWall(windowStructure, wall);
  assert.deepEqual(aligned, {
    ...windowStructure, x: 270, y: 150, orientation: 'horizontal', wallId: 'wall',
  });
  assert.deepEqual(structureSegment(aligned), { orientation: 'horizontal', x1: 190, x2: 350, y: 150 });
  assert.deepEqual(splitWallSegment(structureSegment(wall), [aligned]).spans, [
    { orientation: 'horizontal', x1: 50, x2: 190, y: 150 },
  ]);
});

test('attached doors cut only automatic boundaries overlapped by their owning wall', () => {
  const automaticWall = { orientation: 'horizontal', x1: 0, x2: 400, y: 100 };
  const walls = [
    { id: 'overlap', type: 'wall', orientation: 'horizontal', x: 100, y: 100, length: 160, thickness: 4 },
    { id: 'touching', type: 'wall', orientation: 'horizontal', x: 260, y: 105, length: 120, thickness: 4 },
    { id: 'nearby', type: 'wall', orientation: 'horizontal', x: 340, y: 110, length: 100, thickness: 4 },
    { id: 'vertical', type: 'wall', orientation: 'vertical', x: 200, y: 100, length: 120, thickness: 4 },
  ];
  const doors = [
    { id: 'direct', type: 'door', orientation: 'horizontal', x: 30, y: 110, width: 50, wallId: null },
    { id: 'overlap-door', type: 'door', orientation: 'horizontal', x: 100, y: 100, width: 80, wallId: 'overlap' },
    { id: 'touching-door', type: 'door', orientation: 'horizontal', x: 260, y: 105, width: 80, wallId: 'touching' },
    { id: 'nearby-door', type: 'door', orientation: 'horizontal', x: 340, y: 110, width: 70, wallId: 'nearby' },
    { id: 'vertical-door', type: 'door', orientation: 'vertical', x: 200, y: 100, width: 70, wallId: 'vertical' },
  ];

  assert.deepEqual(
    doorsForAutomaticWallSegment(automaticWall, doors, walls).map(({ id }) => id),
    ['direct', 'overlap-door', 'touching-door'],
  );
});

test('attached doors stay on their wall axis and inside its endpoints', () => {
  const horizontalWall = { id: 'wall-h', type: 'wall', x: 200, y: 150, length: 300, orientation: 'horizontal' };
  const verticalWall = { id: 'wall-v', type: 'wall', x: 420, y: 250, length: 240, orientation: 'vertical' };
  assert.deepEqual(alignDoorToWall({ id: 'door-h', type: 'door', x: 500, y: 210, width: 90 }, horizontalWall), {
    id: 'door-h', type: 'door', x: 305, y: 150, width: 90, orientation: 'horizontal', wallId: 'wall-h',
  });
  assert.deepEqual(alignDoorToWall({ id: 'door-v', type: 'door', x: 500, y: 50, width: 120 }, verticalWall), {
    id: 'door-v', type: 'door', x: 420, y: 190, width: 120, orientation: 'vertical', wallId: 'wall-v',
  });
});

test('linear structure endpoint resize keeps the opposite endpoint fixed', () => {
  const wall = { id: 'wall', type: 'wall', x: 200, y: 150, length: 300, orientation: 'horizontal' };
  const door = { id: 'door', type: 'door', x: 420, y: 250, width: 120, orientation: 'vertical' };
  assert.deepEqual(resizeStructureFromEndpoint(wall, 'start', { x: 100, y: 0 }), {
    ...wall, x: 225, length: 250,
  });
  assert.deepEqual(resizeStructureFromEndpoint(door, 'end', { x: 0, y: 350 }), {
    ...door, y: 270, width: 160,
  });
  assert.deepEqual(resizeStructureFromEndpoint(wall, 'end', { x: 100, y: 0 }, 120), {
    ...wall, x: 110, length: 120,
  });
});

test('moving a door near a wall snaps its position orientation and ownership', () => {
  const door = { id: 'door', type: 'door', x: 205, y: 285, width: 90, orientation: 'vertical', wallId: 'old' };
  const targets = [
    { orientation: 'horizontal', x1: 0, x2: 400, y: 300, wallId: null },
    { orientation: 'vertical', x: 450, y1: 0, y2: 400, wallId: 'manual-wall' },
  ];
  assert.deepEqual(snapDoorToWallSegments(door, targets), {
    ...door, x: 205, y: 300, orientation: 'horizontal', wallId: null,
  });
  assert.equal(snapDoorToWallSegments(door, [
    { orientation: 'horizontal', x1: 180, x2: 240, y: 300, wallId: 'short-wall' },
  ]), null);
  assert.equal(snapDoorToWallSegments({ ...door, x: 600, y: 600 }, targets), null);
});

test('door leaf collision follows swing angle and two-panel sliding openness', () => {
  const swing = { id: 'swing', type: 'door', doorType: 'swing', x: 100, y: 100, width: 90, orientation: 'horizontal', hinge: 'start', openSide: 1 };
  const closedSwing = getDoorLeafSegments([{ ...swing, openAngle: 0 }]);
  const openSwing = getDoorLeafSegments([{ ...swing, openAngle: 90 }]);
  assert.equal(isPointBlockedByDoorLeaves({ x: 100, y: 100 }, closedSwing, 5), true);
  assert.equal(isPointBlockedByDoorLeaves({ x: 100, y: 100 }, openSwing, 5), false);

  const sliding = { id: 'sliding', type: 'door', doorType: 'sliding', x: 250, y: 100, width: 120, orientation: 'horizontal', slideDirection: 'end' };
  const closedSliding = getDoorLeafSegments([{ ...sliding, openRatio: 0 }]);
  const openSliding = getDoorLeafSegments([{ ...sliding, openRatio: 100 }]);
  assert.equal(isPointBlockedByDoorLeaves({ x: 220, y: 100 }, closedSliding, 5), true);
  assert.equal(isPointBlockedByDoorLeaves({ x: 220, y: 100 }, openSliding, 5), false);
  assert.equal(isPointBlockedByDoorLeaves({ x: 280, y: 100 }, openSliding, 5), true);
});

test('solid custom wall segments block walkthrough movement without a doorway', () => {
  const segment = { orientation: 'horizontal', x1: 0, x2: 200, y: 100 };
  assert.equal(isPointBlockedByInteriorWall({ x: 100, y: 100 }, [segment]), true);
  assert.equal(isPointBlockedByInteriorWall({ x: 230, y: 100 }, [segment]), false);
});

test('attached parts of one compound space do not create an interior wall', () => {
  const compound = zones.map((zone) => ({ ...zone, spaceId: 'one-space' }));
  assert.deepEqual(getInteriorWallSegments(compound), []);
});
