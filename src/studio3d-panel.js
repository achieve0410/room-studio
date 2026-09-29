import { ROOM_ASSETS, ROOM_MATERIALS, roomAssetUrl } from './asset-library.js';
import { studioItemFromAsset, studioItemFromTemplate, studioStructureFromType, studioWallTargets } from './studio3d-edit.js';
import { snapDoorToWallSegments, zoneInteriorPoint, segmentFrame, structureAngle, pointInZone } from './geometry.js';

export function createStudioPanel({
  overlay,
  session,
  focus,
  onSelection,
  onResize,
  onUndo,
  onRedo,
  historyState,
  onError,
  onTransformMode,
  furnitureTemplates = [],
}) {
  const shell = document.createElement('aside');
  shell.className = 'studio3d-shell';
  shell.hidden = true;
  let revealed = false;
  let currentMode = 'dollhouse';
  shell.setAttribute('aria-label', '3D 가구와 구조 상세 편집');
  shell.innerHTML = `<div class="studio3d-panel-head"><button type="button" data-studio-toggle aria-expanded="false" aria-controls="studio3d-body"><span>편집 도구</span><strong data-studio-panel-title>가구 라이브러리</strong><svg class="studio3d-disclosure-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg></button><button type="button" data-studio-add aria-label="가구·구조 추가">추가</button><button type="button" data-studio-list aria-label="장면 목록 열기">목록</button><button type="button" data-studio-undo aria-label="3D 실행 취소">↶</button><button type="button" data-studio-redo aria-label="3D 다시 실행">↷</button></div>
    <div id="studio3d-body" class="studio3d-body" hidden>
      <section class="studio3d-catalog-view" data-studio-catalog-view aria-label="가구와 구조 추가">
        <div class="studio3d-catalog-controls">
          <div class="studio3d-tabs" role="tablist" aria-label="추가와 마감"><button role="tab" type="button" data-studio-tab="item" aria-controls="studio3d-catalog">가구</button><button role="tab" type="button" data-studio-tab="structure" aria-controls="studio3d-catalog">문·벽</button><button role="tab" type="button" data-studio-tab="floor" aria-controls="studio3d-catalog">바닥</button><button role="tab" type="button" data-studio-tab="wall" aria-controls="studio3d-catalog">벽 마감</button></div>
          <select class="studio3d-category" data-studio-category aria-label="추가와 마감 종류"><option value="item">가구</option><option value="structure">문·벽</option><option value="floor">바닥</option><option value="wall">벽 마감</option></select>
          <label class="studio3d-field studio3d-search" data-studio-search-field><span>가구 찾기</span><input data-studio-search type="search" placeholder="가구 이름 검색"></label>
        </div>
        <div id="studio3d-catalog" data-studio-catalog role="tabpanel"></div>
        <p class="studio3d-empty" data-studio-empty hidden>검색 결과가 없습니다. 다른 이름으로 찾아보세요.</p>
      </section>
      <section class="studio3d-inspector" data-studio-inspector aria-labelledby="studio3d-inspector-name" hidden>
        <header class="sr-only"><span data-studio-kind>선택 대상</span><h2 id="studio3d-inspector-name" data-studio-inspector-name></h2></header>
        <div class="studio3d-primary-fields" data-studio-primary-fields></div>
        <div class="studio3d-transform-tools" role="group" aria-label="선택 대상 조작"><button type="button" data-studio-transform="move">이동</button><button type="button" data-studio-transform="rotate">회전</button><button type="button" data-studio-transform="resize">크기</button></div>
        <div class="studio3d-appearance" data-studio-item-appearance><strong>재질</strong><div class="studio3d-swatches" data-studio-palettes aria-label="가구 주 재질"></div></div>
        <div class="studio3d-appearance" data-studio-zone-appearance><strong data-studio-finish-title>바닥 마감</strong><div class="studio3d-swatches" data-studio-finish-palettes></div></div>
        <label class="studio3d-field" data-studio-wall-field>붙일 벽<select data-studio-wall-target aria-label="문·창을 붙일 벽"></select></label>
        <p class="studio3d-hint" data-studio-wall-status></p>
        <div class="studio3d-nudges" data-studio-opening-tools><button type="button" data-studio-opening="0">닫기</button><button type="button" data-studio-opening="0.5">반 열기</button><button type="button" data-studio-opening="1">열기</button></div>
        <div class="studio3d-entity-actions"><button type="button" data-studio-duplicate>복제</button><button type="button" data-studio-lock>잠금</button><button type="button" data-studio-delete>삭제</button></div>
        <button type="button" data-studio-clear>선택 해제</button>
        <details class="studio3d-precision" data-studio-precision>
          <summary><span>정밀 배치 및 설정</span><small>좌표 · 높이 · 기타</small></summary>
          <div class="studio3d-precision-body">
            <p class="studio3d-hint">장면에서 끌어 미리 본 뒤 적용하세요. 문과 창은 선택한 벽에 맞춰집니다.</p>
            <div class="studio3d-coordinates" data-studio-fields></div>
            <div class="studio3d-nudges" role="group" aria-label="선택 대상 10cm 이동"><button type="button" data-studio-nudge="0,-10" aria-label="위로 10cm">↑</button><button type="button" data-studio-nudge="-10,0" aria-label="왼쪽으로 10cm">←</button><button type="button" data-studio-nudge="0,10" aria-label="아래로 10cm">↓</button><button type="button" data-studio-nudge="10,0" aria-label="오른쪽으로 10cm">→</button></div>
          </div>
        </details>
      </section>
      <details class="studio3d-target-alternative" data-studio-target-alternative>
        <summary>장면 목록</summary>
        <label class="studio3d-field"><span class="sr-only">3D 대상 선택</span><select data-studio-target aria-label="3D 대상 선택"></select></label>
      </details>
      <label class="studio3d-replace"><input type="checkbox" data-studio-replace> 선택 가구를 이 모델로 교체</label>
    </div>
    <div class="studio3d-footer">
      <div class="studio3d-selection" role="status" aria-live="polite"><strong data-studio-selection>가구 또는 공간 선택</strong><span data-studio-draft></span></div>
      <div class="studio3d-transform-tools studio3d-transform-compact" role="group" aria-label="선택 대상 빠른 조작"><button type="button" data-studio-transform="move">이동</button><button type="button" data-studio-transform="rotate">회전</button><button type="button" data-studio-transform="resize">크기</button></div>
      <div class="studio3d-transform-tools studio3d-finish-compact" role="group" aria-label="공간 마감 빠른 조작" hidden><button type="button" data-studio-finish-edit="floor">바닥 마감</button><button type="button" data-studio-finish-edit="wall">벽 마감</button><button type="button" data-studio-finish-clear>선택 해제</button></div>
      <p class="studio3d-empty-tools" data-studio-empty-tools hidden>추가에서 가구를 골라 공간에 놓아보세요.</p>
      <div class="studio3d-actions"><button type="button" data-studio-rotate>15° 회전</button><button type="button" data-studio-apply>적용</button><button type="button" data-studio-cancel>취소</button></div>
      <div class="studio3d-load" data-studio-error role="alert"></div>
      <div class="studio3d-asset-status"><div class="studio3d-load" data-studio-load role="status" aria-live="polite"></div><button type="button" data-studio-retry hidden>에셋 다시 불러오기</button></div>
    </div>`;
  overlay.append(shell);
  overlay.classList.add('has-studio3d');
  const $ = (selector) => shell.querySelector(selector);
  const body = $('.studio3d-body'),
    target = $('[data-studio-target]'),
    catalog = $('[data-studio-catalog]');
  let selection = focus && ['item', 'zone', 'structure'].includes(focus.kind) ? { ...focus } : null;
  let placementZoneId = focus?.kind === 'zone' ? focus.id : null;
  let deletedSelection = null;
  let transformMode = 'move';
  let showingCatalog = !selection;
  let catalogScrollTop = 0;
  let tab = 'item',
    catalogKey = '',
    assetBusy = false,
    assetFailed = false;
  const entity = () =>
    selection &&
    session.layout[{ item: 'items', zone: 'zones', structure: 'structures' }[selection.kind]].find(
      (item) => item.id === selection.id,
    );
  const zone = () => session.layout.zones.find(zone => zone.id === placementZoneId)
    ?? (selection?.kind === 'zone' ? entity() : entity() && session.layout.zones.find(zone => pointInZone(entity(), zone)))
    ?? session.layout.zones.find(zone => zone.type === '거실') ?? session.layout.zones[0];
  const patch = (updates) => {
    if (selection && entity()) run(() => {
      if (!session.preview({
        type: `update-${selection.kind}`,
        id: selection.id,
        updates,
      })) throw new Error('잠금을 해제하고 적용한 뒤 다시 편집하세요. 연결된 문·창의 잠금도 확인하세요.');
    });
  };
  const run = (fn) => {
    try {
      fn();
      $('[data-studio-error]').textContent = '';
      sync();
    } catch (error) {
      $('[data-studio-error]').textContent = `적용 실패 · ${error.message}`;
      onError?.(error);
      sync();
    }
  };
  const setOpen = (open) => {
    body.hidden = !open;
    $('[data-studio-toggle]').setAttribute('aria-expanded', String(open));
    shell.classList.toggle('is-expanded', open);
    onResize();
  };
  const setTransformMode = (mode) => {
    if (!['move', 'rotate', 'resize'].includes(mode)) throw new TypeError(`알 수 없는 변형 모드: ${mode}`);
    const current = entity();
    if (mode !== 'move' && (selection?.kind !== 'item' || current?.locked)) return;
    transformMode = mode;
    sync();
    onTransformMode?.(mode);
  };
  const select = (value) => {
    const wasShowingCatalog = showingCatalog;
    if (wasShowingCatalog && value) catalogScrollTop = body.scrollTop;
    const changed = selection?.id !== value?.id || selection?.kind !== value?.kind;
    if (changed) {
      session.cancel();
      transformMode = 'move';
    }
    selection = value;
    if (value?.kind === 'zone') placementZoneId = value.id;
    else if (entity()) placementZoneId = session.layout.zones.find(zone => pointInZone(entity(), zone))?.id ?? placementZoneId;
    deletedSelection = null;
    showingCatalog = !value;
    if (value?.kind === 'item') tab = 'item';
    else if (value?.kind === 'structure') tab = 'structure';
    else if (value?.kind === 'zone') tab = value.surface ?? (['item', 'structure'].includes(tab) ? 'floor' : tab);
    sync();
    if (value && (wasShowingCatalog || changed)) body.scrollTop = 0;
    onSelection(selection);
    if (changed) onTransformMode?.(transformMode);
  };
  const place = (kind, value) => {
    if (showingCatalog) catalogScrollTop = body.scrollTop;
    session.cancel();
    // onPreview synchronizes the panel, so establish selection after the entity exists.
    if (!session.preview({ type: `add-${kind}`, [kind]: value })) throw new Error('잠긴 벽에는 문·창을 추가할 수 없습니다.');
    selection = { kind, id: value.id };
    deletedSelection = null;
    transformMode = 'move';
    showingCatalog = false;
    sync();
    onSelection(selection);
    onTransformMode?.(transformMode);
    body.scrollTop = 0;
  };
  const roomPoint = () => {
    const room = zone();
    return zoneInteriorPoint(room);
  };
  const fields = [
    ['name', '이름', 'text', 'detail'],
    ['x', 'X cm', 'number', 'detail', -5000, 5000], ['y', 'Y cm', 'number', 'detail', -5000, 5000],
    ['rotation', '회전 °', 'number', 'item', -360, 360],
    ['width', '가로 cm', 'number', 'opening-item', 20, 600], ['depth', '세로 cm', 'number', 'item', 20, 600],
    ['height', '높이 H cm', 'number', 'detail', 1, 600], ['elevation', '바닥 Z cm', 'number', 'item', 0, 400],
    ['length', '벽 길이 cm', 'number', 'wall', 40, 2000], ['thickness', '벽 두께 cm', 'number', 'wall', 2, 12],
    ['sillHeight', '창턱 cm', 'number', 'window', 0, 550],
    ['orientation', '벽 방향', [['horizontal', '가로'], ['vertical', '세로']], 'wall'],
    ['doorType', '문 방식', [['swing', '여닫이'], ['sliding', '미닫이']], 'door'],
    ['hinge', '경첩', [['start', '시작 (왼쪽·위)'], ['end', '끝 (오른쪽·아래)']], 'swing'],
    ['openSide', '열림 방향', [[-1, '뒤쪽·오른쪽'], [1, '앞쪽·왼쪽']], 'swing'],
    ['openAngle', '열림 각도 °', 'number', 'swing', 0, 120],
    ['openRatio', '개방률 %', 'number', 'sliding', 0, 100],
    ['slideDirection', '미닫이 방향', [['start', '왼쪽·위'], ['end', '오른쪽·아래']], 'sliding'],
    ['shape', '형태', [['rect', '사각형'], ['roundRect', '둥근 사각형'], ['circle', '원'], ['ellipse', '타원']], 'legacy'],
    ['color', '색상', 'color', 'legacy'],
  ];
  fields.forEach(([key, label, type, scope, min, max]) => {
    const wrapper = document.createElement('label');
    wrapper.dataset.studioScope = scope;
    const input = document.createElement(Array.isArray(type) ? 'select' : 'input');
    input.dataset.studioValue = key;
    if (Array.isArray(type)) type.forEach(([value, text]) => input.add(new Option(text, value)));
    else {
      input.type = type;
      if (type === 'text') input.maxLength = 80;
      if (type === 'number') { input.step = '1'; input.min = min; input.max = max; input.inputMode = 'decimal'; }
    }
    wrapper.append(document.createTextNode(label), input);
    const primaryKeys = new Set(['width', 'depth', 'height', 'length', 'orientation', 'doorType', 'openAngle', 'openRatio']);
    $(primaryKeys.has(key) ? '[data-studio-primary-fields]' : '[data-studio-fields]').append(wrapper);
  });
  const swatch = (entry) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.studioMaterial = entry.id;
    const color = document.createElement('i');
    color.style.backgroundColor = entry.color;
    color.setAttribute('aria-hidden', 'true');
    button.append(color, document.createTextNode(entry.name));
    return button;
  };
  const palettes = $('[data-studio-palettes]');
  ROOM_MATERIALS.filter((entry) => entry.kind === 'palette').forEach((entry) => {
    const button = swatch(entry);
    button.addEventListener('click', () => patch({ materialId: entry.id }));
    palettes.append(button);
  });
  const finishPalettes = $('[data-studio-finish-palettes]');
  for (const entry of ROOM_MATERIALS.filter((material) => material.usage?.some((usage) => ['floor', 'wall'].includes(usage)))) {
    const button = swatch(entry);
    button.dataset.studioFinishUsage = entry.usage.join(' ');
    button.addEventListener('click', () => {
      const usage = selection?.surface ?? (['floor', 'wall'].includes(tab) ? tab : 'floor');
      patch({ [`${usage}MaterialId`]: entry.id });
    });
    finishPalettes.append(button);
  }
  const renderCatalog = () => {
    const key = tab;
    if (catalogKey === key) return;
    catalogKey = key;
    catalog.replaceChildren();
    if (tab === 'item') {
      catalog.className = 'studio3d-catalog';
      ROOM_ASSETS.forEach((asset) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'room-asset-card';
        card.dataset.studioAsset = asset.id;
        const image = document.createElement('img');
        image.src = roomAssetUrl(asset.thumbnailWebpPath);
        image.alt = '';
        image.loading = 'lazy';
        const name = document.createElement('strong');
        name.textContent = asset.name;
        const size = document.createElement('small');
        size.textContent = `${Math.round(asset.dimensions.width * 100)} × ${Math.round(asset.dimensions.depth * 100)} cm`;
        card.append(image, name, size);
        card.addEventListener('click', () => run(() => {
          if ($('[data-studio-replace]').checked && selection?.kind === 'item') {
            const current = entity();
            if (current.locked) return;
            const replacement = studioItemFromAsset(asset, current, current.id);
            patch({
              assetId: asset.id,
              name: asset.name,
              type: replacement.type,
              width: replacement.width,
              depth: replacement.depth,
              height: replacement.height,
              shape: replacement.shape,
              materialId: current.materialId ?? 'warm-oak',
            });
          } else {
            const room = zone();
            if (!room) return;
            const item = studioItemFromAsset(
              asset,
              zoneInteriorPoint(room),
              crypto.randomUUID(),
            );
            place('item', item);
          }
        }));
        catalog.append(card);
      });
      const legacyTemplates = furnitureTemplates.filter(template => !template.assetId);
      if (!legacyTemplates.some(template => template.type === 'custom')) {
        legacyTemplates.push({ type: 'custom', name: '커스텀 가구', width: 100, depth: 70, height: 80 });
      }
      legacyTemplates.forEach(template => {
        const card = document.createElement('button');
        card.type = 'button';
        card.dataset.studioTemplate = template.type;
        card.textContent = `${template.name} · ${template.width} × ${template.depth} cm`;
        card.addEventListener('click', () => run(() => place('item', studioItemFromTemplate(template, roomPoint(), crypto.randomUUID()))));
        catalog.append(card);
      });
    } else if (tab === 'structure') {
      catalog.className = 'studio3d-catalog';
      for (const [type, name] of [['wall', '벽 추가'], ['swing', '여닫이문 추가'], ['sliding', '미닫이문 추가'], ['window', '미닫이창 추가']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.studioStructure = type;
        button.textContent = name;
        button.addEventListener('click', () => run(() => {
          const selected = entity();
          const wall = selection?.kind === 'structure' && selected?.type === 'wall' ? selected : null;
          const value = studioStructureFromType(type, wall ?? roomPoint(), crypto.randomUUID(), wall?.height ?? session.layout.wallHeight);
          if (wall && type !== 'wall') value.wallId = wall.id;
          place('structure', value);
        }));
        catalog.append(button);
      }
    } else {
      catalog.className = 'studio3d-swatches';
      ROOM_MATERIALS.filter((entry) => entry.usage?.includes(tab)).forEach((entry) => {
        const button = swatch(entry);
        button.addEventListener('click', () => patch({ [`${tab}MaterialId`]: entry.id }));
        catalog.append(button);
      });
    }
  };
  const sync = () => {
    const current = entity();
    const deleting = session.action?.type === `delete-${selection?.kind}` && session.action.id === selection?.id;
    if (selection && !current && !deleting) {
      selection = null;
      showingCatalog = true;
      transformMode = 'move';
      onSelection(null);
      onTransformMode?.(transformMode);
    }
    const signature = JSON.stringify([
      session.layout.items.map((item) => [item.id, item.name]),
      session.layout.zones.map((item) => [item.id, item.name]),
      session.layout.structures.map((item) => [item.id, item.name]),
    ]);
    if (target.dataset.signature !== signature) {
      target.dataset.signature = signature;
      target.replaceChildren(new Option('대상 선택', ''));
      for (const [kind, list] of [
        ['item', session.layout.items],
        ['zone', session.layout.zones],
        ['structure', session.layout.structures],
      ])
        for (const item of list)
          target.add(new Option(`${{ item: '가구', zone: '공간', structure: '구조' }[kind]} · ${item.name}`, `${kind}:${item.id}`));
    }
    target.value = selection ? `${selection.kind}:${selection.id}` : '';
    shell.dataset.selectionId = selection?.id ?? '';
    shell.dataset.pending = String(session.pending);
    shell.dataset.view = showingCatalog ? 'catalog' : 'inspector';
    shell.dataset.catalogIdle = String(showingCatalog && !session.pending && !assetBusy && !assetFailed && !$('[data-studio-error]').textContent);
    $('[data-studio-catalog-view]').hidden = !showingCatalog;
    $('[data-studio-inspector]').hidden = showingCatalog || (!current && !deleting);
    $('[data-studio-panel-title]').textContent = showingCatalog ? '가구 라이브러리' : current?.name ?? '선택 상세';
    $('[data-studio-inspector-name]').textContent = current?.name ?? deletedSelection?.name ?? '';
    $('[data-studio-kind]').textContent = selection?.kind === 'item' ? '선택한 가구' : selection?.kind === 'zone' ? '선택한 공간 마감' : '선택한 구조';
    $('[data-studio-selection]').textContent = current
      ? `${current.locked ? '잠김 · ' : ''}${current.name}`
      : deleting ? `${deletedSelection?.name ?? '선택 대상'} · 삭제 미리보기` : '가구 · 문 · 공간 선택';
    $('[data-studio-draft]').textContent = session.pending ? '미저장 · 적용 또는 취소' : '';
    const detail = current && ['item', 'structure'].includes(selection?.kind);
    $('.studio3d-inspector .studio3d-transform-tools').hidden = !detail;
    const opening = selection?.kind === 'structure' && ['door', 'window'].includes(current?.type);
    shell.dataset.canRotate = String(Boolean(detail && !opening));
    $('.studio3d-transform-compact').hidden = !detail;
    $('.studio3d-finish-compact').hidden = selection?.kind !== 'zone' || !current;
    $('[data-studio-empty-tools]').hidden = Boolean(current);
    $('[data-studio-empty-tools]').textContent = deleting ? '변경을 적용하거나 취소하세요.' : '추가에서 가구를 골라 공간에 놓아보세요.';
    const swing = opening && current.type === 'door' && current.doorType !== 'sliding';
    const scopes = {
      detail, item: selection?.kind === 'item', 'opening-item': opening || selection?.kind === 'item',
      wall: selection?.kind === 'structure' && current?.type === 'wall',
      window: opening && current.type === 'window', door: opening && current.type === 'door',
      swing, sliding: opening && !swing, legacy: selection?.kind === 'item' && !current?.assetId,
    };
    shell.querySelectorAll('[data-studio-scope]').forEach(label => { label.hidden = !scopes[label.dataset.studioScope]; });
    shell.querySelectorAll('[data-studio-value]').forEach((input) => {
      if (document.activeElement !== input) {
        const value = current?.[input.dataset.studioValue] ?? 0;
        input.value = typeof value === 'number' ? Math.round(value * 100) / 100 : value;
      }
      input.disabled = !detail || Boolean(current?.locked);
      if (input.dataset.studioValue === 'width') { input.min = opening ? current.type === 'window' ? 60 : 50 : 20; input.max = opening ? current.type === 'window' ? 400 : 300 : 600; }
      if (input.dataset.studioValue === 'height') { input.min = selection?.kind === 'item' ? 1 : current?.type === 'window' ? 50 : 100; input.max = selection?.kind === 'item' ? 400 : 600; }
    });
    const wallTarget = $('[data-studio-wall-target]');
    $('[data-studio-wall-field]').hidden = !opening;
    $('[data-studio-wall-status]').hidden = !opening;
    if (opening) {
      const targets = studioWallTargets(session.layout);
      wallTarget.replaceChildren();
      targets.forEach((wall, index) => {
        const frame = segmentFrame(wall);
        const label = `${wall.name ?? `공간 벽 ${index + 1}`} · ${Math.round(frame.angle)}° · ${Math.round(frame.length)} cm`;
        const option = new Option(label, String(index));
        option.disabled = Boolean(wall.locked) || frame.length < current.width;
        wallTarget.add(option);
      });
      const owner = targets.findIndex(wall => {
        const placed = snapDoorToWallSegments(current, [wall], 0.01);
        return placed && (placed.wallId ?? null) === (current.wallId ?? null) && placed.orientation === current.orientation;
      });
      wallTarget.value = String(owner);
      wallTarget.disabled = Boolean(current.locked);
      $('[data-studio-wall-status]').textContent = owner < 0 ? '기존 직접 배치 · 이동하면 벽에 맞춥니다.' : `벽 연결됨 · ${Math.round(structureAngle(current))}°`;
    }
    $('[data-studio-opening-tools]').hidden = !opening;
    $('.studio3d-entity-actions').hidden = !detail;
    $('.studio3d-precision').hidden = !detail;
    shell.querySelectorAll('[data-studio-nudge], [data-studio-rotate]').forEach((button) => {
      button.disabled = !detail || Boolean(current?.locked) || (button.hasAttribute('data-studio-rotate') && opening);
    });
    shell.querySelectorAll('[data-studio-transform]').forEach((button) => {
      const furnitureOnly = button.dataset.studioTransform !== 'move';
      button.disabled = !detail || Boolean(current?.locked) || (furnitureOnly && selection?.kind !== 'item');
      button.setAttribute('aria-pressed', String(button.dataset.studioTransform === transformMode));
    });
    $('[data-studio-rotate]').textContent = scopes.wall ? '90° 회전' : '15° 회전';
    shell.querySelectorAll('[data-studio-delete], [data-studio-duplicate], [data-studio-opening]').forEach(button => {
      button.disabled = !detail || Boolean(current?.locked);
    });
    $('[data-studio-duplicate]').hidden = selection?.kind !== 'item';
    $('[data-studio-lock]').disabled = !detail;
    $('[data-studio-lock]').textContent = current?.locked ? '잠금 해제' : '잠금';
    $('[data-studio-lock]').setAttribute('aria-pressed', String(Boolean(current?.locked)));
    $('[data-studio-apply]').disabled = !session.pending || assetBusy || assetFailed;
    $('[data-studio-cancel]').disabled = !session.pending;
    const history = historyState?.();
    $('[data-studio-undo]').disabled = !onUndo || history?.canUndo === false;
    $('[data-studio-redo]').disabled = !onRedo || history?.canRedo === false;
    $('[data-studio-replace]').disabled = selection?.kind !== 'item' || Boolean(current?.locked);
    if ($('[data-studio-replace]').disabled) $('[data-studio-replace]').checked = false;
    $('.studio3d-replace').hidden = !showingCatalog || tab !== 'item' || selection?.kind !== 'item';
    $('[data-studio-search-field]').hidden = tab !== 'item';
    $('[data-studio-item-appearance]').hidden = selection?.kind !== 'item';
    palettes.querySelectorAll('button').forEach((button) => {
      button.disabled = selection?.kind !== 'item' || !current?.assetId || Boolean(current?.locked);
      button.setAttribute('aria-pressed', String(current?.materialId === button.dataset.studioMaterial));
    });
    const finishUsage = selection?.surface ?? (['floor', 'wall'].includes(tab) ? tab : 'floor');
    $('[data-studio-zone-appearance]').hidden = selection?.kind !== 'zone';
    $('[data-studio-finish-title]').textContent = finishUsage === 'wall' ? '벽 마감' : '바닥 마감';
    finishPalettes.setAttribute('aria-label', finishUsage === 'wall' ? '벽 마감' : '바닥 마감');
    finishPalettes.querySelectorAll('button').forEach((button) => {
      button.hidden = !button.dataset.studioFinishUsage.split(' ').includes(finishUsage);
      button.disabled = selection?.kind !== 'zone' || Boolean(current?.locked);
      button.setAttribute('aria-pressed', String(current?.[`${finishUsage}MaterialId`] === button.dataset.studioMaterial));
    });
    shell.querySelectorAll('[data-studio-tab]').forEach((button) => {
      const active = button.dataset.studioTab === tab;
      button.setAttribute('aria-selected', String(active));
      button.id = `studio3d-tab-${button.dataset.studioTab}`;
      button.tabIndex = active ? 0 : -1;
    });
    $('[data-studio-category]').value = tab;
    catalog.setAttribute('aria-labelledby', `studio3d-tab-${tab}`);
    renderCatalog();
    catalog.querySelectorAll('button').forEach((button) => {
      const active = button.dataset.studioAsset
        ? current?.assetId === button.dataset.studioAsset
        : button.dataset.studioMaterial
          ? current?.[`${tab}MaterialId`] === button.dataset.studioMaterial
          : button.dataset.studioTemplate ? selection?.kind === 'item' && !current?.assetId && current?.type === button.dataset.studioTemplate : false;
      button.setAttribute('aria-pressed', String(active));
      button.disabled =
        ['item', 'structure'].includes(tab)
          ? !session.layout.zones.length || ($('[data-studio-replace]').checked && Boolean(current?.locked))
          : selection?.kind !== 'zone' || Boolean(current?.locked);
      if (tab === 'item') button.hidden = !button.textContent.includes($('[data-studio-search]').value.trim());
    });
    const visibleCatalogItems = [...catalog.querySelectorAll('button')].filter((button) => !button.hidden).length;
    $('[data-studio-empty]').hidden = tab !== 'item' || visibleCatalogItems > 0;
  };
  target.addEventListener('change', () => {
    const [kind, ...id] = target.value.split(':');
    select(id.length ? { kind, id: id.join(':') } : null);
  });
  $('[data-studio-toggle]').addEventListener('click', () => setOpen(body.hidden));
  $('[data-studio-list]').addEventListener('click', () => {
    setOpen(true);
    $('[data-studio-target-alternative]').open = true;
    body.scrollTop = $('[data-studio-target-alternative]').offsetTop;
    target.focus({ preventScroll: true });
  });
  $('[data-studio-add]').addEventListener('click', () => {
    showingCatalog = true;
    sync();
    setOpen(true);
    body.scrollTop = catalogScrollTop;
  });
  $('[data-studio-clear]').addEventListener('click', () => select(null));
  $('[data-studio-finish-clear]').addEventListener('click', () => select(null));
  shell.querySelectorAll('[data-studio-finish-edit]').forEach(button => button.addEventListener('click', () => {
    select({ ...selection, surface: button.dataset.studioFinishEdit });
    setOpen(true);
  }));
  shell.querySelectorAll('[data-studio-transform]').forEach((button) =>
    button.addEventListener('click', () => setTransformMode(button.dataset.studioTransform)),
  );
  $('[data-studio-replace]').addEventListener('change', sync);
  const selectTab = (value) => {
    tab = value;
    if (['floor', 'wall'].includes(tab) && selection?.kind !== 'zone') {
      const room = zone();
      select(room ? { kind: 'zone', id: room.id, surface: tab } : null);
    } else sync();
  };
  shell.querySelectorAll('[data-studio-tab]').forEach(button => button.addEventListener('click', () => selectTab(button.dataset.studioTab)));
  $('[data-studio-category]').addEventListener('change', event => selectTab(event.target.value));
  shell.querySelectorAll('[data-studio-value]').forEach((input) =>
    input.addEventListener('change', () => {
      if (!input.value.trim() || !input.checkValidity()) { input.reportValidity(); return; }
      const numeric = input.type === 'number' || input.dataset.studioValue === 'openSide';
      patch({ [input.dataset.studioValue]: numeric ? Number(input.value) : input.value });
      input.value = entity()?.[input.dataset.studioValue] ?? input.value;
    }),
  );
  shell.querySelectorAll('[data-studio-nudge]').forEach((button) =>
    button.addEventListener('click', () => {
      const [x, y] = button.dataset.studioNudge.split(',').map(Number),
        current = entity();
      patch({ x: current.x + x, y: current.y + y });
    }),
  );
  $('[data-studio-rotate]').addEventListener('click', () => patch(selection?.kind === 'structure'
    ? { orientation: entity().orientation === 'horizontal' ? 'vertical' : 'horizontal' }
    : { rotation: ((entity()?.rotation ?? 0) + 15) % 360 }));
  $('[data-studio-search]').addEventListener('input', sync);
  $('[data-studio-wall-target]').addEventListener('change', event => {
    const wall = studioWallTargets(session.layout)[Number(event.target.value)];
    const placed = snapDoorToWallSegments(entity(), [wall], Infinity);
    if (placed) patch({ x: placed.x, y: placed.y, angle: structureAngle(placed), orientation: placed.orientation, wallId: placed.wallId });
  });
  shell.querySelectorAll('[data-studio-opening]').forEach(button => button.addEventListener('click', () => {
    const current = entity();
    const swing = current.type === 'door' && current.doorType !== 'sliding';
    patch({ [swing ? 'openAngle' : 'openRatio']: Number(button.dataset.studioOpening) * (swing ? 90 : 100) });
  }));
  $('[data-studio-duplicate]').addEventListener('click', () => run(() => {
    const current = entity();
    place('item', { ...structuredClone(current), id: crypto.randomUUID(), name: `${current.name} 복사`, x: current.x + 20, y: current.y + 20, locked: false });
  }));
  $('[data-studio-lock]').addEventListener('click', () => {
    if (!entity().locked && transformMode !== 'move') {
      transformMode = 'move';
      onTransformMode?.(transformMode);
    }
    patch({ locked: !entity().locked });
  });
  $('[data-studio-delete]').addEventListener('click', () => run(() => {
    deletedSelection = structuredClone(entity());
    if (!session.preview({ type: `delete-${selection.kind}`, id: selection.id }))
      throw new Error('잠긴 대상 또는 연결된 문·창은 삭제할 수 없습니다.');
  }));
  $('[data-studio-apply]').addEventListener('click', () => run(() => session.commit()));
  $('[data-studio-cancel]').addEventListener('click', () => {
    session.cancel();
    sync();
  });
  $('[data-studio-undo]').addEventListener('click', () =>
    run(() => {
      session.cancel();
      session.refresh(onUndo());
    }),
  );
  $('[data-studio-redo]').addEventListener('click', () =>
    run(() => {
      session.cancel();
      session.refresh(onRedo());
    }),
  );
  shell.addEventListener('keydown', (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      if (session.pending) {
        session.cancel();
        sync();
      } else {
        setOpen(false);
        $('[data-studio-toggle]').focus();
      }
    }
    if (event.target.matches('[role="tab"]') && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      const tabs = [...shell.querySelectorAll('[role="tab"]')];
      const index = tabs.indexOf(event.target);
      const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.click();
      next.focus();
    }
    if (event.key !== 'Tab') event.stopPropagation();
  });
  const media = window.matchMedia('(min-width: 901px) and (min-height: 601px)');
  const adapt = () => setOpen(media.matches);
  media.addEventListener('change', adapt);
  adapt();
  sync();
  onSelection(selection);
  let resizeFrame = 0;
  const resizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      overlay.style.setProperty('--studio-panel-height', `${shell.getBoundingClientRect().height}px`);
      onResize();
    });
  });
  resizeObserver.observe(shell);
  return {
    get selection() {
      return selection;
    },
    get current() {
      return entity();
    },
    get transformMode() {
      return transformMode;
    },
    get expanded() {
      return !body.hidden;
    },
    select,
    sync,
    setExpanded(open) {
      setOpen(Boolean(open));
    },
    setRoom(id) {
      placementZoneId = id;
    },
    setTransformMode,
    transform(updates) {
      patch(updates);
    },
    reveal() {
      revealed = true;
      shell.hidden = currentMode === 'walk';
    },
    move(x, y) {
      patch({ x, y });
    },
    commit() {
      if (!assetBusy && !assetFailed) run(() => session.commit());
    },
    cancel() {
      session.cancel();
      sync();
    },
    setMode(mode) {
      currentMode = mode;
      if (mode === 'walk') session.cancel();
      shell.hidden = !revealed || mode === 'walk';
      sync();
    },
    setAssets({ pending, errors }) {
      assetBusy = pending > 0;
      assetFailed = errors.length > 0;
      shell.dataset.assetState = errors.length ? 'error' : pending ? 'loading' : 'ready';
      $('[data-studio-load]').textContent = errors.length
        ? `에셋 로딩 실패 · ${errors.join(' / ')}`
        : pending
          ? `에셋 ${pending}개 불러오는 중`
          : '';
      $('[data-studio-retry]').hidden = !errors.length;
      sync();
    },
    onRetry(callback) {
      $('[data-studio-retry]').addEventListener('click', callback);
    },
    dispose() {
      resizeObserver.disconnect();
      cancelAnimationFrame(resizeFrame);
      media.removeEventListener('change', adapt);
      shell.remove();
    },
  };
}
