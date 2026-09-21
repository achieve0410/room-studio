import {
  zonePoints, pointInZone, moveZoneVertex, moveZoneEdge, setZoneEdgeLength,
} from './geometry.js';

const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const lengthLabel = value => `${Math.round(value * 10) / 10} cm`;

/** Canvas interaction state survives the application's DOM replacement lifecycle. */
export function createSpaceEditor({
  getLayout, getSelected, getSvg, getGesture, enabled,
  beginContact, captureContact, startPan, selectSpace, createSpace, changeSpace, render, modeChanged,
}) {
  let mode = 'select';
  let orthogonal = true;
  let shapeEditing = false;
  let points = [];
  let hover = null;
  let pointer = null;
  let preview = null;
  let edgeEdit = null;
  let message = '';
  const resizeObserver = new ResizeObserver(() => refresh());
  const scale = () => Math.hypot(getSvg().getScreenCTM().a, getSvg().getScreenCTM().b);
  const worldPoint = event => {
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(getSvg().getScreenCTM().inverse());
    return { x: Math.round(point.x), y: Math.round(point.y) };
  };
  const snapDrawingPoint = event => {
    const point = worldPoint(event);
    const last = points.at(-1);
    if (last && orthogonal && !event.altKey) {
      const tolerance = 12 / scale();
      if (Math.abs(point.x - last.x) < tolerance) point.x = last.x;
      else if (Math.abs(point.y - last.y) < tolerance) point.y = last.y;
    }
    return point;
  };
  const selected = () => {
    const value = getSelected();
    return value && getLayout().zones.some(zone => zone.id === value.id) ? value : null;
  };

  function refresh() {
    const svg = getSvg();
    if (!svg || !svg.getScreenCTM()) return;
    svg.querySelector('[data-space-overlay]')?.remove();
    for (const node of svg.querySelectorAll('[data-zone-id]')) {
      node.style.visibility = preview?.id === node.dataset.zoneId ? 'hidden' : '';
    }
    const factor = scale();
    const font = parseFloat(getComputedStyle(svg).getPropertyValue('--text-caption')) / factor;
    const target = parseFloat(getComputedStyle(svg).getPropertyValue('--target')) / factor;
    const parts = [];
    const active = preview ?? selected();
    if (active && mode === 'select') {
      const vertices = zonePoints(active);
      const winding = Math.sign(vertices.reduce((sum, point, index) => {
        const next = vertices[(index + 1) % vertices.length];
        return sum + point.x * next.y - next.x * point.y;
      }, 0));
      const rect = svg.getBoundingClientRect();
      const inverse = svg.getScreenCTM().inverse();
      const first = new DOMPoint(rect.left, rect.top).matrixTransform(inverse);
      const last = new DOMPoint(rect.right, rect.bottom).matrixTransform(inverse);
      const labels = [];
      if (preview) parts.push(`<polygon class="space-preview" points="${vertices.map(point => `${point.x},${point.y}`).join(' ')}" />`);
      vertices.forEach((start, index) => {
        const end = vertices[(index + 1) % vertices.length];
        const length = distance(start, end);
        const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
        const tangent = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
        let x, y;
        const label = lengthLabel(length);
        const width = Math.max(target, label.length * font * 0.65 + 12 / factor);
        let box;
        candidate: for (const offset of [32, 52, 72, 92]) {
          for (const along of [0, 28, -28, 56, -56]) {
            x = middle.x + (winding * tangent.y * offset + tangent.x * along) / factor;
            y = middle.y + (-winding * tangent.x * offset + tangent.y * along) / factor;
            x = Math.max(first.x + width / 2 + 4 / factor, Math.min(last.x - width / 2 - 4 / factor, x));
            y = Math.max(first.y + target / 2, Math.min(last.y - target / 2, y));
            box = { left: x - width / 2 - 3 / factor, right: x + width / 2 + 3 / factor,
              top: y - 15 / factor, bottom: y + 15 / factor };
            if (!labels.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) break candidate;
          }
        }
        labels.push(box);
        if (shapeEditing && !active.locked) parts.push(`<line class="space-wall-handle" data-space-wall="${index}"
          x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" />`);
        parts.push(`<line class="space-dimension-guide" x1="${middle.x}" y1="${middle.y}" x2="${x}" y2="${y}" />
          <g class="space-edge-dimension" data-space-edge="${index}" role="button" tabindex="${active.locked ? -1 : 0}"
          aria-label="벽 ${index + 1} 길이 ${label}" transform="translate(${x} ${y})">
          <rect class="space-edge-target" x="${-width / 2}" y="${-target / 2}" width="${width}" height="${target}" />
          <rect class="space-edge-chip" x="${-width / 2}" y="${-12 / factor}" width="${width}" height="${24 / factor}" rx="${4 / factor}" />
          <text text-anchor="middle" dominant-baseline="central" font-size="${font}">${label}</text></g>`);
      });
      if (shapeEditing && !active.locked) vertices.forEach((point, index) => {
        parts.push(`<g class="space-vertex" data-space-vertex="${index}" role="button" tabindex="0"
          aria-label="모서리 ${index + 1}" transform="translate(${point.x} ${point.y})">
          <circle class="space-vertex-target" r="${target / 2}" /><circle class="space-vertex-dot" r="${6 / factor}" /></g>`);
      });
      if (edgeEdit?.id === active.id) {
        const fixed = vertices[edgeEdit.index], end = vertices[(edgeEdit.index + 1) % vertices.length];
        parts.push(`<line class="space-edited-wall" x1="${fixed.x}" y1="${fixed.y}" x2="${end.x}" y2="${end.y}" />
          <g class="space-fixed-end" data-space-fixed data-fixed-x="${fixed.x}" data-fixed-y="${fixed.y}" transform="translate(${fixed.x} ${fixed.y})">
          <circle r="${6 / factor}" /><text x="${12 / factor}" y="${-12 / factor}" font-size="${font}">고정</text></g>`);
      }
    }
    if (mode === 'draw' && points.length) {
      const line = [...points, ...(hover && distance(points.at(-1), hover) > 0 ? [hover] : [])];
      parts.push(`<polyline class="space-draft-line" points="${line.map(point => `${point.x},${point.y}`).join(' ')}" />`);
      points.forEach((point, index) => parts.push(`<circle class="space-draft-corner" ${index === 0 ? 'data-space-close' : ''}
        cx="${point.x}" cy="${point.y}" r="${(index === 0 && points.length > 2 ? 12 : 4) / factor}" />`));
      if (line.length > 1) {
        const start = line.at(-2), end = line.at(-1);
        parts.push(`<text class="space-live-length" x="${(start.x + end.x) / 2}" y="${(start.y + end.y) / 2 - 14 / factor}"
          text-anchor="middle" font-size="${font}">${lengthLabel(distance(start, end))}</text>`);
      }
    }
    svg.insertAdjacentHTML('beforeend', `<g data-space-overlay>${parts.join('')}</g>`);
    const status = document.querySelector('[data-space-status]');
    if (status) status.textContent = message || (edgeEdit
      ? '시작점 고정 · 다음 벽의 길이와 각도도 바뀝니다.'
      : mode === 'draw'
      ? `${points.length}개 모서리 · 점을 찍거나 벽을 끌어 그리세요`
      : '벽을 끌거나 모서리를 이동하세요. 치수를 누르면 길이를 바꿉니다.');
  }

  function reset() {
    mode = 'select';
    points = [];
    pointer = hover = preview = edgeEdit = null;
    shapeEditing = false;
    message = '';
  }

  function setMode(next) {
    cancelPointer();
    mode = next;
    edgeEdit = preview = null;
    points = [];
    hover = null;
    message = '';
    modeChanged();
    render();
  }

  function completeDrawing() {
    if (points.length < 3) return;
    try {
      createSpace(points);
      reset();
      shapeEditing = true;
      render();
    } catch (error) {
      message = error.message;
      refresh();
    }
  }

  function openEdge(index) {
    const zone = selected();
    if (!zone || zone.locked) return;
    const vertices = zonePoints(zone);
    edgeEdit = { id: zone.id, index, original: structuredClone(zone), fixed: 'start',
      length: Math.round(distance(vertices[index], vertices[(index + 1) % vertices.length]) * 10) / 10 };
    preview = null;
    message = '';
    render();
    document.querySelector('[data-edge-length]')?.focus({ preventScroll: true });
  }

  function previewLength() {
    const input = document.querySelector('[data-edge-length]');
    edgeEdit.length = Number(input.value);
    preview = setZoneEdgeLength(edgeEdit.original, edgeEdit.index, edgeEdit.length, edgeEdit.fixed);
    message = preview ? '' : '벽이 교차하거나 길이가 올바르지 않습니다.';
    input.setAttribute('aria-invalid', String(!preview));
    refresh();
  }

  function down(event) {
    if (!enabled() || (event.button !== undefined && event.button !== 0)) return;
    const vertex = event.target.closest('[data-space-vertex]');
    const wall = event.target.closest('[data-space-wall]');
    const dimension = event.target.closest('[data-space-edge]');
    if (mode === 'select' && !vertex && !wall && !dimension) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (dimension && !shapeEditing) {
      const point = worldPoint(event);
      const underneath = [...getLayout().zones].reverse().find(zone => pointInZone(point, zone));
      if (underneath && underneath.id !== selected()?.id) {
        edgeEdit = preview = null;
        selectSpace(event, underneath.id);
        return;
      }
    }
    if (!beginContact(event)) { cancelPointer(); return; }
    if (mode === 'pan') { startPan(event); return; }
    if (dimension) { openEdge(Number(dimension.dataset.spaceEdge)); return; }
    captureContact(event);
    getSvg().setPointerCapture(event.pointerId);
    if (mode === 'draw') {
      if (points.length > 2 && event.target.hasAttribute('data-space-close')) { completeDrawing(); return; }
      const count = points.length;
      const start = snapDrawingPoint(event);
      if (!count) points.push(start);
      hover = start;
      pointer = { id: event.pointerId, kind: 'draw', count, client: { x: event.clientX, y: event.clientY }, moved: false };
    } else {
      const original = selected();
      if (!original || original.locked) return;
      edgeEdit = null;
      pointer = { id: event.pointerId, kind: vertex ? 'vertex' : 'wall',
        index: Number(vertex ? vertex.dataset.spaceVertex : wall.dataset.spaceWall),
        original: structuredClone(original), start: worldPoint(event),
        client: { x: event.clientX, y: event.clientY }, moved: false };
    }
    refresh();
  }

  function move(event) {
    if (!pointer || pointer.id !== event.pointerId) {
      if (mode === 'draw' && !pointer && event.pointerType === 'mouse' && event.target.closest('#plan-canvas')) {
        hover = snapDrawingPoint(event); refresh();
      }
      return;
    }
    if (['pinch', 'idle-await-release'].includes(getGesture())) { cancelPointer(); return; }
    if (Math.hypot(event.clientX - pointer.client.x, event.clientY - pointer.client.y) >= (event.pointerType === 'touch' ? 10 : 4)) pointer.moved = true;
    if (pointer.kind === 'draw') hover = snapDrawingPoint(event);
    else {
      const point = worldPoint(event);
      if (pointer.kind === 'vertex') preview = moveZoneVertex(pointer.original, pointer.index, point);
      else {
        const vertices = zonePoints(pointer.original), start = vertices[pointer.index], end = vertices[(pointer.index + 1) % vertices.length];
        const length = distance(start, end), normal = { x: -(end.y - start.y) / length, y: (end.x - start.x) / length };
        const amount = (point.x - pointer.start.x) * normal.x + (point.y - pointer.start.y) * normal.y;
        preview = moveZoneEdge(pointer.original, pointer.index, { x: normal.x * amount, y: normal.y * amount });
      }
      message = preview ? '' : '벽이 교차하지 않는 위치로 옮겨주세요.';
    }
    refresh();
  }

  function up(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    const finished = pointer;
    pointer = null;
    if (['pinch', 'idle-await-release'].includes(getGesture())) {
      if (finished.kind === 'draw') points = points.slice(0, finished.count);
      preview = null; refresh(); return;
    }
    if (finished.kind === 'draw') {
      if (finished.count || finished.moved) {
        const next = hover ?? snapDrawingPoint(event);
        if (points.length > 2 && distance(next, points[0]) * scale() < 12) { completeDrawing(); return; }
        if (distance(next, points.at(-1)) >= 1) points.push(next);
      }
      hover = points.at(-1);
    } else if (finished.moved && preview) {
      const next = preview;
      preview = null;
      try { changeSpace(next); message = ''; }
      catch (error) { message = error.message; }
    } else preview = null;
    render();
  }

  function cancelPointer() {
    if (!pointer) return;
    if (pointer.kind === 'draw') points = points.slice(0, pointer.count);
    pointer = preview = null;
    hover = points.at(-1) ?? null;
    refresh();
  }

  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', cancelPointer);
  document.addEventListener('lostpointercapture', cancelPointer);

  return {
    get drawing() { return mode === 'draw'; },
    get editingShape() { return shapeEditing; },
    get hasPointer() { return Boolean(pointer); },
    reset, refresh, cancelPointer,
    startDrawing() { setMode('draw'); },
    toolbarMarkup() {
      return `<div class="space-drawing-toolbar" role="group" aria-label="공간 그리기 도구">
        ${[['select', '선택'], ['draw', '직접 그리기'], ['pan', '화면 이동']].map(([key, label]) =>
          `<button type="button" data-space-tool="${key}" aria-pressed="${mode === key}">${label}</button>`).join('')}
        ${mode === 'draw' ? `<button type="button" data-space-orthogonal aria-pressed="${orthogonal}">직각 맞춤</button>` : ''}
      </div>`;
    },
    selectionMarkup() {
      if (mode === 'draw') return `<section class="simple-selection space-drawing-selection">
        <p data-space-status role="status">${points.length}개 모서리 · 점을 찍거나 벽을 끌어 그리세요</p>
        <div><button type="button" data-space-finish ${points.length < 3 ? 'disabled' : ''}>공간 완성</button>
        <button type="button" data-space-back ${!points.length ? 'disabled' : ''}>한 점 취소</button>
        <button type="button" data-space-cancel>그리기 취소</button></div></section>`;
      if (!edgeEdit) return '';
      if (!getLayout().zones.some(zone => zone.id === edgeEdit.id)) { edgeEdit = preview = null; return ''; }
      return `<form class="simple-selection space-edge-editor" data-edge-form>
        <label>벽 ${edgeEdit.index + 1} 길이 <span>cm</span><input data-edge-length type="number" inputmode="decimal" min="0.1" step="0.1" value="${edgeEdit.length}" aria-label="벽 길이 cm" /></label>
        <button type="submit">치수 적용</button><button type="button" data-edge-cancel>취소</button>
        <p data-space-status>시작점 고정 · 다음 벽의 길이와 각도도 바뀝니다.</p>
      </form>`;
    },
    bind() {
      resizeObserver.disconnect();
      const svg = getSvg();
      if (!svg) return;
      svg.addEventListener('pointerdown', down, true);
      svg.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        const edge = event.target.closest('[data-space-edge]');
        if (edge) { event.preventDefault(); openEdge(Number(edge.dataset.spaceEdge)); }
      });
      document.querySelectorAll('[data-space-tool]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.spaceTool)));
      document.querySelector('[data-space-orthogonal]')?.addEventListener('click', () => { orthogonal = !orthogonal; render(); });
      document.querySelector('[data-space-finish]')?.addEventListener('click', completeDrawing);
      document.querySelector('[data-space-back]')?.addEventListener('click', () => { points.pop(); hover = points.at(-1); render(); });
      document.querySelector('[data-space-cancel]')?.addEventListener('click', () => setMode('select'));
      document.querySelector('[data-space-shape]')?.addEventListener('click', () => { shapeEditing = !shapeEditing; render(); });
      document.querySelector('[data-edge-length]')?.addEventListener('input', previewLength);
      document.querySelector('[data-edge-cancel]')?.addEventListener('click', () => { edgeEdit = preview = null; message = ''; render(); });
      document.querySelector('[data-edge-form]')?.addEventListener('submit', event => {
        event.preventDefault();
        previewLength();
        if (!preview) return;
        const next = preview;
        try {
          changeSpace(next);
          edgeEdit = preview = null;
          message = '';
          render();
        } catch (error) { message = error.message; refresh(); }
      });
      resizeObserver.observe(svg);
      refresh();
    },
    keydown(event) {
      if (event.key === 'Escape' && (mode !== 'select' || edgeEdit || pointer)) {
        event.preventDefault(); setMode('select'); return true;
      }
      if (mode === 'draw' && ['Backspace', 'Delete'].includes(event.key)) {
        event.preventDefault(); points.pop(); hover = points.at(-1); render(); return true;
      }
      if (mode === 'draw' && event.key === 'Enter') {
        event.preventDefault(); completeDrawing(); return true;
      }
      return false;
    },
  };
}
