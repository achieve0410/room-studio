import { getLayoutBounds } from './geometry.js';

const REPORT_SUFFIX = 'decision-report';
const DEFAULT_ZONE_COLOR = '#d9d2c2';
const DEFAULT_ITEM_COLOR = '#d8b596';

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(value)) ? value : fallback;
const centimeters = (value) => Math.round(number(value));
const compactLabel = (value, maximum) => {
  const label = String(value ?? '');
  return label.length > maximum ? `${label.slice(0, maximum - 1)}…` : label;
};

export function decisionReportFileName(projectName) {
  const safeName = String(projectName ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80) || '내-집-도면';
  return `room-studio-${safeName}-${REPORT_SUFFIX}.html`;
}

function zoneMarkup(zone) {
  const x = number(zone.x);
  const y = number(zone.y);
  const width = Math.max(1, number(zone.width, 1));
  const depth = Math.max(1, number(zone.depth, 1));
  return `<g class="zone">
    <rect x="${x}" y="${y}" width="${width}" height="${depth}" fill="${color(zone.color, DEFAULT_ZONE_COLOR)}" />
    <text x="${x + 12}" y="${y + 24}">${escapeHtml(zone.name || zone.type || '공간')}</text>
  </g>`;
}

function itemShape(item) {
  const width = Math.max(1, number(item.width, 1));
  const depth = Math.max(1, number(item.depth, 1));
  const x = number(item.x);
  const y = number(item.y);
  const fill = color(item.color, DEFAULT_ITEM_COLOR);
  if (item.shape === 'circle' || item.shape === 'ellipse') {
    return `<ellipse cx="${x}" cy="${y}" rx="${width / 2}" ry="${depth / 2}" fill="${fill}" />`;
  }
  const radius = item.shape === 'roundRect' ? Math.min(18, width / 6, depth / 6) : 2;
  return `<rect x="${x - width / 2}" y="${y - depth / 2}" width="${width}" height="${depth}" rx="${radius}" fill="${fill}" />`;
}

function itemMarkup(item) {
  const width = Math.max(1, number(item.width, 1));
  const x = number(item.x);
  const y = number(item.y);
  const rotation = number(item.rotation);
  const label = compactLabel(item.name || '가구', Math.max(4, Math.floor(width / 12)));
  return `<g class="item" transform="rotate(${rotation} ${x} ${y})">
    ${itemShape(item)}
    <text x="${x}" y="${y + 4}" text-anchor="middle">${escapeHtml(label)}</text>
  </g>`;
}

function structureMarkup(structure) {
  const x = number(structure.x);
  const y = number(structure.y);
  const length = Math.max(1, number(structure.length ?? structure.width, 1));
  const horizontal = structure.orientation !== 'vertical';
  const x1 = horizontal ? x - length / 2 : x;
  const x2 = horizontal ? x + length / 2 : x;
  const y1 = horizontal ? y : y - length / 2;
  const y2 = horizontal ? y : y + length / 2;
  const kind = structure.type === 'wall' ? 'wall' : 'opening';
  return `<g class="structure ${kind}">
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />
    <text x="${x + 8}" y="${y - 8}">${escapeHtml(structure.name || structure.type || '구조')}</text>
  </g>`;
}

function planMarkup(layout) {
  const zones = Array.isArray(layout.zones) ? layout.zones : [];
  const items = Array.isArray(layout.items) ? layout.items : [];
  const structures = Array.isArray(layout.structures) ? layout.structures : [];
  const empty = !zones.length && !items.length && !structures.length;
  const bounds = getLayoutBounds(zones);
  const padding = 40;
  const viewBox = empty
    ? '0 0 800 500'
    : `${bounds.left - padding} ${bounds.top - padding} ${bounds.width + padding * 2} ${bounds.depth + padding * 2}`;
  return `<svg role="img" aria-label="Room Studio 2D 배치 도면" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">
    <rect class="paper" x="${empty ? 0 : bounds.left - padding}" y="${empty ? 0 : bounds.top - padding}" width="${empty ? 800 : bounds.width + padding * 2}" height="${empty ? 500 : bounds.depth + padding * 2}" />
    ${zones.map(zoneMarkup).join('')}
    ${structures.map(structureMarkup).join('')}
    ${items.map(itemMarkup).join('')}
  </svg>`;
}

