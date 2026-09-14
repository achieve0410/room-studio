import { ROOM_ASSETS, ROOM_MATERIALS, roomAssetUrl } from './asset-library.js';
import { studioItemFromAsset } from './studio3d-edit.js';

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
}) {
  const shell = document.createElement('aside');
  shell.className = 'studio3d-shell';
  shell.hidden = true;
  let revealed = false;
  let currentMode = 'dollhouse';
  shell.setAttribute('aria-label', '3D 가구와 마감 편집');
  shell.innerHTML = `<div class="studio3d-panel-head"><button type="button" data-studio-toggle aria-expanded="false" aria-controls="studio3d-body">가구 · 마감</button><button type="button" data-studio-undo aria-label="3D 실행 취소">↶</button><button type="button" data-studio-redo aria-label="3D 다시 실행">↷</button></div>
    <div id="studio3d-body" class="studio3d-body" hidden>
      <label class="studio3d-field">장면에서 선택 또는 목록 선택<select data-studio-target aria-label="3D 대상 선택"></select></label>
      <p class="studio3d-hint"><span>가구를 끌어 이동하세요.</span><span>수치·재질을 바꾼 뒤 적용하세요.</span><span>빈 곳 드래그: 회전</span><span>상공/Shift 드래그: 화면 이동</span><span>휠: 확대 · 두 손가락: 확대·이동</span></p>
      <div data-studio-item-tools>
        <div class="studio3d-coordinates"><label>X cm<input data-studio-value="x" type="number" step="1"></label><label>Y cm<input data-studio-value="y" type="number" step="1"></label><label>회전 °<input data-studio-value="rotation" type="number" step="1"></label></div>
        <div class="studio3d-nudges" role="group" aria-label="가구 10cm 이동"><button type="button" data-studio-nudge="0,-10" aria-label="가구 위로 10cm">↑</button><button type="button" data-studio-nudge="-10,0" aria-label="가구 왼쪽 10cm">←</button><button type="button" data-studio-nudge="0,10" aria-label="가구 아래로 10cm">↓</button><button type="button" data-studio-nudge="10,0" aria-label="가구 오른쪽 10cm">→</button></div>
      </div>
      <div class="studio3d-tabs" role="tablist" aria-label="가구와 마감"><button role="tab" type="button" data-studio-tab="item" aria-controls="studio3d-catalog">가구</button><button role="tab" type="button" data-studio-tab="floor" aria-controls="studio3d-catalog">바닥</button><button role="tab" type="button" data-studio-tab="wall" aria-controls="studio3d-catalog">벽</button></div>
      <div class="studio3d-swatches" data-studio-palettes aria-label="가구 주 재질"></div>
      <label class="studio3d-replace"><input type="checkbox" data-studio-replace> 선택 가구를 모델로 교체</label>
      <div id="studio3d-catalog" data-studio-catalog role="tabpanel"></div>
    </div>
    <div class="studio3d-selection"><strong data-studio-selection>가구 또는 공간 선택</strong><span data-studio-draft></span></div>
    <div class="studio3d-actions"><button type="button" data-studio-rotate>15° 회전</button><button type="button" data-studio-apply>적용</button><button type="button" data-studio-cancel>취소</button></div>
    <div class="studio3d-load" data-studio-error role="alert"></div>
    <div class="studio3d-load" data-studio-load role="status" aria-live="polite"></div><button type="button" data-studio-retry hidden>에셋 다시 불러오기</button>`;
  overlay.append(shell);
  overlay.classList.add('has-studio3d');
  const $ = (selector) => shell.querySelector(selector);
  const body = $('.studio3d-body'),
    target = $('[data-studio-target]'),
    catalog = $('[data-studio-catalog]');
  let selection = focus && ['item', 'zone'].includes(focus.kind) ? { ...focus } : null;
  let tab = 'item',
    catalogKey = '',
    assetBusy = false,
    assetFailed = false;
  const entity = () =>
    selection &&
    (selection.kind === 'item' ? session.layout.items : session.layout.zones).find(
      (item) => item.id === selection.id,
    );
  const zone = () =>
    selection?.kind === 'zone'
      ? entity()
      : (session.layout.zones.find((z) => z.type === '거실') ?? session.layout.zones[0]);
  const patch = (updates) => {
    if (selection && entity() && !entity().locked) {
      session.preview({
        type: selection.kind === 'item' ? 'update-item' : 'update-zone',
        id: selection.id,
        updates,
      });
      sync();
    }
  };
  const run = (fn) => {
    try {
      fn();
      $('[data-studio-error]').textContent = '';
      sync();
    } catch (error) {
      $('[data-studio-error]').textContent = `적용 실패 · ${error.message}`;
      onError(error);
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
    if (value?.kind === 'item') tab = 'item';
    else if (value?.kind === 'zone') tab = value.surface ?? (tab === 'item' ? 'floor' : tab);
    sync();
    onSelection(selection);
  };
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
        card.addEventListener('click', () => {
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
            session.cancel();
            selection = { kind: 'item', id: item.id };
            session.preview({ type: 'add-item', item });
            sync();
            onSelection(selection);
          }
        });
        catalog.append(card);
      });
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
    if (selection && !current) {
      selection = null;
      onSelection(null);
    }
    const signature = JSON.stringify([
      session.layout.items.map((item) => [item.id, item.name]),
      session.layout.zones.map((item) => [item.id, item.name]),
    ]);
    if (target.dataset.signature !== signature) {
      target.dataset.signature = signature;
      target.replaceChildren(new Option('대상 선택', ''));
      for (const [kind, list] of [
        ['item', session.layout.items],
        ['zone', session.layout.zones],
      ])
        for (const item of list)
          target.add(new Option(`${kind === 'item' ? '가구' : '공간'} · ${item.name}`, `${kind}:${item.id}`));
    }
    target.value = selection ? `${selection.kind}:${selection.id}` : '';
    shell.dataset.selectionId = selection?.id ?? '';
    shell.dataset.pending = String(session.pending);
    $('[data-studio-selection]').textContent = current
      ? `${current.locked ? '잠김 · ' : ''}${current.name}`
      : '가구 또는 공간 선택';
    $('[data-studio-draft]').textContent = session.pending ? '미리보기 · 미저장' : '';
    $('[data-studio-item-tools]').hidden = selection?.kind !== 'item';
    shell.querySelectorAll('[data-studio-value]').forEach((input) => {
      if (document.activeElement !== input) input.value = current?.[input.dataset.studioValue] ?? 0;
      input.disabled = Boolean(current?.locked);
    });
    shell.querySelectorAll('[data-studio-nudge], [data-studio-rotate]').forEach((button) => {
      button.disabled = selection?.kind !== 'item' || Boolean(current?.locked);
    });
    $('[data-studio-apply]').disabled = !session.pending || assetBusy || assetFailed;
    $('[data-studio-cancel]').disabled = !session.pending;
    const history = historyState?.();
    $('[data-studio-undo]').disabled = !onUndo || history?.canUndo === false;
    $('[data-studio-redo]').disabled = !onRedo || history?.canRedo === false;
    $('[data-studio-replace]').disabled = selection?.kind !== 'item' || Boolean(current?.locked);
    if ($('[data-studio-replace]').disabled) $('[data-studio-replace]').checked = false;
    $('.studio3d-replace').hidden = tab !== 'item';
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
        : current?.[`${tab}MaterialId`] === button.dataset.studioMaterial;
      button.setAttribute('aria-pressed', String(active));
      button.disabled =
        tab === 'item'
          ? !session.layout.zones.length || ($('[data-studio-replace]').checked && Boolean(current?.locked))
          : selection?.kind !== 'zone' || Boolean(current?.locked);
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
      if (tab !== 'item' && selection?.kind !== 'zone') {
        const room = zone();
        select(room ? { kind: 'zone', id: room.id, surface: tab } : null);
      } else sync();
    }),
  );
  shell.querySelectorAll('[data-studio-value]').forEach((input) =>
    input.addEventListener('change', () => {
      if (input.value.trim() && Number.isFinite(input.valueAsNumber))
        patch({ [input.dataset.studioValue]: input.valueAsNumber });
      else sync();
    }),
  );
  shell.querySelectorAll('[data-studio-nudge]').forEach((button) =>
    button.addEventListener('click', () => {
      const [x, y] = button.dataset.studioNudge.split(',').map(Number),
        current = entity();
      patch({ x: current.x + x, y: current.y + y });
    }),
  );
  $('[data-studio-rotate]').addEventListener('click', () =>
    patch({ rotation: ((entity()?.rotation ?? 0) + 15) % 360 }),
  );
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
      const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3];
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
      media.removeEventListener('change', adapt);
      shell.remove();
    },
  };
}
