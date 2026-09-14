import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItemAppearance, normalizeZoneAppearance } from '../src/appearance.js';

test('legacy entities keep their original appearance unless an asset is explicitly selected', () => {
  const item = { type: 'sofa', color: '#102030' };
  const zone = { type: '방', color: '#203040' };
  assert.deepEqual(normalizeItemAppearance(item), {});
  assert.deepEqual(normalizeZoneAppearance(zone), {});
  assert.deepEqual(item, { type: 'sofa', color: '#102030' });
});

test('persisted appearance accepts only registered models and appropriate material kinds', () => {
  assert.deepEqual(
    normalizeItemAppearance({ assetId: 'seoul-sofa', materialId: 'walnut' }),
    { assetId: 'seoul-sofa', materialId: 'walnut' },
  );
  assert.deepEqual(
    normalizeZoneAppearance({ floorMaterialId: 'oak-pale', wallMaterialId: 'plaster-chalk' }),
    { floorMaterialId: 'oak-pale', wallMaterialId: 'plaster-chalk' },
  );
  assert.deepEqual(normalizeItemAppearance({ assetId: 'https://example.com/model.glb', materialId: 'walnut' }), {});
  assert.deepEqual(normalizeItemAppearance({ assetId: 'seoul-sofa', materialId: 'tile-ivory' }), { assetId: 'seoul-sofa' });
  assert.deepEqual(normalizeZoneAppearance({ floorMaterialId: 'plaster-warm', wallMaterialId: 'walnut' }), {});
});
