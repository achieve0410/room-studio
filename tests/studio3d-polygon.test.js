import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildScene } from '../src/walkthrough3d.js';
import { studioWallRuns, studioWallTargets, createStudioEditSession } from '../src/studio3d-edit.js';
import { disposeStudioScene } from '../src/studio3d-assets.js';
import { getDoorLeafSegments, isPointBlockedByDoorLeaves, isPointBlockedByInteriorWall,
  segmentFrame, snapDoorToWallSegments, splitWallSegmentLocal, structureSegment } from '../src/geometry.js';

const concave = {
  id: 'concave', name: 'ㄱ자 방', x: 0, y: 0, width: 500, depth: 500,
  floorMaterialId: 'oak-natural', wallMaterialId: 'plaster-chalk',
  points: [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 150 },
    { x: 150, y: 150 }, { x: 150, y: 500 }, { x: 0, y: 500 }],
};
const assets = { surface(material, id) { material.userData.finish = id; } };
const down = (scene, x, z, type, y = 6) => new THREE.Raycaster(
  new THREE.Vector3(x, y, z), new THREE.Vector3(0, -1, 0),
).intersectObjects(scene.children, true).filter(hit => hit.object.userData.type === type);

test('actual Three floor and ceiling follow a concave outline, not its bounding rectangle', () => {
  const scene = new THREE.Scene();
  try {
    buildScene(scene, [concave], [], [], 240, { x: 0, y: 0 }, assets);
    scene.updateMatrixWorld(true);
    assert.equal(down(scene, 3, 3, 'floor').length, 0, 'the L void must have no floor triangles');
    assert.ok(down(scene, 0.7, 3, 'floor').length > 0, 'the L leg has a real floor');
    const up = new THREE.Raycaster(new THREE.Vector3(3, 1, 3), new THREE.Vector3(0, 1, 0));
    assert.equal(up.intersectObjects(scene.children, true).filter(hit => hit.object.userData.type === 'ceiling').length, 0);
    up.ray.origin.set(0.7, 1, 3);
    assert.ok(up.intersectObjects(scene.children, true).some(hit => hit.object.userData.type === 'ceiling'), 'the ceiling faces down over the L leg');
    const fixture = scene.children.find(object => object.userData.type === 'ceiling-fixture');
    assert.ok(fixture.position.x <= 1.5 || fixture.position.z <= 1.5, 'fixture is inside the actual room');
  } finally { disposeStudioScene(scene); }
});

test('angled wall runs assign inward finishes to actual polygon edges', () => {
  const a = { id: 'a', x: 0, y: 0, width: 200, depth: 200,
    points: [{ x: 0, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }] };
  const b = { id: 'b', x: 200, y: 200, width: 200, depth: 200,
    points: [{ x: 0, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }] };
  const runs = studioWallRuns({ orientation: 'diagonal', x1: 0, y1: 0, x2: 400, y2: 400 }, [a, b]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map(run => [run.segment.x1, run.segment.y1, run.segment.x2, run.segment.y2].map(value => Math.round(value))),
    [[0, 0, 200, 200], [200, 200, 400, 400]]);
  assert.deepEqual(runs.map(run => run.positive?.id), ['a', 'b']);
  assert.ok(runs.every(run => !run.negative));
});


test('an enclosed same-space union void has no floor or ceiling', () => {
  const parts = [[0, 0, 500, 100], [0, 400, 500, 100], [0, 100, 100, 300], [400, 100, 100, 300]]
    .map(([x, y, width, depth], i) => ({ id: `part-${i}`, spaceId: 'ring', x, y, width, depth, floorMaterialId: 'oak-natural' }));
  const scene = new THREE.Scene();
  try {
    buildScene(scene, parts, [], [], 240, { x: 0, y: 0 }, assets);
    scene.updateMatrixWorld(true);
    assert.equal(down(scene, 2.5, 2.5, 'floor').length, 0);
    assert.ok(down(scene, 0.5, 2.5, 'floor').length > 0);
    const ray = new THREE.Raycaster(new THREE.Vector3(2.5, 1, 2.5), new THREE.Vector3(0, 1, 0));
    assert.equal(ray.intersectObjects(scene.children, true).filter(hit => hit.object.userData.type === 'ceiling').length, 0);
  } finally { disposeStudioScene(scene); }
});

