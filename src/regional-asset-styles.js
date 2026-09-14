import { assetById } from './asset-library.js';

const styles = {
  'daechi-palace-11224-public-reconstruction': {
    id: 'warm-oak',
    name: '오크와 린넨',
    description: '밝은 오크와 린넨으로 꾸민 가족의 거실',
    floor: 'oak-natural',
    wall: 'plaster-warm',
    color: '#c5ae8d',
    cover: 'daechi',
    additions: [
      ['chair-north', '다이닝 체어', 'chair', 'seoul-dining-chair', 570, 200, 45, 48, 80, 0],
      ['chair-south', '다이닝 체어', 'chair', 'seoul-dining-chair', 570, 360, 45, 48, 80, 180],
      ['coffee-table', '오크 소파 테이블', 'table', 'seoul-coffee-table', 560, 750, 90, 45, 38, 0],
      ['plant', '거실 화분', 'plant', 'seoul-plant', 335, 850, 40, 40, 110, 0],
    ],
  },
  'apgujeong-hyundai-35-estimated': {
    id: 'walnut',
    name: '차분한 월넛',
    description: '월넛 가구와 차분한 패브릭을 조합한 공간',
    floor: 'walnut-smoked',
    wall: 'plaster-warm',
    color: '#94735a',
    cover: 'apgujeong',
    additions: [
      ['chair-north', '다이닝 체어', 'chair', 'seoul-dining-chair', 540, 195, 44, 44, 80, 0],
      ['chair-south', '다이닝 체어', 'chair', 'seoul-dining-chair', 540, 330, 44, 44, 80, 180],
      ['coffee-table', '월넛 소파 테이블', 'table', 'seoul-coffee-table', 515, 645, 80, 45, 38, 0],
      ['plant', '거실 화분', 'plant', 'seoul-plant', 405, 745, 40, 40, 110, 0],
    ],
  },
  'dogok-rexle-111a': {
    id: 'soft-modern',
    name: '소프트 모던',
    description: '밝은 중성색과 부드러운 질감의 여유로운 거실',
    floor: 'oak-pale',
    wall: 'plaster-chalk',
    color: '#c7c6bd',
    cover: 'dogok',
    additions: [
      ['chair-north', '다이닝 체어', 'chair', 'seoul-dining-chair', 470, 275, 44, 44, 80, 0],
      ['chair-south', '다이닝 체어', 'chair', 'seoul-dining-chair', 470, 415, 44, 44, 80, 180],
      ['coffee-table', '라운드 소파 테이블', 'table', 'seoul-coffee-table', 625, 840, 85, 45, 38, 0],
      ['plant', '거실 화분', 'plant', 'seoul-plant', 845, 750, 40, 40, 110, 0],
    ],
  },
};

const models = {
  sofa: 'seoul-sofa',
  bed: 'seoul-bed',
  table: 'seoul-dining-table',
  desk: 'seoul-desk',
};

export function withRegionalAssets(original) {
  const layout = structuredClone(original);
  const style = styles[layout.id];
  layout.assetStyle = {
    id: style.id,
    name: style.name,
    description: style.description,
    cover: style.cover,
  };
  layout.zones = layout.zones.map((zone) => ({
    ...zone,
    floorMaterialId: zone.type === '욕실' || /balcony|laundry/.test(zone.id)
      ? 'tile-ivory' : style.floor,
    wallMaterialId: style.wall,
  }));
  layout.items = layout.items.map((item) => {
    const assetId = models[item.type];
    if (!assetId) return item;
    // Old regional sofas used a depth-long footprint. Rotate the model, not
    // the apartment: the occupied rectangle stays exactly where it was.
    const orientation = item.type === 'sofa' && item.depth > item.width
      ? { width: item.depth, depth: item.width, rotation: (item.rotation + 90) % 360 }
      : {};
    return {
      ...item, ...orientation, assetId, materialId: style.id, color: style.color,
      height: Math.round(assetById(assetId).dimensions.height * 100),
    };
  });
  layout.items.push(...style.additions.map(([suffix, name, type, assetId, x, y, width, depth, height, rotation]) => ({
    id: `${layout.id}-asset-${suffix}`,
    name, type, assetId, materialId: style.id,
    x, y, width, depth, height, rotation, elevation: 0,
    shape: 'roundRect',
    color: style.color,
  })));
  return layout;
}
