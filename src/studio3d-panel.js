import { ROOM_ASSETS, ROOM_MATERIALS, roomAssetUrl } from './asset-library.js';
import { studioItemFromAsset, studioItemFromTemplate, studioStructureFromType, studioWallTargets } from './studio3d-edit.js';
import { snapDoorToWallSegments } from './geometry.js';

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
  furnitureTemplates = [],
}) {
  const shell = document.createElement('aside');
  shell.className = 'studio3d-shell';
  shell.hidden = true;
  let revealed = false;
  let currentMode = 'dollhouse';
  shell.setAttribute('aria-label', '3D 가구와 구조 상세 편집');
  shell.innerHTML = `<div class="studio3d-panel-head"><button type="button" data-studio-toggle aria-expanded="false" aria-controls="studio3d-body">가구 · 문 · 상세</button><button type="button" data-studio-undo aria-label="3D 실행 취소">↶</button><button type="button" data-studio-redo aria-label="3D 다시 실행">↷</button></div>
    <div id="studio3d-body" class="studio3d-body" hidden>
      <label class="studio3d-field">장면에서 선택 또는 목록 선택<select data-studio-target aria-label="3D 대상 선택"></select></label>
      <p class="studio3d-hint">선택·끌기 또는 수치로 미리보기 → 적용. 문·창은 벽에 맞춰집니다. 빈 곳 드래그: 회전 · 위에서 보기: 화면 이동 · 두 손가락: 확대·이동</p>
      <div data-studio-item-tools>
        <div class="studio3d-coordinates" data-studio-fields></div>
        <label class="studio3d-field" data-studio-wall-field>붙일 벽<select data-studio-wall-target aria-label="문·창을 붙일 벽"></select></label>
        <p class="studio3d-hint" data-studio-wall-status></p>
        <div class="studio3d-nudges" role="group" aria-label="선택 대상 10cm 이동"><button type="button" data-studio-nudge="0,-10" aria-label="위로 10cm">↑</button><button type="button" data-studio-nudge="-10,0" aria-label="왼쪽으로 10cm">←</button><button type="button" data-studio-nudge="0,10" aria-label="아래로 10cm">↓</button><button type="button" data-studio-nudge="10,0" aria-label="오른쪽으로 10cm">→</button></div>
        <div class="studio3d-nudges" data-studio-opening-tools><button type="button" data-studio-opening="0">닫기</button><button type="button" data-studio-opening="0.5">반 열기</button><button type="button" data-studio-opening="1">열기</button></div>
        <div class="studio3d-entity-actions"><button type="button" data-studio-duplicate>복제</button><button type="button" data-studio-lock>잠금</button><button type="button" data-studio-delete>삭제</button></div>
      </div>
      <div class="studio3d-tabs" role="tablist" aria-label="추가와 마감"><button role="tab" type="button" data-studio-tab="item" aria-controls="studio3d-catalog">가구</button><button role="tab" type="button" data-studio-tab="structure" aria-controls="studio3d-catalog">문·벽</button><button role="tab" type="button" data-studio-tab="floor" aria-controls="studio3d-catalog">바닥</button><button role="tab" type="button" data-studio-tab="wall" aria-controls="studio3d-catalog">벽 마감</button></div>
      <div class="studio3d-swatches" data-studio-palettes aria-label="가구 주 재질"></div>
      <label class="studio3d-replace"><input type="checkbox" data-studio-replace> 선택 가구를 모델로 교체</label>
      <label class="studio3d-field" data-studio-search-field>가구 찾기<input data-studio-search type="search" placeholder="이름 검색"></label>
      <div id="studio3d-catalog" data-studio-catalog role="tabpanel"></div>
    </div>
    <div class="studio3d-selection" role="status" aria-live="polite"><strong data-studio-selection>가구 또는 공간 선택</strong><span data-studio-draft></span></div>
    <div class="studio3d-actions"><button type="button" data-studio-rotate>15° 회전</button><button type="button" data-studio-apply>적용</button><button type="button" data-studio-cancel>취소</button></div>
    <div class="studio3d-load" data-studio-error role="alert"></div>
    <div class="studio3d-load" data-studio-load role="status" aria-live="polite"></div><button type="button" data-studio-retry hidden>에셋 다시 불러오기</button>`;
  overlay.append(shell);
  overlay.classList.add('has-studio3d');
  const $ = (selector) => shell.querySelector(selector);
  const body = $('.studio3d-body'),
    target = $('[data-studio-target]'),
    catalog = $('[data-studio-catalog]');
  let selection = focus && ['item', 'zone', 'structure'].includes(focus.kind) ? { ...focus } : null;
  let deletedSelection = null;
  let tab = 'item',
    catalogKey = '',
    assetBusy = false,
    assetFailed = false;
  const entity = () =>
    selection &&
    session.layout[{ item: 'items', zone: 'zones', structure: 'structures' }[selection.kind]].find(
      (item) => item.id === selection.id,
    );
  const zone = () =>
    selection?.kind === 'zone'
      ? entity()
      : (session.layout.zones.find((z) => z.type === '거실') ?? session.layout.zones[0]);
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
  const select = (value) => {
    if (selection?.id !== value?.id || selection?.kind !== value?.kind) session.cancel();
    selection = value;
    deletedSelection = null;
    if (value?.kind === 'item') tab = 'item';
    else if (value?.kind === 'structure') tab = 'structure';
    else if (value?.kind === 'zone') tab = value.surface ?? (['item', 'structure'].includes(tab) ? 'floor' : tab);
    sync();
    onSelection(selection);
  };
  const place = (kind, value) => {
    session.cancel();
    // onPreview synchronizes the panel, so establish selection after the entity exists.
    if (!session.preview({ type: `add-${kind}`, [kind]: value })) throw new Error('잠긴 벽에는 문·창을 추가할 수 없습니다.');
    selection = { kind, id: value.id };
    deletedSelection = null;
    sync();
    onSelection(selection);
    body.scrollTop = 0;
  };
  const roomPoint = () => {
    const room = zone();
    return { x: room.x + room.width / 2, y: room.y + room.depth / 2 };
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
    $('[data-studio-fields]').append(wrapper);
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
              { x: room.x + room.width / 2, y: room.y + room.depth / 2 },
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
      onSelection(null);
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
    $('[data-studio-selection]').textContent = current
      ? `${current.locked ? '잠김 · ' : ''}${current.name}`
      : deleting ? `${deletedSelection?.name ?? '선택 대상'} · 삭제 미리보기` : '가구 · 문 · 공간 선택';
    $('[data-studio-draft]').textContent = session.pending ? '미저장 · 적용 또는 취소' : '';
    const detail = current && ['item', 'structure'].includes(selection?.kind);
    const opening = selection?.kind === 'structure' && ['door', 'window'].includes(current?.type);
    const swing = opening && current.type === 'door' && current.doorType !== 'sliding';
    const scopes = {
      detail, item: selection?.kind === 'item', 'opening-item': opening || selection?.kind === 'item',
      wall: selection?.kind === 'structure' && current?.type === 'wall',
      window: opening && current.type === 'window', door: opening && current.type === 'door',
      swing, sliding: opening && !swing, legacy: selection?.kind === 'item' && !current?.assetId,
    };
    $('[data-studio-item-tools]').hidden = !detail;
    shell.querySelectorAll('[data-studio-scope]').forEach(label => { label.hidden = !scopes[label.dataset.studioScope]; });
    shell.querySelectorAll('[data-studio-value]').forEach((input) => {
      if (document.activeElement !== input) input.value = current?.[input.dataset.studioValue] ?? 0;
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
        const horizontal = wall.orientation === 'horizontal';
        const label = `${wall.name ?? '공간 경계'} · ${horizontal ? '가로 Y' : '세로 X'} ${horizontal ? wall.y : wall.x} cm`;
        const option = new Option(label, String(index));
        option.disabled = Boolean(wall.locked) || (horizontal ? wall.x2 - wall.x1 : wall.y2 - wall.y1) < current.width;
        wallTarget.add(option);
      });
      const owner = targets.findIndex(wall => {
        const placed = snapDoorToWallSegments(current, [wall], 0.01);
        return placed && (placed.wallId ?? null) === (current.wallId ?? null) && placed.orientation === current.orientation;
      });
      wallTarget.value = String(owner);
      wallTarget.disabled = Boolean(current.locked);
      $('[data-studio-wall-status]').textContent = owner < 0 ? '기존 직접 배치 · 이동하면 벽에 맞춥니다.' : `벽 연결됨 · ${current.orientation === 'horizontal' ? '가로' : '세로'}`;
    }
    $('[data-studio-opening-tools]').hidden = !opening;
    shell.querySelectorAll('[data-studio-nudge], [data-studio-rotate]').forEach((button) => {
      button.disabled = !detail || Boolean(current?.locked) || (button.hasAttribute('data-studio-rotate') && opening);
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
    $('.studio3d-replace').hidden = tab !== 'item';
    $('[data-studio-search-field]').hidden = tab !== 'item';
    palettes.hidden = tab !== 'item';
    palettes.querySelectorAll('button').forEach((button) => {
      button.disabled = selection?.kind !== 'item' || !current?.assetId || Boolean(current?.locked);
      button.setAttribute('aria-pressed', String(current?.materialId === button.dataset.studioMaterial));
    });
    shell.querySelectorAll('[data-studio-tab]').forEach((button) => {
      const active = button.dataset.studioTab === tab;
      button.setAttribute('aria-selected', String(active));
      button.id = `studio3d-tab-${button.dataset.studioTab}`;
      button.tabIndex = active ? 0 : -1;
    });
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
  };
  target.addEventListener('change', () => {
    const [kind, ...id] = target.value.split(':');
    select(id.length ? { kind, id: id.join(':') } : null);
  });
  $('[data-studio-toggle]').addEventListener('click', () => setOpen(body.hidden));
  $('[data-studio-replace]').addEventListener('change', sync);
  shell.querySelectorAll('[data-studio-tab]').forEach((button) =>
    button.addEventListener('click', () => {
      tab = button.dataset.studioTab;
      if (['floor', 'wall'].includes(tab) && selection?.kind !== 'zone') {
        const room = zone();
        select(room ? { kind: 'zone', id: room.id, surface: tab } : null);
      } else sync();
    }),
  );
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
    if (placed) patch({ x: placed.x, y: placed.y, orientation: placed.orientation, wallId: placed.wallId });
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
  $('[data-studio-lock]').addEventListener('click', () => patch({ locked: !entity().locked }));
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
    select,
    sync,
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
