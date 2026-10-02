import { pointInPolygon } from '../../src/space-geometry.js';
import { demoLayoutById } from '../../src/demo-layouts.js';

export function raster(width, height, color = [255, 255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set(color, i * 4);
  return { width, height, data };
}

export function fillRect(image, left, top, right, bottom, color = [255, 255, 255, 255]) {
  for (let y = Math.max(0, Math.floor(top)); y < Math.min(image.height, Math.ceil(bottom)); y += 1) {
    for (let x = Math.max(0, Math.floor(left)); x < Math.min(image.width, Math.ceil(right)); x += 1) {
      image.data.set(color, (y * image.width + x) * 4);
    }
  }
}

export function fillPolygon(image, points, color) {
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (pointInPolygon({ x: x + 0.5, y: y + 0.5 }, points)) image.data.set(color, (y * image.width + x) * 4);
    }
  }
}

export function stroke(image, coordinates, thickness = 4, color = [25, 25, 25, 255], closed = false) {
  const points = coordinates.map(([x, y]) => ({ x, y }));
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i += 1) {
    const a = points[i], b = points[(i + 1) % points.length], dx = b.x - a.x, dy = b.y - a.y;
    for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y) - thickness)); y < Math.min(image.height, Math.ceil(Math.max(a.y, b.y) + thickness)); y += 1) {
      for (let x = Math.max(0, Math.floor(Math.min(a.x, b.x) - thickness)); x < Math.min(image.width, Math.ceil(Math.max(a.x, b.x) + thickness)); x += 1) {
        const t = Math.max(0, Math.min(1, ((x + 0.5 - a.x) * dx + (y + 0.5 - a.y) * dy) / (dx * dx + dy * dy)));
        if (Math.hypot(x + 0.5 - a.x - t * dx, y + 0.5 - a.y - t * dy) <= thickness / 2) {
          image.data.set(color, (y * image.width + x) * 4);
        }
      }
    }
  }
}

export function twoRooms({ scale = 1, thickness = 4, gaps = true, noise = true } = {}) {
  const image = raster(240 * scale, 160 * scale);
  const coordinates = points => points.map(([x, y]) => [x * scale, y * scale]);
  fillRect(image, 20 * scale, 20 * scale, 120 * scale, 140 * scale, [232, 221, 201, 255]);
  fillRect(image, 120 * scale, 20 * scale, 220 * scale, 140 * scale, [206, 225, 237, 255]);
  stroke(image, coordinates([[20, 20], [220, 20], [220, 140], [20, 140]]), thickness * scale, undefined, true);
  stroke(image, coordinates([[120, 20], [120, 140]]), thickness * scale);
  if (gaps) {
    fillRect(image, (120 - thickness / 2) * scale, 75 * scale, (120 + thickness / 2) * scale, 88 * scale);
    fillRect(image, 45 * scale, (20 - thickness / 2) * scale, 58 * scale, (20 + thickness / 2) * scale);
    // A door leaf is attached ink, not another room or a synthetic opening.
    stroke(image, coordinates([[120, 75], [131, 75]]), scale);
  }
  if (noise) {
    for (const x of [48, 54, 60, 155, 161, 167]) {
      stroke(image, coordinates([[x, 50], [x, 55], [x + 3, 55]]), scale);
    }
    stroke(image, coordinates([[42, 95], [70, 95], [70, 123], [42, 123]]), scale, [80, 80, 80, 255], true);
    stroke(image, coordinates([[155, 97], [182, 97], [182, 121], [155, 121]]), scale, [80, 80, 80, 255], true);
  }
  return image;
}

// Generated printed-plan adaptation, not a scan or exact construction plan.
// Geometry/door positions: canonical LH Yangju Hoecheon A18 74A fixture,
// sourced in src/demo-layouts.js from https://www.data.go.kr/data/15037046/fileData.do.
// Includes eight uneven rooms, the stepped exterior, labels, dark thin furniture,
// an exterior entrance gap, and seven interior door gaps. No runtime image dependency.
export function apartmentPlan(scale = 1) {
  const layout = demoLayoutById('lh-hoecheon-a18-74a');
  const ratio = 0.48 * scale, margin = 20 * scale;
  const image = raster(Math.round(710 * scale), Math.round(365 * scale));
  const convert = (x, y) => [margin + x * ratio, margin + y * ratio];
  for (const zone of layout.zones) {
    const [x, y] = convert(zone.x, zone.y), [right, bottom] = convert(zone.x + zone.width, zone.y + zone.depth);
    const color = zone.color.match(/\w\w/g).map(value => parseInt(value, 16));
    fillRect(image, x, y, right, bottom, [...color, 255]);
  }
  for (const zone of layout.zones) {
    stroke(image, [
      convert(zone.x, zone.y), convert(zone.x + zone.width, zone.y),
      convert(zone.x + zone.width, zone.y + zone.depth), convert(zone.x, zone.y + zone.depth),
    ], 5 * scale, undefined, true);
    const [x, y] = convert(zone.x + zone.width / 2 - 20, zone.y + zone.depth / 2 - 10);
    for (let i = 0; i < 4; i += 1) stroke(image, [[x + i * 5 * scale, y], [x + i * 5 * scale, y + 4 * scale], [x + (i * 5 + 2) * scale, y + 4 * scale]], scale);
  }
  for (const item of layout.items) {
    const [left, top] = convert(item.x - item.width / 2, item.y - item.depth / 2);
    const [right, bottom] = convert(item.x + item.width / 2, item.y + item.depth / 2);
    stroke(image, [[left, top], [right, top], [right, bottom], [left, bottom]], scale, [85, 85, 85, 255], true);
  }
  const doorCenters = [];
  for (const door of layout.structures.filter(structure => structure.type === 'door')) {
    const [x, y] = convert(door.x, door.y), half = door.width * ratio / 2;
    const vertical = door.orientation === 'vertical';
    fillRect(image, x - (vertical ? 3 * scale : half), y - (vertical ? half : 3 * scale),
      x + (vertical ? 3 * scale : half), y + (vertical ? half : 3 * scale));
    doorCenters.push({ x, y, exterior: Boolean(door.exterior) });
  }
  return { image, doorCenters, source: layout.source };
}
