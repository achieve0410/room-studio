import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import * as walkthrough from '../src/walkthrough3d.js';

test('overview clips only wall materials and walk restores full-height rendering', () => {
  const scene = new THREE.Scene();
  const shared = new THREE.MeshStandardMaterial();
  const objects = ['wall', 'wall-trim', 'door', 'window', 'furniture'].map((type) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2.4, 0.06), shared);
    mesh.position.y = 1.2;
    mesh.userData.type = type;
    scene.add(mesh);
    return mesh;
  });
  const frame = objects[1].clone();
  frame.userData.doorFramePart = true;
  scene.add(frame);
  const geometry = objects[0].geometry;
  const positions = [...geometry.attributes.position.array];
  const presentation = walkthrough.createWallPresentation(scene);
  for (const mode of ['dollhouse', 'top']) {
    assert.equal(presentation.setMode(mode), true);
    const plane = objects[0].material.clippingPlanes[0];
    assert.ok(plane instanceof THREE.Plane);
    assert.ok(plane.distanceToPoint(new THREE.Vector3(0, 2.4, 0)) < 0);
    assert.ok(plane.distanceToPoint(new THREE.Vector3(0, 0.1, 0)) > 0);
    assert.equal(objects[0].material.clipShadows, true);
    assert.equal(objects[0].visible, true);
    for (const object of [...objects.slice(2), frame]) {
      assert.equal(object.material, shared);
      assert.equal(object.material.clippingPlanes, null);
    }
  }
  assert.equal(presentation.setMode('walk'), false);
  assert.equal(objects[0].material.clippingPlanes, null);
  assert.equal(presentation.setMode('dollhouse', false), false);
  assert.equal(objects[0].material.clippingPlanes, null);
  assert.equal(objects[0].geometry, geometry);
  assert.deepEqual([...geometry.attributes.position.array], positions);
  assert.equal(objects[0].position.y, 1.2);
  let disposed = 0;
  objects[0].material.addEventListener('dispose', () => { disposed += 1; });
  presentation.dispose();
  assert.equal(disposed, 1);
  assert.equal(objects[0].material, shared);
});

test('renderer enables material-local clipping without global scene clipping', () => {
  let options;
  const renderer = {
    shadowMap: {},
    setPixelRatio(value) { this.pixelRatio = value; },
    setSize(width, height, updateStyle) { this.size = [width, height, updateStyle]; },
  };
  assert.equal(walkthrough.createWalkthroughRenderer({ clientWidth: 320, clientHeight: 568 }, {}, {
    antialias: true, pixelRatio: 2, shadows: true,
  }, (value) => { options = value; return renderer; }), renderer);
  assert.deepEqual(options, { antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  assert.equal(renderer.localClippingEnabled, true);
  assert.equal(renderer.clippingPlanes, undefined);
  assert.deepEqual(renderer.size, [320, 568, false]);
  assert.equal(renderer.shadowMap.enabled, true);
});

test('renderer construction failure removes the partial overlay and preserves the cause', () => {
  let removed = false;
  const cause = new Error('WebGL context unavailable');
  assert.throws(() => walkthrough.createWalkthroughRenderer({}, {
    remove() { removed = true; },
  }, {}, () => { throw cause; }), (error) => error.cause === cause);
  assert.equal(removed, true);
});

test('renderer setup failure disposes an allocated context before removing the overlay', () => {
  const calls = [];
  const cause = new Error('setup failed');
  assert.throws(() => walkthrough.createWalkthroughRenderer({}, {
    remove() { calls.push('remove'); },
  }, {}, () => ({
    setPixelRatio() { throw cause; },
    dispose() { calls.push('dispose'); },
    forceContextLoss() { calls.push('context-loss'); },
  })), (error) => error.cause === cause);
  assert.deepEqual(calls, ['dispose', 'context-loss', 'remove']);
});
