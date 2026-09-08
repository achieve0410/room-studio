import {
  getExteriorWallSegments, getInteriorWallSegments, doorsForAutomaticWallSegment,
  splitWallSegment, structureSegment, structureBounds, getDoorLeafSegments,
  itemBounds, zoneBounds, spaceIdOf, calculateUnionArea, pointInZone, meters,
} from './geometry.js';
import { formatMeasurement } from './layout-tools.js';

const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(value)) ? value : fallback;
let sequence = 0;

const line = (x1, y1, x2, y2, attributes = '') => `<line ${attributes} x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
const wallLine = (segment) => segment.orientation === 'horizontal'
  ? line(segment.x1, segment.y, segment.x2, segment.y)
  : line(segment.x, segment.y1, segment.x, segment.y2);

// Static editor symbols: leaf positions come from the same geometry as 3D/collision.
function openingSymbol(opening) {
  const half = opening.width / 2;
  const isWindow = opening.type === 'window';
  const sliding = isWindow || opening.doorType === 'sliding';
  const leaves = getDoorLeafSegments([{ ...opening, type: 'door', doorType: sliding ? 'sliding' : 'swing', x: 0, y: 0, orientation: 'horizontal' }]);
  let symbol;
  if (sliding) {
    const kind = isWindow ? 'window' : 'door';
    const offset = isWindow ? 4 : 5;
    symbol = leaves.map(({ start, end }, index) => line(start.x, index ? offset : -offset, end.x, index ? offset : -offset,
      `class="${kind}-panel ${kind}-panel-${index ? 'moving' : 'fixed'}"`)).join('');
    if (isWindow) {
      symbol = `<rect class="window-frame" x="${-half}" y="-8" width="${opening.width}" height="16" rx="2" />${symbol}`;
    } else {
      const direction = opening.slideDirection === 'start' ? -1 : 1;
      const center = (leaves[1].start.x + leaves[1].end.x) / 2;
      const start = center - direction * Math.min(opening.width / 6, 18);
      const end = center + direction * Math.min(opening.width / 6, 18);
      const head = end - direction * 8;
      symbol += `<path class="door-direction" d="M ${start} 15 L ${end} 15 M ${head} 9 L ${end} 15 L ${head} 21" />`;
    }
  } else {
    const { start, end } = leaves[0];
    symbol = line(start.x, start.y, end.x, end.y, 'class="door-panel"');
    if (Number(opening.openAngle) > 0) {
      const sweep = (opening.hinge === 'start') === (Number(opening.openSide) === 1) ? 1 : 0;
      symbol += `<path class="door-swing" d="M ${-start.x} 0 A ${opening.width} ${opening.width} 0 0 ${sweep} ${end.x} ${end.y}" />`;
    }
  }
  const labelY = isWindow ? -15 : sliding ? 22 : Number(opening.openSide) === 1 ? -18 : 18;
  return `<g class="plan-${isWindow ? 'window' : 'door'}" data-structure-id="${escapeHtml(opening.id)}" transform="translate(${opening.x} ${opening.y}) rotate(${opening.orientation === 'vertical' ? 90 : 0})"><title>${escapeHtml(opening.name)}</title>${symbol}<text x="0" y="${labelY}" font-size="10" text-anchor="middle">${isWindow ? '창' : sliding ? '미닫이' : '여닫이'}</text></g>`;
}

/** Browser-free static plan; accepts the editor's normalized, centimeter-based layout. */
export function renderPlanSvg(layout, { label = 'Room Studio 2D 배치 도면', idPrefix = 'plan' } = {}) {
  const { zones = [], items = [], structures = [], dimensions = [], backgroundPlan } = layout;
  const id = `plan-${String(idPrefix).replace(/[^a-z0-9_-]/gi, '-')}-${++sequence}`;
  const bounds = [];
  const text = (value, x, y, size = 12, anchor = 'start', className = '') => {
    // Conservative glyph bounds include full untruncated labels, even outside rooms.
    const width = String(value).length * size * 1.2;
    const left = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
    bounds.push({ left, right: left + width, top: y - size * 1.5, bottom: y + size / 2 });
    return `<text class="${className}" x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}">${escapeHtml(value)}</text>`;
  };
  const safeBackground = backgroundPlan && /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(backgroundPlan.dataUrl);
  let background = '';
  if (safeBackground) {
    bounds.push(zoneBounds(backgroundPlan));
    background = `<image href="${backgroundPlan.dataUrl}" x="${backgroundPlan.x}" y="${backgroundPlan.y}" width="${backgroundPlan.width}" height="${backgroundPlan.depth}" opacity="${backgroundPlan.opacity}" preserveAspectRatio="none"><title>${escapeHtml(backgroundPlan.name)}</title></image>`;
  }
  const spaces = new Map();
  for (const zone of zones) {
    const key = spaceIdOf(zone);
    if (!spaces.has(key)) spaces.set(key, []);
    spaces.get(key).push(zone);
  }
  const roomLabels = [];
  const rooms = zones.map((zone) => {
    bounds.push(zoneBounds(zone));
    const parts = spaces.get(spaceIdOf(zone));
    const largest = parts.reduce((a, b) => b.width * b.depth > a.width * a.depth ? b : a);
    if (largest === zone) {
      const nearby = items.filter((item) => pointInZone(item, zone));
      const candidates = [
        { x: zone.x + 12, y: zone.y + 22, anchor: 'start' },
        { x: zone.x + zone.width - 12, y: zone.y + 22, anchor: 'end' },
        { x: zone.x + 12, y: zone.y + zone.depth - 28, anchor: 'start' },
        { x: zone.x + zone.width - 12, y: zone.y + zone.depth - 28, anchor: 'end' },
      ];
      const position = candidates.reduce((best, candidate) => {
        const clearance = Math.min(...nearby.map((item) => Math.hypot(candidate.x - item.x, candidate.y - item.y)), 10000);
        return clearance > best.clearance ? { ...candidate, clearance } : best;
      }, { ...candidates[0], clearance: -1 });
      const size = parts.length > 1
        ? `${parts.length}조각 · ${(calculateUnionArea(parts) / 10000).toFixed(1)}m² · H ${zone.height ?? 240}cm`
        : `${meters(zone.width)} × ${meters(zone.depth)} · H ${zone.height ?? 240}cm`;
      roomLabels.push(text(zone.name, position.x, position.y, 16, position.anchor), text(size, position.x, position.y + 16, 10, position.anchor));
    }
    return `<rect data-zone-id="${escapeHtml(zone.id)}" x="${zone.x}" y="${zone.y}" width="${zone.width}" height="${zone.depth}" fill="${color(zone.color, '#d9d2c2')}" />`;
  }).join('');
  const walls = structures.filter(({ type }) => type === 'wall');
  const openings = structures.filter(({ type }) => type === 'door' || type === 'window');
  const automaticWalls = [...getExteriorWallSegments(zones), ...getInteriorWallSegments(zones)]
    .flatMap((segment) => splitWallSegment(segment, doorsForAutomaticWallSegment(segment, openings, walls)).spans).map(wallLine).join('');
  const explicitWalls = walls.map((wall) => {
    bounds.push(structureBounds(wall));
    const spans = splitWallSegment(structureSegment(wall), openings.filter(({ wallId }) => wallId === wall.id)).spans;
    return `<g data-structure-id="${escapeHtml(wall.id)}"><title>${escapeHtml(wall.name)}</title>${spans.map(wallLine).join('')}${text(`${wall.name ?? '벽'} · ${Math.round(wall.length)}cm`, wall.x, wall.y - 10, 12, 'middle')}</g>`;
  }).join('');
  const symbols = openings.map((opening) => {
    // Full hinge-centered sweep envelope includes arc extrema at any saved angle.
    const radius = opening.width * 1.5 + 24;
    bounds.push({ left: opening.x - radius, right: opening.x + radius, top: opening.y - radius, bottom: opening.y + radius });
    return openingSymbol(opening);
  }).join('');
  const furniture = items.map((item) => {
    bounds.push(itemBounds(item));
    const shape = item.shape === 'circle' || item.shape === 'ellipse'
      ? `<ellipse cx="0" cy="0" rx="${item.width / 2}" ry="${item.depth / 2}" />`
      : `<rect x="${-item.width / 2}" y="${-item.depth / 2}" width="${item.width}" height="${item.depth}" rx="${item.shape === 'roundRect' ? Math.min(item.width, item.depth) * 0.18 : 4}" />`;
    return `<g class="plan-item" data-item-id="${escapeHtml(item.id)}"><g transform="translate(${item.x} ${item.y}) rotate(${item.rotation ?? 0})" fill="${color(item.color, '#d8b596')}">${shape}</g>${text(item.name, item.x, item.y - 3, 12, 'middle')}${text(`H ${item.height}cm${item.elevation ? ` · Z ${item.elevation}cm` : ''}`, item.x, item.y + 15, 10, 'middle')}</g>`;
  }).join('');
  const measurements = dimensions.map((dimension) => {
    const { x1, y1, x2, y2 } = dimension;
    bounds.push({ left: Math.min(x1, x2) - 7, right: Math.max(x1, x2) + 7, top: Math.min(y1, y2) - 7, bottom: Math.max(y1, y2) + 7 });
    const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI + 90;
    return `<g class="plan-dimension" data-dimension-id="${escapeHtml(dimension.id)}"><title>${escapeHtml(dimension.name)}</title>${line(x1, y1, x2, y2, 'class="dimension-line"')}${[[x1, y1], [x2, y2]].map(([x, y]) => line(-7, 0, 7, 0, `class="dimension-tick" transform="translate(${x} ${y}) rotate(${angle})"`)).join('')}${text(formatMeasurement(Math.hypot(x2 - x1, y2 - y1)), (x1 + x2) / 2, (y1 + y2) / 2 - 9, 12, 'middle')}</g>`;
  }).join('');
  const left = Math.min(...bounds.map((b) => b.left)) - 40;
  const top = Math.min(...bounds.map((b) => b.top)) - 40;
  const right = Math.max(...bounds.map((b) => b.right)) + 40;
  const bottom = Math.max(...bounds.map((b) => b.bottom)) + 40;
  const viewBox = bounds.length ? `${left} ${top} ${right - left} ${bottom - top}` : '0 0 800 500';
  return `<svg id="${id}" role="img" aria-label="${escapeHtml(label)}" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg"><style>
    #${id}{background:#faf8f2;font-family:system-ui,sans-serif}#${id} text{fill:#353734;stroke:none}#${id} .structural-walls{fill:none;stroke:#363732;stroke-width:2}#${id} .plan-item rect,#${id} .plan-item ellipse{stroke:#424642;stroke-width:2}#${id} .door-panel,#${id} .door-swing,#${id} .door-direction{fill:none;stroke:#956240;stroke-width:2}#${id} .door-swing{stroke-dasharray:5 3}#${id} .window-frame{fill:#b7ddea;fill-opacity:.58;stroke:#477d92;stroke-width:2}#${id} .window-panel{stroke:#477d92;stroke-width:2}#${id} .plan-dimension line{stroke:#725a44;stroke-width:1.5}
  </style>${background}${rooms}<g class="structural-walls">${automaticWalls}${explicitWalls}</g>${roomLabels.join('')}${furniture}${symbols}${measurements}</svg>`;
}
