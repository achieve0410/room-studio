import './styles.css';
import { createConfiguredCloudStore, hasCloudConfiguration, normalizeProjectName, resolveAuthRedirectUrl } from './cloud-store.js';
import {
  calibrateBackgroundPlan,
  createLayoutClipboard,
  formatMeasurement,
  measurementLength,
  pasteLayoutClipboard,
} from './layout-tools.js';
import {
  alignDoorToWall,
  GRID_CM,
  RESIZE_DIRECTIONS,
  calculateCoverage,
  calculateUnionArea,
  clampZoom,
  doorsForAutomaticWallSegment,
  findCollisions,
  findHeightViolations,
  findOutOfBounds,
  findZoneOverlaps,
  getExteriorWallSegments,
  getInteriorWallSegments,
  getAlignmentSnap,
  getAnchoredZoomViewBox,
  getPannedViewBox,
  getPinchViewBox,
  getLayoutBounds,
  getRolledBackSelection,
  getZoomViewBox,
  itemBounds,
  meters,
  normalizeAngle,
  pointInZone,
  resizeItemFromHandle,
  resizeStructureFromEndpoint,
  resizeZoneFromHandle,
  rotationFromPointer,
  snap,
  spaceIdOf,
  splitWallSegment,
  snapDoorToWallSegments,
  structureBounds,
  structureSegment,
  zoneBounds,
  zonesOverlap,
} from './geometry.js';

const STORAGE_KEY = 'room-studio-layout-v2';
const ACTIVE_PROJECT_KEY_PREFIX = 'room-studio-active-project-v1';
const ANONYMOUS_LAYOUT_KEY = 'room-studio-anonymous-layout-v1';
const ANONYMOUS_OWNER_KEY = 'room-studio-anonymous-owner-v1';
const SPACE_TYPES = ['거실', '방', '주방', '다용도실', '욕실', '기타'];
const SHAPES = {
  rect: '직사각형',
  circle: '원',
  roundRect: '둥근 사각형',
  ellipse: '타원',
};
const DOOR_TYPES = { swing: '여닫이문', sliding: '미닫이문' };
const STRUCTURE_LABELS = { wall: '벽', door: '문', window: '미닫이창' };
const ORIENTATIONS = { horizontal: '가로', vertical: '세로' };
const END_DIRECTIONS = { start: '시작쪽', end: '끝쪽' };
const spaceColors = ['#d9d2c2', '#ced8cf', '#e7cfb6', '#c8d7dd', '#d8c9d5', '#ddd9c8'];
const DEFAULT_ZONE_COLOR = '#d9d2c2';
const DEFAULT_ITEM_COLOR = '#d8b596';
const DOOR_WALL_SNAP_CM = 30;
const MAX_BACKGROUND_DATA_URL_LENGTH = 700_000;
const BACKGROUND_MAX_IMAGE_EDGE = 1600;

const furnitureTemplates = [
  { type: 'bed', name: '침대', shape: 'roundRect', width: 160, depth: 200, height: 55, color: '#d8b596' },
  { type: 'sofa', name: '소파', shape: 'roundRect', width: 210, depth: 90, height: 85, color: '#91a38f' },
  { type: 'desk', name: '책상', shape: 'rect', width: 140, depth: 70, height: 74, color: '#bf8e62' },
  { type: 'table', name: '원형 테이블', shape: 'circle', width: 110, depth: 110, height: 72, color: '#d4a653' },
  { type: 'rug', name: '타원 러그', shape: 'ellipse', width: 180, depth: 110, height: 2, color: '#b98f75' },
  { type: 'wardrobe', name: '옷장', shape: 'rect', width: 120, depth: 60, height: 210, color: '#9b8067' },
  { type: 'tv', name: 'TV장', shape: 'roundRect', width: 140, depth: 40, height: 48, color: '#6f7775' },
  { type: 'plant', name: '화분', shape: 'circle', width: 50, depth: 50, height: 95, color: '#64886a' },
  { type: 'toilet', name: '변기', shape: 'roundRect', width: 72, depth: 75, height: 78, color: '#e7e8e3' },
  { type: 'washbasin', name: '세면대', shape: 'roundRect', width: 70, depth: 52, height: 85, color: '#dfe5e2' },
  { type: 'kitchenSink', name: '싱크대', shape: 'rect', width: 240, depth: 60, height: 110, color: '#b7ab96' },
  { type: 'kitchenIsland', name: '아일랜드장', shape: 'rect', width: 180, depth: 90, height: 92, color: '#a98f72' },
  { type: 'laundryTower', name: '세탁기·건조기 콤보', shape: 'roundRect', width: 70, depth: 75, height: 190, color: '#aeb5b5' },
  { type: 'clothesRackSingle', name: '옷걸이 행거 1단', shape: 'rect', width: 120, depth: 45, height: 170, color: '#747872' },
  { type: 'clothesRackDoubleRow', name: '옷걸이 행거 2단 횡', shape: 'rect', width: 120, depth: 70, height: 170, color: '#747872' },
  { type: 'clothesRackDoubleTier', name: '옷걸이 행거 2단 열', shape: 'rect', width: 120, depth: 45, height: 190, color: '#747872' },
];

const uid = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const makeZone = (zone) => {
  const id = uid('zone');
  return { id, spaceId: id, height: 240, ...zone };
};
const zonesInSpace = (zones, zone) => zones.filter((candidate) => spaceIdOf(candidate) === spaceIdOf(zone));
const groupSpaces = (zones) => {
  const groups = new Map();
  zones.forEach((zone) => {
    const key = spaceIdOf(zone);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(zone);
  });
  return [...groups.values()];
};
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
})[character]);
const numberValue = (value, fallback, min = 0, max = 2000) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};
const normalizeHexColor = (value, fallback) => (
  typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : fallback
);
const safeEntityId = (value, prefix) => (
  typeof value === 'string' && /^[\w-]+$/.test(value) ? value : uid(prefix)
);
const uniqueEntityId = (value, prefix, usedIds) => {
  let id = safeEntityId(value, prefix);
  while (usedIds.has(id)) id = uid(prefix);
  usedIds.add(id);
  return id;
};
const normalizeStructure = (structure, wallHeight) => {
  if (!structure || !['wall', 'door', 'window'].includes(structure.type)) return null;
  const orientation = ORIENTATIONS[structure.orientation] ? structure.orientation : 'horizontal';
  const base = {
    id: safeEntityId(structure.id, structure.type),
    type: structure.type,
    name: typeof structure.name === 'string' ? structure.name : STRUCTURE_LABELS[structure.type],
    x: numberValue(structure.x, 0, -5000, 5000),
    y: numberValue(structure.y, 0, -5000, 5000),
    height: numberValue(structure.height, structure.type === 'wall' ? wallHeight : structure.type === 'window' ? 120 : 205, structure.type === 'window' ? 50 : 100, 600),
    orientation,
    locked: Boolean(structure.locked),
  };
  if (structure.type === 'wall') {
    return {
      ...base,
      length: numberValue(structure.length, 240, 40, 2000),
      thickness: numberValue(structure.thickness, 4, 2, 12),
    };
  }
  const opening = {
    ...base,
    width: numberValue(structure.width, structure.type === 'window' ? 160 : 90, structure.type === 'window' ? 60 : 50, structure.type === 'window' ? 400 : 300),
    slideDirection: END_DIRECTIONS[structure.slideDirection] ? structure.slideDirection : 'end',
    openRatio: numberValue(structure.openRatio, structure.type === 'door' && structure.doorType === 'sliding' ? 100 : 0, 0, 100),
    wallId: typeof structure.wallId === 'string' && /^[\w-]+$/.test(structure.wallId) ? structure.wallId : null,
  };
  if (structure.type === 'window') {
    const sillHeight = numberValue(structure.sillHeight, 90, 0, Math.max(0, wallHeight - 50));
    return { ...opening, sillHeight, height: Math.min(opening.height, Math.max(50, wallHeight - sillHeight)) };
  }
  return {
    ...opening,
    doorType: DOOR_TYPES[structure.doorType] ? structure.doorType : 'swing',
    hinge: END_DIRECTIONS[structure.hinge] ? structure.hinge : 'start',
    openSide: Number(structure.openSide) === 1 ? 1 : -1,
    openAngle: numberValue(structure.openAngle, 0, 0, 120),
  };
};
const normalizeDimension = (dimension, usedIds) => {
  if (!dimension || typeof dimension !== 'object') return null;
  return {
    id: uniqueEntityId(dimension.id, 'dimension', usedIds),
    name: typeof dimension.name === 'string' ? dimension.name.slice(0, 80) : '치수',
    x1: numberValue(dimension.x1, 0, -5000, 5000),
    y1: numberValue(dimension.y1, 0, -5000, 5000),
    x2: numberValue(dimension.x2, 100, -5000, 5000),
    y2: numberValue(dimension.y2, 0, -5000, 5000),
    locked: Boolean(dimension.locked),
  };
};
const normalizeBackgroundPlan = (backgroundPlan) => {
  if (!backgroundPlan || typeof backgroundPlan !== 'object') return null;
  if (
    typeof backgroundPlan.dataUrl !== 'string'
    || backgroundPlan.dataUrl.length > MAX_BACKGROUND_DATA_URL_LENGTH
    || !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(backgroundPlan.dataUrl)
  ) return null;
  return {
    dataUrl: backgroundPlan.dataUrl,
    name: typeof backgroundPlan.name === 'string' ? backgroundPlan.name.slice(0, 120) : '배경 도면',
    x: numberValue(backgroundPlan.x, 0, -5000, 5000),
    y: numberValue(backgroundPlan.y, 0, -5000, 5000),
    width: numberValue(backgroundPlan.width, 800, 20, 10000),
    depth: numberValue(backgroundPlan.depth, 600, 20, 10000),
    opacity: numberValue(backgroundPlan.opacity, 0.45, 0.05, 1),
    locked: backgroundPlan.locked !== false,
  };
};

function apartmentZones() {
  return [
    makeZone({ name: '거실', type: '거실', x: 0, y: 0, width: 400, depth: 300, color: spaceColors[0] }),
    makeZone({ name: '주방', type: '주방', x: 400, y: 0, width: 220, depth: 180, color: spaceColors[2] }),
    makeZone({ name: '다용도실', type: '다용도실', x: 620, y: 0, width: 120, depth: 180, color: spaceColors[3] }),
    makeZone({ name: '방 1', type: '방', x: 0, y: 300, width: 280, depth: 260, color: spaceColors[1] }),
    makeZone({ name: '방 2', type: '방', x: 280, y: 300, width: 220, depth: 260, color: spaceColors[4] }),
    makeZone({ name: '방 3', type: '방', x: 500, y: 180, width: 240, depth: 380, color: spaceColors[5] }),
  ];
}

function lShapeZones() {
  return [
    makeZone({ name: '거실', type: '거실', x: 0, y: 0, width: 460, depth: 300, color: spaceColors[0] }),
    makeZone({ name: '주방', type: '주방', x: 460, y: 0, width: 240, depth: 180, color: spaceColors[2] }),
    makeZone({ name: '방 1', type: '방', x: 0, y: 300, width: 260, depth: 250, color: spaceColors[1] }),
    makeZone({ name: '방 2', type: '방', x: 260, y: 300, width: 200, depth: 250, color: spaceColors[4] }),
  ];
}

function createItem(template, zones, index = 0) {
  const target = zones.find((zone) => zone.type === '거실') ?? zones[0];
  const layout = getLayoutBounds(zones);
  const center = target
    ? { x: target.x + target.width / 2, y: target.y + target.depth / 2 }
    : { x: layout.left + layout.width / 2, y: layout.top + layout.depth / 2 };
  return {
    id: uid('item'),
    ...template,
    x: snap(center.x + (index % 3) * 30),
    y: snap(center.y + (index % 2) * 30),
    elevation: 0,
    rotation: 0,
  };
}

function defaultState(zones = apartmentZones()) {
  const bed = createItem(furnitureTemplates[0], zones);
  const sofa = createItem(furnitureTemplates[1], zones, 1);
  const table = createItem(furnitureTemplates[3], zones, 2);
  const bedroom = zones.find((zone) => zone.name === '방 1');
  const living = zones.find((zone) => zone.type === '거실');
  if (bedroom) {
    bed.x = bedroom.x + 95;
    bed.y = bedroom.y + 125;
  }
  if (living) {
    sofa.x = living.x + 150;
    sofa.y = living.y + 90;
    table.x = living.x + 270;
    table.y = living.y + 200;
  }
  return {
    zones,
    items: [bed, sofa, table],
    structures: [],
    dimensions: [],
    backgroundPlan: null,
    selection: { kind: 'item', id: sofa.id },
    wallHeight: 240,
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved?.zones) && Array.isArray(saved?.items)) {
      const wallHeight = numberValue(saved.wallHeight, 240, 100, 600);
      const zoneIds = new Set();
      const itemIds = new Set();
      const dimensionIds = new Set();
      const generatedSpaceIds = new Map();
      const zones = saved.zones.map((source) => {
        const zone = source && typeof source === 'object' ? source : {};
        const id = uniqueEntityId(zone.id, 'zone', zoneIds);
        const rawSpaceId = zone.spaceId ?? zone.id ?? id;
        let spaceId = typeof rawSpaceId === 'string' && /^[\w-]+$/.test(rawSpaceId) ? rawSpaceId : null;
        if (!spaceId) {
          const key = String(rawSpaceId);
          if (!generatedSpaceIds.has(key)) generatedSpaceIds.set(key, uid('space'));
          spaceId = generatedSpaceIds.get(key);
        }
        return {
          id,
          spaceId,
          name: typeof zone.name === 'string' ? zone.name.slice(0, 80) : '공간',
          type: SPACE_TYPES.includes(zone.type) ? zone.type : '기타',
          x: numberValue(zone.x, 0, -5000, 5000),
          y: numberValue(zone.y, 0, -5000, 5000),
          width: numberValue(zone.width, 300, 100, 1200),
          depth: numberValue(zone.depth, 300, 100, 1200),
          height: numberValue(zone.height, wallHeight, 100, 600),
          color: normalizeHexColor(zone.color, DEFAULT_ZONE_COLOR),
          locked: Boolean(zone.locked),
        };
      });
      const items = saved.items.map((source) => {
        const item = source && typeof source === 'object' ? source : {};
        const rotation = Number.isFinite(Number(item.rotation)) ? ((Number(item.rotation) % 360) + 360) % 360 : 0;
        return {
          id: uniqueEntityId(item.id, 'item', itemIds),
          type: typeof item.type === 'string' && /^[\w-]+$/.test(item.type) ? item.type : 'custom',
          name: typeof item.name === 'string' ? item.name.slice(0, 80) : '가구',
          shape: SHAPES[item.shape] ? item.shape : 'rect',
          x: numberValue(item.x, 0, -5000, 5000),
          y: numberValue(item.y, 0, -5000, 5000),
          width: numberValue(item.width, 100, 20, 600),
          depth: numberValue(item.depth, 70, 20, 600),
          height: numberValue(item.height, 80, 1, 400),
          elevation: numberValue(item.elevation, 0, 0, 400),
          rotation,
          color: normalizeHexColor(item.color, DEFAULT_ITEM_COLOR),
          locked: Boolean(item.locked),
        };
      });
      const normalizedStructures = (Array.isArray(saved.structures) ? saved.structures : [])
        .map((structure) => normalizeStructure(structure, wallHeight))
        .filter(Boolean);
      const attachedWallIds = new Set(normalizedStructures
        .filter((structure) => structure.type !== 'wall' && structure.wallId)
        .map((opening) => opening.wallId));
      const sizedStructures = normalizedStructures.map((structure) => (
        structure.type === 'wall' && attachedWallIds.has(structure.id) && structure.length < 50
          ? { ...structure, length: 50 }
          : structure
      ));
      const walls = new Map(sizedStructures.filter((structure) => structure.type === 'wall').map((wall) => [wall.id, wall]));
      const structures = sizedStructures.map((structure) => {
        if (structure.type === 'wall') return structure;
        const wall = walls.get(structure.wallId);
        if (!wall) return { ...structure, wallId: null };
        const aligned = alignDoorToWall({ ...structure, width: Math.min(structure.width, wall.length) }, wall);
        if (aligned.type !== 'window') return aligned;
        const sillHeight = Math.min(aligned.sillHeight, Math.max(0, wall.height - 50));
        return { ...aligned, sillHeight, height: Math.min(aligned.height, Math.max(50, wall.height - sillHeight)) };
      });
      const dimensions = (Array.isArray(saved.dimensions) ? saved.dimensions : [])
        .map((dimension) => normalizeDimension(dimension, dimensionIds))
        .filter(Boolean);
      const backgroundPlan = normalizeBackgroundPlan(saved.backgroundPlan);
      return {
        ...defaultState(zones),
        ...saved,
        zones,
        items,
        structures,
        dimensions,
        backgroundPlan,
        wallHeight,
        selection: null,
      };
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  return defaultState();
}

let state = loadState();
let drag = null;
let resize = null;
let rotateGesture = null;
let marquee = null;
let backgroundDrag = null;
let alignmentGuides = [];
let selectionKeys = new Set(state.selection ? [`${state.selection.kind}:${state.selection.id}`] : []);
const historyPast = [];
const historyFuture = [];
const HISTORY_LIMIT = 100;
const MIN_CANVAS_ZOOM = 0.05;
const MAX_CANVAS_ZOOM = 6;
const CANVAS_PADDING = 70;
const FOCUSED_MOBILE_BREAKPOINT = 900;
const MOBILE_LONG_PRESS_MS = 450;
const TOUCH_SLOP_PX = 10;
const mobileLayoutQuery = window.matchMedia(`(max-width: ${FOCUSED_MOBILE_BREAKPOINT}px)`);
let canvasZoom = 1;
let canvasCenter = null;
let mobilePanel = 'canvas';
let mobileMultiSelect = false;
let pendingFocus = null;
const activePointers = new Map();
let gestureMode = 'idle';
let pan = null;
let pinch = null;
let entityPress = null;
let mobileContextMenu = null;
let mobileMoveArmed = false;
let precisionTool = null;
let calibrationDistanceCm = 100;
let internalClipboard = null;
let pasteCount = 0;
let editorNotice = '';
const app = document.querySelector('#app');
const cloudConfigured = hasCloudConfiguration();
const cloudAuthRedirectUrl = resolveAuthRedirectUrl(import.meta.env.BASE_URL, window.location.href);
let cloudStore = null;
let cloudSession = null;
let cloudProjects = [];
let activeProjectId = null;
let activeProjectName = '내 집 도면';
let activeProjectRevision = null;
let cloudDialogOpen = false;
let cloudLoadBusy = false;
let cloudPendingSave = null;
let cloudSaveLoop = null;
let cloudSaveTimer = null;
let suppressCloudSave = false;
let cloudDirty = false;
let layoutChangeVersion = 0;
let cloudGeneration = 0;
let cloudFeedback = cloudConfigured ? '로그인 기능을 준비하는 중…' : '클라우드 연결 설정이 필요합니다.';
let cloudFeedbackTone = '';

const selectionKey = (kind, id) => `${kind}:${id}`;
const isMobileLayout = () => mobileLayoutQuery.matches;
const usesAdditiveSelection = (event) => event.shiftKey || (isMobileLayout() && mobileMultiSelect);
const mobileTabs = [
  ['canvas', '▦', '도면'],
  ['spaces', '⌂', '공간'],
  ['furniture', '▤', '가구'],
  ['inspector', '⌁', '상세'],
];
const layoutSnapshot = () => ({
  zones: state.zones.map((zone) => ({ ...zone })),
  items: state.items.map((item) => ({ ...item })),
  structures: state.structures.map((structure) => ({ ...structure })),
  dimensions: state.dimensions.map((dimension) => ({ ...dimension })),
  backgroundPlan: state.backgroundPlan ? { ...state.backgroundPlan } : null,
  wallHeight: state.wallHeight,
});
const snapshotsMatch = (first, second) => JSON.stringify(first) === JSON.stringify(second);

function commitHistory(previous) {
  const current = layoutSnapshot();
  if (snapshotsMatch(previous, current)) return;
  historyPast.push(previous);
  if (historyPast.length > HISTORY_LIMIT) historyPast.shift();
  historyFuture.length = 0;
}

function restoreSnapshot(snapshot, destination) {
  if (!snapshot) return;
  destination.push(layoutSnapshot());
  state = { ...state, ...snapshot, selection: null };
  selectionKeys = new Set();
  drag = null;
  resize = null;
  backgroundDrag = null;
  marquee = null;
  precisionTool = null;
  alignmentGuides = [];
  mobileContextMenu = null;
  mobileMoveArmed = false;
  saveState();
  render();
}

function undo() {
  restoreSnapshot(historyPast.pop(), historyFuture);
}

function redo() {
  restoreSnapshot(historyFuture.pop(), historyPast);
}

function selectedEntries() {
  return [...selectionKeys].flatMap((key) => {
    const separator = key.indexOf(':');
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);
    const collection = kind === 'zone'
      ? state.zones
      : kind === 'item'
        ? state.items
        : kind === 'structure'
          ? state.structures
          : state.dimensions;
    const entity = collection.find((entry) => entry.id === id);
    return entity ? [{ kind, id, entity }] : [];
  });
}

function isSelected(kind, id) {
  return selectionKeys.has(selectionKey(kind, id));
}

function selectEntity(kind, id, toggle = false) {
  const key = selectionKey(kind, id);
  if (toggle && selectionKeys.has(key)) {
    selectionKeys.delete(key);
    const fallback = selectedEntries().at(-1);
    state.selection = fallback ? { kind: fallback.kind, id: fallback.id } : null;
    return false;
  }
  if (!toggle) selectionKeys = new Set();
  selectionKeys.add(key);
  state.selection = { kind, id };
  return true;
}

function clearSelection() {
  selectionKeys = new Set();
  state.selection = null;
  mobileContextMenu = null;
  mobileMoveArmed = false;
  render();
}

function rotateSelection() {
  const itemIds = new Set(selectedEntries()
    .filter((entry) => entry.kind === 'item' && !entry.entity.locked)
    .map((entry) => entry.id));
  if (!itemIds.size) return;
  const previous = layoutSnapshot();
  state.items = state.items.map((item) => itemIds.has(item.id)
    ? { ...item, rotation: (item.rotation + 90) % 360 }
    : item);
  mobileContextMenu = null;
  commitHistory(previous);
  saveState();
  render();
}

function rotateItemBy(id, degrees) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item || item.locked) return;
  pendingFocus = { kind: 'item-rotate', id };
  updateItem(id, { rotation: normalizeAngle(item.rotation + degrees) });
}

function selectedEntity() {
  if (!state.selection) return null;
  const collection = state.selection.kind === 'zone'
    ? state.zones
    : state.selection.kind === 'item'
      ? state.items
      : state.selection.kind === 'structure'
        ? state.structures
        : state.dimensions;
  return collection.find((entry) => entry.id === state.selection.id) ?? null;
}

function saveState() {
  const {
    zones, items, structures, dimensions, backgroundPlan, wallHeight,
  } = state;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    zones, items, structures, dimensions, backgroundPlan, wallHeight,
  }));
  layoutChangeVersion += 1;
  if (!suppressCloudSave && cloudSession) {
    cloudDirty = true;
    scheduleCloudSave();
  }
}

const activeProjectStorageKey = (userId) => `${ACTIVE_PROJECT_KEY_PREFIX}:${userId}`;
const currentCloudUserId = () => cloudSession?.user?.id ?? null;
const cloudOperationIsCurrent = (generation, userId) => (
  generation === cloudGeneration && userId && userId === currentCloudUserId()
);
const cloudIsBusy = () => cloudLoadBusy || Boolean(cloudSaveLoop);

