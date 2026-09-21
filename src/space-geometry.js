// Browser-free polygon primitives. Coordinates and distances are centimeters.
export const POLYGON_LIMITS = Object.freeze({ maxVertices: 128, maxCoordinate: 1_000_000, minEdgeLength: 0.000001, minArea: 0.000001 });
const EPS = 1e-8;
const copy = value => structuredClone(value);
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a, b) => a.x * b.y - a.y * b.x;
const dot = (a, b) => a.x * b.x + a.y * b.y;
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const edgesOf = points => points.map((start, i) => ({ start, end: points[(i + 1) % points.length] }));
const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= EPS;
const signedArea = points => edgesOf(points).reduce((sum, edge) => sum + cross(sub(edge.start, points[0]), sub(edge.end, points[0])), 0) / 2;
const invalid = reason => { throw new Error(`Invalid polygon outline: ${reason}`); };

function onEdge(point, a, b) {
  const vector = sub(b, a);
  const length = Math.hypot(vector.x, vector.y);
  return length > 0 && Math.abs(cross(vector, sub(point, a))) <= EPS * length
    && dot(sub(point, a), vector) >= -EPS * length && dot(sub(point, b), vector) <= EPS * length;
}

// Segment intersections expressed as parameters on the first directed edge.
function cutsOnEdge(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c), q = sub(c, a);
  const determinant = cross(r, s);
  if (Math.abs(determinant) > EPS * Math.max(1, Math.hypot(r.x, r.y), Math.hypot(s.x, s.y))) {
    const t = cross(q, s) / determinant, u = cross(q, r) / determinant;
    return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS ? [Math.max(0, Math.min(1, t))] : [];
  }
  return [c, d].filter(point => onEdge(point, a, b)).map(point => dot(sub(point, a), r) / dot(r, r));
}

function validateOutline(points) {
  if (!Array.isArray(points) || points.length < 3 || points.length > POLYGON_LIMITS.maxVertices) invalid(`expected 3-${POLYGON_LIMITS.maxVertices} vertices`);
  if (points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || Math.abs(point.x) > POLYGON_LIMITS.maxCoordinate || Math.abs(point.y) > POLYGON_LIMITS.maxCoordinate)) invalid('coordinates must be finite and within the coordinate limit');
  const edges = edgesOf(points);
  for (let i = 0; i < edges.length; i += 1) {
    const a = edges[i];
    if (Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y) < POLYGON_LIMITS.minEdgeLength) invalid('zero-length edge or repeated vertex');
    const next = edges[(i + 1) % edges.length];
    if (onEdge(next.end, a.start, a.end) || onEdge(a.start, next.start, next.end)) invalid('adjacent edges overlap');
    for (let j = i + 1; j < edges.length; j += 1) {
      if (j === i + 1 || (i === 0 && j === edges.length - 1)) continue;
      const b = edges[j];
      if (cutsOnEdge(a.start, a.end, b.start, b.end).length || cutsOnEdge(b.start, b.end, a.start, a.end).length) invalid('self-intersection or repeated vertex');
    }
  }
  if (Math.abs(signedArea(points)) < POLYGON_LIMITS.minArea) invalid('degenerate area');
  return points;
}

export function hasPolygon(zone) { return 'points' in zone; }

/** Ordered world points; a malformed points field is never a rectangle fallback. */
export function zonePoints(zone) {
  if (hasPolygon(zone)) {
    validateOutline(zone.points);
    return validateOutline(zone.points.map(point => ({ x: zone.x + point.x, y: zone.y + point.y })));
  }
  return [{ x: zone.x, y: zone.y }, { x: zone.x + zone.width, y: zone.y },
    { x: zone.x + zone.width, y: zone.y + zone.depth }, { x: zone.x, y: zone.y + zone.depth }];
}

export function zoneFromPoints(zone, worldPoints) {
  validateOutline(worldPoints);
  const x = Math.min(...worldPoints.map(point => point.x));
  const y = Math.min(...worldPoints.map(point => point.y));
  const points = worldPoints.map(point => ({ x: point.x - x, y: point.y - y }));
  validateOutline(points);
  return { ...copy(zone), x, y, width: Math.max(...points.map(point => point.x)), depth: Math.max(...points.map(point => point.y)), points };
}

export function pointInPolygon(point, points) {
  let inside = false;
  for (const { start: a, end: b } of edgesOf(points)) {
    if (onEdge(point, a, b)) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < a.x + (point.y - a.y) * (b.x - a.x) / (b.y - a.y)) inside = !inside;
  }
  return inside;
}

