import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEMO_LAYOUTS, demoLayoutById } from '../src/demo-layouts.js';
import {
  doorsForAutomaticWallSegment,
  getDoorLeafSegments,
  getInteriorWallSegments,
  itemBounds,
  isPointBlockedByDoorLeaves,
  isPointBlockedByFurniture,
  isPointBlockedByInteriorWall,
  isWalkablePoint,
  splitWallSegment,
} from '../src/geometry.js';

const DATASET_URL = 'https://www.data.go.kr/data/15037046/fileData.do';
const CATALOG_URL = 'https://www.data.go.kr/catalog/15037046/fileData.json';
const LICENSE = '이용허락범위 제한 없음';
const SOURCE_RECEIPTS = JSON.parse(readFileSync(
  new URL('../.omo/evidence/layout-speed/lh-source-records.json', import.meta.url),
));
const entities = (layout) => [...layout.zones, ...layout.items, ...layout.structures, ...layout.dimensions];
const FURNITURE_TYPES = new Set(['bed', 'sofa', 'desk', 'table', 'rug', 'wardrobe', 'shelf', 'rack']);

function doorConnectedZoneGraph(layout) {
  const doors = layout.structures.filter(({ type }) => type === 'door');
  const walls = layout.structures.filter(({ type }) => type === 'wall');
  const neighbors = new Map(layout.zones.map(({ name }) => [name, new Set()]));
  const matchedDoorIds = new Map();
  for (let first = 0; first < layout.zones.length; first += 1) {
    for (let second = first + 1; second < layout.zones.length; second += 1) {
      const openings = getInteriorWallSegments([
        layout.zones[first],
        layout.zones[second],
      ]).flatMap((wall) => splitWallSegment(
        wall,
        doorsForAutomaticWallSegment(wall, doors, walls),
      ).openings);
      if (openings.length === 0) continue;
      const firstName = layout.zones[first].name;
      const secondName = layout.zones[second].name;
      neighbors.get(firstName).add(secondName);
      neighbors.get(secondName).add(firstName);
      for (const opening of openings) {
        for (const matchedDoor of opening.doors) {
          const matches = matchedDoorIds.get(matchedDoor.id) ?? new Set();
          matches.add([firstName, secondName].sort().join(' <> '));
          matchedDoorIds.set(matchedDoor.id, matches);
        }
      }
    }
  }
  return { neighbors, matchedDoorIds };
}

function zonesReachableThroughDoors(layout) {
  const { neighbors } = doorConnectedZoneGraph(layout);
  const start = layout.zones.find(({ type }) => type === '거실')?.name ?? layout.zones[0].name;
  const reachable = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const neighbor of neighbors.get(queue.shift())) {
      if (reachable.has(neighbor)) continue;
      reachable.add(neighbor);
      queue.push(neighbor);
    }
  }
  return reachable;
}

