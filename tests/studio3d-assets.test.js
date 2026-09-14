import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createStudioAssets, disposeStudioScene } from '../src/studio3d-assets.js';

function bounded(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Asset signal timeout')), 2000);
    }),
  ]).finally(() => clearTimeout(timer));
}
const item = {
  id: 'item',
  name: 'sofa',
  assetId: 'seoul-sofa',
  width: 220,
  depth: 94,
  height: 84,
  x: 0,
  y: 0,
};
const asset = { dimensions: { width: 2.2, depth: 0.94, height: 0.84 } };

test('a late previous-generation GLB releases once and never attaches to a retired root', async () => {
  const requests = [];
  const states = [];
  const released = Promise.withResolvers();
  let releaseCount = 0;
  const library = {
    acquire() {
      const request = Promise.withResolvers();
      requests.push(request);
      return request.promise;
    },
    dispose() {},
  };
  const assets = createStudioAssets((state) => states.push(state), library);
  const retired = assets.furniture(item);
  assets.begin();
  const current = assets.furniture({ ...item, id: 'current' });
  requests[0].resolve({
    object: new THREE.Group(),
    asset,
    release() {
      releaseCount++;
      released.resolve();
    },
  });
  await bounded(released.promise);
  assert.equal(releaseCount, 1);
  assert.equal(retired.userData.assetState, 'loading');
  assert.equal(states.at(-1).pending, 1);
  const ready = Promise.withResolvers();
  const object = new THREE.Group();
  // The callback signal is the exact attachment, not a guessed microtask count.
  object.addEventListener('added', () => ready.resolve());
  let currentReleases = 0;
  requests[1].resolve({
    object,
    asset,
    release() {
      currentReleases++;
      object.removeFromParent();
    },
  });
  await bounded(ready.promise);
  assert.equal(current.userData.assetState, 'ready');
  assert.deepEqual(object.scale.toArray(), [1, 1, 1]);
  assets.begin();
  assert.equal(currentReleases, 1);
  disposeStudioScene(retired);
  disposeStudioScene(current);
  assets.dispose();
});

test('closing while a GLB is pending never publishes ready or retains the late instance', async () => {
  const request = Promise.withResolvers(),
    released = Promise.withResolvers();
  const states = [];
  let disposed = 0;
  const assets = createStudioAssets((state) => states.push(state), {
    acquire: () => request.promise,
    dispose() {
      disposed++;
    },
  });
  const root = assets.furniture(item);
  assets.dispose();
  const before = states.length;
  request.resolve({ object: new THREE.Group(), asset, release: () => released.resolve() });
  await bounded(released.promise);
  assert.equal(states.length, before);
  assert.equal(disposed, 1);
  assert.equal(root.children.length, 1);
  disposeStudioScene(root);
});

test('surface map clones remain loader-owned while copied renderer materials are disposed', async () => {
  const ready = Promise.withResolvers();
  const texture = new THREE.Texture();
  let textureDisposals = 0,
    materialDisposals = 0;
  texture.addEventListener('dispose', () => textureDisposals++);
  const source = new THREE.MeshStandardMaterial({ map: texture, normalMap: texture });
  const releases = [];
  const library = {
    async acquireSurface(id, options) {
      assert.equal(id, 'oak-natural');
      assert.deepEqual(options.repeat, [2, 3]);
      const release = () => {
        source.dispose();
        texture.dispose();
      };
      releases.push(release);
      return { material: source, release };
    },
    dispose() {},
  };
  const assets = createStudioAssets((state) => {
    if (!state.pending) ready.resolve();
  }, library);
  const target = new THREE.MeshStandardMaterial();
  target.addEventListener('dispose', () => materialDisposals++);
  assets.surface(target, 'oak-natural', 3.6, 5.4, 'floor');
  await bounded(ready.promise);
  assert.equal(target.map, texture);
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.PlaneGeometry(), target));
  disposeStudioScene(root);
  assert.equal(materialDisposals, 1);
  assert.equal(textureDisposals, 0);
  assets.begin();
  assert.equal(textureDisposals, 1);
  assets.dispose();
});
