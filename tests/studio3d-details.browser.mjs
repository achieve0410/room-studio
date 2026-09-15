import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer as reservePort } from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.STUDIO3D_DETAILS_OUTPUT ?? join(root, '.omx/artifacts/studio3d-details', new Date().toISOString().replaceAll(':', '-')));
const report = { output, renderProfile: 'production', checks: [], errors: [] };
await mkdir(output, { recursive: true });
const port = await new Promise((done, reject) => {
  const server = reservePort();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); });
});
const server = await createServer({ root, cacheDir: join(output, 'vite-cache'),
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/.omx/**'] } },
  plugins: [{ name: 'detail-observation', transform(source, id) {
    if (id.split('?')[0] === join(root, 'src/main.js')) {
      const anchor = 'function apply3dEdit(action) {';
      assert.equal(source.split(anchor).length, 2);
      return source.replace(anchor, `${anchor}
 window.__actions.push(structuredClone(action));`) + `
        window.__actions = [];
        Object.defineProperty(window, '__layout', { get: () => layoutSnapshot() });`;
    }
    if (id.split('?')[0] !== join(root, 'src/walkthrough3d.js')) return;
    const anchor = "  overlay.dataset.walkthroughReady = 'true';";
    assert.equal(source.split(anchor).length, 2);
    return source.replace(anchor, `
      window.__detailScene = () => ({ items, sceneStructures, scene, camera, renderer, destroyed, editSession, center, canMoveTo,
        project(id) { const item = items.find(i => i.id === id) ?? sceneStructures.find(i => i.id === id);
          const p = new THREE.Vector3((item.x-center.x)/100, ((item.elevation||0)+item.height/2)/100, (item.y-center.y)/100).project(camera);
          const r = renderer.domElement.getBoundingClientRect(); return { x:r.x+(p.x+1)*r.width/2, y:r.y+(1-p.y)*r.height/2 }; }
      });
      overlay.dataset.walkthroughReady = 'true';`);
  } }],
});
let browser;
let page;
try {
  await server.listen();
  const executablePath = process.env.CHROME_PATH ?? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    chromium.executablePath(),
  ].find(existsSync);
  assert.ok(executablePath && existsSync(executablePath), 'Install Chrome/Chromium or set CHROME_PATH');
  browser = await chromium.launch({ executablePath, headless: true, args: ['--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 320, height: 568 }, reducedMotion: 'reduce', hasTouch: true });
  page.setDefaultTimeout(20000);
  const errors = report.errors;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('room-studio-layout-v2', JSON.stringify({
    zones: [{ id: 'room', name: '방', type: '거실', x: 0, y: 0, width: 500, depth: 400, height: 240 }],
    items: [], structures: [], wallHeight: 240,
  })));
  await page.goto(server.resolvedUrls.local[0]);
  let serial = 0;
  const change = async (expression, trigger) => {
    const key = `__detailSignal${serial++}`;
    await page.evaluate(`(() => {
      window[${JSON.stringify(key)}] = new Promise((done, reject) => {
        const observer = new MutationObserver(check);
        const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(${JSON.stringify(`State timeout: ${expression}`)})); }, 15000);
        function check() { if (${expression}) { clearTimeout(timeout); observer.disconnect(); done(); } }
        observer.observe(document.documentElement, { attributes: true, subtree: true, childList: true, characterData: true });
        check();
      });
    })()`);
    await trigger();
    await page.evaluate(async key => { await window[key]; delete window[key]; }, key);
  };
  const ready = `document.querySelector('[data-walkthrough]')?.dataset.studioReady === 'true' && document.querySelector('[data-walkthrough]')?.dataset.assetState === 'ready'`;
  await change(ready, () => page.locator('#open-walkthrough').click());
  await page.locator('button[data-view-mode="top"]').click();
  assert.equal(await page.evaluate(() => window.__detailScene().renderer.shadowMap.enabled), true);
  assert.equal(await page.evaluate(() => window.__detailScene().renderer.getContext().getContextAttributes().antialias), true);
  assert.equal(await page.evaluate(() => window.__detailScene().renderer.getPixelRatio()), 1);
  assert.equal(await page.locator('#app').evaluate(app => app.inert), true);
  const apply = async () => {
    const count = await page.evaluate(() => window.__actions.length);
    await change(`window.__actions.length === ${count + 1} && !window.__detailScene().editSession.pending`, () => page.locator('[data-studio-apply]').click());
  };
  const choose = async value => { await page.locator('[data-studio-target]').selectOption(value); };
  const field = async (key, value) => {
    const control = page.locator(`[data-studio-value="${key}"]`);
    await control.fill(String(value)); await control.press('Tab');
  };
  const cdp = await page.context().newCDPSession(page);
  const touch = async (type, points) => {
    const eventType = { touchStart: 'pointerdown', touchMove: 'pointermove', touchEnd: 'pointerup', touchCancel: 'pointercancel' }[type];
    await page.evaluate(eventType => {
      const canvas = document.querySelector('[data-walkthrough-stage] canvas');
      window.__nativeTouch = new Promise((done, reject) => {
        const receive = event => {
          if (event.pointerType !== 'touch') return;
          clearTimeout(timeout); canvas.removeEventListener(eventType, receive); done();
        };
        const timeout = setTimeout(() => { canvas.removeEventListener(eventType, receive); reject(new Error(`Missing ${eventType}`)); }, 15000);
        canvas.addEventListener(eventType, receive);
      });
    }, eventType);
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    await page.evaluate(() => window.__nativeTouch);
  };
  await change(`Number.parseFloat(document.querySelector('[data-walkthrough]').style.getPropertyValue('--studio-panel-height')) > 200`, () => page.locator('[data-studio-toggle]').click());
  const containment = async () => {
    await page.screenshot({ path: join(output, 'current-containment.png') });
    const rects = await page.evaluate(() => {
      const stage = document.querySelector('[data-walkthrough-stage]').getBoundingClientRect();
      const panel = document.querySelector('.studio3d-shell').getBoundingClientRect();
      const apply = document.querySelector('[data-studio-apply]').getBoundingClientRect();
      return { separate: stage.bottom <= panel.top || stage.right <= panel.left, sceneHeight: stage.height,
        cameraAspect: window.__detailScene().camera.aspect, stageAspect: stage.width / stage.height,
        applyVisible: apply.bottom <= innerHeight && apply.top >= 0, overflow: document.documentElement.scrollWidth > innerWidth,
        smallControls: [...document.querySelectorAll('.studio3d-shell button, .studio3d-shell input, .studio3d-shell select')]
          .filter(el => el.getClientRects().length && !el.closest('[hidden]')).filter(el => el.getBoundingClientRect().height < 44).length };
    });
    assert.equal(rects.separate, true, JSON.stringify(rects));
    assert.ok(rects.sceneHeight >= 150, JSON.stringify(rects));
    assert.ok(Number.isFinite(rects.cameraAspect), JSON.stringify(rects));
    assert.ok(Math.abs(rects.cameraAspect - rects.stageAspect) < 0.01, JSON.stringify(rects));
    assert.equal(rects.applyVisible, true); assert.equal(rects.overflow, false); assert.equal(rects.smallControls, 0);
  };
  await containment();
  assert.equal(await page.locator('[data-studio-asset]').count(), 12);
  assert.equal(await page.locator('[data-studio-palettes] button').count(), 3);
  await page.locator('[data-studio-template="laundryTower"]').click();
  await field('width', 90); await field('height', 180); await field('elevation', 15);
  assert.equal(await page.evaluate(() => window.__layout.items.length), 0);
  await apply();
  const item = await page.evaluate(() => window.__layout.items[0]);
  assert.equal(item.width, 90); assert.equal(item.elevation, 15); assert.equal(item.type, 'laundryTower');
  await page.locator('[data-studio-duplicate]').click(); await apply();
  assert.equal(await page.evaluate(() => window.__layout.items.length), 2);
  await page.locator('[data-studio-delete]').click();
  assert.equal(await page.evaluate(() => window.__layout.items.length), 2);
  await page.locator('[data-studio-cancel]').click();
  await page.locator('[data-studio-delete]').click(); await apply();
  await page.locator('[data-studio-undo]').click(); assert.equal(await page.evaluate(() => window.__layout.items.length), 2);
  await page.locator('[data-studio-redo]').click(); assert.equal(await page.evaluate(() => window.__layout.items.length), 1);
  await choose(`item:${item.id}`);
  await page.locator('[data-studio-lock]').click(); await apply();
  assert.equal(await page.locator('[data-studio-delete]').isDisabled(), true);
  await page.locator('[data-studio-lock]').click(); await apply();
  report.checks.push('real mobile entry: furniture properties, preview/apply, duplicate/delete/cancel, lock/unlock and host undo/redo');
  const initialPoint = { ...await page.evaluate(id => window.__detailScene().project(id), item.id), id: 1 };
  assert.equal(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.matches('[data-walkthrough-canvas]'), initialPoint), true);
  const actionCount = await page.evaluate(() => window.__actions.length);
  await touch('touchStart', [initialPoint]);
  await touch('touchMove', [{ ...initialPoint, x: initialPoint.x + 18 }]);
  await touch('touchEnd', []);
  assert.equal(await page.evaluate(() => window.__actions.length), actionCount);
  assert.equal(await page.evaluate(() => window.__detailScene().editSession.pending), true);
  await apply();
  const placedItem = await page.evaluate(() => structuredClone(window.__layout.items[0]));
  for (const cancel of ['pointercancel', 'second-touch']) {
    const point = { ...await page.evaluate(id => window.__detailScene().project(id), item.id), id: 1 };
    await touch('touchStart', [point]);
    const moved = { ...point, x: point.x + 16 };
    await touch('touchMove', [moved]);
    assert.equal(await page.evaluate(() => window.__detailScene().editSession.pending), true);
    if (cancel === 'pointercancel') await touch('touchCancel', []);
    else {
      await touch('touchStart', [moved, { ...point, x: point.x + 44, id: 2 }]);
      await touch('touchEnd', []);
    }
    assert.deepEqual(await page.evaluate(() => window.__detailScene().items[0]), placedItem);
    assert.equal(await page.evaluate(() => window.__detailScene().editSession.pending), false);
  }
  assert.equal(await page.evaluate(() => window.__actions.length), actionCount + 1, 'canceled native drags do not write history');
  report.checks.push('actual object drag previews until Apply; pointercancel and second contact cancel the moved draft without history');
  await page.locator('[data-studio-template="laundryTower"]').click();
  const placementId = await page.locator('.studio3d-shell').getAttribute('data-selection-id');
  const blank = await page.locator('[data-walkthrough-stage]').evaluate(stage => {
    const rect = stage.getBoundingClientRect();
    return { x: rect.left + 4, y: rect.top + 4, id: 1 };
  });
  await touch('touchStart', [blank]);
  await touch('touchStart', [blank, { ...blank, x: blank.x + 40, id: 2 }]);
  await touch('touchEnd', []);
  assert.equal(await page.evaluate(() => window.__detailScene().editSession.pending), true,
    'camera contacts preserve a pending placement');
  assert.equal(await page.locator('.studio3d-shell').getAttribute('data-selection-id'), placementId);
  await page.locator('[data-studio-cancel]').click();
  await choose(`item:${item.id}`);
  await field('rotation', 30);
  const unchangedContact = { ...await page.evaluate(id => window.__detailScene().project(id), item.id), id: 1 };
  await touch('touchStart', [unchangedContact]);
  await touch('touchStart', [unchangedContact, { ...unchangedContact, x: unchangedContact.x + 40, id: 2 }]);
  await touch('touchEnd', []);
  assert.equal(await page.evaluate(() => window.__detailScene().editSession.pending), true,
    'a second contact without an object drag preserves numeric changes');
  await page.locator('[data-studio-cancel]').click();
  report.checks.push('camera-only contacts preserve pending placement and numeric rotation; no object drag is mistaken for camera intent');
  await page.locator('[data-studio-tab="structure"]').click();
  await page.locator('[data-studio-structure="swing"]').click();
  const door = await page.evaluate(() => window.__detailScene().sceneStructures[0]);
  assert.equal(door.y, 0); assert.equal(door.orientation, 'horizontal');
  assert.equal(await page.evaluate(() => window.__layout.structures.length), 0);
  await field('width', 110);
  await page.locator('[data-studio-value="hinge"]').selectOption('end');
  await page.locator('[data-studio-value="openSide"]').selectOption('1');
  await page.locator('[data-studio-opening="1"]').click();
  await page.screenshot({ path: join(output, 'portrait-door-preview.png') });
  await containment();
  await apply();
  assert.equal(await page.evaluate(() => window.__layout.structures[0].openAngle), 90);
  const wallOption = await page.evaluate(async () => {
    const { studioWallTargets } = await import('/src/studio3d-edit.js');
    return String(studioWallTargets(window.__layout).findIndex(wall => wall.orientation === 'vertical' && wall.x === 500));
  });
  assert.notEqual(wallOption, '-1');
  await page.locator('[data-studio-wall-target]').selectOption(wallOption);
  assert.equal(await page.evaluate(() => window.__detailScene().sceneStructures[0].x), 500);
  await apply();
  await page.locator('[data-studio-structure="window"]').click();
  await field('sillHeight', 80); await field('height', 130); await page.locator('[data-studio-opening="1"]').click(); await apply();
  assert.equal(await page.evaluate(() => window.__layout.structures.find(s => s.type === 'window').openRatio), 100);
  await page.locator('[data-studio-structure="wall"]').click();
  await field('x', 250); await field('y', 200); await field('length', 300); await apply();
  const wall = await page.evaluate(() => window.__layout.structures.find(s => s.type === 'wall'));
  await page.locator('[data-studio-structure="sliding"]').click(); await apply();
  assert.equal(await page.evaluate(() => window.__layout.structures.at(-1).wallId), wall.id);
  await choose(`structure:${wall.id}`); await field('y', 230); await apply();
  assert.equal(await page.evaluate(() => window.__layout.structures.at(-1).y), 230);
  const geometryBefore = await page.evaluate(() => window.__detailScene().scene.children[0].children.filter(o => o.userData.structureId).map(o => o.uuid));
  assert.ok(geometryBefore.length);
  await page.locator('[data-studio-delete]').click(); await apply();
  assert.equal(await page.evaluate(() => window.__layout.structures.some(s => s.type === 'wall' || s.wallId)), false);
  assert.equal(await page.evaluate(() => window.__detailScene().scene.children[0].children.some(o => o.userData.structureId)), false);
  await page.locator('[data-studio-undo]').click();
  assert.equal(await page.evaluate(() => window.__layout.structures.at(-1).wallId), wall.id);
  await page.setViewportSize({ width: 844, height: 390 });
  await choose(`structure:${wall.id}`);
  await containment();
  await page.screenshot({ path: join(output, 'landscape-wall-inspector.png') });
  await page.locator('[data-view-mode="walk"]').click();
  assert.equal(await page.locator('.studio3d-shell').isVisible(), false);
  assert.equal(await page.evaluate(() => window.__detailScene().editSession.pending), false);
  await page.locator('[data-walkthrough-exit]').first().click();
  assert.equal(await page.locator('#app').evaluate(app => app.inert), false);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.__detailScene().destroyed), true);
  assert.equal(await page.evaluate(() => window.__detailScene().renderer.getContext().isContextLost()), true);
  report.checks.push('snapped swing/sliding doors and windows, wall attachment/rebuild/cascade delete, undo/redo, portrait/landscape containment and real renderer cleanup');
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png') });
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