test('ships three immutable, distinct LH model-home adaptations', () => {
  assert.equal(DEMO_LAYOUTS.length, 3);
  assert.ok(Object.isFrozen(DEMO_LAYOUTS));
  assert.deepEqual(DEMO_LAYOUTS.map(({ typology }) => typology).sort(), ['common-family', 'compact', 'larger-family']);
  assert.equal(new Set(DEMO_LAYOUTS.map(({ id }) => id)).size, 3);
  assert.equal(new Set(DEMO_LAYOUTS.map(({ source }) => source.archiveEntry)).size, 3);
  assert.deepEqual(DEMO_LAYOUTS.map(({ source }) => source.planType), ['59A', '74A', '84A']);
  for (const fixture of DEMO_LAYOUTS) {
    assert.ok(Object.isFrozen(fixture));
    assert.equal(fixture.backgroundPlan, null);
    assert.ok(Number.isFinite(fixture.wallHeight) && fixture.wallHeight > 0);
    for (const key of ['zones', 'items', 'structures', 'dimensions']) {
      assert.ok(Array.isArray(fixture[key]) && fixture[key].length > 0, `${fixture.id}: ${key}`);
      assert.ok(Object.isFrozen(fixture[key]), `${fixture.id}: immutable ${key}`);
    }
    assert.ok(fixture.structures.some(({ type }) => type === 'door'));
    assert.ok(fixture.structures.some(({ type }) => type === 'window'));
    assert.equal(
      fixture.structures.filter(({ type, exterior }) => type === 'door' && exterior).length,
      1,
      `${fixture.id}: one exterior entrance door`,
    );
    assert.ok(fixture.items.some(({ name }) => name === '침대'));
    assert.ok(fixture.items.some(({ name }) => name === '소파'));
    assert.ok(fixture.items.some(({ name }) => name === '식탁'));
    const ids = entities(fixture).map(({ id }) => id);
    assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0));
    assert.equal(new Set(ids).size, ids.length, `${fixture.id}: globally unique entity IDs`);
    for (const zone of fixture.zones) {
      assert.ok(zone.name && zone.type);
      assert.ok([zone.x, zone.y, zone.width, zone.depth].every(Number.isFinite));
      assert.ok(zone.width > 0 && zone.depth > 0);
    }
    assert.equal(
      fixture.zones.filter(({ walkthroughStart }) => walkthroughStart).length,
      1,
      `${fixture.id}: one entrance starts the walkthrough`,
    );
    for (const item of fixture.items) {
      assert.ok(FURNITURE_TYPES.has(item.type), `${fixture.id}: supported item type for ${item.id}`);
      assert.ok([item.x, item.y, item.width, item.depth, item.height].every(Number.isFinite));
      assert.ok(item.width > 0 && item.depth > 0 && item.height > 0);
    }
    for (const dimension of fixture.dimensions) {
      assert.ok([dimension.x1, dimension.y1, dimension.x2, dimension.y2].every(Number.isFinite));
      assert.notDeepEqual([dimension.x1, dimension.y1], [dimension.x2, dimension.y2]);
    }
  }
});

test('connects every model-home room through a door opening', () => {
  for (const fixture of DEMO_LAYOUTS) {
    const reachable = zonesReachableThroughDoors(fixture);
    assert.equal(
      reachable.size,
      fixture.zones.length,
      `${fixture.id}: only ${reachable.size}/${fixture.zones.length} zones are reachable`,
    );
    const { neighbors, matchedDoorIds } = doorConnectedZoneGraph(fixture);
    const actualEdges = new Set([...neighbors].flatMap(([from, destinations]) =>
      [...destinations].map((to) => [from, to].sort().join(' <> '))));
    const receipt = SOURCE_RECEIPTS.records.find(({ fixtureId }) => fixtureId === fixture.id);
    assert.ok(receipt, `${fixture.id}: independent source receipt exists`);
    assert.deepEqual(fixture.source.roomAdjacency, receipt.roomAdjacency);
    const expectedEdges = new Set(receipt.roomAdjacency.map((edge) => edge.slice().sort().join(' <> ')));
    assert.deepEqual(actualEdges, expectedEdges, `${fixture.id}: preserves official room adjacency`);
    assert.equal(
      fixture.structures.filter(({ type, exterior }) => type === 'door' && !exterior).length,
      expectedEdges.size,
      `${fixture.id}: every interior adjacency has one visible door structure`,
    );
    for (const doorStructure of fixture.structures.filter(({ type }) => type === 'door')) {
      assert.equal(doorStructure.openAngle, 90, `${fixture.id}: ${doorStructure.name} starts open for walkthrough`);
      if (doorStructure.exterior) continue;
      assert.equal(
        matchedDoorIds.get(doorStructure.id)?.size,
        1,
        `${fixture.id}: ${doorStructure.name} matches exactly one room boundary`,
      );
    }
  }
});

test('keeps a traversable approach clear on both sides of every interior door', () => {
  for (const fixture of DEMO_LAYOUTS) {
    const doors = fixture.structures.filter(({ type }) => type === 'door');
    const walls = fixture.structures.filter(({ type }) => type === 'wall');
    const wallSpans = [];
    const approaches = [];
    for (const wall of getInteriorWallSegments(fixture.zones)) {
      const split = splitWallSegment(wall, doorsForAutomaticWallSegment(wall, doors, walls));
      wallSpans.push(...split.spans);
      for (const opening of split.openings) {
        const center = wall.orientation === 'horizontal'
          ? { x: (opening.start + opening.end) / 2, y: wall.y }
          : { x: wall.x, y: (opening.start + opening.end) / 2 };
        const normal = wall.orientation === 'horizontal' ? { x: 0, y: 1 } : { x: 1, y: 0 };
        for (const side of [-1, 1]) {
          approaches.push({
            doorNames: opening.doors.map(({ name }) => name).join(', '),
            point: { x: center.x + normal.x * 28 * side, y: center.y + normal.y * 28 * side },
          });
        }
      }
    }
    const openDoorLeaves = getDoorLeafSegments(doors.map((doorStructure) => ({
      ...doorStructure,
      openAngle: 90,
    })));
    for (const { doorNames, point } of approaches) {
      const label = `${fixture.id}: ${doorNames} at ${point.x},${point.y}`;
      assert.ok(isWalkablePoint(point, fixture.zones, 18), `${label} stays in the floor plan`);
      assert.ok(!isPointBlockedByFurniture(point, fixture.items, 18, 165), `${label} clears furniture`);
      assert.ok(!isPointBlockedByInteriorWall(point, wallSpans, 18), `${label} clears wall spans`);
      assert.ok(!isPointBlockedByDoorLeaves(point, openDoorLeaves, 18), `${label} clears open door leaves`);
    }
  }
});

