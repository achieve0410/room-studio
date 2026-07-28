export const GRID_CM = 10;
export const RESIZE_DIRECTIONS = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
};

export function snap(value, grid = GRID_CM) {
  return Math.round(value / grid) * grid;
}

export function normalizeAngle(value) {
  const normalized = Number(value) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

export function rotationFromPointer(center, originRotation, startPointer, currentPointer, snapDegrees = 1) {
  const angle = (point) => Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI;
  const delta = ((angle(currentPointer) - angle(startPointer) + 540) % 360) - 180;
  const rotation = normalizeAngle(originRotation + delta);
  return normalizeAngle(Math.round(rotation / snapDegrees) * snapDegrees);
}

export function rotatedSize(item) {
  const radians = normalizeAngle(item.rotation ?? 0) * Math.PI / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  const clean = (value) => Number(value.toFixed(10));
  return {
    width: clean(item.width * cosine + item.depth * sine),
    depth: clean(item.width * sine + item.depth * cosine),
  };
}

export function itemBounds(item) {
  const size = rotatedSize(item);
  return {
    left: item.x - size.width / 2,
    right: item.x + size.width / 2,
    top: item.y - size.depth / 2,
    bottom: item.y + size.depth / 2,
  };
}

export function zoneBounds(zone) {
  return {
    left: zone.x,
    right: zone.x + zone.width,
    top: zone.y,
    bottom: zone.y + zone.depth,
  };
}

export function spaceIdOf(zone) {
  return zone.spaceId ?? zone.id;
}

export function zonesShareSpace(first, second) {
  return spaceIdOf(first) === spaceIdOf(second);
}

export function resizeZoneFromHandle(zone, handle, point, minimumSize = 100) {
  const direction = RESIZE_DIRECTIONS[handle];
  if (!direction) return zone;

  let left = zone.x;
  let right = zone.x + zone.width;
  let top = zone.y;
  let bottom = zone.y + zone.depth;

  if (direction.x < 0) left = Math.min(point.x, right - minimumSize);
  if (direction.x > 0) right = Math.max(point.x, left + minimumSize);
  if (direction.y < 0) top = Math.min(point.y, bottom - minimumSize);
  if (direction.y > 0) bottom = Math.max(point.y, top + minimumSize);

  return { ...zone, x: left, y: top, width: right - left, depth: bottom - top };
}

export function resizeItemFromHandle(item, handle, point, minimumSize = 20) {
  const direction = RESIZE_DIRECTIONS[handle];
  if (!direction) return item;

  const radians = ((item.rotation ?? 0) * Math.PI) / 180;
  const deltaX = point.x - item.x;
  const deltaY = point.y - item.y;
  const localPoint = {
    x: deltaX * Math.cos(radians) + deltaY * Math.sin(radians),
    y: -deltaX * Math.sin(radians) + deltaY * Math.cos(radians),
  };
  let left = -item.width / 2;
  let right = item.width / 2;
  let top = -item.depth / 2;
  let bottom = item.depth / 2;

  if (direction.x < 0) left = Math.min(localPoint.x, right - minimumSize);
  if (direction.x > 0) right = Math.max(localPoint.x, left + minimumSize);
  if (direction.y < 0) top = Math.min(localPoint.y, bottom - minimumSize);
  if (direction.y > 0) bottom = Math.max(localPoint.y, top + minimumSize);

  const localCenter = { x: (left + right) / 2, y: (top + bottom) / 2 };
  const width = right - left;
  const depth = bottom - top;
  return {
    ...item,
    x: item.x + localCenter.x * Math.cos(radians) - localCenter.y * Math.sin(radians),
    y: item.y + localCenter.x * Math.sin(radians) + localCenter.y * Math.cos(radians),
    width,
    depth,
    shape: item.shape === 'circle' && Math.abs(width - depth) > 0.5 ? 'ellipse' : item.shape,
  };
}

export function boundsOverlap(first, second, gap = 0) {
  return !(
    first.right <= second.left + gap ||
    first.left >= second.right - gap ||
    first.bottom <= second.top + gap ||
    first.top >= second.bottom - gap
  );
}

export function getAlignmentSnap(movingBounds, targetBounds, delta, threshold = 12) {
  const moved = {
    left: movingBounds.left + delta.x,
    right: movingBounds.right + delta.x,
    top: movingBounds.top + delta.y,
    bottom: movingBounds.bottom + delta.y,
  };
  let bestX = null;
  let bestY = null;

  targetBounds.forEach((bounds) => {
    const xPairs = [
      [moved.left, bounds.left], [moved.left, bounds.right],
      [(moved.left + moved.right) / 2, (bounds.left + bounds.right) / 2],
      [moved.right, bounds.left], [moved.right, bounds.right],
    ];
    const yPairs = [
      [moved.top, bounds.top], [moved.top, bounds.bottom],
      [(moved.top + moved.bottom) / 2, (bounds.top + bounds.bottom) / 2],
      [moved.bottom, bounds.top], [moved.bottom, bounds.bottom],
    ];
    xPairs.forEach(([movingEdge, targetEdge]) => {
      const offset = targetEdge - movingEdge;
      if (Math.abs(offset) <= threshold && (!bestX || Math.abs(offset) < Math.abs(bestX.offset))) {
        bestX = { offset, position: targetEdge };
      }
    });
    yPairs.forEach(([movingEdge, targetEdge]) => {
      const offset = targetEdge - movingEdge;
      if (Math.abs(offset) <= threshold && (!bestY || Math.abs(offset) < Math.abs(bestY.offset))) {
        bestY = { offset, position: targetEdge };
      }
    });
  });

  return {
    x: delta.x + (bestX?.offset ?? 0),
    y: delta.y + (bestY?.offset ?? 0),
    snapX: Boolean(bestX),
    snapY: Boolean(bestY),
    guides: [
      ...(bestX ? [{ orientation: 'vertical', position: bestX.position }] : []),
      ...(bestY ? [{ orientation: 'horizontal', position: bestY.position }] : []),
    ],
  };
}

export function zonesOverlap(first, second) {
  return boundsOverlap(zoneBounds(first), zoneBounds(second));
}

export function findZoneOverlaps(zones) {
  const overlaps = new Set();

  for (let i = 0; i < zones.length; i += 1) {
    for (let j = i + 1; j < zones.length; j += 1) {
      if (zonesShareSpace(zones[i], zones[j])) continue;
      if (zonesOverlap(zones[i], zones[j])) {
        overlaps.add(zones[i].id);
        overlaps.add(zones[j].id);
      }
    }
  }

  return overlaps;
}

export function itemsOverlap3d(first, second, gap = 2) {
  if (!boundsOverlap(itemBounds(first), itemBounds(second), gap)) return false;

  const firstBottom = first.elevation ?? 0;
  const secondBottom = second.elevation ?? 0;
  const firstTop = firstBottom + (first.height ?? 0);
  const secondTop = secondBottom + (second.height ?? 0);

  return firstTop > secondBottom && secondTop > firstBottom;
}

export function findCollisions(items) {
  const collisions = new Set();

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (itemsOverlap3d(items[i], items[j])) {
        collisions.add(items[i].id);
        collisions.add(items[j].id);
      }
    }
  }

  return collisions;
}

