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
  ? `<section class="card" data-field="${field}"><h3>${heading}</h3><p class="notes">${escapeHtml(value)}</p></section>` : '';

function optionMarkup(key, layout, option, recommended) {
  const { items = [], zones = [] } = layout;
  const optionTitle = option.label && option.label !== `${key}안` ? `${key}안 · ${option.label}` : `${key}안`;
  const area = (calculateUnionArea(zones) / 10000).toFixed(1);
  const coverage = calculateCoverage(items, zones);
  return `<article data-option="${key}">
<header><h2>${escapeHtml(optionTitle)}${recommended ? ' · 추천안' : ''}</h2></header>
${noteMarkup(option.recommendation, '추천 이유', 'recommendation')}
<div class="plan-checks"><section class="card plan-card"><h3>${escapeHtml(optionTitle)} · 2D 도면</h3>${renderPlanSvg(layout, { label: optionTitle, idPrefix: `report-${key}` })}
<div class="metrics"><div><span>집 면적</span><strong data-metric="area">${area}m²</strong></div><div><span>바닥 점유 추정</span><strong data-metric="coverage">${coverage}%</strong></div><div><span>가구 수</span><strong data-metric="items">${items.length}개</strong></div></div>
<p class="meta">바닥에 놓인 가구의 외곽 크기로 계산한 점유 추정치입니다. 통행 폭과 설치 여유는 별도로 확인하세요.</p></section>
<section class="card"><h3>대상별 확인 사항</h3>${warningMarkup(layout)}</section></div>
<section class="card"><h3>가구 목록</h3>${furnitureMarkup(items)}</section>
${noteMarkup(option.nextSteps, '수정 사항과 다음 단계', 'nextSteps')}
</article>`;
}

// Legacy metrics is still accepted by callers; layout is the source of truth.
export function createDecisionReport({ projectName, layout = {}, generatedAt = new Date().toISOString() }) {
  const title = escapeHtml(String(projectName ?? '').trim() || '내 집 도면');
  const source = { zones: [], items: [], structures: [], dimensions: [], backgroundPlan: null, wallHeight: 240, ...layout };
  const consultation = normalizeConsultation(source.consultation);
  const keys = consultation.inactiveGeometry ? ['A', 'B'] : ['A'];
  const generated = new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC',
  }).format(new Date(generatedAt));
  const options = keys.map((key) => optionMarkup(key, geometryForOption(source, key), consultation.options[key], consultation.recommendedOption === key)).join('');

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Room Studio 의사결정 리포트</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#eee9df;color:#292b29;font:15px/1.55 system-ui,sans-serif}main{max-width:1080px;margin:auto;padding:40px}header,.card{background:#fffdf8;border:1px solid #d6cfc2;border-radius:12px;padding:24px;margin-bottom:18px}header{border-top:5px solid #d87943}h1{margin:4px 0;font-size:30px}h2,h3{margin:0 0 12px}.eyebrow{color:#a6532e;font-size:12px;font-weight:800;letter-spacing:.12em}.meta{color:#62665f;font-size:12px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:16px}.metrics strong{display:block;font-size:24px}svg{display:block;width:100%;max-height:560px;background:#faf8f2;border:1px solid #ded8cc}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #e1ddd4;padding:10px;overflow-wrap:anywhere}.warnings{color:#9a3528}.ok{color:#49634d;font-weight:700}.notice{border-left:4px solid #d87943}.notes{white-space:pre-wrap;overflow-wrap:anywhere}h1,h2,h3,li{overflow-wrap:anywhere}@page{size:A4;margin:12mm}@media print{body{background:#fff;font-size:11px}main{max-width:none;padding:0}header,.card{padding:6px;margin-bottom:6px;border-radius:0}main>header{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));column-gap:12px}main>header>.eyebrow,main>header>h1{grid-column:1/-1}main>header p{align-self:end;overflow-wrap:anywhere}article>header{break-inside:avoid;break-after:avoid}h1{font-size:24px}header{border-top-width:2px}article>header h2{margin-bottom:0}h2,h3{margin-bottom:4px;line-height:1.3}p{margin:4px 0}.metrics{margin-top:6px}.metrics strong{display:inline;margin-left:8px;font-size:16px}.meta{font-size:10px}th,td{padding:4px 6px}p{orphans:3;widows:3}.plan-checks,.notice{break-inside:avoid}h2,h3{break-inside:avoid;break-after:avoid}.card>h3+*{break-before:avoid}tr,li{break-inside:avoid}thead{display:table-header-group}svg{max-height:90mm}}@media screen and (max-width:700px){main{padding:16px}header,.card{padding:16px}.metrics{grid-template-columns:1fr}table{font-size:12px}}
</style></head><body><main>
<header><span class="eyebrow">ROOM STUDIO · DECISION REPORT</span><h1>${title}</h1>
${consultation.businessName ? `<p data-field="businessName">업체 · ${escapeHtml(consultation.businessName)}</p>` : ''}
${consultation.clientName ? `<p data-field="clientName">고객 · ${escapeHtml(consultation.clientName)}</p>` : ''}
<p class="meta">${escapeHtml(generated)} UTC 생성</p></header>
${noteMarkup(consultation.requirements, '고객 요구사항', 'requirements')}
${options}
<section class="card notice"><h2>사용 범위</h2><p>이 문서는 기획·배치 확인을 돕는 시각화 자료입니다. 건축 인허가·구조·접근성·시공 판단은 관련 전문가의 검토가 필요합니다.</p></section>
</main></body></html>`;
}