function polygonIntervals(points, x) {
  const crossings = edgesOf(points).filter(({ start: a, end: b }) => (a.x > x) !== (b.x > x))
    .map(({ start: a, end: b }) => a.y + (x - a.x) * (b.y - a.y) / (b.x - a.x)).sort((a, b) => a - b);
  const result = [];
  for (let i = 0; i < crossings.length; i += 2) result.push([crossings[i], crossings[i + 1]]);
  return result;
}

function unionIntervals(intervals) {
  const merged = [];
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function intersectIntervals(first, second) {
  const result = [];
  let a = 0, b = 0;
  while (a < first.length && b < second.length) {
    const start = Math.max(first[a][0], second[b][0]), end = Math.min(first[a][1], second[b][1]);
    if (end > start) result.push([start, end]);
    if (first[a][1] < second[b][1]) a += 1; else b += 1;
  }
  return result;
}

// All edge crossings are sweep events. Between events each interval boundary is
// affine, so midpoint integration is exact (not grid sampling or triangulation).
function sweepArea(groups) {
  if (groups.some(group => !group.length)) return 0;
  const polygons = groups.flat();
  const edges = polygons.flatMap(edgesOf);
  const events = polygons.flatMap(points => points.map(point => point.x));
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const a = edges[i], b = edges[j];
      for (const t of cutsOnEdge(a.start, a.end, b.start, b.end)) events.push(lerp(a.start, a.end, t).x);
    }
  }
  const xs = [...new Set(events)].sort((a, b) => a - b);
  let area = 0;
  for (let i = 1; i < xs.length; i += 1) {
    const x = (xs[i - 1] + xs[i]) / 2;
    if (x === xs[i - 1] || x === xs[i]) continue;
    const intervals = groups.map(group => unionIntervals(group.flatMap(points => polygonIntervals(points, x))));
    const covered = intervals.reduce(intersectIntervals);
    area += (xs[i] - xs[i - 1]) * covered.reduce((sum, [start, end]) => sum + end - start, 0);
  }
  return area;
}

export const polygonUnionArea = zones => sweepArea([zones.map(zonePoints)]);
export const polygonIntersectionArea = (first, second) => sweepArea([first.map(zonePoints), second.map(zonePoints)]);

export function zoneInteriorPoint(zone) {
  const points = zonePoints(zone);
  const xs = [...new Set(points.map(point => point.x))].sort((a, b) => a - b);
  let best = null;
  for (let i = 1; i < xs.length; i += 1) {
    const x = (xs[i - 1] + xs[i]) / 2;
    for (const [top, bottom] of polygonIntervals(points, x)) {
      const clearance = Math.min(xs[i] - xs[i - 1], bottom - top);
      if (!best || clearance > best.clearance) best = { x, y: (top + bottom) / 2, clearance };
    }
  }
  return best ? { x: best.x, y: best.y } : { ...points[0] };
}

function editZone(zone, index, edit) {
  const points = zonePoints(zone);
  if (!Number.isInteger(index) || index < 0 || index >= points.length) return null;
  edit(points, index, (index + 1) % points.length);
  // Invalid previews are expected; do not hide other programming errors.
  try { return zoneFromPoints(zone, points); }
  catch (error) { if (error.message.startsWith('Invalid polygon outline:')) return null; throw error; }
}

export function moveZoneVertex(zone, index, point) {
  return editZone(zone, index, points => { points[index] = { x: point.x, y: point.y }; });
}

export function moveZoneEdge(zone, index, delta) {
  return editZone(zone, index, (points, start, end) => {
    for (const i of [start, end]) points[i] = { x: points[i].x + delta.x, y: points[i].y + delta.y };
  });
}

export function setZoneEdgeLength(zone, index, length, fixed = 'start') {
  if (!Number.isFinite(length) || length < POLYGON_LIMITS.minEdgeLength || !['start', 'end'].includes(fixed)) return null;
  return editZone(zone, index, (points, start, end) => {
    const vector = sub(points[end], points[start]);
    const ratio = length / Math.hypot(vector.x, vector.y);
    if (fixed === 'start') points[end] = { x: points[start].x + vector.x * ratio, y: points[start].y + vector.y * ratio };
    else points[start] = { x: points[end].x - vector.x * ratio, y: points[end].y - vector.y * ratio };
  });
}

