import regionalLayouts from './regional-demo-layouts.js';

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
const entranceZone = (...args) => ({ ...zone(...args), walkthroughStart: true });
const item = (id, name, type, x, y, width, depth, height, color, rotation = 0) => ({
  id, name, type, shape: 'roundRect', x, y, width, depth, height, elevation: 0, rotation, color,
});
const door = (id, name, x, y, orientation = 'horizontal', width = 90, openSide = -1) => ({
  id, type: 'door', name, x, y, width, height: 205, orientation,
  doorType: 'swing', hinge: 'start', openSide, openAngle: 90, slideDirection: 'end', openRatio: 0,
});
const entranceDoor = (...args) => ({ ...door(...args), exterior: true });
const windowOpening = (id, name, x, y, width, orientation = 'horizontal') => ({
  id, type: 'window', name, x, y, width, height: 120, sillHeight: 90,
  orientation, slideDirection: 'end', openRatio: 0,
});
const dimension = (id, name, x1, y1, x2, y2) => ({ id, name, x1, y1, x2, y2, locked: true });
const source = ({
  archiveEntry, planType, recordSha256, geometryBasis, roomAdjacency,
}) => ({
  datasetUrl: DATASET_URL,
  catalogUrl: CATALOG_URL,
  archiveFileId: 'FILE_000000003519063',
  fileDetailSn: '1',
  archiveEntry,
  planType,
  recordSha256,
  license: '이용허락범위 제한 없음',
  attribution: '한국토지주택공사(LH), 주택 평면도 현황',
  geometryBasis,
  roomAdjacency,
  adaptationNotice: '실제 LH 평면 기록의 주요 치수·공간 수·인접 관계·문과 창 위치를 축약 재구성했습니다. 원본 이미지·주소·개인정보는 포함하지 않습니다.',
});

const mandeok59 = {
  id: 'lh-mandeok5-59a', name: '부산만덕5 59A 아파트', typology: 'compact', wallHeight: 240,
  zones: [
    zone('m59-zone-living', '거실', '거실', 270, 360, 390, 300, '#d9d2c2'),
    zone('m59-zone-kitchen', '주방·식당', '주방', 270, 150, 280, 210, '#d8c6a1'),
    entranceZone('m59-zone-entry', '현관·복도', '기타', 0, 150, 270, 210, '#d2c9bb'),
    zone('m59-zone-room2', '침실 2', '방', 0, 360, 270, 300, '#c9b8a6'),
    zone('m59-zone-room3', '침실 3', '방', 550, 150, 150, 210, '#b9c6b4'),
    zone('m59-zone-room1', '침실 1', '방', 660, 360, 330, 300, '#c5b8cd'),
    zone('m59-zone-bath1', '욕실 1', '욕실', 0, 0, 210, 150, '#aebfc4'),
    zone('m59-zone-bath2', '욕실 2', '욕실', 700, 150, 140, 210, '#aebfc4'),
  ],
  items: [
    item('m59-item-sofa', '소파', 'sofa', 455, 500, 210, 85, 82, '#7f9884'),
    item('m59-item-table', '식탁', 'table', 410, 265, 130, 75, 74, '#b78d65'),
    item('m59-item-bed1', '침대', 'bed', 825, 520, 160, 210, 55, '#b8a7a0'),
    item('m59-item-bed2', '침대', 'bed', 125, 520, 135, 195, 55, '#b8a7a0'),
    item('m59-item-desk', '책상', 'desk', 620, 190, 100, 50, 75, '#a98465'),
  ],
  structures: [
    entranceDoor('m59-door-entry', '현관문', 0, 255, 'vertical', 100, 1),
    door('m59-door-bath1', '욕실 1 문', 105, 150, 'horizontal', 80),
    door('m59-door-kitchen', '주방 문', 270, 255, 'vertical', 90, 1),
    door('m59-door-living', '거실 문', 500, 360, 'horizontal', 90, 1),
    door('m59-door-room2', '침실 2 문', 270, 455, 'vertical', 90),
    door('m59-door-room3', '침실 3 문', 550, 260, 'vertical', 90, 1),
    door('m59-door-bath2', '욕실 2 문', 700, 290, 'vertical', 80),
    door('m59-door-room1', '침실 1 문', 660, 455, 'vertical', 90),
    windowOpening('m59-window-living', '거실 창', 465, 660, 230),
    windowOpening('m59-window-room1', '침실 1 창', 825, 660, 180),
    windowOpening('m59-window-room2', '침실 2 창', 130, 660, 160),
  ],
  dimensions: [
    dimension('m59-dim-width', '주요 실내 폭', 0, 700, 990, 700),
    dimension('m59-dim-depth', '주요 실내 깊이', 1030, 0, 1030, 660),
  ],
  backgroundPlan: null,
  source: source({
    archiveEntry: '부산울산본부_부산만덕5(06,주환1)_01BL/01.59A-평면-01.json',
    planType: '59A',
    recordSha256: '1eee0500213a8862d5a3ebfaaaf6f570d096f9621618cc5802e3caf1d4a63e89',
    geometryBasis: '59A 기록의 2,700·3,900·3,300 mm 실 폭과 현관-복도-거실, 방 3개, 욕실 2개의 인접 관계를 축약했습니다.',
    roomAdjacency: [
      ['현관·복도', '욕실 1'], ['현관·복도', '주방·식당'], ['주방·식당', '거실'],
      ['주방·식당', '침실 3'], ['침실 3', '욕실 2'], ['거실', '침실 2'], ['거실', '침실 1'],
    ],
  }),
};

