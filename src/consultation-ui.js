import { normalizeConsultation, geometryForOption } from './consultation.js';
import { renderPlanSvg } from './plan-svg.js';

const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
const existingOptions = (data) => data.inactiveGeometry === null ? ['A'] : ['A', 'B'];
const optionName = (data, option) => `${option} · ${data.options[option].label}`;

export function renderConsultationToolbar({ projectName, consultation }) {
  const data = normalizeConsultation(consultation);
  const hasB = data.inactiveGeometry !== null;
  return `<section class="consultation-toolbar" aria-label="상담 및 배치안">
    <div class="consultation-context"><span title="${escapeHtml(`${projectName} · ${data.options[data.activeOption].label}`)}">${escapeHtml(data.clientName || '고객 정보 미입력')} · ${escapeHtml(data.options[data.activeOption].label)}</span><button type="button" data-consultation-open>상담 정보</button></div>
    <div class="consultation-option-controls">
      <div class="consultation-options" role="group" aria-label="편집할 배치안">${['A', 'B'].map((option) => `<button type="button" data-option-select="${option}" aria-pressed="${data.activeOption === option}" aria-label="${escapeHtml(optionName(data, option))}" title="${escapeHtml(optionName(data, option))}" ${option === 'B' && !hasB ? 'disabled' : ''}>${option}안${data.recommendedOption === option ? '<span class="consultation-recommended">추천</span>' : ''}</button>`).join('')}</div>
      ${hasB ? '' : '<button type="button" data-option-create>B안 만들기</button>'}
      <button type="button" data-options-compare ${hasB ? '' : 'disabled title="B안을 만들면 비교할 수 있습니다."'}>비교</button>
      <button class="consultation-report-button" type="button" data-consultation-report>제안서</button>
    </div>
  </section>`;
}

export function renderConsultationDialog({ projectName, consultation }) {
  const data = normalizeConsultation(consultation);
  const notes = data.options[data.activeOption];
  return `<div class="consultation-backdrop" data-consultation-backdrop>
    <section class="consultation-dialog" role="dialog" aria-modal="true" aria-labelledby="consultation-dialog-title">
      <header class="consultation-dialog-header"><div><span class="eyebrow">상담 기록</span><h2 id="consultation-dialog-title">상담 정보</h2></div><button type="button" data-consultation-close aria-label="변경 취소하고 상담 정보 닫기">닫기</button></header>
      <form data-consultation-form>
        <div class="consultation-form-scroll">
          <fieldset class="consultation-fieldset"><legend>프로젝트 공통 정보</legend>
            <label>프로젝트 이름<input name="projectName" maxlength="80" value="${escapeHtml(projectName)}" required></label>
            <div class="consultation-field-row"><label>업체명<input name="businessName" maxlength="120" autocomplete="organization" value="${escapeHtml(data.businessName)}"></label><label>고객명<input name="clientName" maxlength="120" autocomplete="off" value="${escapeHtml(data.clientName)}"></label></div>
            <label>고객 요구사항<textarea name="requirements" maxlength="8000" rows="4">${escapeHtml(data.requirements)}</textarea></label>
          </fieldset>
          <fieldset class="consultation-fieldset"><legend>현재 ${data.activeOption}안 메모</legend>
            <label>배치안 이름<input name="optionLabel" maxlength="80" value="${escapeHtml(notes.label)}"></label>
            <label>추천 이유<textarea name="recommendation" maxlength="4000" rows="4">${escapeHtml(notes.recommendation)}</textarea></label>
            <label>수정 사항 및 다음 단계<textarea name="nextSteps" maxlength="4000" rows="4">${escapeHtml(notes.nextSteps)}</textarea></label>
            <label>추천 배치안<select name="recommendedOption"><option value="" ${data.recommendedOption === null ? 'selected' : ''}>아직 정하지 않음</option>${existingOptions(data).map((option) => `<option value="${option}" ${data.recommendedOption === option ? 'selected' : ''}>${escapeHtml(optionName(data, option))}</option>`).join('')}</select></label>
          </fieldset>
        </div>
        <div class="consultation-dialog-footer"><p>적용 전에는 원본이 바뀌지 않습니다.</p><div><button type="button" data-consultation-close>취소</button><button class="consultation-primary" type="submit">적용</button></div></div>
      </form>
    </section>
  </div>`;
}

export function renderComparisonDialog({ projectName, layout }) {
  const data = normalizeConsultation(layout.consultation);
  return `<div class="consultation-backdrop" data-comparison-backdrop>
    <section class="comparison-dialog" role="dialog" aria-modal="true" aria-labelledby="comparison-dialog-title">
      <header class="consultation-dialog-header"><div><span class="eyebrow">배치안 비교</span><h2 id="comparison-dialog-title">${escapeHtml(projectName)}</h2></div><button type="button" data-comparison-close aria-label="배치안 비교 닫기">닫기</button></header>
      <div class="comparison-scroll"><div class="comparison-grid">${existingOptions(data).map((option) => {
    const notes = data.options[option];
    const name = optionName(data, option);
    return `<article class="comparison-option" data-comparison-option="${option}">
          <header><h3>${escapeHtml(name)}</h3><div class="comparison-markers">${data.activeOption === option ? '<span>현재 편집 중</span>' : ''}${data.recommendedOption === option ? '<strong>추천안</strong>' : ''}</div></header>
          <div class="comparison-plan">${renderPlanSvg(geometryForOption(layout, option), { label: `${projectName} · ${name} 도면`, idPrefix: `comparison-${option}` })}</div>
          <dl><dt>추천 이유</dt><dd>${escapeHtml(notes.recommendation) || '<span class="consultation-empty">입력한 추천 이유가 없습니다.</span>'}</dd><dt>수정 사항 및 다음 단계</dt><dd>${escapeHtml(notes.nextSteps) || '<span class="consultation-empty">입력한 수정 사항이 없습니다.</span>'}</dd></dl>
          <button type="button" data-comparison-edit="${option}">${option}안 편집</button>
        </article>`;
  }).join('')}</div></div>
    </section>
  </div>`;
}