test('snapped angled door/window render exact cuts, frames and directed leaves with shared collision', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  const zone = { ...concave, id: 'angled', width: 600, depth: 600,
    points: [{ x: 0, y: 0 }, { x: 600, y: 600 }, { x: 0, y: 600 }] };
  const layout = { zones: [zone], items: [], structures: [], wallHeight: 240 };
  const targets = studioWallTargets(layout);
  const door = snapDoorToWallSegments({ id: 'door', type: 'door', x: 165, y: 155, width: 90,
    height: 205, doorType: 'swing', hinge: 'start', openSide: 1, openAngle: 0 }, targets);
  const windowStructure = snapDoorToWallSegments({ id: 'window', type: 'window', x: 415, y: 405,
    width: 120, height: 100, sillHeight: 90, openRatio: 0 }, targets);
  const scene = new THREE.Scene();
  try {
    assert.ok(Math.abs(door.angle - 45) < 1e-8);
    assert.ok(Math.abs(windowStructure.angle - 45) < 1e-8);
    const controllers = buildScene(scene, [zone], [], [door, windowStructure], 240, { x: 0, y: 0 }, assets);
    scene.updateMatrixWorld(true);
    const frame = segmentFrame(structureSegment(door));
    const rayAt = (x, y, height) => new THREE.Raycaster(
      new THREE.Vector3(x / 100 + frame.normal.x * 0.3, height, y / 100 + frame.normal.y * 0.3),
      new THREE.Vector3(-frame.normal.x, 0, -frame.normal.y), 0, 0.6,
    ).intersectObjects(scene.children, true);
    const wallsAt = (...args) => rayAt(...args).filter(hit => hit.object.userData.type === 'wall');
    assert.equal(wallsAt(160, 160, 1).length, 0, 'door clear opening');
    assert.ok(wallsAt(160, 160, 2.2).length, 'door lintel');
    assert.equal(wallsAt(410, 410, 1.4).length, 0, 'window clear opening');
    assert.ok(wallsAt(410, 410, 0.5).length, 'window sill wall');
    assert.ok(wallsAt(410, 410, 2.2).length, 'window lintel');
    const solid = wallsAt(300, 300, 1);
    assert.ok(solid.length);
    assert.equal(solid[0].object.material[solid[0].face.materialIndex].userData.finish, zone.wallMaterialId);
    assert.ok(rayAt(160, 160, 1).some(hit => hit.object.userData.openingController?.structure.id === 'door'));
    const startJamb = rayAt(door.x + frame.tangent.x * door.width / 2, door.y + frame.tangent.y * door.width / 2, 1);
    assert.ok(startJamb.some(hit => hit.object.userData.doorFramePart), 'jamb aligns with the physical edge');
    const collisionSpans = splitWallSegmentLocal(targets.find(target => target.orientation === 'diagonal'), [door]).spans;
    assert.equal(isPointBlockedByInteriorWall({ x: 160, y: 160 }, collisionSpans, 10), false);
    assert.equal(isPointBlockedByInteriorWall({ x: 300, y: 300 }, collisionSpans, 10), true);
    assert.equal(isPointBlockedByDoorLeaves({ x: 160, y: 160 }, getDoorLeafSegments([door]), 10), true);
    const controller = controllers.find(entry => entry.kind === 'door');
    controller.setOpening(90); controller.tick(1); scene.updateMatrixWorld(true);
    assert.equal(isPointBlockedByDoorLeaves({ x: 160, y: 160 }, getDoorLeafSegments([door]), 10), false);
    const panel = controller.meshes[0];
    const endpoints = [-door.width / 200, door.width / 200].map(x => panel.localToWorld(new THREE.Vector3(x, 0, 0)));
    const leaf = getDoorLeafSegments([door])[0];
    const expected = [[leaf.start.x, leaf.start.y], [leaf.end.x, leaf.end.y]];
    for (const endpoint of endpoints) assert.ok(expected.some(([x, y]) => Math.hypot(endpoint.x * 100 - x, endpoint.z * 100 - y) < 1e-6));
  } finally { disposeStudioScene(scene); if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});

