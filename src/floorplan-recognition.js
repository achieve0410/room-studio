import { zoneFromPoints } from './space-geometry.js';

const areaOf = points => Math.abs(points.reduce((sum, p, i) => {
  const q = points[(i + 1) % points.length];
  return sum + p.x * q.y - q.x * p.y;
}, 0)) / 2;

function components(mask, width, height, value, diagonal = false) {
  const labels = new Int32Array(mask.length);
  const queue = new Int32Array(mask.length);
  const regions = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] !== value || labels[i]) continue;
    const id = regions.length + 1;
    const region = { id, count: 0, left: width, top: height, right: 0, bottom: 0, exterior: false };
    let head = 0, tail = 1;
    queue[0] = i;
    labels[i] = id;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width, y = Math.floor(index / width);
      region.count += 1;
      region.left = Math.min(region.left, x); region.right = Math.max(region.right, x);
      region.top = Math.min(region.top, y); region.bottom = Math.max(region.bottom, y);
      if (!x || !y || x === width - 1 || y === height - 1) region.exterior = true;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if ((!dx && !dy) || (!diagonal && dx && dy)) continue;
          if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
          const next = index + dy * width + dx;
          if (mask[next] === value && !labels[next]) {
            labels[next] = id; queue[tail++] = next;
          }
        }
      }
    }
    regions.push(region);
  }
  return { labels, regions };
}

function lineRuns(mask, width, height, vertical, visit) {
  const lines = vertical ? width : height, length = vertical ? height : width;
  const indexOf = (line, position) => vertical ? position * width + line : line * width + position;
  for (let line = 0; line < lines; line += 1) {
    for (let p = 0; p < length;) {
      if (!mask[indexOf(line, p)]) { p += 1; continue; }
      const start = p;
      while (p < length && mask[indexOf(line, p)]) p += 1;
      visit(line, start, p, indexOf);
    }
  }
}

function wallEvidence(dark, width, height, edge) {
  const horizontal = new Uint16Array(dark.length), vertical = new Uint16Array(dark.length);
  for (const [isVertical, lengths] of [[false, horizontal], [true, vertical]]) {
    lineRuns(dark, width, height, isVertical, (line, start, end, indexOf) => {
      for (let p = start; p < end; p += 1) lengths[indexOf(line, p)] = end - start;
    });
  }
  const minRun = Math.max(6, Math.round(edge * 0.025));
  const maxThickness = Math.max(3, Math.round(edge * 0.035));
  const { labels, regions } = components(dark, width, height, 1, true);
  const evidence = new Uint32Array(regions.length + 1);
  const thickness = new Uint32Array(regions.length + 1);
  let supported = 0, total = 0;
  for (let i = 0; i < dark.length; i += 1) {
    if (!dark[i]) continue;
    total += 1;
    if ((horizontal[i] >= minRun && vertical[i] <= maxThickness)
      || (vertical[i] >= minRun && horizontal[i] <= maxThickness)) {
      evidence[labels[i]] += 1; supported += 1;
      thickness[labels[i]] += Math.min(horizontal[i], vertical[i]);
    }
  }
  // Broad shadows and textured images are not evidence of a printed wall graph.
  const mask = new Uint8Array(dark.length);
  if (total / dark.length > 0.4 || supported < total * 0.25) return { mask, minRun };
  const primary = regions.reduce((best, region) => evidence[region.id] > evidence[best] ? region.id : best, 0);
  const wallThickness = evidence[primary] ? thickness[primary] / evidence[primary] : 1;
  const retained = new Set(regions.filter(region => evidence[region.id] >= minRun * 2
    && Math.max(region.right - region.left, region.bottom - region.top) >= Math.max(12, edge * 0.12)
    && (thickness[region.id] / evidence[region.id] >= wallThickness * 0.65
      || Math.max(region.right - region.left, region.bottom - region.top) >= edge * 0.4))
    .map(region => region.id));
  for (let i = 0; i < mask.length; i += 1) mask[i] = retained.has(labels[i]) ? 1 : 0;
  return { mask, minRun };
}

function repairGaps(mask, width, height, minRun, maxGap) {
  const repaired = mask.slice(), bridges = [];
  if (!maxGap) return { repaired, bridges };
  for (const vertical of [false, true]) {
    let previous = null;
    lineRuns(mask, width, height, vertical, (line, start, end, indexOf) => {
      if (end - start < minRun) return;
      if (previous?.line === line) {
        const gap = start - previous.end;
        if (gap > 0 && gap <= maxGap) {
          let ink = 0;
          for (let p = previous.end; p < start; p += 1) ink += mask[indexOf(line, p)];
          if (ink <= gap * 0.3) {
            for (let p = previous.end; p < start; p += 1) repaired[indexOf(line, p)] = 1;
            bridges.push({ vertical, line, start: previous.end, end: start });
          }
        }
      }
      previous = { line, end };
    });
  }
  return { repaired, bridges };
}

