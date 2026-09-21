import {
  hasPolygon, zonePoints, zoneFromPoints, pointInPolygon, polygonUnionArea,
  polygonIntersectionArea, polygonWallSegments, segmentFrame,
  segmentFromEndpoints, structureAngle, angleTangent, framePoint, frameProjection, frameDistance,
} from './space-geometry.js';
export {
  POLYGON_LIMITS, zonePoints, zoneFromPoints, zoneInteriorPoint,
  moveZoneVertex, moveZoneEdge, setZoneEdgeLength, segmentEndpoints, segmentFrame, structureAngle,
  attachOpeningToZoneEdge, reprojectOpeningToZone, reconcileZoneOpenings,
} from './space-geometry.js';

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
  if (hasPolygon(zone)) {
    const points = zonePoints(zone);
    return { left: Math.min(...points.map(point => point.x)), right: Math.max(...points.map(point => point.x)),
      top: Math.min(...points.map(point => point.y)), bottom: Math.max(...points.map(point => point.y)) };
  }
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

  const bounds = zoneBounds(zone);
  let { left, right, top, bottom } = bounds;

  if (direction.x < 0) left = Math.min(point.x, right - minimumSize);
  if (direction.x > 0) right = Math.max(point.x, left + minimumSize);
  if (direction.y < 0) top = Math.min(point.y, bottom - minimumSize);
  if (direction.y > 0) bottom = Math.max(point.y, top + minimumSize);

  if (hasPolygon(zone)) return zoneFromPoints(zone, zonePoints(zone).map(point => ({
    x: left + (point.x - bounds.left) * (right - left) / (bounds.right - bounds.left),
    y: top + (point.y - bounds.top) * (bottom - top) / (bounds.bottom - bounds.top),
  })));
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
  if (hasPolygon(first) || hasPolygon(second)) return polygonIntersectionArea([first], [second]) > 1e-8;
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
  if (hasPolygon(zone)) return pointInPolygon(point, zonePoints(zone));
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
  const area = (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
  if (zones.some(hasPolygon)) {
    const covered = polygonIntersectionArea([boundsFootprint(bounds)], zones);
    return area > 0 && Math.abs(area - covered) <= Math.max(1e-8, Number.EPSILON * area * 64);
  }
  const coveredArea = calculateUnionArea(clippedItemFootprints(item, zones));
  // Allow only floating-point roundoff when the union partitions rotated bounds.
  return area > 0 && Math.abs(area - coveredArea) <= Number.EPSILON * area * 8;
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

  if (zones.some(hasPolygon)) {
    const footprint = [boundsFootprint(bounds)];
    const covered = polygonIntersectionArea(footprint, zones);
    const highEnough = polygonIntersectionArea(footprint, zones.filter(zone => itemTop <= (zone.height ?? defaultHeight)));
    return Math.abs(covered - highEnough) <= Math.max(1e-8, Number.EPSILON * covered * 64);
  }
  return corners.every((corner) => {
    const containingZones = zones.filter((zone) => pointInZone(corner, zone));
    return !containingZones.length || containingZones.some((zone) => itemTop <= (zone.height ?? defaultHeight));
  });
}

export function findHeightViolations(items, zones, defaultHeight = 240) {
  return new Set(items.filter((item) => !itemFitsZoneHeights(item, zones, defaultHeight)).map((item) => item.id));
}

export function getExteriorWallSegments(zones) {
  if (zones.some(hasPolygon)) return polygonWallSegments(zones);
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
  if (zones.some(hasPolygon)) return polygonWallSegments(zones, true);
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
  const tangent = angleTangent(structureAngle(structure));
  return segmentFromEndpoints(
    { x: structure.x - tangent.x * halfLength, y: structure.y - tangent.y * halfLength },
    { x: structure.x + tangent.x * halfLength, y: structure.y + tangent.y * halfLength },
  );
}

export function structureBounds(structure) {
  const frame = segmentFrame(structureSegment(structure));
  const halfThickness = Math.max(2, structure.type === 'wall' ? structure.thickness ?? 4 : 12) / 2;
  const dx = Math.abs(frame.normal.x) * halfThickness, dy = Math.abs(frame.normal.y) * halfThickness;
  return { left: Math.min(frame.start.x, frame.end.x) - dx, right: Math.max(frame.start.x, frame.end.x) + dx,
    top: Math.min(frame.start.y, frame.end.y) - dy, bottom: Math.max(frame.start.y, frame.end.y) + dy };
}

export function alignDoorToWall(door, wall) {
  if (!['door', 'window'].includes(door?.type) || wall?.type !== 'wall') return structuredClone(door);
  const segment = structureSegment(wall), frame = segmentFrame(segment);
  const halfRange = Math.max(0, frame.length / 2 - door.width / 2);
  const distance = Math.max(frame.length / 2 - halfRange, Math.min(frame.length / 2 + halfRange, frameProjection(frame, door)));
  const result = { ...structuredClone(door), ...framePoint(frame, distance), orientation: segment.orientation, wallId: wall.id };
  if (Number.isFinite(wall.angle) || Number.isFinite(door.angle) || segment.orientation === 'diagonal') result.angle = frame.angle;
  delete result.wallAttachment;
  return result;
}

