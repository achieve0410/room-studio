import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer as reservePort } from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { captureRoomScene } from './browser-rendering.mjs';

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

  await page.evaluate(() => {
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
  await page.locator('#open-walkthrough').click();
  await page.evaluate(() => window.__studioUiReady);

  const assertCatalogFirst = async () => {
    const order = await page.evaluate(() => {
      const card = document.querySelector('[data-studio-asset]')?.getBoundingClientRect();
      const target = document.querySelector('[data-studio-target-alternative]')?.getBoundingClientRect();
      const precision = document.querySelector('[data-studio-precision]')?.getBoundingClientRect();
      return { cardTop: card?.top, targetTop: target?.top, precisionTop: precision?.top };
    });
    assert.ok(Number.isFinite(order.cardTop), JSON.stringify(order));
    assert.ok(order.cardTop < order.targetTop && order.cardTop < order.precisionTop, JSON.stringify(order));
  };
  await assertCatalogFirst();
  await captureRoomScene(page, join(output, 'desktop-1440x1000.png'));
  report.screenshots.push('desktop-1440x1000.png');

  const awaitPanelLayout = () => page.evaluate(() => new Promise((done, reject) => {
    const shell = document.querySelector('.studio3d-shell');
    const overlay = document.querySelector('[data-walkthrough]');
    const observer = new ResizeObserver(check);
    const mutation = new MutationObserver(check);
    const timeout = setTimeout(() => {
      observer.disconnect(); mutation.disconnect();
      reject(new Error(`panel layout timeout: ${JSON.stringify({
        viewport: [innerWidth, innerHeight], expanded: shell.classList.contains('is-expanded'),
        panel: shell.getBoundingClientRect().toJSON(),
        stage: document.querySelector('[data-walkthrough-stage]').getBoundingClientRect().toJSON(),
      })}`));
    }, 10000);
    function check() {
      const stage = document.querySelector('[data-walkthrough-stage]').getBoundingClientRect();
      const panel = shell.getBoundingClientRect();
      if (shell.classList.contains('is-expanded') && panel.height > 250
        && (innerWidth > innerHeight || stage.width === innerWidth)
        && (stage.bottom <= panel.top + 1 || stage.right <= panel.left + 1)) {
        clearTimeout(timeout); observer.disconnect(); mutation.disconnect(); done();
      }
    }
    observer.observe(shell);
    observer.observe(document.querySelector('[data-walkthrough-stage]'));
    mutation.observe(overlay, { attributes: true, attributeFilter: ['style'] });
    check();
  }));
  for (const viewport of [{ width: 390, height: 844, name: 'mobile-390x844' }, { width: 844, height: 390, name: 'landscape-844x390' }]) {
    await page.evaluate(desktop => {
      const media = matchMedia('(min-width: 901px) and (min-height: 601px)');
      window.__panelModeReady = new Promise((done, reject) => {
        if (media.matches === desktop) { done(); return; }
        const onChange = () => { clearTimeout(timeout); done(); };
        const timeout = setTimeout(() => {
          media.removeEventListener('change', onChange);
          reject(new Error('Panel responsive mode did not change'));
        }, 10000);
        media.addEventListener('change', onChange, { once: true });
      });
    }, viewport.width > 900 && viewport.height > 600);
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.__panelModeReady);
    if (await page.locator('[data-studio-toggle]').getAttribute('aria-expanded') === 'false') {
      await page.locator('[data-studio-toggle]').click();
    }
    await awaitPanelLayout();
    await assertCatalogFirst();
    const bounds = await page.evaluate(() => {
      const stage = document.querySelector('[data-walkthrough-stage]').getBoundingClientRect();
      const panel = document.querySelector('.studio3d-shell').getBoundingClientRect();
      const actions = document.querySelector('.studio3d-actions').getBoundingClientRect();
      const body = document.querySelector('.studio3d-body').getBoundingClientRect();
      const cards = [...document.querySelectorAll('[data-studio-asset]')].filter(node => node.getClientRects().length);
      return {
        stage: stage.toJSON(), panel: panel.toJSON(), actions: actions.toJSON(),
        body: body.toJSON(), firstCard: cards[0]?.getBoundingClientRect().toJSON(),
        visibleCards: cards.filter(node => {
          const rect = node.getBoundingClientRect();
          return rect.top >= body.top && rect.bottom <= body.bottom;
        }).length,
        separate: stage.bottom <= panel.top + 1 || stage.right <= panel.left + 1,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    await captureRoomScene(page, join(output, `${viewport.name}.png`));
    report.screenshots.push(`${viewport.name}.png`);
    assert.equal(bounds.separate, true, JSON.stringify(bounds));
    assert.equal(bounds.overflow, false, JSON.stringify(bounds));
    assert.ok(bounds.visibleCards >= 2, JSON.stringify(bounds));
    assert.ok(bounds.actions.top >= 0 && bounds.actions.bottom <= viewport.height, JSON.stringify(bounds));
    if (viewport.width < viewport.height) assert.ok(bounds.stage.height > bounds.panel.height, JSON.stringify(bounds));
    else assert.ok(bounds.stage.width > bounds.panel.width, JSON.stringify(bounds));
  }
  assert.deepEqual(report.errors, []);
  report.checks.push('catalog cards precede alternative target and precision controls');
  report.checks.push('desktop, portrait, and landscape keep scene separate and actions visible');
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
