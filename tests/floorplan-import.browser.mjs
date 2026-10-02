import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as reservePort } from 'node:net';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { twoRooms, apartmentPlan, raster } from './fixtures/floorplan-raster.js';
import { captureRoomScene, settleBrowserPaint } from './browser-rendering.mjs';
import { createFloorplanLayout } from '../src/floorplan-import.js';

const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.FLOORPLAN_OUTPUT ?? join(root, '.omx/artifacts/floorplan-import/browser'));
const timeout = 30000;
const storageKey = 'room-studio-layout-v2';
const stage = value => `document.querySelector('[data-plan-import]')?.dataset.importStage === '${value}'`;
const ready3d = `document.querySelector('[data-walkthrough]')?.dataset.studioReady === 'true'
  && document.querySelector('[data-walkthrough]')?.dataset.assetState === 'ready'`;
const report = { output, groups: [], checks: [], failures: [], screenshots: [], pageErrors: [], externalRequests: [] };
await mkdir(output, { recursive: true });
let server, browser;
let baseURL = process.env.FLOORPLAN_BASE_URL;

// Observes native workers; computation, messages, and application handlers remain real.
function observeWorkers() {
  const NativeWorker = window.Worker;
  const records = [];
  window.__floorplanWorkers = records;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      const record = { url: String(url), terminated: false, sent: 0, received: 0 };
      records.push(record);
      const notify = () => document.dispatchEvent(new Event('floorplan-worker-state'));
      this.addEventListener('message', () => { record.received += 1; notify(); });
      const post = this.postMessage.bind(this);
      this.postMessage = (...args) => { record.sent += 1; notify(); return post(...args); };
      const terminate = this.terminate.bind(this);
      this.terminate = () => { record.terminated = true; notify(); return terminate(); };
      notify();
    }
  };
}

