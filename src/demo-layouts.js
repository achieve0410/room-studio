const DATASET_URL = 'https://www.data.go.kr/data/15037046/fileData.do';
const CATALOG_URL = 'https://www.data.go.kr/catalog/15037046/fileData.json';

function deepFreeze(value) {
  Object.values(value).forEach((child) => {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  });
  return Object.freeze(value);
}

const zone = (id, name, type, x, y, width, depth, color) => ({
  id, name, type, x, y, width, depth, height: 240, color,
});
const item = (id, name, type, x, y, width, depth, height, color, rotation = 0) => ({
  id, name, type, shape: 'roundRect', x, y, width, depth, height, elevation: 0, rotation, color,
});
const door = (id, x, y, orientation = 'horizontal') => ({
  id, type: 'door', name: '문', x, y, width: 90, height: 205, orientation,
  doorType: 'swing', hinge: 'start', openSide: -1, openAngle: 0, slideDirection: 'end', openRatio: 0,
});
const windowOpening = (id, x, y, width, orientation = 'horizontal') => ({
  id, type: 'window', name: '창', x, y, width, height: 120, sillHeight: 90,
  orientation, slideDirection: 'end', openRatio: 0,
});
const dimension = (id, name, x1, y1, x2, y2) => ({ id, name, x1, y1, x2, y2, locked: true });
const source = (archiveEntry, supplyAreaSquareMeters) => ({
  datasetUrl: DATASET_URL,
  catalogUrl: CATALOG_URL,
  archiveFileId: 'FILE_000000003519063',
  fileDetailSn: '1',
  archiveEntry,
  supplyAreaSquareMeters,
  license: '이용허락범위 제한 없음',
  attribution: '한국토지주택공사(LH), 주택 평면도 현황',
  adaptationNotice: '원본 평면도 기록의 면적 유형을 바탕으로 Room Studio용 가구 배치 예시를 새로 재구성했으며 원본 이미지를 포함하지 않습니다.',
});

const compact = {
  id: 'lh-compact-37', name: '37㎡ 컴팩트 모델 홈', typology: 'compact', wallHeight: 240,
  zones: [
    zone('c-zone-living', '거실 겸 주방', '거실', 0, 0, 520, 280, '#d9d2c2'),
    zone('c-zone-bedroom', '침실', '방', 0, 280, 300, 260, '#c9b8a6'),
    zone('c-zone-bath', '욕실', '욕실', 300, 280, 220, 260, '#aebfc4'),
  ],
  items: [
    item('c-item-sofa', '소파', 'sofa', 145, 90, 160, 80, 80, '#7f9884'),
    item('c-item-table', '식탁', 'table', 405, 150, 100, 70, 74, '#b78d65'),
    item('c-item-bed', '침대', 'bed', 145, 405, 140, 200, 55, '#b8a7a0'),
  ],
  structures: [door('c-door-entry', 430, 540), windowOpening('c-window-living', 165, 0, 180)],
  dimensions: [dimension('c-dim-width', '전체 폭', 0, -25, 520, -25), dimension('c-dim-depth', '전체 깊이', -25, 0, -25, 540)],
  backgroundPlan: null,
  source: source('부산울산본부_부산전포(06,주1)_01BL/(평면)전포지구-오피스37-1112.json', 37),
};

const commonFamily = {
  id: 'lh-family-84a', name: '84㎡ 패밀리 모델 홈', typology: 'common-family', wallHeight: 240,
  zones: [
    zone('m-zone-living', '거실', '거실', 0, 0, 430, 310, '#d9d2c2'),
    zone('m-zone-kitchen', '주방', '주방', 430, 0, 270, 310, '#d8c6a1'),
    zone('m-zone-main', '안방', '방', 0, 310, 280, 290, '#c9b8a6'),
    zone('m-zone-room2', '방 2', '방', 280, 310, 210, 290, '#b9c6b4'),
    zone('m-zone-bath', '욕실', '욕실', 490, 310, 210, 290, '#aebfc4'),
  ],
  items: [
    item('m-item-sofa', '소파', 'sofa', 160, 120, 210, 90, 85, '#7f9884'),
    item('m-item-table', '식탁', 'table', 560, 155, 150, 85, 74, '#b78d65'),
    item('m-item-bed', '침대', 'bed', 135, 445, 160, 210, 55, '#b8a7a0'),
    item('m-item-desk', '책상', 'desk', 380, 430, 110, 55, 75, '#a98465'),
  ],
  structures: [door('m-door-entry', 610, 600), windowOpening('m-window-living', 170, 0, 220), windowOpening('m-window-main', 100, 600, 150)],
  dimensions: [dimension('m-dim-width', '전체 폭', 0, -25, 700, -25), dimension('m-dim-depth', '전체 깊이', -25, 0, -25, 600)],
  backgroundPlan: null,
  source: source('서울본부_양주회천_A18/양주회천18bl-84A.json', 84),
};

const largerFamily = {
  id: 'lh-family-114a', name: '114㎡ 라지 패밀리 모델 홈', typology: 'larger-family', wallHeight: 250,
  zones: [
    zone('l-zone-living', '거실', '거실', 0, 0, 500, 350, '#d9d2c2'),
    zone('l-zone-kitchen', '주방', '주방', 500, 0, 320, 350, '#d8c6a1'),
    zone('l-zone-main', '안방', '방', 0, 350, 300, 320, '#c9b8a6'),
    zone('l-zone-room2', '방 2', '방', 300, 350, 260, 320, '#b9c6b4'),
    zone('l-zone-room3', '방 3', '방', 560, 350, 260, 320, '#c5b8cd'),
  ],
  items: [
    item('l-item-sofa', '소파', 'sofa', 190, 130, 240, 95, 85, '#7f9884'),
    item('l-item-table', '식탁', 'table', 655, 175, 180, 90, 74, '#b78d65'),
    item('l-item-bed', '침대', 'bed', 145, 500, 180, 220, 55, '#b8a7a0'),
    item('l-item-desk', '책상', 'desk', 420, 490, 120, 60, 75, '#a98465'),
    item('l-item-storage', '수납장', 'wardrobe', 690, 485, 140, 45, 180, '#9c826b'),
  ],
  structures: [door('l-door-entry', 730, 670), windowOpening('l-window-living', 190, 0, 250), windowOpening('l-window-main', 105, 670, 170), windowOpening('l-window-room3', 625, 670, 150)],
  dimensions: [dimension('l-dim-width', '전체 폭', 0, -25, 820, -25), dimension('l-dim-depth', '전체 깊이', -25, 0, -25, 670)],
  backgroundPlan: null,
  source: source('부산울산본부_부산만덕5(06,주환1)_01BL/11.114A-평면-01.json', 114),
};

export const DEMO_LAYOUTS = deepFreeze([compact, commonFamily, largerFamily]);

export function demoLayoutById(id) {
  const layout = DEMO_LAYOUTS.find((candidate) => candidate.id === id);
  return layout ? structuredClone(layout) : null;
}
