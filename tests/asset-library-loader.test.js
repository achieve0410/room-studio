import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from 'three';
import { createRoomAssetLibrary } from '../src/asset-library-loader.js';

function template() {
  const scene = new Group();
  const texture = new Texture();
  const geometry = new BoxGeometry(1, 1, 1);
  const fabric = new MeshStandardMaterial({ color: '#c4b8a4', map: texture });
  fabric.name = 'fabric'; fabric.userData.slot = 'fabric';
  const metal = new MeshStandardMaterial({ color: '#514839', metalness: 0.72 });
  metal.name = 'metal'; metal.userData.slot = 'metal';
  scene.add(new Mesh(geometry, fabric), new Mesh(geometry, metal));
  return { scene, geometry, fabric, metal, texture };
}

function observe(resources) {
  const counts = new Map(resources.map((resource) => [resource, 0]));
  counts.forEach((_, resource) => resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource) + 1)));
  return counts;
}

test('concurrent acquisitions share a master, isolate palettes, and dispose exact owners once', { timeout: 5000 }, async () => {
  const source = template(), calls = [];
  const masterDisposals = observe([source.geometry, source.fabric, source.metal, source.texture]);
  const library = createRoomAssetLibrary({ baseUrl: '/room-studio/', loadGLTF: async (url) => { calls.push(url); return source; } });
  const [warm, walnut] = await Promise.all([
    library.acquire('seoul-sofa'), library.acquire('seoul-sofa', { materialId: 'walnut' }),
  ]);
  assert.deepEqual(calls, ['/room-studio/assets/room-studio/models/seoul-sofa.glb']);
  assert.notEqual(warm.object, walnut.object);
  assert.equal(warm.object.children[0].geometry, walnut.object.children[0].geometry);
  const a = warm.object.children[0].material, b = walnut.object.children[0].material;
  assert.notEqual(a, b); assert.equal(a.map, b.map);
  assert.notEqual(a.color.getHex(), b.color.getHex());
  assert.equal(warm.object.children[1].material.color.getHex(), walnut.object.children[1].material.color.getHex());
  assert.equal(walnut.object.children[1].material.metalness, 0.72);
  assert.equal(source.fabric.color.getHexString(), 'c4b8a4');
  assert.ok(warm.object.children.every((mesh) => mesh.userData.roomAssetOwned));
  const clones = observe([...warm.object.children, ...walnut.object.children].map((mesh) => mesh.material));
  const scene = new Group(); scene.add(warm.object, walnut.object);
  warm.release(); warm.release();
  assert.equal(warm.object.parent, null);
  assert.ok([...masterDisposals.values()].every((count) => count === 0));
  library.dispose(); library.dispose(); walnut.release();
  assert.equal(scene.children.length, 0);
  assert.ok([...masterDisposals.values()].every((count) => count === 1));
  assert.ok([...clones.values()].every((count) => count === 1));
  await assert.rejects(library.acquire('seoul-sofa'), /disposed/);
});

test('disposal during an exact pending load releases eventual resources, never creates an instance', { timeout: 5000 }, async () => {
  const pending = Promise.withResolvers(), started = Promise.withResolvers();
  const source = template();
  const disposals = observe([source.geometry, source.fabric, source.metal, source.texture]);
  const library = createRoomAssetLibrary({ loadGLTF: () => { started.resolve(); return pending.promise; } });
  const rejection = assert.rejects(library.acquire('seoul-sofa'), /disposed/);
  await started.promise;
  library.dispose();
  pending.resolve(source);
  await rejection;
  assert.ok([...disposals.values()].every((count) => count === 1));
});

test('failed loads reject and can be explicitly retried; unsafe IDs never reach transport', { timeout: 5000 }, async () => {
  let calls = 0;
  const library = createRoomAssetLibrary({ loadGLTF: async () => { if (++calls === 1) throw new Error('network unavailable'); return template(); } });
  await assert.rejects(library.acquire('https://bad.example/evil.glb'), /Unknown room asset/);
  await assert.rejects(library.acquire('seoul-sofa', { materialId: 'unknown' }), /Unknown furniture palette/);
  assert.equal(calls, 0);
  await assert.rejects(library.acquire('seoul-sofa'), /network unavailable/);
  const handle = await library.acquire('seoul-sofa');
  assert.equal(calls, 2);
  handle.release(); library.dispose();
});

test('surface instances share source images but isolate repeat transforms and clean every texture', { timeout: 5000 }, async () => {
  const sources = [], calls = [];
  const library = createRoomAssetLibrary({ loadTexture: async (url) => {
    calls.push(url); const texture = new Texture({ width: 256, height: 256 }); sources.push(texture); return texture;
  } });
  const [first, second] = await Promise.all([
    library.acquireSurface('oak-natural', { repeat: [2, 3] }),
    library.acquireSurface('walnut-smoked', { repeat: [4, 5] }),
  ]);
  assert.equal(calls.length, 3);
  assert.notEqual(first.material.map, second.material.map);
  assert.equal(first.material.map.source, second.material.map.source);
  assert.deepEqual(first.material.map.repeat.toArray(), [2, 3]);
  assert.deepEqual(second.material.map.repeat.toArray(), [4, 5]);
  const resources = observe([...sources, first.material, second.material, ...[first, second].flatMap(({ material }) => [material.map, material.normalMap, material.roughnessMap])]);
  first.release(); library.dispose(); second.release(); library.dispose();
  assert.ok([...resources.values()].every((count) => count === 1));
});

test('surface image completions after close reject and dispose without timing waits', { timeout: 5000 }, async () => {
  const requests = [], started = Promise.withResolvers();
  const library = createRoomAssetLibrary({ loadTexture: () => {
    const pending = Promise.withResolvers(); requests.push(pending);
    if (requests.length === 3) started.resolve();
    return pending.promise;
  } });
  const rejection = assert.rejects(library.acquireSurface('tile-ivory'), /disposed/);
  await started.promise;
  library.dispose();
  const sources = requests.map(() => new Texture());
  const disposals = observe(sources);
  requests.forEach((pending, i) => pending.resolve(sources[i]));
  await rejection;
  assert.ok([...disposals.values()].every((count) => count === 1));
});