export function pointInZone(point, zone) {
  const bounds = zoneBounds(zone);
  return (
    point.x >= bounds.left &&
    point.x <= bounds.right &&
    point.y >= bounds.top &&
    point.y <= bounds.bottom
  );
}

export function itemInsideZones(item, zones) {
  const bounds = itemBounds(item);
  const corners = [
    { x: bounds.left, y: bounds.top },
    { x: bounds.right, y: bounds.top },
    { x: bounds.right, y: bounds.bottom },
    { x: bounds.left, y: bounds.bottom },
  ];

  return corners.every((corner) => zones.some((zone) => pointInZone(corner, zone)));
}

export function findOutOfBounds(items, zones) {
  return new Set(items.filter((item) => !itemInsideZones(item, zones)).map((item) => item.id));
}

export function itemFitsZoneHeights(item, zones, defaultHeight = 240) {
  const bounds = itemBounds(item);
  const corners = [
    { x: bounds.left, y: bounds.top },
    { x: bounds.right, y: bounds.top },
    { x: bounds.right, y: bounds.bottom },
    { x: bounds.left, y: bounds.bottom },
  ];
  const itemTop = (item.elevation ?? 0) + (item.height ?? 0);

  return corners.every((corner) => {
    const containingZones = zones.filter((zone) => pointInZone(corner, zone));
    return !containingZones.length || containingZones.some((zone) => itemTop <= (zone.height ?? defaultHeight));
  });
}