try {
  if (!baseURL) {
    const port = await new Promise((done, reject) => {
      const reservation = reservePort();
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', () => {
        const { port } = reservation.address();
        reservation.close(() => done(port));
      });
    });
    server = await createServer({
      root, cacheDir: join(output, 'vite-cache'),
      server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/.omx/**'] } },
    });
    await server.listen();
    baseURL = `http://127.0.0.1:${port}`;
  }
  report.baseURL = baseURL;
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });

  // Encode real fixture pixels in a disposable browser canvas, not a recognition mock.
  const encoder = await browser.newContext();
  let fixtures;
  try {
    const page = await encoder.newPage();
    fixtures = {};
    for (const [name, image, label] of [
      ['two-rooms', twoRooms({ scale: 3, noise: false }), true],
      ['apartment', apartmentPlan(1.5).image, true],
      ['blank', raster(720, 480), false],
    ]) {
      const encoded = await page.evaluate(({ width, height, data, label }) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height + (label ? 100 : 0);
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
        if (label) {
          context.fillStyle = '#111';
          context.font = 'bold 42px Arial';
          context.fillText('3600 mm', 32, height + 64);
        }
        return canvas.toDataURL('image/png').split(',')[1];
      }, { width: image.width, height: image.height, data: Array.from(image.data), label });
      const path = join(output, `${name}.png`);
      const buffer = Buffer.from(encoded, 'base64');
      await writeFile(path, buffer);
      fixtures[name] = { name: `${name}.png`, mimeType: 'image/png', buffer };
    }
  } finally {
    await encoder.close();
  }

  for (const mobile of [false, true]) {
    const device = mobile ? 'mobile' : 'desktop';
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    page.setDefaultTimeout(timeout);
    await page.addInitScript(observeWorkers);
    page.on('pageerror', error => report.pageErrors.push({ device, message: error.message }));
    context.on('request', request => {
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== new URL(baseURL).origin) {
        report.externalRequests.push({ device, url: url.href, resourceType: request.resourceType() });
      }
    });
    const activate = selector => page.locator(selector)[mobile ? 'tap' : 'click']();
    const saved = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    const snapshot = layout => ({
      zones: layout.zones, items: layout.items, structures: layout.structures,
      dimensions: layout.dimensions, backgroundPlan: layout.backgroundPlan, wallHeight: layout.wallHeight,
    });
    const arm = (expression, limit = timeout) => page.evaluate(({ expression, limit }) => {
      const matches = new Function(`return (${expression})`);
      window.__floorplanSignal = new Promise((done, reject) => {
        const observer = new MutationObserver(check);
        const timer = setTimeout(() => { cleanup(); reject(new Error(`State timeout: ${expression}`)); }, limit);
        function cleanup() {
          clearTimeout(timer);
          observer.disconnect();
          document.removeEventListener('floorplan-worker-state', check);
        }
        function check() { if (matches()) { cleanup(); done(); } }
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        document.addEventListener('floorplan-worker-state', check);
        check();
      });
      window.__floorplanSignal.catch(() => {});
    }, { expression, limit });
    const change = async (expression, action, limit) => {
      await arm(expression, limit);
      await action();
      await page.evaluate(() => window.__floorplanSignal);
    };
    const check = async (name, action) => {
      try {
        await action();
        report.checks.push(`${device}: ${name}`);
        console.log(`PASS ${device}: ${name}`);
        return true;
      } catch (error) {
        report.failures.push({ device, group: name, error: error.stack });
        console.log(`FAIL ${device}: ${name}: ${error.message}`);
        return false;
      }
    };
    const capture = async label => {
      const path = join(output, `${device}-${label}.png`);
      if (await page.locator('[data-walkthrough]').count()) await captureRoomScene(page, path);
      else { await settleBrowserPaint(page); await page.screenshot({ path }); }
      report.screenshots.push(path);
    };
    const group = async (name, action, cleanup) => {
      const firstFailure = report.failures.length;
      try {
        await action();
      } catch (error) {
        report.failures.push({ device, group: name, error: error.stack });
        console.log(`FAIL ${device}: ${name}: ${error.message}`);
        try { await capture(`${name}-failure`); } catch (captureError) {
          report.failures.push({ device, group: `${name} screenshot`, error: captureError.stack });
        }
      } finally {
        await cleanup?.();
      }
      report.groups.push({ device, name, passed: report.failures.length === firstFailure });
      if (report.failures.length === firstFailure) console.log(`PASS ${device}: ${name}`);
    };
    const fresh = async () => {
      // Clear only this test context between independent groups, never during a workflow.
      await page.goto(baseURL);
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.locator('[data-start-plan-file]').waitFor({ state: 'attached' });
    };
    const upload = async (fixture = fixtures['two-rooms']) => {
      await change(stage('review'), () => page.locator('[data-start-plan-file]').setInputFiles(fixture));
    };
    const geometry = () => page.locator('[data-room]').evaluateAll(nodes => nodes.map(node => ({
      id: node.dataset.room, name: node.getAttribute('aria-label').split(', ')[0],
      points: node.querySelector('polygon').getAttribute('points').split(' ').map(pair => {
        const [x, y] = pair.split(',').map(Number);
        return { x, y };
      }),
    })));
    const imagePoint = (x, y) => page.locator('[data-import-canvas]').evaluate((svg, { x, y }) => {
      const point = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM());
      return { x: point.x, y: point.y };
    }, { x, y });
    const tapPoint = async (x, y) => {
      await page.locator('[data-import-canvas]').scrollIntoViewIfNeeded();
      const point = await imagePoint(x, y);
      await pointer('pointerup', () => mobile
        ? page.touchscreen.tap(point.x, point.y) : page.mouse.click(point.x, point.y));
    };
    const pointer = async (type, action) => {
      await page.evaluate(type => {
        window.__floorplanPointer = new Promise((done, reject) => {
          const handler = event => { clearTimeout(timer); done({ trusted: event.isTrusted, type: event.pointerType }); };
          const timer = setTimeout(() => {
            document.removeEventListener(type, handler, true);
            reject(new Error(`Missing native ${type}`));
          }, 10000);
          document.addEventListener(type, handler, { once: true, capture: true });
        });
        window.__floorplanPointer.catch(() => {});
      }, type);
      await action();
      assert.deepEqual(await page.evaluate(() => window.__floorplanPointer),
        { trusted: true, type: mobile ? 'touch' : 'mouse' });
    };
    const dragHandle = async (kind = 'vertex', cancel = false, secondTouch = false, index = 0, direction = 1) => {
      await page.locator('[data-import-canvas]').scrollIntoViewIfNeeded();
      const point = await page.locator(`[data-handle="${kind}"][data-index="${index}"]`).evaluate(node => {
        const circle = node.querySelector('circle');
        const p = new DOMPoint(Number(circle.getAttribute('cx')), Number(circle.getAttribute('cy')))
          .matrixTransform(node.ownerSVGElement.getScreenCTM());
        return { x: p.x, y: p.y };
      });
      const end = { x: point.x + 12 * direction, y: point.y + 10 * direction };
      if (mobile) {
        await pointer('pointerdown', () => cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart', touchPoints: [{ ...point, id: 1 }],
        }));
        await pointer('pointermove', () => cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove', touchPoints: [{ ...end, id: 1 }],
        }));
        if (secondTouch) {
          await pointer('pointerdown', () => cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart', touchPoints: [{ ...end, id: 1 }, { x: end.x + 65, y: end.y + 55, id: 2 }],
          }));
        }
        await pointer(cancel ? 'pointercancel' : 'pointerup', () => cdp.send('Input.dispatchTouchEvent', {
          type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [],
        }));
      } else {
        await page.mouse.move(point.x, point.y);
        await pointer('pointerdown', () => page.mouse.down());
        await pointer('pointermove', () => page.mouse.move(end.x, end.y));
        await pointer('pointerup', () => page.mouse.up());
      }
    };
    const surface = async label => {
      await settleBrowserPaint(page);
      await check(`${label}: no horizontal overflow and 44px controls`, async () => {
        const result = await page.evaluate(() => {
          const root = document.querySelector('[data-plan-import]') ?? document.querySelector('.starter-dialog');
          const small = [...root.querySelectorAll('button, input:not([hidden]):not([type="file"]), select, summary, label.plan-import-check, label[role="button"]')]
            .filter(node => node.getClientRects().length && node.type !== 'checkbox')
            .map(node => ({ control: node.dataset.action ?? node.dataset.field ?? node.textContent.trim().slice(0, 40),
              width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }))
            .filter(rect => rect.width < 43.99 || rect.height < 43.99);
          return { overflow: document.documentElement.scrollWidth > innerWidth + 1, small };
        });
        assert.equal(result.overflow, false);
        assert.deepEqual(result.small, []);
      });
      await capture(label);
    };
    const trap = async () => {
      await page.evaluate(() => {
        const root = document.querySelector('[data-plan-import]');
        const focusable = [...root.querySelectorAll('button:not(:disabled), input:not([hidden]):not(:disabled), select, summary, [tabindex="0"]')]
          .filter(node => node.getClientRects().length);
        focusable.at(-1).focus();
      });
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('[data-plan-import] button')), true);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.querySelector('[data-plan-import]').contains(document.activeElement)), true);
    };

    await group('starter-gallery', async () => {
      await fresh();
      assert.equal(await page.locator('[data-start-plan]').isVisible(), true);
      await surface('starter');
      const chooser = page.waitForEvent('filechooser');
      await activate('[data-start-plan]');
      assert.equal((await chooser).isMultiple(), false);
      await activate('[data-start-gallery]');
      await page.locator('[data-demo-search]').fill('대치');
      const visible = await page.locator('[data-demo-card]:visible').allTextContents();
      assert.ok(visible.length > 0 && visible.every(text => text.includes('대치')));
      await page.locator('[data-demo-search]').fill('unregistered-real-floorplan');
      assert.equal(await page.locator('[data-demo-card]:visible').count(), 0);
      assert.equal(await page.locator('[data-demo-empty]').isVisible(), true);
      await capture('gallery-search');
      report.checks.push(`${device}: primary real upload chooser and honest gallery search`);
    });

    let releaseOCR;
    let cancelledOCR = false;
    const heldOCR = new Promise(done => { releaseOCR = done; });
    const holdOCR = async route => {
      await heldOCR;
      if (!cancelledOCR) await route.continue();
    };
    await context.route(/\/ocr\/worker\.min\.js(?:\?|$)/, holdOCR);
    await group('image-edit-scale-apply', async () => {
      await fresh();
      await upload();
      const recognized = await geometry();
      assert.ok(recognized.length >= 2, `Real fixture recognition produced ${recognized.length} polygons`);
      assert.ok(recognized.every(room => room.points.length >= 3));
      await surface('review');
      await trap();
      await page.locator('[data-select-room]').first()[mobile ? 'tap' : 'click']();
      await page.locator('[data-field="included"]').uncheck();
      assert.equal(await page.locator('[data-field="included"]').isChecked(), false);
      await page.locator('[data-field="included"]').check();
      await page.locator('[data-field="room-name"]').fill('테스트 거실');
      await page.locator('[data-field="room-type"]').selectOption('거실');
      await activate('[data-action="vertices"]');
      const beforeDrag = await geometry();
      await dragHandle();
      assert.notDeepEqual(await geometry(), beforeDrag);
      const beforeKey = await geometry();
      await page.locator('[data-handle="vertex"][data-index="0"]').focus();
      await page.keyboard.press('ArrowRight');
      assert.equal((await geometry())[0].points[0].x, beforeKey[0].points[0].x + 1);
      await page.locator('summary').filter({ hasText: '모서리 좌표로 조정' }).click();
      const numericX = Math.round((await geometry())[0].points[0].x) + 2;
      await page.locator('[data-field="vertex-x"]').fill(String(numericX));
      await page.locator('[data-field="vertex-x"]').press('Tab');
      assert.equal((await geometry())[0].points[0].x, numericX);
      await page.locator('[data-field="vertex"]').selectOption('1');
      assert.equal(await page.locator('[data-field="vertex"]').evaluate(node => node.closest('details').open), true,
        'Selecting another corner must keep its coordinate controls open');
      assert.equal(await page.locator('[data-field="vertex"]').evaluate(node => document.activeElement === node), true);
      await page.locator('[data-field="vertex"]').selectOption('0');
      if (mobile) {
        const beforeCancel = await geometry();
        await dragHandle('vertex', true);
        assert.deepEqual(await geometry(), beforeCancel, 'Native pointercancel must restore the polygon');
        await dragHandle('vertex', false, true);
        assert.deepEqual(await geometry(), beforeCancel, 'A second native touch must roll back a vertex drag');
      }
      report.checks.push(`${device}: inclusion, name/type, native vertex drag, keyboard and numeric editing${mobile ? ', pointercancel and second-touch rollback' : ''}`);
      await activate('[data-action="draw"]');
      // Add a missing closed polygon in the fixture's whitespace.
      for (const [x, y] of [[8, 490], [200, 490], [200, 502], [212, 502], [212, 565], [8, 565]]) await tapPoint(x, y);
      await activate('[data-action="finish-draw"]');
      assert.equal((await geometry()).length, recognized.length + 1);
      // Nearby corner hit targets overlap. Up/left keeps this outline valid.
      const denseBefore = (await geometry()).at(-1).points;
      await dragHandle('vertex', false, false, 1, -1);
      const denseAfter = (await geometry()).at(-1).points;
      assert.notDeepEqual(denseAfter[1], denseBefore[1], 'The nearest corner wins over SVG paint order');
      assert.deepEqual(denseAfter.filter((_, index) => index !== 1), denseBefore.filter((_, index) => index !== 1));
      assert.equal(await page.locator('[data-field="vertex"]').inputValue(), '1');
      await page.locator('[data-handle="vertex"][data-index="2"]').focus();
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.locator('[data-field="vertex"]').inputValue(), '2',
        'Keyboard edits and numeric corner selection must identify the same vertex');
      await page.locator('[data-field="room-name"]').fill('수동 공간');
      const doors = page.locator('[data-opening-included]');
      report.checks.push(`${device}: manual missing polygon; ${await doors.count()} real optional door candidates left unconfirmed`);
      await page.locator('[data-select-room]').first()[mobile ? 'tap' : 'click']();
      await activate('[data-action="scale"]');
      assert.equal(await page.locator('.plan-import-body').evaluate(node => node.scrollTop), 0,
        'A new import step starts at its image and primary input instead of an old scroll offset');
      assert.equal(await page.locator('[data-action="apply"]').first().isDisabled(), true);
      await surface('scale-empty');
      await page.locator('[data-field="length"]').fill('3600');
      await page.locator('[data-field="unit"]').selectOption('mm');
      await arm(`window.__floorplanWorkers.some(worker => worker.url.includes('/ocr/') && !worker.terminated)`);
      await page.evaluate(() => window.__floorplanSignal);
      assert.equal(await page.locator('[data-candidate]').count(), 0, 'The real OCR worker is still loading');
      assert.equal(await page.locator('[data-action="apply"]').first().isEnabled(), true,
        'Manual calibration must be usable independently of OCR completion');
      report.checks.push(`${device}: valid manual calibration stays usable while the real OCR worker is held loading`);
      await page.locator('[data-field="length"]').fill('0');
      assert.equal(await page.locator('[data-action="apply"]').first().isDisabled(), true);
      await page.locator('[data-field="length"]').fill('3600');
      await page.locator('[data-field="unit"]').selectOption('');
      assert.equal(await page.locator('[data-action="apply"]').first().isDisabled(), true);
      await page.locator('[data-field="unit"]').selectOption('mm');
      releaseOCR();
      await check('real OCR text, numeric value, and unit', async () => {
        await arm(`Array.from(document.querySelectorAll('[data-candidate]')).some(node => /3600\\s*mm/i.test(node.textContent))`, 90000);
        await page.evaluate(() => window.__floorplanSignal);
        const candidate = page.locator('[data-candidate]').filter({ hasText: /3600\s*mm/i }).first();
        await candidate[mobile ? 'tap' : 'click']();
        assert.equal(await page.locator('[data-field="length"]').inputValue(), '3600');
        assert.equal(await page.locator('[data-field="unit"]').inputValue(), 'mm');
      });
      await page.locator('summary').filter({ hasText: '기준 공간·벽 바꾸기' }).click();
      await page.locator('[data-field="reference-edge"]').selectOption('0');
      assert.equal(await page.locator('[data-field="length"]').inputValue(), '');
      assert.equal(await page.locator('[data-action="apply"]').first().isDisabled(), true);
      await page.locator('[data-field="length"]').fill('3600');
      await activate('[data-action="reference"]');
      await change(`document.querySelector('[data-action="reference"]')?.getAttribute('aria-pressed') === 'false'
        && document.querySelectorAll('[data-handle="reference"]').length === 2`, async () => {
        await tapPoint(60, 60);
        await tapPoint(360, 60);
      });
      await check('custom reference invalidates stale length', async () => {
        assert.equal(await page.locator('[data-field="length"]').inputValue(), '');
        assert.equal(await page.locator('[data-action="apply"]').first().isDisabled(), true);
      });
      await page.locator('[data-field="length"]').fill('3600');
      await page.locator('[data-field="unit"]').selectOption('mm');
      await page.locator('[data-handle="reference"][data-index="1"]').focus();
      await page.keyboard.press('ArrowRight');
      await check('reference handle edit invalidates stale length', async () => {
        assert.equal(await page.locator('[data-field="length"]').inputValue(), '');
        assert.equal(await page.locator('[data-action="apply"]').first().isDisabled(), true);
      });
      await page.locator('[data-field="length"]').fill('3600');
      await dragHandle('reference');
      await check('reference drag invalidates stale length', async () => {
        assert.equal(await page.locator('[data-field="length"]').inputValue(), '');
        assert.equal(await page.locator('[data-action="apply"]').first().isDisabled(), true);
      });
      await page.locator('[data-field="length"]').fill('3600');
      await page.locator('[data-field="unit"]').selectOption('mm');
      await surface('scale-confirmed');
      const expected = await page.evaluate(() => {
        const svg = document.querySelector('[data-import-canvas]');
        const image = svg.querySelector('image');
        const endpoints = [...svg.querySelectorAll('[data-handle="reference"]')].map(handle => {
          const circle = handle.querySelector('circle');
          return { x: Number(circle.getAttribute('cx')), y: Number(circle.getAttribute('cy')) };
        });
        return {
          image: { width: Number(image.getAttribute('width')), height: Number(image.getAttribute('height')),
            dataUrl: image.getAttribute('href'), name: document.querySelector('.plan-import-file-name').textContent },
          reference: { start: endpoints[0], end: endpoints[1],
            length: document.querySelector('[data-field="length"]').value,
            unit: document.querySelector('[data-field="unit"]').value },
        };
      });
      expected.rooms = (await geometry()).map((room, index) => ({
        ...room, included: true, type: index === 0 ? '거실' : '기타',
      }));
      const expectedLayout = createFloorplanLayout(expected);
      await change(ready3d, () => activate('[data-action="apply"][data-open-3d]'));
      let layout = await saved();
      assert.deepEqual(snapshot(layout), expectedLayout);
      assert.equal(await page.locator('[data-walkthrough]').getAttribute('data-view-mode'), 'dollhouse');
      await capture('dollhouse');
      await activate('button[data-view-mode="top"]');
      await capture('top');
      await activate('[data-studio-add]');
      await activate('[data-studio-tab="item"]');
      await capture('catalog');
      await change(`document.querySelector('.studio3d-shell')?.dataset.pending === 'true' && ${ready3d}`,
        () => activate('[data-studio-asset="seoul-dining-chair"]'));
      await activate('[data-studio-apply]');
      layout = await saved();
      assert.equal(layout.items.length, 1);
      assert.equal(layout.items[0].assetId, 'seoul-dining-chair');
      assert.deepEqual(layout.zones, expectedLayout.zones);
      await capture('furniture-applied');
      await change(`!document.querySelector('[data-walkthrough]')`,
        () => activate('.workbench-modes [data-walkthrough-exit]'));
      const persisted = snapshot(await saved());
      assert.deepEqual(persisted.dimensions, expectedLayout.dimensions);
      assert.deepEqual(persisted.backgroundPlan, expectedLayout.backgroundPlan);
      await capture('returned-2d');
      await page.reload();
      await page.locator('#plan-canvas').waitFor();
      assert.deepEqual(snapshot(await saved()), persisted);
      await activate('[data-project-open]');
      const download = page.waitForEvent('download');
      await activate('[data-project-export]');
      const exported = await download;
      const path = join(output, `${device}-roundtrip.roomstudio.json`);
      await exported.saveAs(path);
      const portable = JSON.parse(await readFile(path, 'utf8'));
      assert.deepEqual(snapshot(portable.layout), persisted);
      await activate('[data-project-open]');
      await change(`!document.querySelector('[data-project-backdrop]')`, () =>
        page.locator('[data-project-import]').setInputFiles(path));
      assert.deepEqual(snapshot(await saved()), persisted);
      await capture('portable-roundtrip');
      report.checks.push(`${device}: actual 3D catalog placement/apply, exact imported geometry/calibration/background, 2D return, reload and portable round trip`);
      assert.equal(await page.evaluate(() => window.__floorplanWorkers.every(worker => worker.terminated)), true);
    }, async () => {
      cancelledOCR = true;
      releaseOCR();
      await context.unroute(/\/ocr\/worker\.min\.js(?:\?|$)/, holdOCR);
    });

    await group('review-scale-cancellation', async () => {
      await fresh();
      await change(`!document.querySelector('[data-start-backdrop]')`,
        () => page.locator('[name="roomWidth"]').press('Enter'));
      const original = snapshot(await saved());
      for (const reviewStage of ['review', 'scale']) {
        await activate('[data-start-open]');
        await upload();
        if (reviewStage === 'scale') await activate('[data-action="scale"]');
        await trap();
        await capture(`cancel-${reviewStage}`);
        await change(`!document.querySelector('[data-plan-import]')`, () => page.keyboard.press('Escape'));
        assert.deepEqual(snapshot(await saved()), original);
        assert.equal(await page.evaluate(() => document.querySelector('#app').inert), false);
        assert.equal(await page.evaluate(() => document.querySelector('[data-start-backdrop]').contains(document.activeElement)), true);
        assert.equal(await page.evaluate(() => window.__floorplanWorkers.every(worker => worker.terminated)), true);
        await activate('[data-start-close]');
      }
      report.checks.push(`${device}: review/scale Escape cancellation preserves the real original document, focus and worker cleanup`);
    });

    await group('keyboard-rerender-cancellation', async () => {
      for (const action of ['room-list', 'room-canvas', 'vertices', 'back', 'rectify']) {
        await fresh();
        await upload();
        if (action === 'back') await activate('[data-action="scale"]');
        if (action === 'rectify') await page.locator('[data-import-disclosure="photo"] summary').click();
        const selector = action === 'room-list' ? '[data-select-room="room-2"]'
          : action === 'room-canvas' ? '[data-room="room-2"]' : `[data-action="${action}"]`;
        await page.locator(selector).focus();
        await page.locator(selector).press('Enter');
        await settleBrowserPaint(page);
        const focusStayedInside = await page.evaluate(() =>
          document.querySelector('[data-plan-import]').contains(document.activeElement));
        await page.keyboard.press('Escape');
        assert.equal(focusStayedInside, true, `${action}: rendering must preserve modal keyboard focus`);
        assert.equal(await page.locator('[data-plan-import]').count(), 0, `${action}: immediate Escape must close the importer`);
        assert.equal(await page.evaluate(() => document.querySelector('#app').inert), false);
        assert.equal(await page.evaluate(() => window.__floorplanWorkers.every(worker => worker.terminated)), true);
      }
    });

    await group('processing-abort', async () => {
      await fresh();
      let release;
      const held = new Promise(done => { release = done; });
      let received;
      const requested = new Promise(done => { received = done; });
      let cancelled = false;
      const heldWorkers = new Set();
      const workerScript = /(?:floorplan-recognition\.worker(?:-[\w-]+)?|\/ocr\/worker\.min)\.js(?:\?|$)/;
      const route = async intercepted => {
        heldWorkers.add(intercepted.request().url().includes('floorplan-recognition') ? 'geometry' : 'ocr');
        if (heldWorkers.size === 2) received();
        await held;
        // Termination already cancels the held request; it has no response to resume.
        if (!cancelled) await intercepted.continue();
      };
      // Hold loading, not the response or recognition result. Actual workers are owned.
      await context.route(workerScript, route);
      try {
        await change(stage('loading'), () => page.locator('[data-start-plan-file]').setInputFiles(fixtures['two-rooms']));
        await Promise.race([requested, new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Worker load was not intercepted')), timeout);
          requested.finally(() => clearTimeout(timer));
        })]);
        await arm(`window.__floorplanWorkers.some(worker => worker.url.includes('floorplan-recognition') && !worker.terminated)
          && window.__floorplanWorkers.some(worker => worker.url.includes('/ocr/') && !worker.terminated)`);
        await page.evaluate(() => window.__floorplanSignal);
        assert.equal(await page.locator('[data-plan-import]').getAttribute('data-import-stage'), 'loading');
        assert.equal(await page.evaluate(() => window.__floorplanWorkers.filter(worker => !worker.terminated)
          .every(worker => worker.received === 0)), true);
        await surface('processing-cancel');
        assert.equal(await page.locator('[data-plan-import]').getAttribute('data-import-stage'), 'loading');
        const before = await saved();
        await change(`!document.querySelector('[data-plan-import]')`, () => activate('.plan-import-header [data-action="close"]'));
        const terminated = await page.evaluate(() => window.__floorplanWorkers);
        assert.ok(terminated.length >= 2);
        assert.ok(terminated.every(worker => worker.terminated), JSON.stringify(terminated));
        cancelled = true;
        release();
        await context.unroute(workerScript, route);
        await upload(fixtures.blank);
        assert.equal(await page.locator('[data-room]').count(), 0);
        assert.equal(await page.locator('[data-action="scale"]').isDisabled(), true);
        assert.deepEqual(await saved(), before, 'Aborted workers must not replace or save the next import');
        await capture('abort-no-stale-review');
        await activate('[data-action="close"]');
        report.checks.push(`${device}: processing abort terminates both held native workers and has no stale effects on the next real import`);
      } finally {
        cancelled = true;
        release();
        await context.unroute(workerScript, route);
      }
    });

    await group('photo-correction-and-short-screen', async () => {
      await fresh();
      await upload();
      const imageSize = () => page.locator('[data-import-canvas] image').evaluate(node => ({
        width: Number(node.getAttribute('width')), height: Number(node.getAttribute('height')),
      }));
      const original = await imageSize();
      await page.locator('[data-import-disclosure="photo"] summary').click();
      await change(`${stage('review')} && Number(document.querySelector('[data-import-canvas] image')?.getAttribute('width')) === ${original.height}`,
        () => activate('[data-action="rotate"]'));
      assert.deepEqual(await imageSize(), { width: original.height, height: original.width });
      await capture('photo-rotated');
      await page.locator('[data-import-disclosure="photo"] summary').click();
      await change(`${stage('review')} && Number(document.querySelector('[data-import-canvas] image')?.getAttribute('width')) === ${original.width}`,
        () => activate('[data-action="restore-photo"]'));
      assert.deepEqual(await imageSize(), original);
      await page.locator('[data-import-disclosure="photo"] summary').click();
      await change(stage('rectify'), () => activate('[data-action="rectify"]'));
      await settleBrowserPaint(page);
      const targets = await page.locator('[data-handle="photo"] circle:first-child').evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect(), frame = node.ownerSVGElement.getBoundingClientRect();
        return { width: Math.min(rect.right, frame.right) - Math.max(rect.left, frame.left),
          height: Math.min(rect.bottom, frame.bottom) - Math.max(rect.top, frame.top) };
      }));
      assert.equal(targets.length, 4);
      assert.ok(targets.every(target => target.width >= 43.9999 && target.height >= 43.9999),
        `Photo handles must retain their full 44px targets inside the canvas: ${JSON.stringify(targets)}`);
      await page.locator('[data-field="photo-aspect"]').selectOption('original');
      await dragHandle('photo');
      await capture('photo-corners');
      await change(stage('review'), () => activate('[data-action="apply-rectify"]'));
      assert.ok(await page.locator('[data-room]').count() >= 2);
      assert.notDeepEqual(await imageSize(), original);
      await capture('photo-corrected');
      if (mobile) {
        await page.setViewportSize({ width: 844, height: 390 });
        for (const button of await page.locator('.plan-import-toolbar button').all()) {
          await button.scrollIntoViewIfNeeded();
          const reachable = await button.evaluate(node => {
            const rect = node.getBoundingClientRect(), body = document.querySelector('.plan-import-body').getBoundingClientRect();
            return rect.top >= body.top && rect.bottom <= body.bottom
              && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === node;
          });
          assert.equal(reachable, true, 'Every landscape canvas control must scroll fully above the footer');
        }
        await activate('[data-action="vertices"]');
        assert.equal(await page.locator('[data-action="vertices"]').getAttribute('aria-pressed'), 'true');
        await capture('landscape-tools');
      }
      if (mobile) await page.setViewportSize({ width: 390, height: 480 });
      await change(stage('scale'), () => activate('[data-action="scale"]'));
      await settleBrowserPaint(page);
      const visible = await page.locator('[data-field="length"]').evaluate(node => {
        const rect = node.getBoundingClientRect(), body = document.querySelector('.plan-import-body').getBoundingClientRect();
        return document.activeElement === node && rect.top >= body.top && rect.bottom <= body.bottom;
      });
      assert.equal(visible, true, 'The focused length input must remain visible above the footer on a short screen');
      await capture('short-screen-length');
      await activate('[data-action="close"]');
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => window.__floorplanWorkers.every(worker => worker.terminated)), true);
    });

    await group('unsupported-blank-apartment', async () => {
      await fresh();
      await change(stage('choose'), () => page.locator('[data-start-plan-file]').setInputFiles({
        name: 'unsupported.svg', mimeType: 'image/svg+xml',
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>'),
      }));
      assert.equal(await page.locator('[data-import-error]').isVisible(), true);
      assert.ok((await page.locator('[data-import-error]').textContent()).trim().length > 0);
      assert.equal(await page.locator('[data-action="apply"]').count(), 0);
      await surface('unsupported-error');
      await trap();
      await change(stage('review'), () => page.locator('[data-import-file]').setInputFiles(fixtures.blank));
      assert.equal(await page.locator('[data-room]').count(), 0);
      assert.equal(await page.locator('[data-action="scale"]').isDisabled(), true);
      assert.equal(await page.locator('[data-action="apply"]').count(), 0);
      assert.ok((await page.locator('[data-import-notice]').textContent()).trim().length > 0);
      await surface('blank-no-room');
      await change(`${stage('review')} && document.querySelector('.plan-import-file-name')?.textContent === 'apartment.png'`,
        () => page.locator('[data-import-file]').setInputFiles(fixtures.apartment));
      assert.ok(await page.locator('[data-room]').count() >= 2, 'Real apartment pixels must yield multiple editable spaces');
      await surface('apartment-review');
      await activate('[data-action="only-room"]');
      await activate('[data-action="scale"]');
      await page.locator('[data-field="length"]').fill('400');
      await change(`!document.querySelector('[data-plan-import]')`,
        () => activate('[data-action="apply"]:not([data-open-3d])'));
      assert.equal((await saved()).zones.length, 1, 'The one-room shortcut must exclude the other recognized regions');
      assert.equal(await page.evaluate(() => window.__floorplanWorkers.every(worker => worker.terminated)), true);
      report.checks.push(`${device}: unsupported format and blank image are honest/non-applicable; apartment pixels yield editable polygons`);
    });
    await context.close();
  }
  assert.deepEqual(report.pageErrors, [], 'The app must not raise uncaught page errors');
  assert.deepEqual(report.externalRequests, [], 'Image recognition and OCR must remain local, with no external requests');
} catch (error) {
  report.failures.push({ group: 'suite', error: error.stack });
} finally {
  await browser?.close();
  await server?.close();
  report.passed = report.failures.length === 0;
  if (!report.passed) process.exitCode = 1;
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
