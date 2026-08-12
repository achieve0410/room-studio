import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_LAYOUTS, demoLayoutById } from '../src/demo-layouts.js';

const DATASET_URL = 'https://www.data.go.kr/data/15037046/fileData.do';
const CATALOG_URL = 'https://www.data.go.kr/catalog/15037046/fileData.json';
const LICENSE = '이용허락범위 제한 없음';
const entities = (layout) => [...layout.zones, ...layout.items, ...layout.structures, ...layout.dimensions];
const FURNITURE_TYPES = new Set(['bed', 'sofa', 'desk', 'table', 'rug', 'wardrobe', 'shelf', 'rack']);

test('ships three immutable, distinct LH model-home adaptations', () => {
  assert.equal(DEMO_LAYOUTS.length, 3);
  assert.ok(Object.isFrozen(DEMO_LAYOUTS));
  assert.deepEqual(DEMO_LAYOUTS.map(({ typology }) => typology).sort(), ['common-family', 'compact', 'larger-family']);
  assert.equal(new Set(DEMO_LAYOUTS.map(({ id }) => id)).size, 3);
  assert.equal(new Set(DEMO_LAYOUTS.map(({ source }) => source.archiveEntry)).size, 3);
  assert.equal(new Set(DEMO_LAYOUTS.map(({ source }) => source.supplyAreaSquareMeters)).size, 3);
  for (const fixture of DEMO_LAYOUTS) {
    assert.ok(Object.isFrozen(fixture));
    assert.equal(fixture.backgroundPlan, null);
    assert.ok(Number.isFinite(fixture.wallHeight) && fixture.wallHeight > 0);
    for (const key of ['zones', 'items', 'structures', 'dimensions']) {
      assert.ok(Array.isArray(fixture[key]) && fixture[key].length > 0, `${fixture.id}: ${key}`);
      assert.ok(Object.isFrozen(fixture[key]), `${fixture.id}: immutable ${key}`);
    }
    assert.ok(fixture.structures.some(({ type }) => type === 'door'));
    assert.ok(fixture.structures.some(({ type }) => type === 'window'));
    assert.ok(fixture.items.some(({ name }) => name === '침대'));
    assert.ok(fixture.items.some(({ name }) => name === '소파'));
    assert.ok(fixture.items.some(({ name }) => name === '식탁'));
    const ids = entities(fixture).map(({ id }) => id);
    assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0));
    assert.equal(new Set(ids).size, ids.length, `${fixture.id}: globally unique entity IDs`);
    for (const zone of fixture.zones) {
      assert.ok(zone.name && zone.type);
      assert.ok([zone.x, zone.y, zone.width, zone.depth].every(Number.isFinite));
      assert.ok(zone.width > 0 && zone.depth > 0);
    }
    for (const item of fixture.items) {
      assert.ok(FURNITURE_TYPES.has(item.type), `${fixture.id}: supported item type for ${item.id}`);
      assert.ok([item.x, item.y, item.width, item.depth, item.height].every(Number.isFinite));
      assert.ok(item.width > 0 && item.depth > 0 && item.height > 0);
    }
    for (const dimension of fixture.dimensions) {
      assert.ok([dimension.x1, dimension.y1, dimension.x2, dimension.y2].every(Number.isFinite));
      assert.notDeepEqual([dimension.x1, dimension.y1], [dimension.x2, dimension.y2]);
    }
  }
});

test('contains attributable unrestricted source metadata without sensitive or copied data', () => {
  for (const { source } of DEMO_LAYOUTS) {
    assert.equal(source.datasetUrl, DATASET_URL);
    assert.equal(source.catalogUrl, CATALOG_URL);
    assert.equal(source.archiveFileId, 'FILE_000000003519063');
    assert.equal(source.fileDetailSn, '1');
    assert.equal(source.license, LICENSE);
    assert.match(source.attribution, /한국토지주택공사/);
    assert.match(source.adaptationNotice, /재구성|adapt/i);
    assert.match(source.archiveEntry, /\.json$/);
    assert.ok(Number.isFinite(source.supplyAreaSquareMeters));
    const serialized = JSON.stringify(source);
    assert.doesNotMatch(serialized, /(?:data:image|base64|https?:\/\/(?:s3|storage|supabase)|\b(?:address|주소|resident|주민|brand|브랜드)\b)/i);
    assert.ok(!Object.keys(source).some((key) => /address|resident|brand|cloud/i.test(key)));
  }
});

test('lookup returns a deep clone and cannot mutate canonical fixtures', () => {
  assert.equal(demoLayoutById('missing-layout'), null);
  const canonical = DEMO_LAYOUTS[0];
  const first = demoLayoutById(canonical.id);
  const second = demoLayoutById(canonical.id);
  assert.deepEqual(first, canonical);
  assert.notEqual(first, canonical);
  assert.notEqual(first.zones, canonical.zones);
  assert.notEqual(first.source, canonical.source);
  first.name = 'changed';
  first.zones[0].name = 'changed';
  first.source.attribution = 'changed';
  assert.deepEqual(second, canonical);
  assert.notEqual(canonical.name, 'changed');
});
