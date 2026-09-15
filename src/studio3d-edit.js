import {
  alignDoorToWall, getExteriorWallSegments, getInteriorWallSegments, normalizeAngle,
  pointInZone, snapDoorToWallSegments, spaceIdOf, structureSegment,
} from './geometry.js';

const copy = (value) => structuredClone(value);
const collections = { item: 'items', structure: 'structures', zone: 'zones' };

export function studioWallTargets(layout) {
  return [
    ...(layout.structures ?? []).filter(entry => entry.type === 'wall').map(wall => ({
      ...structureSegment(wall), wallId: wall.id, name: wall.name, locked: wall.locked,
    })),
    ...getExteriorWallSegments(layout.zones),
    ...getInteriorWallSegments(layout.zones),
  ];
}

function prepareAction(layout, requested) {
  const action = copy(requested);
  const [operation, kind] = action.type.split('-');
  const key = collections[kind];
  if (!key || !['add', 'update', 'delete'].includes(operation) || (kind === 'zone' && operation !== 'update'))
    throw new Error(`지원하지 않는 3D 작업: ${action.type}`);
  const selected = layout[key]?.find(entity => entity.id === action.id);
  const lockOnly = operation === 'update' && Object.keys(action.updates).length === 1 && typeof action.updates.locked === 'boolean';
  if (operation !== 'add' && (!selected || (selected.locked && !lockOnly))) return null;
  if (kind === 'structure' && selected?.type === 'wall' && !lockOnly
    && layout.structures.some(entry => entry.wallId === selected.id && entry.locked)) return null;
  if (kind === 'structure' && !lockOnly) {
    const ownerId = action.structure?.wallId ?? action.updates?.wallId ?? selected?.wallId;
    if (layout.structures.some(entry => entry.id === ownerId && entry.locked)) return null;
  }
  if (kind === 'zone' && ['floorMaterialId', 'wallMaterialId'].some(field => field in action.updates)
    && layout.zones.some(zone => spaceIdOf(zone) === spaceIdOf(selected) && zone.locked)) return null;
  if (operation === 'delete') return action;
  let next = operation === 'add' ? action[kind] : { ...selected, ...action.updates };
  if (operation === 'add' && layout[key]?.some(entry => entry.id === next.id)) throw new Error('같은 ID의 대상이 이미 있습니다.');
  if (kind === 'item') {
    if ('rotation' in next) next.rotation = normalizeAngle(next.rotation);
    if (next.shape === 'circle') {
      if (operation === 'update' && 'depth' in action.updates) next.width = next.depth;
      else next.depth = next.width;
    }
  }
  if (kind === 'structure' && !lockOnly) {
    if (next.type === 'wall') {
      next.length = Math.max(next.length, ...layout.structures.filter(entry => entry.wallId === next.id).map(entry => entry.width));
    } else if (operation === 'add' || ['x', 'y', 'width', 'wallId', 'orientation'].some(field => field in action.updates)) {
      const targets = studioWallTargets(layout).filter(target => !target.locked);
      const owner = next.wallId && targets.find(target => target.wallId === next.wallId);
      const moved = operation === 'update' && ['x', 'y'].some(field => field in action.updates && action.updates[field] !== selected[field]);
      const snapped = snapDoorToWallSegments(next, owner && !moved ? [owner] : targets, Infinity);
      if (!snapped) throw new Error('이 폭을 놓을 수 있는 벽이 없습니다. 폭을 줄이거나 벽을 추가하세요.');
      next = snapped;
    }
    if (next.type === 'window') {
      const height = layout.structures.find(entry => entry.id === next.wallId)?.height ?? layout.wallHeight ?? 240;
      next.sillHeight = Math.min(next.sillHeight ?? 90, Math.max(0, height - 50));
      next.height = Math.min(next.height, height - next.sillHeight);
    }
  }
  if (operation === 'add') action[kind] = next;
  else action.updates = Object.fromEntries(Object.entries(next).filter(([field, value]) => field !== 'id'
    && (field in action.updates || JSON.stringify(value) !== JSON.stringify(selected[field]))));
  return action;
}

const applyPrepared = (layout, action) => {
  const [operation, kind] = action.type.split('-');
  const key = collections[kind];
  if (operation === 'add') return { ...layout, [key]: [...(layout[key] ?? []), copy(action[kind])] };
  if (operation === 'delete') return {
    ...layout,
    [key]: layout[key].filter(entity => entity.id !== action.id && !(kind === 'structure' && entity.wallId === action.id)),
  };
  const selected = layout[key].find(entity => entity.id === action.id);
  const next = { ...selected, ...copy(action.updates) };
  const finishes = Object.fromEntries(
    Object.entries(action.updates).filter(([field]) => ['floorMaterialId', 'wallMaterialId'].includes(field)),
  );
  return {
    ...layout,
    [key]: layout[key].map((entity) => {
      if (entity.id === action.id) return next;
      if (kind === 'structure' && selected.type === 'wall' && entity.wallId === selected.id) {
        const rotated = selected.orientation !== next.orientation;
        const attached = alignDoorToWall({
          ...entity,
          x: rotated ? next.x : entity.x + next.x - selected.x,
          y: rotated ? next.y : entity.y + next.y - selected.y,
        }, next);
        if (attached.type === 'window') {
          attached.sillHeight = Math.min(attached.sillHeight, Math.max(0, next.height - 50));
          attached.height = Math.min(attached.height, next.height - attached.sillHeight);
        }
        return attached;
      }
      if (key === 'zones' && spaceIdOf(entity) === spaceIdOf(selected)) return { ...entity, ...finishes };
      return entity;
    }),
  };
};

