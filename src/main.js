import './styles.css';
import './space-editor.css';
import { createSpaceEditor } from './space-editor.js';
import { createConfiguredCloudStore, hasCloudConfiguration, normalizeProjectName, resolveAuthRedirectUrl } from './cloud-store.js';
import {
  calibrateBackgroundPlan,
  createLayoutClipboard,
  formatMeasurement,
  measurementLength,
  pasteLayoutClipboard,
} from './layout-tools.js';
import { parseProjectFile, projectFileName, serializeProjectFile } from './project-file.js';
import { createDecisionReport, decisionReportFileName } from './project-report.js';
import { createNumericEditTransaction } from './editor-interactions.js';
import { DEMO_LAYOUTS, REGIONAL_DEMO_LAYOUTS, demoLayoutById } from './demo-layouts.js';
import { normalizeItemAppearance, normalizeZoneAppearance } from './appearance.js';
import { ROOM_ASSETS, assetForItem } from './asset-library.js';
import {
  createComparisonOption,
  geometryForOption,
  geometrySnapshot,
  normalizeConsultation,
  preparePersistedLayout,
  switchConsultationOption,
} from './consultation.js';
import { createLocalDraftStore } from './local-draft.js';
import {
  renderComparisonDialog,
  renderConsultationDialog,
  renderConsultationToolbar,
} from './consultation-ui.js';
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
  getDoorLeafSegments,
  getRolledBackSelection,
  getZoomViewBox,
  meters,
  normalizeAngle,
  pointInZone,
  resizeZoneFromHandle,
  snap,
  spaceIdOf,
  splitWallSegment,
  snapDoorToWallSegments,
  structureSegment,
  zoneBounds,
  zonesOverlap,
  zonePoints,
  zoneFromPoints,
  zoneInteriorPoint,
  segmentEndpoints,
  structureAngle,
  reconcileZoneOpenings,
} from './geometry.js';

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
const ORIENTATIONS = { horizontal: '가로', vertical: '세로', diagonal: '사선' };
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
].map((template) => {
  const asset = assetForItem(template);
  if (!asset) return template;
  return {
    ...template,
    name: asset.name,
    shape: 'roundRect',
    width: Math.round(asset.dimensions.width * 100),
    depth: Math.round(asset.dimensions.depth * 100),
    height: Math.round(asset.dimensions.height * 100),
    assetId: asset.id,
    materialId: 'warm-oak',
  };
});
furnitureTemplates.push(...ROOM_ASSETS.filter((asset) => !furnitureTemplates.some((template) => template.assetId === asset.id))
  .map((asset) => ({
    type: asset.legacyTypes[0] ?? asset.category.replaceAll('-', '_'),
    name: asset.name,
    shape: 'roundRect',
    width: Math.round(asset.dimensions.width * 100),
    depth: Math.round(asset.dimensions.depth * 100),
    height: Math.round(asset.dimensions.height * 100),
    color: '#c4b8a4',
    assetId: asset.id,
    materialId: 'warm-oak',
  })));

furnitureTemplates.push({ type: 'custom', name: '내 가구', shape: 'rect', width: 100, depth: 70, height: 80, color: '#b97962' });

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
    ...(Number.isFinite(structure.angle) ? { angle: normalizeAngle(structure.angle) } : {}),
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
    ...(structure.wallAttachment ? { wallAttachment: structuredClone(structure.wallAttachment) } : {}),
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

function defaultState(zones = apartmentZones()) {
  return {
    zones, items: [], structures: [], dimensions: [], backgroundPlan: null,
    selection: null, wallHeight: 240,
  };
}

function normalizeDrawing(saved) {
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
      const normalized = {
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
        ...normalizeZoneAppearance(zone),
        locked: Boolean(zone.locked),
        walkthroughStart: Boolean(zone.walkthroughStart),
      };
      return Object.hasOwn(zone, 'points') ? zoneFromPoints(normalized, zonePoints(zone)) : normalized;
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
        ...normalizeItemAppearance(item),
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
    const drawing = {
      ...defaultState(zones),
      zones,
      items,
      structures,
      dimensions,
      backgroundPlan,
      wallHeight,
      selection: null,
    };
    const reconciled = reconcileZoneOpenings(drawing, drawing);
    if (!reconciled) throw new TypeError('연결된 문과 창을 도면의 벽에 배치할 수 없습니다.');
    return reconciled;
  }
  return defaultState();
}

function normalizeLayout(saved) {
  const layout = normalizeDrawing(saved);
  if (saved?.consultation) {
    layout.consultation = normalizeConsultation(saved.consultation);
    if (layout.consultation.inactiveGeometry) {
      layout.consultation.inactiveGeometry = geometrySnapshot(normalizeDrawing(layout.consultation.inactiveGeometry));
    }
  }
  return layout;
}

const draftStore = createLocalDraftStore(() => window.localStorage);
const startupDraft = draftStore.read();
let deferredOwnerDraft = startupDraft.ok && startupDraft.draft?.ownerId ? startupDraft.draft : null;
const initialAnonymousDraft = startupDraft.ok && !startupDraft.draft?.ownerId ? startupDraft.draft : null;
const startsWithoutStoredLayout = startupDraft.ok && !startupDraft.draft;
let state = initialAnonymousDraft ? normalizeLayout(initialAnonymousDraft.layout) : deferredOwnerDraft ? normalizeDrawing({ zones: [], items: [] }) : defaultState();
let draftStorageError = startupDraft.ok ? '' : '브라우저 저장소를 읽지 못했습니다. 현재 작업은 파일로 보관해주세요.';
let recoveryDraft = draftStore.readRecovery();
let unreadDraftRaw = startupDraft.ok ? null : startupDraft.raw;
let numericEdit = null;
let deferInputRender = false;
let inputRenderPending = false;
let pointerFocusTransfer = false;
let drag = null;
let resize = null;
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
const TOUCH_SLOP_PX = 10;
const mobileLayoutQuery = window.matchMedia(`(max-width: ${FOCUSED_MOBILE_BREAKPOINT}px)`);
let canvasZoom = 1;
let canvasCenter = null;
let canvasBase = null;
let spaceEditor = null;
const scenePreviews = new Map();
let mobilePanel = 'canvas';
let workspaceMode = 'simple';
let workspacePanel = 'spaces';
let quickSizesOpen = false;
let mobileMultiSelect = false;
let pendingFocus = startsWithoutStoredLayout ? { kind: 'starter-sample' } : null;
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
let activeProjectName = initialAnonymousDraft?.projectName ?? '새 상담 프로젝트';
let activeProjectRevision = null;
let cloudDialogOpen = false;
let cloudLoadBusy = false;
let cloudPendingSave = null;
let cloudSaveLoop = null;
let cloudSaveTimer = null;
let cloudDirty = initialAnonymousDraft?.dirty ?? false;
let layoutChangeVersion = 0;
let documentGeneration = 0;
let renderedDocumentGeneration = -1;
let cloudGeneration = 0;
let cloudFeedback = cloudConfigured ? '로그인 기능을 준비하는 중…' : '로그인 없이 로컬 작업';
let cloudFeedbackTone = '';
let starterDialogOpen = startsWithoutStoredLayout;
let demoGalleryOpen = false;
let pendingDemoId = null;
let pendingDemo3d = false;
let active3dCleanup = null;
let opening3d = false;
let projectDialogOpen = false;
let projectFileFeedback = '';
let projectFileFeedbackTone = '';
let consultationDialogOpen = false;
let comparisonDialogOpen = false;
let cloudConflict = false;

const selectionKey = (kind, id) => `${kind}:${id}`;
const isEditable2dKind = (kind) => kind === 'zone' || kind === 'dimension';
const isMobileLayout = () => mobileLayoutQuery.matches;
const usesAdditiveSelection = (event) => event.shiftKey || mobileMultiSelect;
const mobileTabs = [
  ['canvas', '▦', '도면'],
  ['spaces', '⌂', '공간'],
  ['inspector', '⌁', '상세'],
];
const layoutSnapshot = () => ({
  ...geometrySnapshot(state),
  ...(state.consultation ? { consultation: normalizeConsultation(state.consultation) } : {}),
});
const snapshotsMatch = (first, second) => JSON.stringify(first) === JSON.stringify(second);
const blankLayout = () => ({
  zones: [],
  items: [],
  structures: [],
  dimensions: [],
  backgroundPlan: null,
  wallHeight: 240,
});

function currentDraftDocument() {
  return {
    projectName: activeProjectName,
    layout: layoutSnapshot(),
    ownerId: currentCloudUserId(),
    projectId: activeProjectId,
    baseRevision: activeProjectRevision,
    dirty: cloudDirty,
  };
}

function availableRecovery() {
  const draft = recoveryDraft.ok ? recoveryDraft.draft : null;
  return draft && (!draft.ownerId || draft.ownerId === currentCloudUserId()) ? draft : null;
}

function updateDraftStatus() {
  const status = document.querySelector('[data-draft-status]');
  if (!status) return;
  const recovery = availableRecovery();
  status.hidden = !draftStorageError && !recovery;
  status.dataset.tone = draftStorageError ? 'error' : '';
  status.setAttribute('role', draftStorageError ? 'alert' : 'status');
  status.querySelector('[data-draft-message]').textContent = draftStorageError
    || `교체 전 상담 “${recovery?.projectName ?? ''}”의 복구본이 있습니다.`;
  status.querySelector('[data-draft-retry]').hidden = !draftStorageError;
  status.querySelector('[data-draft-export]').hidden = !draftStorageError;
  status.querySelector('[data-draft-export]').textContent = unreadDraftRaw ? '저장된 원본 받기' : '도면 파일로 보관';
  status.querySelector('[data-recovery-restore]').hidden = !recovery;
}

function persistCurrentDraft({ replaceUnread = false } = {}) {
  if ((unreadDraftRaw && !replaceUnread) || (deferredOwnerDraft && !cloudSession)) {
    draftStorageError = unreadDraftRaw
      ? '저장된 원본을 읽지 못해 덮어쓰지 않았습니다. 원본을 받은 뒤 다시 저장해주세요.'
      : '기존 상담은 로그인 후 복구할 수 있습니다. 현재 작업은 도면 파일로 보관해주세요.';
    updateDraftStatus();
    return false;
  }
  const result = draftStore.write(currentDraftDocument());
  draftStorageError = result.ok
    ? ''
    : '이 브라우저에 저장하지 못했습니다. 창을 닫기 전에 도면 파일로 보관해주세요.';
  if (result.ok) unreadDraftRaw = null;
  updateDraftStatus();
  return result.ok;
}

function protectCurrentDraft() {
  const result = draftStore.protect(currentDraftDocument());
  if (!result.ok) {
    draftStorageError = '복구본을 저장하지 못해 현재 상담을 유지했습니다. 도면 파일로 보관한 뒤 다시 시도해주세요.';
    setCloudFeedback(draftStorageError, 'error');
    setProjectFileFeedback(draftStorageError, 'error');
    updateDraftStatus();
    return false;
  }
  recoveryDraft = draftStore.readRecovery();
  return true;
}

function canReplaceCurrentDraft() {
  if ((!layoutChangeVersion && !initialAnonymousDraft) || protectCurrentDraft()) return true;
  starterDialogOpen = false;
  projectDialogOpen = false;
  demoGalleryOpen = false;
  pendingDemoId = null;
  render();
  document.querySelector('[data-draft-export]')?.focus();
  return false;
}

function applyProjectDocument({
  projectName,
  layout,
  ownerId = currentCloudUserId(),
  projectId = null,
  baseRevision = null,
  dirty = false,
}) {
  if (ownerId && ownerId !== currentCloudUserId()) return false;
  active3dCleanup?.();
  clearTimeout(cloudSaveTimer);
  cloudPendingSave = null;
  documentGeneration += 1;
  cancelEntityPress();
  activePointers.clear();
  state = normalizeLayout(layout);
  activeProjectName = normalizeProjectName(projectName);
  activeProjectId = projectId;
  activeProjectRevision = baseRevision;
  cloudDirty = dirty;
  cloudConflict = false;
  selectionKeys = new Set();
  historyPast.length = 0;
  historyFuture.length = 0;
  drag = resize = marquee = backgroundDrag = pan = pinch = null;
  numericEdit = mobileContextMenu = null;
  precisionTool = null;
  gestureMode = 'idle';
  mobileMoveArmed = false;
  canvasZoom = 1;
  canvasCenter = null;
  canvasBase = null;
  spaceEditor?.reset();
  scenePreviews.clear();
  layoutChangeVersion += 1;
  persistCurrentDraft();
  return true;
}

function closeConsultationDialog() {
  consultationDialogOpen = false;
  render();
  document.querySelector('[data-consultation-open]')?.focus();
}

function commitInputBlur(event, commit) {
  deferInputRender = event.isTrusted && (pointerFocusTransfer || Boolean(event.relatedTarget));
  try {
    commit();
  } finally {
    deferInputRender = false;
  }
}

function finishInputRender(target = document.activeElement) {
  if (!inputRenderPending) return;
  const attribute = target.id ? 'id' : target.getAttributeNames().find((name) => name.startsWith('data-'));
  const selector = attribute ? `[${attribute}="${CSS.escape(target.getAttribute(attribute))}"]` : null;
  const start = target.selectionStart;
  const end = target.selectionEnd;
  render();
  const replacement = selector ? document.querySelector(selector) : null;
  replacement?.focus();
  if (typeof start === 'number' && replacement?.setSelectionRange) replacement.setSelectionRange(start, end);
  else if (replacement instanceof HTMLInputElement && replacement.type === 'number') replacement.select();
}

function closeComparisonDialog() {
  comparisonDialogOpen = false;
  render();
  document.querySelector('[data-options-compare]')?.focus();
}

function selectConsultationOption(option) {
  if (state.consultation?.activeOption === option) {
    if (comparisonDialogOpen) closeComparisonDialog();
    return;
  }
  state = { ...normalizeLayout(switchConsultationOption(layoutSnapshot(), option)), selection: null };
  cancelEntityPress();
  activePointers.clear();
  selectionKeys = new Set();
  historyPast.length = 0;
  historyFuture.length = 0;
  drag = resize = marquee = backgroundDrag = pan = pinch = null;
  numericEdit = mobileContextMenu = null;
  precisionTool = null;
  gestureMode = 'idle';
  comparisonDialogOpen = false;
  mobilePanel = 'canvas';
  saveState();
  render();
  document.querySelector(`[data-option-select="${option}"]`)?.focus();
}

function setProjectFileFeedback(message, tone = '') {
  projectFileFeedback = message;
  projectFileFeedbackTone = tone;
  const status = document.querySelector('[data-project-feedback]');
  if (status) {
    status.textContent = message;
    status.dataset.tone = tone;
  }
}

