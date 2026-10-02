import { zoneFromPoints, polygonUnionArea } from './space-geometry.js';
import { getExteriorWallSegments, snapDoorToWallSegments } from './geometry.js';

const unitInCm = { mm: 0.1, cm: 1, m: 100 };
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

export function floorplanScale(reference) {
  const length = Number(reference?.length) * unitInCm[reference?.unit];
  const pixels = reference?.start && reference?.end ? distance(reference.start, reference.end) : 0;
  if (!Number.isFinite(length) || length <= 0 || length > 10000 || !Number.isFinite(pixels) || pixels < 5) {
    throw new RangeError('기준선의 두 점과 실제 길이·단위를 확인해주세요.');
  }
  return length / pixels;
}

export function longestRoomEdge(room) {
  return room.points.reduce((longest, start, index) => {
    const end = room.points[(index + 1) % room.points.length];
    return !longest || distance(start, end) > distance(longest.start, longest.end)
      ? { start: { ...start }, end: { ...end }, edgeIndex: index }
      : longest;
  }, null);
}

export function createFloorplanLayout({ rooms, image, reference, openings = [] }) {
  const included = rooms.filter(room => room.included !== false);
  if (!included.length) throw new RangeError('가져올 공간을 하나 이상 선택해주세요.');
  const scale = floorplanScale(reference);
  const points = included.flatMap(room => room.points);
  const left = Math.min(...points.map(point => point.x));
  const top = Math.min(...points.map(point => point.y));
  if (!Number.isFinite(image.width) || !Number.isFinite(image.height)
    || image.width <= 0 || image.height <= 0
    || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.y < 0 || point.x > image.width || point.y > image.height)) {
    throw new RangeError('공간 윤곽을 이미지 안에 맞춰주세요.');
  }
  const backgroundPlan = {
    dataUrl: image.dataUrl, name: image.name,
    x: -left * scale, y: -top * scale,
    width: image.width * scale, depth: image.height * scale,
    opacity: 0.45, locked: true,
  };
  if (backgroundPlan.width < 20 || backgroundPlan.depth < 20
    || backgroundPlan.width > 10000 || backgroundPlan.depth > 10000
    || backgroundPlan.x < -5000 || backgroundPlan.y < -5000) {
    throw new RangeError('도면 크기가 편집 범위를 벗어납니다. 실제 길이와 단위를 확인해주세요.');
  }
  const zones = included.map((room, index) => zoneFromPoints({
    id: `import-space-${index + 1}`, spaceId: `import-space-${index + 1}`,
    name: room.name?.trim() || `공간 ${index + 1}`,
    type: room.type || '기타', height: 240, color: '#d9d2c2',
    walkthroughStart: index === 0, locked: false,
  }, room.points.map(point => ({ x: (point.x - left) * scale, y: (point.y - top) * scale }))));
  if (zones.some(zone => zone.width < 20 || zone.depth < 20 || zone.x > 5000 || zone.y > 5000)) {
    throw new RangeError('너무 작거나 먼 공간이 있습니다. 윤곽과 기준 길이를 확인해주세요.');
  }
  const targets = new Map(included.map((room, index) => [room.id, getExteriorWallSegments([zones[index]])]));
  const structures = openings.filter(opening => opening.included && opening.roomIds.some(id => targets.has(id)))
    .map((opening, index) => {
      const width = distance(opening.start, opening.end) * scale;
      const orientation = Math.abs(opening.end.x - opening.start.x) >= Math.abs(opening.end.y - opening.start.y) ? 'horizontal' : 'vertical';
      const door = {
        id: `import-door-${index + 1}`, name: `도면 문 후보 ${index + 1}`, type: 'door', orientation,
        x: ((opening.start.x + opening.end.x) / 2 - left) * scale,
        y: ((opening.start.y + opening.end.y) / 2 - top) * scale,
        width, height: 205, doorType: 'swing', hinge: 'start', openSide: -1,
        openAngle: 90, wallId: null, locked: false,
      };
      if (width < 50 || width > 300 || opening.roomIds.filter(id => targets.has(id)).some(id =>
        !snapDoorToWallSegments(door, targets.get(id).filter(target => target.orientation === orientation), 12))) {
        throw new RangeError('문 후보의 폭·벽 위치를 확인해주세요. 맞지 않는 후보는 제외하고 3D에서 추가할 수 있습니다.');
      }
      return door;
    });
  return {
    zones, items: [], structures,
    dimensions: [{
      id: 'import-reference',
      x1: (reference.start.x - left) * scale, y1: (reference.start.y - top) * scale,
      x2: (reference.end.x - left) * scale, y2: (reference.end.y - top) * scale,
      name: '확인한 기준 길이', locked: true,
    }],
    backgroundPlan, wallHeight: 240,
  };
}

