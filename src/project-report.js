import {
  calculateUnionArea, calculateCoverage, findCollisions, findOutOfBounds,
  findHeightViolations, findZoneOverlaps,
} from './geometry.js';
import { renderPlanSvg } from './plan-svg.js';
import { normalizeConsultation, geometryForOption } from './consultation.js';

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
const centimeters = (value) => Math.round(Number(value) || 0);
const MAX_PREVIEW_BASE64_LENGTH = 6_990_508; // At most 5 MiB decoded.
const RASTER_PREVIEW = /^data:image\/(jpeg|png|webp);base64,([a-z0-9+/]+={0,2})$/i;
const rasterSignatures = { jpeg: '/9j/', png: 'iVBORw0KGgo', webp: 'UklGR' };

function safePreview(value) {
  if (typeof value !== 'string' || value.length > MAX_PREVIEW_BASE64_LENGTH + 32) return null;
  const match = value.match(RASTER_PREVIEW);
  return match && match[2].startsWith(rasterSignatures[match[1].toLowerCase()]) ? value : null;
}

export function decisionReportFileName(projectName) {
  const safeName = String(projectName ?? '')
    .normalize('NFKC').trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, '-').replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '').slice(0, 80) || '내-집-도면';
  return `room-studio-${safeName}-decision-report.html`;
}

function warningMarkup(layout) {
  const { items = [], zones = [], wallHeight = 240 } = layout;
  const checks = [
    ['collisions', '충돌', findCollisions(items), items],
    ['outOfBounds', '집 밖 배치', findOutOfBounds(items, zones), items],
    ['height', '높이 초과', findHeightViolations(items, zones, wallHeight), items],
    ['zoneOverlaps', '공간 중복', findZoneOverlaps(zones), zones],
  ];
  const entries = checks.flatMap(([kind, label, ids, entities]) => entities.filter(({ id }) => ids.has(id)).map((entity) =>
    `<li data-warning-kind="${kind}" data-entity-id="${escapeHtml(entity.id)}"><strong>${label}</strong> · ${escapeHtml(entity.name || entity.id)} <small>위치 X ${centimeters(entity.x)} · Y ${centimeters(entity.y)}cm</small></li>`));
  return entries.length ? `<ul class="warnings">${entries.join('')}</ul>` : '<p class="ok">배치 경고 없음</p>';
}

function furnitureMarkup(items) {
  if (!items.length) return '<p class="empty">등록된 가구가 없습니다.</p>';
  return `<table><thead><tr><th>가구</th><th>크기</th><th>위치</th></tr></thead><tbody>${items.map((item) => `<tr>
    <td>${escapeHtml(item.name || '가구')}</td>
    <td>${centimeters(item.width)} × ${centimeters(item.depth)} × ${centimeters(item.height)}cm</td>
    <td>X ${centimeters(item.x)} · Y ${centimeters(item.y)} · ${centimeters(item.rotation)}° · Z ${centimeters(item.elevation)}cm</td>
  </tr>`).join('')}</tbody></table>`;
}

const noteMarkup = (value, heading, field) => String(value ?? '').trim()
  ? `<section class="card note" data-field="${field}"><h3>${heading}</h3><p class="notes">${escapeHtml(value)}</p></section>` : '';

function optionMarkup(key, layout, option, recommended, preview) {
  const { items = [], zones = [] } = layout;
  const optionTitle = option.label && option.label !== `${key}안` ? `${key}안 · ${option.label}` : `${key}안`;
  const area = (calculateUnionArea(zones) / 10000).toFixed(1);
  const coverage = calculateCoverage(items, zones);
  const scene = preview ? `<figure class="scene-card"><figcaption><span>실제 3D 배치 보기</span><strong>${escapeHtml(optionTitle)}</strong></figcaption><img src="${escapeHtml(preview)}" alt="${escapeHtml(optionTitle)} 가구 배치 3D 보기"></figure>` : '';
  return `<article data-option="${key}">
<header class="option-header"><div><span class="option-key">배치 ${key}</span><h2>${escapeHtml(optionTitle)}${recommended ? ' · 추천안' : ''}</h2></div></header>
${noteMarkup(option.recommendation, '추천 이유', 'recommendation')}
${scene}
<div class="plan-checks"><section class="card plan-card"><h3>${escapeHtml(optionTitle)} · 정확한 2D 치수</h3>${renderPlanSvg(layout, { label: optionTitle, idPrefix: `report-${key}` })}
<div class="metrics"><div><span>집 면적</span><strong data-metric="area">${area}m²</strong></div><div><span>바닥 점유 추정</span><strong data-metric="coverage">${coverage}%</strong></div><div><span>가구 수</span><strong data-metric="items">${items.length}개</strong></div></div>
<p class="meta">바닥에 놓인 가구의 외곽 크기로 계산한 점유 추정치입니다. 통행 폭과 설치 여유는 별도로 확인하세요.</p></section>
<section class="card checks"><h3>대상별 확인 사항</h3>${warningMarkup(layout)}</section></div>
<section class="card furniture"><h3>가구 목록</h3>${furnitureMarkup(items)}</section>
${noteMarkup(option.nextSteps, '수정 사항과 다음 단계', 'nextSteps')}
</article>`;
}