export function resizeStructureFromEndpoint(structure, handle, point, minimumSize) {
  const sizeKey = structure.type === 'wall' ? 'length' : 'width';
  const minimum = minimumSize ?? (structure.type === 'wall' ? 40 : 50);
  const frame = segmentFrame(structureSegment(structure));
  const requested = frameProjection(frame, point);
  const start = handle === 'start' ? Math.min(requested, frame.length - minimum) : 0;
  const end = handle === 'start' ? frame.length : Math.max(requested, minimum);
  return { ...structuredClone(structure), ...framePoint(frame, (start + end) / 2), [sizeKey]: end - start };
}

export function snapDoorToWallSegments(door, targets, tolerance = 30) {
  if (!['door', 'window'].includes(door?.type)) return null;
  const half = door.width / 2;
  let nearest = null;
  targets.forEach((target) => {
    const frame = segmentFrame(target);
    if (frame.length < door.width) return;
    const axis = Math.min(frame.length - half, Math.max(half, frameProjection(frame, door)));
    const { x, y } = framePoint(frame, axis);
    const distance = Math.hypot(door.x - x, door.y - y);
    if (!nearest || distance < nearest.distance) nearest = { target, frame, x, y, distance };
  });
  if (!nearest || nearest.distance > tolerance) return null;
  const result = {
    ...structuredClone(door),
    x: nearest.x,
    y: nearest.y,
    orientation: nearest.target.orientation,
    wallId: nearest.target.wallId ?? null,
  };
  if (Number.isFinite(door.angle) || nearest.target.orientation === 'diagonal' || nearest.frame.angle < 0 || nearest.frame.angle > 90) result.angle = nearest.frame.angle;
  delete result.wallAttachment;
  return result;
}

export function splitWallSegment(segment, doors = [], tolerance = 12) {
  return splitWall(segment, doors, tolerance, false);
}

/** Uniform directed distances, including fragments shorter than 20cm at run seams. */
export function splitWallSegmentLocal(segment, doors = [], tolerance = 12) {
  return splitWall(segment, doors, tolerance, true);
}

function attachmentMatchesSegment(door, segment, frame) {
  const attachment = door.wallAttachment;
  if (!attachment) return true;
  return !segment.wallId && frameDistance(frame, door) <= 1e-8
    && (!segment.sources || segment.sources.some(source => source.zoneId === attachment.zoneId && source.edgeIndex === attachment.edgeIndex));
}

