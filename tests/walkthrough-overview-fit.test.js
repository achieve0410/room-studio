import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import * as walkthrough from '../src/walkthrough3d.js';

test('overview fits the complete spatial envelope at portrait and landscape aspects', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial();
  const room = new THREE.Mesh(new THREE.BoxGeometry(8, 2.4, 6), material);
  room.position.y = 1.2;
  room.userData.type = 'wall';
  scene.add(room);
  const pivot = new THREE.Group();
  pivot.position.set(-4, 0, -2);
  pivot.rotation.y = Math.PI / 3;
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.05, 0.035), material);
  leaf.position.set(-0.6, 1.025, 0);
  leaf.userData.openingController = { kind: 'door' };
  pivot.add(leaf);
  scene.add(pivot);
  scene.updateMatrixWorld(true);
  const before = scene.toJSON();
  const bounds = walkthrough.overviewSpatialBounds(scene);
  assert.ok(bounds.min.x < -4);
  for (const aspect of [320 / 294, 390 / 570, 768 / 844, 844 / 256, 1440 / 866, 0.25, 4]) {
    for (const mode of ['top', 'dollhouse']) {
      for (const target of [null, { x: 3, y: 0.8, z: 2 }]) {
        const camera = new THREE.PerspectiveCamera(70, aspect, 0.05, 50);
        walkthrough.fitOverviewCamera(camera, bounds, mode, target);
        let largest = 0;
        for (const x of [bounds.min.x, bounds.max.x]) {
          for (const y of [bounds.min.y, bounds.max.y]) {
            for (const z of [bounds.min.z, bounds.max.z]) {
              const projected = new THREE.Vector3(x, y, z).project(camera);
              largest = Math.max(largest, Math.abs(projected.x), Math.abs(projected.y));
              assert.ok(Math.abs(projected.x) <= 0.900001, `${mode}, aspect ${aspect}, x ${projected.x}`);
              assert.ok(Math.abs(projected.y) <= 0.900001, `${mode}, aspect ${aspect}, y ${projected.y}`);
              assert.ok(projected.z >= -1 && projected.z <= 1);
            }
          }
        }
        assert.ok(largest >= 0.899999, 'the camera should not zoom out beyond the requested margin');
      }
    }
  }
  assert.deepEqual(scene.toJSON(), before);
});

test('overview excludes decorative ground, ceilings, labels and invisible hit meshes', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial();
  const floor = new THREE.Mesh(new THREE.BoxGeometry(4, 0.01, 3), material);
  floor.userData.type = 'floor';
  scene.add(floor);
  const expected = walkthrough.overviewSpatialBounds(scene).clone();
  for (const type of [undefined, 'ceiling', 'ceiling-fixture', 'furniture-label']) {
    const decoration = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000), material);
    decoration.userData.type = type;
    scene.add(decoration);
  }
  const hidden = new THREE.Group();
  hidden.visible = false;
  const furniture = new THREE.Mesh(new THREE.BoxGeometry(100, 100, 100), material);
  furniture.userData.type = 'furniture';
  hidden.add(furniture);
  scene.add(hidden);
  const interaction = new THREE.Mesh(new THREE.BoxGeometry(200, 200, 200),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, colorWrite: false }));
  interaction.userData.openingController = { kind: 'door' };
  scene.add(interaction);
  assert.ok(walkthrough.overviewSpatialBounds(scene).equals(expected));
});
