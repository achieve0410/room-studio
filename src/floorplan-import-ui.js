import './floorplan-import.css';
import { createFloorplanLayout, floorplanSummary, longestRoomEdge, rectifyFloorplan } from './floorplan-import.js';
import { zoneFromPoints, zoneInteriorPoint } from './space-geometry.js';

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const types = ['기타', '거실', '방', '주방', '욕실', '다용도실'];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const pointDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

async function imageCanvas(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('PNG, JPG, WebP 도면 이미지를 선택해주세요.');
  if (file.size > 20 * 1024 * 1024) throw new Error('20MB 이하의 이미지를 선택해주세요.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function encodedImage(canvas, name) {
  let dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  for (let quality = 0.78; dataUrl.length > 650000 && quality >= 0.28; quality -= 0.1) {
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }
  if (dataUrl.length > 650000) throw new Error('도면 부분을 잘라 더 작은 이미지로 올려주세요.');
  return { width: canvas.width, height: canvas.height, dataUrl, name };
}

export function openFloorplanImporter({ file, onApply, onClose }) {
  const app = document.querySelector('#app');
  const previousInert = app.inert;
  const previousOverflow = document.body.style.overflow;
  const previousFocus = document.activeElement;
  app.inert = true;
  document.body.style.overflow = 'hidden';
  const root = document.createElement('div');
  root.className = 'plan-import-backdrop';
  root.dataset.planImport = '';
  root.innerHTML = `<section class="plan-import-dialog" role="dialog" aria-modal="true" aria-labelledby="plan-import-title">
    <header class="plan-import-header"></header><div class="plan-import-body"></div><footer class="plan-import-footer"></footer>
  </section>`;
  document.body.append(root);
  const header = root.querySelector('header'), body = root.querySelector('.plan-import-body'), footer = root.querySelector('footer');
  let disposed = false, generation = 0, worker = null, ocr = null;
  let canvas = null, originalCanvas = null, image = null, rooms = [], openings = [], selected = null, activeOpening = null;
  let step = 'choose', mode = 'select', vertices = false, vertexIndex = 0;
  let reference = null, previousReference = null, length = '', unit = 'cm', candidates = [], ocrStatus = '', candidateBounds = null;
  let photoCorners = [], photoAspect = 'landscape', draft = [], error = '', notice = '';
  let automaticThreshold = true, threshold = 150, gapClosing = 0.08, zoom = 1, center = null, gesture = null, applying = false;
  const contacts = new Map();
  const includedRooms = () => rooms.filter(room => room.included);
  const selectedRoom = () => rooms.find(room => room.id === selected);
  const canvasElement = () => root.querySelector('[data-import-canvas]');
  const focusedSelector = () => {
    if (!root.contains(document.activeElement)) return null;
    const attributes = [...document.activeElement.attributes].filter(attribute => attribute.name.startsWith('data-'));
    return attributes.length ? attributes.map(attribute => `[${attribute.name}="${CSS.escape(attribute.value)}"]`).join('') : null;
  };
  const signalError = message => {
    error = message;
    const output = root.querySelector('[data-import-error]');
    if (output) output.textContent = message;
  };
  const close = (applied = false, open3d = false) => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    worker?.terminate();
    ocr?.abort();
    resizeObserver.disconnect();
    root.remove();
    app.inert = previousInert;
    document.body.style.overflow = previousOverflow;
    onClose?.({ applied, open3d });
    if (!applied && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  };
  const currentLayout = () => createFloorplanLayout({ rooms, image, openings, reference: { ...reference, length, unit } });
  const pointAt = event => {
    const svg = canvasElement();
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return { x: clamp(point.x, 0, image.width - 1), y: clamp(point.y, 0, image.height - 1) };
  };
  const viewBox = () => {
    const svg = canvasElement();
    const padding = 24 / Math.min((svg.clientWidth - 48) / image.width, (svg.clientHeight - 48) / image.height);
    const width = (image.width + padding * 2) / zoom, height = (image.height + padding * 2) / zoom;
    return { x: center.x - width / 2, y: center.y - height / 2, width, height };
  };
  const resizeObserver = new ResizeObserver(() => drawCanvas());

  function drawCanvas() {
    const svg = canvasElement();
    if (!svg || !image) return;
    const focus = svg.contains(document.activeElement) ? focusedSelector() : null;
    const box = viewBox();
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
    const transform = svg.getScreenCTM();
    const ratio = Math.hypot(transform?.a ?? 1, transform?.b ?? 0);
    const hit = 22 / ratio, marker = 6 / ratio, font = 12 / ratio;
    const handle = (point, index, kind) => `<g data-handle="${kind}" data-index="${index}" tabindex="0" role="button" aria-label="${kind === 'reference' ? '기준점' : '모서리'} ${index + 1}, 방향키로 이동">
      <circle cx="${point.x}" cy="${point.y}" r="${hit}" fill="transparent"/>
      <circle class="plan-import-point" cx="${point.x}" cy="${point.y}" r="${marker}" fill="${['vertex', 'photo'].includes(kind) && index === vertexIndex ? 'var(--ink)' : 'var(--surface-raised)'}" stroke="var(--ink)" vector-effect="non-scaling-stroke" stroke-width="2"/>
    </g>`;
    let markup = `<image href="${image.dataUrl}" x="0" y="0" width="${image.width}" height="${image.height}"/>`;
    if (step !== 'rectify') {
      markup += rooms.map((room, index) => {
        const position = zoneInteriorPoint(zoneFromPoints({}, room.points));
        const active = room.id === selected;
        return `<g data-room="${room.id}" role="button" tabindex="0" aria-label="${escape(room.name)}, ${room.included ? '포함' : '제외'}">
          <polygon points="${room.points.map(point => `${point.x},${point.y}`).join(' ')}" fill="${room.included ? 'var(--success)' : 'var(--surface-raised)'}" fill-opacity="${room.included ? active ? 0.25 : 0.1 : 0.05}"
            stroke="${active ? 'var(--ink)' : 'var(--muted-readable)'}" stroke-width="${active ? 2.5 : 1}" stroke-dasharray="${room.included ? 'none' : '5 4'}" vector-effect="non-scaling-stroke"/>
          <circle cx="${position.x}" cy="${position.y}" r="${font}" fill="${active ? 'var(--ink)' : 'var(--surface-raised)'}"/>
          <text x="${position.x}" y="${position.y}" font-size="${font}" font-family="inherit" text-anchor="middle" dominant-baseline="central" fill="${active ? 'var(--surface-raised)' : 'var(--ink)'}" pointer-events="none">${index + 1}</text>
        </g>`;
      }).join('');
      markup += openings.map((opening, index) => `<g data-opening="${index}" role="button" tabindex="0" aria-label="문 후보 ${index + 1} 위치 확인">
        <line x1="${opening.start.x}" y1="${opening.start.y}" x2="${opening.end.x}" y2="${opening.end.y}" stroke="transparent" stroke-width="44" vector-effect="non-scaling-stroke"/>
        <line x1="${opening.start.x}" y1="${opening.start.y}" x2="${opening.end.x}" y2="${opening.end.y}" stroke="var(--surface-raised)" stroke-width="7" vector-effect="non-scaling-stroke"/>
        <line x1="${opening.start.x}" y1="${opening.start.y}" x2="${opening.end.x}" y2="${opening.end.y}" stroke="var(--accent)" stroke-width="3" stroke-dasharray="${opening.included ? 'none' : '4 3'}" vector-effect="non-scaling-stroke"/>
        ${activeOpening === index ? `<rect x="${(opening.start.x + opening.end.x) / 2 - font * 2.5}" y="${(opening.start.y + opening.end.y) / 2 - font}" width="${font * 5}" height="${font * 2}" rx="${font / 3}" fill="var(--ink)"/>
          <text x="${(opening.start.x + opening.end.x) / 2}" y="${(opening.start.y + opening.end.y) / 2}" font-size="${font}" font-family="inherit" text-anchor="middle" dominant-baseline="central" fill="var(--surface-raised)">문 후보 ${index + 1}</text>` : ''}
      </g>`).join('');
      if (step === 'review' && vertices && selectedRoom()) {
        const points = selectedRoom().points;
        markup += points.map((point, index) => index === vertexIndex ? '' : handle(point, index, 'vertex')).join('');
        markup += handle(points[vertexIndex], vertexIndex, 'vertex');
      }
      if (draft.length) {
        markup += `<polyline points="${draft.map(point => `${point.x},${point.y}`).join(' ')}" fill="none" stroke="var(--ink)" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
        markup += draft.map((point, index) => handle(point, index, 'draft')).join('');
      }
      if (step === 'scale' && reference) {
        const x = (reference.start.x + reference.end.x) / 2, y = (reference.start.y + reference.end.y) / 2;
        markup += `<line x1="${reference.start.x}" y1="${reference.start.y}" x2="${reference.end.x}" y2="${reference.end.y}" stroke="var(--surface-raised)" stroke-width="8" vector-effect="non-scaling-stroke"/>
          <line x1="${reference.start.x}" y1="${reference.start.y}" x2="${reference.end.x}" y2="${reference.end.y}" stroke="var(--accent)" stroke-width="3" vector-effect="non-scaling-stroke"/>
          <rect x="${x - font * 2}" y="${y - font}" width="${font * 4}" height="${font * 2}" rx="${font / 3}" fill="var(--surface-raised)"/>
          <text x="${x}" y="${y}" font-family="inherit" font-size="${font}" text-anchor="middle" dominant-baseline="central" fill="var(--ink)">기준선</text>`;
        markup += [reference.start, reference.end].map((point, index) => handle(point, index, 'reference')).join('');
      }
      if (step === 'scale' && candidateBounds) markup += `<rect x="${candidateBounds.x}" y="${candidateBounds.y}" width="${candidateBounds.width}" height="${candidateBounds.height}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
    } else {
      markup += `<polygon points="${photoCorners.map(point => `${point.x},${point.y}`).join(' ')}" fill="var(--surface-raised)" fill-opacity=".2" stroke="var(--ink)" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
      markup += photoCorners.map((point, index) => index === vertexIndex ? '' : handle(point, index, 'photo')).join('');
      markup += handle(photoCorners[vertexIndex], vertexIndex, 'photo');
    }
    svg.innerHTML = markup;
    const point = (step === 'rectify' ? photoCorners : selectedRoom()?.points)?.[vertexIndex];
    if (point) {
      const select = root.querySelector('[data-field="vertex"]');
      if (select) select.value = String(vertexIndex);
      for (const axis of ['x', 'y']) {
        const input = root.querySelector(`[data-field="vertex-${axis}"]`);
        if (input && input !== document.activeElement) input.value = String(Math.round(point[axis]));
      }
    }
    if (focus) root.querySelector(focus)?.focus({ preventScroll: true });
  }

  function renderCandidates() {
    const output = root.querySelector('[data-import-ocr]');
    if (!output) return;
    output.innerHTML = `<p class="plan-import-caption" data-import-ocr-status>${escape(ocrStatus)}</p>
      <div class="plan-import-ocr-list">${candidates.slice(0, 16).map((candidate, index) => `<button type="button" data-candidate="${index}">${escape(candidate.text)}</button>`).join('')}</div>`;
  }

  function updateScalePreview() {
    const preview = root.querySelector('[data-import-summary]');
    if (!preview) return;
    let valid = false;
    try {
      const summary = floorplanSummary(currentLayout());
      preview.innerHTML = `<strong>${summary.rooms}개 공간 · ${summary.area.toFixed(1)}㎡</strong>
        <span class="plan-import-caption">전체 가로 ${(summary.width / 100).toFixed(2)}m · 세로 ${(summary.depth / 100).toFixed(2)}m</span>`;
      valid = true;
    } catch (failure) {
      preview.textContent = length && unit && reference ? failure.message : '표시한 기준선의 실제 길이와 단위를 입력하세요.';
    }
    root.querySelectorAll('[data-action="apply"]').forEach(button => { button.disabled = !valid; });
  }

  function render() {
    const sameStep = root.dataset.importStage === step;
    const focus = sameStep ? focusedSelector() : null;
    const scrollTop = sameStep ? body.scrollTop : 0;
    const openDetails = sameStep
      ? [...body.querySelectorAll('details[data-import-disclosure][open]')].map(node => node.dataset.importDisclosure)
      : [];
    resizeObserver.disconnect();
    root.dataset.importStage = step;
    header.innerHTML = `<div><nav class="plan-import-steps" aria-label="도면 가져오기 단계">
      <span ${step === 'choose' || step === 'loading' ? 'aria-current="step"' : ''}>1 도면 선택</span>
      <span ${step === 'review' || step === 'rectify' ? 'aria-current="step"' : ''}>2 공간 확인</span>
      <span ${step === 'scale' ? 'aria-current="step"' : ''}>3 크기 확인</span></nav>
      <h2 id="plan-import-title">${step === 'scale' ? '실제 길이만 확인하면 준비 끝' : step === 'rectify' ? '사진의 네 모서리 맞추기' : '우리 집 도면으로 시작'}</h2>
      <p>${step === 'scale' ? '원본의 치수와 굵게 표시한 기준선을 맞춰주세요.' : '인식한 공간을 확인하고 바로 가구를 놓아보세요.'}</p></div>
      <button data-action="close" type="button" aria-label="도면 가져오기 닫기">×</button>`;
    if (!image || step === 'loading') {
      body.innerHTML = `<div class="plan-import-upload" data-import-drop>
        <svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M12 8h28l12 12v36H12V8Zm28 0v12h12M22 34h20M32 24v20" stroke="currentColor" stroke-width="2"/></svg>
        <h3>${step === 'loading' ? '도면에서 공간을 찾고 있어요' : '평면도 사진이나 캡처를 올려주세요'}</h3>
        <p>${step === 'loading' ? '사진은 이 기기 안에서 처리합니다.' : '파일을 끌어놓거나 붙여넣어도 됩니다. 선명한 평면도가 가장 잘 읽혀요.'}</p>
        <button class="plan-import-primary" data-action="choose" type="button">${step === 'loading' ? '다른 이미지 선택' : '도면 이미지 선택'}</button>
        <p class="plan-import-caption">PNG · JPG · WebP, 최대 20MB</p>
      </div><p class="plan-import-error" data-import-error role="alert">${escape(error)}</p>`;
      footer.innerHTML = '<p>도면과 사진을 외부 서버로 보내지 않습니다.</p><button type="button" data-action="close">돌아가기</button>';
    } else {
      const room = selectedRoom();
      const correctionPoints = step === 'rectify' ? photoCorners : room?.points ?? [];
      vertexIndex = Math.min(vertexIndex, Math.max(0, correctionPoints.length - 1));
      const vertex = correctionPoints[vertexIndex];
      const coordinateControls = vertex ? `<details data-import-disclosure="coordinates"><summary>모서리 좌표로 조정</summary><div>
        <label>모서리<select data-field="vertex">${correctionPoints.map((_, index) => `<option value="${index}" ${index === vertexIndex ? 'selected' : ''}>${index + 1}번 모서리</option>`).join('')}</select></label>
        <div class="plan-import-row"><label>사진 X (px)<input data-field="vertex-x" type="number" min="0" max="${image.width - 1}" step="1" value="${Math.round(vertex.x)}"></label>
        <label>사진 Y (px)<input data-field="vertex-y" type="number" min="0" max="${image.height - 1}" step="1" value="${Math.round(vertex.y)}"></label></div></div></details>` : '';
      body.innerHTML = `<div class="plan-import-workspace">
        <div class="plan-import-preview">
          <svg class="plan-import-canvas" data-import-canvas aria-label="원본 도면과 인식한 공간" tabindex="0" preserveAspectRatio="xMidYMid meet"></svg>
          <div class="plan-import-toolbar">
            ${step === 'review' ? `<button type="button" data-action="vertices" aria-pressed="${vertices}">윤곽 수정</button>
              <button type="button" data-action="draw" aria-pressed="${mode === 'draw'}">공간 추가</button>` : ''}
            ${step === 'scale' ? `<button type="button" data-action="reference" aria-pressed="${mode === 'reference'}">기준 두 점 선택</button>` : ''}
            <div class="plan-import-zoom"><button type="button" data-action="zoom-out" aria-label="도면 축소">−</button>
              <button type="button" data-action="fit">전체</button><button type="button" data-action="zoom-in" aria-label="도면 확대">+</button></div>
          </div>
          <p class="plan-import-caption">${mode === 'draw' ? '빠진 공간의 모서리를 차례로 찍고 공간 완성을 누르세요.' : mode === 'reference' ? '실제 길이를 아는 선의 시작점과 끝점을 찍으세요.' : step === 'rectify' ? '종이의 왼쪽 위부터 시계 방향으로 네 모서리를 맞추세요.' : step === 'scale' ? '기준선은 벽 선택이나 두 점 선택으로 바꿀 수 있어요.' : '공간을 눌러 선택 · 빈 곳을 끌어 이동 · 두 손가락으로 확대'}</p>
          ${mode === 'draw' ? '<div class="plan-import-toolbar"><button type="button" data-action="finish-draw">공간 완성</button><button type="button" data-action="undo-point">한 점 취소</button><button type="button" data-action="cancel-mode">그리기 취소</button></div>' : ''}
          <p class="plan-import-error" data-import-error role="alert">${escape(error)}</p>
          <p class="plan-import-caption" data-import-notice role="status">${step === 'review' ? escape(notice) : ''}</p>
        </div>
        <aside class="plan-import-controls" aria-label="도면 확인 도구">
          ${step === 'rectify' ? `<section><h3>종이 비율 확인</h3><p>네 모서리는 도면 내부가 아닌 종이 테두리에 맞춰주세요.</p>
            <label>종이 방향<select data-field="photo-aspect"><option value="landscape" ${photoAspect === 'landscape' ? 'selected' : ''}>A4 가로 · 297 × 210</option><option value="portrait" ${photoAspect === 'portrait' ? 'selected' : ''}>A4 세로 · 210 × 297</option><option value="original" ${photoAspect === 'original' ? 'selected' : ''}>기울기 없는 영역 자르기</option></select></label>
            <p class="plan-import-caption">보정하면 기존 인식 결과를 지우고 다시 읽습니다.</p></section>${coordinateControls}` : step === 'scale' ? `
            <section><h3>표시한 기준선의 길이</h3>
              <div class="plan-import-row"><label>실제 길이<input data-field="length" type="number" inputmode="decimal" min="0.01" step="any" value="${escape(length)}" placeholder="예: 420"></label>
              <label>단위<select data-field="unit"><option value="" ${!unit ? 'selected' : ''}>단위 확인</option>${['mm', 'cm', 'm'].map(value => `<option ${unit === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label></div>
              <p class="plan-import-caption">원본에 표시된 길이나 직접 잰 길이를 입력하세요.</p>
              <details data-import-disclosure="reference"><summary>기준 공간·벽 바꾸기</summary><div>
                <label>기준 공간<select data-field="reference-room">${includedRooms().map(candidate => `<option value="${candidate.id}" ${candidate.id === selected ? 'selected' : ''}>${escape(candidate.name)}</option>`).join('')}</select></label>
                <label>기준 벽<select data-field="reference-edge">${(room?.points ?? []).map((_, index) => `<option value="${index}" ${reference?.edgeIndex === index ? 'selected' : ''}>${index + 1}번 벽</option>`).join('')}<option value="custom" ${reference?.edgeIndex === undefined ? 'selected' : ''}>직접 지정한 두 점</option></select></label>
              </div></details></section>
            <section><h3>사진에서 읽은 숫자</h3><div data-import-ocr></div><p class="plan-import-caption">숫자를 누른 뒤 해당 기준선과 단위를 확인하세요.</p></section>
            <div class="plan-import-size-preview" data-import-summary aria-live="polite"></div>` : `
            <section><h3>${includedRooms().length}개 공간 가져오기</h3><p class="plan-import-caption">필요한 공간만 남겨도 됩니다. 인식 결과는 실측 도면이 아니므로 원본과 확인하세요.</p>
              <div class="plan-import-rooms">${rooms.map((candidate, index) => `<button type="button" data-select-room="${candidate.id}" aria-pressed="${candidate.id === selected}"><span>${index + 1}. ${escape(candidate.name)}</span><small>${candidate.included ? '포함' : '제외'}</small></button>`).join('')}</div>
              ${!rooms.length ? '<p>닫힌 공간을 찾지 못했습니다. 사진을 보정하거나 빠진 공간의 모서리를 찍어주세요.</p>' : ''}
            </section>
            ${room ? `<section><label class="plan-import-check"><input data-field="included" type="checkbox" ${room.included ? 'checked' : ''}>이 공간 가져오기</label>
              <button type="button" data-action="only-room">이 공간만 가져오기</button>
              <label>공간 이름<input data-field="room-name" maxlength="80" value="${escape(room.name)}"></label>
              <label>공간 종류<select data-field="room-type">${types.map(type => `<option ${type === room.type ? 'selected' : ''}>${type}</option>`).join('')}</select></label>
              ${coordinateControls}</section>` : ''}
            ${openings.length ? `<details data-opening-details data-import-disclosure="openings"><summary>문 후보 ${openings.length}곳 확인</summary><div><p class="plan-import-caption">점선은 벽의 틈 후보입니다. 실제 문인 곳만 선택하세요. 후보를 누르면 사진에 번호가 표시됩니다.</p>
              ${openings.map((opening, index) => `<label class="plan-import-check"><input data-opening-included="${index}" type="checkbox" ${opening.included ? 'checked' : ''}>문 후보 ${index + 1} 가져오기</label>`).join('')}</div></details>` : ''}
            <details data-import-disclosure="photo"><summary>사진 보정 · 다시 인식</summary><div>
              <button type="button" data-action="rectify">사진 원근 보정</button>
              <button type="button" data-action="rotate">사진 90° 회전</button>
              <button type="button" data-action="restore-photo">원본으로 되돌리기</button>
              <label class="plan-import-check"><input data-field="automatic-threshold" type="checkbox" ${automaticThreshold ? 'checked' : ''}>벽 선 진하기 자동 맞춤</label>
              <label>벽 선 진하기<input data-field="threshold" type="range" min="80" max="230" step="5" value="${threshold}" ${automaticThreshold ? 'disabled' : ''}></label>
              <label>벽 틈 연결<input data-field="gap-closing" type="range" min="0" max="0.12" step="0.01" value="${gapClosing}"></label>
              <p class="plan-import-caption">다시 인식하면 수정한 공간 윤곽을 초기화합니다.</p>
              <button type="button" data-action="recognize">다시 인식</button>
            </div></details>
            <p class="plan-import-caption">문·창문과 가구의 상세 편집은 3D에서 이어갑니다.</p>`}
          <p class="plan-import-file-name plan-import-caption">${escape(image.name)}</p>
          <button type="button" data-action="choose">다른 이미지 선택</button>
        </aside></div>`;
      footer.innerHTML = step === 'rectify'
        ? '<button type="button" data-action="cancel-rectify">돌아가기</button><button type="button" class="plan-import-primary" data-action="apply-rectify">보정하고 다시 읽기</button>'
        : step === 'scale'
          ? '<button type="button" data-action="back">공간 다시 확인</button><div><button type="button" data-action="apply">2D에서 더 고치기</button><button type="button" data-action="apply" data-open-3d class="plan-import-primary">가구 배치 시작</button></div>'
          : `<p>원래 작업은 최종 적용 전까지 바뀌지 않습니다.</p><button type="button" data-action="scale" class="plan-import-primary" ${includedRooms().length ? '' : 'disabled'}>이 공간으로 크기 확인</button>`;
      drawCanvas();
      renderCandidates();
      updateScalePreview();
      resizeObserver.observe(canvasElement());
    }
    openDetails.forEach(key => {
      const details = body.querySelector(`[data-import-disclosure="${key}"]`);
      if (details) details.open = true;
    });
    body.scrollTop = scrollTop;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.hidden = true;
    input.dataset.importFile = '';
    input.addEventListener('change', () => { if (input.files[0]) void loadFile(input.files[0]); });
    root.querySelector('[data-import-file]')?.remove();
    root.append(input);
    (focus && root.querySelector(focus) || header.querySelector('[data-action="close"]')).focus({ preventScroll: true });
  }

  async function recognize() {
    const current = ++generation;
    worker?.terminate();
    ocr?.abort();
    step = 'loading'; error = ''; notice = ''; rooms = []; openings = []; activeOpening = null; candidates = []; candidateBounds = null;
    length = ''; unit = 'cm'; reference = null; mode = 'select'; draft = []; vertices = false;
    zoom = 1; center = { x: image.width / 2, y: image.height / 2 };
    render();
    const source = document.createElement('canvas');
    const ratio = Math.min(1, 1000 / Math.max(canvas.width, canvas.height));
    source.width = Math.round(canvas.width * ratio); source.height = Math.round(canvas.height * ratio);
    source.getContext('2d').drawImage(canvas, 0, 0, source.width, source.height);
    const pixels = source.getContext('2d').getImageData(0, 0, source.width, source.height);
    const controller = new AbortController();
    ocr = controller;
    ocrStatus = '치수 숫자를 읽고 있어요. 직접 길이를 입력해도 됩니다.';
    void import('./floorplan-ocr.js').then(({ readFloorplanDimensions }) => readFloorplanDimensions(canvas, {
      signal: controller.signal,
    })).then(result => {
      if (disposed || current !== generation) return;
      candidates = result;
      ocrStatus = result.length ? '읽은 값은 후보입니다. 원본과 단위를 확인하세요.' : '뚜렷한 숫자를 찾지 못했습니다. 실제 길이를 직접 입력해주세요.';
      renderCandidates();
    }).catch(() => {
      if (disposed || current !== generation) return;
      ocrStatus = '숫자 읽기를 완료하지 못했습니다. 실제 길이를 직접 입력할 수 있습니다.';
      renderCandidates();
    });
    worker = new Worker(new URL('./floorplan-recognition.worker.js', import.meta.url), { type: 'module' });
    const owned = worker;
    owned.onmessage = ({ data }) => {
      owned.terminate();
      if (worker === owned) worker = null;
      if (disposed || current !== generation) return;
      step = 'review';
      if (data.error) {
        error = data.error;
      } else {
        threshold = data.result.threshold;
        rooms = data.result.rooms.map((room, index) => ({
          ...room, name: `공간 ${index + 1}`, type: '기타', included: true,
          points: room.points.map(point => ({ x: point.x * canvas.width / source.width, y: point.y * canvas.height / source.height })),
        }));
        openings = data.result.openings.map(opening => ({
          ...opening, included: false,
          start: { x: opening.start.x * canvas.width / source.width, y: opening.start.y * canvas.height / source.height },
          end: { x: opening.end.x * canvas.width / source.width, y: opening.end.y * canvas.height / source.height },
        }));
        selected = rooms.reduce((largest, room) => !largest || room.area > largest.area ? room : largest, null)?.id ?? null;
        notice = rooms.length ? `${rooms.length}개 공간의 윤곽을 찾았습니다. 필요한 공간만 남기세요.` : '인식된 공간이 없습니다. 사진 보정이나 공간 추가로 이어갈 수 있습니다.';
      }
      render();
      (root.querySelector('[data-action="scale"]:not(:disabled)') ?? root.querySelector('[data-action="draw"]'))?.focus({ preventScroll: true });
    };
    owned.onerror = () => {
      owned.terminate();
      if (worker === owned) worker = null;
      if (disposed || current !== generation) return;
      step = 'review'; error = '공간 인식을 완료하지 못했습니다. 사진을 다시 선택하거나 공간을 추가해주세요.';
      render();
    };
    owned.postMessage({ image: { width: pixels.width, height: pixels.height, data: pixels.data }, options: { ...(!automaticThreshold ? { threshold } : {}), gapClosing } }, [pixels.data.buffer]);
  }

  async function loadFile(nextFile) {
    const current = ++generation;
    worker?.terminate(); worker = null; ocr?.abort();
    step = 'loading'; error = ''; render();
    try {
      const next = await imageCanvas(nextFile);
      if (disposed || current !== generation) return;
      image = encodedImage(next, nextFile.name);
      canvas = originalCanvas = next;
      await recognize();
    } catch (failure) {
      if (disposed || current !== generation) return;
      step = image ? 'review' : 'choose'; error = failure.message || '이미지를 읽지 못했습니다.';
      render();
    }
  }

  function selectRoom(id) {
    selected = id; vertexIndex = 0; error = '';
    if (step === 'scale') { reference = longestRoomEdge(selectedRoom()); length = ''; }
    render();
  }

  function finishDrawing() {
    try {
      zoneFromPoints({}, draft);
      const room = { id: `manual-${rooms.length + 1}`, points: structuredClone(draft), name: `공간 ${rooms.length + 1}`, type: '기타', included: true };
      rooms.push(room); selected = room.id; mode = 'select'; draft = []; error = ''; vertices = true;
      render();
    } catch {
      signalError('세 모서리 이상을 겹치지 않게 지정해주세요.');
    }
  }

  root.addEventListener('click', async event => {
    const roomButton = event.target.closest('[data-select-room]');
    if (roomButton) { selectRoom(roomButton.dataset.selectRoom); return; }
    const candidateButton = event.target.closest('[data-candidate]');
    if (candidateButton) {
      const candidate = candidates[Number(candidateButton.dataset.candidate)];
      length = String(candidate.value); unit = candidate.unit ?? '';
      candidateBounds = candidate.bounds;
      root.querySelector('[data-field="length"]').value = length;
      root.querySelector('[data-field="unit"]').value = unit;
      drawCanvas(); updateScalePreview(); root.querySelector(`[data-field="${unit ? 'length' : 'unit'}"]`).focus();
      return;
    }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'close') { close(); return; }
    if (action === 'choose') { root.querySelector('[data-import-file]').click(); return; }
    if (action === 'zoom-in' || action === 'zoom-out') {
      zoom = clamp(zoom * (action === 'zoom-in' ? 1.4 : 1 / 1.4), 1, 6); drawCanvas(); return;
    }
    if (action === 'fit') { zoom = 1; center = { x: image.width / 2, y: image.height / 2 }; drawCanvas(); return; }
    if (action === 'vertices') { vertices = !vertices; mode = 'select'; render(); return; }
    if (action === 'only-room') {
      rooms.forEach(room => { room.included = room.id === selected; });
      render(); return;
    }
    if (action === 'draw') { mode = 'draw'; vertices = false; draft = []; error = ''; render(); return; }
    if (action === 'finish-draw') { finishDrawing(); return; }
    if (action === 'undo-point') { draft.pop(); drawCanvas(); return; }
    if (action === 'cancel-mode') { mode = 'select'; draft = []; render(); return; }
    if (action === 'reference') { mode = 'reference'; previousReference = reference; reference = null; draft = []; render(); return; }
    if (action === 'scale') {
      if (!includedRooms().some(room => room.id === selected)) selected = includedRooms()[0].id;
      reference = longestRoomEdge(selectedRoom()); step = 'scale'; mode = 'select'; error = '';
      render(); root.querySelector('[data-field="length"]').focus(); return;
    }
    if (action === 'back' || action === 'cancel-rectify') { step = 'review'; mode = 'select'; error = ''; render(); return; }
    if (action === 'rectify') {
      step = 'rectify'; mode = 'select'; vertexIndex = 0; error = '';
      photoCorners = [{ x: 0, y: 0 }, { x: image.width - 1, y: 0 }, { x: image.width - 1, y: image.height - 1 }, { x: 0, y: image.height - 1 }];
      photoAspect = image.width >= image.height ? 'landscape' : 'portrait'; render(); return;
    }
    if (action === 'recognize') { void recognize(); return; }
    if (action === 'rotate' || action === 'restore-photo' || action === 'apply-rectify') {
      try {
        if (action === 'restore-photo') canvas = originalCanvas;
        else {
          const next = document.createElement('canvas');
          if (action === 'rotate') {
            next.width = canvas.height; next.height = canvas.width;
            const context = next.getContext('2d');
            context.translate(next.width, 0); context.rotate(Math.PI / 2); context.drawImage(canvas, 0, 0);
          } else {
            const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
            const corrected = rectifyFloorplan(pixels, photoCorners);
            next.width = corrected.width;
            next.height = photoAspect === 'original' ? corrected.height
              : Math.round(corrected.width * (photoAspect === 'landscape' ? 210 / 297 : 297 / 210));
            const temporary = document.createElement('canvas');
            temporary.width = corrected.width; temporary.height = corrected.height;
            temporary.getContext('2d').putImageData(new ImageData(corrected.data, corrected.width, corrected.height), 0, 0);
            next.getContext('2d').drawImage(temporary, 0, 0, next.width, next.height);
          }
          canvas = next;
        }
        image = encodedImage(canvas, image.name); void recognize();
      } catch (failure) { signalError(failure.message); }
      return;
    }
    if (action === 'apply') {
      if (applying) return;
      applying = true;
      root.querySelectorAll('[data-action="apply"]').forEach(control => { control.disabled = true; });
      try {
        const layout = currentLayout();
        const accepted = await onApply({ projectName: image.name.replace(/\.[^.]+$/, '') || '우리 집 도면', layout });
        if (accepted !== false) close(true, button.hasAttribute('data-open-3d'));
        else signalError('기존 작업을 보관하지 못했습니다. 돌아가서 도면 파일로 보관한 뒤 다시 시도해주세요.');
      } catch (failure) { signalError(failure.message); }
      finally { applying = false; if (!disposed) updateScalePreview(); }
    }
  });

  root.addEventListener('input', event => {
    const field = event.target.dataset.field;
    if (field === 'length') { length = event.target.value; updateScalePreview(); }
    if (field === 'threshold') threshold = Number(event.target.value);
    if (field === 'gap-closing') gapClosing = Number(event.target.value);
    if (field === 'room-name' && selectedRoom()) {
      selectedRoom().name = event.target.value;
      const label = root.querySelector(`[data-select-room="${selected}"] > span`);
      if (label) label.textContent = `${rooms.indexOf(selectedRoom()) + 1}. ${event.target.value}`;
      drawCanvas();
    }
  });
  root.addEventListener('change', event => {
    const field = event.target.dataset.field;
    if (event.target.hasAttribute('data-opening-included')) {
      activeOpening = Number(event.target.dataset.openingIncluded);
      openings[activeOpening].included = event.target.checked;
      drawCanvas();
    }
    if (field === 'unit') { unit = event.target.value; updateScalePreview(); }
    if (field === 'automatic-threshold') {
      automaticThreshold = event.target.checked;
      root.querySelector('[data-field="threshold"]').disabled = automaticThreshold;
    }
    if (field === 'photo-aspect') photoAspect = event.target.value;
    if (field === 'room-type') selectedRoom().type = event.target.value;
    if (field === 'included') { selectedRoom().included = event.target.checked; render(); }
    if (field === 'reference-room') selectRoom(event.target.value);
    if (field === 'reference-edge') {
      if (event.target.value === 'custom') {
        mode = 'reference'; previousReference = reference; reference = null; draft = []; render();
      } else {
        const edgeIndex = Number(event.target.value), points = selectedRoom().points;
        reference = { start: { ...points[edgeIndex] }, end: { ...points[(edgeIndex + 1) % points.length] }, edgeIndex };
        length = ''; root.querySelector('[data-field="length"]').value = '';
        drawCanvas(); updateScalePreview();
      }
    }
    if (field === 'vertex') { vertexIndex = Number(event.target.value); render(); root.querySelector('[data-field="vertex"]')?.focus(); }
    if (field === 'vertex-x' || field === 'vertex-y') {
      const points = step === 'rectify' ? photoCorners : selectedRoom().points;
      const original = { ...points[vertexIndex] };
      points[vertexIndex][field === 'vertex-x' ? 'x' : 'y'] = Number(event.target.value);
      try {
        if (step !== 'rectify') zoneFromPoints({}, points);
        if (points[vertexIndex].x < 0 || points[vertexIndex].y < 0 || points[vertexIndex].x >= image.width || points[vertexIndex].y >= image.height) throw new Error();
        drawCanvas(); signalError('');
      } catch { points[vertexIndex] = original; event.target.value = original[field === 'vertex-x' ? 'x' : 'y']; signalError('모서리가 겹치거나 사진 밖으로 나갈 수 없습니다.'); }
    }
  });
  root.addEventListener('focusin', event => {
    if (event.target.hasAttribute('data-opening-included')) {
      activeOpening = Number(event.target.dataset.openingIncluded);
      drawCanvas();
    }
  });

  root.addEventListener('pointerdown', event => {
    if (!event.target.closest('[data-import-canvas]') || event.button > 0) return;
    event.preventDefault();
    const svg = canvasElement();
    svg.setPointerCapture(event.pointerId);
    contacts.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (contacts.size === 2) {
      if (gesture?.points) {
        if (gesture.kind === 'vertex') selectedRoom().points = gesture.points;
        else if (gesture.kind === 'photo') photoCorners = gesture.points;
        else if (gesture.kind === 'reference') reference = gesture.reference;
      }
      const [a, b] = [...contacts.values()];
      gesture = { kind: 'pinch', distance: pointDistance(a, b), midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, zoom, center: { ...center }, box: viewBox() };
      drawCanvas(); return;
    }
    const target = event.target.closest('[data-handle]');
    const roomTarget = event.target.closest('[data-room]');
    const openingTarget = event.target.closest('[data-opening]');
    const handlePoints = target?.dataset.handle === 'vertex' ? selectedRoom().points
      : target?.dataset.handle === 'photo' ? photoCorners
        : target?.dataset.handle === 'reference' ? [reference.start, reference.end] : null;
    let handleIndex = Number(target?.dataset.index);
    if (handlePoints) {
      const point = pointAt(event);
      handleIndex = handlePoints.reduce((nearest, candidate, index) =>
        pointDistance(candidate, point) < pointDistance(handlePoints[nearest], point) ? index : nearest, 0);
    }
    gesture = {
      kind: target?.dataset.handle ?? 'canvas', index: handleIndex, room: roomTarget?.dataset.room,
      opening: openingTarget ? Number(openingTarget.dataset.opening) : null,
      start: { x: event.clientX, y: event.clientY }, point: pointAt(event), center: { ...center }, box: viewBox(),
      points: target?.dataset.handle === 'photo' ? structuredClone(photoCorners) : structuredClone(selectedRoom()?.points),
      reference: structuredClone(reference), moved: false,
    };
    if (target?.dataset.handle === 'vertex' || target?.dataset.handle === 'photo') vertexIndex = gesture.index;
  });
  root.addEventListener('pointermove', event => {
    if (!contacts.has(event.pointerId) || !gesture) return;
    event.preventDefault();
    contacts.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesture.kind === 'pinch') {
      if (contacts.size !== 2) return;
      const [a, b] = [...contacts.values()], svg = canvasElement();
      const factor = 1 / svg.getScreenCTM().a;
      zoom = clamp(gesture.zoom * pointDistance(a, b) / Math.max(1, gesture.distance), 1, 6);
      center = { x: gesture.center.x - ((a.x + b.x) / 2 - gesture.midpoint.x) * factor, y: gesture.center.y - ((a.y + b.y) / 2 - gesture.midpoint.y) * factor };
      drawCanvas(); return;
    }
    if (pointDistance(gesture.start, { x: event.clientX, y: event.clientY }) >= 4) gesture.moved = true;
    const point = pointAt(event);
    if (gesture.kind === 'vertex') {
      const points = structuredClone(gesture.points);
      points[gesture.index] = point;
      try { zoneFromPoints({}, points); selectedRoom().points = points; signalError(''); } catch { signalError('서로 겹치지 않는 윤곽으로 맞춰주세요.'); }
    } else if (gesture.kind === 'photo') photoCorners[gesture.index] = point;
    else if (gesture.kind === 'reference') {
      reference[gesture.index === 0 ? 'start' : 'end'] = point;
      delete reference.edgeIndex; updateScalePreview();
    } else if (gesture.kind === 'canvas' && gesture.moved && mode !== 'draw' && mode !== 'reference') {
      const transform = canvasElement().getScreenCTM();
      center = { x: gesture.center.x - (event.clientX - gesture.start.x) / transform.a, y: gesture.center.y - (event.clientY - gesture.start.y) / transform.d };
    }
    drawCanvas();
  });
  const finishPointer = (event, cancelled = false) => {
    if (!contacts.has(event.pointerId)) return;
    contacts.delete(event.pointerId);
    const finished = gesture;
    if (!finished) return;
    if (cancelled) {
      if (finished.kind === 'vertex') selectedRoom().points = finished.points;
      else if (finished.kind === 'photo') photoCorners = finished.points;
      else if (finished.kind === 'reference') reference = finished.reference;
    } else if (finished.kind !== 'pinch' && !finished.moved) {
      const point = finished.point;
      if (mode === 'draw') {
        if (draft.length >= 3 && pointDistance(point, draft[0]) < 15 / canvasElement().getScreenCTM().a) finishDrawing();
        else { draft.push(point); drawCanvas(); }
      } else if (mode === 'reference') {
        draft.push(point);
        if (draft.length === 2) {
          reference = { start: draft[0], end: draft[1] }; length = ''; draft = []; mode = 'select'; render();
        }
      } else if (finished.opening !== null) {
        activeOpening = finished.opening;
        const details = root.querySelector('[data-opening-details]');
        if (details) details.open = true;
        drawCanvas();
      } else if (finished.room) selectRoom(finished.room);
    }
    if (!cancelled && finished.kind === 'reference' && finished.moved) {
      length = '';
      root.querySelector('[data-field="length"]').value = '';
      updateScalePreview();
    }
    if (!contacts.size) gesture = null;
    drawCanvas();
  };
  root.addEventListener('pointerup', event => finishPointer(event));
  root.addEventListener('pointercancel', event => finishPointer(event, true));
  root.addEventListener('touchstart', event => {
    if (event.target.closest('[data-import-canvas]')) event.preventDefault();
  }, { passive: false });
  root.addEventListener('wheel', event => {
    if (!event.target.closest('[data-import-canvas]')) return;
    event.preventDefault();
    const before = pointAt(event);
    zoom = clamp(zoom * Math.exp(-event.deltaY * 0.002), 1, 6);
    drawCanvas();
    const after = pointAt(event);
    center.x += before.x - after.x; center.y += before.y - after.y;
    drawCanvas();
  }, { passive: false });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (mode === 'draw' || mode === 'reference') {
        if (mode === 'reference') reference = previousReference;
        mode = 'select'; draft = []; render();
      }
      else close();
      return;
    }
    if (event.key === 'Tab') {
      const elements = [...root.querySelectorAll('button:not(:disabled), input:not([hidden]):not(:disabled), select, summary, [tabindex="0"]')]
        .filter(element => element.getClientRects().length);
      const index = elements.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0 || !event.shiftKey && (index < 0 || index === elements.length - 1)) {
        event.preventDefault(); (event.shiftKey ? elements.at(-1) : elements[0])?.focus();
      }
      event.stopPropagation(); return;
    }
    const handle = event.target.closest('[data-handle]');
    if (handle && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const index = Number(handle.dataset.index), kind = handle.dataset.handle;
      const points = kind === 'photo' ? photoCorners : kind === 'reference' ? [reference.start, reference.end] : selectedRoom()?.points;
      if (!points) return;
      if (kind === 'vertex' || kind === 'photo') vertexIndex = index;
      const original = { ...points[index] }, delta = event.shiftKey ? 10 : 1;
      points[index].x = clamp(points[index].x + (event.key === 'ArrowRight' ? delta : event.key === 'ArrowLeft' ? -delta : 0), 0, image.width - 1);
      points[index].y = clamp(points[index].y + (event.key === 'ArrowDown' ? delta : event.key === 'ArrowUp' ? -delta : 0), 0, image.height - 1);
      try { if (kind === 'vertex') zoneFromPoints({}, points); } catch { Object.assign(points[index], original); }
      if (kind === 'reference') {
        delete reference.edgeIndex;
        length = '';
        root.querySelector('[data-field="length"]').value = '';
      }
      drawCanvas(); updateScalePreview();
      root.querySelector(`[data-handle="${kind}"][data-index="${index}"]`)?.focus(); return;
    }
    const roomTarget = event.target.closest('[data-room]');
    if (roomTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); selectRoom(roomTarget.dataset.room); }
    const openingTarget = event.target.closest('[data-opening]');
    if (openingTarget && ['Enter', ' '].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      activeOpening = Number(openingTarget.dataset.opening);
      const details = root.querySelector('[data-opening-details]');
      if (details) details.open = true;
      drawCanvas();
      root.querySelector(`[data-opening-included="${activeOpening}"]`)?.focus();
    }
  });
  root.addEventListener('dragover', event => {
    event.preventDefault(); root.querySelector('[data-import-drop]')?.setAttribute('data-dragging', 'true');
  });
  root.addEventListener('dragleave', event => {
    if (!root.contains(event.relatedTarget)) root.querySelector('[data-import-drop]')?.removeAttribute('data-dragging');
  });
  root.addEventListener('drop', event => {
    event.preventDefault();
    const next = [...event.dataTransfer.files].find(candidate => candidate.type.startsWith('image/'));
    if (next) void loadFile(next);
  });
  root.addEventListener('paste', event => {
    const item = [...(event.clipboardData?.items ?? [])].find(candidate => candidate.type.startsWith('image/'));
    if (item) { event.preventDefault(); void loadFile(item.getAsFile()); }
  });
  render();
  root.querySelector('[data-action="choose"]')?.focus();
  if (file) void loadFile(file);
  return close;
}
