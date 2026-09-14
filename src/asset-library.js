const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

const asset = (category, name, size, primarySlot, materialSlots, legacyTypes) => ({
  id: `seoul-${category}`, name, category,
  dimensions: { width: size[0], depth: size[1], height: size[2] },
  modelPath: `models/seoul-${category}.glb`,
  thumbnailPath: `thumbnails/seoul-${category}.png`,
  thumbnailWebpPath: `thumbnails/seoul-${category}.webp`,
  primarySlot, materialSlots, legacyTypes,
  units: 'm', origin: 'bottom-center', front: '+Z', license: 'Apache-2.0',
});

export const ROOM_ASSETS = freeze([
  asset('sofa', '한강 모듈 소파', [2.2, 0.94, 0.84], 'fabric', ['fabric', 'piping', 'wood', 'accent'], ['sofa']),
  asset('bed', '여백 패널 침대', [1.6, 2.15, 1.04], 'fabric', ['wood', 'fabric', 'linen', 'piping'], ['bed']),
  asset('dining-table', '결 라운드 식탁', [1.65, 0.9, 0.75], 'wood', ['wood', 'metal'], ['table']),
  asset('dining-chair', '호 곡목 의자', [0.52, 0.55, 0.79], 'fabric', ['wood', 'fabric', 'metal'], ['chair']),
  asset('desk', '선 서랍 책상', [1.25, 0.62, 0.76], 'wood', ['wood', 'metal', 'primary'], ['desk']),
  asset('coffee-table', '조약돌 소파 테이블', [1.12, 0.66, 0.36], 'wood', ['wood', 'primary'], []),
  asset('side-table', '소반 사이드 테이블', [0.46, 0.46, 0.48], 'wood', ['wood', 'metal'], []),
  asset('wardrobe', '결 프레임 옷장', [1.5, 0.6, 2.1], 'wood', ['wood', 'primary', 'metal'], ['wardrobe', 'cabinet']),
  asset('tv-console', '살 미디어 장', [1.8, 0.42, 0.48], 'wood', ['wood', 'primary', 'metal', 'linen'], ['tv']),
  asset('plant', '잎 세라믹 화분', [0.68, 0.68, 1.15], 'primary', ['primary', 'foliage', 'stem', 'soil'], ['plant']),
  asset('floor-lamp', '주름 플로어 조명', [0.48, 0.48, 1.5], 'primary', ['primary', 'metal', 'linen', 'light'], ['lamp']),
  asset('rug', '고요 직조 러그', [2.1, 1.5, 0.018], 'fabric', ['fabric', 'piping', 'accent'], ['rug']),
]);

const surface = (id, name, texture, color, roughness, tileSize, usage) => ({
  id, name, kind: 'surface', color, roughness, tileSize, usage,
  ...(texture ? {
    texturePath: `textures/${texture}-color.png`,
    normalPath: `textures/${texture}-normal.png`,
    roughnessPath: `textures/${texture}-roughness.png`,
  } : {}),
});

export const ROOM_MATERIALS = freeze([
  { id: 'warm-oak', name: '웜 오크', kind: 'palette', color: '#b79a75', slots: { wood: '#c8a777', fabric: '#c4b8a4', primary: '#d0b79b' } },
  { id: 'walnut', name: '월넛', kind: 'palette', color: '#71513d', slots: { wood: '#78523a', fabric: '#909c90', primary: '#9a7760' } },
  { id: 'soft-modern', name: '소프트 모던', kind: 'palette', color: '#d0cec5', slots: { wood: '#d2c3a7', fabric: '#dedbd2', primary: '#b6b8b3' } },
  surface('oak-natural', '내추럴 오크', 'oak', '#c9ab82', 0.63, [1.8, 1.8], ['floor']),
  surface('walnut-smoked', '스모크 월넛', 'oak', '#76533b', 0.61, [1.8, 1.8], ['floor']),
  surface('oak-pale', '페일 오크', 'oak', '#d6c8ac', 0.68, [1.8, 1.8], ['floor']),
  surface('tile-ivory', '아이보리 석재 타일', 'tile', '#d8d4ca', 0.74, [1.2, 1.2], ['floor', 'wall']),
  surface('tile-slate', '슬레이트 타일', 'tile', '#8b9494', 0.77, [1.2, 1.2], ['floor', 'wall']),
  surface('plaster-warm', '웜 미장', 'plaster', '#e7dfd1', 0.94, [2, 2], ['wall']),
  surface('plaster-chalk', '초크 미장', 'plaster', '#eeeae2', 0.96, [2, 2], ['wall']),
]);

export const LEGACY_ASSET_COMPATIBILITY = freeze({
  kitchenSink: 'procedural-kitchen', kitchenIsland: 'procedural-kitchen',
  toilet: 'procedural-plumbing', washbasin: 'procedural-plumbing',
  laundryTower: 'procedural-appliance', clothesRackSingle: 'procedural-rack',
  clothesRackDoubleRow: 'procedural-rack', clothesRackDoubleTier: 'procedural-rack',
});

const assets = new Map(ROOM_ASSETS.map((entry) => [entry.id, entry]));
const materials = new Map(ROOM_MATERIALS.map((entry) => [entry.id, entry]));
const paths = new Set([
  'manifest.json', 'PROVENANCE.json', 'LICENSE.txt', 'THREE-LICENSE.txt',
  ...ROOM_ASSETS.flatMap(({ modelPath, thumbnailPath, thumbnailWebpPath }) => [modelPath, thumbnailPath, thumbnailWebpPath]),
  ...['wood', 'fabric', 'oak', 'tile', 'plaster'].flatMap((name) => ['color', 'normal', 'roughness'].map((kind) => `textures/${name}-${kind}.png`)),
]);

export const assetById = (id) => assets.get(id) ?? null;
export const materialById = (id) => materials.get(id) ?? null;

export function assetForItem(item) {
  if (item.assetId != null) return assetById(item.assetId);
  if (item.type === 'table' && item.height < 55) {
    return assetById(item.width < 65 ? 'seoul-side-table' : 'seoul-coffee-table');
  }
  return ROOM_ASSETS.find(({ legacyTypes }) => legacyTypes.includes(item.type)) ?? null;
}

export function roomAssetUrl(path, baseUrl = import.meta.env?.BASE_URL ?? './') {
  if (!paths.has(path)) throw new Error(`Unknown asset path: ${path}`);
  // A local base is configuration, not an arbitrary remote asset host.
  if (typeof baseUrl !== 'string' || /[\s%\\?#:]/.test(baseUrl) || baseUrl.startsWith('//') || baseUrl.split('/').includes('..')) {
    throw new Error('Asset base must be a same-origin directory path');
  }
  const base = baseUrl === '' ? './' : baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}assets/room-studio/${path}`;
}
