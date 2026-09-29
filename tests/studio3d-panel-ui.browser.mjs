import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer as reservePort } from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { captureRoomScene, settleBrowserPaint } from './browser-rendering.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.STUDIO3D_UI_OUTPUT ?? join(root, '.omx/artifacts/studio3d-panel-ui'));
await mkdir(output, { recursive: true });
const port = await new Promise((done, reject) => {
  const reservation = reservePort();
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', () => {
    const { port } = reservation.address();
    reservation.close(() => done(port));
  });
});
const server = await createServer({
  root,
  cacheDir: join(output, 'vite-cache'),
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/.omx/**'] } },
});
const report = { output, checks: [], screenshots: [], errors: [] };
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true, args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', hasTouch: true });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('room-studio-layout-v2', JSON.stringify({
    zones: [{ id: 'room', name: '거실', type: '거실', x: 0, y: 0, width: 500, depth: 400, height: 240 }],
    items: [], structures: [], wallHeight: 240,
  })));
  await page.goto(server.resolvedUrls.local[0]);
  await settleBrowserPaint(page);
  const unselected = await page.evaluate(() => ({
    canvas: document.querySelector('.canvas-wrap').getBoundingClientRect().toJSON(),
    room: document.querySelector('.plan-zone').getBoundingClientRect().toJSON(),
    slot: document.querySelector('.workspace-hint').getBoundingClientRect().toJSON(),
  }));
  await page.evaluate(() => {
    window.__spaceSelected = new Promise((done, reject) => {
      const observer = new MutationObserver(check);
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('space selection timeout')); }, 10000);
      function check() {
        if (document.querySelector('.simple-selection')) { clearTimeout(timeout); observer.disconnect(); done(); }
      }
      observer.observe(document.querySelector('#app'), { subtree: true, childList: true });
      check();
    });
  });
  await page.locator('.plan-zone').click();
  await page.evaluate(() => window.__spaceSelected);
  const selected = await page.evaluate(() => ({
    canvas: document.querySelector('.canvas-wrap').getBoundingClientRect().toJSON(),
    room: document.querySelector('.plan-zone').getBoundingClientRect().toJSON(),
    slot: document.querySelector('.simple-selection').getBoundingClientRect().toJSON(),
  }));
  assert.equal(selected.slot.height, unselected.slot.height, JSON.stringify({ unselected, selected }));
  assert.equal(selected.canvas.height, unselected.canvas.height, JSON.stringify({ unselected, selected }));
  assert.ok(Math.abs(selected.room.top - unselected.room.top) <= 0.5, JSON.stringify({ unselected, selected }));
  report.checks.push('mobile simple selection uses a stable reserved slot and does not shift room projection');

  await page.setViewportSize({ width: 1440, height: 1000 });
  const armStudioReady = () => page.evaluate(() => {
    window.__studioUiReady = new Promise((done, reject) => {
      const observer = new MutationObserver(check);
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('studio ready timeout')); }, 20000);
      function check() {
        const overlay = document.querySelector('[data-walkthrough]');
        if (overlay?.dataset.studioReady === 'true' && overlay.dataset.assetState === 'ready') {
          clearTimeout(timeout); observer.disconnect(); done();
        }
      }
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
      check();
    });
  });
  await armStudioReady();
  await page.locator('#open-walkthrough').click();
  await page.evaluate(() => window.__studioUiReady);

  const armPanelState = state => page.evaluate(expected => {
    window.__panelState = new Promise((done, reject) => {
      const shell = document.querySelector('.studio3d-shell');
      const observer = new MutationObserver(check);
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`panel state timeout: ${expected}`)); }, 10000);
      function check() {
        if (shell.dataset.view === expected.view
          && (expected.pending === undefined || shell.dataset.pending === String(expected.pending))
          && (expected.asset === undefined || shell.dataset.assetState === expected.asset)) {
          clearTimeout(timeout); observer.disconnect(); done();
        }
      }
      observer.observe(shell, { subtree: true, attributes: true, childList: true });
      check();
    });
  }, state);
  const bounds = () => page.evaluate(() => {
    const stage = document.querySelector('[data-walkthrough-stage]').getBoundingClientRect();
    const panel = document.querySelector('.studio3d-shell').getBoundingClientRect();
    const body = document.querySelector('.studio3d-body').getBoundingClientRect();
    const actions = document.querySelector('.studio3d-actions').getBoundingClientRect();
    return {
      stage: stage.toJSON(), panel: panel.toJSON(), body: body.toJSON(), actions: actions.toJSON(),
      separate: stage.bottom <= panel.top + 1 || stage.right <= panel.left + 1,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  const openCatalog = async () => {
    if (await page.locator('[data-studio-add]:visible').count()) {
      await armPanelState({ view: 'catalog' });
      await page.locator('[data-studio-add]').click();
      await page.evaluate(() => window.__panelState);
    }
  };
  const chooseCategory = async value => {
    if (await page.locator('[data-studio-category]').isVisible()) {
      await page.locator('[data-studio-category]').selectOption(value);
    } else await page.locator(`[data-studio-tab="${value}"]`).click();
  };
  const selectTarget = async value => {
    await armPanelState({ view: 'inspector' });
    await page.locator('[data-studio-list]').click();
    await page.locator('[data-studio-target]').selectOption(value);
    await page.evaluate(() => window.__panelState);
  };
  const capture = async name => {
    await captureRoomScene(page, join(output, name));
    report.screenshots.push(name);
  };

  await page.locator('[data-studio-clear]').click();
  assert.equal(await page.locator('.studio3d-shell').getAttribute('data-view'), 'catalog');
  assert.equal(await page.locator('[data-studio-catalog-view]').isVisible(), true);
  assert.equal(await page.locator('[data-studio-inspector]').isHidden(), true);
  const catalogOrder = await page.evaluate(() => {
    const card = document.querySelector('[data-studio-asset]').getBoundingClientRect();
    const target = document.querySelector('[data-studio-target-alternative]').getBoundingClientRect();
    return { cardTop: card.top, targetTop: target.top };
  });
  assert.ok(catalogOrder.cardTop < catalogOrder.targetTop, JSON.stringify(catalogOrder));
  await page.evaluate(() => { document.querySelector('.studio3d-body').scrollTop = 80; });
  const rememberedScroll = await page.locator('.studio3d-body').evaluate(node => node.scrollTop);
  assert.ok(rememberedScroll > 0);
  await capture('desktop-1440x1000-catalog.png');

  await armPanelState({ view: 'inspector', pending: true });
  await page.locator('[data-studio-asset]:visible').first().click();
  await page.evaluate(() => window.__panelState);
  const itemOption = await page.locator('[data-studio-target] option').evaluateAll(options => options.find(option => option.textContent.startsWith('가구 · '))?.value);
  assert.ok(itemOption);
  const inspector = await page.evaluate(() => {
    const primary = document.querySelector('[data-studio-primary-fields]').getBoundingClientRect();
    const precision = document.querySelector('[data-studio-precision]').getBoundingClientRect();
    const fields = [...document.querySelectorAll('[data-studio-primary-fields] [data-studio-value]')].filter(input => !input.closest('[hidden]')).map(input => input.dataset.studioValue);
    return {
      primaryTop: primary.top, precisionTop: precision.top, fields,
      materialVisible: document.querySelector('[data-studio-item-appearance]').getClientRects().length > 0,
      nativeButtons: [...document.querySelectorAll('[data-studio-transform]')].every(node => node.tagName === 'BUTTON'),
    };
  });
  assert.ok(inspector.primaryTop < inspector.precisionTop, JSON.stringify(inspector));
  assert.deepEqual(inspector.fields, ['width', 'depth', 'height']);
  assert.equal(inspector.materialVisible, true);
  assert.equal(inspector.nativeButtons, true);
  await capture('desktop-1440x1000-pending.png');

  await page.locator('[data-studio-apply]').click();
  assert.equal(await page.locator('.studio3d-shell').getAttribute('data-pending'), 'false');
  assert.equal(await page.locator('[data-studio-undo]').isEnabled(), true);
  await capture('desktop-1440x1000-selected.png');

  const selectedPalette = page.locator('[data-studio-item-appearance] [aria-pressed="true"]');
  const paletteColors = await selectedPalette.evaluate(node => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, color: style.color };
  });
  await selectedPalette.hover();
  await selectedPalette.evaluate(async node => {
    await Promise.all(node.getAnimations().map(animation => animation.finished));
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  assert.equal(await selectedPalette.evaluate(node => node.matches(':hover')), true);
  await page.screenshot({ path: join(output, 'desktop-selected-palette-hover.png') });
  report.screenshots.push('desktop-selected-palette-hover.png');
  assert.deepEqual(await selectedPalette.evaluate(node => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, color: style.color };
  }), paletteColors, 'selected material retains its readable selected colors on hover');
  report.checks.push('selected material remains visually selected and readable while hovered');

  await page.locator('[data-studio-transform="rotate"]').first().click();
  assert.equal(await page.locator('[data-studio-transform="rotate"]').first().getAttribute('aria-pressed'), 'true');
  await page.locator('[data-studio-list]').click();
  await page.locator('[data-studio-target]').selectOption(itemOption);
  assert.equal(await page.locator('[data-studio-transform="rotate"]').first().getAttribute('aria-pressed'), 'true');
  await page.locator('[data-studio-lock]').click();
  assert.equal(await page.locator('.studio3d-shell').getAttribute('data-pending'), 'true');
  assert.equal(await page.locator('[data-studio-transform="move"]').first().getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-studio-transform="rotate"]').first().isDisabled(), true);
  assert.equal(await page.locator('[data-studio-value="width"]').isDisabled(), true);
  await page.locator('[data-studio-cancel]').click();
  assert.equal(await page.locator('[data-studio-value="width"]').isEnabled(), true);
  report.checks.push('furniture inspector prioritizes name, size, material, and native transform controls; locks disable editing');

  await openCatalog();
  assert.equal(await page.locator('.studio3d-body').evaluate(node => node.scrollTop), rememberedScroll);
  await page.locator('[data-studio-search]').fill('소파');
  await selectTarget(itemOption);
  await openCatalog();
  assert.equal(await page.locator('[data-studio-search]').inputValue(), '소파');
  report.checks.push('catalog search and scroll state survive inspector switching');

  const pointerSelectionBefore = await bounds();
  const wasExpanded = await page.locator('[data-studio-toggle]').getAttribute('aria-expanded');
  await armPanelState({ view: 'inspector' });
  const stageBox = await page.locator('[data-walkthrough-stage]').boundingBox();
  await page.mouse.click(stageBox.x + stageBox.width * 0.5, stageBox.y + stageBox.height * 0.37);
  await page.evaluate(() => window.__panelState);
  const pointerSelectionAfter = await bounds();
  assert.equal(await page.locator('[data-studio-toggle]').getAttribute('aria-expanded'), wasExpanded);
  assert.equal(pointerSelectionAfter.panel.width, pointerSelectionBefore.panel.width);
  assert.equal(pointerSelectionAfter.stage.width, pointerSelectionBefore.stage.width);
  assert.equal(pointerSelectionAfter.stage.height, pointerSelectionBefore.stage.height);
  report.checks.push('canvas pointer selection neither auto-expands the panel nor changes stage dimensions');

  const awaitPanelLayout = () => page.evaluate(() => new Promise((done, reject) => {
    const shell = document.querySelector('.studio3d-shell');
    const stage = document.querySelector('[data-walkthrough-stage]');
    const observer = new ResizeObserver(check);
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`panel layout timeout: ${JSON.stringify({
        viewport: [innerWidth, innerHeight], expanded: shell.classList.contains('is-expanded'),
        panel: shell.getBoundingClientRect().toJSON(), stage: stage.getBoundingClientRect().toJSON(),
      })}`));
    }, 10000);
    function check() {
      const stageRect = stage.getBoundingClientRect();
      const panelRect = shell.getBoundingClientRect();
      const minimumHeight = innerWidth < innerHeight && innerHeight < 700 ? innerHeight * 0.4 - 1 : 250;
      if (shell.classList.contains('is-expanded') && panelRect.height > minimumHeight
        && (innerWidth > innerHeight || stageRect.width === innerWidth)
        && (stageRect.bottom <= panelRect.top + 1 || stageRect.right <= panelRect.left + 1)) {
        clearTimeout(timeout); observer.disconnect(); done();
      }
    }
    observer.observe(shell); observer.observe(stage); check();
  }));

  const viewports = [
    { width: 320, height: 568, name: 'compact-320x568' },
    { width: 375, height: 812, name: 'portrait-375x812' },
    { width: 390, height: 844, name: 'portrait-390x844' },
    { width: 768, height: 1024, name: 'tablet-768x1024' },
    { width: 844, height: 390, name: 'landscape-844x390' },
  ];
  for (const viewport of viewports) {
    await page.evaluate(desktop => {
      const media = matchMedia('(min-width: 901px) and (min-height: 601px)');
      window.__panelModeReady = new Promise((done, reject) => {
        if (media.matches === desktop) { done(); return; }
        const timeout = setTimeout(() => { media.removeEventListener('change', onChange); reject(new Error('Panel responsive mode did not change')); }, 10000);
        const onChange = () => { clearTimeout(timeout); done(); };
        media.addEventListener('change', onChange, { once: true });
      });
    }, viewport.width > 900 && viewport.height > 600);
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.__panelModeReady);
    if (await page.locator('[data-studio-toggle]').getAttribute('aria-expanded') === 'false') await page.locator('[data-studio-toggle]').click();
    await awaitPanelLayout();
    await openCatalog();
    await chooseCategory('item');
    await page.locator('[data-studio-search]').fill('');
    await page.locator('.studio3d-body').evaluate(node => { node.scrollTop = 0; });
    const catalogBounds = await bounds();
    const visibleCards = await page.evaluate(() => {
      const body = document.querySelector('.studio3d-body').getBoundingClientRect();
      return [...document.querySelectorAll('[data-studio-asset]:not([hidden])')].filter(node => {
        const card = node.getBoundingClientRect();
        return card.top >= body.top && card.bottom <= body.bottom;
      }).length;
    });
    assert.ok(visibleCards >= 2, `Complete catalog cards must stay visible: ${visibleCards}`);
    assert.equal(await page.locator('[data-studio-apply]').isHidden(), true);
    await capture(`${viewport.name}-catalog.png`);
    await selectTarget(itemOption);
    const selectedBounds = await bounds();
    const widthBounds = await page.locator('[data-studio-value="width"]').boundingBox();
    assert.ok(widthBounds.y >= selectedBounds.body.top
      && widthBounds.y + widthBounds.height <= selectedBounds.body.bottom,
    'Furniture size is visible immediately without scrolling the inspector');
    await capture(`${viewport.name}-selected.png`);
    assert.equal(selectedBounds.panel.width, catalogBounds.panel.width, JSON.stringify({ catalogBounds, selectedBounds }));
    assert.equal(selectedBounds.panel.height, catalogBounds.panel.height, JSON.stringify({ catalogBounds, selectedBounds }));
    assert.equal(selectedBounds.stage.width, catalogBounds.stage.width, JSON.stringify({ catalogBounds, selectedBounds }));
    assert.equal(selectedBounds.stage.height, catalogBounds.stage.height, JSON.stringify({ catalogBounds, selectedBounds }));

    await armPanelState({ view: 'inspector', pending: true });
    const width = page.locator('[data-studio-value="width"]');
    await width.fill(String(Number(await width.inputValue()) + 10));
    await width.press('Tab');
    await page.evaluate(() => window.__panelState);
    await capture(`${viewport.name}-pending.png`);
    const pendingBounds = await bounds();
    assert.equal(pendingBounds.panel.height, selectedBounds.panel.height, JSON.stringify({ selectedBounds, pendingBounds }));
    assert.equal(pendingBounds.separate, true, JSON.stringify(pendingBounds));
    assert.equal(pendingBounds.overflow, false, JSON.stringify(pendingBounds));
    assert.ok(pendingBounds.actions.top >= 0 && pendingBounds.actions.bottom <= viewport.height, JSON.stringify(pendingBounds));
    if (viewport.width < viewport.height && viewport.height >= 700) assert.ok(pendingBounds.stage.height > pendingBounds.panel.height, JSON.stringify(pendingBounds));
    else if (viewport.width < viewport.height) assert.ok(pendingBounds.stage.height >= 150, JSON.stringify(pendingBounds));
    else assert.ok(pendingBounds.stage.width > pendingBounds.panel.width, JSON.stringify(pendingBounds));
    await page.locator('[data-studio-cancel]').click();

    await page.locator('[data-studio-toggle]').click();
    const collapsedSelected = await page.locator('.studio3d-shell').evaluate(node => node.getBoundingClientRect().height);
    await page.locator('[data-studio-toggle]').click();
    await openCatalog();
    await page.locator('[data-studio-toggle]').click();
    const collapsedCatalog = await page.locator('.studio3d-shell').evaluate(node => node.getBoundingClientRect().height);
    assert.equal(collapsedCatalog, collapsedSelected);
    await page.locator('[data-studio-toggle]').click();
  }
  report.checks.push('desktop, portrait, and landscape keep stable panel/scene geometry across catalog, selection, and pending states');
  report.checks.push('mobile collapsed and expanded shell heights do not change with selection');

  await selectTarget(itemOption);
  const keyboardWidth = page.locator('[data-studio-value="width"]');
  await keyboardWidth.fill(String(Number(await keyboardWidth.inputValue()) + 5));
  const typedWidth = await keyboardWidth.inputValue();
  await page.evaluate(() => { window.__roomControl = document.querySelector('[data-studio-room]'); });
  await page.setViewportSize({ width: 390, height: 420 });
  await settleBrowserPaint(page);
  assert.equal(await keyboardWidth.inputValue(), typedWidth);
  assert.equal(await page.evaluate(() => document.activeElement.matches('[data-studio-value="width"]')), true);
  const keyboardLayout = await page.evaluate(() => ({
    header: document.querySelector('.walkthrough-overlay .workbench-header').getBoundingClientRect().toJSON(),
    modes: document.querySelector('.walkthrough-overlay .workbench-modes').getBoundingClientRect().toJSON(),
    body: document.querySelector('.studio3d-body').getBoundingClientRect().toJSON(),
    field: document.querySelector('[data-studio-value="width"]').getBoundingClientRect().toJSON(),
    stage: document.querySelector('[data-walkthrough-stage]').getBoundingClientRect().toJSON(),
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  assert.ok(keyboardLayout.modes.bottom <= keyboardLayout.header.bottom, JSON.stringify(keyboardLayout));
  assert.ok(keyboardLayout.field.top >= keyboardLayout.body.top && keyboardLayout.field.bottom <= keyboardLayout.body.bottom, JSON.stringify(keyboardLayout));
  assert.ok(keyboardLayout.stage.height >= 44, JSON.stringify(keyboardLayout));
  assert.equal(keyboardLayout.overflow, false);
  await armPanelState({ view: 'inspector', pending: true });
  await keyboardWidth.press('Tab');
  await page.evaluate(() => window.__panelState);
  await capture('keyboard-390x420-pending.png');
  await page.locator('[data-studio-cancel]').click();
  await page.locator('.walkthrough-view-tools button[aria-expanded]').click();
  assert.equal(await page.locator('[data-studio-room]').isVisible(), true);
  assert.equal(await page.locator('[data-save-snapshot]').isVisible(), true);
  await page.locator('[data-studio-room]').selectOption('');
  assert.equal(await page.locator('[data-walkthrough]').getAttribute('data-focused-room'), '');
  await page.locator('[data-studio-room]').selectOption('room');
  assert.equal(await page.locator('[data-walkthrough]').getAttribute('data-focused-room'), 'room');
  const toolsBounds = await page.locator('.walkthrough-more-panel').boundingBox();
  assert.ok(toolsBounds.x >= 0 && toolsBounds.y >= 0
    && toolsBounds.x + toolsBounds.width <= 390 && toolsBounds.y + toolsBounds.height <= 420);
  // This explicitly opened menu covers the small scene while exposing its tools.
  await settleBrowserPaint(page);
  await page.screenshot({ path: join(output, 'keyboard-390x420-tools.png') });
  report.screenshots.push('keyboard-390x420-tools.png');
  await page.locator('.walkthrough-view-tools button[aria-expanded]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await settleBrowserPaint(page);
  assert.equal(await page.evaluate(() => document.querySelector('[data-studio-room]') === window.__roomControl
    && Boolean(window.__roomControl.closest('.workbench-header'))), true);
  report.checks.push('reduced-height portrait preserves focused numeric input and moves the same room/export controls into an accessible tools menu');
  await selectTarget('zone:room');
  await page.locator('[data-studio-toggle]').click();
  assert.equal(await page.locator('[data-studio-finish-edit="floor"]').isVisible(), true);
  assert.equal(await page.locator('[data-studio-rotate]').isHidden(), true);
  await page.locator('[data-studio-finish-edit="wall"]').click();
  assert.equal(await page.locator('[data-studio-finish-palettes]').isVisible(), true);
  await capture('portrait-390x844-finish.png');
  report.checks.push('collapsed space selection exposes floor and wall finishes instead of unavailable transform actions');

  let releaseModel;
  const modelGate = new Promise(resolve => { releaseModel = resolve; });
  const holdModel = async route => { await modelGate; await route.continue(); };
  await page.route('**/seoul-bed.glb', holdModel);
  try {
    await openCatalog();
    await chooseCategory('item');
    const requested = page.waitForRequest(request => request.url().endsWith('/seoul-bed.glb'));
    await armPanelState({ view: 'inspector', pending: true, asset: 'loading' });
    await page.locator('[data-studio-asset="seoul-bed"]').click();
    await requested;
    await page.evaluate(() => window.__panelState);
    await page.locator('[data-studio-toggle]').click();
    await settleBrowserPaint(page);
    const loadingBounds = await bounds();
    assert.equal(await page.locator('[data-studio-apply]').isDisabled(), true);
    await capture('portrait-390x844-loading.png');
    await armPanelState({ view: 'inspector', pending: true, asset: 'ready' });
    releaseModel();
    await page.evaluate(() => window.__panelState);
    await settleBrowserPaint(page);
    const readyBounds = await bounds();
    assert.equal(readyBounds.panel.height, loadingBounds.panel.height);
    assert.equal(readyBounds.stage.height, loadingBounds.stage.height);
    assert.equal(await page.locator('[data-studio-apply]').isEnabled(), true);
    await page.locator('[data-studio-cancel]').click();
    report.checks.push('real deferred model loading preserves the collapsed scene viewport and gates Apply until ready');
  } finally {
    releaseModel();
    await page.unroute('**/seoul-bed.glb', holdModel);
  }

  await page.setViewportSize({ width: 320, height: 568 });
  await page.locator('.workbench-modes [data-walkthrough-exit]').click();
  await armStudioReady();
  await page.locator('#open-walkthrough').click();
  await page.evaluate(() => window.__studioUiReady);
  await page.route('**/seoul-bed.glb', route => route.fulfill({ status: 503, body: 'Owned QA asset failure' }));
  try {
    await openCatalog();
    await armPanelState({ view: 'inspector', pending: true, asset: 'error' });
    await page.locator('[data-studio-asset="seoul-bed"]').click();
    await page.evaluate(() => window.__panelState);
    await capture('compact-320x568-model-error.png');
    const recovery = await page.evaluate(() => ({
      panel: document.querySelector('.studio3d-shell').getBoundingClientRect().toJSON(),
      retry: document.querySelector('[data-studio-retry]').getBoundingClientRect().toJSON(),
    }));
    assert.ok(recovery.retry.top >= recovery.panel.top && recovery.retry.bottom <= recovery.panel.bottom, JSON.stringify(recovery));
  } finally {
    await page.unroute('**/seoul-bed.glb');
  }
  await armPanelState({ view: 'inspector', pending: true, asset: 'ready' });
  await page.locator('[data-studio-retry]').click();
  await page.evaluate(() => window.__panelState);
  assert.equal(await page.locator('[data-studio-apply]').isEnabled(), true);
  await page.locator('[data-studio-cancel]').click();
  report.checks.push('compact mobile model failure keeps recovery visible and retries the real asset without losing the preview');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