export function findHeightViolations(items, zones, defaultHeight = 240) {
  return new Set(items.filter((item) => !itemFitsZoneHeights(item, zones, defaultHeight)).map((item) => item.id));
}

export function getExteriorWallSegments(zones) {
  if (!zones.length) return [];
  const xCoordinates = [...new Set(zones.flatMap((zone) => [zone.x, zone.x + zone.width]))].sort((a, b) => a - b);
  const yCoordinates = [...new Set(zones.flatMap((zone) => [zone.y, zone.y + zone.depth]))].sort((a, b) => a - b);
  const occupied = Array.from({ length: xCoordinates.length - 1 }, (_, xIndex) =>
    Array.from({ length: yCoordinates.length - 1 }, (_, yIndex) =>
      zones.some((zone) => pointInZone({
        x: (xCoordinates[xIndex] + xCoordinates[xIndex + 1]) / 2,
        y: (yCoordinates[yIndex] + yCoordinates[yIndex + 1]) / 2,
      }, zone)),
    ),
  );
  const segments = [];
  const isOccupied = (x, y) => occupied[x]?.[y] ?? false;

  for (let x = 0; x < occupied.length; x += 1) {
    for (let y = 0; y < occupied[x].length; y += 1) {
      if (!occupied[x][y]) continue;
      if (!isOccupied(x, y - 1)) segments.push({ orientation: 'horizontal', x1: xCoordinates[x], x2: xCoordinates[x + 1], y: yCoordinates[y] });
      if (!isOccupied(x, y + 1)) segments.push({ orientation: 'horizontal', x1: xCoordinates[x], x2: xCoordinates[x + 1], y: yCoordinates[y + 1] });
      if (!isOccupied(x - 1, y)) segments.push({ orientation: 'vertical', x: xCoordinates[x], y1: yCoordinates[y], y2: yCoordinates[y + 1] });
      if (!isOccupied(x + 1, y)) segments.push({ orientation: 'vertical', x: xCoordinates[x + 1], y1: yCoordinates[y], y2: yCoordinates[y + 1] });
    }
  }

  const merged = [];
  for (const orientation of ['horizontal', 'vertical']) {
    const groups = new Map();
    segments.filter((segment) => segment.orientation === orientation).forEach((segment) => {
      const key = orientation === 'horizontal' ? segment.y : segment.x;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(segment);
    });
    groups.forEach((group) => {
      group.sort((first, second) => orientation === 'horizontal' ? first.x1 - second.x1 : first.y1 - second.y1);
      group.forEach((segment) => {
        const previous = merged.at(-1);
        const joinsPrevious = previous && previous.orientation === orientation && (
          orientation === 'horizontal'
            ? previous.y === segment.y && previous.x2 === segment.x1
            : previous.x === segment.x && previous.y2 === segment.y1
        );
        if (joinsPrevious) {
          if (orientation === 'horizontal') previous.x2 = segment.x2;
          else previous.y2 = segment.y2;
        } else {
          merged.push({ ...segment });
        }
      });
    });
  }
  return merged;
}