const hoecheon74 = {
  id: 'lh-hoecheon-a18-74a', name: '양주회천 A18 74A 아파트', typology: 'common-family', wallHeight: 240,
  zones: [
    zone('h74-zone-living', '거실', '거실', 380, 300, 436, 355, '#d9d2c2'),
    zone('h74-zone-kitchen', '주방·식당', '주방', 380, 0, 436, 300, '#d8c6a1'),
    entranceZone('h74-zone-entry', '현관·복도', '기타', 816, 0, 282, 300, '#d2c9bb'),
    zone('h74-zone-room1', '침실 1', '방', 0, 300, 380, 355, '#c9b8a6'),
    zone('h74-zone-room2', '침실 2', '방', 816, 300, 282, 355, '#b9c6b4'),
    zone('h74-zone-room3', '침실 3', '방', 1098, 300, 286, 355, '#c5b8cd'),
    zone('h74-zone-bath1', '부부 욕실', '욕실', 140, 0, 240, 180, '#aebfc4'),
    zone('h74-zone-bath2', '공용 욕실', '욕실', 1098, 0, 286, 300, '#aebfc4'),
  ],
  items: [
    item('h74-item-sofa', '소파', 'sofa', 600, 500, 235, 90, 84, '#7f9884'),
    item('h74-item-table', '식탁', 'table', 585, 165, 150, 80, 74, '#b78d65'),
    item('h74-item-bed1', '침대', 'bed', 185, 500, 170, 210, 55, '#b8a7a0'),
    item('h74-item-bed2', '침대', 'bed', 955, 500, 140, 195, 55, '#b8a7a0'),
    item('h74-item-desk', '책상', 'desk', 1235, 500, 115, 55, 75, '#a98465'),
  ],
  structures: [
    entranceDoor('h74-door-entry', '현관문', 957, 0, 'horizontal', 100),
    door('h74-door-entry-hall', '현관 안쪽 문', 816, 180, 'vertical', 100),
    door('h74-door-living', '거실 문', 700, 300, 'horizontal', 100, 1),
    door('h74-door-room1', '침실 1 문', 380, 400, 'vertical', 90),
    door('h74-door-bath1', '부부 욕실 문', 380, 90, 'vertical', 80),
    door('h74-door-room2', '침실 2 문', 816, 400, 'vertical', 90),
    door('h74-door-room3', '침실 3 문', 1098, 400, 'vertical', 90),
    door('h74-door-bath2', '공용 욕실 문', 1200, 300, 'horizontal', 80),
    windowOpening('h74-window-living', '거실 창', 600, 655, 260),
    windowOpening('h74-window-room1', '침실 1 창', 180, 655, 200),
    windowOpening('h74-window-room2', '침실 2 창', 955, 655, 150),
    windowOpening('h74-window-room3', '침실 3 창', 1240, 655, 150),
  ],
  dimensions: [
    dimension('h74-dim-width', '주요 실내 폭', 0, 700, 1384, 700),
    dimension('h74-dim-depth', '주요 실내 깊이', 1425, 0, 1425, 655),
  ],
  backgroundPlan: null,
  source: source({
    archiveEntry: '서울본부_양주회천_A18/양주회천18bl-74A.json',
    planType: '74A',
    recordSha256: 'b1982ca7e5be25c770f068e5769f8785c89b0609e5339e85cf1a015ea9377bec',
    geometryBasis: '74A 기록의 3,800·4,360·2,820·2,860 mm 실 폭과 중앙 거실, 방 3개, 욕실 2개의 인접 관계를 축약했습니다.',
    roomAdjacency: [
      ['현관·복도', '주방·식당'], ['주방·식당', '거실'], ['주방·식당', '부부 욕실'],
      ['거실', '침실 1'], ['거실', '침실 2'], ['침실 2', '침실 3'], ['침실 3', '공용 욕실'],
    ],
  }),
};

