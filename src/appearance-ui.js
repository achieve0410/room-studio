import { ROOM_MATERIALS, assetById, roomAssetUrl } from './asset-library.js';

export function renderAssetPreview(template) {
  const asset = assetById(template.assetId);
  if (!asset) return `<i class="shape-${template.shape}" style="--item:${template.color}"></i>`;
  return `<img class="asset-preview" src="${roomAssetUrl(asset.thumbnailWebpPath)}" alt="" width="96" height="96" loading="lazy" decoding="async">`;
}

export function renderMaterialControls(entity, kind) {
  if (kind === 'item' && !assetById(entity.assetId)) return '';
  const fields = kind === 'item'
    ? [['materialId', '가구 마감', 'palette']]
    : [['floorMaterialId', '바닥 마감', 'floor'], ['wallMaterialId', '벽 마감', 'wall']];
  return `<div class="appearance-controls">${fields.map(([field, label, usage]) => {
    const materials = ROOM_MATERIALS.filter((material) => usage === 'palette'
      ? material.kind === 'palette' : material.usage?.includes(usage));
    return `<div class="appearance-group" role="group" aria-label="${label}">
      <p class="appearance-label">${label}</p>
      <div class="appearance-swatches">${materials.map((material) => `<button
        type="button" data-appearance-field="${field}" data-appearance-value="${material.id}"
        aria-pressed="${entity[field] === material.id}" title="${material.name}">
        <span class="appearance-swatch" style="--swatch:${material.color}" aria-hidden="true"></span>
        <span>${material.name}</span>
      </button>`).join('')}</div>
      ${entity[field] ? `<button class="appearance-reset" type="button" data-appearance-field="${field}" data-appearance-value="">기존 색상으로</button>` : ''}
    </div>`;
  }).join('')}</div>`;
}