export function segmentEndpoints(segment) {
  if (segment.orientation === 'horizontal') return { start: { x: segment.x1, y: segment.y }, end: { x: segment.x2, y: segment.y } };
  if (segment.orientation === 'vertical') return { start: { x: segment.x, y: segment.y1 }, end: { x: segment.x, y: segment.y2 } };
  return { start: { x: segment.x1, y: segment.y1 }, end: { x: segment.x2, y: segment.y2 } };
}

export function segmentFrame(segment) {
  const { start, end } = segmentEndpoints(segment);
  const vector = sub(end, start), length = Math.hypot(vector.x, vector.y);
  const tangent = length ? { x: vector.x / length, y: vector.y / length } : { x: 1, y: 0 };
  return { start, end, length, tangent, normal: { x: -tangent.y, y: tangent.x }, angle: Math.atan2(tangent.y, tangent.x) * 180 / Math.PI };
}

export function segmentFromEndpoints(start, end) {
  if (start.y === end.y) return { orientation: 'horizontal', x1: start.x, x2: end.x, y: start.y };
  if (start.x === end.x) return { orientation: 'vertical', x: start.x, y1: start.y, y2: end.y };
  return { orientation: 'diagonal', x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

export const structureAngle = structure => Number.isFinite(structure.angle) ? structure.angle : structure.orientation === 'vertical' ? 90 : 0;
export function angleTangent(angle) {
  const radians = angle * Math.PI / 180;
  const clean = value => Math.abs(value) < 1e-14 ? 0 : value;
  return { x: clean(Math.cos(radians)), y: clean(Math.sin(radians)) };
}
export const framePoint = (frame, distance, normal = 0) => ({ x: frame.start.x + frame.tangent.x * distance + frame.normal.x * normal, y: frame.start.y + frame.tangent.y * distance + frame.normal.y * normal });
export const frameProjection = (frame, point) => dot(sub(point, frame.start), frame.tangent);
export const frameDistance = (frame, point) => Math.abs(dot(sub(point, frame.start), frame.normal));

function mergeSegments(segments) {
  const merged = [];
  for (const segment of segments) {
    let { start, end } = segment;
    if (start.x > end.x || (start.x === end.x && start.y > end.y)) [start, end] = [end, start];
    let candidate = { start, end, sources: segment.sources };
    for (let i = 0; i < merged.length;) {
      const other = merged[i];
      const frame = segmentFrame(segmentFromEndpoints(candidate.start, candidate.end));
      const a = frameProjection(frame, other.start), b = frameProjection(frame, other.end);
      if (JSON.stringify(candidate.sources) === JSON.stringify(other.sources)
        && frameDistance(frame, other.start) <= EPS && frameDistance(frame, other.end) <= EPS
        && Math.max(a, b) >= -EPS && Math.min(a, b) <= frame.length + EPS) {
        candidate = { ...candidate, start: framePoint(frame, Math.min(0, a, b)), end: framePoint(frame, Math.max(frame.length, a, b)) };
        merged.splice(i, 1); i = 0;
      } else i += 1;
    }
    merged.push(candidate);
  }
  return merged.map(({ start, end, sources }) => ({ ...segmentFromEndpoints(start, end), sources: copy(sources) }));
}

export function polygonWallSegments(zones, interior = false) {
  const polygons = zones.map(zone => {
    const points = zonePoints(zone);
    return { points, edges: edgesOf(points), sign: Math.sign(signedArea(points)), spaceId: zone.spaceId ?? zone.id, zoneId: zone.id };
  });
  const edges = polygons.flatMap(polygon => polygon.edges);
  const result = [];
  for (const edge of edges) {
    const cuts = [...new Set([0, 1, ...edges.flatMap(other => cutsOnEdge(edge.start, edge.end, other.start, other.end))])].sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i += 1) {
      const start = lerp(edge.start, edge.end, cuts[i - 1]), end = lerp(edge.start, edge.end, cuts[i]);
      if (near(start, end)) continue;
      const midpoint = lerp(start, end, 0.5), direction = sub(end, start);
      const left = new Set(), right = new Set();
      const sources = [];
      for (const polygon of polygons) {
        const edgeIndex = polygon.edges.findIndex(other => onEdge(midpoint, other.start, other.end));
        const boundary = polygon.edges[edgeIndex];
        if (boundary) {
          sources.push({ zoneId: polygon.zoneId, edgeIndex });
          const sameDirection = dot(direction, sub(boundary.end, boundary.start)) > 0;
          (sameDirection === (polygon.sign > 0) ? left : right).add(polygon.spaceId);
        } else if (pointInPolygon(midpoint, polygon.points)) {
          left.add(polygon.spaceId); right.add(polygon.spaceId);
        }
      }
      const exterior = Boolean(left.size) !== Boolean(right.size);
      const shared = left.size && right.size && ![...left].some(id => right.has(id));
      if (interior ? shared : exterior) result.push({ start, end, sources });
    }
  }
  return mergeSegments(result);
}

function zoneEdgeFrame(zone, edgeIndex) {
  const points = zonePoints(zone);
  if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= points.length) return null;
  return segmentFrame(segmentFromEndpoints(points[edgeIndex], points[(edgeIndex + 1) % points.length]));
}