const hoecheon84 = {
  id: 'lh-hoecheon-a18-84a', name: '양주회천 A18 84A 아파트', typology: 'larger-family', wallHeight: 250,
  zones: [
    zone('h84-zone-living', '거실', '거실', 628, 341, 466, 355, '#d9d2c2'),
    zone('h84-zone-kitchen', '주방·식당', '주방', 480, 0, 614, 341, '#d8c6a1'),
    entranceZone('h84-zone-entry', '현관·복도', '기타', 316, 0, 164, 341, '#d2c9bb'),
    zone('h84-zone-room1', '침실 1', '방', 1094, 341, 380, 355, '#c9b8a6'),
    zone('h84-zone-room2', '침실 2', '방', 316, 341, 312, 355, '#b9c6b4'),
    zone('h84-zone-room3', '침실 3', '방', 0, 341, 316, 355, '#c5b8cd'),
    zone('h84-zone-bath1', '공용 욕실', '욕실', 0, 0, 316, 341, '#aebfc4'),
    zone('h84-zone-bath2', '부부 욕실', '욕실', 1094, 0, 190, 341, '#aebfc4'),
  ],
  items: [
    item('h84-item-sofa', '소파', 'sofa', 860, 535, 250, 95, 85, '#7f9884'),
    item('h84-item-table', '식탁', 'table', 790, 190, 170, 85, 74, '#b78d65'),
    item('h84-item-bed1', '침대', 'bed', 1280, 525, 180, 220, 55, '#b8a7a0'),
    item('h84-item-bed2', '침대', 'bed', 470, 520, 145, 200, 55, '#b8a7a0'),
    item('h84-item-desk', '책상', 'desk', 150, 520, 120, 60, 75, '#a98465'),
  ],
  structures: [
    entranceDoor('h84-door-entry', '현관문', 398, 0, 'horizontal', 100),
    door('h84-door-entry-hall', '현관 안쪽 문', 480, 200, 'vertical', 100),
    door('h84-door-living', '거실 문', 850, 341, 'horizontal', 100),
    door('h84-door-room1', '침실 1 문', 1094, 450, 'vertical', 90),
    door('h84-door-bath1', '공용 욕실 문', 150, 341, 'horizontal', 80),
    door('h84-door-room2', '침실 2 문', 628, 450, 'vertical', 90),
    door('h84-door-room3', '침실 3 문', 316, 450, 'vertical', 90, 1),
    door('h84-door-bath2', '부부 욕실 문', 1180, 341, 'horizontal', 80),
    windowOpening('h84-window-living', '거실 창', 860, 696, 280),
    windowOpening('h84-window-room1', '침실 1 창', 1280, 696, 210),
    windowOpening('h84-window-room2', '침실 2 창', 470, 696, 175),
    windowOpening('h84-window-room3', '침실 3 창', 155, 696, 175),
  ],
  dimensions: [
    dimension('h84-dim-width', '주요 실내 폭', 0, 740, 1474, 740),
    dimension('h84-dim-depth', '주요 실내 깊이', 1515, 0, 1515, 696),
  ],
  backgroundPlan: null,
  source: source({
    archiveEntry: '서울본부_양주회천_A18/양주회천18bl-84A.json',
    planType: '84A',
    recordSha256: 'f63d26b4d176d9c9573f5f7a5575f52342bcf99c490b967f0c7869fdedcd8bd4',
    geometryBasis: '84A 기록의 3,160·3,120·4,660·3,800 mm 실 폭과 중앙 거실, 방 3개, 욕실 2개의 인접 관계를 축약했습니다.',
    roomAdjacency: [
      ['현관·복도', '주방·식당'], ['주방·식당', '거실'], ['거실', '침실 1'],
      ['거실', '침실 2'], ['침실 2', '침실 3'], ['침실 3', '공용 욕실'], ['침실 1', '부부 욕실'],
    ],
  }),
};

export const DEMO_LAYOUTS = deepFreeze([mandeok59, hoecheon74, hoecheon84]);
export const REGIONAL_DEMO_LAYOUTS = deepFreeze(regionalLayouts);

export function demoLayoutById(id) {
  const layout = [...REGIONAL_DEMO_LAYOUTS, ...DEMO_LAYOUTS].find((candidate) => candidate.id === id);
  return layout ? structuredClone(layout) : null;
}