export function getInteriorWallSegments(zones) {
  const segments = [];

  for (let firstIndex = 0; firstIndex < zones.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < zones.length; secondIndex += 1) {
      if (zonesShareSpace(zones[firstIndex], zones[secondIndex])) continue;
      const first = zoneBounds(zones[firstIndex]);
      const second = zoneBounds(zones[secondIndex]);
      const sharedTop = Math.max(first.top, second.top);
      const sharedBottom = Math.min(first.bottom, second.bottom);
      const sharedLeft = Math.max(first.left, second.left);
      const sharedRight = Math.min(first.right, second.right);

      if ((first.right === second.left || second.right === first.left) && sharedBottom > sharedTop) {
        segments.push({
          orientation: 'vertical',
          x: first.right === second.left ? first.right : second.right,
          y1: sharedTop,
          y2: sharedBottom,
        });
      }

      if ((first.bottom === second.top || second.bottom === first.top) && sharedRight > sharedLeft) {
        segments.push({
          orientation: 'horizontal',
          x1: sharedLeft,
          x2: sharedRight,
          y: first.bottom === second.top ? first.bottom : second.bottom,
        });
      }
    }
  }

  return segments;
}

export function structureSegment(structure) {
  const halfLength = (structure.type === 'wall' ? structure.length : structure.width) / 2;
  return structure.orientation === 'vertical'
    ? { orientation: 'vertical', x: structure.x, y1: structure.y - halfLength, y2: structure.y + halfLength }
    : { orientation: 'horizontal', x1: structure.x - halfLength, x2: structure.x + halfLength, y: structure.y };
}

export function structureBounds(structure) {
  const segment = structureSegment(structure);
  const halfThickness = Math.max(2, structure.type === 'wall' ? structure.thickness ?? 4 : 12) / 2;
  return segment.orientation === 'horizontal'
    ? { left: segment.x1, right: segment.x2, top: segment.y - halfThickness, bottom: segment.y + halfThickness }
    : { left: segment.x - halfThickness, right: segment.x + halfThickness, top: segment.y1, bottom: segment.y2 };
}

export function alignDoorToWall(door, wall) {
  if (!['door', 'window'].includes(door?.type) || wall?.type !== 'wall') return door;
  const halfRange = Math.max(0, wall.length / 2 - door.width / 2);
  if (wall.orientation === 'vertical') {
    return {
      ...door,
      x: wall.x,
      y: Math.min(wall.y + halfRange, Math.max(wall.y - halfRange, door.y)),
      orientation: 'vertical',
      wallId: wall.id,
    };
  }
  return {
    ...door,
    x: Math.min(wall.x + halfRange, Math.max(wall.x - halfRange, door.x)),
    y: wall.y,
    orientation: 'horizontal',
    wallId: wall.id,
  };
}

export function resizeStructureFromEndpoint(structure, handle, point, minimumSize) {
  const horizontal = structure.orientation === 'horizontal';
  const sizeKey = structure.type === 'wall' ? 'length' : 'width';
  const minimum = minimumSize ?? (structure.type === 'wall' ? 40 : 50);
  const center = horizontal ? structure.x : structure.y;
  const half = structure[sizeKey] / 2;
  const opposite = handle === 'start' ? center + half : center - half;
  const requested = horizontal ? point.x : point.y;
  const endpoint = handle === 'start'
    ? Math.min(requested, opposite - minimum)
    : Math.max(requested, opposite + minimum);
  const start = Math.min(endpoint, opposite);
  const end = Math.max(endpoint, opposite);
  return {
    ...structure,
    [horizontal ? 'x' : 'y']: (start + end) / 2,
    [sizeKey]: end - start,
  };
}

export function snapDoorToWallSegments(door, targets, tolerance = 30) {
  if (!['door', 'window'].includes(door?.type)) return null;
  const half = door.width / 2;
  let nearest = null;
  targets.forEach((target) => {
    const horizontal = target.orientation === 'horizontal';
    const start = horizontal ? target.x1 : target.y1;
    const end = horizontal ? target.x2 : target.y2;
    if (end - start < door.width) return;
    const minimum = start + half;
    const maximum = end - half;
    const requested = horizontal ? door.x : door.y;
    const axis = Math.min(maximum, Math.max(minimum, requested));
    const x = horizontal ? axis : target.x;
    const y = horizontal ? target.y : axis;
    const distance = Math.hypot(door.x - x, door.y - y);
    if (!nearest || distance < nearest.distance) nearest = { target, x, y, distance };
  });
  if (!nearest || nearest.distance > tolerance) return null;
  return {
    ...door,
    x: nearest.x,
    y: nearest.y,
    orientation: nearest.target.orientation,
    wallId: nearest.target.wallId ?? null,
  };
}