test('keeps every open interior door leaf clear of furniture', () => {
  for (const fixture of DEMO_LAYOUTS) {
    for (const doorStructure of fixture.structures.filter(({ type, exterior }) => type === 'door' && !exterior)) {
      const halfWidth = doorStructure.width / 2;
      const hinge = doorStructure.orientation === 'horizontal'
        ? {
          x: doorStructure.x + (doorStructure.hinge === 'end' ? halfWidth : -halfWidth),
          y: doorStructure.y,
        }
        : {
          x: doorStructure.x,
          y: doorStructure.y + (doorStructure.hinge === 'end' ? halfWidth : -halfWidth),
        };
      const leaf = getDoorLeafSegments([{ ...doorStructure, openAngle: 90 }])[0];
      const leafBounds = {
        left: Math.min(hinge.x, leaf.end.x),
        right: Math.max(hinge.x, leaf.end.x),
        top: Math.min(hinge.y, leaf.end.y),
        bottom: Math.max(hinge.y, leaf.end.y),
      };
      const collides = fixture.items.some((item) => {
        const bounds = itemBounds(item);
        return leafBounds.left < bounds.right
        && leafBounds.right > bounds.left
        && leafBounds.top < bounds.bottom
        && leafBounds.bottom > bounds.top;
      }
      );
      assert.equal(collides, false, `${fixture.id}: ${doorStructure.name} open leaf clears furniture`);
    }
  }
});

test('contains attributable unrestricted source metadata without sensitive or copied data', () => {
  for (const { source } of DEMO_LAYOUTS) {
    assert.equal(source.datasetUrl, DATASET_URL);
    assert.equal(source.catalogUrl, CATALOG_URL);
    assert.equal(source.archiveFileId, 'FILE_000000003519063');
    assert.equal(source.fileDetailSn, '1');
    assert.equal(source.license, LICENSE);
    assert.match(source.attribution, /한국토지주택공사/);
    assert.match(source.adaptationNotice, /재구성|adapt/i);
    assert.match(source.geometryBasis, /mm/);
    assert.ok(source.roomAdjacency.length >= 2);
    assert.match(source.recordSha256, /^[a-f0-9]{64}$/);
    assert.match(source.archiveEntry, /\.json$/);
    assert.match(source.planType, /^\d+[A-Z]$/);
    assert.ok(source.archiveEntry.toUpperCase().includes(source.planType));
    assert.equal('supplyAreaSquareMeters' in source, false);
    const serialized = JSON.stringify(source);
    assert.doesNotMatch(serialized, /(?:data:image|base64|https?:\/\/(?:s3|storage|supabase)|\b(?:address|주소|resident|주민|brand|브랜드)\b)/i);
    assert.ok(!Object.keys(source).some((key) => /address|resident|brand|cloud/i.test(key)));
  }
});

test('lookup returns a deep clone and cannot mutate canonical fixtures', () => {
  assert.equal(demoLayoutById('missing-layout'), null);
  const canonical = DEMO_LAYOUTS[0];
  const first = demoLayoutById(canonical.id);
  const second = demoLayoutById(canonical.id);
  assert.deepEqual(first, canonical);
  assert.notEqual(first, canonical);
  assert.notEqual(first.zones, canonical.zones);
  assert.notEqual(first.source, canonical.source);
  first.name = 'changed';
  first.zones[0].name = 'changed';
  first.source.attribution = 'changed';
  assert.deepEqual(second, canonical);
  assert.notEqual(canonical.name, 'changed');
});