function splitWall(segment, doors, tolerance, local) {
  const frame = segmentFrame(segment);
  // Old axis-aligned opening coordinates remain absolute; diagonal coordinates
  // are distances from the directed start. Spans retain all non-opening metadata.
  const axis = segment.orientation === 'horizontal' ? 'x' : segment.orientation === 'vertical' ? 'y' : null;
  const toOffset = value => axis ? (value - frame.start[axis]) / frame.tangent[axis] : value;
  const toCoordinate = value => axis && !local ? framePoint(frame, value)[axis] : value;
  const explicitOpenings = doors.flatMap((door) => {
    if (!['door', 'window'].includes(door.type) || !attachmentMatchesSegment(door, segment, frame)) return [];
    const tangent = angleTangent(structureAngle(door));
    if (Math.abs(tangent.x * frame.tangent.y - tangent.y * frame.tangent.x) > 1e-8 || frameDistance(frame, door) > tolerance) return [];
    const center = frameProjection(frame, door);
    const start = Math.max(0, center - door.width / 2), end = Math.min(frame.length, center + door.width / 2);
    const minimumFragment = local || segment.sources ? 1e-8 : 20 - 1e-8;
    return end - start >= minimumFragment ? [{ start, end, door: structuredClone(door) }] : [];
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
      ? [{ start: Math.max(0, Math.min(toOffset(segment.doorStart), toOffset(segment.doorEnd))), end: Math.min(frame.length, Math.max(toOffset(segment.doorStart), toOffset(segment.doorEnd))), doors: [] }]
      : [];
  const spans = [];
  let cursor = 0;
  openings.forEach((opening) => {
    if (opening.start > cursor) spans.push({ start: cursor, end: opening.start });
    cursor = Math.max(cursor, opening.end);
  });
  if (cursor < frame.length) spans.push({ start: cursor, end: frame.length });
  const metadata = structuredClone(segment);
  for (const key of ['orientation', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'doorStart', 'doorEnd']) delete metadata[key];
  const toSegment = ({ start, end }) => ({ ...structuredClone(metadata), ...segmentFromEndpoints(framePoint(frame, start), framePoint(frame, end)) });
  return { spans: spans.map(toSegment), openings: openings.map(opening => ({ ...opening,
    start: Math.min(toCoordinate(opening.start), toCoordinate(opening.end)), end: Math.max(toCoordinate(opening.start), toCoordinate(opening.end)),
  })) };
}

export function doorsForAutomaticWallSegment(segment, doors = [], walls = [], automaticThickness = 6) {
  const frame = segmentFrame(segment);
  const wallsById = new Map(walls.filter((wall) => wall.type === 'wall').map((wall) => [wall.id, wall]));
  return doors.filter((door) => {
    if (!attachmentMatchesSegment(door, segment, frame)) return false;
    if (!door.wallId) return true;
    const wall = wallsById.get(door.wallId);
    if (!wall) return false;
    const other = segmentFrame(structureSegment(wall));
    if (Math.abs(frame.tangent.x * other.tangent.y - frame.tangent.y * other.tangent.x) > 1e-8) return false;
    const start = frameProjection(frame, other.start), end = frameProjection(frame, other.end);
    const centerTolerance = (automaticThickness + (wall.thickness ?? 4)) / 2;
    const overlap = Math.min(frame.length, Math.max(start, end)) - Math.max(0, Math.min(start, end));
    return frameDistance(frame, other.start) <= centerTolerance + 1e-8 && overlap >= 20 - 1e-8;
  }).map(door => structuredClone(door));
}

export function getDoorLeafSegments(doors) {
  const toPlanPoint = (door, axis, normal = 0) => {
    const tangent = angleTangent(structureAngle(door));
    return { x: door.x + tangent.x * axis - tangent.y * normal, y: door.y + tangent.y * axis + tangent.x * normal };
  };
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
  if (zones.some(hasPolygon)) return radius > 0
    ? itemInsideZones({ ...point, width: radius * 2, depth: radius * 2 }, zones)
    : zones.some(zone => pointInZone(point, zone));
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
    const frame = segmentFrame(segment), distance = frameProjection(frame, point);
    if (frameDistance(frame, point) > radius + 6 || distance < 0 || distance > frame.length) return false;
    if (!Number.isFinite(segment.doorStart) || !Number.isFinite(segment.doorEnd)) return true;
    const axis = segment.orientation === 'horizontal' ? 'x' : segment.orientation === 'vertical' ? 'y' : null;
    const a = axis ? (segment.doorStart - frame.start[axis]) / frame.tangent[axis] : segment.doorStart;
    const b = axis ? (segment.doorEnd - frame.start[axis]) / frame.tangent[axis] : segment.doorEnd;
    return distance < Math.min(a, b) + radius || distance > Math.max(a, b) - radius;
  });
}

export function getLayoutBounds(zones) {
  if (!zones.length) return { left: 0, top: 0, right: 400, bottom: 300, width: 400, depth: 300 };

  const bounds = zones.map(zoneBounds);
  const left = Math.min(...bounds.map(zone => zone.left));
  const top = Math.min(...bounds.map(zone => zone.top));
  const right = Math.max(...bounds.map(zone => zone.right));
  const bottom = Math.max(...bounds.map(zone => zone.bottom));
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
  if (zones.some(hasPolygon)) return polygonUnionArea(zones);
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

function boundsFootprint(bounds) {
  return { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, depth: bounds.bottom - bounds.top };
}

function clippedItemFootprints(item, zones) {
  const bounds = itemBounds(item);
  return zones.flatMap((zone) => {
    const x = Math.max(bounds.left, zone.x);
    const y = Math.max(bounds.top, zone.y);
    const width = Math.min(bounds.right, zone.x + zone.width) - x;
    const depth = Math.min(bounds.bottom, zone.y + zone.depth) - y;
    return width > 0 && depth > 0 ? [{ x, y, width, depth }] : [];
  });
}

// Bounding-footprint estimate, not a measure of clear walking space.
export function calculateCoverage(items, zones) {
  const homeArea = calculateUnionArea(zones);
  if (!homeArea) return 0;
  if (zones.some(hasPolygon)) {
    const footprints = items.filter(item => (item.elevation ?? 0) <= 0).map(item => boundsFootprint(itemBounds(item)));
    const usedArea = polygonIntersectionArea(zones, footprints);
    return Math.min(100, Math.max(0, Math.round(usedArea / homeArea * 100)));
  }
  const footprints = items
    .filter((item) => (item.elevation ?? 0) <= 0)
    .flatMap((item) => clippedItemFootprints(item, zones));
  const usedArea = calculateUnionArea(footprints);
  return Math.min(100, Math.max(0, Math.round((usedArea / homeArea) * 100)));
}

export function meters(cm) {
  return `${(cm / 100).toFixed(cm % 100 === 0 ? 0 : 1)}m`;
}