function apply3dEdit(action) {
  const options = { normalize: true };
  if (action.type === 'add-item' || action.type === 'add-structure') {
    const kind = action.type === 'add-item' ? 'item' : 'structure';
    const collection = kind === 'item' ? 'items' : 'structures';
    const source = action[kind];
    const entity = { ...source, id: source.id ?? uid(kind) };
    if (!/^[\w-]+$/.test(entity.id) || state[collection].some(({ id }) => id === entity.id)) {
      throw new Error('이미 사용 중이거나 유효하지 않은 대상 ID입니다.');
    }
    if (kind === 'structure') {
      if (!normalizeStructure(entity, state.wallHeight)) throw new Error('지원하지 않는 구조입니다.');
      const wall = state.structures.find(({ id, type }) => id === entity.wallId && type === 'wall');
      if (wall?.locked) throw new Error('잠긴 벽에는 개구부를 추가할 수 없습니다.');
    }
    updateState({ [collection]: [...state[collection], entity] }, options);
  } else if (['update-item', 'delete-item', 'update-structure', 'delete-structure', 'update-zone'].includes(action.type)) {
    const kind = action.type.split('-')[1];
    const collection = { item: 'items', structure: 'structures', zone: 'zones' }[kind];
    const entity = state[collection].find(({ id }) => id === action.id);
    if (!entity) throw new Error('변경할 대상을 찾지 못했습니다.');
    const deleting = action.type.startsWith('delete-');
    const updates = action.updates ?? {};
    const lockOnly = !deleting && Object.keys(updates).length === 1 && Object.hasOwn(updates, 'locked');
    if (entity.locked && !lockOnly) throw new Error('잠긴 대상은 변경할 수 없습니다.');
    if (kind === 'structure') {
      const wall = state.structures.find(({ id, type }) => type === 'wall' && id === (updates.wallId ?? entity.wallId));
      if (wall?.locked && !lockOnly) throw new Error('연결된 벽이 잠겨 있습니다.');
      const changesWallGeometry = ['x', 'y', 'orientation', 'length', 'height'].some((field) => Object.hasOwn(updates, field) && updates[field] !== entity[field]);
      if (entity.type === 'wall' && (deleting || changesWallGeometry)
        && state.structures.some((opening) => opening.wallId === entity.id && opening.locked)) {
        throw new Error('잠긴 문·창이 연결된 벽은 변경할 수 없습니다.');
      }
    }
    if (kind === 'zone' && Object.keys(updates).some((field) => ['name', 'type', 'color', 'height', 'floorMaterialId', 'wallMaterialId'].includes(field))
      && zonesInSpace(state.zones, entity).some((part) => part.locked)) {
      throw new Error('잠긴 조각이 있는 공간은 변경할 수 없습니다.');
    }
    if (deleting) {
      updateState({ [collection]: state[collection].filter((entry) => entry.id !== entity.id
        && !(kind === 'structure' && entity.type === 'wall' && entry.wallId === entity.id)) }, options);
    } else {
      const update = { item: updateItem, structure: updateStructure, zone: updateZone }[kind];
      update(entity.id, { ...updates, id: entity.id, ...(kind === 'structure' ? { type: entity.type } : {}) }, options);
    }
  } else {
    throw new Error('지원하지 않는 3D 편집 동작입니다.');
  }
  return layoutSnapshot();
}

async function open3dEditor() {
  if (opening3d || active3dCleanup) return;
  opening3d = true;
  const openingDocument = documentGeneration;
  const button = document.querySelector('#open-walkthrough');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '3D 준비 중…';
  try {
    const { openWalkthrough } = await import('./walkthrough3d.js');
    if (openingDocument !== documentGeneration) return;
    active3dCleanup = openWalkthrough({
      zones: state.zones,
      items: state.items,
      structures: state.structures,
      wallHeight: state.wallHeight,
      focus: state.selection ? { ...state.selection } : null,
      initialMode: 'dollhouse',
      getLayout: layoutSnapshot,
      historyState: () => ({ canUndo: historyPast.length > 0, canRedo: historyFuture.length > 0 }),
      furnitureTemplates,
      onEdit: apply3dEdit,
      onUndo() { undo(); return layoutSnapshot(); },
      onRedo() { redo(); return layoutSnapshot(); },
      onStructureChange: (id, updates) => apply3dEdit({ type: 'update-structure', id, updates }),
      onSnapshot({ layout, imageDataUrl }) {
        const option = state.consultation?.activeOption ?? 'A';
        scenePreviews.set(option, { key: sceneGeometryKey(layout), imageDataUrl });
      },
      onClose() {
        active3dCleanup = null;
        document.querySelector('#open-walkthrough')?.focus({ preventScroll: true });
      },
    });
  } catch (error) {
    editorNotice = error.message || '3D 화면을 열지 못했습니다. 도면은 유지됩니다.';
    render();
  } finally {
    opening3d = false;
    button.disabled = false;
    button.textContent = originalText;
  }
}