function openingOnEdge(opening, zone, edgeIndex, offset) {
  const frame = zoneEdgeFrame(zone, edgeIndex);
  if (!frame || !Number.isFinite(offset) || !Number.isFinite(opening.width) || opening.width <= 0
    || offset - opening.width / 2 < -EPS || offset + opening.width / 2 > frame.length + EPS) return null;
  return { ...copy(opening), ...framePoint(frame, offset), angle: frame.angle,
    orientation: segmentFromEndpoints(frame.start, frame.end).orientation, wallId: null,
    wallAttachment: { zoneId: zone.id, edgeIndex, offset } };
}

/** Attach at the nearest fitting center; offset is measured from the directed edge start. */
export function attachOpeningToZoneEdge(opening, zone, edgeIndex) {
  if (!['door', 'window'].includes(opening.type)) return null;
  const frame = zoneEdgeFrame(zone, edgeIndex);
  if (!frame || frame.length < opening.width) return null;
  const offset = Math.max(opening.width / 2, Math.min(frame.length - opening.width / 2, frameProjection(frame, opening)));
  return openingOnEdge(opening, zone, edgeIndex, offset);
}

/** Preserve the centimeter offset, clamping and persisting it only when needed to fit. */
export function reprojectOpeningToZone(opening, zone) {
  const attachment = opening.wallAttachment;
  if (!attachment || attachment.zoneId !== zone.id || !['door', 'window'].includes(opening.type)
    || opening.wallId || !Number.isFinite(attachment.offset) || attachment.offset < 0) return null;
  const frame = zoneEdgeFrame(zone, attachment.edgeIndex);
  if (!frame || frame.length < opening.width) return null;
  const offset = Math.max(opening.width / 2, Math.min(frame.length - opening.width / 2, attachment.offset));
  return openingOnEdge(opening, zone, attachment.edgeIndex, offset);
}

/** Atomic layout repair: cloned layout on success, null on any invalid surviving attachment. */
export function reconcileZoneOpenings(beforeLayout, afterLayout) {
  const result = copy(afterLayout);
  const previousZones = new Set(beforeLayout.zones.map(zone => zone.id));
  const zones = new Map(result.zones.map(zone => [zone.id, zone]));
  const structures = [];
  let supportingWalls;
  for (const opening of result.structures ?? []) {
    if (!opening.wallAttachment) { structures.push(opening); continue; }
    const id = opening.wallAttachment.zoneId;
    if (!zones.has(id)) {
      if (opening.locked) return null;
      if (previousZones.has(id)) continue;
      return null;
    }
    const repaired = reprojectOpeningToZone(opening, zones.get(id));
    if (!repaired) return null;
    if (opening.locked && (Math.hypot(repaired.x - opening.x, repaired.y - opening.y) > EPS
      || Math.abs(structureAngle(repaired) - structureAngle(opening)) > EPS
      || repaired.wallAttachment.offset !== opening.wallAttachment.offset)) return null;
    supportingWalls ??= [...polygonWallSegments(result.zones), ...polygonWallSegments(result.zones, true)];
    const { edgeIndex, offset } = repaired.wallAttachment;
    const frame = zoneEdgeFrame(zones.get(id), edgeIndex);
    const intervals = supportingWalls.filter(wall => wall.sources.some(source => source.zoneId === id && source.edgeIndex === edgeIndex))
      .map(wall => {
        const { start, end } = segmentEndpoints(wall);
        const a = frameProjection(frame, start), b = frameProjection(frame, end);
        return [Math.min(a, b), Math.max(a, b)];
      });
    const covered = intersectIntervals(unionIntervals(intervals), [[offset - repaired.width / 2, offset + repaired.width / 2]])
      .reduce((sum, [start, end]) => sum + end - start, 0);
    if (Math.abs(covered - repaired.width) > EPS * 8) return null;
    structures.push(repaired);
  }
  if ('structures' in result) result.structures = structures;
  return result;
}