function warningMarkup(warningCounts) {
  const entries = [
    ['충돌', warningCounts.collisions],
    ['집 밖 배치', warningCounts.outOfBounds],
    ['높이 초과', warningCounts.height],
    ['공간 중복', warningCounts.zoneOverlaps],
  ].filter(([, count]) => number(count) > 0);
  if (!entries.length) return '<p class="ok">배치 경고 없음</p>';
  return `<ul class="warnings">${entries.map(([label, count]) => `<li><strong>${label} ${centimeters(count)}</strong></li>`).join('')}</ul>`;
}

function furnitureMarkup(items) {
  if (!items.length) return '<p class="empty">등록된 가구가 없습니다.</p>';
  return `<table><thead><tr><th>가구</th><th>크기</th><th>위치</th></tr></thead><tbody>${items.map((item) => `<tr>
    <td>${escapeHtml(item.name || '가구')}</td>
    <td>${centimeters(item.width)} × ${centimeters(item.depth)} × ${centimeters(item.height)}cm</td>
    <td>X ${centimeters(item.x)} · Y ${centimeters(item.y)} · ${centimeters(item.rotation)}°</td>
  </tr>`).join('')}</tbody></table>`;
}

export function createDecisionReport({
  projectName,
  layout,
  metrics,
  generatedAt = new Date().toISOString(),
}) {
  const title = escapeHtml(String(projectName ?? '').trim() || '내 집 도면');
  const items = Array.isArray(layout?.items) ? layout.items : [];
  const area = number(metrics?.areaSquareMeters).toFixed(1);
  const coverage = centimeters(metrics?.coveragePercent);
  const warnings = metrics?.warningCounts ?? {};
  const generated = new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(generatedAt));

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Room Studio 의사결정 리포트</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#eee9df;color:#292b29;font:15px/1.55 system-ui,sans-serif}main{max-width:1080px;margin:auto;padding:40px}header,.card{background:#fffdf8;border:1px solid #d6cfc2;border-radius:16px;padding:24px;margin-bottom:18px}header{border-top:6px solid #d87943}h1{margin:4px 0;font-size:30px}.eyebrow{color:#a6532e;font-size:12px;font-weight:800;letter-spacing:.12em}.meta{color:#6e716d}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.metric{background:#f6f2e9;border-radius:12px;padding:16px}.metric strong{display:block;font-size:24px}svg{display:block;width:100%;max-height:560px;background:#faf8f2;border:1px solid #ded8cc}.paper{fill:#faf8f2}.zone rect{stroke:#6d706b;stroke-width:2}.zone text,.structure text{font-size:14px;fill:#353734}.item>*:first-child{stroke:#424642;stroke-width:2}.item text{font-size:12px;fill:#202220}.structure line{stroke:#3b3e3b;stroke-width:8}.structure.opening line{stroke:#d87943;stroke-width:6;stroke-dasharray:14 8}.structure text{font-size:12px}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #e1ddd4;padding:10px}.warnings{color:#9a3528}.ok{color:#49634d;font-weight:700}.notice{border-left:4px solid #d87943;padding-left:14px}@media print{body{background:#fff}main{max-width:none;padding:0}.card,header{break-inside:avoid}}@media(max-width:700px){main{padding:16px}.metrics{grid-template-columns:1fr}table{font-size:12px}}
</style></head><body><main>
<header><span class="eyebrow">ROOM STUDIO · DECISION REPORT</span><h1>${title}</h1><p class="meta">${escapeHtml(generated)} 생성</p></header>
<section class="card"><h2>한눈에 보는 배치</h2><div class="metrics">
  <div class="metric"><span>집 면적</span><strong>${area}m²</strong></div>
  <div class="metric"><span>바닥 점유</span><strong>${coverage}%</strong></div>
  <div class="metric"><span>가구 수</span><strong>${items.length}개</strong></div>
</div></section>
<section class="card"><h2>2D 배치 도면</h2>${planMarkup(layout ?? {})}</section>
<section class="card"><h2>배치 확인</h2>${warningMarkup(warnings)}</section>
<section class="card"><h2>가구 목록</h2>${furnitureMarkup(items)}</section>
<section class="card notice"><h2>사용 범위</h2><p>이 문서는 기획·배치 확인을 돕는 시각화 자료입니다. 건축 인허가·구조·접근성·시공 판단은 관련 전문가의 검토가 필요합니다.</p></section>
</main></body></html>`;
}
