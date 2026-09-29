import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as reservePort } from 'node:net';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { captureRoomScene, settleBrowserPaint } from './browser-rendering.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.WORKBENCH_OUTPUT ?? join(root, '.omx/artifacts/ux-workbench/flow'));
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
  plugins: [{
    name: 'workbench-observation',
    transform(source, id) {
      if (id.split('?')[0] !== join(root, 'src/walkthrough3d.js')) return;
      const anchor = "  overlay.dataset.walkthroughReady = 'true';";
      assert.equal(source.split(anchor).length, 2);
      return source.replace(anchor, `
        window.__workbench3d = () => ({
          mode: viewMode, selection: studioPanel?.selection, layout: editSession?.layout, groundPoint,
          pose: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(),
            up: camera.up.toArray(), target: overviewOrbitTarget.toArray(), fov: camera.fov },
          get walls() {
            const walls = [];
            worldRoot.traverse(object => {
              if (object.userData.type !== 'wall') return;
              const materials = Array.isArray(object.material) ? object.material : [object.material];
              walls.push({ position: object.position.toArray(), clipped: materials.some(material => Boolean(material.clippingPlanes?.length)) });
            });
            return walls;
          },
          project(point, height = 0) {
            const projected = new THREE.Vector3((point.x - center.x) / 100, height / 100, (point.y - center.y) / 100).project(camera);
            const rectangle = renderer.domElement.getBoundingClientRect();
            return { x: rectangle.x + (projected.x + 1) * rectangle.width / 2,
              y: rectangle.y + (1 - projected.y) * rectangle.height / 2 };
          },
        });
        ${anchor}`);
    },
  }],
});
const fixture = {
  zones: [
    { id: 'living', name: '거실', type: '거실', x: 0, y: 0, width: 500, depth: 400, height: 240 },
    { id: 'study', name: '작업실', type: '방', x: 500, y: 0, width: 300, depth: 400, height: 240 },
  ],
  items: [{
    id: 'sofa', name: '소파', type: 'sofa', shape: 'rect', assetId: 'seoul-sofa',
    materialId: 'warm-oak', x: 250, y: 200, width: 220, depth: 94, height: 84,
    rotation: 0, elevation: 0, color: '#c8a777', locked: false,
  }],
  structures: [], dimensions: [], backgroundPlan: null, wallHeight: 240,
};
const report = { output, checks: [], screenshots: [], errors: [] };
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  for (const { name, mobile, legacy } of [
    { name: 'desktop', mobile: false, legacy: false },
    { name: 'mobile', mobile: true, legacy: false },
    { name: 'legacy-desktop', mobile: false, legacy: true },
  ]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => report.errors.push(`${name}: ${error.message}`));
    const initialLayout = structuredClone(fixture);
    if (legacy) {
      delete initialLayout.items[0].assetId;
      delete initialLayout.items[0].materialId;
    }
    await page.addInitScript(layout => localStorage.setItem('room-studio-layout-v2', JSON.stringify(layout)), initialLayout);
    const activate = selector => page.locator(selector)[mobile ? 'tap' : 'click']();
    const arm = expression => page.evaluate(expression => {
      window.__workbenchSignal = new Promise((done, reject) => {
        const matches = new Function(`return (${expression})`);
        const observer = new MutationObserver(check);
        const timeout = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`State timeout: ${expression}`));
        }, 20000);
        function check() {
          if (matches()) { clearTimeout(timeout); observer.disconnect(); done(); }
        }
        observer.observe(document.documentElement, { subtree: true, attributes: true, childList: true });
        check();
      });
    }, expression);
    const change = async (expression, action) => {
      await arm(expression);
      await action();
      await page.evaluate(() => window.__workbenchSignal);
    };
    const ready = `document.querySelector('[data-walkthrough]')?.dataset.studioReady === 'true'
      && document.querySelector('[data-walkthrough]')?.dataset.assetState === 'ready'`;
    const open = async () => {
      await change(ready, () => activate('#open-walkthrough'));
      await settleBrowserPaint(page);
    };
    const close = () => change(`!document.querySelector('[data-walkthrough]')`,
      () => activate('.workbench-modes [data-walkthrough-exit]'));
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('room-studio-layout-v2')));
    const pointer = async (type, action) => {
      await page.evaluate(type => {
        window.__workbenchPointer = new Promise((done, reject) => {
          const handler = event => { clearTimeout(timeout); done({
            trusted: event.isTrusted, type: event.pointerType,
            handle: event.target.closest('[data-studio-handle]')?.dataset.studioHandle ?? null,
          }); };
          const timeout = setTimeout(() => {
            document.removeEventListener(type, handler);
            reject(new Error(`Pointer was not delivered: ${type}`));
          }, 10000);
          document.addEventListener(type, handler, { once: true });
        });
      }, type);
      await action();
      const event = await page.evaluate(() => window.__workbenchPointer);
      assert.deepEqual({ trusted: event.trusted, type: event.type }, { trusted: true, type: mobile ? 'touch' : 'mouse' });
      return event;
    };
    const drag = async (from, to, cancel = false) => {
      if (mobile) {
        const start = await pointer('pointerdown', () => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] }));
        assert.ok(start.handle, `Transform must start on its visible handle: ${JSON.stringify({ from, start, cancel })}`);
        await pointer('pointermove', () => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...to, id: 1 }] }));
        assert.equal(await page.locator('.studio3d-shell').getAttribute('data-pending'), 'true');
        await pointer(cancel ? 'pointercancel' : 'pointerup', () => cdp.send('Input.dispatchTouchEvent', {
          type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [],
        }));
      } else {
        await page.mouse.move(from.x, from.y);
        const start = await pointer('pointerdown', () => page.mouse.down());
        assert.ok(start.handle, `Transform must start on its visible handle: ${JSON.stringify({ from, start, cancel })}`);
        await pointer('pointermove', () => page.mouse.move(to.x, to.y));
        assert.equal(await page.locator('.studio3d-shell').getAttribute('data-pending'), 'true');
        if (cancel) await page.keyboard.press('Escape');
        await pointer('pointerup', () => page.mouse.up());
      }
    };
    const handlePoints = async mode => {
      await settleBrowserPaint(page);
      const handle = page.locator(`[data-studio-handle="${mode}"]`);
      const size = await handle.evaluate(node => {
        const style = getComputedStyle(node);
        return [parseFloat(style.width), parseFloat(style.height)];
      });
      assert.ok(size.every(value => value >= 44), `Handle CSS target is at least 44px: ${size}`);
      const rectangle = await handle.boundingBox();
      // Translated 44px boxes can measure 43.99998474121094px across a float32 boundary.
      assert.ok(rectangle && rectangle.width >= 44 - 0.0001 && rectangle.height >= 44 - 0.0001);
      const from = { x: rectangle.x + rectangle.width / 2, y: rectangle.y + rectangle.height / 2 };
      const to = await page.evaluate(({ from, mode }) => {
        const state = window.__workbench3d();
        const item = state.layout.items.find(item => item.id === 'sofa');
        const start = state.groundPoint({ clientX: from.x, clientY: from.y }, item.elevation);
        const radians = (mode === 'rotate' ? 45 : item.rotation) * Math.PI / 180;
        const dx = mode === 'rotate' ? start.x - item.x : 40;
        const dy = mode === 'rotate' ? start.y - item.y : 30;
        const origin = mode === 'rotate' ? item : start;
        return state.project({
          x: origin.x + dx * Math.cos(radians) - dy * Math.sin(radians),
          y: origin.y + dx * Math.sin(radians) + dy * Math.cos(radians),
        }, item.elevation);
      }, { from, mode });
      return { from, to };
    };
    const capture = async label => {
      const path = join(output, `${name}-${label}.png`);
      if (await page.locator('[data-walkthrough]').count()) await captureRoomScene(page, path);
      else { await settleBrowserPaint(page); await page.screenshot({ path }); }
      report.screenshots.push(path);
    };
    await page.goto(server.resolvedUrls.local[0], { waitUntil: 'domcontentloaded' });
    await page.locator('.plan-zone').first()[mobile ? 'tap' : 'click']();
    const spaceGeometry = await saved();
    await capture('space');
    await open();
    assert.equal(await page.locator('[data-studio-inspector]').isVisible(), !mobile);
    assert.equal(await page.locator('.studio3d-shell').getAttribute('data-selection-id'), 'living');
    assert.equal(await page.locator('#app').evaluate(node => node.inert), true);
    assert.deepEqual((await saved()).zones, spaceGeometry.zones);
    assert.equal(await page.locator('[data-studio-room]').inputValue(), 'living');
    const wallPoint = await page.evaluate(() => window.__workbench3d().project({ x: 250, y: 0 }, 150));
    if (mobile) await page.touchscreen.tap(wallPoint.x, wallPoint.y);
    else await page.mouse.click(wallPoint.x, wallPoint.y);
    assert.equal(await page.evaluate(() => window.__workbench3d().selection?.surface), 'wall',
      'Visible full-height room walls must remain selectable for finish editing');
    await capture('wall-finish');
    await activate('button[data-view-mode="top"]');
    await settleBrowserPaint(page);
    const radius = pose => Math.hypot(...pose.position.map((value, index) => value - pose.target[index]));
    const roomRadius = radius(await page.evaluate(() => window.__workbench3d().pose));
    await page.locator('[data-studio-room]').selectOption('');
    const wholeRadius = radius(await page.evaluate(() => window.__workbench3d().pose));
    assert.ok(wholeRadius > roomRadius * 1.05, JSON.stringify({ roomRadius, wholeRadius }));
    await page.locator('[data-studio-room]').selectOption('study');
    assert.equal(await page.locator('.studio3d-shell').getAttribute('data-selection-id'), 'study');
    assert.deepEqual((await saved()).zones, spaceGeometry.zones);
    await activate('[data-studio-add]');
    await activate('[data-studio-tab="item"]');
    await change(`document.querySelector('.studio3d-shell').dataset.pending === 'true' && ${ready}`,
      () => activate('[data-studio-asset="seoul-dining-chair"]'));
    await activate('[data-studio-apply]');
    const placedChair = (await saved()).items.find(item => item.id !== 'sofa');
    assert.ok(placedChair.x > 500 && placedChair.x < 800 && placedChair.y > 0 && placedChair.y < 400);
    await capture('room-placement');
    await activate('[data-studio-undo]');
    assert.equal((await saved()).items.length, 1);
    await close();
    assert.equal(await page.locator('[data-select-zone="study"]').getAttribute('class'), 'active');
    await open();
    assert.equal(await page.locator('[data-studio-room]').inputValue(), 'study');
    assert.equal(await page.locator('[data-walkthrough]').getAttribute('data-restored-view'), 'true');
    await close();
    await page.locator('.plan-zone').first()[mobile ? 'tap' : 'click']();
    await open();
    assert.equal(await page.locator('[data-studio-room]').inputValue(), 'living');
    assert.equal(await page.locator('[data-walkthrough]').getAttribute('data-restored-view'), null);
    report.checks.push(`${name}: room framing excludes neighbors, placement uses that room, and 2D return preserves room context`);
    await activate('button[data-view-mode="dollhouse"]');
    await settleBrowserPaint(page);
    const initialWalls = await page.evaluate(() => window.__workbench3d().walls);
    const orbitStage = await page.locator('[data-walkthrough-stage]').boundingBox();
    const orbitStart = { x: orbitStage.x + 8, y: orbitStage.y + 8 };
    const orbitEnd = { x: orbitStart.x + 220, y: orbitStart.y };
    if (mobile) {
      await pointer('pointerdown', () => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...orbitStart, id: 1 }] }));
      await pointer('pointermove', () => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...orbitEnd, id: 1 }] }));
      await pointer('pointerup', () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }));
    } else {
      await page.mouse.move(orbitStart.x, orbitStart.y);
      await pointer('pointerdown', () => page.mouse.down());
      await pointer('pointermove', () => page.mouse.move(orbitEnd.x, orbitEnd.y));
      await pointer('pointerup', () => page.mouse.up());
    }
    await settleBrowserPaint(page);
    const pose = await page.evaluate(() => window.__workbench3d().pose);
    const walls = await page.evaluate(() => window.__workbench3d().walls);
    assert.notDeepEqual(walls, initialWalls, 'Orbit must change which room walls are cut away');
    await capture('room-orbit');
    await close();
    assert.equal(await page.locator('#app').evaluate(node => node.inert), false);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'open-walkthrough');
    await open();
    await settleBrowserPaint(page);
    assert.equal(await page.locator('[data-walkthrough]').getAttribute('data-restored-view'), 'true');
    assert.equal(await page.locator('[data-walkthrough]').getAttribute('data-view-mode'), 'dollhouse');
    assert.deepEqual(await page.evaluate(() => window.__workbench3d().pose), pose);
    assert.deepEqual(await page.evaluate(() => window.__workbench3d().walls), walls,
      'Returning to an orbited room must restore the same visible wall cutaway');
    report.checks.push(`${name}: shared workspace restores exact camera, selected space, and focus without changing geometry`);
    await activate('button[data-view-mode="top"]');
    await settleBrowserPaint(page);

    const sofaPoint = await page.evaluate(() => {
      const state = window.__workbench3d();
      const item = state.layout.items.find(item => item.id === 'sofa');
      return state.project(item, item.height);
    });
    await change(`document.querySelector('.studio3d-shell').dataset.selectionId === 'sofa'`, () => mobile
      ? page.touchscreen.tap(sofaPoint.x, sofaPoint.y) : page.mouse.click(sofaPoint.x, sofaPoint.y));
    if (await page.locator('[data-studio-toggle]').getAttribute('aria-expanded') === 'false') {
      await activate('[data-studio-toggle]');
    }
    await settleBrowserPaint(page);
    assert.equal(await page.locator('[data-studio-catalog-view]').isHidden(), true);
    const inspectorBounds = await page.locator('.studio3d-body').boundingBox();
    const widthBounds = await page.locator('[data-studio-value="width"]').boundingBox();
    assert.ok(widthBounds.y >= inspectorBounds.y
      && widthBounds.y + widthBounds.height <= inspectorBounds.y + inspectorBounds.height);
    await capture('selected');
    const originalItem = (await saved()).items[0];
    if (mobile) {
      await activate('button[data-view-mode="top"]');
      const fittedPose = await page.evaluate(() => window.__workbench3d().pose);
      await page.locator('[data-studio-value="width"]').fill(String(originalItem.width + 10));
      await page.locator('[data-studio-value="width"]').press('Tab');
      assert.deepEqual(await page.evaluate(() => window.__workbench3d().pose), fittedPose,
        'editing geometry must not reframe the working camera');
      await activate('[data-studio-toggle]');
      await settleBrowserPaint(page);
      const framing = await page.evaluate(() => {
        const rectangle = document.querySelector('[data-walkthrough-stage]').getBoundingClientRect().toJSON();
        const state = window.__workbench3d();
        return { rectangle, corners: [[0, 0], [500, 0], [500, 400], [0, 400]].map(([x, y]) => state.project({ x, y })) };
      });
      assert.ok(framing.corners.every(point => point.x >= framing.rectangle.left && point.x <= framing.rectangle.right
        && point.y >= framing.rectangle.top && point.y <= framing.rectangle.bottom),
      `An automatic room view must remain framed when its panel closes: ${JSON.stringify(framing)}`);
      await capture('panel-reframed');
      await activate('[data-studio-toggle]');
      await activate('[data-studio-cancel]');
      await activate('button[data-view-mode="top"]');
      await settleBrowserPaint(page);
      report.checks.push('mobile: numeric preview preserves the camera while panel resizing still fits the automatic room view');
    }
    const selectedPose = await page.evaluate(() => window.__workbench3d().pose);
    await activate('[data-studio-inspector] [data-studio-transform="rotate"]');
    let points = await handlePoints('rotate');
    await drag(points.from, points.to);
    let draft = await page.evaluate(() => window.__workbench3d().layout.items.find(item => item.id === 'sofa'));
    assert.ok(Math.abs(draft.rotation - 45) <= 1, JSON.stringify(draft));
    assert.deepEqual((await saved()).items[0], originalItem);
    assert.deepEqual(await page.evaluate(() => window.__workbench3d().pose), selectedPose);
    await capture('rotation-preview');
    await activate('[data-studio-cancel]');
    assert.deepEqual(await page.evaluate(() => window.__workbench3d().layout.items.find(item => item.id === 'sofa')), originalItem);

    await activate('[data-studio-inspector] [data-studio-transform="resize"]');
    points = await handlePoints('resize');
    await drag(points.from, points.to);
    draft = await page.evaluate(() => window.__workbench3d().layout.items.find(item => item.id === 'sofa'));
    assert.ok(Math.abs(draft.width - originalItem.width - 40) < 1.5, JSON.stringify(draft));
    assert.ok(Math.abs(draft.depth - originalItem.depth - 30) < 1.5, JSON.stringify(draft));
    assert.ok(Math.abs((draft.x - draft.width / 2) - (originalItem.x - originalItem.width / 2)) < 1e-7);
    assert.ok(Math.abs((draft.y - draft.depth / 2) - (originalItem.y - originalItem.depth / 2)) < 1e-7);
    assert.deepEqual((await saved()).items[0], originalItem);
    assert.deepEqual(await page.evaluate(() => window.__workbench3d().pose), selectedPose);
    await arm(ready);
    await page.evaluate(() => window.__workbenchSignal);
    await capture('resize-preview');
    await activate('[data-studio-apply]');
    assert.deepEqual((await saved()).items[0], draft);
    await activate('[data-studio-undo]');
    assert.deepEqual((await saved()).items[0], originalItem);

    points = await handlePoints('resize');
    await drag(points.from, points.to, true);
    assert.equal(await page.locator('.studio3d-shell').getAttribute('data-pending'), 'false');
    assert.deepEqual(await page.evaluate(() => window.__workbench3d().layout.items.find(item => item.id === 'sofa')), originalItem);
    report.checks.push(`${name}: trusted pointer rotation/resize preserve camera and fixed corner; previews, cancellation, apply, and one-step undo use the shared geometry`);

    await activate('[data-studio-inspector] [data-studio-transform="rotate"]');
    await page.locator('[data-studio-handle="rotate"]').press('Enter');
    assert.equal(await page.evaluate(() => window.__workbench3d().layout.items[0].rotation), 15);
    await activate('[data-studio-cancel]');
    await activate('[data-studio-lock]');
    assert.equal(await page.locator('[data-studio-handle="rotate"]').isHidden(), true);
    assert.equal(await page.locator('[data-studio-handle="resize"]').isHidden(), true);
    await activate('[data-studio-cancel]');
    report.checks.push(`${name}: keyboard handle activation previews one step and locked furniture exposes no handles`);

    if (mobile) {
      await change(`document.querySelector('.studio3d-shell').dataset.pending === 'true'`, async () => {
        await page.locator('[data-studio-value="width"]').fill(String(originalItem.width + 10));
        await page.locator('[data-studio-value="width"]').press('Tab');
      });
      await page.locator('[data-studio-room]').selectOption('study');
      assert.equal(await page.locator('.studio3d-shell').getAttribute('data-pending'), 'true');
      await page.locator('[data-studio-room]').selectOption('living');
      assert.equal(await page.evaluate(() => window.__workbench3d().layout.items[0].width), originalItem.width + 10);
      const floorPoint = await page.evaluate(() => window.__workbench3d().project({ x: 40, y: 40 }));
      assert.equal(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.hasAttribute('data-walkthrough-canvas'), floorPoint), true);
      const first = { ...floorPoint, id: 1 };
      const second = { x: floorPoint.x + 50, y: floorPoint.y, id: 2 };
      const cameraBefore = await page.locator('[data-walkthrough]').getAttribute('data-camera-revision');
      const gestureState = () => page.evaluate(() => ({
        selection: window.__workbench3d().selection,
        width: window.__workbench3d().layout.items[0].width,
        pending: document.querySelector('.studio3d-shell').dataset.pending,
      }));
      report.cameraGesture = { before: await gestureState() };
      await pointer('pointerdown', () => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] }));
      report.cameraGesture.firstContact = await gestureState();
      await pointer('pointerdown', () => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second] }));
      report.cameraGesture.secondContact = await gestureState();
      await pointer('pointermove', () => cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [first, { ...second, x: second.x + 35, y: second.y + 25 }],
      }));
      await pointer('pointerup', () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }));
      assert.notEqual(await page.locator('[data-walkthrough]').getAttribute('data-camera-revision'), cameraBefore);
      assert.equal(await page.locator('.studio3d-shell').getAttribute('data-pending'), 'true',
        'A two-finger camera gesture over a floor must preserve an existing numeric preview');
      assert.equal(await page.evaluate(() => window.__workbench3d().layout.items[0].width), originalItem.width + 10);
      assert.deepEqual((await saved()).items[0], originalItem);
      await activate('[data-studio-cancel]');
      report.checks.push('mobile: a camera gesture starting on the room floor preserves pre-existing numeric edits');
    }

    const beforeRotation = (await saved()).items[0].rotation;
    await change(`document.querySelector('.studio3d-shell').dataset.pending === 'true'`,
      () => activate('[data-studio-rotate]'));
    assert.equal((await saved()).items[0].rotation, beforeRotation);
    await change(`document.querySelector('.studio3d-shell').dataset.pending === 'false'`,
      () => activate('[data-studio-apply]'));
    assert.equal((await saved()).items[0].rotation, (beforeRotation + 15) % 360);
    await close();
    await activate('#undo-action');
    assert.equal((await saved()).items[0].rotation, beforeRotation);
    await open();
    assert.equal(await page.locator('[data-walkthrough]').getAttribute('data-restored-view'), null);
    report.checks.push(`${name}: canvas selection reveals dimensions; preview/apply/one-step undo preserves the drawing and invalidates stale view state`);
    await capture('geometry-changed');
    await context.close();
  }
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