/** Shared action semantics; the host still owns validation, history and persistence. */
export function applyStudioEditAction(layout, action) {
  const prepared = prepareAction(layout, action);
  return prepared ? applyPrepared(layout, prepared) : layout;
}

/** Drafts are disposable; the caller alone owns history, validation and persistence. */
export function createStudioEditSession({ layout, getLayout, onEdit, onPreview = () => {} }) {
  let baseline = copy(layout);
  let draft = copy(layout);
  let action = null;
  const refresh = (value) => {
    baseline = copy(value ?? getLayout?.() ?? baseline);
    draft = copy(baseline);
    action = null;
    onPreview(draft);
  };
  return {
    get layout() {
      return draft;
    },
    get pending() {
      return action !== null;
    },
    get action() {
      return action && copy(action);
    },
    refresh,
    preview(next) {
      const [operation, kind] = next.type.split('-');
      let candidate = next;
      if (action?.type === `add-${kind}` && next.id === action[kind].id) {
        if (operation === 'delete') { refresh(baseline); return true; }
        candidate = { ...action, [kind]: { ...action[kind], ...copy(next.updates) } };
      } else if (action?.type === next.type && action.id === next.id && operation === 'update') {
        candidate = { ...action, updates: { ...action.updates, ...copy(next.updates) } };
      }
      const prepared = prepareAction(baseline, candidate);
      if (!prepared) return false;
      const nextDraft = applyPrepared(baseline, prepared);
      action = prepared;
      draft = nextDraft;
      if (JSON.stringify(draft) === JSON.stringify(baseline)) action = null;
      onPreview(draft);
      return true;
    },
    commit() {
      if (!action) return false;
      const result = onEdit(copy(action));
      if (result?.then) throw new Error('3D edit callbacks must return a layout synchronously');
      if (result === false) throw new Error('변경이 거절되었습니다. 입력을 확인하세요.');
      refresh(result ?? getLayout?.() ?? draft);
      return true;
    },
    cancel() {
      refresh(baseline);
    },
  };
}

export function studioItemFromTemplate(template, point, id) {
  return { shape: 'rect', width: 100, depth: 70, height: 80, color: '#c8a777', type: 'custom',
    name: '커스텀 가구', ...copy(template), id, x: point.x, y: point.y, rotation: 0, elevation: 0, locked: false };
}

export function studioStructureFromType(type, point, id, wallHeight = 240) {
  const base = { id, x: point.x, y: point.y, orientation: 'horizontal', locked: false };
  if (type === 'wall') return { ...base, type, name: '벽', length: 240, height: wallHeight, thickness: 6 };
  if (type === 'window') return { ...base, type, name: '미닫이창', width: 160,
    height: Math.min(120, wallHeight - 90), sillHeight: 90, openRatio: 0, slideDirection: 'end', wallId: null };
  return { ...base, type: 'door', name: type === 'sliding' ? '미닫이문' : '여닫이문', doorType: type,
    width: type === 'sliding' ? 120 : 90, height: Math.min(205, wallHeight), hinge: 'start',
    openSide: -1, openAngle: 0, openRatio: 0, slideDirection: 'end', wallId: null };
}

export function studioItemFromAsset(asset, point, id) {
  return {
    id,
    assetId: asset.id,
    materialId: 'warm-oak',
    name: asset.name,
    type: asset.legacyTypes[0] ?? (asset.category.includes('table') ? 'table' : 'custom'),
    shape: 'rect',
    color: '#c8a777',
    x: point.x,
    y: point.y,
    width: Math.round(asset.dimensions.width * 100),
    depth: Math.round(asset.dimensions.depth * 100),
    height: Math.round(asset.dimensions.height * 100),
    rotation: 0,
    elevation: 0,
    locked: false,
  };
}

/** Split shared geometry segments at zone edges so each inward face has an owner. */
export function studioWallRuns(segment, zones) {
  const horizontal = segment.orientation === 'horizontal';
  const start = horizontal ? segment.x1 : segment.y1;
  const end = horizontal ? segment.x2 : segment.y2;
  const fixed = horizontal ? segment.y : segment.x;
  const cuts = [
    ...new Set([
      start,
      end,
      ...zones
        .flatMap((zone) => (horizontal ? [zone.x, zone.x + zone.width] : [zone.y, zone.y + zone.depth]))
        .filter((value) => value > start && value < end),
    ]),
  ].sort((a, b) => a - b);
  return cuts.slice(0, -1).map((value, index) => {
    const last = cuts[index + 1],
      middle = (value + last) / 2;
    const at = (offset) => ({
      x: horizontal ? middle : fixed + offset,
      y: horizontal ? fixed + offset : middle,
    });
    return {
      segment: horizontal ? { ...segment, x1: value, x2: last } : { ...segment, y1: value, y2: last },
      positive: zones.find((zone) => pointInZone(at(1), zone)),
      negative: zones.find((zone) => pointInZone(at(-1), zone)),
    };
  });
}