function replaceLocalLayout(serializedLayout = null) {
  suppressCloudSave = true;
  if (serializedLayout) localStorage.setItem(STORAGE_KEY, serializedLayout);
  else localStorage.removeItem(STORAGE_KEY);
  state = loadState();
  suppressCloudSave = false;
  selectionKeys = new Set(state.selection ? [selectionKey(state.selection.kind, state.selection.id)] : []);
  historyPast.length = 0;
  historyFuture.length = 0;
  cloudDirty = false;
  layoutChangeVersion += 1;
}

function setCloudFeedback(message, tone = '') {
  cloudFeedback = message;
  cloudFeedbackTone = tone;
  const status = document.querySelector('[data-cloud-feedback]');
  if (status) {
    status.textContent = message;
    status.dataset.tone = tone;
  }
  const headerStatus = document.querySelector('[data-cloud-status]');
  if (headerStatus) headerStatus.textContent = message;
}

function scheduleCloudSave() {
  clearTimeout(cloudSaveTimer);
  if (!cloudStore || !cloudSession || !activeProjectId) return;
  setCloudFeedback('클라우드 저장 대기 중');
  cloudSaveTimer = setTimeout(() => saveCloudProject(false), 1200);
}

async function refreshCloudProjects(generation = cloudGeneration, userId = currentCloudUserId()) {
  if (!cloudStore || !userId) return null;
  const projects = await cloudStore.listProjects();
  if (!cloudOperationIsCurrent(generation, userId)) return null;
  cloudProjects = projects;
  return projects;
}

async function performCloudSave(createVersion) {
  const generation = cloudGeneration;
  const userId = currentCloudUserId();
  const targetProjectId = activeProjectId;
  const expectedRevision = activeProjectRevision;
  const changeVersion = layoutChangeVersion;
  const snapshot = layoutSnapshot();
  const projectName = activeProjectName;
  if (!cloudStore || !userId) return null;
  setCloudFeedback(createVersion ? '버전 저장 중…' : '클라우드 저장 중…');
  try {
    const project = await cloudStore.saveProject({
      id: targetProjectId,
      name: projectName,
      layout: snapshot,
      expectedRevision,
      createVersion,
    });
    if (!cloudOperationIsCurrent(generation, userId)) return null;
    if (targetProjectId !== activeProjectId) return null;
    activeProjectId = project.id;
    activeProjectName = project.name;
    activeProjectRevision = Number(project.revision);
    localStorage.setItem(activeProjectStorageKey(userId), project.id);
    if (changeVersion === layoutChangeVersion) cloudDirty = false;
    await refreshCloudProjects(generation, userId);
    setCloudFeedback(createVersion ? '새 버전을 저장했습니다.' : '클라우드에 저장했습니다.', 'success');
    return project;
  } catch (error) {
    if (!cloudOperationIsCurrent(generation, userId)) return null;
    const conflict = error.code === '40001' || String(error.message).includes('PROJECT_CONFLICT');
    setCloudFeedback(
      conflict ? '다른 기기에서 도면이 수정되었습니다. 저장된 도면을 다시 열어 확인해주세요.' : error.message || '클라우드 저장에 실패했습니다.',
      'error',
    );
    return null;
  }
}

async function drainCloudSaves() {
  let lastProject = null;
  while (cloudPendingSave) {
    const request = cloudPendingSave;
    cloudPendingSave = null;
    lastProject = await performCloudSave(request.createVersion);
    if (!lastProject) break;
  }
  return lastProject;
}

function saveCloudProject(createVersion = false) {
  if (!cloudStore || !cloudSession) {
    cloudDialogOpen = true;
    render();
    return Promise.resolve(null);
  }
  clearTimeout(cloudSaveTimer);
  cloudPendingSave = {
    createVersion: Boolean(createVersion || cloudPendingSave?.createVersion),
  };
  if (!cloudSaveLoop) {
    let loopPromise;
    loopPromise = (async () => {
      try {
        return await drainCloudSaves();
      } finally {
        if (cloudSaveLoop === loopPromise) cloudSaveLoop = null;
      }
    })();
    cloudSaveLoop = loopPromise;
  }
  return cloudSaveLoop;
}

async function flushCloudSave() {
  clearTimeout(cloudSaveTimer);
  if (!cloudDirty && !cloudPendingSave && !cloudSaveLoop) return true;
  const project = await saveCloudProject(false);
  return Boolean(project && !cloudDirty);
}

async function openCloudProject(id, { skipFlush = false } = {}) {
  if (!cloudStore || !cloudSession || !id || cloudLoadBusy) return;
  if (!skipFlush && !(await flushCloudSave())) return;
  const generation = cloudGeneration;
  const userId = currentCloudUserId();
  cloudLoadBusy = true;
  setCloudFeedback('도면을 불러오는 중…');
  try {
    const project = await cloudStore.loadProject(id);
    if (!cloudOperationIsCurrent(generation, userId)) return;
    replaceLocalLayout(JSON.stringify(project.layout_json));
    activeProjectId = project.id;
    activeProjectName = project.name;
    activeProjectRevision = Number(project.revision);
    localStorage.setItem(activeProjectStorageKey(userId), project.id);
    cloudDialogOpen = false;
    setCloudFeedback(`${project.name} 도면을 불러왔습니다.`, 'success');
    render();
    document.querySelector('#plan-canvas')?.focus();
  } catch (error) {
    if (cloudOperationIsCurrent(generation, userId)) setCloudFeedback(error.message || '도면을 불러오지 못했습니다.', 'error');
  } finally {
    if (cloudOperationIsCurrent(generation, userId)) cloudLoadBusy = false;
  }
}

async function createCloudCopy() {
  if (!cloudStore || !cloudSession || cloudLoadBusy) return;
  if (!(await flushCloudSave())) return;
  const originalId = activeProjectId;
  const originalName = activeProjectName;
  const originalRevision = activeProjectRevision;
  activeProjectId = null;
  activeProjectRevision = null;
  activeProjectName = normalizeProjectName(`${originalName} 복사본`);
  const project = await saveCloudProject(true);
  if (!project) {
    activeProjectId = originalId;
    activeProjectName = originalName;
    activeProjectRevision = originalRevision;
    return;
  }
  cloudDialogOpen = false;
  render();
  document.querySelector('[data-cloud-open]')?.focus();
}

async function handleCloudSession(session) {
  const previousUserId = currentCloudUserId();
  const nextUserId = session?.user?.id ?? null;
  cloudGeneration += 1;
  const generation = cloudGeneration;
  clearTimeout(cloudSaveTimer);
  cloudPendingSave = null;
  cloudSaveLoop = null;
  cloudLoadBusy = false;
  cloudSession = session;
  if (!session) {
    cloudProjects = [];
    activeProjectId = null;
    activeProjectRevision = null;
    if (previousUserId) replaceLocalLayout(localStorage.getItem(ANONYMOUS_LAYOUT_KEY));
    setCloudFeedback(cloudStore ? '로그인하면 여러 기기에서 동기화됩니다.' : '클라우드 연결 설정이 필요합니다.');
    render();
    if (cloudDialogOpen) document.querySelector('.cloud-dialog button, .cloud-dialog input')?.focus();
    return;
  }
  if (previousUserId && previousUserId !== nextUserId) replaceLocalLayout(localStorage.getItem(ANONYMOUS_LAYOUT_KEY));
  activeProjectId = localStorage.getItem(activeProjectStorageKey(nextUserId));
  activeProjectRevision = null;
  const anonymousOwner = localStorage.getItem(ANONYMOUS_OWNER_KEY);
  if (!activeProjectId && !previousUserId && localStorage.getItem(STORAGE_KEY) && !localStorage.getItem(ANONYMOUS_LAYOUT_KEY)) {
    localStorage.setItem(ANONYMOUS_LAYOUT_KEY, localStorage.getItem(STORAGE_KEY));
  }
  setCloudFeedback('내 도면을 확인하는 중…');
  try {
    const projects = await refreshCloudProjects(generation, nextUserId);
    if (!projects) return;
    const preferred = cloudProjects.find((project) => project.id === activeProjectId);
    if (preferred) {
      activeProjectRevision = Number(preferred.revision);
      await openCloudProject(preferred.id, { skipFlush: true });
      return;
    }
    const anonymousLayout = localStorage.getItem(ANONYMOUS_LAYOUT_KEY);
    if (anonymousLayout && (!anonymousOwner || anonymousOwner === nextUserId)) {
      replaceLocalLayout(anonymousLayout);
      activeProjectId = null;
      activeProjectRevision = null;
      activeProjectName = cloudProjects.length ? '가져온 로컬 도면' : '내 집 도면';
      const imported = await saveCloudProject(true);
      if (!imported) return;
      localStorage.setItem(ANONYMOUS_OWNER_KEY, nextUserId);
    } else if (cloudProjects[0]) {
      await openCloudProject(cloudProjects[0].id, { skipFlush: true });
      return;
    } else {
      replaceLocalLayout();
      activeProjectName = '내 집 도면';
      const created = await saveCloudProject(true);
      if (!created) return;
    }
    if (!cloudOperationIsCurrent(generation, nextUserId)) return;
    cloudDialogOpen = false;
    render();
  } catch (error) {
    if (cloudOperationIsCurrent(generation, nextUserId)) {
      setCloudFeedback(error.message || '클라우드 도면을 확인하지 못했습니다.', 'error');
      render();
    }
  }
}

async function initializeCloud() {
  if (!cloudConfigured) return;
  try {
    cloudStore = await createConfiguredCloudStore();
    await handleCloudSession(await cloudStore.getSession());
    cloudStore.onAuthStateChange((session) => {
      if (session?.user?.id === cloudSession?.user?.id) return;
      handleCloudSession(session);
    });
  } catch (error) {
    setCloudFeedback(error.message || '로그인 상태를 확인하지 못했습니다.', 'error');
  }
}

function updateState(updates, options = {}) {
  const previous = options.historySnapshot ?? layoutSnapshot();
  state = { ...state, ...updates };
  if (Object.hasOwn(updates, 'selection') && !options.preserveMultiSelection) {
    selectionKeys = new Set(updates.selection ? [selectionKey(updates.selection.kind, updates.selection.id)] : []);
    if (!updates.selection) {
      mobileContextMenu = null;
      mobileMoveArmed = false;
    }
  }
  if (options.save !== false) {
    if (options.history !== false) commitHistory(previous);
    saveState();
  }
  render();
}

function updateZone(id, updates, options = {}) {
  const selected = state.zones.find((zone) => zone.id === id);
  const sharedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([field]) => ['name', 'type', 'color', 'height'].includes(field)),
  );
  const zones = state.zones.map((zone) => {
    const sameSpace = selected && spaceIdOf(zone) === spaceIdOf(selected);
    if (zone.id !== id && (!sameSpace || !Object.keys(sharedUpdates).length)) return zone;
    const next = {
      ...zone,
      ...(sameSpace ? sharedUpdates : {}),
      ...(zone.id === id ? updates : {}),
    };
    next.width = numberValue(next.width, zone.width, 100, 1200);
    next.depth = numberValue(next.depth, zone.depth, 100, 1200);
    next.height = numberValue(next.height, zone.height ?? 240, 100, 600);
    return next;
  });
  updateState({ zones }, options);
}

function updateItem(id, updates, options = {}) {
  const items = state.items.map((item) => {
    if (item.id !== id) return item;
    const next = { ...item, ...updates };
    next.width = numberValue(next.width, item.width, 20, 600);
    next.depth = numberValue(next.depth, item.depth, 20, 600);
    next.height = numberValue(next.height, item.height, 1, 400);
    next.elevation = numberValue(next.elevation, item.elevation ?? 0, 0, 400);
    next.rotation = normalizeAngle(Number.isFinite(Number(next.rotation)) ? Number(next.rotation) : item.rotation);
    if (next.shape === 'circle') {
      if (updates.width !== undefined) next.depth = next.width;
      if (updates.depth !== undefined) next.width = next.depth;
    }
    return next;
  });
  updateState({ items }, options);
}

function updateStructure(id, updates, options = {}) {
  const current = state.structures.find((structure) => structure.id === id);
  if (!current) return;
  let next = { ...current, ...updates };
  next.x = numberValue(next.x, current.x, -5000, 5000);
  next.y = numberValue(next.y, current.y, -5000, 5000);
  next.height = numberValue(next.height, current.height ?? state.wallHeight, next.type === 'window' ? 50 : 100, 600);
  if (next.type === 'wall') {
    const attachedOpeningWidth = Math.max(40, ...state.structures
      .filter((structure) => structure.type !== 'wall' && structure.wallId === next.id)
      .map((opening) => opening.width));
    next.length = numberValue(next.length, current.length, attachedOpeningWidth, 2000);
    next.thickness = numberValue(next.thickness, current.thickness ?? 4, 2, 12);
  } else if (next.type === 'door') {
    next.width = numberValue(next.width, current.width, 50, 300);
    next.doorType = DOOR_TYPES[next.doorType] ? next.doorType : 'swing';
    next.hinge = END_DIRECTIONS[next.hinge] ? next.hinge : 'start';
    next.openSide = Number(next.openSide) === 1 ? 1 : -1;
    next.slideDirection = END_DIRECTIONS[next.slideDirection] ? next.slideDirection : 'end';
    next.openAngle = numberValue(next.openAngle, current.openAngle ?? 0, 0, 120);
    next.openRatio = numberValue(next.openRatio, current.openRatio ?? 0, 0, 100);
  } else {
    next.width = numberValue(next.width, current.width, 60, 400);
    next.slideDirection = END_DIRECTIONS[next.slideDirection] ? next.slideDirection : 'end';
    next.openRatio = numberValue(next.openRatio, current.openRatio ?? 0, 0, 100);
    const wall = state.structures.find((structure) => structure.id === next.wallId && structure.type === 'wall');
    const availableHeight = wall?.height ?? state.wallHeight;
    next.sillHeight = numberValue(next.sillHeight, current.sillHeight ?? 90, 0, Math.max(0, availableHeight - 50));
    next.height = Math.min(next.height, Math.max(50, availableHeight - next.sillHeight));
  }
  next.orientation = ORIENTATIONS[next.orientation] ? next.orientation : 'horizontal';
  const positionChanged = next.x !== current.x || next.y !== current.y;
  if (next.type !== 'wall' && next.wallId && !positionChanged) {
    const wall = state.structures.find((structure) => structure.id === next.wallId && structure.type === 'wall');
    if (wall) next = alignDoorToWall({ ...next, width: Math.min(next.width, wall.length) }, wall);
  }
  const delta = { x: next.x - current.x, y: next.y - current.y };
  const orientationChanged = current.orientation !== next.orientation;
  let structures = state.structures.map((structure) => {
    if (structure.id === id) return next;
    if (current.type === 'wall' && structure.wallId === id) {
      const aligned = alignDoorToWall({
        ...structure,
        x: orientationChanged ? next.x : structure.x + delta.x,
        y: orientationChanged ? next.y : structure.y + delta.y,
        orientation: next.orientation,
      }, next);
      if (aligned.type !== 'window') return aligned;
      const sillHeight = Math.min(aligned.sillHeight, Math.max(0, next.height - 50));
      return { ...aligned, sillHeight, height: Math.min(aligned.height, Math.max(50, next.height - sillHeight)) };
    }
    return structure;
  });
  if (current.type !== 'wall' && positionChanged) {
    structures = settleMovedStructures(structures, new Set([id]));
  }
  updateState({ structures }, options);
}

function updateDimension(id, updates, options = {}) {
  const dimensions = state.dimensions.map((dimension) => {
    if (dimension.id !== id) return dimension;
    return {
      ...dimension,
      ...updates,
      name: typeof updates.name === 'string' ? updates.name.slice(0, 80) : dimension.name,
      x1: numberValue(updates.x1, dimension.x1, -5000, 5000),
      y1: numberValue(updates.y1, dimension.y1, -5000, 5000),
      x2: numberValue(updates.x2, dimension.x2, -5000, 5000),
      y2: numberValue(updates.y2, dimension.y2, -5000, 5000),
      locked: updates.locked === undefined ? dimension.locked : Boolean(updates.locked),
    };
  });
  updateState({ dimensions }, options);
}

function updateBackgroundPlan(updates, options = {}) {
  if (!state.backgroundPlan) return;
  const backgroundPlan = {
    ...state.backgroundPlan,
    ...updates,
  };
  backgroundPlan.x = numberValue(backgroundPlan.x, state.backgroundPlan.x, -5000, 5000);
  backgroundPlan.y = numberValue(backgroundPlan.y, state.backgroundPlan.y, -5000, 5000);
  backgroundPlan.width = numberValue(backgroundPlan.width, state.backgroundPlan.width, 20, 10000);
  backgroundPlan.depth = numberValue(backgroundPlan.depth, state.backgroundPlan.depth, 20, 10000);
  backgroundPlan.opacity = numberValue(backgroundPlan.opacity, state.backgroundPlan.opacity, 0.05, 1);
  backgroundPlan.locked = Boolean(backgroundPlan.locked);
  updateState({ backgroundPlan }, options);
}

function setSelectionLocked(locked) {
  const entries = selectedEntries();
  if (!entries.length) return;
  const idsByKind = {
    zone: new Set(entries.filter(({ kind }) => kind === 'zone').map(({ id }) => id)),
    item: new Set(entries.filter(({ kind }) => kind === 'item').map(({ id }) => id)),
    structure: new Set(entries.filter(({ kind }) => kind === 'structure').map(({ id }) => id)),
    dimension: new Set(entries.filter(({ kind }) => kind === 'dimension').map(({ id }) => id)),
  };
  const selectedWallIds = new Set(state.structures
    .filter((structure) => idsByKind.structure.has(structure.id) && structure.type === 'wall')
    .map(({ id }) => id));
  state.structures
    .filter((structure) => selectedWallIds.has(structure.wallId))
    .forEach((structure) => idsByKind.structure.add(structure.id));
  updateState({
    zones: state.zones.map((zone) => idsByKind.zone.has(zone.id) ? { ...zone, locked } : zone),
    items: state.items.map((item) => idsByKind.item.has(item.id) ? { ...item, locked } : item),
    structures: state.structures.map((structure) => idsByKind.structure.has(structure.id) ? { ...structure, locked } : structure),
    dimensions: state.dimensions.map((dimension) => idsByKind.dimension.has(dimension.id) ? { ...dimension, locked } : dimension),
  }, { preserveMultiSelection: true });
}

function toggleSelectionLocked() {
  const entries = selectedEntries();
  if (!entries.length) return;
  setSelectionLocked(!entries.every(({ entity }) => entity.locked));
}

function applyClipboard(clipboard, offset, notice) {
  const previous = layoutSnapshot();
  const pasted = pasteLayoutClipboard(previous, clipboard, { offset, idFactory: uid });
  if (!pasted.selection.length) return false;
  selectionKeys = new Set(pasted.selection.map(({ kind, id }) => selectionKey(kind, id)));
  const primary = pasted.selection.at(-1);
  editorNotice = notice ?? `${pasted.selection.length}개 대상을 붙여넣었습니다.`;
  updateState({
    ...pasted.layout,
    selection: { kind: primary.kind, id: primary.id },
  }, { historySnapshot: previous, preserveMultiSelection: true });
  return true;
}

function copySelection() {
  const selection = selectedEntries().map(({ kind, id }) => ({ kind, id }));
  if (!selection.length) return false;
  internalClipboard = createLayoutClipboard(layoutSnapshot(), selection);
  pasteCount = 0;
  editorNotice = `${selection.length}개 대상을 복사했습니다.`;
  render();
  return true;
}

function pasteSelection() {
  if (!internalClipboard) return false;
  pasteCount += 1;
  return applyClipboard(internalClipboard, GRID_CM * 2 * pasteCount);
}

function duplicateSelection() {
  const selection = selectedEntries().map(({ kind, id }) => ({ kind, id }));
  if (!selection.length) return false;
  const clipboard = createLayoutClipboard(layoutSnapshot(), selection);
  return applyClipboard(clipboard, GRID_CM * 2, `${selection.length}개 대상을 복제했습니다.`);
}

function imageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'));
    image.src = url;
  });
}

