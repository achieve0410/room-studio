import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOM_ASSETS, ROOM_MATERIALS, assetById, assetForItem, materialById, roomAssetUrl } from '../src/asset-library.js';

test('stable reusable pack covers furniture and rejects untrusted IDs/URLs', () => {
  const categories = ['sofa', 'bed', 'dining-table', 'dining-chair', 'desk', 'coffee-table', 'side-table', 'wardrobe', 'tv-console', 'plant', 'floor-lamp', 'rug'];
  assert.deepEqual(ROOM_ASSETS.map(asset => asset.category), categories);
  for (const asset of ROOM_ASSETS) {
    assert.equal(assetById(asset.id), asset);
    assert.ok(Object.isFrozen(asset.dimensions));
    for (const value of Object.values(asset.dimensions)) assert.ok(value > 0 && value < 4);
    assert.ok(asset.materialSlots.includes(asset.primarySlot));
    assert.equal(roomAssetUrl(asset.modelPath, '/room-studio/'), `/room-studio/assets/room-studio/${asset.modelPath}`);
  }
  for (const id of ['warm-oak', 'walnut', 'soft-modern']) assert.ok(materialById(id));
  assert.ok(ROOM_MATERIALS.every(entry => Object.isFrozen(entry)));
  for (const id of ['__proto__', 'constructor', 'https://evil.example/model.glb']) {
    assert.equal(assetById(id), null);
    assert.equal(materialById(id), null);
  }
  for (const path of ['../escape.glb', '/escape.glb', 'https://evil.example/model.glb', 'models/missing.glb']) {
    assert.throws(() => roomAssetUrl(path), /Unknown asset path/);
  }
  assert.equal(assetForItem({ type: 'sofa' }).id, 'seoul-sofa');
  assert.equal(assetForItem({ type: 'table', height: 40 }).id, 'seoul-coffee-table');
  assert.equal(assetForItem({ type: 'sofa', assetId: 'unknown' }), null);
  assert.equal(assetForItem({ type: 'kitchenSink' }), null);
  assert.equal(roomAssetUrl('manifest.json', ''), './assets/room-studio/manifest.json');
  for (const base of ['https://remote.example/', '//remote.example/', '../', '/%2e%2e/', '/bad\\path/', '/path?query']) {
    assert.throws(() => roomAssetUrl('manifest.json', base), /same-origin directory/);
  }
});