function outerContour(labels, region, width) {
  const stride = width + 1, edges = new Map();
  const add = (x, y, direction) => {
    const key = y * stride + x;
    const list = edges.get(key) ?? [];
    list.push(direction); edges.set(key, list);
  };
  const belongs = (x, y) => x >= region.left && x <= region.right && y >= region.top && y <= region.bottom
    && labels[y * width + x] === region.id;
  for (let y = region.top; y <= region.bottom; y += 1) {
    for (let x = region.left; x <= region.right; x += 1) {
      if (!belongs(x, y)) continue;
      if (!belongs(x, y - 1)) add(x, y, 0);
      if (!belongs(x + 1, y)) add(x + 1, y, 1);
      if (!belongs(x, y + 1)) add(x + 1, y + 1, 2);
      if (!belongs(x - 1, y)) add(x, y + 1, 3);
    }
  }
  const delta = [1, stride, -1, -stride];
  let largest = [], largestArea = 0;
  while (edges.size) {
    const start = edges.keys().next().value;
    let key = start, direction = edges.get(start)[0];
    const points = [];
    do {
      points.push({ x: key % stride, y: Math.floor(key / stride) });
      const available = edges.get(key);
      available.splice(available.indexOf(direction), 1);
      if (!available.length) edges.delete(key);
      key += delta[direction];
      if (key === start) break;
      const next = edges.get(key);
      if (!next) return [];
      // At a diagonal pixel contact, keep the same region on the right.
      direction = [(direction + 1) % 4, direction, (direction + 3) % 4, (direction + 2) % 4]
        .find(candidate => next.includes(candidate));
    } while (key !== start);
    const area = areaOf(points);
    if (area > largestArea) { largest = points; largestArea = area; }
  }
  // Interior ink islands (text/furniture) are not holes in the editable room.
  return largest;
}