test('angled attachment previews cancel and commit without mutating the canonical room', () => {
  const zone = { ...concave, id: 'angled', width: 600, depth: 600,
    points: [{ x: 0, y: 0 }, { x: 600, y: 600 }, { x: 0, y: 600 }] };
  const canonical = { zones: [zone], items: [], structures: [], wallHeight: 240 };
  const actions = [];
  const session = createStudioEditSession({ layout: canonical, onEdit: action => { actions.push(action); } });
  session.preview({ type: 'add-structure', structure: { id: 'door', type: 'door', x: 180, y: 160, width: 90, height: 205, orientation: 'horizontal' } });
  assert.ok(Math.abs(session.layout.structures[0].angle - 45) < 1e-8);
  assert.equal(session.layout.structures[0].wallAttachment.zoneId, zone.id);
  assert.equal(canonical.structures.length, 0);
  session.cancel();
  assert.equal(session.layout.structures.length, 0);
  session.preview({ type: 'add-structure', structure: { id: 'door', type: 'door', x: 180, y: 160, width: 90, height: 205, orientation: 'horizontal' } });
  session.commit();
  assert.equal(actions.length, 1);
  assert.ok(Math.abs(actions[0].structure.x - actions[0].structure.y) < 1e-8);
});

test('a short opening fragment at a finish ownership seam never gains a phantom wall or jamb', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  const zones = [0, 200].map((x, index) => ({ id: `part-${index}`, spaceId: 'shared', x, y: 0, width: 200, depth: 300,
    floorMaterialId: 'oak-natural', wallMaterialId: index ? 'plaster-chalk' : 'plaster-warm' }));
  const door = { id: 'seam-door', type: 'door', x: 235, y: 0, width: 90, height: 205, orientation: 'horizontal', doorType: 'swing' };
  const scene = new THREE.Scene();
  try {
    buildScene(scene, zones, [], [door], 240, { x: 0, y: 0 }, assets);
    scene.updateMatrixWorld(true);
    const hit = new THREE.Raycaster(new THREE.Vector3(1.95, 1, 0.3), new THREE.Vector3(0, 0, -1), 0, 0.6)
      .intersectObjects(scene.children, true);
    assert.equal(hit.filter(entry => entry.object.userData.type === 'wall').length, 0, 'the 10cm fragment is still cut');
    const jambs = scene.children.filter(object => object.userData.type === 'wall-trim' && object.userData.doorFramePart);
    assert.equal(jambs.length, 2, 'only physical door ends get jambs, not the finish seam');
    assert.deepEqual(jambs.map(jamb => Math.round(jamb.position.x * 100)), [190, 280]);
  } finally { disposeStudioScene(scene); if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});


test('directed explicit-wall rotation preserves its opening offset and rendered hinge direction', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  const zone = { id: 'room', x: 0, y: 0, width: 700, depth: 700, floorMaterialId: 'oak-natural' };
  const wall = { id: 'wall', type: 'wall', x: 350, y: 350, length: 240, height: 240, thickness: 6, angle: 225 };
  const tangent = segmentFrame(structureSegment(wall)).tangent;
  const door = { id: 'door', wallId: 'wall', type: 'door', x: wall.x + tangent.x * 40, y: wall.y + tangent.y * 40,
    width: 80, height: 205, angle: 225, doorType: 'swing', hinge: 'end', openSide: -1, openAngle: 90 };
  const session = createStudioEditSession({ layout: { zones: [zone], items: [], structures: [wall, door], wallHeight: 240 }, onEdit() {} });
  const scene = new THREE.Scene();
  try {
    session.preview({ type: 'update-structure', id: 'wall', updates: { angle: 315, x: 380 } });
    const [nextWall, nextDoor] = session.layout.structures;
    const nextFrame = segmentFrame(structureSegment(nextWall));
    assert.ok(Math.abs((nextDoor.x - nextWall.x) * nextFrame.tangent.x + (nextDoor.y - nextWall.y) * nextFrame.tangent.y - 40) < 1e-6);
    const [controller] = buildScene(scene, [zone], [], session.layout.structures, 240, { x: 0, y: 0 }, assets);
    scene.updateMatrixWorld(true);
    const leaf = getDoorLeafSegments([nextDoor])[0];
    for (const x of [-0.4, 0.4]) {
      const endpoint = controller.meshes[0].localToWorld(new THREE.Vector3(x, 0, 0));
      assert.ok([leaf.start, leaf.end].some(point => Math.hypot(endpoint.x * 100 - point.x, endpoint.z * 100 - point.y) < 1e-6));
    }
    session.cancel();
    assert.equal(session.layout.structures[0].angle, 225);
  } finally { disposeStudioScene(scene); if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});