async function encodeBackgroundImage(file) {
  if (!['image/png', 'image/jpeg'].includes(file?.type)) throw new Error('PNG 또는 JPG 이미지만 가져올 수 있습니다.');
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await imageFromUrl(objectUrl);
    let scale = Math.min(1, BACKGROUND_MAX_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    let dataUrl = '';
    let width;
    let height;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      width = Math.max(1, Math.round(image.naturalWidth * scale));
      height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      dataUrl = canvas.toDataURL('image/jpeg', attempt < 4 ? 0.84 : 0.72);
      if (dataUrl.length <= MAX_BACKGROUND_DATA_URL_LENGTH) break;
      scale *= 0.78;
    }
    if (dataUrl.length > MAX_BACKGROUND_DATA_URL_LENGTH) throw new Error('이미지 용량을 줄이지 못했습니다. 더 작은 도면을 사용해주세요.');
    return { dataUrl, width, height };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function importBackgroundPlan(file) {
  const encoded = await encodeBackgroundImage(file);
  const bounds = getLayoutBounds(state.zones);
  const aspectRatio = encoded.width / encoded.height;
  let width = Math.max(400, bounds.width);
  let depth = width / aspectRatio;
  if (depth > Math.max(400, bounds.depth * 1.4)) {
    depth = Math.max(400, bounds.depth);
    width = depth * aspectRatio;
  }
  const backgroundPlan = {
    dataUrl: encoded.dataUrl,
    name: file.name,
    x: bounds.left + (bounds.width - width) / 2,
    y: bounds.top + (bounds.depth - depth) / 2,
    width,
    depth,
    opacity: 0.45,
    locked: true,
  };
  editorNotice = '배경 도면을 가져왔습니다. 실제 길이를 입력하고 2점을 찍어 축척을 맞추세요.';
  updateState({ backgroundPlan });
}

function startPrecisionTool(type) {
  if (type === 'background' && !state.backgroundPlan) return;
  precisionTool = { type, points: [] };
  mobileContextMenu = null;
  editorNotice = type === 'background'
    ? `도면에서 ${calibrationDistanceCm}cm에 해당하는 두 점을 찍으세요.`
    : '치수의 시작점과 끝점을 찍으세요.';
  render();
}

function handlePrecisionPoint(event) {
  if (!precisionTool || (event.button !== undefined && event.button !== 0)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const point = svgPoint(event);
  precisionTool.points.push({ x: point.x, y: point.y });
  if (precisionTool.points.length < 2) {
    editorNotice = '첫 점을 지정했습니다. 두 번째 점을 찍으세요.';
    render();
    return;
  }
  const [first, second] = precisionTool.points;
  const type = precisionTool.type;
  precisionTool = null;
  if (type === 'background') {
    const calibrated = calibrateBackgroundPlan(state.backgroundPlan, first, second, calibrationDistanceCm);
    if (!calibrated) {
      editorNotice = '서로 다른 두 점을 지정해주세요.';
      render();
      return;
    }
    if (
      calibrated.width < 20
      || calibrated.depth < 20
      || calibrated.width > 10000
      || calibrated.depth > 10000
      || calibrated.x < -5000
      || calibrated.y < -5000
      || calibrated.x > 5000
      || calibrated.y > 5000
    ) {
      editorNotice = '축척 결과가 편집 범위를 벗어납니다. 기준점을 더 멀리 찍어주세요.';
      render();
      return;
    }
    editorNotice = `배경 도면 축척을 ${calibrationDistanceCm}cm 기준으로 맞췄습니다.`;
    updateState({ backgroundPlan: calibrated });
    return;
  }
  if (measurementLength(first, second) < 0.1) {
    editorNotice = '치수선의 시작점과 끝점을 서로 다르게 지정해주세요.';
    render();
    return;
  }
  const dimension = {
    id: uid('dimension'),
    name: `치수 ${state.dimensions.length + 1}`,
    x1: first.x,
    y1: first.y,
    x2: second.x,
    y2: second.y,
    locked: false,
  };
  editorNotice = `${formatMeasurement(measurementLength(first, second))} 치수선을 추가했습니다.`;
  updateState({
    dimensions: [...state.dimensions, dimension],
    selection: { kind: 'dimension', id: dimension.id },
  });
}

function rotateStructure(id) {
  const structure = state.structures.find((entry) => entry.id === id);
  if (!structure || structure.locked) return;
  updateStructure(id, {
    orientation: structure.orientation === 'horizontal' ? 'vertical' : 'horizontal',
    ...(structure.type !== 'wall' ? { wallId: null } : {}),
  });
}

function setDoorOpening(id, value) {
  const opening = state.structures.find((structure) => structure.id === id && structure.type !== 'wall');
  if (!opening) return;
  updateStructure(id, opening.type === 'window' || opening.doorType === 'sliding'
    ? { openRatio: numberValue(value, opening.openRatio ?? 0, 0, 100) }
    : { openAngle: numberValue(value, opening.openAngle ?? 0, 0, 120) });
}

function doorWallTargets(structures) {
  return [
    ...getExteriorWallSegments(state.zones).map((segment) => ({ ...segment, wallId: null })),
    ...getInteriorWallSegments(state.zones).map((segment) => ({ ...segment, wallId: null })),
    ...structures.filter((structure) => structure.type === 'wall').map((wall) => ({
      ...structureSegment(wall),
      wallId: wall.id,
    })),
  ];
}

function settleMovedStructures(structures, movedIds) {
  const movedWallIds = new Set(structures
    .filter((structure) => movedIds.has(structure.id) && structure.type === 'wall')
    .map((wall) => wall.id));
  const walls = new Map(structures.filter((structure) => structure.type === 'wall').map((wall) => [wall.id, wall]));
  const targets = doorWallTargets(structures);
  return structures.map((structure) => {
    if (structure.type === 'wall' || !movedIds.has(structure.id)) return structure;
    if (movedWallIds.has(structure.wallId) && walls.has(structure.wallId)) {
      return alignDoorToWall(structure, walls.get(structure.wallId));
    }
    return snapDoorToWallSegments(structure, targets, DOOR_WALL_SNAP_CM) ?? { ...structure, wallId: null };
  });
}

function addZone() {
  const bounds = getLayoutBounds(state.zones);
  const roomCount = groupSpaces(state.zones).filter((parts) => parts[0]?.type === '방').length + 1;
  const zone = makeZone({
    name: `방 ${roomCount}`,
    type: '방',
    x: snap(bounds.right),
    y: snap(bounds.top),
    width: 240,
    depth: 220,
    color: spaceColors[state.zones.length % spaceColors.length],
  });
  updateState({ zones: [...state.zones, zone], selection: { kind: 'zone', id: zone.id } });
}

function zonesConnect(first, second) {
  if (zonesOverlap(first, second)) return true;
  const firstRight = first.x + first.width;
  const secondRight = second.x + second.width;
  const firstBottom = first.y + first.depth;
  const secondBottom = second.y + second.depth;
  const verticalOverlap = Math.min(firstBottom, secondBottom) > Math.max(first.y, second.y);
  const horizontalOverlap = Math.min(firstRight, secondRight) > Math.max(first.x, second.x);
  return ((firstRight === second.x || secondRight === first.x) && verticalOverlap)
    || ((firstBottom === second.y || secondBottom === first.y) && horizontalOverlap);
}

function selectedSpacesCanMerge() {
  const selectedIds = new Set(selectedEntries().filter((entry) => entry.kind === 'zone').map((entry) => spaceIdOf(entry.entity)));
  if (selectedIds.size < 2) return false;
  const partsBySpace = new Map([...selectedIds].map((id) => [id, state.zones.filter((zone) => spaceIdOf(zone) === id)]));
  const visited = new Set([[...selectedIds][0]]);
  let changed = true;
  while (changed) {
    changed = false;
    selectedIds.forEach((candidateId) => {
      if (visited.has(candidateId)) return;
      const touchesVisited = [...visited].some((visitedId) => partsBySpace.get(candidateId).some((candidate) => (
        partsBySpace.get(visitedId).some((part) => zonesConnect(candidate, part))
      )));
      if (touchesVisited) {
        visited.add(candidateId);
        changed = true;
      }
    });
  }
  return visited.size === selectedIds.size;
}

function mergeSelectedSpaces() {
  const selectedZones = selectedEntries().filter((entry) => entry.kind === 'zone').map((entry) => entry.entity);
  if (selectedZones.some((zone) => zone.locked)) {
    editorNotice = '잠긴 공간은 합칠 수 없습니다.';
    render();
    return;
  }
  const selectedSpaceIds = new Set(selectedZones.map(spaceIdOf));
  if (selectedSpaceIds.size < 2 || !selectedSpacesCanMerge()) return;
  const primary = state.selection?.kind === 'zone'
    ? state.zones.find((zone) => zone.id === state.selection.id)
    : selectedZones[0];
  if (!primary) return;
  const targetSpaceId = spaceIdOf(primary);
  const shared = {
    spaceId: targetSpaceId,
    name: primary.name,
    type: primary.type,
    color: primary.color,
    height: primary.height,
  };
  const selectedParts = state.zones.filter((zone) => selectedSpaceIds.has(spaceIdOf(zone)));
  const boundaryDoors = state.structures.filter((structure) => structure.type === 'door' && !structure.wallId);
  const removedDoorIds = new Set(getInteriorWallSegments(selectedParts).flatMap((segment) => (
    splitWallSegment(segment, boundaryDoors).openings.flatMap((opening) => opening.doors.map((door) => door.id))
  )));
  mobileMultiSelect = false;
  mobileMoveArmed = false;
  updateState({
    zones: state.zones.map((zone) => selectedSpaceIds.has(spaceIdOf(zone)) ? { ...zone, ...shared } : zone),
    structures: state.structures.filter((structure) => !removedDoorIds.has(structure.id)),
    selection: { kind: 'zone', id: primary.id },
  });
}

function addZonePart() {
  if (state.selection?.kind !== 'zone') return;
  const selected = selectedEntity();
  if (!selected) return;
  const width = Math.max(100, Math.min(240, selected.width));
  const depth = Math.max(100, Math.min(220, selected.depth));
  const positions = [
    { x: selected.x + selected.width, y: selected.y },
    { x: selected.x, y: selected.y + selected.depth },
    { x: selected.x - width, y: selected.y },
    { x: selected.x, y: selected.y - depth },
  ];
  const position = positions.find((candidate) => !state.zones.some((zone) => (
    spaceIdOf(zone) !== spaceIdOf(selected)
    && zonesOverlap({ ...candidate, width, depth }, zone)
  ))) ?? positions[0];
  const part = {
    ...selected,
    id: uid('zone'),
    spaceId: spaceIdOf(selected),
    ...position,
    width,
    depth,
  };
  updateState({ zones: [...state.zones, part], selection: { kind: 'zone', id: part.id } });
}

function addFurniture(template) {
  const item = createItem(template, state.zones, state.items.length);
  updateState({ items: [...state.items, item], selection: { kind: 'item', id: item.id } });
}

function addCustomFurniture() {
  const name = document.querySelector('#custom-name').value.trim() || '커스텀 가구';
  const shape = document.querySelector('#custom-shape').value;
  const width = numberValue(document.querySelector('#custom-width').value, 100, 20, 600);
  const depthInput = numberValue(document.querySelector('#custom-depth').value, 70, 20, 600);
  const template = {
    type: 'custom',
    name,
    shape,
    width,
    depth: shape === 'circle' ? width : depthInput,
    height: numberValue(document.querySelector('#custom-height').value, 80, 1, 400),
    color: document.querySelector('#custom-color').value,
  };
  if (isMobileLayout()) mobilePanel = 'canvas';
  addFurniture(template);
}

function addWall() {
  const target = state.zones.find((zone) => zone.type === '거실') ?? state.zones[0];
  const bounds = getLayoutBounds(state.zones);
  const wall = {
    id: uid('wall'),
    type: 'wall',
    name: `벽 ${state.structures.filter((structure) => structure.type === 'wall').length + 1}`,
    x: snap(target ? target.x + target.width / 2 : bounds.left + bounds.width / 2),
    y: snap(target ? target.y + target.depth - 40 : bounds.top + bounds.depth / 2),
    length: 320,
    height: target?.height ?? state.wallHeight,
    thickness: 4,
    orientation: 'horizontal',
  };
  if (isMobileLayout()) mobilePanel = 'canvas';
  updateState({ structures: [...state.structures, wall], selection: { kind: 'structure', id: wall.id } });
}

function addDoor(doorType) {
  const selected = state.selection?.kind === 'structure' ? selectedEntity() : null;
  const wall = selected?.type === 'wall'
    ? selected
    : selected?.wallId
      ? state.structures.find((structure) => structure.id === selected.wallId && structure.type === 'wall')
      : null;
  const attachedDoorCount = wall
    ? state.structures.filter((structure) => structure.type !== 'wall' && structure.wallId === wall.id).length
    : 0;
  const wallOffset = wall
    ? [-wall.length / 4, wall.length / 4, 0][attachedDoorCount] ?? 0
    : 0;
  const bounds = getLayoutBounds(state.zones);
  const door = {
    id: uid('door'),
    type: 'door',
    doorType,
    name: `${DOOR_TYPES[doorType]} ${state.structures.filter((structure) => structure.type === 'door' && structure.doorType === doorType).length + 1}`,
    x: wall ? wall.x + (wall.orientation === 'horizontal' ? wallOffset : 0) : snap(bounds.left + bounds.width / 2),
    y: wall ? wall.y + (wall.orientation === 'vertical' ? wallOffset : 0) : snap(bounds.top + bounds.depth / 2),
    width: doorType === 'sliding' ? 120 : 90,
    height: 205,
    orientation: wall?.orientation ?? 'horizontal',
    hinge: 'start',
    openSide: -1,
    slideDirection: 'end',
    openAngle: 0,
    openRatio: 0,
    wallId: wall?.id ?? null,
  };
  if (isMobileLayout()) mobilePanel = 'canvas';
  updateState({ structures: [...state.structures, door], selection: { kind: 'structure', id: door.id } });
}

function addWindow() {
  const selected = state.selection?.kind === 'structure' ? selectedEntity() : null;
  const wall = selected?.type === 'wall'
    ? selected
    : selected?.wallId
      ? state.structures.find((structure) => structure.id === selected.wallId && structure.type === 'wall')
      : null;
  const attachedOpeningCount = wall
    ? state.structures.filter((structure) => structure.type !== 'wall' && structure.wallId === wall.id).length
    : 0;
  const wallOffset = wall ? [-wall.length / 4, wall.length / 4, 0][attachedOpeningCount] ?? 0 : 0;
  const bounds = getLayoutBounds(state.zones);
  const availableHeight = wall?.height ?? state.wallHeight;
  const sillHeight = Math.min(90, Math.max(0, availableHeight - 50));
  const height = Math.min(120, Math.max(50, availableHeight - sillHeight));
  const width = wall ? Math.max(60, Math.min(160, wall.length)) : 160;
  const windowStructure = {
    id: uid('window'),
    type: 'window',
    name: `미닫이창 ${state.structures.filter((structure) => structure.type === 'window').length + 1}`,
    x: wall ? wall.x + (wall.orientation === 'horizontal' ? wallOffset : 0) : snap(bounds.left + bounds.width / 2),
    y: wall ? wall.y + (wall.orientation === 'vertical' ? wallOffset : 0) : snap(bounds.top),
    width,
    height,
    sillHeight,
    orientation: wall?.orientation ?? 'horizontal',
    slideDirection: 'end',
    openRatio: 0,
    wallId: wall?.id ?? null,
  };
  if (isMobileLayout()) mobilePanel = 'canvas';
  const structures = state.structures.map((structure) => (
    structure.id === wall?.id && structure.length < width ? { ...structure, length: width } : structure
  ));
  updateState({ structures: [...structures, windowStructure], selection: { kind: 'structure', id: windowStructure.id } });
}

function deleteSelectedZonePart() {
  if (state.selection?.kind !== 'zone') return;
  if (selectedEntity()?.locked) {
    editorNotice = '잠긴 공간 조각은 삭제할 수 없습니다.';
    render();
    return;
  }
  updateState({ zones: state.zones.filter((zone) => zone.id !== state.selection.id), selection: null });
}

function deleteSelectedSpace() {
  if (state.selection?.kind !== 'zone') return;
  const selected = selectedEntity();
  if (!selected) return;
  const spaceId = spaceIdOf(selected);
  if (state.zones.some((zone) => spaceIdOf(zone) === spaceId && zone.locked)) {
    editorNotice = '잠긴 조각이 있는 공간은 삭제할 수 없습니다.';
    render();
    return;
  }
  updateState({ zones: state.zones.filter((zone) => spaceIdOf(zone) !== spaceId), selection: null });
}

function deleteSelection() {
  const entries = selectedEntries().filter(({ entity }) => !entity.locked);
  if (!entries.length) {
    editorNotice = '잠긴 대상은 삭제할 수 없습니다.';
    render();
    return;
  }
  const zoneIds = new Set(entries.filter((entry) => entry.kind === 'zone').map((entry) => entry.id));
  const itemIds = new Set(entries.filter((entry) => entry.kind === 'item').map((entry) => entry.id));
  const structureIds = new Set(entries.filter((entry) => entry.kind === 'structure').map((entry) => entry.id));
  const dimensionIds = new Set(entries.filter((entry) => entry.kind === 'dimension').map((entry) => entry.id));
  state.structures
    .filter((structure) => structure.locked && structure.wallId)
    .forEach((structure) => structureIds.delete(structure.wallId));
  updateState({
    zones: state.zones.filter((zone) => !zoneIds.has(zone.id)),
    items: state.items.filter((item) => !itemIds.has(item.id)),
    structures: state.structures.filter((structure) => (
      !structureIds.has(structure.id) && !structureIds.has(structure.wallId)
    )),
    dimensions: state.dimensions.filter((dimension) => !dimensionIds.has(dimension.id)),
    selection: null,
  });
}

function clearUnlockedFurniture() {
  const remainingItems = state.items.filter((item) => item.locked);
  const selectedItemRemoved = state.selection?.kind === 'item'
    && !remainingItems.some((item) => item.id === state.selection.id);
  editorNotice = remainingItems.length
    ? `잠긴 가구 ${remainingItems.length}개를 남기고 비웠습니다.`
    : '가구를 모두 비웠습니다.';
  updateState({
    items: remainingItems,
    selection: selectedItemRemoved ? null : state.selection,
  });
}

function svgPoint(event) {
  const svg = document.querySelector('#plan-canvas');
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
}

function pointerMidpoint(first, second) {
  return { x: (first.clientX + second.clientX) / 2, y: (first.clientY + second.clientY) / 2 };
}

function pointerDistance(first, second) {
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function svgPointFromClient(point) {
  const svg = document.querySelector('#plan-canvas');
  const svgPointValue = svg.createSVGPoint();
  svgPointValue.x = point.x;
  svgPointValue.y = point.y;
  return svgPointValue.matrixTransform(svg.getScreenCTM().inverse());
}

function editorContentBounds() {
  const bounds = [getLayoutBounds(state.zones)];
  if (state.backgroundPlan) {
    bounds.push({
      left: state.backgroundPlan.x,
      right: state.backgroundPlan.x + state.backgroundPlan.width,
      top: state.backgroundPlan.y,
      bottom: state.backgroundPlan.y + state.backgroundPlan.depth,
    });
  }
  state.dimensions.forEach((dimension) => bounds.push({
    left: Math.min(dimension.x1, dimension.x2),
    right: Math.max(dimension.x1, dimension.x2),
    top: Math.min(dimension.y1, dimension.y2),
    bottom: Math.max(dimension.y1, dimension.y2),
  }));
  const combined = unionBounds(bounds);
  return {
    ...combined,
    width: Math.max(1, combined.right - combined.left),
    depth: Math.max(1, combined.bottom - combined.top),
  };
}

function canvasBaseViewBox() {
  const bounds = editorContentBounds();
  return {
    left: bounds.left - CANVAS_PADDING,
    top: bounds.top - CANVAS_PADDING,
    width: bounds.width + CANVAS_PADDING * 2,
    height: bounds.depth + CANVAS_PADDING * 2,
  };
}

function currentCanvasViewBox() {
  return getZoomViewBox(canvasBaseViewBox(), canvasZoom, canvasCenter);
}

function applyCanvasView() {
  const viewBox = currentCanvasViewBox();
  document.querySelector('#plan-canvas')?.setAttribute('viewBox', `${viewBox.left} ${viewBox.top} ${viewBox.width} ${viewBox.height}`);
  const background = document.querySelector('.grid-background');
  if (background) {
    background.setAttribute('x', viewBox.left);
    background.setAttribute('y', viewBox.top);
    background.setAttribute('width', viewBox.width);
    background.setAttribute('height', viewBox.height);
  }
  const label = document.querySelector('#zoom-level');
  if (label) label.textContent = `${Math.round(canvasZoom * 100)}%`;
}

function applyCanvasViewBox(viewBox) {
  const base = canvasBaseViewBox();
  canvasZoom = clampZoom(base.width / viewBox.width, MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM);
  canvasCenter = {
    x: viewBox.left + viewBox.width / 2,
    y: viewBox.top + viewBox.height / 2,
  };
  applyCanvasView();
}

function setCanvasZoom(nextZoom, anchorEvent = null) {
  if (drag || resize || rotateGesture || marquee || backgroundDrag || gestureMode === 'pinch') return;
  const current = currentCanvasViewBox();
  const anchor = anchorEvent
    ? svgPoint(anchorEvent)
    : { x: current.left + current.width / 2, y: current.top + current.height / 2 };
  canvasZoom = clampZoom(nextZoom, MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM);
  const next = getAnchoredZoomViewBox(canvasBaseViewBox(), current, canvasZoom, anchor);
  canvasCenter = {
    x: next.left + next.width / 2,
    y: next.top + next.height / 2,
  };
  applyCanvasView();
}

function resetCanvasZoom() {
  canvasZoom = 1;
  canvasCenter = null;
  applyCanvasView();
}

function zoomCanvasWithWheel(event) {
  event.preventDefault();
  setCanvasZoom(canvasZoom * Math.exp(-event.deltaY * 0.0015), event);
}

function unionBounds(boundsList) {
  return {
    left: Math.min(...boundsList.map((bounds) => bounds.left)),
    right: Math.max(...boundsList.map((bounds) => bounds.right)),
    top: Math.min(...boundsList.map((bounds) => bounds.top)),
    bottom: Math.max(...boundsList.map((bounds) => bounds.bottom)),
  };
}

function cancelEntityPress() {
  if (entityPress?.timer) window.clearTimeout(entityPress.timer);
  entityPress = null;
}

function dismissMobileContextMenuForGesture() {
  mobileContextMenu = null;
  document.querySelector('.mobile-context-menu')?.remove();
}

function closeMobileContextMenu() {
  mobileContextMenu = null;
  pendingFocus = { kind: 'canvas' };
  render();
}

function syncSelectionClasses() {
  const selectedSpaceIds = new Set(selectedEntries()
    .filter((entry) => entry.kind === 'zone')
    .map((entry) => spaceIdOf(entry.entity)));
  document.querySelectorAll('[data-zone-id]').forEach((node) => {
    const zone = state.zones.find((entry) => entry.id === node.dataset.zoneId);
    node.classList.toggle('is-selected', Boolean(zone && isSelected('zone', zone.id)));
    node.classList.toggle('is-space-selected', Boolean(zone && selectedSpaceIds.has(spaceIdOf(zone))));
  });
  document.querySelectorAll('[data-item-id]').forEach((node) => {
    node.classList.toggle('is-selected', isSelected('item', node.dataset.itemId));
  });
  document.querySelectorAll('[data-structure-id]').forEach((node) => {
    node.classList.toggle('is-selected', isSelected('structure', node.dataset.structureId));
  });
  document.querySelectorAll('[data-dimension-id]').forEach((node) => {
    node.classList.toggle('is-selected', isSelected('dimension', node.dataset.dimensionId));
  });
}

function syncValidationClasses() {
  const collisions = findCollisions(state.items);
  const outOfBounds = findOutOfBounds(state.items, state.zones);
  const heightViolations = findHeightViolations(state.items, state.zones, state.wallHeight);
  const zoneOverlaps = findZoneOverlaps(state.zones);
  document.querySelectorAll('[data-zone-id]').forEach((node) => {
    node.classList.toggle('has-overlap', zoneOverlaps.has(node.dataset.zoneId));
  });
  document.querySelectorAll('[data-item-id]').forEach((node) => {
    const id = node.dataset.itemId;
    node.classList.toggle('has-collision', collisions.has(id));
    node.classList.toggle('is-outside', outOfBounds.has(id));
    node.classList.toggle('is-too-tall', heightViolations.has(id));
  });
}

function syncAlignmentGuides() {
  const svg = document.querySelector('#plan-canvas');
  if (!svg) return;
  svg.querySelectorAll('.alignment-guide').forEach((guide) => guide.remove());
  const bounds = getLayoutBounds(state.zones);
  alignmentGuides.forEach((guide) => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('class', 'alignment-guide');
    if (guide.orientation === 'vertical') {
      line.setAttribute('x1', guide.position);
      line.setAttribute('x2', guide.position);
      line.setAttribute('y1', bounds.top - CANVAS_PADDING);
      line.setAttribute('y2', bounds.bottom + CANVAS_PADDING);
    } else {
      line.setAttribute('x1', bounds.left - CANVAS_PADDING);
      line.setAttribute('x2', bounds.right + CANVAS_PADDING);
      line.setAttribute('y1', guide.position);
      line.setAttribute('y2', guide.position);
    }
    svg.append(line);
  });
}

function transformHudContent(mode = 'selected') {
  const modeLabels = {
    selected: '선택됨',
    move: '이동 중',
    resize: '크기 조절 중',
    rotate: '회전 중',
  };
  if (!selectionKeys.size) return null;
  if (selectionKeys.size > 1) {
    const lockedCount = selectedEntries().filter(({ entity }) => entity.locked).length;
    return {
      label: modeLabels[mode] ?? modeLabels.selected,
      primary: `${selectionKeys.size}개 함께 선택`,
      secondary: mode === 'move' && drag
        ? `ΔX ${Math.round(drag.currentDelta.x)} · ΔY ${Math.round(drag.currentDelta.y)}cm`
        : lockedCount ? `${lockedCount}개 잠김 · 나머지만 이동` : '본체를 끌어 함께 이동',
    };
  }
  const entity = selectedEntity();
  if (!entity || !state.selection) return null;
  const lockLabel = entity.locked ? ' · 잠김' : '';
  if (state.selection.kind === 'zone') {
    return {
      label: modeLabels[mode] ?? modeLabels.selected,
      primary: `${Math.round(entity.width)} × ${Math.round(entity.depth)}cm`,
      secondary: `X ${Math.round(entity.x)} · Y ${Math.round(entity.y)} · H ${Math.round(entity.height ?? 240)}cm${lockLabel}`,
    };
  }
  if (state.selection.kind === 'structure') {
    const size = entity.type === 'wall' ? entity.length : entity.width;
    return {
      label: modeLabels[mode] ?? modeLabels.selected,
      primary: `${STRUCTURE_LABELS[entity.type]} ${Math.round(size)}cm`,
      secondary: `X ${Math.round(entity.x)} · Y ${Math.round(entity.y)} · ${ORIENTATIONS[entity.orientation]}${lockLabel}`,
    };
  }
  if (state.selection.kind === 'dimension') {
    return {
      label: modeLabels[mode] ?? modeLabels.selected,
      primary: formatMeasurement(measurementLength(
        { x: entity.x1, y: entity.y1 },
        { x: entity.x2, y: entity.y2 },
      )),
      secondary: `${entity.name}${lockLabel}`,
    };
  }
  return {
    label: modeLabels[mode] ?? modeLabels.selected,
    primary: `${Math.round(entity.width)} × ${Math.round(entity.depth)}cm`,
    secondary: `X ${Math.round(entity.x)} · Y ${Math.round(entity.y)} · ${Math.round(entity.rotation)}°${lockLabel}`,
  };
}

function renderTransformHud() {
  const content = transformHudContent();
  if (!content) return '';
  return `<div class="transform-hud" data-transform-hud data-mode="selected" aria-hidden="true">
    <span data-transform-label>${content.label}</span>
    <strong data-transform-primary>${content.primary}</strong>
    <small data-transform-secondary>${content.secondary}</small>
  </div>`;
}

function syncTransformHud(mode) {
  const hud = document.querySelector('[data-transform-hud]');
  const content = transformHudContent(mode);
  if (!hud || !content) return;
  hud.dataset.mode = mode;
  hud.querySelector('[data-transform-label]').textContent = content.label;
  hud.querySelector('[data-transform-primary]').textContent = content.primary;
  hud.querySelector('[data-transform-secondary]').textContent = content.secondary;
}

function syncMarqueePreview() {
  const svg = document.querySelector('#plan-canvas');
  if (!svg) return;
  svg.querySelector('.selection-marquee')?.remove();
  if (!marquee?.hasMoved) return;
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('class', 'selection-marquee');
  rect.setAttribute('x', Math.min(marquee.start.x, marquee.current.x));
  rect.setAttribute('y', Math.min(marquee.start.y, marquee.current.y));
  rect.setAttribute('width', Math.abs(marquee.current.x - marquee.start.x));
  rect.setAttribute('height', Math.abs(marquee.current.y - marquee.start.y));
  svg.append(rect);
}

function syncCanvasPreviewFromState() {
  document.querySelectorAll('[data-zone-id]').forEach((node) => node.removeAttribute('transform'));
  document.querySelectorAll('.space-outline').forEach((node) => node.removeAttribute('visibility'));
  document.querySelector('.group-selection-bounds')?.removeAttribute('transform');
  state.items.forEach((item) => {
    document.querySelector(`[data-item-id="${item.id}"]`)
      ?.setAttribute('transform', `translate(${item.x} ${item.y}) rotate(${item.rotation})`);
  });
  state.structures.forEach((structure) => {
    document.querySelector(`[data-structure-id="${structure.id}"]`)
      ?.setAttribute('transform', `translate(${structure.x} ${structure.y}) rotate(${structure.orientation === 'vertical' ? 90 : 0})`);
  });
  const overlay = document.querySelector('.resize-overlay');
  if (overlay) {
    const selected = selectedEntity();
    if (state.selection?.kind === 'item' && selected) {
      overlay.setAttribute('transform', `translate(${selected.x} ${selected.y}) rotate(${selected.rotation})`);
    } else {
      overlay.removeAttribute('transform');
    }
  }
  alignmentGuides = [];
  syncAlignmentGuides();
  document.querySelector('.selection-marquee')?.remove();
  syncSelectionClasses();
  syncValidationClasses();
}

function syncDragPreview() {
  if (!drag) return;
  document.querySelector('.group-selection-bounds')
    ?.setAttribute('transform', `translate(${drag.currentDelta.x} ${drag.currentDelta.y})`);
  if (drag.zoneOrigins.size) {
    document.querySelectorAll('.space-outline').forEach((node) => node.setAttribute('visibility', 'hidden'));
  }
  drag.zoneOrigins.forEach((_, id) => {
    document.querySelector(`[data-zone-id="${id}"]`)
      ?.setAttribute('transform', `translate(${drag.currentDelta.x} ${drag.currentDelta.y})`);
  });
  drag.itemOrigins.forEach((_, id) => {
    const item = state.items.find((entry) => entry.id === id);
    if (!item) return;
    document.querySelector(`[data-item-id="${id}"]`)
      ?.setAttribute('transform', `translate(${item.x} ${item.y}) rotate(${item.rotation})`);
  });
  drag.structureOrigins.forEach((_, id) => {
    const structure = state.structures.find((entry) => entry.id === id);
    if (!structure) return;
    document.querySelector(`[data-structure-id="${id}"]`)
      ?.setAttribute('transform', `translate(${structure.x} ${structure.y}) rotate(${structure.orientation === 'vertical' ? 90 : 0})`);
  });
  syncAlignmentGuides();
  syncTransformHud('move');
  syncValidationClasses();
}

function syncResizePreview() {
  if (!resize) return;
  const collection = resize.kind === 'zone' ? state.zones : resize.kind === 'item' ? state.items : state.structures;
  const entity = collection.find((entry) => entry.id === resize.id);
  const node = document.querySelector(`[data-${resize.kind === 'zone' ? 'zone' : resize.kind === 'item' ? 'item' : 'structure'}-id="${resize.id}"]`);
  const overlay = document.querySelector('.resize-overlay');
  if (!entity || !node) return;
  if (resize.kind === 'zone') {
    document.querySelectorAll('.space-outline').forEach((outline) => outline.setAttribute('visibility', 'hidden'));
  }
  if (resize.kind === 'structure') {
    const currentSize = entity.type === 'wall' ? entity.length : entity.width;
    const originSize = resize.origin.type === 'wall' ? resize.origin.length : resize.origin.width;
    const transform = `translate(${entity.x} ${entity.y}) rotate(${entity.orientation === 'vertical' ? 90 : 0}) scale(${currentSize / originSize} 1)`;
    node.setAttribute('transform', transform);
    overlay?.setAttribute('transform', transform);
    syncTransformHud('resize');
    return;
  }
  const scaleX = entity.width / resize.origin.width;
  const scaleY = entity.depth / resize.origin.depth;
  if (resize.kind === 'zone') {
    const translateX = entity.x - resize.origin.x * scaleX;
    const translateY = entity.y - resize.origin.y * scaleY;
    const transform = `matrix(${scaleX} 0 0 ${scaleY} ${translateX} ${translateY})`;
    node.setAttribute('transform', transform);
    overlay?.setAttribute('transform', transform);
  } else {
    const transform = `translate(${entity.x} ${entity.y}) rotate(${entity.rotation}) scale(${scaleX} ${scaleY})`;
    node.setAttribute('transform', transform);
    overlay?.setAttribute('transform', transform);
  }
  syncTransformHud('resize');
  syncValidationClasses();
}

function syncRotatePreview() {
  if (!rotateGesture) return;
  const item = state.items.find((entry) => entry.id === rotateGesture.id);
  if (!item) return;
  document.querySelector(`[data-item-id="${item.id}"]`)
    ?.setAttribute('transform', `translate(${item.x} ${item.y}) rotate(${item.rotation})`);
  document.querySelector('.resize-overlay')
    ?.setAttribute('transform', `translate(${item.x} ${item.y}) rotate(${item.rotation})`);
  const control = document.querySelector(`[data-item-rotate="${item.id}"]`);
  control?.setAttribute('aria-valuenow', String(Math.round(item.rotation)));
  control?.setAttribute('aria-valuetext', `${Math.round(item.rotation)}도`);
  syncTransformHud('rotate');
  syncValidationClasses();
}

function resetTemporaryGestureState() {
  cancelEntityPress();
  drag = null;
  resize = null;
  rotateGesture = null;
  marquee = null;
  backgroundDrag = null;
  pan = null;
  pinch = null;
  alignmentGuides = [];
}

function restoreGestureSnapshot() {
  if (drag?.historySnapshot) {
    state = { ...state, ...drag.historySnapshot };
    selectionKeys = getRolledBackSelection(drag.selectionSnapshot);
    state.selection = drag.primarySelectionSnapshot ? { ...drag.primarySelectionSnapshot } : null;
    mobileMoveArmed = drag.moveArmedSnapshot;
  } else if (resize?.historySnapshot) {
    state = { ...state, ...resize.historySnapshot };
  } else if (rotateGesture?.historySnapshot) {
    state = { ...state, ...rotateGesture.historySnapshot };
  } else if (backgroundDrag?.historySnapshot) {
    state = { ...state, ...backgroundDrag.historySnapshot };
  } else if (marquee) {
    selectionKeys = getRolledBackSelection(marquee.baseSelection);
    const primary = selectedEntries().at(-1);
    state.selection = primary ? { kind: primary.kind, id: primary.id } : null;
  }
}

function cancelTemporaryGesture(options = {}) {
  if (options.rollback !== false) restoreGestureSnapshot();
  resetTemporaryGestureState();
  gestureMode = activePointers.size ? 'idle-await-release' : 'idle';
  render();
}

function recordPointer(event) {
  activePointers.set(event.pointerId, {
    clientX: event.clientX,
    clientY: event.clientY,
    pointerType: event.pointerType,
  });
}

function captureActivePointers(event) {
  const svg = document.querySelector('#plan-canvas');
  activePointers.forEach((_, pointerId) => {
    try {
      svg.setPointerCapture(pointerId);
    } catch {
      try {
        event.currentTarget?.setPointerCapture?.(pointerId);
      } catch {
        // Pointer capture is best-effort; document-level listeners still own state cleanup.
      }
    }
  });
}

function startPinch(event) {
  restoreGestureSnapshot();
  syncCanvasPreviewFromState();
  resetTemporaryGestureState();
  const pointers = [...activePointers.values()].filter((pointer) => pointer.pointerType === 'touch').slice(0, 2);
  if (pointers.length < 2) return false;
  const midpoint = pointerMidpoint(pointers[0], pointers[1]);
  pinch = {
    startViewBox: currentCanvasViewBox(),
    startZoom: canvasZoom,
    startDistance: Math.max(1, pointerDistance(pointers[0], pointers[1])),
    startMidpoint: midpoint,
    anchor: svgPointFromClient(midpoint),
  };
  gestureMode = 'pinch';
  captureActivePointers(event);
  return true;
}

function beginPointerContact(event) {
  if (event.pointerType === 'touch') recordPointer(event);
  if (gestureMode === 'idle-await-release') return false;
  if ([...activePointers.values()].filter((pointer) => pointer.pointerType === 'touch').length >= 2) {
    startPinch(event);
    return false;
  }
  return true;
}

function startPan(event) {
  if (event.button !== undefined && event.button !== 0) return;
  if (!beginPointerContact(event)) return;
  event.preventDefault();
  pan = {
    startClient: { x: event.clientX, y: event.clientY },
    startViewBox: currentCanvasViewBox(),
    hasMoved: false,
  };
  gestureMode = 'pan';
  captureActivePointers(event);
}

function movePan(event) {
  if (!pan) return;
  const movement = {
    x: event.clientX - pan.startClient.x,
    y: event.clientY - pan.startClient.y,
  };
  if (!pan.hasMoved && Math.hypot(movement.x, movement.y) < TOUCH_SLOP_PX) return;
  pan.hasMoved = true;
  const svg = document.querySelector('#plan-canvas');
  const rect = svg.getBoundingClientRect();
  applyCanvasViewBox(getPannedViewBox(pan.startViewBox, movement, { width: rect.width, height: rect.height }));
}

function movePinch() {
  if (!pinch) return;
  const pointers = [...activePointers.values()].filter((pointer) => pointer.pointerType === 'touch').slice(0, 2);
  if (pointers.length < 2) return;
  const svg = document.querySelector('#plan-canvas');
  const rect = svg.getBoundingClientRect();
  const result = getPinchViewBox(canvasBaseViewBox(), pinch.startViewBox, pinch.startZoom, {
    anchor: pinch.anchor,
    startDistance: pinch.startDistance,
    currentDistance: Math.max(1, pointerDistance(pointers[0], pointers[1])),
    startMidpoint: pinch.startMidpoint,
    currentMidpoint: pointerMidpoint(pointers[0], pointers[1]),
  }, { width: rect.width, height: rect.height }, MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM);
  canvasZoom = result.zoom;
  canvasCenter = {
    x: result.viewBox.left + result.viewBox.width / 2,
    y: result.viewBox.top + result.viewBox.height / 2,
  };
  applyCanvasView();
}

function finishPointerContact(event) {
  activePointers.delete(event.pointerId);
  if (gestureMode === 'pinch') {
    pinch = null;
    gestureMode = 'idle-await-release';
    return true;
  }
  if (gestureMode === 'idle-await-release') {
    if (!activePointers.size) gestureMode = 'idle';
    return true;
  }
  if (gestureMode === 'pan') {
    const wasTap = !pan?.hasMoved;
    pan = null;
    gestureMode = activePointers.size ? 'idle-await-release' : 'idle';
    if (wasTap) clearSelection();
    return true;
  }
  if (!activePointers.size && !drag && !resize && !rotateGesture && !marquee && !backgroundDrag) gestureMode = 'idle';
  return false;
}

function startBackgroundDrag(event) {
  if (!state.backgroundPlan || state.backgroundPlan.locked || precisionTool) return;
  if (event.button !== undefined && event.button !== 0) return;
  if (!beginPointerContact(event)) return;
  event.preventDefault();
  event.stopPropagation();
  backgroundDrag = {
    startPointer: svgPoint(event),
    origin: { ...state.backgroundPlan },
    historySnapshot: layoutSnapshot(),
    hasMoved: false,
  };
  gestureMode = 'edit';
  captureActivePointers(event);
}

function moveBackgroundDrag(event) {
  if (!backgroundDrag) return;
  const point = svgPoint(event);
  const delta = {
    x: point.x - backgroundDrag.startPointer.x,
    y: point.y - backgroundDrag.startPointer.y,
  };
  if (!backgroundDrag.hasMoved && Math.hypot(delta.x, delta.y) < 1) return;
  backgroundDrag.hasMoved = true;
  state.backgroundPlan = {
    ...state.backgroundPlan,
    x: backgroundDrag.origin.x + delta.x,
    y: backgroundDrag.origin.y + delta.y,
  };
  const image = document.querySelector('[data-background-plan]');
  image?.setAttribute('x', state.backgroundPlan.x);
  image?.setAttribute('y', state.backgroundPlan.y);
}

function finishBackgroundDrag() {
  if (!backgroundDrag) return;
  const previous = backgroundDrag.historySnapshot;
  if (backgroundDrag.hasMoved) {
    state.backgroundPlan = {
      ...state.backgroundPlan,
      x: snap(state.backgroundPlan.x),
      y: snap(state.backgroundPlan.y),
    };
    commitHistory(previous);
    saveState();
  }
  backgroundDrag = null;
  gestureMode = activePointers.size ? 'idle-await-release' : 'idle';
  render();
}

function startDrag(event, kind, id, options = {}) {
  if (event.button !== undefined && event.button !== 0) return;
  const collection = kind === 'zone' ? state.zones : kind === 'item' ? state.items : state.structures;
  const entity = collection.find((entry) => entry.id === id);
  if (!entity) return;
  if (entity.locked) {
    event.preventDefault();
    selectEntity(kind, id, options.additive ?? usesAdditiveSelection(event));
    editorNotice = `${entity.name}은(는) 잠겨 있습니다.`;
    render();
    return;
  }
  if (!options.contactStarted && !beginPointerContact(event)) return;
  event.preventDefault();
  const selectionSnapshot = options.selectionSnapshot ?? new Set(selectionKeys);
  const primarySelectionSnapshot = options.primarySelectionSnapshot
    ?? (state.selection ? { ...state.selection } : null);
  const moveArmedSnapshot = options.moveArmedSnapshot ?? mobileMoveArmed;
  const additive = options.additive ?? usesAdditiveSelection(event);
  const key = selectionKey(kind, id);
  const deferredToggle = options.deferToggle === false
    ? null
    : additive && selectionKeys.has(key) ? { kind, id } : null;
  if (deferredToggle) {
    state.selection = { kind, id };
  } else if (additive) {
    selectEntity(kind, id, true);
  } else if (!isSelected(kind, id)) {
    selectEntity(kind, id);
  }
  const point = svgPoint(event);
  const entries = selectedEntries().filter((entry) => !entry.entity.locked);
  const zoneOrigins = new Map(entries.filter((entry) => entry.kind === 'zone').map((entry) => [entry.id, { ...entry.entity }]));
  const itemOrigins = new Map(entries.filter((entry) => entry.kind === 'item').map((entry) => [entry.id, { ...entry.entity }]));
  const structureOrigins = new Map(entries.filter((entry) => entry.kind === 'structure').map((entry) => [entry.id, { ...entry.entity }]));
  structureOrigins.forEach((structure) => {
    if (structure.type !== 'wall') return;
    state.structures.filter((entry) => entry.wallId === structure.id).forEach((opening) => {
      if (!structureOrigins.has(opening.id)) structureOrigins.set(opening.id, { ...opening });
    });
  });
  zoneOrigins.forEach((zone) => {
    state.items.filter((item) => !item.locked && pointInZone({ x: item.x, y: item.y }, zone)).forEach((item) => {
      if (!itemOrigins.has(item.id)) itemOrigins.set(item.id, { ...item });
    });
  });
  const movingBounds = [
    ...[...zoneOrigins.values()].map(zoneBounds),
    ...[...itemOrigins.values()].map(itemBounds),
    ...[...structureOrigins.values()].map(structureBounds),
  ];
  const targetBounds = [
    ...state.zones.filter((zone) => !zoneOrigins.has(zone.id)).map(zoneBounds),
    ...state.items.filter((item) => !itemOrigins.has(item.id)).map(itemBounds),
    ...state.structures.filter((structure) => !structureOrigins.has(structure.id)).map(structureBounds),
  ];
  drag = {
    kind,
    id,
    startPointer: point,
    primaryOrigin: { x: entity.x, y: entity.y },
    zoneOrigins,
    itemOrigins,
    structureOrigins,
    groupBounds: unionBounds(movingBounds),
    targetBounds,
    currentDelta: { x: 0, y: 0 },
    hasMoved: false,
    deferredToggle,
    snapX: false,
    snapY: false,
    historySnapshot: layoutSnapshot(),
    selectionSnapshot,
    primarySelectionSnapshot,
    moveArmedSnapshot,
  };
  dismissMobileContextMenuForGesture();
  mobileMoveArmed = false;
  gestureMode = 'edit';
  syncSelectionClasses();
  captureActivePointers(event);
}

function beginLongPressDrag() {
  if (!entityPress || entityPress.moved || activePointers.size !== 1) return;
  const press = entityPress;
  entityPress = null;
  const additive = mobileMultiSelect && !isSelected(press.kind, press.id);
  if (!isSelected(press.kind, press.id)) selectEntity(press.kind, press.id, additive);
  startDrag(press.event, press.kind, press.id, {
    contactStarted: true,
    additive: false,
    deferToggle: false,
    selectionSnapshot: press.selectionSnapshot,
    primarySelectionSnapshot: press.primarySelectionSnapshot,
    moveArmedSnapshot: press.moveArmedSnapshot,
  });
}

function startEntityPress(event, kind, id) {
  const collection = kind === 'zone' ? state.zones : kind === 'item' ? state.items : state.structures;
  const entity = collection.find((entry) => entry.id === id);
  if (entity?.locked) {
    event.preventDefault();
    event.stopPropagation();
    selectEntity(kind, id, usesAdditiveSelection(event));
    mobileContextMenu = isMobileLayout() ? { kind, id } : null;
    editorNotice = `${entity.name}은(는) 잠겨 있습니다.`;
    render();
    return;
  }
  if (event.pointerType !== 'touch' || !isMobileLayout()) {
    startDrag(event, kind, id);
    return;
  }
  if (event.button !== undefined && event.button !== 0) return;
  if (!beginPointerContact(event)) return;
  event.preventDefault();
  event.stopPropagation();
  const selectionSnapshot = new Set(selectionKeys);
  const primarySelectionSnapshot = state.selection ? { ...state.selection } : null;
  const moveArmedSnapshot = mobileMoveArmed;
  const pressEvent = {
    button: 0,
    pointerId: event.pointerId,
    pointerType: 'touch',
    clientX: event.clientX,
    clientY: event.clientY,
    shiftKey: false,
    preventDefault() {},
    currentTarget: event.currentTarget,
  };
  if (mobileMoveArmed && isSelected(kind, id)) {
    startDrag(pressEvent, kind, id, {
      contactStarted: true,
      additive: false,
      deferToggle: false,
      selectionSnapshot,
      primarySelectionSnapshot,
      moveArmedSnapshot,
    });
    return;
  }
  cancelEntityPress();
  entityPress = {
    kind,
    id,
    pointerId: event.pointerId,
    startClient: { x: event.clientX, y: event.clientY },
    event: pressEvent,
    moved: false,
    initiallySelected: isSelected(kind, id),
    selectionSnapshot,
    primarySelectionSnapshot,
    moveArmedSnapshot,
    timer: window.setTimeout(beginLongPressDrag, MOBILE_LONG_PRESS_MS),
  };
  gestureMode = 'press';
  captureActivePointers(event);
}

function finishEntityPress(event) {
  if (!entityPress || entityPress.pointerId !== event.pointerId) return false;
  const press = entityPress;
  cancelEntityPress();
  if (press.moved) return true;
  mobileMoveArmed = false;
  if (mobileMultiSelect) {
    selectEntity(press.kind, press.id, true);
    mobileContextMenu = null;
  } else {
    if (press.initiallySelected && isSelected(press.kind, press.id)) {
      state.selection = { kind: press.kind, id: press.id };
    } else {
      selectEntity(press.kind, press.id);
    }
    mobileContextMenu = { kind: press.kind, id: press.id };
    pendingFocus = { kind: 'context-menu' };
  }
  return true;
}

function startItemRotation(event, id) {
  if (event.button !== undefined && event.button !== 0) return;
  if (!beginPointerContact(event)) return;
  event.preventDefault();
  event.stopPropagation();
  const item = state.items.find((entry) => entry.id === id);
  if (!item || item.locked) return;
  rotateGesture = {
    id,
    origin: { ...item },
    startPointer: svgPoint(event),
    hasMoved: false,
    historySnapshot: layoutSnapshot(),
  };
  gestureMode = 'rotate';
  dismissMobileContextMenuForGesture();
  captureActivePointers(event);
}

function moveItemRotation(event) {
  if (!rotateGesture) return;
  const point = svgPoint(event);
  const nextRotation = rotationFromPointer(
    { x: rotateGesture.origin.x, y: rotateGesture.origin.y },
    rotateGesture.origin.rotation,
    rotateGesture.startPointer,
    point,
    event.shiftKey ? 15 : 1,
  );
  rotateGesture.hasMoved ||= nextRotation !== rotateGesture.origin.rotation;
  state = {
    ...state,
    items: state.items.map((item) => item.id === rotateGesture.id
      ? { ...item, rotation: nextRotation }
      : item),
  };
  syncRotatePreview();
}

function finishItemRotation() {
  if (!rotateGesture) return;
  const previous = rotateGesture.historySnapshot;
  const changed = rotateGesture.hasMoved;
  rotateGesture = null;
  gestureMode = activePointers.size ? 'idle-await-release' : 'idle';
  if (changed) {
    commitHistory(previous);
    saveState();
  }
  render();
}

function startResize(event, kind, id, handle) {
  if (event.button !== undefined && event.button !== 0) return;
  if (!beginPointerContact(event)) return;
  event.preventDefault();
  event.stopPropagation();
  const collection = kind === 'zone' ? state.zones : kind === 'item' ? state.items : state.structures;
  const entity = collection.find((entry) => entry.id === id);
  if (!entity || entity.locked) return;
  resize = { kind, id, handle, origin: { ...entity }, historySnapshot: layoutSnapshot() };
  gestureMode = 'resize';
  dismissMobileContextMenuForGesture();
  captureActivePointers(event);
}

function moveResize(event) {
  if (!resize) return;
  const point = svgPoint(event);
  if (resize.kind === 'zone') {
    const resized = resizeZoneFromHandle(resize.origin, resize.handle, {
      x: snap(point.x),
      y: snap(point.y),
    });
    state = { ...state, zones: state.zones.map((zone) => zone.id === resize.id ? resized : zone) };
  } else if (resize.kind === 'item') {
    const resized = resizeItemFromHandle(resize.origin, resize.handle, point);
    state = { ...state, items: state.items.map((item) => item.id === resize.id ? resized : item) };
  } else {
    const attachedOpeningWidth = resize.origin.type === 'wall'
      ? Math.max(40, ...state.structures
        .filter((structure) => structure.type !== 'wall' && structure.wallId === resize.origin.id)
        .map((opening) => opening.width))
      : undefined;
    let resized = resizeStructureFromEndpoint(resize.origin, resize.handle, {
      x: snap(point.x),
      y: snap(point.y),
    }, attachedOpeningWidth);
    if (resized.type !== 'wall' && resized.wallId) {
      const wall = state.structures.find((structure) => structure.id === resized.wallId && structure.type === 'wall');
      if (wall) resized = alignDoorToWall({ ...resized, width: Math.min(resized.width, wall.length) }, wall);
    }
    state = { ...state, structures: state.structures.map((structure) => structure.id === resize.id ? resized : structure) };
  }
  syncResizePreview();
}

function finishResize() {
  if (!resize) return;
  const previous = resize.historySnapshot;
  if (resize.kind === 'item') {
    state.items = state.items.map((item) => item.id === resize.id ? {
      ...item,
      x: snap(item.x),
      y: snap(item.y),
      width: Math.max(20, snap(item.width)),
      depth: Math.max(20, snap(item.depth)),
    } : item);
  } else if (resize.kind === 'structure') {
    const walls = new Map(state.structures.filter((structure) => structure.type === 'wall').map((wall) => [wall.id, wall]));
    state.structures = state.structures.map((structure) => (
      structure.type !== 'wall' && walls.has(structure.wallId)
        ? alignDoorToWall(structure, walls.get(structure.wallId))
        : structure
    ));
  }
  resize = null;
  gestureMode = activePointers.size ? 'idle-await-release' : 'idle';
  commitHistory(previous);
  saveState();
  render();
}

function moveDrag(event) {
  if (!drag) return;
  const point = svgPoint(event);
  const rawDelta = { x: point.x - drag.startPointer.x, y: point.y - drag.startPointer.y };
  if (!drag.hasMoved && Math.hypot(rawDelta.x, rawDelta.y) < 1) return;
  drag.hasMoved = true;
  const snapped = getAlignmentSnap(drag.groupBounds, drag.targetBounds, rawDelta);
  drag.currentDelta = { x: snapped.x, y: snapped.y };
  drag.snapX = snapped.snapX;
  drag.snapY = snapped.snapY;
  alignmentGuides = snapped.guides;
  const movedStructureIds = new Set(drag.structureOrigins.keys());
  const movedStructures = state.structures.map((structure) => {
    const origin = drag.structureOrigins.get(structure.id);
    return origin ? { ...structure, x: origin.x + snapped.x, y: origin.y + snapped.y } : structure;
  });
  state = {
    ...state,
    zones: state.zones.map((zone) => {
      const origin = drag.zoneOrigins.get(zone.id);
      return origin ? { ...zone, x: origin.x + snapped.x, y: origin.y + snapped.y } : zone;
    }),
    items: state.items.map((item) => {
      const origin = drag.itemOrigins.get(item.id);
      return origin ? { ...item, x: origin.x + snapped.x, y: origin.y + snapped.y } : item;
    }),
    structures: settleMovedStructures(movedStructures, movedStructureIds),
  };
  syncDragPreview();
}

function finishDrag() {
  if (!drag) return;
  if (!drag.hasMoved) {
    if (drag.deferredToggle) {
      selectEntity(drag.deferredToggle.kind, drag.deferredToggle.id, true);
    }
    drag = null;
    alignmentGuides = [];
    gestureMode = activePointers.size ? 'idle-await-release' : 'idle';
    render();
    return;
  }
  const deltaX = drag.snapX ? drag.currentDelta.x : snap(drag.primaryOrigin.x + drag.currentDelta.x) - drag.primaryOrigin.x;
  const deltaY = drag.snapY ? drag.currentDelta.y : snap(drag.primaryOrigin.y + drag.currentDelta.y) - drag.primaryOrigin.y;
  state.zones = state.zones.map((zone) => {
    const origin = drag.zoneOrigins.get(zone.id);
    return origin ? { ...zone, x: origin.x + deltaX, y: origin.y + deltaY } : zone;
  });
  state.items = state.items.map((item) => {
    const origin = drag.itemOrigins.get(item.id);
    return origin ? { ...item, x: origin.x + deltaX, y: origin.y + deltaY } : item;
  });
  const movedStructureIds = new Set(drag.structureOrigins.keys());
  const movedStructures = state.structures.map((structure) => {
    const origin = drag.structureOrigins.get(structure.id);
    return origin ? { ...structure, x: origin.x + deltaX, y: origin.y + deltaY } : structure;
  });
  state.structures = settleMovedStructures(movedStructures, movedStructureIds);
  commitHistory(drag.historySnapshot);
  drag = null;
  alignmentGuides = [];
  gestureMode = activePointers.size ? 'idle-await-release' : 'idle';
  saveState();
  render();
}

function startMarquee(event) {
  if (event.button !== undefined && event.button !== 0) return;
  if ((event.pointerType === 'touch' || isMobileLayout()) && !mobileMultiSelect && !event.shiftKey) {
    startPan(event);
    return;
  }
  if (!beginPointerContact(event)) return;
  event.preventDefault();
  const point = svgPoint(event);
  marquee = {
    start: point,
    current: point,
    startClient: { x: event.clientX, y: event.clientY },
    hasMoved: false,
    movementThreshold: event.pointerType === 'touch' ? TOUCH_SLOP_PX : 1,
    additive: usesAdditiveSelection(event),
    baseSelection: new Set(usesAdditiveSelection(event) ? selectionKeys : []),
  };
  if (!usesAdditiveSelection(event)) {
    selectionKeys = new Set();
    state.selection = null;
  }
  gestureMode = 'marquee';
  syncSelectionClasses();
  captureActivePointers(event);
}

function moveMarquee(event) {
  if (!marquee) return;
  if (!marquee.hasMoved && Math.hypot(
    event.clientX - marquee.startClient.x,
    event.clientY - marquee.startClient.y,
  ) < marquee.movementThreshold) return;
  marquee.hasMoved = true;
  marquee.current = svgPoint(event);
  const selectionBounds = {
    left: Math.min(marquee.start.x, marquee.current.x),
    right: Math.max(marquee.start.x, marquee.current.x),
    top: Math.min(marquee.start.y, marquee.current.y),
    bottom: Math.max(marquee.start.y, marquee.current.y),
  };
  const nextSelection = new Set(marquee.baseSelection);
  const contains = (bounds) => (
    bounds.left >= selectionBounds.left && bounds.right <= selectionBounds.right
    && bounds.top >= selectionBounds.top && bounds.bottom <= selectionBounds.bottom
  );
  state.zones.forEach((zone) => {
    if (contains(zoneBounds(zone))) nextSelection.add(selectionKey('zone', zone.id));
  });
  state.items.forEach((item) => {
    if (contains(itemBounds(item))) nextSelection.add(selectionKey('item', item.id));
  });
  state.structures.forEach((structure) => {
    if (contains(structureBounds(structure))) nextSelection.add(selectionKey('structure', structure.id));
  });
  state.dimensions.forEach((dimension) => {
    if (contains(dimensionBounds(dimension))) nextSelection.add(selectionKey('dimension', dimension.id));
  });
  selectionKeys = nextSelection;
  const primary = selectedEntries().at(-1);
  state.selection = primary ? { kind: primary.kind, id: primary.id } : null;
  syncSelectionClasses();
  syncMarqueePreview();
}

function finishMarquee() {
  if (!marquee) return;
  const finished = marquee;
  const wasTap = !finished.hasMoved;
  marquee = null;
  gestureMode = activePointers.size ? 'idle-await-release' : 'idle';
  if (wasTap) {
    if (finished.additive) {
      selectionKeys = getRolledBackSelection(finished.baseSelection);
      const primary = selectedEntries().at(-1);
      state.selection = primary ? { kind: primary.kind, id: primary.id } : null;
      render();
    } else {
      clearSelection();
    }
  } else {
    render();
  }
}

function shapeMarkup(item, options = {}) {
  const x = -item.width / 2;
  const y = -item.depth / 2;
  const hitAttributes = options.hitTarget
    ? 'fill="none" stroke="transparent" stroke-width="44" vector-effect="non-scaling-stroke" pointer-events="stroke"'
    : '';
  if (item.shape === 'circle' || item.shape === 'ellipse') {
    return `<ellipse cx="0" cy="0" rx="${item.width / 2}" ry="${item.depth / 2}" ${hitAttributes} />`;
  }
  const radius = item.shape === 'roundRect' ? Math.min(item.width, item.depth) * 0.18 : 4;
  return `<rect x="${x}" y="${y}" width="${item.width}" height="${item.depth}" rx="${radius}" ${hitAttributes} />`;
}

function resizeHandlesMarkup(entity, kind) {
  const halfWidth = kind === 'item' ? entity.width / 2 : entity.width;
  const halfDepth = kind === 'item' ? entity.depth / 2 : entity.depth;
  const originX = kind === 'item' ? 0 : entity.x;
  const originY = kind === 'item' ? 0 : entity.y;
  const radius = isMobileLayout() ? 13 : 8;
  const positions = kind === 'item'
    ? {
        nw: [-halfWidth, -halfDepth], n: [0, -halfDepth], ne: [halfWidth, -halfDepth],
        e: [halfWidth, 0], se: [halfWidth, halfDepth], s: [0, halfDepth],
        sw: [-halfWidth, halfDepth], w: [-halfWidth, 0],
      }
    : {
        nw: [originX, originY], n: [originX + halfWidth / 2, originY], ne: [originX + halfWidth, originY],
        e: [originX + halfWidth, originY + halfDepth / 2], se: [originX + halfWidth, originY + halfDepth],
        s: [originX + halfWidth / 2, originY + halfDepth], sw: [originX, originY + halfDepth],
        w: [originX, originY + halfDepth / 2],
      };
  const frame = kind === 'item'
    ? `<rect class="transform-bounds" x="${-halfWidth}" y="${-halfDepth}" width="${entity.width}" height="${entity.depth}" />`
    : `<rect class="transform-bounds" x="${entity.x}" y="${entity.y}" width="${entity.width}" height="${entity.depth}" />`;
  const handles = Object.keys(RESIZE_DIRECTIONS).map((handle) => {
    const [x, y] = positions[handle];
    return `<circle class="resize-hit-target handle-${handle}" cx="${x}" cy="${y}" r="${radius}"
      fill="none" stroke="transparent" stroke-width="44" vector-effect="non-scaling-stroke" pointer-events="stroke"
      data-resize-kind="${kind}" data-resize-id="${entity.id}" data-resize-handle="${handle}"></circle>
    <circle class="resize-handle handle-${handle}" cx="${x}" cy="${y}" r="${radius}"
      data-resize-kind="${kind}" data-resize-id="${entity.id}" data-resize-handle="${handle}">
      <title>${handle} 방향 크기 조절</title></circle>`;
  }).join('');
  if (kind !== 'item') return `${frame}${handles}`;
  const rotateY = -halfDepth - (isMobileLayout() ? 54 : 42);
  return `${frame}${handles}
    <line class="item-rotate-stem" x1="0" y1="${-halfDepth}" x2="0" y2="${rotateY}" />
    <g class="item-rotate-control" data-item-rotate="${entity.id}" transform="translate(0 ${rotateY})"
      role="slider" tabindex="0" aria-label="${escapeHtml(entity.name)} 회전 각도" aria-valuemin="0" aria-valuemax="359"
      aria-valuenow="${Math.round(entity.rotation)}" aria-valuetext="${Math.round(entity.rotation)}도">
      <circle class="item-rotate-hit" r="${radius}"></circle>
      <circle class="item-rotate-handle" r="${radius}"></circle>
      <text y="4">↻</text><title>드래그하여 회전 · Shift를 누르면 15도 단위</title>
    </g>`;
}

function structureHandlesMarkup(entity) {
  const half = (entity.type === 'wall' ? entity.length : entity.width) / 2;
  const radius = isMobileLayout() ? 13 : 8;
  const endpoint = (handle, x) => `<circle class="resize-hit-target structure-endpoint-hit" cx="${x}" cy="0" r="${radius}"
      fill="none" stroke="transparent" stroke-width="44" vector-effect="non-scaling-stroke" pointer-events="stroke"
      data-resize-kind="structure" data-resize-id="${entity.id}" data-resize-handle="${handle}"></circle>
    <circle class="resize-handle structure-endpoint" cx="${x}" cy="0" r="${radius}"
      data-resize-kind="structure" data-resize-id="${entity.id}" data-resize-handle="${handle}">
      <title>${handle === 'start' ? '시작점' : '끝점'}을 움직여 ${entity.type === 'wall' ? '벽 길이' : `${STRUCTURE_LABELS[entity.type]} 너비`} 조절</title></circle>`;
  return `<line class="structure-transform-bounds" x1="${-half}" y1="0" x2="${half}" y2="0" />
    ${endpoint('start', -half)}${endpoint('end', half)}
    <g class="structure-rotate-control" data-structure-rotate="${entity.id}" transform="translate(0 -42)"
      role="button" tabindex="0" aria-label="${STRUCTURE_LABELS[entity.type]} 90도 회전">
      <circle class="structure-rotate-hit" r="${radius}"></circle>
      <circle class="structure-rotate-handle" r="${radius}"></circle>
      <text y="4">↻</text><title>90도 회전</title>
    </g>`;
}

function wallSegmentMarkup(segment) {
  return segment.orientation === 'horizontal'
    ? `<line x1="${segment.x1}" y1="${segment.y}" x2="${segment.x2}" y2="${segment.y}" />`
    : `<line x1="${segment.x}" y1="${segment.y1}" x2="${segment.x}" y2="${segment.y2}" />`;
}

function dimensionBounds(dimension) {
  return {
    left: Math.min(dimension.x1, dimension.x2),
    right: Math.max(dimension.x1, dimension.x2),
    top: Math.min(dimension.y1, dimension.y2),
    bottom: Math.max(dimension.y1, dimension.y2),
  };
}

function dimensionMarkup(dimension) {
  const length = measurementLength(
    { x: dimension.x1, y: dimension.y1 },
    { x: dimension.x2, y: dimension.y2 },
  );
  const angle = Math.atan2(dimension.y2 - dimension.y1, dimension.x2 - dimension.x1) * 180 / Math.PI;
  const middleX = (dimension.x1 + dimension.x2) / 2;
  const middleY = (dimension.y1 + dimension.y2) / 2;
  const selected = isSelected('dimension', dimension.id);
  return `<g class="plan-dimension ${selected ? 'is-selected' : ''} ${dimension.locked ? 'is-locked' : ''}"
      data-dimension-id="${dimension.id}">
    <title>${escapeHtml(dimension.name)} ${formatMeasurement(length)}${dimension.locked ? ' · 잠김' : ''}</title>
    <line class="dimension-hit-target" x1="${dimension.x1}" y1="${dimension.y1}" x2="${dimension.x2}" y2="${dimension.y2}" />
    <line class="dimension-line" x1="${dimension.x1}" y1="${dimension.y1}" x2="${dimension.x2}" y2="${dimension.y2}" />
    <line class="dimension-tick" x1="-7" y1="0" x2="7" y2="0" transform="translate(${dimension.x1} ${dimension.y1}) rotate(${angle + 90})" />
    <line class="dimension-tick" x1="-7" y1="0" x2="7" y2="0" transform="translate(${dimension.x2} ${dimension.y2}) rotate(${angle + 90})" />
    <text x="${middleX}" y="${middleY - 9}">${formatMeasurement(length)}${dimension.locked ? ' · 🔒' : ''}</text>
  </g>`;
}

function precisionMarkup() {
  if (!precisionTool?.points.length) return '';
  const [first] = precisionTool.points;
  return `<g class="precision-points" pointer-events="none">
    <circle cx="${first.x}" cy="${first.y}" r="7" />
    <text x="${first.x + 11}" y="${first.y - 11}">1</text>
  </g>`;
}

function endDirectionLabel(orientation, value) {
  if (orientation === 'vertical') return value === 'start' ? '위쪽' : '아래쪽';
  return value === 'start' ? '왼쪽' : '오른쪽';
}

function openSideLabel(orientation, value) {
  if (orientation === 'vertical') return Number(value) === 1 ? '왼쪽' : '오른쪽';
  return Number(value) === 1 ? '아래쪽' : '위쪽';
}

function doorSymbolMarkup(door, options = {}) {
  const half = door.width / 2;
  const selected = options.selected ? ' is-selected' : '';
  const attributes = options.interactive
    ? `data-structure-id="${door.id}" transform="translate(${door.x} ${door.y}) rotate(${door.orientation === 'vertical' ? 90 : 0})"`
    : `pointer-events="none" transform="translate(${door.x} ${door.y}) rotate(${door.orientation === 'vertical' ? 90 : 0})"`;
  const symbol = (() => {
    if (door.doorType === 'sliding') {
      const direction = door.slideDirection === 'start' ? -1 : 1;
      const ratio = Math.min(100, Math.max(0, Number(door.openRatio) || 0)) / 100;
      const panelWidth = door.width / 2;
      const fixedCenter = direction * door.width / 4;
      const movingCenter = -direction * door.width / 4 + direction * door.width / 2 * ratio;
      const arrowStart = movingCenter - direction * Math.min(panelWidth / 3, 18);
      const arrowEnd = movingCenter + direction * Math.min(panelWidth / 3, 18);
      const arrowHead = arrowEnd - direction * 8;
      return `<line class="door-panel door-panel-fixed" x1="${fixedCenter - panelWidth / 2}" y1="-5" x2="${fixedCenter + panelWidth / 2}" y2="-5" /><line class="door-panel door-panel-moving" x1="${movingCenter - panelWidth / 2}" y1="5" x2="${movingCenter + panelWidth / 2}" y2="5" /><path class="door-direction" d="M ${arrowStart} 15 L ${arrowEnd} 15 M ${arrowHead} 9 L ${arrowEnd} 15 L ${arrowHead} 21" />`;
    }
    const hingeX = door.hinge === 'end' ? half : -half;
    const closedX = -hingeX;
    const hingeDirection = door.hinge === 'end' ? -1 : 1;
    const openSide = Number(door.openSide) === 1 ? 1 : -1;
    const angle = Math.min(120, Math.max(0, Number(door.openAngle) || 0));
    const radians = angle * Math.PI / 180;
    const openX = hingeX + hingeDirection * door.width * Math.cos(radians);
    const openY = openSide * door.width * Math.sin(radians);
    const sweep = (door.hinge === 'start') === (Number(door.openSide) === 1) ? 1 : 0;
    const arc = angle > 0 ? `<path class="door-swing" d="M ${closedX} 0 A ${door.width} ${door.width} 0 0 ${sweep} ${openX} ${openY}" />` : '';
    return `<line class="door-panel" x1="${hingeX}" y1="0" x2="${openX}" y2="${openY}" />${arc}`;
  })();
  const label = options.label === false
    ? ''
    : `<text x="0" y="${door.doorType === 'sliding' ? 22 : Number(door.openSide) === 1 ? -18 : 18}">${options.label ?? DOOR_TYPES[door.doorType].replace(/문$/, '')}</text>`;
  return `<g class="plan-structure plan-door door-${door.doorType}${selected} ${door.locked ? 'is-locked' : ''}" ${attributes}>
    ${options.interactive ? `<title>${escapeHtml(door.name)} ${DOOR_TYPES[door.doorType]}</title>` : ''}
    ${options.interactive ? `<line class="structure-hit-target" x1="${-half}" y1="0" x2="${half}" y2="0" />` : ''}
    ${symbol}
    ${label}
  </g>`;
}

function windowSymbolMarkup(windowStructure, options = {}) {
  const half = windowStructure.width / 2;
  const direction = windowStructure.slideDirection === 'start' ? -1 : 1;
  const ratio = Math.min(100, Math.max(0, Number(windowStructure.openRatio) || 0)) / 100;
  const panelWidth = windowStructure.width / 2;
  const fixedCenter = direction * windowStructure.width / 4;
  const movingCenter = -direction * windowStructure.width / 4 + direction * windowStructure.width / 2 * ratio;
  const selected = options.selected ? ' is-selected' : '';
  return `<g class="plan-structure plan-window${selected} ${windowStructure.locked ? 'is-locked' : ''}" data-structure-id="${windowStructure.id}" transform="translate(${windowStructure.x} ${windowStructure.y}) rotate(${windowStructure.orientation === 'vertical' ? 90 : 0})">
    <title>${escapeHtml(windowStructure.name)} 샷시형 미닫이창</title>
    <line class="structure-hit-target" x1="${-half}" y1="0" x2="${half}" y2="0" />
    <rect class="window-frame" x="${-half}" y="-8" width="${windowStructure.width}" height="16" rx="2" />
    <line class="window-panel window-panel-fixed" x1="${fixedCenter - panelWidth / 2}" y1="-4" x2="${fixedCenter + panelWidth / 2}" y2="-4" />
    <line class="window-panel window-panel-moving" x1="${movingCenter - panelWidth / 2}" y1="4" x2="${movingCenter + panelWidth / 2}" y2="4" />
    <text x="0" y="-15">창</text>
  </g>`;
}

function render2d(collisions, outOfBounds, heightViolations, zoneOverlaps) {
  const bounds = editorContentBounds();
  const spaces = groupSpaces(state.zones);
  const padding = CANVAS_PADDING;
  const canvasViewBox = currentCanvasViewBox();
  const viewBox = `${canvasViewBox.left} ${canvasViewBox.top} ${canvasViewBox.width} ${canvasViewBox.height}`;
  const singleSelection = selectionKeys.size === 1;
  const selectedZone = singleSelection && state.selection?.kind === 'zone'
    ? state.zones.find((zone) => zone.id === state.selection.id)
    : null;
  const selectedItem = singleSelection && state.selection?.kind === 'item'
    ? state.items.find((item) => item.id === state.selection.id)
    : null;
  const selectedStructure = singleSelection && state.selection?.kind === 'structure'
    ? state.structures.find((structure) => structure.id === state.selection.id)
    : null;
  const selectedSpaceIds = new Set(selectedEntries().filter((entry) => entry.kind === 'zone').map((entry) => spaceIdOf(entry.entity)));
  const spaceDetails = new Map();
  spaces.forEach((parts) => {
    const labelPart = parts.reduce((largest, part) => part.width * part.depth > largest.width * largest.depth ? part : largest, parts[0]);
    parts.forEach((part) => spaceDetails.set(part.id, { parts, labelPart }));
  });
  const zones = state.zones.map((zone) => {
    const details = spaceDetails.get(zone.id);
    const selected = isSelected('zone', zone.id);
    const spaceSelected = selectedSpaceIds.has(spaceIdOf(zone));
    const showLabel = details.labelPart.id === zone.id;
    const sizeLabel = details.parts.length > 1
      ? `${details.parts.length}조각 · ${(calculateUnionArea(details.parts) / 10000).toFixed(1)}m² · H ${zone.height ?? 240}cm`
      : `${meters(zone.width)} × ${meters(zone.depth)} · H ${zone.height ?? 240}cm`;
    return `<g class="plan-zone ${details.parts.length > 1 ? 'is-compound' : ''} ${spaceSelected ? 'is-space-selected' : ''} ${selected ? 'is-selected' : ''} ${zone.locked ? 'is-locked' : ''} ${zoneOverlaps.has(zone.id) ? 'has-overlap' : ''}" data-zone-id="${zone.id}">
      <rect class="zone-hit-target" x="${zone.x}" y="${zone.y}" width="${zone.width}" height="${zone.depth}"
        fill="none" stroke="transparent" stroke-width="44" vector-effect="non-scaling-stroke" pointer-events="stroke" />
      <rect x="${zone.x}" y="${zone.y}" width="${zone.width}" height="${zone.depth}" fill="${zone.color}" />
      ${showLabel ? `<text x="${zone.x + zone.width / 2}" y="${zone.y + zone.depth / 2 - 5}">${escapeHtml(zone.name)}</text>
      <text class="zone-size" x="${zone.x + zone.width / 2}" y="${zone.y + zone.depth / 2 + 15}">${sizeLabel}</text>` : ''}
    </g>`;
  }).join('');
  const openings = state.structures.filter((structure) => structure.type !== 'wall');
  const userWalls = state.structures.filter((structure) => structure.type === 'wall');
  const automaticWallOpenings = (segment) => doorsForAutomaticWallSegment(segment, openings, userWalls);
  const spaceOutlines = spaces.filter((parts) => selectedSpaceIds.has(spaceIdOf(parts[0]))).map((parts) => {
    const active = selectedSpaceIds.has(spaceIdOf(parts[0]));
    const outlineSpans = getExteriorWallSegments(parts).flatMap((segment) => splitWallSegment(segment, automaticWallOpenings(segment)).spans);
    return `<g class="space-outline ${active ? 'is-active' : ''}">${outlineSpans.map((segment) => segment.orientation === 'horizontal'
      ? `<line x1="${segment.x1}" y1="${segment.y}" x2="${segment.x2}" y2="${segment.y}" />`
      : `<line x1="${segment.x}" y1="${segment.y1}" x2="${segment.x}" y2="${segment.y2}" />`).join('')}</g>`;
  }).join('');
  const automaticSegments = [...getExteriorWallSegments(state.zones), ...getInteriorWallSegments(state.zones)];
  const automaticWalls = automaticSegments.flatMap((segment) => splitWallSegment(segment, automaticWallOpenings(segment)).spans).map(wallSegmentMarkup).join('');
  const structureRenderOrder = [...state.structures].sort((left, right) => (
    Number(isSelected('structure', left.id)) - Number(isSelected('structure', right.id))
  ));
  const structures = structureRenderOrder.map((structure) => {
    const selected = isSelected('structure', structure.id);
    if (structure.type === 'door') return doorSymbolMarkup(structure, { interactive: true, selected });
    if (structure.type === 'window') return windowSymbolMarkup(structure, { selected });
    const wallSpans = splitWallSegment(
      structureSegment(structure),
      openings.filter((opening) => opening.wallId === structure.id),
    ).spans;
    const wallStrokes = wallSpans.map((span) => {
      const start = structure.orientation === 'horizontal' ? span.x1 - structure.x : span.y1 - structure.y;
      const end = structure.orientation === 'horizontal' ? span.x2 - structure.x : span.y2 - structure.y;
      return `<line class="wall-stroke" x1="${start}" y1="0" x2="${end}" y2="0" />`;
    }).join('');
    const wallHitTargets = wallSpans.map((span) => {
      const start = structure.orientation === 'horizontal' ? span.x1 - structure.x : span.y1 - structure.y;
      const end = structure.orientation === 'horizontal' ? span.x2 - structure.x : span.y2 - structure.y;
      return `<line class="structure-hit-target" x1="${start}" y1="0" x2="${end}" y2="0" />`;
    }).join('');
    return `<g class="plan-structure plan-wall ${selected ? 'is-selected' : ''} ${structure.locked ? 'is-locked' : ''}" data-structure-id="${structure.id}" transform="translate(${structure.x} ${structure.y}) rotate(${structure.orientation === 'vertical' ? 90 : 0})">
      <title>${escapeHtml(structure.name)} 벽</title>
      ${wallHitTargets}
      ${wallStrokes}
      <text x="0" y="-10">${escapeHtml(structure.name)} · ${Math.round(structure.length)}cm${structure.locked ? ' · 🔒' : ''}</text>
    </g>`;
  }).join('');
  const items = state.items.map((item) => {
    const selected = isSelected('item', item.id);
    const classes = ['plan-item', selected ? 'is-selected' : '', item.locked ? 'is-locked' : '', collisions.has(item.id) ? 'has-collision' : '', outOfBounds.has(item.id) ? 'is-outside' : '', heightViolations.has(item.id) ? 'is-too-tall' : ''].filter(Boolean).join(' ');
    return `<g class="${classes}" data-item-id="${item.id}" transform="translate(${item.x} ${item.y}) rotate(${item.rotation})">
      <g class="item-hit-target">${shapeMarkup(item, { hitTarget: true })}</g>
      <g class="item-shape" fill="${item.color}">${shapeMarkup(item)}</g>
      <g transform="rotate(${-item.rotation})" pointer-events="none">
        <text class="item-label" y="-3">${escapeHtml(item.name)}</text>
        <text class="item-height" y="15">H ${item.height}cm${item.elevation ? ` · Z ${item.elevation}cm` : ''}${item.locked ? ' · 🔒' : ''}</text>
      </g>
    </g>`;
  }).join('');
  const groupBoundsMarkup = selectionKeys.size > 1 ? (() => {
    const selectedBounds = selectedEntries().map(({ kind, entity }) => (
      kind === 'zone'
        ? zoneBounds(entity)
        : kind === 'item'
          ? itemBounds(entity)
          : kind === 'structure'
            ? structureBounds(entity)
            : dimensionBounds(entity)
    ));
    const selectedBoundsUnion = unionBounds(selectedBounds);
    return `<rect class="group-selection-bounds" x="${selectedBoundsUnion.left}" y="${selectedBoundsUnion.top}"
      width="${selectedBoundsUnion.right - selectedBoundsUnion.left}" height="${selectedBoundsUnion.bottom - selectedBoundsUnion.top}" rx="6" />`;
  })() : '';
  const resizeOverlay = selectedZone && !selectedZone.locked
    ? `<g class="resize-overlay">${resizeHandlesMarkup(selectedZone, 'zone')}</g>`
    : selectedItem && !selectedItem.locked
      ? `<g class="resize-overlay" transform="translate(${selectedItem.x} ${selectedItem.y}) rotate(${selectedItem.rotation})">${resizeHandlesMarkup(selectedItem, 'item')}</g>`
      : selectedStructure && !selectedStructure.locked
        ? `<g class="resize-overlay structure-resize-overlay" transform="translate(${selectedStructure.x} ${selectedStructure.y}) rotate(${selectedStructure.orientation === 'vertical' ? 90 : 0})">${structureHandlesMarkup(selectedStructure)}</g>`
        : '';
  const guideMarkup = alignmentGuides.map((guide) => guide.orientation === 'vertical'
    ? `<line class="alignment-guide" x1="${guide.position}" y1="${bounds.top - padding}" x2="${guide.position}" y2="${bounds.bottom + padding}" />`
    : `<line class="alignment-guide" x1="${bounds.left - padding}" y1="${guide.position}" x2="${bounds.right + padding}" y2="${guide.position}" />`).join('');
  const marqueeMarkup = marquee ? (() => {
    const left = Math.min(marquee.start.x, marquee.current.x);
    const top = Math.min(marquee.start.y, marquee.current.y);
    return `<rect class="selection-marquee" x="${left}" y="${top}" width="${Math.abs(marquee.current.x - marquee.start.x)}" height="${Math.abs(marquee.current.y - marquee.start.y)}" />`;
  })() : '';
  const backgroundMarkup = state.backgroundPlan
    ? `<image class="background-plan ${state.backgroundPlan.locked ? 'is-locked' : ''}" data-background-plan
        href="${state.backgroundPlan.dataUrl}" x="${state.backgroundPlan.x}" y="${state.backgroundPlan.y}"
        width="${state.backgroundPlan.width}" height="${state.backgroundPlan.depth}"
        opacity="${state.backgroundPlan.opacity}" preserveAspectRatio="none"
        ${state.backgroundPlan.locked ? 'pointer-events="none"' : ''}>
        <title>${escapeHtml(state.backgroundPlan.name)}${state.backgroundPlan.locked ? ' · 잠김' : ' · 드래그하여 이동'}</title>
      </image>`
    : '';
  const dimensions = state.dimensions.map(dimensionMarkup).join('');
  return `<svg id="plan-canvas" class="plan-svg" viewBox="${viewBox}" tabindex="0" aria-label="다중 공간 가구 배치도">
    <defs><pattern id="grid" width="${GRID_CM}" height="${GRID_CM}" patternUnits="userSpaceOnUse"><path d="M ${GRID_CM} 0 L 0 0 0 ${GRID_CM}" fill="none" stroke="#d7d3c9" stroke-width="0.7" /></pattern></defs>
    <rect class="grid-background" x="${canvasViewBox.left}" y="${canvasViewBox.top}" width="${canvasViewBox.width}" height="${canvasViewBox.height}" fill="url(#grid)" />
    ${backgroundMarkup}${zones}<g class="structural-walls">${automaticWalls}</g>${spaceOutlines}${items}${structures}${dimensions}${groupBoundsMarkup}${guideMarkup}${resizeOverlay}${marqueeMarkup}${precisionMarkup()}
  </svg>`;
}

function optionsMarkup(values, selected) {
  return values.map((value) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${value}</option>`).join('');
}

function selectionUtilityMarkup(entity = null) {
  const locked = entity ? entity.locked : selectedEntries().length > 0 && selectedEntries().every(({ entity: entry }) => entry.locked);
  return `<div class="selection-utility">
    <button data-duplicate-selection type="button">⧉ 복제</button>
    <button data-toggle-selection-lock type="button" aria-pressed="${locked}">${locked ? '🔓 잠금 해제' : '🔒 잠금'}</button>
  </div>`;
}

function renderInspector(entity) {
  if (!entity || !state.selection) {
    return `<div class="empty-inspector"><span>↖</span><h3 id="inspector-heading" tabindex="-1">공간·가구·벽·문·창을 선택하세요</h3><p>2D 도면에서 대상을 누르면 위치·크기·높이를 세밀하게 조정할 수 있습니다.</p></div>`;
  }
  if (selectionKeys.size > 1) {
    const entries = selectedEntries();
    const zoneCount = entries.filter((entry) => entry.kind === 'zone').length;
    const itemCount = entries.filter((entry) => entry.kind === 'item').length;
    const structureCount = entries.filter((entry) => entry.kind === 'structure').length;
    const dimensionCount = entries.filter((entry) => entry.kind === 'dimension').length;
    const selectedSpaceCount = new Set(entries.filter((entry) => entry.kind === 'zone').map((entry) => spaceIdOf(entry.entity))).size;
    const canMergeSpaces = selectedSpaceCount > 1 && selectedSpacesCanMerge();
    return `<div class="multi-selection-inspector">
      <span>다중 선택</span>
      <strong id="inspector-heading" tabindex="-1">${entries.length}개 대상</strong>
      <p>${[zoneCount ? `공간 조각 ${zoneCount}개` : '', itemCount ? `가구 ${itemCount}개` : '', structureCount ? `벽·문·창 ${structureCount}개` : '', dimensionCount ? `치수 ${dimensionCount}개` : ''].filter(Boolean).join(' · ')}</p>
      <small>드래그하거나 방향키를 누르면 선택한 대상이 함께 이동합니다.</small>
      ${canMergeSpaces ? '<button data-merge-spaces type="button">선택 공간 합치기 · 경계 개방</button>' : ''}
      ${selectionUtilityMarkup()}
      <button class="danger-button" data-delete-selection type="button">선택 대상 삭제</button>
    </div>`;
  }
  if (state.selection.kind === 'zone') {
    const parts = zonesInSpace(state.zones, entity);
    const partIndex = parts.findIndex((part) => part.id === entity.id) + 1;
    return `<div class="selection-heading"><i style="--swatch:${entity.color}"></i><div><span>선택한 공간 · 조각 ${partIndex}/${parts.length}${entity.locked ? ' · 잠김' : ''}</span><h2 id="inspector-heading" tabindex="-1">${escapeHtml(entity.name)}</h2></div></div>
      <fieldset class="selection-fields" ${entity.locked ? 'disabled' : ''}>
      <div class="field-stack">
        <label>공간 이름<input data-zone-field="name" value="${escapeHtml(entity.name)}" /></label>
        <label>공간 용도<select data-zone-field="type">${optionsMarkup(SPACE_TYPES, entity.type)}</select></label>
      </div>
      <div class="field-grid">
        <label>X 위치 <span>cm</span><input type="number" step="10" data-zone-field="x" value="${Math.round(entity.x)}" /></label>
        <label>Y 위치 <span>cm</span><input type="number" step="10" data-zone-field="y" value="${Math.round(entity.y)}" /></label>
        <label>가로 <span>cm</span><input type="number" min="100" step="10" data-zone-field="width" value="${entity.width}" /></label>
        <label>세로 <span>cm</span><input type="number" min="100" step="10" data-zone-field="depth" value="${entity.depth}" /></label>
        <label>공간 높이 <span>cm</span><input type="number" min="100" max="600" step="10" data-zone-field="height" value="${entity.height ?? 240}" /></label>
      </div>
      <label class="color-field">공간 색상<input type="color" data-zone-field="color" value="${entity.color}" /></label>
      <div class="space-part-actions">
        <button data-add-zone-part type="button">＋ 이 공간에 조각 추가</button>
        <button class="danger-button" data-delete-zone-part type="button">선택 조각 삭제</button>
        <button class="danger-button" data-delete-space type="button">공간 전체 삭제</button>
      </div></fieldset>${selectionUtilityMarkup(entity)}`;
  }
  if (state.selection.kind === 'dimension') {
    const length = measurementLength(
      { x: entity.x1, y: entity.y1 },
      { x: entity.x2, y: entity.y2 },
    );
    return `<div class="selection-heading dimension-heading"><i aria-hidden="true">↔</i><div><span>선택한 치수${entity.locked ? ' · 잠김' : ''}</span><h2 id="inspector-heading" tabindex="-1">${escapeHtml(entity.name)}</h2></div></div>
      <fieldset class="selection-fields" ${entity.locked ? 'disabled' : ''}>
        <div class="field-stack"><label>이름<input data-dimension-field="name" value="${escapeHtml(entity.name)}" /></label></div>
        <div class="field-grid">
          <label>시작 X <span>cm</span><input type="number" step="1" data-dimension-field="x1" value="${Math.round(entity.x1)}" /></label>
          <label>시작 Y <span>cm</span><input type="number" step="1" data-dimension-field="y1" value="${Math.round(entity.y1)}" /></label>
          <label>끝 X <span>cm</span><input type="number" step="1" data-dimension-field="x2" value="${Math.round(entity.x2)}" /></label>
          <label>끝 Y <span>cm</span><input type="number" step="1" data-dimension-field="y2" value="${Math.round(entity.y2)}" /></label>
        </div>
        <p class="dimension-result">측정 거리 <strong>${formatMeasurement(length)}</strong> · ${Math.round(length * 10) / 10}cm</p>
        <button class="danger-button" data-delete-selection type="button">이 치수선 삭제</button>
      </fieldset>${selectionUtilityMarkup(entity)}`;
  }
  if (state.selection.kind === 'structure') {
    const isWall = entity.type === 'wall';
    const isWindow = entity.type === 'window';
    const typeLabel = isWall ? '벽' : isWindow ? '미닫이창' : DOOR_TYPES[entity.doorType];
    return `<div class="selection-heading structure-heading"><i aria-hidden="true">${isWall ? '━' : isWindow ? '▤' : entity.doorType === 'sliding' ? '⇆' : '◜'}</i><div><span>선택한 구조 · ${typeLabel}${entity.locked ? ' · 잠김' : ''}</span><h2 id="inspector-heading" tabindex="-1">${escapeHtml(entity.name)}</h2></div></div>
      <fieldset class="selection-fields" ${entity.locked ? 'disabled' : ''}>
      <div class="field-stack">
        <label>이름<input data-structure-field="name" value="${escapeHtml(entity.name)}" /></label>
        ${!isWall && !isWindow ? `<label>문 방식<select data-structure-field="doorType">${Object.entries(DOOR_TYPES).map(([value, label]) => `<option value="${value}" ${value === entity.doorType ? 'selected' : ''}>${label}</option>`).join('')}</select></label>` : ''}
        <label>방향<select data-structure-field="orientation">${Object.entries(ORIENTATIONS).map(([value, label]) => `<option value="${value}" ${value === entity.orientation ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        ${entity.type === 'door' && entity.doorType === 'swing' ? `<label>경첩 위치<select data-structure-field="hinge">${Object.keys(END_DIRECTIONS).map((value) => `<option value="${value}" ${value === entity.hinge ? 'selected' : ''}>${endDirectionLabel(entity.orientation, value)}</option>`).join('')}</select></label><label>열림 방향<select data-structure-field="openSide"><option value="-1" ${Number(entity.openSide) === -1 ? 'selected' : ''}>${openSideLabel(entity.orientation, -1)}</option><option value="1" ${Number(entity.openSide) === 1 ? 'selected' : ''}>${openSideLabel(entity.orientation, 1)}</option></select></label>` : ''}
        ${!isWall && (isWindow || entity.doorType === 'sliding') ? `<label>미끄러지는 방향<select data-structure-field="slideDirection">${Object.keys(END_DIRECTIONS).map((value) => `<option value="${value}" ${value === entity.slideDirection ? 'selected' : ''}>${endDirectionLabel(entity.orientation, value)}</option>`).join('')}</select></label>` : ''}
      </div>
      ${isWall ? '' : `<div class="door-interaction" aria-label="${typeLabel} 열림 상태">
        <div><strong>${isWindow || entity.doorType === 'sliding' ? `개방률 ${Math.round(entity.openRatio ?? 0)}%` : `열림 각도 ${Math.round(entity.openAngle ?? 0)}°`}</strong><span>${isWindow ? '샷시 두 짝이 앞·뒤 레일에서 서로 겹쳐집니다.' : entity.doorType === 'sliding' ? '두 짝 중 이동문이 고정문 앞으로 겹쳐집니다.' : '경첩을 기준으로 지정한 방향으로 열립니다.'}</span></div>
        <label><span class="sr-only">${typeLabel} 열림 정도</span><input type="range" data-structure-field="${isWindow || entity.doorType === 'sliding' ? 'openRatio' : 'openAngle'}" min="0" max="${isWindow || entity.doorType === 'sliding' ? 100 : 120}" step="5" value="${isWindow || entity.doorType === 'sliding' ? entity.openRatio ?? 0 : entity.openAngle ?? 0}" /></label>
        <div class="door-action-buttons"><button data-door-opening="0" type="button">닫기</button><button data-door-opening="${isWindow || entity.doorType === 'sliding' ? 50 : 45}" type="button">반 열기</button><button data-door-opening="${isWindow || entity.doorType === 'sliding' ? 100 : 90}" type="button">완전히 열기</button></div>
      </div>`}
      <div class="field-grid">
        <label>X 위치 <span>cm</span><input type="number" step="10" data-structure-field="x" value="${Math.round(entity.x)}" /></label>
        <label>Y 위치 <span>cm</span><input type="number" step="10" data-structure-field="y" value="${Math.round(entity.y)}" /></label>
        ${isWall
          ? `<label>벽 길이 <span>cm</span><input type="number" min="40" step="10" data-structure-field="length" value="${entity.length}" /></label><label>벽 두께 <span>cm</span><input type="number" min="2" max="12" step="1" data-structure-field="thickness" value="${entity.thickness ?? 4}" /></label>`
          : `<label>${isWindow ? '창 너비' : '문 너비'} <span>cm</span><input type="number" min="${isWindow ? 60 : 50}" max="${isWindow ? 400 : 300}" step="10" data-structure-field="width" value="${entity.width}" /></label>`}
        <label>${isWindow ? '창 높이' : '높이'} <span>cm</span><input type="number" min="${isWindow ? 50 : 100}" max="600" step="5" data-structure-field="height" value="${entity.height}" /></label>
        ${isWindow ? `<label>창턱 높이 <span>cm</span><input type="number" min="0" max="550" step="5" data-structure-field="sillHeight" value="${entity.sillHeight ?? 90}" /></label>` : ''}
      </div>
      <p class="structure-help">${isWall ? '벽을 선택한 뒤 문이나 창을 추가하면 연결되며, 벽을 이동하면 함께 이동합니다.' : isWindow ? `${entity.wallId ? '선택한 벽에 연결됨' : '공간 경계에 직접 배치'} · 너비·높이·창턱 높이가 3D 샷시에 반영됩니다.` : `${entity.wallId ? '선택한 벽에 연결됨' : '공간 경계에 직접 배치'} · 너비와 방향이 2D 기호·3D 문짝·통행 폭에 반영됩니다.`}</p>
      <button class="danger-button" data-delete-selection type="button">이 ${typeLabel} 삭제</button>
      </fieldset>${selectionUtilityMarkup(entity)}`;
  }
  return `<div class="selection-heading"><i style="--swatch:${entity.color}"></i><div><span>선택한 가구 · ${SHAPES[entity.shape]}${entity.locked ? ' · 잠김' : ''}</span><h2 id="inspector-heading" tabindex="-1">${escapeHtml(entity.name)}</h2></div></div>
    <fieldset class="selection-fields" ${entity.locked ? 'disabled' : ''}>
    <div class="field-stack">
      <label>가구 이름<input data-item-field="name" value="${escapeHtml(entity.name)}" /></label>
      <label>바닥 도형<select data-item-field="shape">${Object.entries(SHAPES).map(([value, label]) => `<option value="${value}" ${value === entity.shape ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    </div>
    <div class="field-grid">
      <label>가로 <span>cm</span><input type="number" min="20" step="10" data-item-field="width" value="${entity.width}" /></label>
      <label>세로 <span>cm</span><input type="number" min="20" step="10" data-item-field="depth" value="${entity.depth}" /></label>
      <label>높이 H <span>cm</span><input type="number" min="1" step="1" data-item-field="height" value="${entity.height}" /></label>
      <label>바닥 높이 Z <span>cm</span><input type="number" min="0" step="1" data-item-field="elevation" value="${entity.elevation ?? 0}" /></label>
      <label>X 위치 <span>cm</span><input type="number" step="10" data-item-field="x" value="${Math.round(entity.x)}" /></label>
      <label>Y 위치 <span>cm</span><input type="number" step="10" data-item-field="y" value="${Math.round(entity.y)}" /></label>
    </div>
    <label class="color-field">가구 색상<input type="color" data-item-field="color" value="${entity.color}" /></label>
    <div class="rotation-row">
      <label>회전 각도 <span>°</span><input type="number" min="0" max="359" step="1" data-item-field="rotation" value="${Math.round(entity.rotation)}" /></label>
      <button id="rotate-item" type="button">↻ 90° 회전</button>
    </div>
    <button class="danger-button" data-delete-selection type="button">이 가구 삭제</button>
    </fieldset>${selectionUtilityMarkup(entity)}`;
}

function renderMobileContextMenu() {
  if (!isMobileLayout() || !mobileContextMenu) return '';
  const entries = selectedEntries();
  const target = entries.find((entry) => entry.kind === mobileContextMenu.kind && entry.id === mobileContextMenu.id);
  if (!target) {
    mobileContextMenu = null;
    return '';
  }
  const groupContext = entries.length > 1;
  const itemCount = entries.filter((entry) => entry.kind === 'item').length;
  const title = groupContext ? `${entries.length}개 그룹` : target.entity.name;
  const typeLabel = groupContext
    ? '선택한 대상 함께 편집'
    : target.kind === 'zone'
      ? '선택한 공간'
      : target.kind === 'item'
        ? '선택한 가구'
        : target.kind === 'dimension'
          ? '선택한 치수'
          : target.entity.type === 'wall' ? '선택한 벽' : target.entity.type === 'window' ? '선택한 미닫이창' : `선택한 ${DOOR_TYPES[target.entity.doorType]}`;
  const openingTarget = !groupContext && target.kind === 'structure' && target.entity.type !== 'wall' ? target.entity : null;
  return `<section class="mobile-context-menu" role="dialog" aria-labelledby="mobile-context-title">
    <div class="mobile-context-heading"><div><span>${typeLabel}</span><strong id="mobile-context-title">${escapeHtml(title)}</strong></div><button data-context-close type="button" aria-label="작업 메뉴 닫기">×</button></div>
    <div class="mobile-context-actions">
      <button data-context-action="move" type="button"><b aria-hidden="true">✥</b><span>이동</span></button>
      ${itemCount ? '<button data-context-action="rotate" type="button" aria-label="선택한 가구 90도 회전"><b aria-hidden="true">↻</b><span>가구 회전</span></button>' : ''}
      ${openingTarget ? `<button data-context-door-opening="0" type="button"><b aria-hidden="true">▯</b><span>${openingTarget.type === 'window' ? '창' : '문'} 닫기</span></button><button data-context-door-opening="${openingTarget.type === 'window' || openingTarget.doorType === 'sliding' ? 100 : 90}" type="button"><b aria-hidden="true">◩</b><span>${openingTarget.type === 'window' ? '창' : '문'} 열기</span></button>` : ''}
      ${!groupContext ? '<button data-context-action="details" type="button"><b aria-hidden="true">⌁</b><span>상세</span></button>' : ''}
      <button data-context-action="duplicate" type="button"><b aria-hidden="true">⧉</b><span>복제</span></button>
      <button data-context-action="lock" type="button"><b aria-hidden="true">${entries.every(({ entity }) => entity.locked) ? '🔓' : '🔒'}</b><span>${entries.every(({ entity }) => entity.locked) ? '잠금 해제' : '잠금'}</span></button>
      <button data-context-action="multi" type="button"><b aria-hidden="true">＋</b><span>그룹 선택</span></button>
      <button class="is-danger" data-context-action="delete" type="button"><b aria-hidden="true">⌫</b><span>삭제</span></button>
      ${!groupContext && target.kind === 'zone' ? '<button class="is-danger" data-context-action="delete-space" type="button"><b aria-hidden="true">×</b><span>공간 전체 삭제</span></button>' : ''}
    </div>
  </section>`;
}

function renderMobileSelectionBar() {
  if (!isMobileLayout() || mobileContextMenu || (!mobileMoveArmed && !mobileMultiSelect && selectionKeys.size < 2)) return '';
  const itemCount = selectedEntries().filter((entry) => entry.kind === 'item').length;
  const selectedSpaceCount = new Set(selectedEntries().filter((entry) => entry.kind === 'zone').map((entry) => spaceIdOf(entry.entity))).size;
  const canMergeSpaces = selectedSpaceCount > 1 && selectedSpacesCanMerge();
  const disabled = selectionKeys.size ? '' : 'disabled';
  return `<section class="mobile-selection-bar ${mobileMoveArmed ? 'is-move-armed' : ''}" aria-label="그룹 편집">
    <div><strong>${mobileMoveArmed ? '대상을 끌어 이동' : '그룹 선택'}</strong><span data-selection-count>${selectionKeys.size}개 선택</span></div>
    <button data-group-action="move" type="button" ${disabled}>이동</button>
    <button data-group-action="rotate" type="button" aria-label="선택한 가구 90도 회전" ${itemCount ? '' : 'disabled'}>회전</button>
    <button data-group-action="duplicate" type="button" ${disabled}>복제</button>
    <button data-group-action="lock" type="button" ${disabled}>${selectedEntries().length && selectedEntries().every(({ entity }) => entity.locked) ? '해제' : '잠금'}</button>
    ${canMergeSpaces ? '<button data-group-action="merge-spaces" type="button">공간 합치기</button>' : ''}
    <button class="is-danger" data-group-action="delete" type="button" ${disabled}>삭제</button>
    <button data-group-action="done" type="button">해제</button>
  </section>`;
}

function renderCloudDialog() {
  if (!cloudDialogOpen) return '';
  const closeButton = '<button class="cloud-dialog-close" data-cloud-close type="button" aria-label="클라우드 창 닫기">×</button>';
  if (!cloudConfigured) {
    return `<div class="cloud-dialog-backdrop" data-cloud-backdrop>
      <section class="cloud-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-dialog-title">
        ${closeButton}
        <span class="eyebrow">CLOUD SETUP</span>
        <h2 id="cloud-dialog-title">클라우드 연결 설정</h2>
        <p><code>.env</code> 파일에 Supabase 프로젝트 URL과 Publishable Key를 입력하면 로그인과 도면 동기화가 활성화됩니다.</p>
        <div class="cloud-code">VITE_SUPABASE_URL<br>VITE_SUPABASE_PUBLISHABLE_KEY</div>
        <p class="cloud-feedback" data-cloud-feedback data-tone="${cloudFeedbackTone}" role="status">${escapeHtml(cloudFeedback)}</p>
      </section>
    </div>`;
  }
  if (!cloudStore) {
    return `<div class="cloud-dialog-backdrop" data-cloud-backdrop>
      <section class="cloud-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-dialog-title">
        ${closeButton}
        <span class="eyebrow">ROOM STUDIO CLOUD</span>
        <h2 id="cloud-dialog-title">로그인 준비 중</h2>
        <p>클라우드 로그인 모듈을 불러오고 있습니다.</p>
        <p class="cloud-feedback" data-cloud-feedback role="status">${escapeHtml(cloudFeedback)}</p>
      </section>
    </div>`;
  }
  if (!cloudSession) {
    return `<div class="cloud-dialog-backdrop" data-cloud-backdrop>
      <section class="cloud-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-dialog-title">
        ${closeButton}
        <span class="eyebrow">ROOM STUDIO ACCOUNT</span>
        <h2 id="cloud-dialog-title">로그인하고 도면 저장</h2>
        <p>Google 계정으로 로그인하거나 이메일로 일회용 로그인 링크를 받아보세요. 현재 로컬 도면은 로그인 후 자동으로 계정에 저장됩니다.</p>
        <button class="cloud-google-button" data-cloud-google type="button">Google로 계속하기</button>
        <div class="cloud-divider"><span>또는</span></div>
        <form class="cloud-email-form" data-cloud-email-form>
          <label>이메일 주소<input name="email" type="email" inputmode="email" autocomplete="email" required placeholder="name@example.com" /></label>
          <button type="submit">로그인 링크 받기</button>
        </form>
        <p class="cloud-feedback" data-cloud-feedback data-tone="${cloudFeedbackTone}" role="status">${escapeHtml(cloudFeedback)}</p>
      </section>
    </div>`;
  }
  const accountLabel = cloudSession.user.user_metadata?.full_name || cloudSession.user.email || '로그인 사용자';
  const dialogBusy = cloudIsBusy();
  return `<div class="cloud-dialog-backdrop" data-cloud-backdrop>
    <section class="cloud-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-dialog-title">
      ${closeButton}
      <span class="eyebrow">MY ROOM CLOUD</span>
      <h2 id="cloud-dialog-title">내 도면 관리</h2>
      <p class="cloud-account-email">${escapeHtml(accountLabel)}</p>
      <label>저장된 도면
        <select data-cloud-project ${dialogBusy ? 'disabled' : ''}>
          ${cloudProjects.length ? cloudProjects.map((project) => `<option value="${project.id}" ${project.id === activeProjectId ? 'selected' : ''}>${escapeHtml(project.name)}</option>`).join('') : '<option value="">저장된 도면 없음</option>'}
        </select>
      </label>
      <label>현재 도면 이름<input data-cloud-project-name maxlength="80" value="${escapeHtml(activeProjectName)}" ${dialogBusy ? 'disabled' : ''} /></label>
      <div class="cloud-project-actions">
        <button data-cloud-save type="button" ${dialogBusy ? 'disabled' : ''}>지금 저장</button>
        <button data-cloud-copy type="button" ${dialogBusy ? 'disabled' : ''}>현재 도면 복사 저장</button>
      </div>
      <p class="cloud-feedback" data-cloud-feedback data-tone="${cloudFeedbackTone}" role="status">${escapeHtml(cloudFeedback)}</p>
      <button class="cloud-signout" data-cloud-signout type="button">로그아웃</button>
    </section>
  </div>`;
}

function renderBlueprintControls() {
  const background = state.backgroundPlan;
  return `<div class="blueprint-tools">
    <div class="blueprint-heading"><strong>실도면 밑그림</strong><small>PNG·JPG</small></div>
    <label class="blueprint-file-button">도면 이미지 가져오기
      <input id="background-file" type="file" accept="image/png,image/jpeg" />
    </label>
    ${background ? `<div class="blueprint-active">
      <span title="${escapeHtml(background.name)}">${escapeHtml(background.name)}</span>
      <div class="blueprint-position">
        <label>X 위치 <span>cm</span><input id="background-x" type="number" step="1" value="${Math.round(background.x)}" ${background.locked ? 'disabled' : ''} /></label>
        <label>Y 위치 <span>cm</span><input id="background-y" type="number" step="1" value="${Math.round(background.y)}" ${background.locked ? 'disabled' : ''} /></label>
      </div>
      <label>투명도 <b>${Math.round(background.opacity * 100)}%</b><input id="background-opacity" type="range" min="5" max="100" step="5" value="${Math.round(background.opacity * 100)}" /></label>
      <div class="blueprint-calibration">
        <label>두 점의 실제 거리 <span>cm</span><input id="calibration-distance" type="number" min="1" max="10000" step="1" value="${calibrationDistanceCm}" /></label>
        <button id="calibrate-background" class="${precisionTool?.type === 'background' ? 'is-active' : ''}" type="button">⌖ 2점 축척 맞추기</button>
      </div>
      <div class="blueprint-actions">
        <button id="toggle-background-lock" type="button" aria-pressed="${background.locked}">${background.locked ? '🔓 이동 잠금 해제' : '🔒 배경 이동 잠금'}</button>
        <button id="remove-background" class="danger-button" type="button">배경 제거</button>
      </div>
    </div>` : '<p>실제 평면도를 배경에 놓고 두 점의 실제 거리로 축척을 맞출 수 있습니다.</p>'}
  </div>`;
}

function render() {
  const focusedMobileLayout = isMobileLayout();
  const mobilePanelAttributes = (panel) => {
    const inactive = focusedMobileLayout && mobilePanel !== panel;
    return `role="tabpanel" aria-labelledby="mobile-tab-${panel}" aria-hidden="${inactive}"${inactive ? ' inert' : ''}`;
  };
  const collisions = findCollisions(state.items);
  const outOfBounds = findOutOfBounds(state.items, state.zones);
  const heightViolations = findHeightViolations(state.items, state.zones, state.wallHeight);
  const zoneOverlaps = findZoneOverlaps(state.zones);
  const selected = selectedEntity();
  const spaces = groupSpaces(state.zones);
  const selectedSpaceIds = new Set(selectedEntries().filter((entry) => entry.kind === 'zone').map((entry) => spaceIdOf(entry.entity)));
  const area = calculateUnionArea(state.zones) / 10000;
  const maxHeight = state.items.length ? Math.max(...state.items.map((item) => item.height + (item.elevation ?? 0))) : 0;
  const warningCount = new Set([...collisions, ...outOfBounds, ...heightViolations]).size + zoneOverlaps.size;
  const mobileStatus = `${mobileMultiSelect ? '그룹 선택 켜짐' : '그룹 선택 꺼짐'} · 선택 ${selectionKeys.size}개${mobileMoveArmed ? ' · 이동 준비됨' : ''}`;
  const cloudBackgroundAttributes = cloudDialogOpen ? 'inert aria-hidden="true"' : '';
  const cloudState = cloudFeedbackTone === 'error' ? 'error' : !cloudConfigured ? 'setup' : cloudSession ? 'synced' : 'idle';

  const accountName = cloudSession?.user?.user_metadata?.full_name || cloudSession?.user?.email?.split('@')[0];
  app.innerHTML = `<header class="topbar" ${cloudBackgroundAttributes}>
    <a class="brand" href="#"><span class="brand-mark"><i></i><i></i><i></i></span><span><strong>ROOM</strong> STUDIO</span></a>
    <div class="topbar-cloud">
      <div class="save-state" data-state="${cloudState}"><span></span><span data-cloud-status>${escapeHtml(cloudFeedback)}</span></div>
      <button class="cloud-account-button" data-cloud-open type="button" aria-haspopup="dialog"><b aria-hidden="true">${cloudSession ? '●' : '○'}</b><span>${escapeHtml(accountName || (cloudConfigured ? '로그인' : '클라우드 설정'))}</span></button>
    </div>
  </header>
  <main class="workspace mobile-${mobilePanel}" ${cloudBackgroundAttributes}>
    <aside class="panel left-panel" aria-label="공간과 가구 패널">
      <section class="space-section" id="mobile-panel-spaces" ${mobilePanelAttributes('spaces')}>
        <div class="section-title"><span>01</span><h2>집 구성</h2><button class="add-mini" id="add-zone" type="button">＋ 공간</button></div>
        ${renderBlueprintControls()}
        <div class="preset-row"><button data-layout="apartment" type="button">기본 아파트</button><button data-layout="lshape" type="button">ㄱ자 주택</button></div>
        <p class="section-help">하나의 공간에 여러 조각을 붙여 거실·복도 같은 직교형 공간을 만드세요.</p>
        <div class="zone-list">${spaces.map((parts) => {
          const representative = parts.reduce((largest, part) => part.width * part.depth > largest.width * largest.depth ? part : largest, parts[0]);
          const area = calculateUnionArea(parts) / 10000;
          return `<button class="${selectedSpaceIds.has(spaceIdOf(representative)) ? 'active' : ''}" data-select-zone="${representative.id}" type="button"><i style="--zone:${representative.color}"></i><span><strong>${escapeHtml(representative.name)}</strong><small>${escapeHtml(representative.type)} · ${area.toFixed(1)}m² · H ${representative.height ?? 240}cm${parts.length > 1 ? ` · ${parts.length}조각` : ''}</small></span></button>`;
        }).join('')}</div>
        <div class="structure-library">
          <div class="section-title compact"><span>02</span><h2>벽·문·창</h2></div>
          <p class="section-help">벽을 선택한 뒤 문이나 창을 추가하면 벽에 연결됩니다. 선택을 해제하면 공간 경계에 직접 놓을 수 있습니다.</p>
          <div class="structure-add-row"><button data-add-structure="wall" type="button">━ 벽</button><button data-add-structure="swing" type="button">◜ 여닫이문</button><button data-add-structure="sliding" type="button">⇆ 미닫이문</button><button data-add-structure="window" type="button">▤ 미닫이창</button></div>
          <div class="structure-list">${state.structures.map((structure) => `<button class="${isSelected('structure', structure.id) ? 'active' : ''}" data-select-structure="${structure.id}" type="button"><b aria-hidden="true">${structure.type === 'wall' ? '━' : structure.type === 'window' ? '▤' : structure.doorType === 'sliding' ? '⇆' : '◜'}</b><span><strong>${escapeHtml(structure.name)}</strong><small>${structure.type === 'wall' ? `${ORIENTATIONS[structure.orientation]} · ${structure.length}cm · T ${structure.thickness ?? 4}cm` : structure.type === 'window' ? `샷시 미닫이 · ${ORIENTATIONS[structure.orientation]} · ${structure.width}×${structure.height}cm · 창턱 ${structure.sillHeight ?? 90}cm · ${Math.round(structure.openRatio ?? 0)}% 열림` : `${DOOR_TYPES[structure.doorType]} · ${ORIENTATIONS[structure.orientation]} · ${structure.width}cm · ${structure.wallId ? '벽 연결' : '직접 배치'} · ${structure.doorType === 'swing' ? `${Math.round(structure.openAngle ?? 0)}° 열림` : `${Math.round(structure.openRatio ?? 0)}% 열림`}`}</small></span></button>`).join('')}</div>
        </div>
      </section>
      <section class="furniture-section" id="mobile-panel-furniture" ${mobilePanelAttributes('furniture')}>
        <div class="section-title"><span>03</span><h2>가구 라이브러리</h2></div>
        <div class="furniture-library">${furnitureTemplates.map((template) => `<button type="button" data-add-type="${template.type}"><i class="shape-${template.shape}" style="--item:${template.color}"></i><span><strong>${escapeHtml(template.name)}</strong><small>${SHAPES[template.shape]} · H ${template.height}cm</small></span><b>＋</b></button>`).join('')}</div>
      </section>
      <section class="custom-section">
        <div class="section-title"><span>04</span><h2>커스텀 가구</h2></div>
        <label>이름<input id="custom-name" placeholder="예: 반려견 집" /></label>
        <label>도형<select id="custom-shape">${Object.entries(SHAPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
        <div class="custom-grid"><label>가로<input id="custom-width" type="number" value="100" min="20" step="10" /></label><label>세로<input id="custom-depth" type="number" value="70" min="20" step="10" /></label><label>높이<input id="custom-height" type="number" value="80" min="1" /></label><label>색상<input id="custom-color" type="color" value="#b97962" /></label></div>
        <button class="primary-button" id="add-custom" type="button">커스텀 가구 추가</button>
      </section>
    </aside>

    <section class="canvas-column" id="mobile-panel-canvas" ${mobilePanelAttributes('canvas')}>
      <div class="canvas-toolbar"><div><span class="eyebrow">HOME COMPOSER</span><h1>나의 집 도면</h1></div>
        <div class="view-tabs"><button class="active" type="button">2D 편집</button><button id="open-walkthrough" type="button">3D 미리보기</button></div>
      </div>
      <div class="canvas-actions">
        <span>방향키 1cm · Shift+방향키 40cm · ⌘/Ctrl+C·V · Shift 클릭 다중 선택</span>
        <div><span class="zoom-controls"><button id="zoom-out" type="button" title="축소" aria-label="도면 축소">−</button><b id="zoom-level">${Math.round(canvasZoom * 100)}%</b><button id="zoom-in" type="button" title="확대" aria-label="도면 확대">＋</button><button id="zoom-fit" type="button">전체 보기</button></span><button class="mobile-only ${mobileMultiSelect ? 'is-active' : ''}" id="multi-select-action" type="button" aria-pressed="${mobileMultiSelect}">그룹 선택${selectionKeys.size ? ` ${selectionKeys.size}` : ''}</button><button id="undo-action" type="button" aria-label="실행 취소" ${historyPast.length ? '' : 'disabled'}><span class="desktop-only">↶ 실행 취소</span><span class="mobile-only" aria-hidden="true">↶</span></button><button id="redo-action" type="button" aria-label="다시 실행" ${historyFuture.length ? '' : 'disabled'}><span class="desktop-only">↷ 다시 실행</span><span class="mobile-only" aria-hidden="true">↷</span></button><button id="add-dimension" class="${precisionTool?.type === 'dimension' ? 'is-active' : ''}" type="button">↔ 거리 측정</button><button id="duplicate-selection" type="button" ${selectionKeys.size ? '' : 'disabled'}>⧉ 복제</button><button id="copy-selection" type="button" ${selectionKeys.size ? '' : 'disabled'}>복사</button><button id="paste-selection" type="button" ${internalClipboard ? '' : 'disabled'}>붙여넣기</button><button id="clear-furniture" type="button">가구 비우기</button></div>
      </div>
      <div class="canvas-wrap">${render2d(collisions, outOfBounds, heightViolations, zoneOverlaps)}${renderTransformHud()}${editorNotice || precisionTool ? `<div class="editor-notice ${precisionTool ? 'is-tool-active' : ''}" role="status"><span>${escapeHtml(editorNotice)}</span>${precisionTool ? '<button id="cancel-precision-tool" type="button">취소</button>' : ''}</div>` : ''}</div>
      <div class="stats-bar"><div><span>집 면적</span><strong>${area.toFixed(1)}<small>m²</small></strong></div><div><span>공간 구성</span><strong>${spaces.length}<small>개 · ${state.zones.length}조각</small></strong></div><div><span>바닥 점유</span><strong>${calculateCoverage(state.items, state.zones)}<small>%</small></strong></div><div><span>최고 높이</span><strong>${maxHeight}<small>cm</small></strong></div><div class="${warningCount ? 'warning' : ''}"><span>배치 검사</span><strong>${warningCount ? `${warningCount}개 확인` : '정상'}</strong></div></div>
      <div class="legend"><span><i class="collision-dot"></i>가구 3D 충돌</span><span><i class="height-dot"></i>공간 높이 초과</span><span><i class="outside-dot"></i>집 밖 배치</span><span><i class="zone-dot"></i>공간 중복</span></div>
    </section>

    <aside class="panel right-panel" id="mobile-panel-inspector" ${mobilePanelAttributes('inspector')}><div class="section-title"><span>05</span><h2>상세 조정</h2></div>${renderInspector(selected)}
      <div class="tips"><h3>3차원 배치 기준</h3><p><b>높이 H</b>는 가구 자체 높이입니다.</p><p><b>바닥 높이 Z</b>는 선반처럼 바닥에서 띄운 높이입니다.</p><p>가구의 바닥 면적과 높이 구간이 모두 겹칠 때만 3D 충돌로 표시합니다.</p></div>
    </aside>
  </main>
  ${renderMobileSelectionBar()}
  ${renderMobileContextMenu()}
  ${renderCloudDialog()}
  <div id="mobile-status" role="status" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;">${mobileStatus}</div>
  <nav class="mobile-nav" role="tablist" aria-label="모바일 편집 메뉴" aria-describedby="mobile-status" ${cloudBackgroundAttributes}>
    ${mobileTabs.map(([panel, icon, label]) => {
      const active = mobilePanel === panel;
      return `<button id="mobile-tab-${panel}" class="${active ? 'is-active' : ''}" data-mobile-panel="${panel}" type="button" role="tab" aria-controls="mobile-panel-${panel}" aria-selected="${active}" tabindex="${active ? '0' : '-1'}"><b aria-hidden="true">${icon}</b><span>${label}</span></button>`;
    }).join('')}
  </nav>
  <footer ${cloudBackgroundAttributes}>사각 공간을 조합하고, 가구의 폭·깊이·높이를 함께 확인하세요. <strong>Room Studio</strong></footer>`;
  bindEvents();
}

function activateMobilePanel(panel, focusKind = 'mobile-tab') {
  mobilePanel = panel;
  pendingFocus = { kind: focusKind, panel };
  render();
}

function focusPendingTarget() {
  if (!pendingFocus) return;
  const focusRequest = pendingFocus;
  pendingFocus = null;
  if (focusRequest.kind === 'item-rotate') {
    document.querySelector(`[data-item-rotate="${focusRequest.id}"]`)?.focus();
    return;
  }
  const selector = {
    'panel-heading': '#inspector-heading',
    'context-menu': '[data-context-action="move"]',
    canvas: '#plan-canvas',
    'group-move': '[data-group-action="move"]',
    'group-rotate': '[data-group-action="rotate"]',
  }[focusRequest.kind] ?? `#mobile-tab-${focusRequest.panel}`;
  document.querySelector(selector)?.focus();
}

function moveMobileTabFocus(event, currentPanel) {
  const index = mobileTabs.findIndex(([panel]) => panel === currentPanel);
  const nextIndex = {
    ArrowLeft: (index + mobileTabs.length - 1) % mobileTabs.length,
    ArrowRight: (index + 1) % mobileTabs.length,
    Home: 0,
    End: mobileTabs.length - 1,
  }[event.key];
  if (nextIndex === undefined) return;
  event.preventDefault();
  activateMobilePanel(mobileTabs[nextIndex][0]);
}

function bindEvents() {
  document.querySelector('[data-cloud-open]')?.addEventListener('click', () => {
    cloudDialogOpen = true;
    render();
    document.querySelector('.cloud-dialog input, .cloud-dialog select, .cloud-dialog button')?.focus();
  });
  document.querySelector('[data-cloud-close]')?.addEventListener('click', () => {
    cloudDialogOpen = false;
    render();
    document.querySelector('[data-cloud-open]')?.focus();
  });
  document.querySelector('[data-cloud-backdrop]')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget) return;
    cloudDialogOpen = false;
    render();
    document.querySelector('[data-cloud-open]')?.focus();
  });
  document.querySelector('[data-cloud-email-form]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    button.disabled = true;
    setCloudFeedback('로그인 링크를 보내는 중…');
    try {
      await cloudStore.signInWithMagicLink(new FormData(form).get('email'), cloudAuthRedirectUrl);
      form.reset();
      setCloudFeedback('이메일을 확인해 로그인 링크를 열어주세요.', 'success');
    } catch (error) {
      setCloudFeedback(error.message || '로그인 링크를 보내지 못했습니다.', 'error');
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector('[data-cloud-google]')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    setCloudFeedback('Google 로그인으로 이동하는 중…');
    try {
      await cloudStore.signInWithGoogle(cloudAuthRedirectUrl);
    } catch (error) {
      event.currentTarget.disabled = false;
      setCloudFeedback(error.message || 'Google 로그인을 시작하지 못했습니다.', 'error');
    }
  });
  document.querySelector('[data-cloud-signout]')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      if (!(await flushCloudSave())) {
        event.currentTarget.disabled = false;
        return;
      }
      await cloudStore.signOut();
      cloudDialogOpen = false;
      await handleCloudSession(null);
      document.querySelector('[data-cloud-open]')?.focus();
    } catch (error) {
      event.currentTarget.disabled = false;
      setCloudFeedback(error.message || '로그아웃하지 못했습니다.', 'error');
    }
  });
  document.querySelector('[data-cloud-project]')?.addEventListener('change', (event) => {
    if (event.target.value) openCloudProject(event.target.value);
  });
  document.querySelector('[data-cloud-project-name]')?.addEventListener('change', (event) => {
    activeProjectName = normalizeProjectName(event.target.value);
    event.target.value = activeProjectName;
    scheduleCloudSave();
  });
  document.querySelector('[data-cloud-save]')?.addEventListener('click', async () => {
    activeProjectName = normalizeProjectName(document.querySelector('[data-cloud-project-name]')?.value);
    await saveCloudProject(true);
    render();
  });
  document.querySelector('[data-cloud-copy]')?.addEventListener('click', createCloudCopy);
  document.querySelector('#background-file')?.addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    event.target.disabled = true;
    editorNotice = '배경 도면을 최적화하는 중…';
    render();
    try {
      await importBackgroundPlan(file);
    } catch (error) {
      editorNotice = error.message || '배경 도면을 가져오지 못했습니다.';
      render();
    }
  });
  document.querySelector('#background-opacity')?.addEventListener('change', (event) => {
    updateBackgroundPlan({ opacity: Number(event.target.value) / 100 });
  });
  document.querySelector('#background-x')?.addEventListener('change', (event) => {
    updateBackgroundPlan({ x: Number(event.target.value) });
  });
  document.querySelector('#background-y')?.addEventListener('change', (event) => {
    updateBackgroundPlan({ y: Number(event.target.value) });
  });
  document.querySelector('#calibration-distance')?.addEventListener('input', (event) => {
    calibrationDistanceCm = numberValue(event.target.value, calibrationDistanceCm, 1, 10000);
  });
  document.querySelector('#calibrate-background')?.addEventListener('click', () => {
    calibrationDistanceCm = numberValue(
      document.querySelector('#calibration-distance')?.value,
      calibrationDistanceCm,
      1,
      10000,
    );
    startPrecisionTool('background');
  });
  document.querySelector('#toggle-background-lock')?.addEventListener('click', () => {
    updateBackgroundPlan({ locked: !state.backgroundPlan.locked });
  });
  document.querySelector('#remove-background')?.addEventListener('click', () => {
    precisionTool = null;
    editorNotice = '배경 도면을 제거했습니다.';
    updateState({ backgroundPlan: null });
  });
  document.querySelector('#add-zone').addEventListener('click', addZone);
  document.querySelector('#undo-action').addEventListener('click', undo);
  document.querySelector('#redo-action').addEventListener('click', redo);
  document.querySelector('#zoom-out').addEventListener('click', () => setCanvasZoom(canvasZoom - 0.25));
  document.querySelector('#zoom-in').addEventListener('click', () => setCanvasZoom(canvasZoom + 0.25));
  document.querySelector('#zoom-fit').addEventListener('click', resetCanvasZoom);
  document.querySelector('#add-dimension').addEventListener('click', () => startPrecisionTool('dimension'));
  document.querySelector('#cancel-precision-tool')?.addEventListener('click', () => {
    precisionTool = null;
    editorNotice = '정밀 도구를 취소했습니다.';
    render();
  });
  document.querySelector('#duplicate-selection').addEventListener('click', duplicateSelection);
  document.querySelector('#copy-selection').addEventListener('click', copySelection);
  document.querySelector('#paste-selection').addEventListener('click', pasteSelection);
  document.querySelectorAll('[data-duplicate-selection]').forEach((button) => button.addEventListener('click', duplicateSelection));
  document.querySelectorAll('[data-toggle-selection-lock]').forEach((button) => button.addEventListener('click', toggleSelectionLocked));
  document.querySelector('#multi-select-action').addEventListener('click', () => {
    mobileMultiSelect = !mobileMultiSelect;
    mobileContextMenu = null;
    mobileMoveArmed = false;
    render();
  });
  document.querySelector('[data-context-close]')?.addEventListener('click', closeMobileContextMenu);
  document.querySelector('[data-context-action="move"]')?.addEventListener('click', () => {
    mobileContextMenu = null;
    mobileMoveArmed = true;
    pendingFocus = { kind: 'canvas' };
    render();
  });
  document.querySelector('[data-context-action="rotate"]')?.addEventListener('click', () => {
    pendingFocus = { kind: 'canvas' };
    rotateSelection();
  });
  document.querySelector('[data-context-action="duplicate"]')?.addEventListener('click', () => {
    mobileContextMenu = null;
    duplicateSelection();
  });
  document.querySelector('[data-context-action="lock"]')?.addEventListener('click', () => {
    mobileContextMenu = null;
    toggleSelectionLocked();
  });
  document.querySelectorAll('[data-context-door-opening]').forEach((button) => button.addEventListener('click', () => {
    const target = selectedEntries().find((entry) => entry.kind === 'structure' && entry.entity.type !== 'wall');
    if (!target) return;
    mobileContextMenu = null;
    pendingFocus = { kind: 'canvas' };
    setDoorOpening(target.id, Number(button.dataset.contextDoorOpening));
  }));
  document.querySelector('[data-context-action="details"]')?.addEventListener('click', () => {
    mobileContextMenu = null;
    mobilePanel = 'inspector';
    pendingFocus = { kind: 'panel-heading', panel: 'inspector' };
    render();
  });
  document.querySelector('[data-context-action="multi"]')?.addEventListener('click', () => {
    mobileContextMenu = null;
    mobileMultiSelect = true;
    pendingFocus = { kind: 'group-move' };
    render();
  });
  document.querySelector('[data-context-action="delete"]')?.addEventListener('click', () => {
    pendingFocus = { kind: 'canvas' };
    deleteSelection();
  });
  document.querySelector('[data-context-action="delete-space"]')?.addEventListener('click', () => {
    pendingFocus = { kind: 'canvas' };
    deleteSelectedSpace();
  });
  document.querySelector('[data-group-action="move"]')?.addEventListener('click', () => {
    mobileMoveArmed = true;
    pendingFocus = { kind: 'canvas' };
    render();
  });
  document.querySelector('[data-group-action="rotate"]')?.addEventListener('click', () => {
    pendingFocus = { kind: 'group-rotate' };
    rotateSelection();
  });
  document.querySelector('[data-group-action="duplicate"]')?.addEventListener('click', duplicateSelection);
  document.querySelector('[data-group-action="lock"]')?.addEventListener('click', toggleSelectionLocked);
  document.querySelector('[data-group-action="merge-spaces"]')?.addEventListener('click', mergeSelectedSpaces);
  document.querySelector('[data-group-action="delete"]')?.addEventListener('click', () => {
    pendingFocus = { kind: 'canvas' };
    deleteSelection();
  });
  document.querySelector('[data-group-action="done"]')?.addEventListener('click', () => {
    mobileMultiSelect = false;
    pendingFocus = { kind: 'canvas' };
    clearSelection();
  });
  document.querySelectorAll('[data-mobile-panel]').forEach((button) => button.addEventListener('click', () => {
    activateMobilePanel(button.dataset.mobilePanel);
  }));
  document.querySelectorAll('[role="tab"][data-mobile-panel]').forEach((button) => {
    button.addEventListener('keydown', (event) => moveMobileTabFocus(event, button.dataset.mobilePanel));
  });
  document.querySelector('[data-add-zone-part]')?.addEventListener('click', addZonePart);
  document.querySelector('[data-merge-spaces]')?.addEventListener('click', mergeSelectedSpaces);
  document.querySelector('[data-delete-zone-part]')?.addEventListener('click', deleteSelectedZonePart);
  document.querySelector('[data-delete-space]')?.addEventListener('click', deleteSelectedSpace);
  document.querySelector('#add-custom').addEventListener('click', addCustomFurniture);
  document.querySelectorAll('[data-add-structure]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.addStructure === 'wall') addWall();
    else if (button.dataset.addStructure === 'window') addWindow();
    else addDoor(button.dataset.addStructure);
  }));
  document.querySelector('#clear-furniture').addEventListener('click', clearUnlockedFurniture);
  document.querySelectorAll('[data-layout]').forEach((button) => button.addEventListener('click', () => {
    const previous = layoutSnapshot();
    const zones = button.dataset.layout === 'lshape' ? lShapeZones() : apartmentZones();
    state = defaultState(zones);
    canvasZoom = 1;
    canvasCenter = null;
    selectionKeys = new Set(state.selection ? [selectionKey(state.selection.kind, state.selection.id)] : []);
    commitHistory(previous);
    saveState();
    render();
  }));
  document.querySelectorAll('[data-add-type]').forEach((button) => button.addEventListener('click', () => {
    if (isMobileLayout()) mobilePanel = 'canvas';
    addFurniture(furnitureTemplates.find((template) => template.type === button.dataset.addType));
  }));
  document.querySelectorAll('[data-select-zone]').forEach((button) => button.addEventListener('click', (event) => {
    selectEntity('zone', button.dataset.selectZone, usesAdditiveSelection(event));
    if (isMobileLayout() && !mobileMultiSelect) {
      mobilePanel = 'inspector';
      pendingFocus = { kind: 'panel-heading', panel: 'inspector' };
    }
    render();
  }));
  document.querySelectorAll('[data-select-structure]').forEach((button) => button.addEventListener('click', (event) => {
    selectEntity('structure', button.dataset.selectStructure, usesAdditiveSelection(event));
    if (isMobileLayout() && !mobileMultiSelect) {
      mobilePanel = 'inspector';
      pendingFocus = { kind: 'panel-heading', panel: 'inspector' };
    }
    render();
  }));
  document.querySelector('#open-walkthrough').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '3D 준비 중…';
    try {
      const { openWalkthrough } = await import('./walkthrough3d.js');
      openWalkthrough({
        zones: state.zones,
        items: state.items,
        structures: state.structures,
        wallHeight: state.wallHeight,
        focus: state.selection ? { ...state.selection } : null,
        initialMode: 'dollhouse',
        onStructureChange: (id, updates) => updateStructure(id, updates),
      });
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });

  document.querySelectorAll('[data-zone-id]').forEach((node) => node.addEventListener('pointerdown', (event) => startEntityPress(event, 'zone', node.dataset.zoneId)));
  document.querySelectorAll('[data-item-id]').forEach((node) => node.addEventListener('pointerdown', (event) => startEntityPress(event, 'item', node.dataset.itemId)));
  document.querySelectorAll('[data-structure-id]').forEach((node) => node.addEventListener('pointerdown', (event) => startEntityPress(event, 'structure', node.dataset.structureId)));
  document.querySelectorAll('[data-dimension-id]').forEach((node) => node.addEventListener('pointerdown', (event) => {
    if (precisionTool) return;
    event.preventDefault();
    event.stopPropagation();
    selectEntity('dimension', node.dataset.dimensionId, usesAdditiveSelection(event));
    if (isMobileLayout() && !mobileMultiSelect) {
      mobileContextMenu = { kind: 'dimension', id: node.dataset.dimensionId };
      pendingFocus = { kind: 'context-menu' };
    }
    render();
  }));
  document.querySelector('[data-background-plan]')?.addEventListener('pointerdown', startBackgroundDrag);
  document.querySelector('.grid-background').addEventListener('pointerdown', startMarquee);
  document.querySelector('#plan-canvas').addEventListener('pointerdown', handlePrecisionPoint, true);
  document.querySelector('#plan-canvas').addEventListener('wheel', zoomCanvasWithWheel, { passive: false });
  document.querySelector('#plan-canvas').addEventListener('contextmenu', (event) => {
    if (isMobileLayout()) event.preventDefault();
  });
  document.querySelectorAll('[data-resize-handle]').forEach((node) => node.addEventListener('pointerdown', (event) => {
    startResize(event, node.dataset.resizeKind, node.dataset.resizeId, node.dataset.resizeHandle);
  }));
  document.querySelectorAll('[data-item-rotate]').forEach((node) => node.addEventListener('pointerdown', (event) => {
    startItemRotation(event, node.dataset.itemRotate);
  }));
  document.querySelectorAll('[data-item-rotate]').forEach((node) => node.addEventListener('keydown', (event) => {
    const degrees = {
      ArrowLeft: -15,
      ArrowDown: -15,
      ArrowRight: 15,
      ArrowUp: 15,
      Enter: 15,
      ' ': 15,
    }[event.key];
    if (degrees === undefined && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const item = state.items.find((entry) => entry.id === node.dataset.itemRotate);
    if (!item) return;
    if (event.key === 'Home') rotateItemBy(item.id, -item.rotation);
    else if (event.key === 'End') rotateItemBy(item.id, 359 - item.rotation);
    else rotateItemBy(item.id, degrees);
  }));
  document.querySelectorAll('[data-structure-rotate]').forEach((node) => node.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    rotateStructure(node.dataset.structureRotate);
  }));
  document.querySelectorAll('[data-structure-rotate]').forEach((node) => node.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    rotateStructure(node.dataset.structureRotate);
  }));
  document.querySelectorAll('[data-scene-item]').forEach((node) => node.addEventListener('click', () => updateState({ selection: { kind: 'item', id: node.dataset.sceneItem } }, { save: false })));

  document.querySelectorAll('[data-zone-field]').forEach((input) => {
    const field = input.dataset.zoneField;
    const entityId = state.selection.id;
    const historySnapshot = layoutSnapshot();
    if (input.tagName !== 'SELECT') {
      input.addEventListener('input', () => {
        const value = input.type === 'number' ? Number(input.value) : input.value;
        const selectedZone = state.zones.find((zone) => zone.id === entityId);
        const sharedField = ['name', 'type', 'color', 'height'].includes(field);
        state.zones = state.zones.map((zone) => (
          zone.id === entityId || (sharedField && selectedZone && spaceIdOf(zone) === spaceIdOf(selectedZone))
            ? { ...zone, [field]: value }
            : zone
        ));
        saveState();
      });
      input.addEventListener('blur', () => updateZone(entityId, {
        [field]: input.type === 'number' ? Number(input.value) : input.value,
      }, { historySnapshot }));
      return;
    }
    input.addEventListener('change', () => {
      updateZone(entityId, { [field]: input.value });
    });
  });
  document.querySelectorAll('[data-item-field]').forEach((input) => {
    const field = input.dataset.itemField;
    const entityId = state.selection.id;
    const historySnapshot = layoutSnapshot();
    if (input.tagName !== 'SELECT') {
      input.addEventListener('input', () => {
        const value = input.type === 'number' ? Number(input.value) : input.value;
        state.items = state.items.map((item) => item.id === entityId ? { ...item, [field]: value } : item);
        saveState();
      });
      input.addEventListener('blur', () => updateItem(entityId, {
        [field]: input.type === 'number' ? Number(input.value) : input.value,
      }, { historySnapshot }));
      return;
    }
    input.addEventListener('change', () => {
      updateItem(entityId, { [field]: input.value });
    });
  });
  document.querySelectorAll('[data-structure-field]').forEach((input) => {
    const field = input.dataset.structureField;
    const entityId = state.selection.id;
    const historySnapshot = layoutSnapshot();
    if (input.tagName !== 'SELECT') {
      if (input.type === 'range') {
        input.addEventListener('change', () => updateStructure(entityId, { [field]: Number(input.value) }));
        return;
      }
      input.addEventListener('blur', () => updateStructure(entityId, {
        [field]: input.type === 'number' ? Number(input.value) : input.value,
      }, { historySnapshot }));
      return;
    }
    input.addEventListener('change', () => updateStructure(entityId, { [field]: input.value }));
  });
  document.querySelectorAll('[data-dimension-field]').forEach((input) => {
    const field = input.dataset.dimensionField;
    const entityId = state.selection.id;
    const historySnapshot = layoutSnapshot();
    input.addEventListener('blur', () => updateDimension(entityId, {
      [field]: input.type === 'number' ? Number(input.value) : input.value,
    }, { historySnapshot }));
  });
  document.querySelectorAll('[data-door-opening]').forEach((button) => button.addEventListener('click', () => {
    setDoorOpening(state.selection.id, Number(button.dataset.doorOpening));
  }));
  document.querySelectorAll('[data-delete-selection]').forEach((button) => button.addEventListener('click', deleteSelection));
  document.querySelector('#rotate-item')?.addEventListener('click', rotateSelection);
  focusPendingTarget();
}

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  if (cloudDialogOpen && event.key === 'Tab') {
    const focusable = [...document.querySelectorAll('.cloud-dialog button:not(:disabled), .cloud-dialog input:not(:disabled), .cloud-dialog select:not(:disabled)')];
    if (!focusable.length) return;
    const currentIndex = focusable.indexOf(document.activeElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
    event.preventDefault();
    focusable[nextIndex].focus();
    return;
  }
  if (cloudDialogOpen && event.key === 'Escape') {
    event.preventDefault();
    cloudDialogOpen = false;
    render();
    document.querySelector('[data-cloud-open]')?.focus();
    return;
  }
  if (mobileContextMenu && event.key === 'Escape') {
    event.preventDefault();
    closeMobileContextMenu();
    return;
  }
  if (precisionTool && event.key === 'Escape') {
    event.preventDefault();
    precisionTool = null;
    editorNotice = '정밀 도구를 취소했습니다.';
    render();
    return;
  }
  const target = event.target instanceof Element ? event.target : null;
  const editingField = target?.closest('input, select, textarea, [contenteditable]:not([contenteditable="false"])') ?? null;
  const interactiveControl = target?.closest('button, a, input, select, textarea, [contenteditable]:not([contenteditable="false"])') ?? null;
  const commandKey = event.ctrlKey || event.metaKey;
  if (!editingField && commandKey && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (!editingField && commandKey && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (!editingField && commandKey && event.key.toLowerCase() === 'c' && selectionKeys.size) {
    event.preventDefault();
    copySelection();
    return;
  }
  if (!editingField && commandKey && event.key.toLowerCase() === 'v' && internalClipboard) {
    event.preventDefault();
    pasteSelection();
    return;
  }
  if (!editingField && commandKey && event.key.toLowerCase() === 'd' && selectionKeys.size) {
    event.preventDefault();
    duplicateSelection();
    return;
  }
  if (interactiveControl || !selectionKeys.size) return;
  const movement = {
    ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
    ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
  }[event.key];
  if (movement) {
    event.preventDefault();
    const previous = layoutSnapshot();
    const entries = selectedEntries().filter(({ entity }) => !entity.locked);
    if (!entries.length) {
      editorNotice = '잠긴 대상은 이동할 수 없습니다.';
      render();
      return;
    }
    const zoneIds = new Set(entries.filter((entry) => entry.kind === 'zone').map((entry) => entry.id));
    const itemIds = new Set(entries.filter((entry) => entry.kind === 'item').map((entry) => entry.id));
    const structureIds = new Set(entries.filter((entry) => entry.kind === 'structure').map((entry) => entry.id));
    const dimensionIds = new Set(entries.filter((entry) => entry.kind === 'dimension').map((entry) => entry.id));
    state.structures.filter((structure) => structureIds.has(structure.wallId)).forEach((door) => structureIds.add(door.id));
    state.zones.filter((zone) => zoneIds.has(zone.id)).forEach((zone) => {
      state.items.filter((item) => !item.locked && pointInZone({ x: item.x, y: item.y }, zone)).forEach((item) => itemIds.add(item.id));
    });
    const movementScale = event.shiftKey ? 40 : 1;
    const keyboardMovement = { x: movement.x * movementScale, y: movement.y * movementScale };
    state.zones = state.zones.map((zone) => zoneIds.has(zone.id) ? { ...zone, x: zone.x + keyboardMovement.x, y: zone.y + keyboardMovement.y } : zone);
    state.items = state.items.map((item) => itemIds.has(item.id) ? { ...item, x: item.x + keyboardMovement.x, y: item.y + keyboardMovement.y } : item);
    const movedStructures = state.structures.map((structure) => structureIds.has(structure.id)
      ? { ...structure, x: structure.x + keyboardMovement.x, y: structure.y + keyboardMovement.y }
      : structure);
    state.structures = settleMovedStructures(movedStructures, structureIds);
    state.dimensions = state.dimensions.map((dimension) => dimensionIds.has(dimension.id) ? {
      ...dimension,
      x1: dimension.x1 + keyboardMovement.x,
      y1: dimension.y1 + keyboardMovement.y,
      x2: dimension.x2 + keyboardMovement.x,
      y2: dimension.y2 + keyboardMovement.y,
    } : dimension);
    commitHistory(previous);
    saveState();
    render();
  } else if (event.key.toLowerCase() === 'r') {
    rotateSelection();
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    deleteSelection();
  }
});

document.addEventListener('pointermove', (event) => {
  if (activePointers.has(event.pointerId)) recordPointer(event);
  if (entityPress?.pointerId === event.pointerId && !entityPress.moved) {
    const movedPastSlop = Math.hypot(
      event.clientX - entityPress.startClient.x,
      event.clientY - entityPress.startClient.y,
    ) >= TOUCH_SLOP_PX;
    if (movedPastSlop && entityPress.timer) {
      window.clearTimeout(entityPress.timer);
      entityPress.timer = null;
    }
    if (movedPastSlop && entityPress.initiallySelected && isSelected(entityPress.kind, entityPress.id)) {
      const press = entityPress;
      entityPress = null;
      startDrag(press.event, press.kind, press.id, {
        contactStarted: true,
        additive: false,
        deferToggle: false,
        selectionSnapshot: press.selectionSnapshot,
        primarySelectionSnapshot: press.primarySelectionSnapshot,
        moveArmedSnapshot: press.moveArmedSnapshot,
      });
    } else if (movedPastSlop) {
      entityPress.moved = true;
    }
  }
  if (gestureMode === 'pinch') {
    movePinch();
  } else if (gestureMode === 'pan') {
    movePan(event);
  } else if (backgroundDrag) moveBackgroundDrag(event);
  else if (rotateGesture) moveItemRotation(event);
  else if (resize) moveResize(event);
  else if (drag) moveDrag(event);
  else if (marquee) moveMarquee(event);
});
document.addEventListener('pointerup', (event) => {
  const handledPress = finishEntityPress(event);
  const handledContact = finishPointerContact(event);
  if (handledPress) {
    render();
    return;
  }
  if (handledContact) return;
  if (backgroundDrag) finishBackgroundDrag();
  else if (rotateGesture) finishItemRotation();
  else if (resize) finishResize();
  else if (drag) finishDrag();
  else if (marquee) finishMarquee();
});
document.addEventListener('pointercancel', (event) => {
  cancelEntityPress();
  activePointers.delete(event.pointerId);
  if (drag || resize || rotateGesture || marquee || backgroundDrag || pan || pinch) cancelTemporaryGesture();
  else if (!activePointers.size) gestureMode = 'idle';
});
document.addEventListener('lostpointercapture', (event) => {
  cancelEntityPress();
  activePointers.delete(event.pointerId);
  if (drag || resize || rotateGesture || marquee || backgroundDrag || pan || pinch) cancelTemporaryGesture();
  else if (!activePointers.size) gestureMode = 'idle';
});

mobileLayoutQuery.addEventListener('change', () => {
  if (drag || resize || rotateGesture || marquee || backgroundDrag || pan || pinch || entityPress) {
    activePointers.clear();
    cancelTemporaryGesture();
    return;
  }
  mobileContextMenu = null;
  mobileMoveArmed = false;
  render();
});
render();
initializeCloud();
