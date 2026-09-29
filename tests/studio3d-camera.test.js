import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fitOverviewCamera, overviewSpatialBounds, overviewSpatialMeshes } from '../src/walkthrough3d.js';
import { createStudioNavigation, fitStudioCamera, studioRoomPoints, studioSpatialPoints } from '../src/studio3d-camera.js';

const projectedRange = (points, camera, axis) => {
  const values = points.map((point) => point.clone().project(camera)[axis]);
  return { min: Math.min(...values), max: Math.max(...values) };
};

test('room framing includes compound outlines, local furniture and open door leaves without fitting neighboring rooms', () => {
  const layout = {
    zones: [
      { id: 'a', spaceId: 'living', x: 0, y: 0, width: 400, depth: 300, height: 240 },
      { id: 'b', spaceId: 'living', x: 400, y: 0, width: 100, depth: 200, height: 240 },
      { id: 'other', x: 1200, y: 0, width: 500, depth: 400, height: 280 },
    ],
    items: [{ id: 'sofa', x: 200, y: 150 }, { id: 'wardrobe', x: 1400, y: 150 }],
    structures: [{ id: 'door', type: 'door', doorType: 'swing', x: 0, y: 150, width: 90, height: 205,
      orientation: 'vertical', hinge: 'start', openAngle: 90, openSide: 1 }],
    wallHeight: 240,
  };
  const original = structuredClone(layout);
  const scene = new THREE.Scene();
  for (const item of layout.items) {
    const group = new THREE.Group();
    group.userData = { type: 'furniture', id: item.id };
    group.position.set(item.x / 100, 0, item.y / 100);
    const height = item.id === 'sofa' ? 0.9 : 2.8;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, height, 1), new THREE.MeshBasicMaterial());
    mesh.position.y = height / 2;
    group.add(mesh);
    scene.add(group);
  }
  const points = studioRoomPoints(layout, 'living', { x: 0, y: 0 }, overviewSpatialMeshes(scene));
  assert.ok(points.some(point => Math.abs(point.x + 0.9) < 1e-9), 'the open door swing remains in frame');
  assert.ok(points.some(point => point.x === 5), 'all parts of the logical room contribute');
  assert.ok(points.some(point => Math.abs(point.y - 0.9) < 1e-6), 'actual furniture bounds contribute');
  assert.ok(points.every(point => point.x <= 5 && point.y <= 2.05), 'unrelated rooms and tall furniture do not enlarge the frame');
  const bounds = new THREE.Box3().setFromPoints(points);
  for (const mode of ['top', 'dollhouse']) {
    for (const aspect of [390 / 338, 1128 / 866, 516 / 282]) {
      const camera = new THREE.PerspectiveCamera(48, aspect, 0.05, 100);
      fitOverviewCamera(camera, bounds, mode);
      fitStudioCamera(camera, points, bounds.getCenter(new THREE.Vector3()));
      for (const axis of ['x', 'y']) {
        const range = projectedRange(points, camera, axis);
        assert.ok(range.min >= -0.900001 && range.max <= 0.900001, JSON.stringify({ mode, aspect, axis, range }));
      }
    }
  }
  assert.deepEqual(layout, original);
});

test('visible-envelope fitting balances the room without discarding tall open doors or changing geometry', () => {
  const scene = new THREE.Scene();
  const floor = new THREE.Mesh(new THREE.BoxGeometry(8, 0.01, 10), new THREE.MeshBasicMaterial());
  floor.userData.type = 'floor';
  scene.add(floor);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(8, 2.4, 0.06), new THREE.MeshBasicMaterial());
  wall.userData.type = 'wall';
  wall.position.set(0, 1.2, -5);
  wall.material.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 0.65)];
  scene.add(wall);
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.04, 2.05, 1), new THREE.MeshBasicMaterial());
  door.userData.openingController = { kind: 'door' };
  door.position.set(-4.2, 1.025, 2);
  scene.add(door);
  const bounds = overviewSpatialBounds(scene);
  const points = studioSpatialPoints(overviewSpatialMeshes(scene));
  assert.ok(points.some((point) => Math.abs(point.y - 2.05) < 1e-6));
  assert.ok(
    points.every((point) => point.y < 2.1),
    'clipped-away wall vertices do not inflate framing',
  );
  for (const aspect of [1128 / 866, 390 / 554, 844 / 256]) {
    const camera = new THREE.PerspectiveCamera(48, aspect, 0.05, 100);
    fitOverviewCamera(camera, bounds, 'dollhouse');
    fitStudioCamera(camera, points, bounds.getCenter(new THREE.Vector3()));
    for (const axis of ['x', 'y']) {
      const range = projectedRange(points, camera, axis);
      assert.ok(range.min >= -0.900001 && range.max <= 0.900001, JSON.stringify({ aspect, axis, range }));
      assert.ok(Math.abs(range.min + range.max) < 0.1, JSON.stringify({ aspect, axis, range }));
    }
  }
  assert.equal(wall.geometry.parameters.height, 2.4);
  assert.equal(door.position.y, 1.025);
});

test('overview orbit, pan and zoom change only camera state; reserved furniture drag waits for two pointers', () => {
  const camera = new THREE.PerspectiveCamera(48, 1.3, 0.05, 100);
  const target = new THREE.Vector3();
  camera.position.set(6, 8, 7);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  let changes = 0;
  const navigation = createStudioNavigation({
    camera,
    target,
    size: () => ({ width: 1128, height: 866 }),
    mode: () => 'dollhouse',
    onChange: () => changes++,
  });
  const event = (id, x, y, extra = {}) => ({ pointerId: id, clientX: x, clientY: y, button: 0, ...extra });
  const initial = camera.position.clone();
  navigation.down(event(0, 20, 20));
  navigation.move(event(0, 20, 20));
  navigation.up(event(0, 20, 20));
  assert.equal(changes, 0, 'a stationary surface tap does not claim camera navigation');
  navigation.down(event(1, 20, 20), true);
  navigation.move(event(1, 40, 20));
  assert.ok(camera.position.equals(initial));
  assert.equal(changes, 0);
  navigation.down(event(2, 80, 20));
  navigation.move(event(2, 140, 20));
  assert.ok(camera.position.distanceTo(target) < initial.length());
  navigation.up(event(1, 40, 20));
  navigation.up(event(2, 140, 20));
  const beforeOrbit = camera.quaternion.clone();
  navigation.down(event(3, 20, 20));
  navigation.move(event(3, 70, 40));
  navigation.up(event(3, 70, 40));
  assert.equal(camera.quaternion.equals(beforeOrbit), false);
  const beforePan = target.clone();
  navigation.down(event(4, 20, 20, { shiftKey: true }));
  navigation.move(event(4, 70, 20));
  navigation.up(event(4, 70, 20));
  assert.equal(target.equals(beforePan), false);
  const beforeZoom = camera.position.distanceTo(target);
  navigation.wheel({ deltaY: -100, deltaMode: 0 });
  assert.ok(camera.position.distanceTo(target) < beforeZoom);
  navigation.cancel();
});