function comparisonMarkup(layouts) {
  if (layouts.length !== 2) return '';
  const [a, b] = layouts;
  const areaA = calculateUnionArea(a.zones ?? []) / 10000;
  const areaB = calculateUnionArea(b.zones ?? []) / 10000;
  const itemA = a.items?.length ?? 0;
  const itemB = b.items?.length ?? 0;
  const areaDifference = Math.round((areaB - areaA) * 10) / 10;
  const itemDifference = itemB - itemA;
  const signed = (value, unit) => `${value > 0 ? '+' : ''}${value}${unit}`;
  return `<section class="comparison-summary" aria-labelledby="comparison-summary-title"><div><span class="eyebrow">A/B COMPARISON</span><h2 id="comparison-summary-title">두 배치의 계산된 차이</h2></div><dl><div><dt>가구 수 · B−A</dt><dd data-comparison="items">${signed(itemDifference, '개')}</dd></div><div><dt>공간 면적 · B−A</dt><dd data-comparison="area">${signed(areaDifference, 'm²')}</dd></div></dl></section>`;
}

// Legacy metrics is still accepted by callers; layout is the source of truth.
export function createDecisionReport({ projectName, layout = {}, previews = {}, generatedAt = new Date().toISOString() }) {
  const title = escapeHtml(String(projectName ?? '').trim() || '내 집 도면');
  const source = { zones: [], items: [], structures: [], dimensions: [], backgroundPlan: null, wallHeight: 240, ...layout };
  const consultation = normalizeConsultation(source.consultation);
  const keys = consultation.inactiveGeometry ? ['A', 'B'] : ['A'];
  const layouts = keys.map((key) => geometryForOption(source, key));
  const generated = new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC',
  }).format(new Date(generatedAt));
  const options = keys.map((key, index) => optionMarkup(key, layouts[index], consultation.options[key], consultation.recommendedOption === key, safePreview(previews?.[key]))).join('');

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Room Studio 의사결정 리포트</title>
<style>
:root{--ink:#18201d;--muted:#5f6965;--line:#cbd2cf;--surface:#f7f8f6;--raised:#fff;--canvas:#dfe5e6;--accent:#c84f32;--success:#46705a;--error:#a33f32;--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s6:24px;--s8:32px;--radius:8px;--panel:12px;--text-body:14px;--text-caption:12px;--text-title:24px;--text-display:30px;--text-print:11px;--text-print-caption:10px;--report-width:1120px;--note-label:120px;--checks-width:220px;--scene-height:620px;--plan-height:560px;--print-scene-height:92mm;--print-plan-height:88mm;--font:'Avenir Next',Pretendard,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:var(--text-body)/1.55 var(--font)}main{max-width:var(--report-width);margin:auto;padding:var(--s8)}.report-header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--s4);padding:var(--s6);background:var(--ink);color:var(--surface);border-radius:var(--panel)}.report-header h1{grid-column:1/-1;margin:var(--s1) 0;font-size:var(--text-display);line-height:1.15;letter-spacing:-.03em}.report-header p{margin:0}.report-header .meta{color:var(--line)}.eyebrow,.option-key{color:var(--accent);font-size:var(--text-caption);font-weight:800;letter-spacing:.12em}.card,.comparison-summary,.scene-card{margin:var(--s4) 0;padding:var(--s6);border:1px solid var(--line);border-radius:var(--panel);background:var(--raised)}.note{display:grid;grid-template-columns:minmax(var(--note-label),1fr) 3fr;gap:var(--s6)}.note p{margin:0}.option-header{display:flex;align-items:end;justify-content:space-between;margin-top:var(--s8);padding:var(--s4) 0 var(--s3);border-bottom:2px solid var(--ink)}h1,h2,h3{overflow-wrap:anywhere}h2,h3{margin:0 0 var(--s3)}.option-header h2{margin:var(--s1) 0 0;font-size:var(--text-title)}.scene-card{padding:0;overflow:hidden;background:var(--ink)}.scene-card figcaption{display:flex;justify-content:space-between;gap:var(--s3);padding:var(--s3) var(--s4);color:var(--surface)}.scene-card figcaption span{color:var(--line)}.scene-card img{display:block;width:100%;max-height:var(--scene-height);object-fit:contain;background:var(--ink)}.plan-checks{display:grid;grid-template-columns:minmax(0,3fr) minmax(var(--checks-width),1fr);gap:var(--s4)}.plan-checks>.card{margin-top:0}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--s2);margin-top:var(--s4);padding-top:var(--s4);border-top:1px solid var(--line)}.metrics span{display:block;color:var(--muted);font-size:var(--text-caption)}.metrics strong{display:block;font-size:var(--text-title);font-variant-numeric:tabular-nums}.meta{color:var(--muted);font-size:var(--text-caption)}.plan-card svg{display:block;width:100%;max-height:var(--plan-height);background:var(--surface);border:1px solid var(--line)}.warnings{padding-left:var(--s4);color:var(--error)}.warnings li+li{margin-top:var(--s2)}.warnings small{display:block;color:var(--muted);font-variant-numeric:tabular-nums}.ok{color:var(--success);font-weight:700}.empty{color:var(--muted)}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid var(--line);padding:var(--s2);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.notes{white-space:pre-wrap;overflow-wrap:anywhere}.comparison-summary{display:grid;grid-template-columns:1fr 1fr;align-items:end;gap:var(--s6);margin-top:var(--s6)}.comparison-summary h2{margin:var(--s1) 0 0}.comparison-summary dl{display:grid;grid-template-columns:1fr 1fr;gap:var(--s3);margin:0}.comparison-summary dl div{padding-left:var(--s3);border-left:2px solid var(--accent)}.comparison-summary dt{color:var(--muted);font-size:var(--text-caption)}.comparison-summary dd{margin:0;font-size:var(--text-title);font-weight:700;font-variant-numeric:tabular-nums}.notice{border-left:4px solid var(--accent)}
@page{size:A4;margin:12mm}@media print{body{background:var(--raised);font-size:var(--text-print)}main{max-width:none;padding:0}.report-header{grid-template-columns:repeat(3,minmax(0,1fr));padding:var(--s3);border-radius:0}.report-header h1{font-size:var(--text-title)}.card,.comparison-summary,.scene-card{padding:var(--s2);margin:var(--s2) 0;border-radius:0}.note{display:block}.note h3{margin-bottom:var(--s2)}.scene-card{padding:0}.scene-card img{max-height:var(--print-scene-height)}.option-header{margin-top:var(--s4)}.option-header h2{font-size:18px}.metrics{margin-top:var(--s2);padding-top:var(--s2)}.metrics strong{display:inline;margin-left:var(--s1);font-size:16px}.meta{font-size:var(--text-print-caption)}th,td{padding:var(--s1) var(--s2)}p{orphans:3;widows:3}.scene-card,.plan-checks,.notice,.comparison-summary{break-inside:avoid}article+article{break-before:page}article>.option-header{break-inside:avoid;break-after:avoid}h2,h3{break-inside:avoid;break-after:avoid}tr,li{break-inside:avoid}thead{display:table-header-group}.plan-card svg{max-height:var(--print-plan-height)}}
@media screen and (max-width:700px){main{padding:var(--s4)}.report-header{grid-template-columns:1fr}.report-header h1{font-size:var(--text-title)}.card,.comparison-summary{padding:var(--s4)}.note,.plan-checks,.comparison-summary{grid-template-columns:1fr}.metrics{grid-template-columns:1fr 1fr 1fr}.metrics strong,.comparison-summary dd{font-size:18px}.scene-card figcaption{display:grid}table{font-size:var(--text-caption)}}
@media print{.notes{line-height:1.4}.notice{display:flex;align-items:baseline;gap:var(--s2);padding:var(--s1) var(--s2)}.notice h2{margin:0;font-size:var(--text-print);white-space:nowrap}.notice p{margin:0;font-size:var(--text-print-caption);line-height:1.4}}
</style></head><body><main>
<header class="report-header"><span class="eyebrow">ROOM STUDIO · DECISION REPORT</span><h1>${title}</h1>
${consultation.businessName ? `<p data-field="businessName">업체 · ${escapeHtml(consultation.businessName)}</p>` : ''}
${consultation.clientName ? `<p data-field="clientName">고객 · ${escapeHtml(consultation.clientName)}</p>` : ''}
<p class="meta">${escapeHtml(generated)} UTC 생성</p></header>
${noteMarkup(consultation.requirements, '고객 요구사항', 'requirements')}
${comparisonMarkup(layouts)}
${options}
<section class="card notice"><h2>사용 범위</h2><p>이 문서는 기획·배치 확인을 돕는 시각화 자료입니다. 건축 인허가·구조·접근성·시공 판단은 관련 전문가의 검토가 필요합니다.</p></section>
</main></body></html>`;
}
