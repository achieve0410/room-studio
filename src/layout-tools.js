const clone = (value) => JSON.parse(JSON.stringify(value));

export function measurementLength(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

export function formatMeasurement(length) {
  const rounded = Math.round(length * 10) / 10;
  return rounded >= 100
    ? `${(rounded / 100).toFixed(rounded % 100 === 0 ? 0 : 2).replace(/0+$/, '').replace(/\.$/, '')}m`
    : `${rounded.toFixed(Number.isInteger(rounded) ? 0 : 1)}cm`;
}

export function calibrateBackgroundPlan(plan, first, second, actualLength) {
  const measuredLength = measurementLength(first, second);
  const targetLength = Number(actualLength);
  if (!plan || measuredLength <= 0 || !Number.isFinite(targetLength) || targetLength <= 0) return null;
  const scale = targetLength / measuredLength;
  return {
    ...plan,
    x: first.x - (first.x - plan.x) * scale,
    y: first.y - (first.y - plan.y) * scale,
    width: plan.width * scale,
    depth: plan.depth * scale,
  };
}

export function createLayoutClipboard(layout, selection) {
  const selected = {
    zone: new Set(),
    item: new Set(),
    structure: new Set(),
    dimension: new Set(),
  };
  selection.forEach(({ kind, id }) => selected[kind]?.add(id));
  layout.structures
    .filter((structure) => selected.structure.has(structure.wallId))
    .forEach((opening) => selected.structure.add(opening.id));
  return clone({
    zones: layout.zones.filter((zone) => selected.zone.has(zone.id)),
    items: layout.items.filter((item) => selected.item.has(item.id)),
    structures: layout.structures.filter((structure) => selected.structure.has(structure.id)),
    dimensions: (layout.dimensions ?? []).filter((dimension) => selected.dimension.has(dimension.id)),
  });
}

export function pasteLayoutClipboard(layout, clipboard, options = {}) {
  const source = clipboard ?? {};
  const offset = Number.isFinite(Number(options.offset)) ? Number(options.offset) : 20;
  const idFactory = options.idFactory ?? ((prefix) => `${prefix}-${crypto.randomUUID()}`);
  const zoneIds = new Map((source.zones ?? []).map((zone) => [zone.id, idFactory('zone')]));
  const itemIds = new Map((source.items ?? []).map((item) => [item.id, idFactory('item')]));
  const structureIds = new Map((source.structures ?? []).map((structure) => [structure.id, idFactory(structure.type)]));
  const dimensionIds = new Map((source.dimensions ?? []).map((dimension) => [dimension.id, idFactory('dimension')]));
  const spaceIds = new Map();
  const zones = (source.zones ?? []).map((zone) => {
    const sourceSpaceId = zone.spaceId ?? zone.id;
    if (!spaceIds.has(sourceSpaceId)) spaceIds.set(sourceSpaceId, idFactory('space'));
    return {
      ...zone,
      id: zoneIds.get(zone.id),
      spaceId: spaceIds.get(sourceSpaceId),
      x: zone.x + offset,
      y: zone.y + offset,
      locked: false,
    };
  });
  const items = (source.items ?? []).map((item) => ({
    ...item,
    id: itemIds.get(item.id),
    x: item.x + offset,
    y: item.y + offset,
    locked: false,
  }));
  const structures = (source.structures ?? []).map((structure) => ({
    ...structure,
    id: structureIds.get(structure.id),
    x: structure.x + offset,
    y: structure.y + offset,
    wallId: structure.wallId ? structureIds.get(structure.wallId) ?? null : null,
    locked: false,
  }));
  const dimensions = (source.dimensions ?? []).map((dimension) => ({
    ...dimension,
    id: dimensionIds.get(dimension.id),
    x1: dimension.x1 + offset,
    y1: dimension.y1 + offset,
    x2: dimension.x2 + offset,
    y2: dimension.y2 + offset,
    locked: false,
  }));
  return {
    layout: {
      ...layout,
      zones: [...layout.zones, ...zones],
      items: [...layout.items, ...items],
      structures: [...layout.structures, ...structures],
      dimensions: [...(layout.dimensions ?? []), ...dimensions],
    },
    selection: [
      ...zones.map(({ id }) => ({ kind: 'zone', id })),
      ...items.map(({ id }) => ({ kind: 'item', id })),
      ...structures.map(({ id }) => ({ kind: 'structure', id })),
      ...dimensions.map(({ id }) => ({ kind: 'dimension', id })),
    ],
  };
}