function simplifyChain(points, tolerance) {
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    const a = points[first], b = points[last], dx = b.x - a.x, dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    let farthest = -1, maximum = tolerance * tolerance;
    for (let i = first + 1; i < last; i += 1) {
      const p = points[i];
      const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
      const distance = (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
      if (distance > maximum) { maximum = distance; farthest = i; }
    }
    if (farthest >= 0) {
      keep[farthest] = 1; stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function roomOutline(contour, edge) {
  if (contour.length < 3) return null;
  let split = 1, farthest = 0;
  for (let i = 1; i < contour.length; i += 1) {
    const distance = (contour[i].x - contour[0].x) ** 2 + (contour[i].y - contour[0].y) ** 2;
    if (distance > farthest) { split = i; farthest = distance; }
  }
  // Bounded approximation, never a bounding-box or convex-hull fallback.
  for (const tolerance of [Math.max(1.25, edge * 0.0015), Math.max(2, edge * 0.003)]) {
    const first = simplifyChain(contour.slice(0, split + 1), tolerance);
    const second = simplifyChain([...contour.slice(split), contour[0]], tolerance);
    const points = [...first.slice(0, -1), ...second.slice(0, -1)];
    if (points.length > 128) continue;
    try { zoneFromPoints({}, points); return points; }
    catch (error) {
      if (!error.message.startsWith('Invalid polygon outline:')) throw error;
    }
  }
  return null;
}

function openingCandidates(bridges, labels, regions, roomIds, width, height, edge) {
  const groups = [];
  for (const bridge of bridges) {
    const previous = groups.find(group => group.vertical === bridge.vertical && bridge.line === group.lastLine + 1
      && Math.min(group.end, bridge.end) - Math.max(group.start, bridge.start)
        >= Math.min(group.end - group.start, bridge.end - bridge.start) * 0.7
      && Math.abs(group.start - bridge.start) <= Math.max(2, edge * 0.006)
      && Math.abs(group.end - bridge.end) <= Math.max(2, edge * 0.006));
    if (previous) {
      previous.lastLine = bridge.line;
      previous.start = Math.min(previous.start, bridge.start);
      previous.end = Math.max(previous.end, bridge.end);
    } else groups.push({ ...bridge, firstLine: bridge.line, lastLine: bridge.line });
  }
  const exterior = new Set(regions.filter(region => region.exterior).map(region => region.id));
  const probe = (x, y, dx, dy) => {
    for (let distance = 1; distance <= Math.max(4, Math.round(edge * 0.035)); distance += 1) {
      const px = Math.floor(x + dx * distance), py = Math.floor(y + dy * distance);
      if (px < 0 || py < 0 || px >= width || py >= height) return 0;
      const label = labels[py * width + px];
      if (label) return label;
    }
    return 0;
  };
  const openings = [];
  for (const group of groups) {
    if (group.end - group.start < Math.max(4, (group.lastLine - group.firstLine + 1) * 1.5)) continue;
    const normal = (group.firstLine + group.lastLine + 1) / 2, tangent = (group.start + group.end) / 2;
    const x = group.vertical ? normal : tangent, y = group.vertical ? tangent : normal;
    const first = probe(x, y, group.vertical ? -1 : 0, group.vertical ? 0 : -1);
    const second = probe(x, y, group.vertical ? 1 : 0, group.vertical ? 0 : 1);
    const ids = [...new Set([roomIds.get(first), roomIds.get(second)].filter(Boolean))];
    if (first === second || !ids.length) continue;
    if (ids.length === 1 && !exterior.has(first) && !exterior.has(second)) continue;
    openings.push({
      start: group.vertical ? { x: normal, y: group.start } : { x: group.start, y: normal },
      end: group.vertical ? { x: normal, y: group.end } : { x: group.end, y: normal },
      roomIds: ids,
    });
  }
  return openings;
}

/**
 * Local printed-plan recognition, not semantic/physical-scale inference.
 * Input: RGBA Uint8ClampedArray, positive integer dimensions, maximum 1000px edge.
 * threshold: explicit 0..255 cutoff; omitted tries 130/150/170/190 and retains
 * the greatest valid enclosed interior area, including lighter window frames.
 * gapClosing: 0..0.12 of the longest image edge, default 0.06; 0 disables repair.
 * Only supported horizontal/vertical gaps are repaired. Diagonal walls may be
 * traced, but their gaps are not repaired. Openings are candidates, not door types.
 * Isolated small ink is discarded; connected furniture can affect an outline.
 * Returned simple polygons follow inner pixel boundaries (up to 3px at 1000px),
 * contain no holes, have at most 128 vertices, and use deterministic scan-order IDs.
 */
export function recognizeFloorplan({ width, height, data }, options = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || Math.max(width, height) > 1000 || !(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
    throw new TypeError('Expected an RGBA image with a maximum 1000px edge');
  }
  if (options.threshold === undefined) {
    let best, bestArea = -1;
    for (const threshold of [130, 150, 170, 190]) {
      const result = recognizeFloorplan({ width, height, data }, { ...options, threshold });
      const area = result.rooms.reduce((sum, room) => sum + room.area, 0);
      if (area > bestArea) { best = result; bestArea = area; }
    }
    return best;
  }
  const { threshold, gapClosing = 0.06 } = options;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255
    || !Number.isFinite(gapClosing) || gapClosing < 0 || gapClosing > 0.12) {
    throw new RangeError('threshold must be 0..255 and gapClosing must be 0..0.12');
  }
  const edge = Math.max(width, height), maxGapPixels = Math.round(edge * gapClosing);
  const result = { rooms: [], openings: [], width, height, threshold, gapClosing, maxGapPixels,
    wallPixels: 0, repairedPixels: 0, rejectedRegions: 0, reason: 'no-wall-evidence' };
  if (Math.min(width, height) < 16) return result;
  const dark = new Uint8Array(width * height);
  for (let i = 0; i < dark.length; i += 1) {
    const offset = i * 4, alpha = data[offset + 3] / 255;
    const luminance = (data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722) * alpha + 255 * (1 - alpha);
    dark[i] = luminance < threshold ? 1 : 0;
  }
  const { mask, minRun } = wallEvidence(dark, width, height, edge);
  result.wallPixels = mask.reduce((sum, value) => sum + value, 0);
  if (!result.wallPixels) return result;
  const { repaired, bridges } = repairGaps(mask, width, height, minRun, maxGapPixels);
  result.repairedPixels = repaired.reduce((sum, value, i) => sum + (value && !mask[i] ? 1 : 0), 0);
  const { labels, regions } = components(repaired, width, height, 0);
  const roomIds = new Map();
  for (const region of regions) {
    if (region.exterior) continue;
    if (region.count < Math.max(36, width * height * 0.004)
      || Math.min(region.right - region.left + 1, region.bottom - region.top + 1) < Math.max(5, edge * 0.025)) {
      result.rejectedRegions += 1; continue;
    }
    const points = roomOutline(outerContour(labels, region, width), edge);
    if (!points) { result.rejectedRegions += 1; continue; }
    const id = `room-${result.rooms.length + 1}`;
    result.rooms.push({ id, points, area: areaOf(points) }); roomIds.set(region.id, id);
  }
  result.openings = openingCandidates(bridges, labels, regions, roomIds, width, height, edge);
  result.reason = result.rooms.length ? 'rooms-detected' : 'no-closed-rooms';
  return result;
}