export function floorplanSummary(layout) {
  return {
    rooms: layout.zones.length,
    area: polygonUnionArea(layout.zones) / 10000,
    width: Math.max(...layout.zones.map(zone => zone.x + zone.width)),
    depth: Math.max(...layout.zones.map(zone => zone.y + zone.depth)),
  };
}

// Map a unit square into a photographed planar quadrilateral. The UI supplies
// clockwise top-left, top-right, bottom-right and bottom-left image coordinates.
export function rectifyFloorplan({ width, height, data }, corners) {
  if (!Array.isArray(corners) || corners.length !== 4
    || corners.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.y < 0 || point.x > width - 1 || point.y > height - 1)) {
    throw new RangeError('사진 안에서 네 모서리를 지정해주세요.');
  }
  const turns = corners.map((a, index) => {
    const b = corners[(index + 1) % 4], c = corners[(index + 2) % 4];
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  });
  if (turns.some(turn => turn <= 1)) throw new RangeError('네 모서리가 겹치지 않도록 시계 방향으로 지정해주세요.');
  const [a, b, c, d] = corners;
  const outWidth = Math.round(Math.max(distance(a, b), distance(d, c)));
  const outHeight = Math.round(Math.max(distance(a, d), distance(b, c)));
  if (outWidth < 32 || outHeight < 32) throw new RangeError('도면 영역을 더 크게 지정해주세요.');
  const dx1 = b.x - c.x, dx2 = d.x - c.x, dx3 = a.x - b.x + c.x - d.x;
  const dy1 = b.y - c.y, dy2 = d.y - c.y, dy3 = a.y - b.y + c.y - d.y;
  const determinant = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / determinant;
  const h = (dx1 * dy3 - dx3 * dy1) / determinant;
  const output = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      const u = x / (outWidth - 1), v = y / (outHeight - 1);
      const divisor = g * u + h * v + 1;
      const sx = Math.max(0, Math.min(width - 1, ((b.x - a.x + g * b.x) * u + (d.x - a.x + h * d.x) * v + a.x) / divisor));
      const sy = Math.max(0, Math.min(height - 1, ((b.y - a.y + g * b.y) * u + (d.y - a.y + h * d.y) * v + a.y) / divisor));
      const x0 = Math.floor(sx), y0 = Math.floor(sy), tx = sx - x0, ty = sy - y0;
      const p00 = (y0 * width + x0) * 4;
      const p10 = (y0 * width + Math.min(width - 1, x0 + 1)) * 4;
      const p01 = (Math.min(height - 1, y0 + 1) * width + x0) * 4;
      const p11 = (Math.min(height - 1, y0 + 1) * width + Math.min(width - 1, x0 + 1)) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        output[(y * outWidth + x) * 4 + channel] = (data[p00 + channel] * (1 - tx) + data[p10 + channel] * tx) * (1 - ty)
          + (data[p01 + channel] * (1 - tx) + data[p11 + channel] * tx) * ty;
      }
    }
  }
  return { width: outWidth, height: outHeight, data: output };
}
