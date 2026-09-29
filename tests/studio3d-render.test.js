import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildScene, createWallPresentation, pickWalkthroughOpening } from '../src/walkthrough3d.js';
import { disposeStudioScene } from '../src/studio3d-assets.js';

test('hidden selection helpers cannot intercept physical opening raycasts', () => {
  const scene = new THREE.Scene();
  const helper = new THREE.Box3Helper(
    new THREE.Box3(new THREE.Vector3(-1, -1, 1), new THREE.Vector3(1, 1, 2)),
  );
  helper.visible = false;
  scene.add(helper);
  const door = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
  const controller = { kind: 'door' };
  door.userData.openingController = controller;
  scene.add(door);
  scene.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 3), new THREE.Vector3(0, 0, -1));
  assert.equal(ray.intersectObjects(scene.children, true)[0].object, helper);
  assert.equal(pickWalkthroughOpening(ray, scene), controller);
  const obstruction = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
  obstruction.position.z = 0.5;
  scene.add(obstruction);
  scene.updateMatrixWorld(true);
  assert.equal(
    pickWalkthroughOpening(ray, scene),
    null,
    'real furniture still blocks interaction through it',
  );
  disposeStudioScene(scene);
});

test('zone-facing wall material arrays keep independent finishes through cutaway and restore', () => {
  const scene = new THREE.Scene();
  const first = new THREE.MeshStandardMaterial({ color: '#e7dfd1' });
  const second = new THREE.MeshStandardMaterial({ color: '#8b9494' });
  const faces = [first, second, first, first, first, first];
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 2.4, 0.06), faces);
  wall.userData.type = 'wall';
  scene.add(wall);
  const presentation = createWallPresentation(scene);
  assert.notEqual(wall.material, faces);
  assert.notEqual(wall.material[0], first);
  assert.equal(wall.material[0], wall.material[2]);
  assert.notEqual(wall.material[0].color.getHex(), wall.material[1].color.getHex());
  presentation.setMode('top');
  assert.ok(wall.material.every((material) => material.clippingPlanes.length === 1));
  assert.equal(first.clippingPlanes, null);
  presentation.setMode('walk');
  assert.ok(wall.material.every((material) => material.clippingPlanes === null));
  presentation.dispose();
  assert.equal(wall.material, faces);
  disposeStudioScene(scene);
});

test('renderer disposes its shared resources once and leaves catalog-owned resources to their owner', () => {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry();
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture });
  root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
  const borrowed = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  borrowed.userData.roomAssetOwned = true;
  root.add(borrowed);
  const counters = { geometry: 0, material: 0, texture: 0, borrowed: 0 };
  geometry.addEventListener('dispose', () => counters.geometry++);
  material.addEventListener('dispose', () => counters.material++);
  texture.addEventListener('dispose', () => counters.texture++);
  borrowed.geometry.addEventListener('dispose', () => counters.borrowed++);
  borrowed.material.addEventListener('dispose', () => counters.borrowed++);
  disposeStudioScene(root);
  assert.deepEqual(counters, { geometry: 1, material: 1, texture: 1, borrowed: 0 });
  borrowed.geometry.dispose();
  borrowed.material.dispose();
});

test('contact shadows follow the furniture footprint and share one fading texture per scene', () => {
  const scene = new THREE.Scene();
  const items = [
    { id: 'sofa', type: 'sofa', x: 100, y: 100, width: 200, depth: 60, height: 80, rotation: 90, color: '#c8a777' },
    { id: 'table', type: 'table', x: 400, y: 100, width: 80, depth: 80, height: 70, rotation: 0, color: '#c8a777' },
  ];
  buildScene(scene, [], items, [], 240, { x: 0, y: 0 }, {});
  const shadows = scene.children.filter(object => object.userData.type === 'furniture-shadow');
  assert.equal(shadows.length, 2);
  const size = new THREE.Box3().setFromObject(shadows[0]).getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.x - 0.76) < 1e-6);
  assert.ok(Math.abs(size.z - 2.16) < 1e-6);
  assert.ok(size.y < 1e-6);
  assert.equal(shadows[0].material, shadows[1].material);
  const texture = shadows[0].material.map;
  assert.equal(texture.image.data[3], 0);
  assert.ok(texture.image.data[(32 * 64 + 32) * 4 + 3] > 0);
  let disposed = 0;
  texture.addEventListener('dispose', () => disposed++);
  disposeStudioScene(scene);
  assert.equal(disposed, 1);
});
