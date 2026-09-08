import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_LAYOUTS, REGIONAL_DEMO_LAYOUTS, demoLayoutById } from '../src/demo-layouts.js';
import {
  doorsForAutomaticWallSegment, getDoorLeafSegments, getInteriorWallSegments,
  getLayoutBounds, itemInsideZones, itemsOverlap3d, isPointBlockedByDoorLeaves,
  isPointBlockedByFurniture, isPointBlockedByInteriorWall, isWalkablePoint,
  pointInZone, splitWallSegment,
} from '../src/geometry.js';

test('regional samples add three attributable immutable plans without replacing LH fixtures', () => {
  assert.equal(DEMO_LAYOUTS.length, 3);
  assert.equal(REGIONAL_DEMO_LAYOUTS.length, 3);
  assert.deepEqual(REGIONAL_DEMO_LAYOUTS.map(f => f.region), ['대치동', '압구정동', '도곡동']);
  for (const layout of REGIONAL_DEMO_LAYOUTS) {
    assert.ok(Object.isFrozen(layout.zones));
    assert.equal(layout.backgroundPlan, null);
    assert.ok(new URL(layout.source.referenceUrl).hostname.includes('.'));
    assert.doesNotMatch(JSON.stringify(layout), /credential=|signature=|data:image|\/Users\/|\.omx\//);
    const copy = demoLayoutById(layout.id);
    copy.zones[0].x += 100;
    assert.notEqual(copy.zones[0].x, layout.zones[0].x);
    assert.deepEqual(demoLayoutById(layout.id), layout);
    assert.equal(layout.zones.filter(z => z.type === '방').length, 3);
    assert.equal(layout.zones.filter(z => z.walkthroughStart).length, 1);
    for (const zone of layout.zones) {
      assert.ok(zone.width >= 100 && zone.depth >= 100, `${zone.id}: must survive editor minimum-size normalization`);
    }
  }
});

for (const region of ['대치동', '압구정동', '도곡동']) {
  test(`${region}: default furniture and doors leave all rooms reachable from the entrance`, () => {
    const layout = REGIONAL_DEMO_LAYOUTS.find(f => f.region === region);
    assert.ok(layout);
    for (const item of layout.items) {
      assert.ok(itemInsideZones(item, layout.zones), item.id);
      for (const other of layout.items) {
        if (item !== other) assert.equal(itemsOverlap3d(item, other, 0), false, `${item.id}/${other.id}`);
      }
    }
    const doors = layout.structures.filter(s => s.type === 'door');
    assert.equal(doors.filter(d => d.exterior).length, 1);
    const leaves = getDoorLeafSegments(doors);
    const walls = getInteriorWallSegments(layout.zones).flatMap(w =>
      splitWallSegment(w, doorsForAutomaticWallSegment(w, doors, [])).spans);
    const radius = 18;
    const clear = p => isWalkablePoint(p, layout.zones, radius)
      && itemInsideZones({ ...p, width: radius * 2, depth: radius * 2 }, layout.zones)
      && !isPointBlockedByInteriorWall(p, walls, radius)
      && !isPointBlockedByDoorLeaves(p, leaves, radius)
      && !isPointBlockedByFurniture(p, layout.items, radius, 165);
    const bounds = getLayoutBounds(layout.zones);
    const step = 5;
    const columns = Math.floor(bounds.width / step) + 1;
    const rows = Math.floor(bounds.depth / step) + 1;
    const point = n => ({ x: bounds.left + n % columns * step, y: bounds.top + Math.floor(n / columns) * step });
    const available = new Uint8Array(columns * rows);
    for (let n = 0; n < available.length; n += 1) available[n] = clear(point(n)) ? 1 : 0;
    const entrance = layout.zones.find(z => z.walkthroughStart);
    const entryDoor = doors.find(d => d.exterior);
    const starts = [];
    for (let n = 0; n < available.length; n += 1) {
      const p = point(n);
      if (available[n] && pointInZone(p, entrance) && Math.hypot(p.x - entryDoor.x, p.y - entryDoor.y) < 65) starts.push(n);
    }
    assert.ok(starts.length, 'Entrance door must open into the starting space');
    const flood = forbidden => {
      const seen = new Set();
      const queue = [];
      const add = n => {
        if (n < 0 || n >= available.length || !available[n] || seen.has(n)
          || forbidden.some(z => pointInZone(point(n), z))) return;
        seen.add(n); queue.push(n);
      };
      starts.forEach(add);
      for (let head = 0; head < queue.length; head += 1) {
        const n = queue[head];
        if (n % columns) add(n - 1);
        if (n % columns < columns - 1) add(n + 1);
        add(n - columns); add(n + columns);
      }
      return seen;
    };
    const reached = (zone, seen) => [...seen].some(n => {
      const p = point(n);
      return p.x > zone.x + radius && p.x < zone.x + zone.width - radius
        && p.y > zone.y + radius && p.y < zone.y + zone.depth - radius;
    });
    const all = flood([]);
    for (const zone of layout.zones) assert.ok(reached(zone, all), `${region}: ${zone.name} unreachable`);
    const bedrooms = layout.zones.filter(z => z.type === '방');
    for (const room of bedrooms) {
      assert.ok(reached(room, flood(bedrooms.filter(other => other !== room))), `${room.name}: route through another bedroom`);
    }
  });
}
