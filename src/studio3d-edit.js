import { pointInZone, spaceIdOf } from './geometry.js';

const copy = (value) => structuredClone(value);
const apply = (layout, action) => {
  if (action.type === 'add-item') return { ...layout, items: [...layout.items, copy(action.item)] };
  const key = action.type === 'update-item' ? 'items' : 'zones';
  const selected = layout[key].find((entity) => entity.id === action.id);
  const finishes = Object.fromEntries(
    Object.entries(action.updates).filter(([field]) => ['floorMaterialId', 'wallMaterialId'].includes(field)),
  );
  return {
    ...layout,
    [key]: layout[key].map((entity) => {
      if (entity.id === action.id) return { ...entity, ...copy(action.updates) };
      if (key === 'zones' && spaceIdOf(entity) === spaceIdOf(selected)) return { ...entity, ...finishes };
      return entity;
    }),
  };
};

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
    refresh,
    preview(next) {
      const key = next.type === 'update-item' ? 'items' : 'zones';
      if (next.type !== 'add-item') {
        const entity = draft[key].find((entry) => entry.id === next.id);
        if (!entity || entity.locked) return false;
      }
      if (action && action.type === 'add-item' && next.type === 'update-item' && next.id === action.item.id) {
        action = { ...action, item: { ...action.item, ...copy(next.updates) } };
      } else if (action && action.type === next.type && action.id === next.id && next.type !== 'add-item') {
        action = { ...action, updates: { ...action.updates, ...copy(next.updates) } };
      } else {
        // Selecting a different target abandons the uncommitted operation.
        draft = copy(baseline);
        action = copy(next);
      }
      draft = apply(baseline, action);
      if (JSON.stringify(draft) === JSON.stringify(baseline)) action = null;
      onPreview(draft);
      return true;
    },
    commit() {
      if (!action) return false;
      const result = onEdit(copy(action));
      if (result?.then) throw new Error('3D edit callbacks must return a layout synchronously');
      refresh(result ?? getLayout?.() ?? draft);
      return true;
    },
    cancel() {
      refresh(baseline);
    },
  };
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
