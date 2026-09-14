import { assetById, materialById } from './asset-library.js';

export function normalizeItemAppearance(item) {
  if (!assetById(item.assetId)) return {};
  const appearance = { assetId: item.assetId };
  if (materialById(item.materialId)?.kind === 'palette') appearance.materialId = item.materialId;
  return appearance;
}

export function normalizeZoneAppearance(zone) {
  const appearance = {};
  for (const [field, usage] of [['floorMaterialId', 'floor'], ['wallMaterialId', 'wall']]) {
    const material = materialById(zone[field]);
    if (material?.kind === 'surface' && material.usage.includes(usage)) appearance[field] = material.id;
  }
  return appearance;
}