export function splitWallSegment(segment, doors = [], tolerance = 12) {
  const horizontal = segment.orientation === 'horizontal';
  const start = horizontal ? segment.x1 : segment.y1;
  const end = horizontal ? segment.x2 : segment.y2;
  const fixed = horizontal ? segment.y : segment.x;
  const explicitOpenings = doors.flatMap((door) => {
    if (!['door', 'window'].includes(door.type) || door.orientation !== segment.orientation) return [];
    const doorFixed = horizontal ? door.y : door.x;
    const doorCenter = horizontal ? door.x : door.y;
    if (Math.abs(doorFixed - fixed) > tolerance) return [];
    const openingStart = Math.max(start, doorCenter - door.width / 2);
    const openingEnd = Math.min(end, doorCenter + door.width / 2);
    return openingEnd - openingStart >= 20 ? [{ start: openingStart, end: openingEnd, door }] : [];
  }).sort((first, second) => first.start - second.start);
  const openings = explicitOpenings.length
    ? explicitOpenings.reduce((merged, opening) => {
        const previous = merged.at(-1);
        if (previous && opening.start <= previous.end) {
          previous.end = Math.max(previous.end, opening.end);
          previous.doors.push(opening.door);
        } else {
          merged.push({ start: opening.start, end: opening.end, doors: [opening.door] });
        }
        return merged;
      }, [])
    : Number.isFinite(segment.doorStart) && Number.isFinite(segment.doorEnd)
      ? [{ start: segment.doorStart, end: segment.doorEnd, doors: [] }]
      : [];
  const spans = [];
  let cursor = start;
  openings.forEach((opening) => {
    if (opening.start > cursor) spans.push({ start: cursor, end: opening.start });
    cursor = Math.max(cursor, opening.end);
  });
  if (cursor < end) spans.push({ start: cursor, end });
  const toSegment = ({ start: spanStart, end: spanEnd }) => horizontal
    ? { orientation: 'horizontal', x1: spanStart, x2: spanEnd, y: fixed }
    : { orientation: 'vertical', x: fixed, y1: spanStart, y2: spanEnd };
  return { spans: spans.map(toSegment), openings };
}

export function doorsForAutomaticWallSegment(segment, doors = [], walls = [], automaticThickness = 6) {
  const horizontal = segment.orientation === 'horizontal';
  const segmentStart = horizontal ? segment.x1 : segment.y1;
  const segmentEnd = horizontal ? segment.x2 : segment.y2;
  const segmentFixed = horizontal ? segment.y : segment.x;
  const wallsById = new Map(walls.filter((wall) => wall.type === 'wall').map((wall) => [wall.id, wall]));
  return doors.filter((door) => {
    if (!door.wallId) return true;
    const wall = wallsById.get(door.wallId);
    if (!wall || wall.orientation !== segment.orientation) return false;
    const wallSegment = structureSegment(wall);
    const wallStart = horizontal ? wallSegment.x1 : wallSegment.y1;
    const wallEnd = horizontal ? wallSegment.x2 : wallSegment.y2;
    const wallFixed = horizontal ? wallSegment.y : wallSegment.x;
    const centerTolerance = (automaticThickness + (wall.thickness ?? 4)) / 2;
    const overlap = Math.min(segmentEnd, wallEnd) - Math.max(segmentStart, wallStart);
    return Math.abs(segmentFixed - wallFixed) <= centerTolerance && overlap >= 20;
  });
}