function exportPortableProject() {
  try {
    const serialized = serializeProjectFile({
      projectName: activeProjectName,
      layout: layoutSnapshot(),
    });
    const url = URL.createObjectURL(new Blob([serialized], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = projectFileName(activeProjectName);
    anchor.click();
    URL.revokeObjectURL(url);
    projectDialogOpen = false;
    editorNotice = '휴대용 도면 파일을 내보냈습니다.';
    render();
    document.querySelector('[data-project-open]')?.focus();
  } catch (error) {
    setProjectFileFeedback(error.message || '도면 파일을 만들지 못했습니다.', 'error');
  }
}

function exportDecisionReport() {
  try {
    const layout = layoutSnapshot();
    const previews = {};
    for (const option of ['A', ...(layout.consultation?.inactiveGeometry ? ['B'] : [])]) {
      const preview = scenePreviews.get(option);
      if (preview?.key === sceneGeometryKey(geometryForOption(layout, option))) previews[option] = preview.imageDataUrl;
    }
    const report = createDecisionReport({
      projectName: activeProjectName,
      layout,
      previews,
    });
    const url = URL.createObjectURL(new Blob([report], { type: 'text/html;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = decisionReportFileName(activeProjectName);
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    projectDialogOpen = false;
    editorNotice = '배치 의사결정 리포트를 내보냈습니다.';
    render();
    document.querySelector('[data-project-open]')?.focus();
  } catch (error) {
    setProjectFileFeedback(error.message || '의사결정 리포트를 만들지 못했습니다.', 'error');
  }
}

function sceneGeometryKey(layout) {
  return JSON.stringify({ zones: layout.zones, items: layout.items, structures: layout.structures, wallHeight: layout.wallHeight });
}

async function importPortableProject(file) {
  const parsed = parseProjectFile(await file.text());
  if (!canReplaceCurrentDraft()) return;
  applyProjectDocument({ projectName: parsed.projectName, layout: parsed.layout });
  starterDialogOpen = false;
  projectDialogOpen = false;
  editorNotice = cloudSession
    ? `${parsed.projectName}을 새 로컬 초안으로 가져왔습니다. 클라우드에 저장하려면 계정 메뉴에서 지금 저장을 선택하세요.`
    : `${parsed.projectName}을 가져왔습니다.`;
  render();
  document.querySelector('#plan-canvas')?.focus();
}

function replaceWithBlankDraft() {
  applyProjectDocument({ projectName: '새 상담 프로젝트', layout: blankLayout() });
}

async function deleteCurrentProject() {
  const cloudProjectId = cloudSession ? activeProjectId : null;
  const projectLabel = cloudProjectId ? '현재 클라우드 도면' : '현재 브라우저 도면';
  if (!window.confirm(`${projectLabel}을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;

  const userId = currentCloudUserId();
  clearTimeout(cloudSaveTimer);
  cloudPendingSave = null;
  if (cloudSaveLoop) await cloudSaveLoop;

  try {
    if (cloudProjectId) {
      await cloudStore.deleteProject(cloudProjectId, { expectedUserId: userId });
      await refreshCloudProjects(cloudGeneration, userId);
      draftStore.removeLegacy(activeProjectStorageKey(userId));
    } else {
      draftStore.removeLegacy(ANONYMOUS_LAYOUT_KEY);
      draftStore.removeLegacy(ANONYMOUS_OWNER_KEY);
    }
    draftStore.clearRecovery();
    recoveryDraft = draftStore.readRecovery();
    replaceWithBlankDraft();
    projectDialogOpen = false;
    editorNotice = `${projectLabel}을 삭제하고 빈 초안을 열었습니다.`;
    render();
    document.querySelector('#plan-canvas')?.focus();
  } catch (error) {
    setProjectFileFeedback(error.message || '도면을 삭제하지 못했습니다.', 'error');
  }
}

async function deleteCurrentAccount() {
  if (!cloudStore || !cloudSession) return;
  const confirmation = window.prompt('계정과 모든 클라우드 도면을 영구 삭제하려면 “계정 삭제”를 입력하세요.');
  if (confirmation !== '계정 삭제') {
    setCloudFeedback('계정 삭제를 취소했습니다.');
    return;
  }

  const userId = currentCloudUserId();
  clearTimeout(cloudSaveTimer);
  cloudPendingSave = null;
  if (cloudSaveLoop) await cloudSaveLoop;
  setCloudFeedback('계정과 모든 클라우드 도면을 삭제하는 중…');

  try {
    await cloudStore.deleteAccount({ expectedUserId: userId, confirmation });
    let signOutWarning = '';
    try {
      await cloudStore.signOut({ scope: 'local' });
    } catch (error) {
      signOutWarning = error.message || '로컬 로그인 정보를 정리하지 못했습니다.';
    }
    draftStore.removeLegacy(activeProjectStorageKey(userId));
    draftStore.removeLegacy(ANONYMOUS_LAYOUT_KEY);
    draftStore.removeLegacy(ANONYMOUS_OWNER_KEY);
    await handleCloudSession(null);
    cloudDialogOpen = false;
    editorNotice = signOutWarning
      ? `계정은 삭제됐지만 ${signOutWarning} 브라우저 사이트 데이터를 지워주세요.`
      : '계정과 모든 클라우드 도면을 삭제했습니다.';
    render();
    document.querySelector('#plan-canvas')?.focus();
  } catch (error) {
    setCloudFeedback(error.message || '계정을 삭제하지 못했습니다.', 'error');
  }
}

function commitHistory(previous) {
  const current = layoutSnapshot();
  if (snapshotsMatch(previous, current)) return;
  historyPast.push(previous);
  if (historyPast.length > HISTORY_LIMIT) historyPast.shift();
  historyFuture.length = 0;
}

function restoreSnapshot(snapshot, destination) {
  if (!snapshot) return;
  const previousSelection = state.selection;
  destination.push(layoutSnapshot());
  state = { ...state, ...snapshot, selection: null };
  if (!snapshot.consultation) delete state.consultation;
  const remainingSelection = workspaceMode === 'simple' ? selectedEntries() : [];
  selectionKeys = new Set(remainingSelection.map(({ kind, id }) => selectionKey(kind, id)));
  const primary = remainingSelection.find(({ kind, id }) => kind === previousSelection?.kind && id === previousSelection.id)
    ?? remainingSelection.at(-1);
  state.selection = primary ? { kind: primary.kind, id: primary.id } : null;
  drag = null;
  resize = null;
  backgroundDrag = null;
  marquee = null;
  precisionTool = null;
  numericEdit = null;
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
    if (!isEditable2dKind(kind)) return [];
    const collection = kind === 'zone' ? state.zones : state.dimensions;
    const entity = collection.find((entry) => entry.id === id);
    return entity ? [{ kind, id, entity }] : [];
  });
}

function isSelected(kind, id) {
  return isEditable2dKind(kind) && selectionKeys.has(selectionKey(kind, id));
}

function selectEntity(kind, id, toggle = false) {
  if (!isEditable2dKind(kind)) return false;
  const collection = kind === 'zone' ? state.zones : state.dimensions;
  if (!collection.some((entity) => entity.id === id)) return false;
  if (state.selection?.kind !== kind || state.selection.id !== id) quickSizesOpen = false;
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
  quickSizesOpen = false;
  mobileMultiSelect = false;
  selectionKeys = new Set();
  state.selection = null;
  mobileContextMenu = null;
  mobileMoveArmed = false;
  render();
}

function selectedEntity() {
  return selectedEntries().find(({ kind, id }) => kind === state.selection?.kind && id === state.selection.id)?.entity ?? null;
}

function saveState() {
  layoutChangeVersion += 1;
  cloudDirty = true;
  persistCurrentDraft();
  if (cloudSession && !cloudConflict) {
    scheduleCloudSave();
  }
}

const activeProjectStorageKey = (userId) => `${ACTIVE_PROJECT_KEY_PREFIX}:${userId}`;
const currentCloudUserId = () => cloudSession?.user?.id ?? null;
const cloudOperationIsCurrent = (generation, userId) => (
  generation === cloudGeneration && userId && userId === currentCloudUserId()
);
const cloudIsBusy = () => cloudLoadBusy || Boolean(cloudSaveLoop);

function hasMeaningfulLocalLayout() {
  return state.zones.length > 0 || state.items.length > 0 || state.structures.length > 0 || state.dimensions.length > 0;
}

function openDemoGallery() {
  starterDialogOpen = false;
  demoGalleryOpen = true;
  pendingDemoId = null;
  pendingDemo3d = false;
  render();
  document.querySelector('[data-demo-close]')?.focus({ preventScroll: true });
}

function closeDemoGallery() {
  demoGalleryOpen = false;
  pendingDemoId = null;
  pendingDemo3d = false;
  render();
  document.querySelector('[data-demo-open]')?.focus();
}

function requestDemoLayout(id, openIn3d = false) {
  if (!demoLayoutById(id)) return;
  pendingDemo3d = openIn3d;
  if (hasMeaningfulLocalLayout()) {
    pendingDemoId = id;
    render();
    document.querySelector('[data-demo-confirm-accept]')?.focus();
    return;
  }
  applyDemoLayout(id);
}

function applyDemoLayout(id, openIn3d = pendingDemo3d) {
  const demo = demoLayoutById(id);
  if (!demo) return;
  if (!canReplaceCurrentDraft()) return;
  const { source, typology, ...layout } = demo;
  applyProjectDocument({ projectName: demo.name, layout });
  starterDialogOpen = false;
  demoGalleryOpen = false;
  pendingDemoId = null;
  pendingDemo3d = false;
  editorNotice = '샘플 도면을 열었습니다.';
  pendingFocus = { kind: 'canvas' };
  render();
  if (openIn3d) void open3dEditor();
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
  if (!cloudStore || !cloudSession || !activeProjectId || cloudConflict || cloudLoadBusy) return;
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
  const documentVersion = documentGeneration;
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
      expectedUserId: userId,
    });
    if (!cloudOperationIsCurrent(generation, userId) || documentVersion !== documentGeneration) return null;
    if (targetProjectId !== activeProjectId) return null;
    activeProjectId = project.id;
    activeProjectRevision = Number(project.revision);
    if (changeVersion === layoutChangeVersion) {
      activeProjectName = project.name;
      cloudDirty = false;
    }
    cloudConflict = false;
    persistCurrentDraft();
    await refreshCloudProjects(generation, userId);
    if (!cloudOperationIsCurrent(generation, userId) || documentVersion !== documentGeneration) return null;
    setCloudFeedback(cloudDirty ? '클라우드 저장 대기 중' : createVersion ? '새 버전을 저장했습니다.' : '클라우드에 저장했습니다.', cloudDirty ? '' : 'success');
    return project;
  } catch (error) {
    if (!cloudOperationIsCurrent(generation, userId) || documentVersion !== documentGeneration) return null;
    const conflict = error.code === '40001' || String(error.message).includes('PROJECT_CONFLICT');
    cloudConflict = conflict;
    setCloudFeedback(
      conflict ? '다른 기기의 수정본이 있습니다. 현재 상담을 새 프로젝트로 저장하거나 복구본을 남기고 서버 도면을 열어주세요.' : error.message || '클라우드 저장에 실패했습니다.',
      'error',
    );
    const recovery = document.querySelector('[data-cloud-recovery]');
    if (recovery) recovery.hidden = !cloudConflict;
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
  if (cloudConflict || cloudLoadBusy) return Promise.resolve(null);
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

async function openCloudProject(id, { skipFlush = false, preserveLocal = false } = {}) {
  if (!cloudStore || !cloudSession || !id || cloudLoadBusy) return;
  const unlinkedLocalDraft = !activeProjectId;
  if ((preserveLocal || unlinkedLocalDraft) && !protectCurrentDraft()) return;
  if (!skipFlush && !unlinkedLocalDraft && !(await flushCloudSave())) return;
  const generation = cloudGeneration;
  const documentVersion = documentGeneration;
  const userId = currentCloudUserId();
  clearTimeout(cloudSaveTimer);
  cloudPendingSave = null;
  cloudLoadBusy = true;
  setCloudFeedback('도면을 불러오는 중…');
  render();
  try {
    if (cloudSaveLoop) await cloudSaveLoop;
    if (!cloudOperationIsCurrent(generation, userId) || documentVersion !== documentGeneration) return;
    const project = await cloudStore.loadProject(id);
    if (!cloudOperationIsCurrent(generation, userId) || documentVersion !== documentGeneration) return;
    applyProjectDocument({
      projectName: project.name,
      layout: project.layout_json,
      ownerId: userId,
      projectId: project.id,
      baseRevision: Number(project.revision),
    });
    cloudDialogOpen = false;
    setCloudFeedback(`${project.name} 도면을 불러왔습니다.`, 'success');
  } catch (error) {
    if (cloudOperationIsCurrent(generation, userId)) setCloudFeedback(error.message || '도면을 불러오지 못했습니다.', 'error');
  } finally {
    if (cloudOperationIsCurrent(generation, userId)) {
      cloudLoadBusy = false;
      render();
      document.querySelector(cloudDialogOpen ? '[data-cloud-reload]' : '#plan-canvas')?.focus();
    }
  }
}

async function createCloudCopy() {
  if (!cloudStore || !cloudSession || cloudLoadBusy) return;
  const captured = currentDraftDocument();
  if (!protectCurrentDraft()) return;
  const generation = cloudGeneration;
  const documentVersion = documentGeneration;
  const userId = currentCloudUserId();
  clearTimeout(cloudSaveTimer);
  cloudPendingSave = null;
  cloudLoadBusy = true;
  setCloudFeedback('현재 상담을 새 프로젝트로 저장하는 중…');
  render();
  try {
    if (cloudSaveLoop) await cloudSaveLoop;
    if (!cloudOperationIsCurrent(generation, userId) || documentVersion !== documentGeneration) return;
    const project = await cloudStore.saveProject({
      id: null,
      name: normalizeProjectName(`${captured.projectName} 복사본`),
      layout: captured.layout,
      expectedRevision: null,
      createVersion: true,
      expectedUserId: userId,
    });
    if (!cloudOperationIsCurrent(generation, userId) || documentVersion !== documentGeneration) return;
    applyProjectDocument({
      projectName: project.name,
      layout: captured.layout,
      ownerId: userId,
      projectId: project.id,
      baseRevision: Number(project.revision),
    });
    const appliedDocumentVersion = documentGeneration;
    await refreshCloudProjects(generation, userId);
    if (!cloudOperationIsCurrent(generation, userId) || appliedDocumentVersion !== documentGeneration) return;
    cloudDialogOpen = false;
    setCloudFeedback('현재 상담을 별도의 프로젝트로 저장했습니다.', 'success');
  } catch (error) {
    if (cloudOperationIsCurrent(generation, userId)) setCloudFeedback(error.message || '복사본을 저장하지 못했습니다.', 'error');
  } finally {
    if (cloudOperationIsCurrent(generation, userId)) {
      cloudLoadBusy = false;
      render();
      document.querySelector(cloudDialogOpen ? '[data-cloud-copy]' : '[data-cloud-open]')?.focus();
    }
  }
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
  cloudConflict = false;
  if (previousUserId && previousUserId !== nextUserId) {
    cloudProjects = [];
    consultationDialogOpen = false;
    comparisonDialogOpen = false;
    draftStore.clear();
    draftStore.clearRecovery();
    draftStore.removeLegacy(activeProjectStorageKey(previousUserId));
    draftStore.removeLegacy(ANONYMOUS_LAYOUT_KEY);
    draftStore.removeLegacy(ANONYMOUS_OWNER_KEY);
    recoveryDraft = draftStore.readRecovery();
    deferredOwnerDraft = null;
    replaceWithBlankDraft();
    render();
  }
  if (!session) {
    cloudProjects = [];
    activeProjectId = null;
    activeProjectRevision = null;
    setCloudFeedback(deferredOwnerDraft
      ? '기존 상담을 복구하려면 같은 계정으로 로그인해주세요.'
      : cloudStore ? '로컬 작업 · 로그인하면 여러 기기에서 동기화됩니다.' : '로그인 없이 로컬 작업');
    render();
    if (cloudDialogOpen) document.querySelector('.cloud-dialog button, .cloud-dialog input')?.focus();
    return;
  }
  const stored = draftStore.read();
  const cached = deferredOwnerDraft?.ownerId === nextUserId
    ? deferredOwnerDraft
    : stored.ok && stored.draft?.ownerId === nextUserId ? stored.draft : null;
  const anonymous = !deferredOwnerDraft && stored.ok && stored.draft && !stored.draft.ownerId;
  if (deferredOwnerDraft && deferredOwnerDraft.ownerId !== nextUserId) {
    draftStore.clear();
    draftStore.clearRecovery();
    recoveryDraft = draftStore.readRecovery();
  }
  deferredOwnerDraft = null;
  setCloudFeedback('내 도면을 확인하는 중…');
  let restorationDocumentVersion = documentGeneration;
  let restorationChangeVersion = layoutChangeVersion;
  try {
    if (cached) applyProjectDocument(cached);
    restorationDocumentVersion = documentGeneration;
    restorationChangeVersion = layoutChangeVersion;
    const projects = await refreshCloudProjects(generation, nextUserId);
    if (!projects) return;
    if (
      restorationDocumentVersion !== documentGeneration
      || restorationChangeVersion !== layoutChangeVersion
      || consultationDialogOpen
      || numericEdit
      || gestureMode !== 'idle'
    ) {
      persistCurrentDraft();
      setCloudFeedback('로그인 중 변경한 현재 상담을 유지했습니다.');
      return;
    }
    if (cached) {
      const preferred = projects.find((project) => project.id === cached.projectId);
      if (cached.projectId && cached.dirty) {
        cloudConflict = !preferred || Number(preferred.revision) !== cached.baseRevision;
        setCloudFeedback(cloudConflict
          ? '저장되지 않은 상담을 복구했습니다. 서버 수정본과 충돌하여 현재 작업을 유지합니다.'
          : '저장되지 않은 상담을 복구했습니다.', cloudConflict ? 'error' : 'success');
        if (!cloudConflict) scheduleCloudSave();
      } else if (preferred) {
        await openCloudProject(preferred.id, { skipFlush: true });
        return;
      } else {
        setCloudFeedback('상담 초안을 복구했습니다. 지금 저장하면 클라우드 프로젝트가 됩니다.', 'success');
      }
      render();
      return;
    }
    if (anonymous) {
      persistCurrentDraft();
      setCloudFeedback('로컬 상담을 유지했습니다. 지금 저장을 누르면 클라우드에 새 프로젝트로 보관됩니다.');
    } else if (cloudProjects[0]) {
      await openCloudProject(cloudProjects[0].id, { skipFlush: true });
      return;
    } else {
      replaceWithBlankDraft();
      setCloudFeedback('새 상담을 시작하세요. 지금 저장하면 클라우드에 보관됩니다.');
    }
    if (!cloudOperationIsCurrent(generation, nextUserId)) return;
    cloudDialogOpen = false;
    render();
  } catch (error) {
    if (
      cloudOperationIsCurrent(generation, nextUserId)
      && restorationDocumentVersion === documentGeneration
      && restorationChangeVersion === layoutChangeVersion
    ) {
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
  const next = Object.hasOwn(updates, 'zones')
    ? reconcileZoneOpenings(previous, { ...state, ...updates })
    : { ...state, ...updates };
  if (!next) throw new Error('연결된 문·창을 유지할 수 없습니다. 잠금, 벽 길이와 개구부 폭을 확인하세요.');
  // Validate the complete 3D edit before changing state, history or storage.
  // This retains the same schema/size boundary as local, cloud and portable data.
  if (options.normalize) {
    const normalized = normalizeLayout(next);
    preparePersistedLayout(normalized);
    state = { ...normalized, selection: next.selection };
  } else {
    state = next;
  }
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

function updateEditorState(updates, options = {}) {
  try {
    updateState(updates, options);
  } catch (error) {
    editorNotice = error.message;
    render();
  }
}

function commitEditorPreview(previous) {
  const next = layoutSnapshot();
  state = { ...state, ...previous };
  updateEditorState(next, { historySnapshot: previous });
}

function updateZone(id, updates, options = {}) {
  const selected = state.zones.find((zone) => zone.id === id);
  const sharedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([field]) => ['name', 'type', 'color', 'height', 'floorMaterialId', 'wallMaterialId'].includes(field)),
  );
  const zones = state.zones.map((zone) => {
    const sameSpace = selected && spaceIdOf(zone) === spaceIdOf(selected);
    if (zone.id !== id && (!sameSpace || !Object.keys(sharedUpdates).length)) return zone;
    const next = {
      ...zone,
      ...(sameSpace ? sharedUpdates : {}),
      ...(zone.id === id ? updates : {}),
    };
    next.x = numberValue(next.x, zone.x, -5000, 5000);
    next.y = numberValue(next.y, zone.y, -5000, 5000);
    next.name = typeof next.name === 'string' ? next.name.slice(0, 80) : zone.name;
    next.type = SPACE_TYPES.includes(next.type) ? next.type : zone.type;
    next.color = normalizeHexColor(next.color, zone.color);
    next.width = numberValue(next.width, zone.width, 100, 1200);
    next.depth = numberValue(next.depth, zone.depth, 100, 1200);
    next.height = numberValue(next.height, zone.height ?? 240, 100, 600);
    return zone.points ? zoneFromPoints(next, zone.points.map(point => ({
      x: next.x + point.x * next.width / zone.width,
      y: next.y + point.y * next.depth / zone.depth,
    }))) : next;
  });
  updateEditorState({ zones }, options);
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
  const zoneIds = new Set(entries.filter(({ kind }) => kind === 'zone').map(({ id }) => id));
  const dimensionIds = new Set(entries.filter(({ kind }) => kind === 'dimension').map(({ id }) => id));
  updateState({
    zones: state.zones.map((zone) => zoneIds.has(zone.id) ? { ...zone, locked } : zone),
    dimensions: state.dimensions.map((dimension) => dimensionIds.has(dimension.id) ? { ...dimension, locked } : dimension),
  }, { preserveMultiSelection: true });
}

function toggleSelectionLocked() {
  const entries = selectedEntries();
  if (!entries.length) return;
  setSelectionLocked(!entries.every(({ entity }) => entity.locked));
}

function applyClipboard(clipboard, offset, notice) {
  const previous = layoutSnapshot();
  const pasted = pasteLayoutClipboard(previous, { zones: clipboard.zones, dimensions: clipboard.dimensions }, { offset, idFactory: uid });
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
  updateEditorState({ zones: [...state.zones, zone], selection: { kind: 'zone', id: zone.id } });
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
  mobileMultiSelect = false;
  mobileMoveArmed = false;
  updateEditorState({
    zones: state.zones.map((zone) => selectedSpaceIds.has(spaceIdOf(zone)) ? { ...zone, ...shared } : zone),
    selection: { kind: 'zone', id: primary.id },
  });
}

function addZonePart() {
  if (state.selection?.kind !== 'zone') return;
  const selected = selectedEntity();
  if (!selected || selected.locked) return;
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
  delete part.points;
  updateEditorState({ zones: [...state.zones, part], selection: { kind: 'zone', id: part.id } });
}

function quickNumericFields(kind) {
  return kind === 'zone' ? [['x', 'X'], ['y', 'Y'], ['width', 'W'], ['depth', 'D']] : [];
}

function normalizeQuickNumericEntity(original, preview) {
  const next = {
    ...original, ...preview,
    x: numberValue(preview.x, original.x, -5000, 5000),
    y: numberValue(preview.y, original.y, -5000, 5000),
    width: numberValue(preview.width, original.width, 100, 1200),
    depth: numberValue(preview.depth, original.depth, 100, 1200),
  };
  return original.points ? zoneFromPoints(next, original.points.map(point => ({
    x: next.x + point.x * next.width / original.width,
    y: next.y + point.y * next.depth / original.depth,
  }))) : next;
}

function previewQuickNumericField(input) {
  const value = Number(input.value);
  if (!Number.isFinite(value)) return;
  const kind = input.dataset.quickKind;
  const id = input.dataset.quickId;
  if (kind !== 'zone') return;
  const collection = 'zones';
  const current = state.zones.find((entity) => entity.id === id);
  if (!current || current.locked) return;
  if (!numericEdit || numericEdit.kind !== kind || numericEdit.id !== id) {
    numericEdit = {
      kind,
      id,
      original: { ...current },
      transaction: createNumericEditTransaction(current),
      historySnapshot: layoutSnapshot(),
    };
  }
  const preview = numericEdit.transaction.preview({ [input.dataset.quickField]: value });
  const entity = normalizeQuickNumericEntity(numericEdit.original, preview);
  numericEdit.preview = entity;
  state = {
    ...state,
    [collection]: state[collection].map((entry) => entry.id === id ? entity : entry),
  };
}

function commitQuickNumericEdit(field = null) {
  if (!numericEdit) return;
  const historySnapshot = numericEdit.historySnapshot;
  numericEdit.transaction.commit();
  numericEdit = null;
  pendingFocus = field ? { kind: 'quick-field', field } : null;
  commitEditorPreview(historySnapshot);
}

function cancelQuickNumericEdit(field = null) {
  if (!numericEdit) return;
  const snapshot = numericEdit.historySnapshot;
  numericEdit.transaction.cancel();
  numericEdit = null;
  state = { ...state, ...snapshot };
  pendingFocus = field ? { kind: 'quick-field', field } : { kind: 'canvas' };
  render();
}

function deleteSelectedZonePart() {
  if (state.selection?.kind !== 'zone') return;
  if (selectedEntity()?.locked) {
    editorNotice = '잠긴 공간 조각은 삭제할 수 없습니다.';
    render();
    return;
  }
  updateEditorState({ zones: state.zones.filter((zone) => zone.id !== state.selection.id), selection: null });
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
  updateEditorState({ zones: state.zones.filter((zone) => spaceIdOf(zone) !== spaceId), selection: null });
}

function deleteSelection() {
  const entries = selectedEntries().filter(({ entity }) => !entity.locked);
  if (!entries.length) {
    editorNotice = '잠긴 대상은 삭제할 수 없습니다.';
    render();
    return;
  }
  const zoneIds = new Set(entries.filter((entry) => entry.kind === 'zone').map((entry) => entry.id));
  const dimensionIds = new Set(entries.filter((entry) => entry.kind === 'dimension').map((entry) => entry.id));
  updateEditorState({
    zones: state.zones.filter((zone) => !zoneIds.has(zone.id)),
    dimensions: state.dimensions.filter((dimension) => !dimensionIds.has(dimension.id)),
    selection: null,
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
  getDoorLeafSegments(state.structures.filter(({ type }) => type === 'door')).forEach(({ start, end }) => bounds.push({
    left: Math.min(start.x, end.x),
    right: Math.max(start.x, end.x),
    top: Math.min(start.y, end.y),
    bottom: Math.max(start.y, end.y),
  }));
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
  if (canvasBase) return canvasBase;
  const bounds = editorContentBounds();
  canvasBase = {
    left: bounds.left - CANVAS_PADDING,
    top: bounds.top - CANVAS_PADDING,
    width: bounds.width + CANVAS_PADDING * 2,
    height: bounds.depth + CANVAS_PADDING * 2,
  };
  return canvasBase;
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
  spaceEditor?.refresh();
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
  if (drag || resize || marquee || backgroundDrag || gestureMode === 'pinch') return;
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
  canvasBase = null;
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
  return null;
}

function renderTransformHud() {
  if (workspaceMode === 'simple' || (isMobileLayout() && mobileContextMenu)) return '';
  const content = transformHudContent();
  if (!content) return '';
  const entity = selectionKeys.size === 1 ? selectedEntity() : null;
  const fields = entity && state.selection && !entity.locked
    ? quickNumericFields(state.selection.kind, entity)
    : [];
  return `<div class="transform-hud ${fields.length ? 'has-quick-fields' : ''}" data-transform-hud data-mode="selected">
    <span class="transform-summary-label" data-transform-label>${content.label}</span>
    <strong class="transform-summary-primary" data-transform-primary>${content.primary}</strong>
    <small class="transform-summary-secondary" data-transform-secondary>${content.secondary}</small>
    ${fields.length ? `<div class="quick-numeric-fields" aria-label="${escapeHtml(entity.name)} 빠른 수치 편집">
      ${fields.map(([field, label]) => `<label><span>${label}</span><input data-quick-field="${field}" data-quick-kind="${state.selection.kind}" data-quick-id="${entity.id}" type="number" inputmode="decimal" value="${Math.round(entity[field])}" aria-label="${escapeHtml(entity.name)} ${label}" /></label>`).join('')}
    </div>` : ''}
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
  document.querySelector('.resize-overlay')?.removeAttribute('transform');
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
  syncAlignmentGuides();
  syncTransformHud('move');
  syncValidationClasses();
}

function syncResizePreview() {
  if (!resize) return;
  const entity = state.zones.find((zone) => zone.id === resize.id);
  const node = document.querySelector(`[data-zone-id="${resize.id}"]`);
  if (!entity || !node) return;
  document.querySelectorAll('.space-outline').forEach((outline) => outline.setAttribute('visibility', 'hidden'));
  const scaleX = entity.width / resize.origin.width;
  const scaleY = entity.depth / resize.origin.depth;
  const transform = `matrix(${scaleX} 0 0 ${scaleY} ${entity.x - resize.origin.x * scaleX} ${entity.y - resize.origin.y * scaleY})`;
  node.setAttribute('transform', transform);
  document.querySelector('.resize-overlay')?.setAttribute('transform', transform);
  syncTransformHud('resize');
  syncValidationClasses();
}

function resetTemporaryGestureState() {
  cancelEntityPress();
  drag = null;
  resize = null;
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
  spaceEditor?.cancelPointer();
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
  if (!activePointers.size && !drag && !resize && !marquee && !backgroundDrag) gestureMode = 'idle';
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
  if (kind !== 'zone') return;
  if (event.button !== undefined && event.button !== 0) return;
  const collection = state.zones;
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
  const movingBounds = [...zoneOrigins.values()].map(zoneBounds);
  const targetBounds = state.zones.filter((zone) => !zoneOrigins.has(zone.id)).map(zoneBounds);
  drag = {
    kind,
    id,
    startPointer: point,
    primaryOrigin: { x: entity.x, y: entity.y },
    zoneOrigins,
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

function startEntityPress(event, kind, id) {
  if (kind !== 'zone') return;
  const point = svgPoint(event);
  id = [...state.zones].reverse().find(zone => pointInZone(point, zone))?.id ?? id;
  const simpleTouch = workspaceMode === 'simple' && event.pointerType === 'touch';
  const collection = state.zones;
  const entity = collection.find((entry) => entry.id === id);
  if (entity?.locked) {
    event.preventDefault();
    event.stopPropagation();
    selectEntity(kind, id, usesAdditiveSelection(event));
    mobileContextMenu = isMobileLayout() && !simpleTouch ? { kind, id } : null;
    editorNotice = `${entity.name}은(는) 잠겨 있습니다.`;
    render();
    return;
  }
  if (event.pointerType !== 'touch' || (!isMobileLayout() && !simpleTouch)) {
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
    mobileContextMenu = workspaceMode === 'simple' ? null : { kind: press.kind, id: press.id };
    pendingFocus = { kind: workspaceMode === 'simple' ? 'canvas' : 'context-menu' };
  }
  return true;
}

function startResize(event, kind, id, handle) {
  if (kind !== 'zone') return;
  if (event.button !== undefined && event.button !== 0) return;
  if (!beginPointerContact(event)) return;
  event.preventDefault();
  event.stopPropagation();
  const collection = state.zones;
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
  const resized = resizeZoneFromHandle(resize.origin, resize.handle, { x: snap(point.x), y: snap(point.y) });
  state = { ...state, zones: state.zones.map((zone) => zone.id === resize.id ? resized : zone) };
  syncResizePreview();
}

function finishResize() {
  if (!resize) return;
  const previous = resize.historySnapshot;
  resize = null;
  gestureMode = activePointers.size ? 'idle-await-release' : 'idle';
  commitEditorPreview(previous);
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
  state = {
    ...state,
    zones: state.zones.map((zone) => {
      const origin = drag.zoneOrigins.get(zone.id);
      return origin ? { ...zone, x: origin.x + snapped.x, y: origin.y + snapped.y } : zone;
    }),
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
  const previous = drag.historySnapshot;
  drag = null;
  alignmentGuides = [];
  gestureMode = activePointers.size ? 'idle-await-release' : 'idle';
  commitEditorPreview(previous);
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

function resizeHandlesMarkup(entity) {
  const radius = isMobileLayout() ? 13 : 8;
  const { x, y, width, depth } = entity;
  const positions = {
    nw: [x, y], n: [x + width / 2, y], ne: [x + width, y],
    e: [x + width, y + depth / 2], se: [x + width, y + depth],
    s: [x + width / 2, y + depth], sw: [x, y + depth], w: [x, y + depth / 2],
  };
  const frame = `<rect class="transform-bounds" x="${x}" y="${y}" width="${width}" height="${depth}" />`;
  if (workspaceMode === 'simple' && !quickSizesOpen) return frame;
  const handles = Object.keys(RESIZE_DIRECTIONS).map((handle) => {
    const [x, y] = positions[handle];
    return `<circle class="resize-hit-target handle-${handle}" cx="${x}" cy="${y}" r="${radius}"
      fill="none" stroke="transparent" stroke-width="44" vector-effect="non-scaling-stroke" pointer-events="stroke"
      data-resize-kind="zone" data-resize-id="${entity.id}" data-resize-handle="${handle}"></circle>
    <circle class="resize-handle handle-${handle}" cx="${x}" cy="${y}" r="${radius}"
      data-resize-kind="zone" data-resize-id="${entity.id}" data-resize-handle="${handle}">
      <title>${handle} 방향 크기 조절</title></circle>`;
  }).join('');
  return `${frame}${handles}`;
}

function wallSegmentMarkup(segment) {
  const { start, end } = segmentEndpoints(segment);
  return `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" />`;
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

function doorSymbolMarkup(door, options = {}) {
  const half = door.width / 2;
  const attributes = `data-structure-id="${door.id}" pointer-events="none" transform="translate(${door.x} ${door.y}) rotate(${structureAngle(door)})"`;
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
  return `<g class="plan-structure plan-door door-${door.doorType} ${door.locked ? 'is-locked' : ''}" ${attributes}>
    <title>${escapeHtml(door.name)} ${DOOR_TYPES[door.doorType]} · 3D에서 편집</title>
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
  return `<g class="plan-structure plan-window${selected} ${windowStructure.locked ? 'is-locked' : ''}" data-structure-id="${windowStructure.id}" pointer-events="none" transform="translate(${windowStructure.x} ${windowStructure.y}) rotate(${structureAngle(windowStructure)})">
    <title>${escapeHtml(windowStructure.name)} 샷시형 미닫이창</title>
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
    const sizeLabel = zone.points
      ? `${zone.points.length}개 벽 · ${(calculateUnionArea([zone]) / 10000).toFixed(1)}m²`
      : details.parts.length > 1
      ? `${details.parts.length}조각 · ${(calculateUnionArea(details.parts) / 10000).toFixed(1)}m² · H ${zone.height ?? 240}cm`
      : `${meters(zone.width)} × ${meters(zone.depth)} · H ${zone.height ?? 240}cm`;
    const zoneItems = state.items.filter((item) => pointInZone({ x: item.x, y: item.y }, zone));
    const labelCandidates = [
      { x: zone.x + 12, y: zone.y + 22, anchor: 'start' },
      { x: zone.x + zone.width - 12, y: zone.y + 22, anchor: 'end' },
      { x: zone.x + 12, y: zone.y + zone.depth - 28, anchor: 'start' },
      { x: zone.x + zone.width - 12, y: zone.y + zone.depth - 28, anchor: 'end' },
    ];
    const labelPosition = zone.points ? { ...zoneInteriorPoint(zone), anchor: 'middle' } : labelCandidates.reduce((best, candidate) => {
      const clearance = Math.min(...zoneItems.map((item) => Math.hypot(candidate.x - item.x, candidate.y - item.y)), 10000);
      return clearance > best.clearance ? { ...candidate, clearance } : best;
    }, { ...labelCandidates[0], clearance: -1 });
    return `<g class="plan-zone ${details.parts.length > 1 ? 'is-compound' : ''} ${spaceSelected ? 'is-space-selected' : ''} ${selected ? 'is-selected' : ''} ${zone.locked ? 'is-locked' : ''} ${zoneOverlaps.has(zone.id) ? 'has-overlap' : ''}" data-zone-id="${zone.id}">
      ${zone.points ? `<polygon class="zone-hit-target" points="${zonePoints(zone).map(point => `${point.x},${point.y}`).join(' ')}"
        fill="none" stroke="transparent" stroke-width="44" vector-effect="non-scaling-stroke" pointer-events="stroke" />
      <polygon points="${zonePoints(zone).map(point => `${point.x},${point.y}`).join(' ')}" fill="${zone.color}" />`
      : `<rect class="zone-hit-target" x="${zone.x}" y="${zone.y}" width="${zone.width}" height="${zone.depth}"
        fill="none" stroke="transparent" stroke-width="44" vector-effect="non-scaling-stroke" pointer-events="stroke" />
      <rect x="${zone.x}" y="${zone.y}" width="${zone.width}" height="${zone.depth}" fill="${zone.color}" />`}
      ${showLabel ? `<text class="zone-name" x="${labelPosition.x}" y="${labelPosition.y}" text-anchor="${labelPosition.anchor}">${escapeHtml(zone.name)}</text>
      <text class="zone-size" x="${labelPosition.x}" y="${labelPosition.y + 16}" text-anchor="${labelPosition.anchor}">${sizeLabel}</text>` : ''}
    </g>`;
  }).join('');
  const openings = state.structures.filter((structure) => structure.type !== 'wall');
  const userWalls = state.structures.filter((structure) => structure.type === 'wall');
  const automaticWallOpenings = (segment) => doorsForAutomaticWallSegment(segment, openings, userWalls);
  const spaceOutlines = spaces.filter((parts) => selectedSpaceIds.has(spaceIdOf(parts[0]))).map((parts) => {
    const active = selectedSpaceIds.has(spaceIdOf(parts[0]));
    const outlineSpans = getExteriorWallSegments(parts).flatMap((segment) => splitWallSegment(segment, automaticWallOpenings(segment)).spans);
    return `<g class="space-outline ${active ? 'is-active' : ''}">${outlineSpans.map(wallSegmentMarkup).join('')}</g>`;
  }).join('');
  const automaticSegments = [...getExteriorWallSegments(state.zones), ...getInteriorWallSegments(state.zones)];
  const automaticWalls = automaticSegments.flatMap((segment) => splitWallSegment(segment, automaticWallOpenings(segment)).spans).map(wallSegmentMarkup).join('');
  const structures = state.structures.map((structure) => {
    if (structure.type === 'door') return doorSymbolMarkup(structure);
    if (structure.type === 'window') return windowSymbolMarkup(structure);
    const wallSpans = splitWallSegment(
      structureSegment(structure),
      openings.filter((opening) => opening.wallId === structure.id),
    ).spans;
    const wallStrokes = wallSpans.map((span) => {
      const endpoints = segmentEndpoints(span);
      const angle = structureAngle(structure) * Math.PI / 180;
      const axis = point => (point.x - structure.x) * Math.cos(angle) + (point.y - structure.y) * Math.sin(angle);
      const start = axis(endpoints.start);
      const end = axis(endpoints.end);
      return `<line class="wall-stroke" x1="${start}" y1="0" x2="${end}" y2="0" />`;
    }).join('');
    return `<g class="plan-structure plan-wall ${structure.locked ? 'is-locked' : ''}" data-structure-id="${structure.id}" pointer-events="none" transform="translate(${structure.x} ${structure.y}) rotate(${structureAngle(structure)})">
      <title>${escapeHtml(structure.name)} 벽</title>
      ${wallStrokes}
      <text x="0" y="-10">${escapeHtml(structure.name)} · ${Math.round(structure.length)}cm${structure.locked ? ' · 🔒' : ''}</text>
    </g>`;
  }).join('');
  const items = state.items.map((item) => {
    const selected = isSelected('item', item.id);
    const classes = ['plan-item', selected ? 'is-selected' : '', item.locked ? 'is-locked' : '', collisions.has(item.id) ? 'has-collision' : '', outOfBounds.has(item.id) ? 'is-outside' : '', heightViolations.has(item.id) ? 'is-too-tall' : ''].filter(Boolean).join(' ');
    return `<g class="${classes}" data-item-id="${item.id}" pointer-events="none" transform="translate(${item.x} ${item.y}) rotate(${item.rotation})">
      <g class="item-shape" fill="${item.color}">${shapeMarkup(item)}</g>
      <g transform="rotate(${-item.rotation})" pointer-events="none">
        <text class="item-label" y="-3">${escapeHtml(item.name)}</text>
        <text class="item-height" y="15">H ${item.height}cm${item.elevation ? ` · Z ${item.elevation}cm` : ''}${item.locked ? ' · 🔒' : ''}</text>
      </g>
    </g>`;
  }).join('');
  const groupBoundsMarkup = selectionKeys.size > 1 ? (() => {
    const selectedBounds = selectedEntries().map(({ kind, entity }) => kind === 'zone' ? zoneBounds(entity) : dimensionBounds(entity));
    const selectedBoundsUnion = unionBounds(selectedBounds);
    return `<rect class="group-selection-bounds" x="${selectedBoundsUnion.left}" y="${selectedBoundsUnion.top}"
      width="${selectedBoundsUnion.right - selectedBoundsUnion.left}" height="${selectedBoundsUnion.bottom - selectedBoundsUnion.top}" rx="6" />`;
  })() : '';
  const resizeOverlay = selectedZone && !selectedZone.locked && !selectedZone.points && !spaceEditor?.editingShape
    ? `<g class="resize-overlay">${resizeHandlesMarkup(selectedZone)}</g>` : '';
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
  return `<svg id="plan-canvas" class="plan-svg" viewBox="${viewBox}" tabindex="0" aria-label="2D 공간 형태 편집 · 가구와 문은 읽기 전용">
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
    return `<div class="empty-inspector"><span>↖</span><h3 id="inspector-heading" tabindex="-1">공간을 선택하세요</h3><p>2D에서 공간의 형태와 치수를 정하고, 가구·문·창·벽은 3D 상세 편집에서 배치하세요.</p></div>`;
  }
  if (selectionKeys.size > 1) {
    const entries = selectedEntries();
    const zoneCount = entries.filter((entry) => entry.kind === 'zone').length;
    const dimensionCount = entries.filter((entry) => entry.kind === 'dimension').length;
    const selectedSpaceCount = new Set(entries.filter((entry) => entry.kind === 'zone').map((entry) => spaceIdOf(entry.entity))).size;
    const canMergeSpaces = selectedSpaceCount > 1 && selectedSpacesCanMerge();
    return `<div class="multi-selection-inspector">
      <span>다중 선택</span>
      <strong id="inspector-heading" tabindex="-1">${entries.length}개 대상</strong>
      <p>${[zoneCount ? `공간 조각 ${zoneCount}개` : '', dimensionCount ? `치수 ${dimensionCount}개` : ''].filter(Boolean).join(' · ')}</p>
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
        <label>공간 용도<select data-zone-field="type">${optionsMarkup([...new Set(['거실', '방', '욕실', entity.type])], entity.type)}</select></label>
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
  return '';
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
  const title = groupContext ? `${entries.length}개 그룹` : target.entity.name;
  const typeLabel = groupContext ? '선택한 공간·치수 함께 편집' : target.kind === 'zone' ? '선택한 공간' : '선택한 치수';
  return `<section class="mobile-context-menu" role="dialog" aria-modal="true" aria-labelledby="mobile-context-title">
    <div class="mobile-context-heading"><div><span>${typeLabel}</span><strong id="mobile-context-title">${escapeHtml(title)}</strong></div><button data-context-close type="button" aria-label="작업 메뉴 닫기">×</button></div>
    <div class="mobile-context-actions">
      <button data-context-action="move" type="button"><b aria-hidden="true">✥</b><span>이동</span></button>
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
  if (workspaceMode === 'simple' || !isMobileLayout() || mobileContextMenu || (!mobileMoveArmed && !mobileMultiSelect && selectionKeys.size < 2)) return '';
  const selectedSpaceCount = new Set(selectedEntries().filter((entry) => entry.kind === 'zone').map((entry) => spaceIdOf(entry.entity))).size;
  const canMergeSpaces = selectedSpaceCount > 1 && selectedSpacesCanMerge();
  const disabled = selectionKeys.size ? '' : 'disabled';
  return `<section class="mobile-selection-bar ${mobileMoveArmed ? 'is-move-armed' : ''}" aria-label="그룹 편집" ${mobileContextMenu ? 'inert aria-hidden="true"' : ''}>
    <div><strong>${mobileMoveArmed ? '대상을 끌어 이동' : '그룹 선택'}</strong><span data-selection-count>${selectionKeys.size}개 선택</span></div>
    <button data-group-action="move" type="button" ${disabled}>이동</button>
    <button data-group-action="duplicate" type="button" ${disabled}>복제</button>
    <button data-group-action="lock" type="button" ${disabled}>${selectedEntries().length && selectedEntries().every(({ entity }) => entity.locked) ? '해제' : '잠금'}</button>
    ${canMergeSpaces ? '<button data-group-action="merge-spaces" type="button">공간 합치기</button>' : ''}
    <button class="is-danger" data-group-action="delete" type="button" ${disabled}>삭제</button>
    <button data-group-action="done" type="button">해제</button>
  </section>`;
}

function renderSimpleSelection() {
  const directControls = spaceEditor?.selectionMarkup();
  if (directControls) return directControls;
  if (workspaceMode !== 'simple') return '';
  const entity = selectedEntity();
  if (!entity || !state.selection) {
    return `<div class="workspace-hint"><span>${state.zones.length ? '공간을 눌러 형태와 치수를 조절하세요.' : '먼저 공간을 만들어주세요.'}</span><button type="button" ${state.zones.length ? 'data-open-detail' : 'data-simple-action="start"'}>${state.zones.length ? '3D로 계속' : '공간 만들기'}</button></div>`;
  }
  const single = selectionKeys.size === 1;
  const fields = single && !entity.locked ? quickNumericFields(state.selection.kind).filter(([field]) => ['width', 'depth'].includes(field)) : [];
  return `<section class="simple-selection" aria-label="선택한 공간·치수 조작">
    <div class="simple-selection-heading"><strong>${single ? escapeHtml(entity.name) : `${selectionKeys.size}개 선택`}</strong><span>${single ? entity.locked ? '잠김' : '끌어서 이동' : '함께 이동'}</span><button type="button" data-simple-action="clear" aria-label="선택 해제">닫기</button></div>
    <div class="simple-selection-actions">
      ${fields.length ? `<button type="button" data-simple-action="size" aria-expanded="${quickSizesOpen}">크기</button>` : ''}
      ${single && state.selection.kind === 'zone' && !entity.locked ? `<button type="button" data-space-shape aria-label="형태·치수 편집" aria-pressed="${spaceEditor?.editingShape}">형태</button>` : ''}
      <button type="button" data-simple-action="duplicate">복제</button>
      <button type="button" data-simple-action="details">상세</button>
      <button type="button" data-simple-action="multi" aria-pressed="${mobileMultiSelect}">함께 선택</button>
      ${selectedSpacesCanMerge() ? '<button type="button" data-merge-spaces>공간 합치기</button>' : ''}
      <button type="button" data-simple-action="delete" ${entity.locked ? 'disabled' : ''}>삭제</button>
    </div>
    ${quickSizesOpen && fields.length ? `<div class="simple-size-fields">${fields.map(([field]) => `<label>${field === 'width' ? '가로' : '세로'} <span>cm</span><input type="number" inputmode="decimal" data-quick-field="${field}" data-quick-kind="zone" data-quick-id="${entity.id}" value="${Math.round(entity[field])}" aria-label="${escapeHtml(entity.name)} ${field === 'width' ? '가로' : '세로'}"></label>`).join('')}</div>` : ''}
  </section>`;
}

function renderProjectDialog() {
  if (!projectDialogOpen) return '';
  return `<div class="cloud-dialog-backdrop" data-project-backdrop>
    <section class="cloud-dialog project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
      <button class="cloud-dialog-close" data-project-close type="button" aria-label="프로젝트 파일 창 닫기">×</button>
      <span class="eyebrow">PORTABLE PROJECT</span>
      <h2 id="project-dialog-title">도면 파일</h2>
      <p>현재 배치를 사람용 리포트로 공유하거나, 계정 정보 없는 도면 파일로 보관·이동할 수 있습니다.</p>
      <div class="project-file-actions">
        <button class="project-report-action" data-project-report type="button">의사결정 리포트 받기</button>
        <button data-project-export type="button">현재 도면 내보내기</button>
        <label class="project-file-import" data-project-import-trigger role="button" tabindex="0">도면 파일 가져오기
          <input data-project-import type="file" accept=".json,.roomstudio.json,application/json" />
        </label>
      </div>
      <div class="project-danger-zone">
        <strong>${cloudSession && activeProjectId ? '클라우드 도면 관리' : '브라우저 도면 관리'}</strong>
        <p>${cloudSession && activeProjectId ? '현재 클라우드 도면과 저장된 버전을 삭제합니다.' : '현재 브라우저 도면을 삭제하고 빈 초안을 엽니다.'}</p>
        <button class="danger-button" data-project-delete type="button">현재 도면 삭제</button>
      </div>
      <p class="cloud-feedback" data-project-feedback data-tone="${projectFileFeedbackTone}" role="status">${escapeHtml(projectFileFeedback)}</p>
    </section>
  </div>`;
}

function sampleCoverSrcSet(cover) {
  const base = `${import.meta.env.BASE_URL}assets/seoul-examples/${cover}-dollhouse`;
  return [...[160, 320, 640].map(width => `${base}-${width}.webp ${width}w`), `${base}.webp 1128w`].join(', ');
}

function renderStarterDialog() {
  if (!starterDialogOpen) return '';
  return `<div class="cloud-dialog-backdrop" data-start-backdrop>
    <section class="cloud-dialog starter-dialog" role="dialog" aria-modal="true" aria-labelledby="starter-dialog-title">
      <header class="starter-heading">
        <div><span class="eyebrow">내 공간, 내 배치</span>
        <h2 id="starter-dialog-title">내 공간 꾸미기</h2></div>
        <button class="cloud-dialog-close" data-start-close type="button" aria-label="시작 화면 닫기">×</button>
      </header>
      <p>방 크기를 입력하거나 아파트 예시를 선택하세요.</p>
      <form class="starter-room-form" data-start-room-form>
        <div class="starter-room-preview" aria-hidden="true"><span>내 공간</span><small>가구를 자유롭게 놓아보세요</small></div>
        <div class="starter-room-fields">
          <label>가로 <span>cm</span><input name="roomWidth" type="number" inputmode="numeric" min="100" max="1200" step="1" value="400" required></label>
          <label>세로 <span>cm</span><input name="roomDepth" type="number" inputmode="numeric" min="100" max="1200" step="1" value="300" required></label>
          <button class="primary-button" type="submit">이 크기로 시작</button>
        </div>
      </form>
      <section class="starter-examples" aria-label="서울 아파트 3D 예시">
        <h3>서울 아파트 3D 예시</h3>
        <div class="starter-example-grid">${REGIONAL_DEMO_LAYOUTS.map((demo) => `<button type="button" data-start-studio="${demo.id}">
          <img src="${import.meta.env.BASE_URL}assets/seoul-examples/${demo.assetStyle.cover}-dollhouse.webp" srcset="${sampleCoverSrcSet(demo.assetStyle.cover)}" sizes="(max-width: 792px) calc((100vw - 144px) / 3), (max-width: 900px) 216px, 210px" alt="" width="1128" height="866" fetchpriority="high">
          <strong>${escapeHtml(demo.region)}</strong><span>${escapeHtml(demo.assetStyle.name)}</span>
        </button>`).join('')}</div>
        <p>공개 평면 참고 재구성 · 치수와 가구 배치는 추정입니다.</p>
      </section>
      <div class="starter-options">
        <button class="starter-option" data-start-sample type="button">
          <b>아파트 샘플 체험</b>
          <span>${escapeHtml(REGIONAL_DEMO_LAYOUTS[0].name)} 참고 도면. 치수·배치는 추정입니다.</span>
        </button>
        <button class="starter-option" data-start-blank type="button">
          <b>직접 그리기</b>
          <span>빈 도면에 여러 공간을 이어 만듭니다.</span>
        </button>
        <label class="starter-option starter-import" data-start-import role="button" tabindex="0">
          <b>저장한 파일 열기</b>
          <span>.roomstudio.json 작업을 이어갑니다.</span>
          <input data-start-file type="file" accept=".json,.roomstudio.json,application/json">
        </label>
      </div>
      <p class="starter-note">작업은 이 브라우저에 자동 저장됩니다. 다른 기기로 옮길 때는 도면 파일로 보관하세요.</p>
    </section>
  </div>`;
}

function renderDemoGallery() {
  if (!demoGalleryOpen) return '';
  const galleryLayouts = [...REGIONAL_DEMO_LAYOUTS, ...DEMO_LAYOUTS];
  const pendingDemo = pendingDemoId ? galleryLayouts.find(({ id }) => id === pendingDemoId) : null;
  const previewDoorMarkup = (structure) => {
    const hingeEnd = structure.hinge === 'end';
    return `<b data-demo-preview-door="${structure.exterior ? 'exterior' : 'interior'}" data-door-kind="${structure.doorType === 'sliding' ? 'sliding' : 'swing'}" style="--x:${structure.x};--y:${structure.y};--w:${structure.width};--r:${structure.orientation === 'vertical' ? 90 : 0}deg;--s:${structure.openSide};--hx:${hingeEnd ? -1 : 1};--ox:${hingeEnd ? '100%' : '0'}"></b>`;
  };
  return `<div class="cloud-dialog-backdrop demo-gallery-backdrop" data-demo-backdrop>
    <section class="cloud-dialog demo-gallery" data-demo-gallery role="dialog" aria-modal="true" aria-labelledby="demo-gallery-title">
      <header class="demo-gallery-heading">
        <div><span class="eyebrow">서울 아파트 · 사전 제작 에셋</span>
        <h2 id="demo-gallery-title">아파트 예시</h2></div>
        <button class="cloud-dialog-close" data-demo-close type="button" aria-label="모델 홈 갤러리 닫기">×</button>
      </header>
      <p>대치동·압구정동·도곡동의 공개 평면 참고 샘플과 기존 LH 샘플입니다. 열린 거실·주방은 문 없이 연결하며, 치수와 가구 배치는 편집용 추정입니다. 출처 표기 면적은 편집기 구역 면적과 다릅니다.</p>
      <div class="demo-grid">
        ${galleryLayouts.map((demo) => {
    // Include the full swing envelope, not just the floor footprint or door center.
    const bounds = [...demo.zones.map(zoneBounds), ...demo.structures.filter(({ type }) => type === 'door').map((door) => {
      const radius = door.width * 1.5;
      return { left: door.x - radius, right: door.x + radius, top: door.y - radius, bottom: door.y + radius };
    })];
    const left = Math.min(...bounds.map((bound) => bound.left));
    const top = Math.min(...bounds.map((bound) => bound.top));
    const width = Math.max(...bounds.map((bound) => bound.right)) - left;
    const height = Math.max(...bounds.map((bound) => bound.bottom)) - top;
    const sourceUrl = demo.source.referenceUrl || demo.source.datasetUrl;
    return `<article class="demo-card${demo.assetStyle ? ' has-asset-cover' : ''}" data-demo-card="${demo.id}">
          ${demo.assetStyle ? `<img class="demo-card-cover" data-sample-cover src="${import.meta.env.BASE_URL}assets/seoul-examples/${demo.assetStyle.cover}-dollhouse.webp" srcset="${sampleCoverSrcSet(demo.assetStyle.cover)}" sizes="(max-width: 338px) calc(100vw - 104px), 235px" alt="${escapeHtml(demo.region)} ${escapeHtml(demo.assetStyle.name)} 3D 예시" width="1128" height="866" loading="lazy" decoding="async">` : ''}
          <div class="demo-card-plan" style="--bounds-x:${left};--bounds-y:${top};--bounds-w:${width};--bounds-h:${height}" aria-hidden="true">
            ${demo.zones.map((zone) => `<i style="--x:${zone.x};--y:${zone.y};--w:${zone.width};--d:${zone.depth};--c:${zone.color}"></i>`).join('')}
            ${demo.structures.filter(({ type }) => type === 'door').map(previewDoorMarkup).join('')}
          </div>
          <span class="demo-area" data-demo-area>${demo.region ? `${escapeHtml(demo.region)} · ` : ''}${escapeHtml(demo.source.planType)}</span>
          ${demo.source.areaLabel ? `<p data-demo-area-label>출처 표기 면적: ${escapeHtml(demo.source.areaLabel)}</p>` : ''}
          <h3>${escapeHtml(demo.name).replace(/(\d+(?:\.\d+)?㎡)/g, '<span class="demo-measurement">$1</span>')}</h3>
          ${demo.assetStyle ? `<div class="demo-asset-style"><strong>${escapeHtml(demo.assetStyle.name)}</strong><p>${escapeHtml(demo.assetStyle.description)}</p><button class="demo-studio-button" data-demo-studio="${demo.id}" type="button">3D로 꾸며보기</button></div>` : ''}
          <dl><div><dt>출처</dt><dd data-demo-source><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(demo.source.attribution)}</a>${demo.source.archiveEntry ? ` · ${escapeHtml(demo.source.archiveEntry)}` : ''}</dd></div></dl>
          ${demo.assetStyle ? '<p class="sample-scope">참고 평면 재구성 · 치수와 가구 배치는 추정입니다.</p><details class="demo-source-details"><summary>공간 구성·추정 범위 보기</summary>' : ''}
          <p data-demo-rooms>${demo.zones.map(({ name }, index) => `<span>${index ? '· ' : ''}${escapeHtml(name)}</span>`).join(' ')}</p>
          <p class="demo-geometry-basis" data-demo-geometry>${escapeHtml(demo.source.geometryBasis)}</p>
          <small data-demo-adaptation>${escapeHtml(demo.source.adaptationNotice)}</small>
          <small data-demo-license>${escapeHtml(demo.source.license)}</small>
          ${demo.assetStyle ? '</details>' : ''}
          <button data-demo-layout="${demo.id}" type="button">이 모델 홈 열기</button>
        </article>`;
  }).join('')}
      </div>
      <p class="demo-license">LH 샘플 3종에만 적용 · 공공데이터포털 <a href="${DEMO_LAYOUTS[0].source.datasetUrl}" target="_blank" rel="noreferrer">한국토지주택공사 주택 평면도 현황</a> · ${escapeHtml(DEMO_LAYOUTS[0].source.license)}</p>
      ${pendingDemo ? `<div class="demo-confirm" data-demo-confirm role="alertdialog" aria-modal="true" aria-labelledby="demo-confirm-title">
        <strong id="demo-confirm-title">현재 도면을 바꿀까요?</strong>
        <p>저장된 브라우저 도면 대신 <b>${escapeHtml(pendingDemo.name)}</b>을 엽니다. 필요한 경우 먼저 도면 파일을 내보내세요.</p>
        <div><button data-demo-confirm-cancel type="button">돌아가기</button><button class="is-danger" data-demo-confirm-accept type="button">현재 도면 바꾸기</button></div>
      </div>` : ''}
    </section>
  </div>`;
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
        <p>Google 계정이나 이메일 링크로 로그인할 수 있습니다. 현재 로컬 상담은 유지되며, 지금 저장을 누르면 계정에 보관됩니다.</p>
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
          ${cloudProjects.length && !cloudProjects.some((project) => project.id === activeProjectId) ? '<option value="" selected>불러올 도면 선택</option>' : ''}
          ${cloudProjects.length ? cloudProjects.map((project) => `<option value="${project.id}" ${project.id === activeProjectId ? 'selected' : ''}>${escapeHtml(project.name)}</option>`).join('') : '<option value="">저장된 도면 없음</option>'}
        </select>
      </label>
      <label>현재 도면 이름<input data-cloud-project-name maxlength="80" value="${escapeHtml(activeProjectName)}" ${dialogBusy ? 'disabled' : ''} /></label>
      <div class="cloud-project-actions">
        <button data-cloud-save type="button" ${dialogBusy ? 'disabled' : ''}>지금 저장</button>
        <button data-cloud-copy type="button" ${dialogBusy ? 'disabled' : ''}>현재 도면 복사 저장</button>
      </div>
      <div class="cloud-project-actions" data-cloud-recovery ${cloudConflict ? '' : 'hidden'}>
        <button data-cloud-reload type="button" ${dialogBusy ? 'disabled' : ''}>복구본 남기고 서버 도면 열기</button>
        <button data-cloud-recovery-export type="button">현재 상담 파일 받기</button>
      </div>
      <p class="cloud-feedback" data-cloud-feedback data-tone="${cloudFeedbackTone}" role="status">${escapeHtml(cloudFeedback)}</p>
      <button class="cloud-signout" data-cloud-signout type="button">로그아웃</button>
      <div class="cloud-danger-zone">
        <strong>계정 데이터 삭제</strong>
        <p>프로필, 모든 클라우드 도면과 저장 버전을 영구 삭제합니다. 이 작업은 되돌릴 수 없습니다.</p>
        <button class="danger-button" data-cloud-delete-account type="button" ${dialogBusy ? 'disabled' : ''}>계정과 모든 도면 삭제</button>
      </div>
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
  if (deferInputRender) {
    inputRenderPending = true;
    return;
  }
  inputRenderPending = false;
  const entries = selectedEntries();
  selectionKeys = new Set(entries.map(({ kind, id }) => selectionKey(kind, id)));
  const primary = entries.find(({ kind, id }) => kind === state.selection?.kind && id === state.selection.id) ?? entries.at(-1);
  state.selection = primary ? { kind: primary.kind, id: primary.id } : null;
  const focusedMobileLayout = isMobileLayout();
  const simpleWorkspace = workspaceMode === 'simple';
  const retainedDisclosures = new Map([...(document.querySelector('.workspace')?.dataset.mode === workspaceMode
    ? document.querySelectorAll('[data-disclosure]') : [])]
    .map((node) => [node.dataset.disclosure, node.open]));
  const panelScroll = !focusedMobileLayout && renderedDocumentGeneration === documentGeneration
    ? ['.left-panel', '.right-panel', '.canvas-column'].map((selector) => {
      const panel = document.querySelector(selector);
      return { selector, top: panel?.scrollTop ?? 0, left: panel?.scrollLeft ?? 0 };
    })
    : [];
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
  const cloudBackgroundAttributes = cloudDialogOpen || projectDialogOpen || starterDialogOpen || demoGalleryOpen || mobileContextMenu || consultationDialogOpen || comparisonDialogOpen || cloudLoadBusy ? 'inert aria-hidden="true"' : '';
  const cloudState = cloudFeedbackTone === 'error' ? 'error' : !cloudConfigured ? 'setup' : cloudSession ? 'synced' : 'idle';

  const accountName = cloudSession?.user?.user_metadata?.full_name || cloudSession?.user?.email?.split('@')[0];
  app.innerHTML = `<header class="topbar ${simpleWorkspace ? 'simple-topbar' : ''}" ${cloudBackgroundAttributes}>
    <a class="brand" href="#" aria-label="Room Studio"><span class="brand-mark"><i></i><i></i><i></i></span><span><strong>ROOM</strong> STUDIO</span></a>
    <div class="topbar-cloud">
      <button class="project-account-button" data-start-open type="button" aria-haspopup="dialog"><b aria-hidden="true">✦</b><span>시작</span></button>
      <button class="project-account-button demo-open-button" data-demo-open type="button" aria-haspopup="dialog"><b aria-hidden="true">⌂</b><span>${simpleWorkspace ? '샘플' : '모델 홈'}</span></button>
      <button class="project-account-button" data-project-open type="button" aria-haspopup="dialog"><b aria-hidden="true">↥</b><span>${simpleWorkspace ? '파일' : '도면 파일'}</span></button>
      <div class="save-state" data-state="${cloudState}"><span></span><span data-cloud-status>${escapeHtml(cloudFeedback)}</span></div>
      ${cloudConfigured || !simpleWorkspace ? `<button class="cloud-account-button" data-cloud-open type="button" aria-haspopup="dialog"><b aria-hidden="true">${cloudSession ? '●' : '○'}</b><span>${escapeHtml(accountName || (cloudConfigured ? '로그인' : '클라우드 설정'))}</span></button>` : ''}
      <button class="workspace-mode-button" data-workspace-mode type="button" aria-pressed="${!simpleWorkspace}" aria-label="${simpleWorkspace ? '정밀 도구 열기' : '공간 편집으로 돌아가기'}">${simpleWorkspace ? '정밀 도구' : '<span class="desktop-only">공간 편집</span><span class="mobile-only">간편</span>'}</button>
    </div>
  </header>
  <main class="workspace mobile-${mobilePanel} workspace-panel-${workspacePanel}" data-mode="${workspaceMode}" ${cloudBackgroundAttributes}>
    <aside class="panel left-panel" aria-label="공간 정의 패널">
      <section class="space-section" id="mobile-panel-spaces" ${mobilePanelAttributes('spaces')}>
        <div class="section-title"><span>01</span><h2>공간 만들기</h2><button class="add-mini" id="add-zone" type="button">＋ 공간</button></div>
        <p class="space-edit-guide">방·거실·욕실의 크기와 위치를 정하세요. 가구와 문은 3D에서 편집합니다.</p>
        <button class="space-detail-button" data-open-detail type="button">2. 3D 가구·문 편집</button>
        <details class="workspace-disclosure" data-disclosure="tracing"><summary>도면 따라 그리기 · 축척</summary>${renderBlueprintControls()}</details>
        <div class="preset-row"><button data-layout="apartment" type="button">기본 아파트</button><button data-layout="lshape" type="button">ㄱ자 주택</button></div>
        <p class="section-help">하나의 공간에 여러 조각을 붙여 거실·복도 같은 직교형 공간을 만드세요.</p>
        <div class="zone-list">${spaces.map((parts) => {
          const representative = parts.reduce((largest, part) => part.width * part.depth > largest.width * largest.depth ? part : largest, parts[0]);
          const area = calculateUnionArea(parts) / 10000;
          return `<button class="${selectedSpaceIds.has(spaceIdOf(representative)) ? 'active' : ''}" data-select-zone="${representative.id}" type="button"><i style="--zone:${representative.color}"></i><span><strong>${escapeHtml(representative.name)}</strong><small>${escapeHtml(representative.type)} · ${area.toFixed(1)}m² · H ${representative.height ?? 240}cm${parts.length > 1 ? ` · ${parts.length}조각` : ''}</small></span></button>`;
        }).join('')}</div>
      </section>
    </aside>

    <section class="canvas-column" id="mobile-panel-canvas" ${mobilePanelAttributes('canvas')}>
      <div class="canvas-toolbar"><div><span class="eyebrow">배치 상담</span><h1 title="${escapeHtml(activeProjectName)}">${escapeHtml(activeProjectName)}</h1><p class="planning-scope" data-planning-scope><strong>기획·배치 확인용</strong><span class="desktop-only">건축 인허가·구조·접근성·시공 판단은 관련 전문가의 검토가 필요합니다.</span><span class="mobile-only">시공 판단은 전문가 검토</span></p></div>
        <div class="view-tabs"><button class="active" type="button">2D 공간 편집</button><button id="open-walkthrough" type="button">3D 상세 편집</button></div>
      </div>
      ${spaceEditor?.toolbarMarkup() ?? ''}
      ${simpleWorkspace ? '<details class="consultation-tools workspace-disclosure" data-disclosure="consultation"><summary>배치 비교 · 상담 · 제안서</summary>' : ''}
      ${renderConsultationToolbar({ projectName: activeProjectName, consultation: state.consultation })}
      ${simpleWorkspace ? '</details>' : ''}
      <div class="draft-status" data-draft-status hidden>
        <p data-draft-message></p>
        <div><button data-draft-retry type="button">다시 저장</button><button data-draft-export type="button">도면 파일로 보관</button><button data-recovery-restore type="button">이전 상담 복구</button></div>
      </div>
      <div class="canvas-actions">
        <span>방향키 1cm · Shift+방향키 40cm · ⌘/Ctrl+C·V · Shift 클릭 다중 선택</span>
        <div>
          <span class="zoom-controls"><button id="zoom-out" type="button" title="축소" aria-label="도면 축소">−</button><b id="zoom-level">${Math.round(canvasZoom * 100)}%</b><button id="zoom-in" type="button" title="확대" aria-label="도면 확대">＋</button><button id="zoom-fit" type="button">전체 보기</button></span>
          <button class="mobile-only ${mobileMultiSelect ? 'is-active' : ''}" id="multi-select-action" type="button" aria-pressed="${mobileMultiSelect}">그룹 선택${selectionKeys.size ? ` ${selectionKeys.size}` : ''}</button>
          <button id="undo-action" type="button" aria-label="실행 취소" title="실행 취소" ${historyPast.length ? '' : 'disabled'}>↶<span class="desktop-only"> 실행 취소</span></button>
          <button id="redo-action" type="button" aria-label="다시 실행" title="다시 실행" ${historyFuture.length ? '' : 'disabled'}>↷<span class="desktop-only"> 다시 실행</span></button>
          <button id="add-dimension" class="${precisionTool?.type === 'dimension' ? 'is-active' : ''}" type="button">↔ 거리 측정</button>
          <details class="canvas-more-actions" ${!simpleWorkspace && !isMobileLayout() ? 'open' : ''}><summary>더보기</summary><div role="group" aria-label="추가 도면 도구">
            <button id="duplicate-selection" type="button" ${selectionKeys.size ? '' : 'disabled'}>⧉ 복제</button>
            <button id="copy-selection" type="button" ${selectionKeys.size ? '' : 'disabled'}>복사</button>
            <button id="paste-selection" type="button" ${internalClipboard ? '' : 'disabled'}>붙여넣기</button>
          </div></details>
        </div>
      </div>
      <div class="canvas-wrap">${render2d(collisions, outOfBounds, heightViolations, zoneOverlaps)}${renderTransformHud()}${editorNotice || precisionTool ? `<div class="editor-notice ${precisionTool ? 'is-tool-active' : ''}" role="status"><span>${escapeHtml(editorNotice)}</span>${precisionTool ? '<button id="cancel-precision-tool" type="button">취소</button>' : ''}</div>` : ''}</div>
      ${renderSimpleSelection()}
      <div class="stats-bar"><div><span>공간 면적</span><strong>${area.toFixed(1)}<small>m²</small></strong></div><div><span>공간 구성</span><strong>${spaces.length}<small>개 · ${state.zones.length}조각</small></strong></div><div><span title="바닥에 놓인 가구의 외곽 사각형 기준이며 통행 여유를 뜻하지 않습니다.">바닥 점유 추정</span><strong>${calculateCoverage(state.items, state.zones)}<small>%</small></strong></div><div><span>최고 높이</span><strong>${maxHeight}<small>cm</small></strong></div><div class="${warningCount ? 'warning' : ''}"><span>배치 확인</span><strong>${warningCount ? `${warningCount}개 확인` : '검사 경고 없음'}</strong></div></div>
      <div class="legend"><span><i class="collision-dot"></i>가구 3D 충돌</span><span><i class="height-dot"></i>공간 높이 초과</span><span><i class="outside-dot"></i>집 밖 배치</span><span><i class="zone-dot"></i>공간 중복</span></div>
      <details class="placement-checks"><summary>${warningCount ? `확인할 대상 ${warningCount}개` : '검사 범위 확인'}</summary>
        <p>가구 외곽 사각형의 겹침·공간 경계·높이와 공간 중복을 검사합니다. 벽·문 간섭과 통행 여유는 도면·3D에서 별도로 확인하세요.</p>
        <ul>${state.items.map((item) => {
          const reasons = [collisions.has(item.id) && '가구 겹침', outOfBounds.has(item.id) && '공간 밖 배치', heightViolations.has(item.id) && '높이 초과'].filter(Boolean);
          return reasons.length ? `<li><button type="button" data-open-detail>${escapeHtml(item.name)} · ${reasons.join(' · ')}</button></li>` : '';
        }).join('')}${state.zones.filter((zone) => zoneOverlaps.has(zone.id)).map((zone) => `<li><button type="button" data-select-warning="zone:${zone.id}">${escapeHtml(zone.name)} · 공간 중복</button></li>`).join('')}</ul>
      </details>
    </section>

    <aside class="panel right-panel" id="mobile-panel-inspector" ${mobilePanelAttributes('inspector')}>${simpleWorkspace ? '<button class="workspace-panel-back" type="button" data-workspace-panel="spaces">공간 목록으로 돌아가기</button>' : ''}<div class="section-title"><span>05</span><h2>공간 상세</h2></div>${renderInspector(selected)}
      <div class="tips"><h3>공간 다음은 3D 상세</h3><p>2D의 가구·문·창·벽은 위치 확인용입니다. 3D에서 배치·크기·재질을 바꾸면 같은 도면에 저장됩니다.</p><button class="space-detail-button" data-open-detail type="button">3D 상세 편집</button></div>
    </aside>
  </main>
  ${renderMobileSelectionBar()}
  ${renderMobileContextMenu()}
  ${renderStarterDialog()}
  ${renderDemoGallery()}
  ${renderProjectDialog()}
  ${renderCloudDialog()}
  ${consultationDialogOpen ? renderConsultationDialog({ projectName: activeProjectName, consultation: state.consultation }) : ''}
  ${comparisonDialogOpen ? renderComparisonDialog({ projectName: activeProjectName, layout: layoutSnapshot() }) : ''}
  <div id="mobile-status" role="status" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;">${mobileStatus}</div>
  <nav class="mobile-nav" aria-label="모바일 편집 메뉴" aria-describedby="mobile-status" ${cloudBackgroundAttributes}>
    <div class="mobile-space-tabs" role="tablist" aria-label="2D 공간 편집">${mobileTabs.map(([panel, icon, label]) => {
      const active = mobilePanel === panel;
      return `<button id="mobile-tab-${panel}" class="${active ? 'is-active' : ''}" data-mobile-panel="${panel}" type="button" role="tab" aria-controls="mobile-panel-${panel}" aria-selected="${active}" tabindex="${active ? '0' : '-1'}"><b aria-hidden="true">${icon}</b><span>${label}</span></button>`;
    }).join('')}</div>
    <button data-open-detail type="button" aria-label="3D 가구·문 상세 편집"><b aria-hidden="true">3D</b><span>상세 편집</span></button>
  </nav>
  <footer ${cloudBackgroundAttributes}>기획·배치 확인을 돕는 시각화 도구입니다. 실제 인허가·구조·접근성·시공은 전문가와 확인하세요. <strong>Room Studio</strong></footer>`;
  for (const { selector, top, left } of panelScroll) {
    const panel = document.querySelector(selector);
    panel.scrollTop = top;
    panel.scrollLeft = left;
  }
  for (const node of document.querySelectorAll('[data-disclosure]')) {
    if (retainedDisclosures.has(node.dataset.disclosure)) node.open = retainedDisclosures.get(node.dataset.disclosure);
  }
  renderedDocumentGeneration = documentGeneration;
  bindEvents();
  updateDraftStatus();
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
  if (focusRequest.kind === 'quick-field') {
    const input = document.querySelector(`[data-quick-field="${focusRequest.field}"]`);
    input?.focus();
    input?.select();
    return;
  }
  const selector = {
    'panel-heading': '#inspector-heading',
    'context-menu': '[data-context-action="move"]',
    canvas: '#plan-canvas',
    'starter-sample': '[name="roomWidth"]',
    'starter-room': '[name="roomWidth"]',
    'group-move': '[data-group-action="move"]',
  }[focusRequest.kind] ?? `#mobile-tab-${focusRequest.panel}`;
  document.querySelector(selector)?.focus({ preventScroll: focusRequest.kind === 'canvas' && !isMobileLayout() });
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
  document.querySelector('[data-workspace-mode]')?.addEventListener('click', () => {
    if (numericEdit) commitQuickNumericEdit();
    workspaceMode = workspaceMode === 'simple' ? 'advanced' : 'simple';
    mobileContextMenu = null;
    quickSizesOpen = false;
    render();
    document.querySelector('[data-workspace-mode]')?.focus();
  });
  document.querySelectorAll('[data-workspace-panel]').forEach((button) => button.addEventListener('click', () => {
    workspacePanel = button.dataset.workspacePanel;
    if (isMobileLayout()) {
      mobilePanel = workspacePanel;
      pendingFocus = { kind: 'mobile-tab', panel: workspacePanel };
    }
    render();
    if (!isMobileLayout()) document.querySelector(`[data-workspace-panel="${workspacePanel}"]`)?.focus();
  }));
  document.querySelectorAll('[data-simple-action]').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.simpleAction;
    pendingFocus = { kind: 'canvas' };
    if (action === 'duplicate') return duplicateSelection();
    if (action === 'delete') return deleteSelection();
    if (action === 'clear') return clearSelection();
    if (action === 'size') {
      quickSizesOpen = !quickSizesOpen;
      pendingFocus = quickSizesOpen ? { kind: 'quick-field', field: 'width' } : { kind: 'canvas' };
    } else if (action === 'details') {
      workspacePanel = 'inspector';
      if (isMobileLayout()) mobilePanel = 'inspector';
      pendingFocus = { kind: 'panel-heading' };
    } else if (action === 'multi') {
      mobileMultiSelect = !mobileMultiSelect;
    } else if (action === 'start') {
      starterDialogOpen = true;
      pendingFocus = { kind: 'starter-room' };
    }
    render();
  }));
  document.querySelector('[data-start-room-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity() || !canReplaceCurrentDraft()) return;
    const fields = new FormData(event.currentTarget);
    const zone = makeZone({
      name: '내 공간', type: '방', x: 0, y: 0,
      width: Number(fields.get('roomWidth')), depth: Number(fields.get('roomDepth')),
      color: spaceColors[0],
    });
    applyProjectDocument({ projectName: '내 공간', layout: { ...blankLayout(), zones: [zone] } });
    starterDialogOpen = false;
    workspaceMode = 'simple';
    workspacePanel = 'spaces';
    mobilePanel = 'canvas';
    editorNotice = '';
    pendingFocus = { kind: 'canvas' };
    render();
  });
  document.querySelector('[data-consultation-open]')?.addEventListener('click', () => {
    consultationDialogOpen = true;
    mobileContextMenu = null;
    render();
    document.querySelector('[name="projectName"]')?.focus();
  });
  document.querySelectorAll('[data-consultation-close]').forEach((button) => button.addEventListener('click', closeConsultationDialog));
  document.querySelector('[data-consultation-backdrop]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeConsultationDialog();
  });
  document.querySelector('[data-consultation-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const consultation = normalizeConsultation(state.consultation);
    const previous = layoutSnapshot();
    const active = consultation.activeOption;
    const next = {
      ...consultation,
      businessName: fields.get('businessName').trim(),
      clientName: fields.get('clientName').trim(),
      requirements: fields.get('requirements').trim(),
      recommendedOption: fields.get('recommendedOption') || null,
      options: {
        ...consultation.options,
        [active]: {
          label: fields.get('optionLabel').trim() || `${active}안`,
          recommendation: fields.get('recommendation').trim(),
          nextSteps: fields.get('nextSteps').trim(),
        },
      },
    };
    try {
      preparePersistedLayout({ ...previous, consultation: next });
      state.consultation = next;
      activeProjectName = normalizeProjectName(fields.get('projectName'));
      commitHistory(previous);
      saveState();
      closeConsultationDialog();
    } catch (error) {
      event.currentTarget.querySelector('[type="submit"]').insertAdjacentElement('beforebegin', Object.assign(document.createElement('p'), {
        textContent: error.message,
        role: 'alert',
      }));
    }
  });
  document.querySelector('[data-option-create]')?.addEventListener('click', () => {
    try {
      const previous = layoutSnapshot();
      state = { ...state, ...createComparisonOption(previous) };
      commitHistory(previous);
      saveState();
      editorNotice = '현재 배치를 B안으로 복사했습니다. B안을 선택해 다른 배치를 만들 수 있습니다.';
    } catch (error) {
      editorNotice = error.message;
    }
    render();
  });
  document.querySelectorAll('[data-option-select]').forEach((button) => button.addEventListener('click', () => selectConsultationOption(button.dataset.optionSelect)));
  document.querySelector('[data-options-compare]')?.addEventListener('click', () => {
    try {
      preparePersistedLayout(state);
      comparisonDialogOpen = true;
      render();
      document.querySelector('[data-comparison-close]')?.focus();
    } catch (error) {
      comparisonDialogOpen = false;
      editorNotice = error.message;
      render();
    }
  });
  document.querySelector('[data-comparison-close]')?.addEventListener('click', closeComparisonDialog);
  document.querySelector('[data-comparison-backdrop]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeComparisonDialog();
  });
  document.querySelectorAll('[data-comparison-edit]').forEach((button) => button.addEventListener('click', () => selectConsultationOption(button.dataset.comparisonEdit)));
  document.querySelector('[data-consultation-report]')?.addEventListener('click', exportDecisionReport);
  document.querySelector('[data-draft-retry]')?.addEventListener('click', () => {
    if (unreadDraftRaw && !window.confirm('저장된 원본을 현재 작업으로 바꿀까요? 원본이 필요하면 먼저 원본 받기를 선택하세요.')) return;
    persistCurrentDraft({ replaceUnread: true });
  });
  document.querySelector('[data-draft-export]')?.addEventListener('click', () => {
    if (!unreadDraftRaw) {
      exportPortableProject();
      return;
    }
    const url = URL.createObjectURL(new Blob([unreadDraftRaw], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'room-studio-recovery-original.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  document.querySelector('[data-recovery-restore]')?.addEventListener('click', () => {
    const recovered = availableRecovery();
    if (!recovered || !protectCurrentDraft()) return;
    applyProjectDocument({ ...recovered, ownerId: currentCloudUserId(), dirty: true });
    editorNotice = '교체 전 상담을 복구했습니다. 방금 편집하던 상담도 복구본으로 남겼습니다.';
    render();
    document.querySelector('#plan-canvas')?.focus();
  });
  document.querySelectorAll('[data-select-warning]').forEach((button) => button.addEventListener('click', () => {
    const [kind, id] = button.dataset.selectWarning.split(':');
    selectEntity(kind, id);
    if (isMobileLayout()) mobilePanel = 'inspector';
    pendingFocus = { kind: 'panel-heading', panel: 'inspector' };
    render();
  }));
  document.querySelector('[data-demo-open]')?.addEventListener('click', openDemoGallery);
  document.querySelector('[data-demo-close]')?.addEventListener('click', closeDemoGallery);
  document.querySelector('[data-demo-backdrop]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeDemoGallery();
  });
  document.querySelectorAll('[data-demo-layout]').forEach((button) => button.addEventListener('click', () => {
    requestDemoLayout(button.dataset.demoLayout);
  }));
  document.querySelectorAll('[data-demo-studio]').forEach((button) => button.addEventListener('click', () => {
    requestDemoLayout(button.dataset.demoStudio, true);
  }));
  document.querySelector('[data-demo-confirm-cancel]')?.addEventListener('click', () => {
    const id = pendingDemoId;
    const selector = pendingDemo3d ? 'data-demo-studio' : 'data-demo-layout';
    pendingDemoId = null;
    pendingDemo3d = false;
    render();
    document.querySelector(`[${selector}="${id}"]`)?.focus();
  });
  document.querySelector('[data-demo-confirm-accept]')?.addEventListener('click', () => {
    if (pendingDemoId) applyDemoLayout(pendingDemoId);
  });
  document.querySelector('[data-start-open]')?.addEventListener('click', () => {
    starterDialogOpen = true;
    pendingFocus = { kind: 'starter-sample' };
    render();
  });
  document.querySelector('[data-start-close]')?.addEventListener('click', () => {
    starterDialogOpen = false;
    render();
    document.querySelector('[data-start-open]')?.focus();
  });
  document.querySelector('[data-start-backdrop]')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget) return;
    starterDialogOpen = false;
    render();
    document.querySelector('[data-start-open]')?.focus();
  });
  document.querySelector('[data-start-sample]')?.addEventListener('click', () => {
    applyDemoLayout(REGIONAL_DEMO_LAYOUTS[0].id, false);
  });
  document.querySelectorAll('[data-start-studio]').forEach((button) => button.addEventListener('click', () => {
    starterDialogOpen = false;
    demoGalleryOpen = true;
    requestDemoLayout(button.dataset.startStudio, true);
  }));
  document.querySelector('[data-start-blank]')?.addEventListener('click', () => {
    if (!canReplaceCurrentDraft()) return;
    replaceWithBlankDraft();
    starterDialogOpen = false;
    editorNotice = '빈 도면을 열었습니다. 공간 추가부터 시작하세요.';
    pendingFocus = { kind: 'canvas' };
    render();
  });
  document.querySelector('[data-start-file]')?.addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    try {
      await importPortableProject(file);
    } catch (error) {
      setProjectFileFeedback(error.message || '도면 파일을 가져오지 못했습니다.', 'error');
    }
  });
  document.querySelector('[data-start-import]')?.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    document.querySelector('[data-start-file]')?.click();
  });
  document.querySelector('[data-project-open]')?.addEventListener('click', () => {
    projectDialogOpen = true;
    projectFileFeedback = '';
    projectFileFeedbackTone = '';
    render();
    document.querySelector('.project-dialog button, .project-dialog input')?.focus();
  });
  document.querySelector('[data-project-close]')?.addEventListener('click', () => {
    projectDialogOpen = false;
    render();
    document.querySelector('[data-project-open]')?.focus();
  });
  document.querySelector('[data-project-backdrop]')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget) return;
    projectDialogOpen = false;
    render();
    document.querySelector('[data-project-open]')?.focus();
  });
  document.querySelector('[data-project-report]')?.addEventListener('click', exportDecisionReport);
  document.querySelector('[data-project-export]')?.addEventListener('click', exportPortableProject);
  document.querySelector('[data-project-import]')?.addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    event.target.disabled = true;
    setProjectFileFeedback('도면 파일을 확인하는 중…');
    try {
      await importPortableProject(file);
    } catch (error) {
      event.target.disabled = false;
      setProjectFileFeedback(error.message || '도면 파일을 가져오지 못했습니다.', 'error');
    }
  });
  document.querySelector('[data-project-import-trigger]')?.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    document.querySelector('[data-project-import]')?.click();
  });
  document.querySelector('[data-project-delete]')?.addEventListener('click', deleteCurrentProject);
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
  document.querySelector('[data-cloud-delete-account]')?.addEventListener('click', deleteCurrentAccount);
  document.querySelector('[data-cloud-reload]')?.addEventListener('click', () => {
    openCloudProject(activeProjectId, { skipFlush: true, preserveLocal: true });
  });
  document.querySelector('[data-cloud-recovery-export]')?.addEventListener('click', exportPortableProject);
  document.querySelector('[data-cloud-project]')?.addEventListener('change', (event) => {
    if (event.target.value) openCloudProject(event.target.value);
  });
  document.querySelector('[data-cloud-project-name]')?.addEventListener('change', (event) => {
    activeProjectName = normalizeProjectName(event.target.value);
    event.target.value = activeProjectName;
    saveState();
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
  document.querySelector('[data-context-action="duplicate"]')?.addEventListener('click', () => {
    mobileContextMenu = null;
    duplicateSelection();
  });
  document.querySelector('[data-context-action="lock"]')?.addEventListener('click', () => {
    mobileContextMenu = null;
    toggleSelectionLocked();
  });
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
  document.querySelectorAll('[data-layout]').forEach((button) => button.addEventListener('click', () => {
    const previous = layoutSnapshot();
    const zones = button.dataset.layout === 'lshape' ? lShapeZones() : apartmentZones();
    state = { ...state, zones, selection: null };
    canvasZoom = 1;
    canvasCenter = null;
    canvasBase = null;
    selectionKeys = new Set(state.selection ? [selectionKey(state.selection.kind, state.selection.id)] : []);
    commitHistory(previous);
    saveState();
    render();
  }));
  document.querySelectorAll('[data-select-zone]').forEach((button) => button.addEventListener('click', (event) => {
    selectEntity('zone', button.dataset.selectZone, usesAdditiveSelection(event));
    if (isMobileLayout() && !mobileMultiSelect) {
      mobilePanel = 'inspector';
      pendingFocus = { kind: 'panel-heading', panel: 'inspector' };
    }
    render();
  }));
  document.querySelector('#open-walkthrough').addEventListener('click', open3dEditor);
  document.querySelectorAll('[data-open-detail]').forEach((button) => button.addEventListener('click', open3dEditor));

  document.querySelectorAll('#plan-canvas [data-zone-id]').forEach((node) => node.addEventListener('pointerdown', (event) => startEntityPress(event, 'zone', node.dataset.zoneId)));
  document.querySelectorAll('#plan-canvas [data-dimension-id]').forEach((node) => node.addEventListener('pointerdown', (event) => {
    if (precisionTool) return;
    event.preventDefault();
    event.stopPropagation();
    selectEntity('dimension', node.dataset.dimensionId, usesAdditiveSelection(event));
    if (isMobileLayout() && workspaceMode !== 'simple' && !mobileMultiSelect) {
      mobileContextMenu = { kind: 'dimension', id: node.dataset.dimensionId };
      pendingFocus = { kind: 'context-menu' };
    } else {
      pendingFocus = { kind: 'canvas' };
    }
    render();
  }));
  document.querySelector('[data-background-plan]')?.addEventListener('pointerdown', startBackgroundDrag);
  document.querySelector('.grid-background').addEventListener('pointerdown', startMarquee);
  const planCanvas = document.querySelector('#plan-canvas');
  // Prevent native flings from consuming the next toolbar tap.
  planCanvas.addEventListener('touchstart', (event) => {
    if (event.cancelable) event.preventDefault();
  }, { passive: false });
  planCanvas.addEventListener('pointerdown', handlePrecisionPoint, true);
  planCanvas.addEventListener('wheel', zoomCanvasWithWheel, { passive: false });
  planCanvas.addEventListener('contextmenu', (event) => {
    if (isMobileLayout()) event.preventDefault();
  });
  document.querySelectorAll('[data-resize-handle]').forEach((node) => node.addEventListener('pointerdown', (event) => {
    startResize(event, node.dataset.resizeKind, node.dataset.resizeId, node.dataset.resizeHandle);
  }));
  document.querySelectorAll('[data-zone-field]').forEach((input) => {
    const field = input.dataset.zoneField;
    const entityId = state.selection.id;
    let historySnapshot = layoutSnapshot();
    if (input.tagName !== 'SELECT') {
      let edited = false;
      input.addEventListener('focus', () => {
        historySnapshot = layoutSnapshot();
        edited = false;
      });
      input.addEventListener('input', () => {
        edited = true;
        if (['x', 'y', 'width', 'depth'].includes(field)) return;
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
      input.addEventListener('blur', (event) => {
        if (!edited) return;
        edited = false;
        commitInputBlur(event, () => updateZone(entityId, {
          [field]: input.type === 'number' ? Number(input.value) : input.value,
        }, { historySnapshot }));
      });
      return;
    }
    input.addEventListener('change', () => {
      updateZone(entityId, { [field]: input.value });
    });
  });
  document.querySelectorAll('[data-dimension-field]').forEach((input) => {
    const field = input.dataset.dimensionField;
    const entityId = state.selection.id;
    const historySnapshot = layoutSnapshot();
    input.addEventListener('blur', (event) => commitInputBlur(event, () => updateDimension(entityId, {
      [field]: input.type === 'number' ? Number(input.value) : input.value,
    }, { historySnapshot })));
  });
  document.querySelectorAll('[data-quick-field]').forEach((input) => {
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    input.addEventListener('input', () => previewQuickNumericField(input));
    input.addEventListener('keydown', (event) => {
      if (!['Enter', 'Escape'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') cancelQuickNumericEdit(input.dataset.quickField);
      else commitQuickNumericEdit(input.dataset.quickField);
    });
    input.addEventListener('blur', (event) => {
      if (!numericEdit) return;
      if (event.relatedTarget?.matches?.('[data-quick-field]')) return;
      commitInputBlur(event, () => commitQuickNumericEdit());
    });
  });
  document.querySelectorAll('[data-delete-selection]').forEach((button) => button.addEventListener('click', deleteSelection));
  spaceEditor?.bind();
  focusPendingTarget();
}

// Commit a blur before its next action, but keep that action's DOM target alive.
document.addEventListener('pointerdown', () => { pointerFocusTransfer = true; }, true);
document.addEventListener('keydown', () => { pointerFocusTransfer = false; }, true);
document.addEventListener('click', () => {
  pointerFocusTransfer = false;
  finishInputRender();
});
document.addEventListener('pointercancel', () => {
  pointerFocusTransfer = false;
  if (inputRenderPending) render();
});
document.addEventListener('focusin', (event) => {
  if (!inputRenderPending || pointerFocusTransfer) return;
  finishInputRender(event.target);
});

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  if (document.querySelector('[data-walkthrough-ready="true"]')) return;
  const activeModal = document.querySelector('[role="dialog"][aria-modal="true"]');
  if (activeModal && event.key === 'Tab') {
    const focusable = [...activeModal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [href], [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length);
    if (!focusable.length) return;
    const currentIndex = focusable.indexOf(document.activeElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
    event.preventDefault();
    focusable[nextIndex].focus();
    return;
  }
  if (consultationDialogOpen && event.key === 'Escape') {
    event.preventDefault();
    closeConsultationDialog();
    return;
  }
  if (comparisonDialogOpen && event.key === 'Escape') {
    event.preventDefault();
    closeComparisonDialog();
    return;
  }
  if (demoGalleryOpen && event.key === 'Escape') {
    event.preventDefault();
    if (pendingDemoId) {
      pendingDemoId = null;
      render();
      document.querySelector('[data-demo-layout]')?.focus();
    } else {
      closeDemoGallery();
    }
    return;
  }
  if (starterDialogOpen && event.key === 'Escape') {
    event.preventDefault();
    starterDialogOpen = false;
    render();
    document.querySelector('[data-start-open]')?.focus();
    return;
  }
  if (projectDialogOpen && event.key === 'Escape') {
    event.preventDefault();
    projectDialogOpen = false;
    render();
    document.querySelector('[data-project-open]')?.focus();
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
  if (cloudLoadBusy || activeModal) return;
  if (spaceEditor?.keydown(event)) return;
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
    const dimensionIds = new Set(entries.filter((entry) => entry.kind === 'dimension').map((entry) => entry.id));
    const movementScale = event.shiftKey ? 40 : 1;
    const keyboardMovement = { x: movement.x * movementScale, y: movement.y * movementScale };
    state.zones = state.zones.map((zone) => zoneIds.has(zone.id) ? { ...zone, x: zone.x + keyboardMovement.x, y: zone.y + keyboardMovement.y } : zone);
    state.dimensions = state.dimensions.map((dimension) => dimensionIds.has(dimension.id) ? {
      ...dimension,
      x1: dimension.x1 + keyboardMovement.x,
      y1: dimension.y1 + keyboardMovement.y,
      x2: dimension.x2 + keyboardMovement.x,
      y2: dimension.y2 + keyboardMovement.y,
    } : dimension);
    commitEditorPreview(previous);
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
    const directSpaceDrag = workspaceMode === 'simple' && entityPress.kind === 'zone';
    if (movedPastSlop && (directSpaceDrag || (entityPress.initiallySelected && isSelected(entityPress.kind, entityPress.id)))) {
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
  else if (resize) finishResize();
  else if (drag) finishDrag();
  else if (marquee) finishMarquee();
});
document.addEventListener('pointercancel', (event) => {
  cancelEntityPress();
  activePointers.delete(event.pointerId);
  if (drag || resize || marquee || backgroundDrag || pan || pinch) cancelTemporaryGesture();
  else if (!activePointers.size) gestureMode = 'idle';
});
document.addEventListener('lostpointercapture', (event) => {
  cancelEntityPress();
  activePointers.delete(event.pointerId);
  if (drag || resize || marquee || backgroundDrag || pan || pinch) cancelTemporaryGesture();
  else if (!activePointers.size) gestureMode = 'idle';
});

spaceEditor = createSpaceEditor({
  getLayout: () => state,
  getSelected: () => state.selection?.kind === 'zone' && selectionKeys.size === 1 ? selectedEntity() : null,
  getSvg: () => document.querySelector('#plan-canvas'),
  getGesture: () => gestureMode,
  enabled: () => !active3dCleanup && !document.querySelector('[role="dialog"][aria-modal="true"]'),
  beginContact: beginPointerContact,
  captureContact: captureActivePointers,
  startPan,
  selectSpace: (event, id) => startEntityPress(event, 'zone', id),
  createSpace(points) {
    const zone = zoneFromPoints(makeZone({
      name: `공간 ${groupSpaces(state.zones).length + 1}`, type: '방', color: spaceColors[state.zones.length % spaceColors.length],
    }), points);
    updateState({ zones: [...state.zones, zone], selection: { kind: 'zone', id: zone.id } });
  },
  changeSpace(zone) {
    updateState({ zones: state.zones.map(current => current.id === zone.id ? zone : current) });
  },
  render,
  modeChanged() {
    precisionTool = null;
    quickSizesOpen = false;
    mobilePanel = 'canvas';
    editorNotice = '';
  },
});

mobileLayoutQuery.addEventListener('change', () => {
  spaceEditor.cancelPointer();
  if (drag || resize || marquee || backgroundDrag || pan || pinch || entityPress) {
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
