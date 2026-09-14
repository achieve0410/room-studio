import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ROOM_ASSETS, ROOM_MATERIALS, roomAssetUrl } from '../src/asset-library.js';
import { createAssetGeometry } from '../scripts/build-room-assets-geometry.mjs';
import { webpDimensions } from './webp-dimensions.js';

const root = new URL('../public/assets/room-studio/', import.meta.url);
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

test('browser thumbnails keep full resolution in smaller WebP companions', async () => {
  for (const asset of ROOM_ASSETS) {
    assert.equal(typeof asset.thumbnailWebpPath, 'string');
    const original = await readFile(new URL(asset.thumbnailPath, root));
    const optimized = await readFile(new URL(asset.thumbnailWebpPath, root));
    assert.equal(optimized.toString('ascii', 0, 4), 'RIFF');
    assert.equal(optimized.toString('ascii', 8, 12), 'WEBP');
    assert.deepEqual(webpDimensions(optimized), { width: 512, height: 512 });
    assert.ok(optimized.length > 1000 && optimized.length < original.length);
    assert.ok(roomAssetUrl(asset.thumbnailWebpPath).startsWith('./assets/room-studio/'));
  }
});

test('shipped manifest, original source provenance, and all PBR maps are complete and consistent', async () => {
  const manifest = await json('manifest.json'), provenance = await json('PROVENANCE.json');
  assert.equal(manifest.assets.length, 12);
  assert.deepEqual(manifest.materials, ROOM_MATERIALS);
  assert.equal(provenance.license, 'Apache-2.0');
  assert.deepEqual(provenance.externalAssets, []);
  assert.deepEqual(provenance.externalImages, []);
  for (const source of provenance.sources) assert.equal(sha256(await readFile(new URL(`../${source.path}`, import.meta.url))), source.sha256, source.path);
  assert.equal((await readFile(new URL(provenance.sourceLicense, root))).length > 10000, true);
  assert.equal(manifest.textures.length, 15);
  for (const texture of manifest.textures) {
    const file = await readFile(new URL(texture.path, root));
    assert.equal(sha256(file), texture.sha256);
    assert.equal(file.length, texture.bytes);
    assert.deepEqual([...file.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(file.readUInt32BE(16), texture.width);
    assert.equal(file.readUInt32BE(20), texture.height);
    assert.ok(roomAssetUrl(texture.path).startsWith('./assets/room-studio/'));
  }
  assert.ok(manifest.totals.modelBytes < 4_000_000, 'mobile-sized model budget');
  assert.ok(manifest.totals.textureBytes < 1_000_000, 'shared PBR image budget');
});

for (const asset of ROOM_ASSETS) test(`${asset.id}: real indexed GLB geometry has finite meter bounds, declared slots, details and a rendered thumbnail`, async () => {
  const file = await readFile(new URL(asset.modelPath, root));
  const manifest = await json('manifest.json');
  const descriptor = manifest.assets.find(({ id }) => id === asset.id);
  assert.equal(sha256(file), descriptor.sha256);
  assert.equal(file.readUInt32LE(0), 0x46546c67);
  assert.equal(file.readUInt32LE(4), 2);
  assert.equal(file.readUInt32LE(8), file.length);
  const jsonLength = file.readUInt32LE(12);
  const gltf = JSON.parse(file.subarray(20, 20 + jsonLength).toString());
  assert.equal(gltf.extras.id, asset.id);
  assert.equal(gltf.extras.units, 'm');
  assert.deepEqual(gltf.extras.dimensions, asset.dimensions);
  assert.deepEqual(gltf.materials.map(({ name }) => name).sort(), [...asset.materialSlots].sort());
  assert.ok(descriptor.components >= 3, 'authored joinery/upholstery/components, not a proxy box');
  const binStart = 28 + jsonLength;
  let triangles = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) {
    const accessor = gltf.accessors[primitive.attributes.POSITION];
    const view = gltf.bufferViews[accessor.bufferView];
    assert.equal(accessor.componentType, 5126);
    for (let vertex = 0; vertex < accessor.count; vertex++) for (let axis = 0; axis < 3; axis++) {
      const value = file.readFloatLE(binStart + view.byteOffset + vertex * 12 + axis * 4);
      assert.ok(Number.isFinite(value)); min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
    }
    const indices = gltf.accessors[primitive.indices], indexView = gltf.bufferViews[indices.bufferView];
    const bytes = indices.componentType === 5125 ? 4 : 2;
    for (let i = 0; i < indices.count; i++) {
      const offset = binStart + indexView.byteOffset + i * bytes;
      assert.ok((bytes === 4 ? file.readUInt32LE(offset) : file.readUInt16LE(offset)) < accessor.count);
    }
    triangles += indices.count / 3;
  }
  assert.equal(triangles, descriptor.triangles);
  const size = [asset.dimensions.width, asset.dimensions.height, asset.dimensions.depth];
  size.forEach((value, axis) => assert.ok(Math.abs(max[axis] - min[axis] - value) < 1e-6));
  assert.ok(Math.abs(min[1]) < 1e-6);
  for (const axis of [0, 2]) assert.ok(Math.abs(min[axis] + max[axis]) < 1e-6);
  for (const image of gltf.images) {
    const imagePath = new URL(image.uri, new URL(asset.modelPath, root));
    assert.ok(imagePath.href.startsWith(root.href));
    assert.ok((await readFile(imagePath)).length > 100);
  }
  const thumb = await readFile(new URL(asset.thumbnailPath, root));
  assert.equal(thumb.readUInt32BE(16), 512); assert.equal(thumb.readUInt32BE(20), 512);
  // Rebuilding geometry itself is deterministic and browser-free; compare actual shipped coordinates.
  const rebuilt = createAssetGeometry(asset);
  for (const part of rebuilt) {
    const mesh = gltf.meshes.find((entry) => entry.name === `${asset.id}-${part.slot}`);
    const accessor = gltf.accessors[mesh.primitives[0].attributes.POSITION], view = gltf.bufferViews[accessor.bufferView];
    assert.deepEqual(Buffer.from(part.geometry.attributes.position.array.buffer), file.subarray(binStart + view.byteOffset, binStart + view.byteOffset + view.byteLength));
    part.geometry.dispose();
  }
});