export function getDoorLeafSegments(doors) {
  const toPlanPoint = (door, axis, normal = 0) => door.orientation === 'vertical'
    ? { x: door.x - normal, y: door.y + axis }
    : { x: door.x + axis, y: door.y + normal };
  return doors.flatMap((door) => {
    if (door?.type !== 'door') return [];
    const width = Math.max(0, door.width ?? 0);
    if (door.doorType === 'sliding') {
      const direction = door.slideDirection === 'start' ? -1 : 1;
      const ratio = Math.min(100, Math.max(0, Number(door.openRatio) || 0)) / 100;
      const panelWidth = width / 2;
      const fixedCenter = direction * width / 4;
      const movingCenter = -direction * width / 4 + direction * width / 2 * ratio;
      return [
        [fixedCenter - panelWidth / 2, fixedCenter + panelWidth / 2, -2],
        [movingCenter - panelWidth / 2, movingCenter + panelWidth / 2, 2],
      ].map(([start, end, normal]) => ({
        start: toPlanPoint(door, start, normal),
        end: toPlanPoint(door, end, normal),
        doorId: door.id,
      }));
    }
    const angle = Math.min(120, Math.max(0, Number(door.openAngle) || 0)) * Math.PI / 180;
    const hingeAtEnd = door.hinge === 'end';
    const hingeAxis = hingeAtEnd ? width / 2 : -width / 2;
    const leafDirection = hingeAtEnd ? -1 : 1;
    const openSide = Number(door.openSide) === 1 ? 1 : -1;
    return [{
      start: toPlanPoint(door, hingeAxis),
      end: toPlanPoint(
        door,
        hingeAxis + leafDirection * width * Math.cos(angle),
        openSide * width * Math.sin(angle),
      ),
      doorId: door.id,
    }];
  });
}

export function isPointBlockedByDoorLeaves(point, segments, radius = 18) {
  return segments.some((segment) => {
    const deltaX = segment.end.x - segment.start.x;
    const deltaY = segment.end.y - segment.start.y;
    const lengthSquared = deltaX ** 2 + deltaY ** 2;
    const projection = lengthSquared
      ? Math.min(1, Math.max(0, ((point.x - segment.start.x) * deltaX + (point.y - segment.start.y) * deltaY) / lengthSquared))
      : 0;
    const nearestX = segment.start.x + deltaX * projection;
    const nearestY = segment.start.y + deltaY * projection;
    return Math.hypot(point.x - nearestX, point.y - nearestY) <= radius + 2;
  });
}

export function isWalkablePoint(point, zones, radius = 18) {
  const offsets = [
    [0, 0], [-radius, -radius], [radius, -radius], [radius, radius], [-radius, radius],
  ];
  return offsets.every(([x, y]) => zones.some((zone) => pointInZone({ x: point.x + x, y: point.y + y }, zone)));
}

export function isPointBlockedByFurniture(point, items, radius = 18, eyeHeight = 165) {
  return items.some((item) => {
    const bottom = item.elevation ?? 0;
    const top = bottom + (item.height ?? 0);
    if (top < 20 || bottom > eyeHeight + 20) return false;
    const bounds = itemBounds(item);
    return point.x >= bounds.left - radius && point.x <= bounds.right + radius
      && point.y >= bounds.top - radius && point.y <= bounds.bottom + radius;
  });
}

export function isPointBlockedByInteriorWall(point, segments, radius = 18) {
  return segments.some((segment) => {
    if (segment.orientation === 'horizontal') {
      if (Math.abs(point.y - segment.y) > radius + 6 || point.x < segment.x1 || point.x > segment.x2) return false;
      if (!Number.isFinite(segment.doorStart) || !Number.isFinite(segment.doorEnd)) return true;
      return point.x < segment.doorStart + radius || point.x > segment.doorEnd - radius;
    }
    if (Math.abs(point.x - segment.x) > radius + 6 || point.y < segment.y1 || point.y > segment.y2) return false;
    if (!Number.isFinite(segment.doorStart) || !Number.isFinite(segment.doorEnd)) return true;
    return point.y < segment.doorStart + radius || point.y > segment.doorEnd - radius;
  });
}

