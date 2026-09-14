import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import originalLayouts from '../src/regional-demo-layouts.js';
import { REGIONAL_DEMO_LAYOUTS, demoLayoutById } from '../src/demo-layouts.js';
import { createComparisonOption, switchConsultationOption } from '../src/consultation.js';
import { parseProjectFile, serializeProjectFile } from '../src/project-file.js';
import { webpDimensions } from './webp-dimensions.js';

test('the three Seoul examples use distinct reusable furniture and surface finishes', () => {
  // Given the three existing, attributed Seoul apartment reference plans
  assert.equal(REGIONAL_DEMO_LAYOUTS.length, 3);
  const styles = new Set();
  for (const original of originalLayouts) {
    // When the editable catalog example is opened
    const example = demoLayoutById(original.id);
    styles.add(example.assetStyle.id);

    // Then it contains editable models and finishes, without changing the plan
    assert.ok(example.items.filter((item) => item.assetId).length >= 5, original.id);
    assert.ok(example.zones.every((zone) => zone.floorMaterialId && zone.wallMaterialId), original.id);
    assert.deepEqual(example.structures, original.structures);
    assert.deepEqual(example.dimensions, original.dimensions);
    assert.deepEqual(example.source, original.source);
    assert.deepEqual(
      example.zones.map(({ floorMaterialId, wallMaterialId, ...zone }) => zone),
      original.zones,
    );
  }
  assert.equal(styles.size, 3);
});

test('sample model and material choices remain independent across A/B and portable files', () => {
  // Given a styled reference with a second comparison option
  const example = demoLayoutById(originalLayouts[0].id);
  const layout = createComparisonOption(example);
  const originalMaterial = layout.items.find((item) => item.assetId).materialId;
  const otherMaterial = demoLayoutById(originalLayouts[1].id).items.find((item) => item.assetId).materialId;
  assert.notEqual(originalMaterial, otherMaterial);

  // When A changes and the two-option file is exported and imported
  layout.items.find((item) => item.assetId).materialId = otherMaterial;
  const imported = parseProjectFile(serializeProjectFile({ projectName: example.name, layout })).layout;
  const alternative = switchConsultationOption(imported, 'B');

  // Then asset references persist and B keeps the original appearance
  assert.equal(imported.items.find((item) => item.assetId).materialId, otherMaterial);
  assert.equal(alternative.items.find((item) => item.assetId).materialId, originalMaterial);
  assert.equal(imported.zones[0].floorMaterialId, example.zones[0].floorMaterialId);
  assert.equal(imported.zones[0].wallMaterialId, example.zones[0].wallMaterialId);
  assert.equal(JSON.stringify(imported).includes('.glb'), false);
});

test('Seoul cover previews ship real smaller WebP files at responsive widths', async () => {
  const directory = new URL('../public/assets/seoul-examples/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  for (const example of manifest.examples) {
    const image = example.images.find(image => image.mode === 'dollhouse');
    assert.deepEqual(image.previews?.map(preview => preview.width), [160, 320, 640]);
    for (const preview of image.previews) {
      assert.equal(preview.filename, image.filename.replace('.webp', `-${preview.width}.webp`));
      const bytes = await readFile(new URL(preview.filename, directory));
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
      assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
      const { width, height } = webpDimensions(bytes);
      assert.equal(width, preview.width);
      assert.equal(height, preview.height);
      assert.ok(Math.abs(height - image.height * width / image.width) <= 1);
      assert.equal(bytes.length, preview.bytes);
      assert.ok(bytes.length < image.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), preview.sha256);
    }
  }
});