export function getLayoutBounds(zones) {
  if (!zones.length) return { left: 0, top: 0, right: 400, bottom: 300, width: 400, depth: 300 };

  const left = Math.min(...zones.map((zone) => zone.x));
  const top = Math.min(...zones.map((zone) => zone.y));
  const right = Math.max(...zones.map((zone) => zone.x + zone.width));
  const bottom = Math.max(...zones.map((zone) => zone.y + zone.depth));
  return { left, top, right, bottom, width: right - left, depth: bottom - top };
}

export function getZoomViewBox(base, scale, center = null) {
  const width = base.width / scale;
  const height = base.height / scale;
  const centerX = center?.x ?? base.left + base.width / 2;
  const centerY = center?.y ?? base.top + base.height / 2;
  return {
    left: centerX - width / 2,
    top: centerY - height / 2,
    width,
    height,
  };
}

export function getAnchoredZoomViewBox(base, current, scale, anchor) {
  const next = getZoomViewBox(base, scale);
  const ratioX = (anchor.x - current.left) / current.width;
  const ratioY = (anchor.y - current.top) / current.height;
  return {
    left: anchor.x - ratioX * next.width,
    top: anchor.y - ratioY * next.height,
    width: next.width,
    height: next.height,
  };
}

export function clampZoom(zoom, min = 0.05, max = 6) {
  return Math.min(max, Math.max(min, zoom));
}

export function getPannedViewBox(viewBox, screenDelta, viewportSize) {
  const renderedScale = Math.min(viewportSize.width / viewBox.width, viewportSize.height / viewBox.height);
  const viewUnitsPerPixel = 1 / renderedScale;
  return {
    ...viewBox,
    left: viewBox.left - screenDelta.x * viewUnitsPerPixel,
    top: viewBox.top - screenDelta.y * viewUnitsPerPixel,
  };
}

export function getPinchViewBox(base, startViewBox, startZoom, gesture, viewportSize, minZoom = 0.05, maxZoom = 6) {
  const zoom = clampZoom(startZoom * (gesture.currentDistance / gesture.startDistance), minZoom, maxZoom);
  const zoomed = getAnchoredZoomViewBox(base, startViewBox, zoom, gesture.anchor);
  return {
    zoom,
    viewBox: getPannedViewBox(zoomed, {
      x: gesture.currentMidpoint.x - gesture.startMidpoint.x,
      y: gesture.currentMidpoint.y - gesture.startMidpoint.y,
    }, viewportSize),
  };
}

export function getRolledBackSelection(baseSelection) {
  return new Set(baseSelection ?? []);
}

export function calculateUnionArea(zones) {
  if (!zones.length) return 0;
  const xCoordinates = [...new Set(zones.flatMap((zone) => [zone.x, zone.x + zone.width]))].sort(
    (a, b) => a - b,
  );
  let area = 0;

  for (let index = 0; index < xCoordinates.length - 1; index += 1) {
    const left = xCoordinates[index];
    const right = xCoordinates[index + 1];
    const intervals = zones
      .filter((zone) => zone.x < right && zone.x + zone.width > left)
      .map((zone) => [zone.y, zone.y + zone.depth])
      .sort((a, b) => a[0] - b[0]);

    let coveredDepth = 0;
    let current = null;
    for (const interval of intervals) {
      if (!current || interval[0] > current[1]) {
        if (current) coveredDepth += current[1] - current[0];
        current = [...interval];
      } else {
        current[1] = Math.max(current[1], interval[1]);
      }
    }
    if (current) coveredDepth += current[1] - current[0];
    area += (right - left) * coveredDepth;
  }

  return area;
}

export function calculateCoverage(items, zones) {
  const homeArea = calculateUnionArea(zones);
  if (!homeArea) return 0;
  const usedArea = items.reduce((total, item) => total + item.width * item.depth, 0);
  return Math.round((usedArea / homeArea) * 100);
}

export function meters(cm) {
  return `${(cm / 100).toFixed(cm % 100 === 0 ? 0 : 1)}m`;
}
