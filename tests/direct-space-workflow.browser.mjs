import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
import { captureRoomScene, settleBrowserPaint } from './browser-rendering.mjs';

const url = process.argv[2];
assert.ok(url, 'Pass the URL of a freshly built production preview');
const output = resolve('.omx/artifacts/direct-space-editor/workflow');
await mkdir(output, { recursive: true });
const report = { url, output, checks: [], screenshots: [], errors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let page;
try {
  for (const mobile of [false, true]) {
    const name = mobile ? 'mobile' : 'desktop';
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      deviceScaleFactor: 1, hasTouch: mobile, isMobile: mobile, reducedMotion: 'reduce',
    });
    page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    const activate = selector => mobile ? page.locator(selector).tap() : page.locator(selector).click();
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('room-studio-layout-v2')));
    const project = point => page.locator('#plan-canvas').evaluate((svg, p) => {
      const screen = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: screen.x, y: screen.y };
    }, point);
    const capture = async label => {
      const file = join(output, `${name}-${label}.png`);
      if (await page.locator('[data-walkthrough-canvas]').count()) await captureRoomScene(page, file);
      else { await settleBrowserPaint(page); await page.screenshot({ path: file }); }
      report.screenshots.push(file);
    };
    const arm = async expression => {
      await page.evaluate(expression => {
        window.__workflowSignal = new Promise((done, reject) => {
          const test = new Function(`return (${expression})`);
          const observer = new MutationObserver(check);
          const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`State timeout: ${expression}`)); }, 20000);
          function check() { if (test()) { clearTimeout(timeout); observer.disconnect(); done(); } }
          observer.observe(document.documentElement, { subtree: true, attributes: true, childList: true });
          check();
        });
      }, expression);
    };
    const change = async (expression, action) => {
      await arm(expression); await action(); await page.evaluate(() => window.__workflowSignal);
    };
    const drag = async (from, to) => {
      if (mobile) {
        for (const [type, points, eventType] of [
          ['touchStart', [{ ...from, id: 1 }], 'pointerdown'],
          ['touchMove', [{ ...to, id: 1 }], 'pointermove'],
          ['touchEnd', [], 'pointerup'],
        ]) {
          await page.evaluate(type => {
            window.__pointerSignal = new Promise((done, reject) => {
              const handler = event => { clearTimeout(timer); done({ trusted: event.isTrusted, type: event.pointerType }); };
              const timer = setTimeout(() => { document.removeEventListener(type, handler, true); reject(new Error(type)); }, 10000);
              document.addEventListener(type, handler, { once: true, capture: true });
            });
          }, eventType);
          await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
          assert.deepEqual(await page.evaluate(() => window.__pointerSignal), { trusted: true, type: 'touch' });
        }
      } else {
        await page.mouse.move(from.x, from.y); await page.mouse.down();
        await page.mouse.move(to.x, to.y); await page.mouse.up();
      }
    };
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await activate('[data-start-blank]');
    await activate('[data-space-tool="draw"]');
    const outline = mobile
      ? [[20, 20], [140, 20], [140, 190], [260, 190], [260, 20], [380, 20], [380, 300], [20, 300]]
      : [[30, 20], [360, 20], [360, 100], [240, 140], [240, 280], [30, 280]];
    for (let i = 0; i < outline.length; i += 1) {
      const from = await project({ x: outline[i][0], y: outline[i][1] });
      if (mobile) await page.touchscreen.tap(from.x, from.y);
      else {
        const next = outline[(i + 1) % outline.length];
        await drag(from, await project({ x: next[0], y: next[1] }));
      }
    }
    if (mobile) await activate('[data-space-finish]');
    const drawing = await saved();
    assert.equal(drawing.zones.length, 1);
    const zone = drawing.zones[0];
    assert.deepEqual(zone.points.map(p => [p.x + zone.x, p.y + zone.y]), outline);
    assert.equal(await page.locator('[data-space-edge]').count(), outline.length);
    await capture('drawn');
    report.checks.push(`${name}: native ${mobile ? 'tap-drawn U' : 'drag-drawn angled stepped'} polygon closes as one space`);

    await activate('[data-space-edge="0"]');
    await page.locator('[data-edge-length]').fill('0');
    assert.equal(await page.locator('[data-edge-length]').getAttribute('aria-invalid'), 'true');
    assert.deepEqual((await saved()).zones, drawing.zones);
    await capture('invalid-length');
    await activate('[data-edge-cancel]');

    const beforePan = await page.locator('#plan-canvas').getAttribute('viewBox');
    await activate('[data-space-tool="pan"]');
    const origin = await project({ x: 80, y: 120 });
    await drag(origin, { x: origin.x + 24, y: origin.y + 18 });
    assert.notEqual(await page.locator('#plan-canvas').getAttribute('viewBox'), beforePan);
    assert.deepEqual((await saved()).zones, drawing.zones);
    await activate('[data-space-tool="select"]');
    await activate('#zoom-fit');
    report.checks.push(`${name}: invalid length never persists; explicit pan over a room preserves geometry`);

    if (!mobile) {
      const anchor = await project({ x: 100, y: 100 });
      const worldAt = () => page.locator('#plan-canvas').evaluate((svg, p) => {
        const world = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM().inverse());
        return { x: world.x, y: world.y };
      }, anchor);
      const before = await worldAt();
      const view = await page.locator('#plan-canvas').getAttribute('viewBox');
      await page.mouse.move(anchor.x, anchor.y);
      await change(`document.querySelector('#plan-canvas').getAttribute('viewBox') !== ${JSON.stringify(view)}`, () => page.mouse.wheel(0, -220));
      const after = await worldAt();
      assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 0.1);
      assert.deepEqual((await saved()).zones, drawing.zones);
      await capture('focal-zoom');
      await activate('#zoom-fit');
      report.checks.push('desktop: wheel zoom preserves the world point under the mouse');
    }

    const ready = `document.querySelector('[data-walkthrough]')?.dataset.studioReady === 'true' && document.querySelector('[data-walkthrough]')?.dataset.assetState === 'ready'`;
    await change(ready, () => activate('#open-walkthrough'));
    await capture('3d-dollhouse');
    await activate('[data-view-mode="top"]');
    await capture('3d-top');
    if (await page.locator('[data-studio-toggle]').getAttribute('aria-expanded') === 'false') await activate('[data-studio-toggle]');
    await activate('[data-studio-tab="item"]');
    await page.locator('[data-studio-search]').fill('의자');
    await change(`document.querySelector('.studio3d-shell').dataset.pending === 'true' && ${ready}`, () => page.locator('[data-studio-asset]:not([hidden])').first()[mobile ? 'tap' : 'click']());
    await change(`document.querySelector('.studio3d-shell').dataset.pending === 'false'`, () => activate('[data-studio-apply]'));
    const placed = await saved();
    assert.equal(placed.items.length, 1);
    await activate('[data-studio-rotate]');
    await change(`document.querySelector('.studio3d-shell').dataset.pending === 'false'`, () => activate('[data-studio-apply]'));
    assert.equal((await saved()).items[0].rotation, (placed.items[0].rotation + 15) % 360);
    await capture('3d-furnished');
    await activate('.walkthrough-exit');
    const normalizedZones = drawing.zones.map(zone => ({ locked: false, walkthroughStart: false, ...zone }));
    assert.deepEqual((await saved()).zones, normalizedZones);
    report.checks.push(`${name}: production 3D shows the same polygon and applies actual asset placement and rotation`);

    await activate('[data-project-open]');
    const downloadReady = page.waitForEvent('download');
    await activate('[data-project-export]');
    const download = await downloadReady;
    const file = join(output, `${name}.roomstudio.json`);
    await download.saveAs(file);
    const portable = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(portable.layout.zones, normalizedZones);
    assert.equal(portable.layout.items.length, 1);
    assert.equal(portable.schemaVersion, 4);
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.deepEqual((await saved()).zones, normalizedZones);
    assert.equal((await saved()).items.length, 1);
    report.checks.push(`${name}: polygon and furniture survive portable export and reload`);
    for (const size of mobile ? [[320, 568], [375, 812], [768, 1024], [844, 390]] : [[1280, 800]]) {
      await page.evaluate(([width, height]) => {
        window.__viewportReady = new Promise((done, reject) => {
          const canvas = document.querySelector('.canvas-wrap');
          const observer = new ResizeObserver(check);
          const finish = error => {
            clearTimeout(timeout); observer.disconnect(); window.removeEventListener('resize', check);
            if (error) reject(error); else done();
          };
          const timeout = setTimeout(() => finish(new Error('Viewport did not expose the full drawing surface')), 10000);
          function check() {
            const rect = canvas.getBoundingClientRect();
            const nav = document.querySelector('.mobile-nav').getBoundingClientRect();
            if (innerWidth === width && innerHeight === height && rect.height >= 150
              && rect.bottom <= (nav.height ? nav.top : innerHeight) + 1) finish();
          }
          observer.observe(canvas); observer.observe(document.documentElement);
          window.addEventListener('resize', check);
          check();
        });
      }, size);
      await page.setViewportSize({ width: size[0], height: size[1] });
      await page.evaluate(() => window.__viewportReady);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const visibleCanvas = await page.locator('.canvas-wrap').evaluate(node => {
        const rect = node.getBoundingClientRect();
        const nav = document.querySelector('.mobile-nav').getBoundingClientRect();
        return Math.min(rect.bottom, nav.height ? nav.top : innerHeight) - Math.max(0, rect.top);
      });
      assert.ok(visibleCanvas >= 150, `the drawing must expose at least 150px without scrolling at ${size.join('x')}: ${visibleCanvas}`);
      if (mobile && size[0] > size[1]) {
        await capture('landscape-ready');
        const center = await project({ x: 80, y: 120 });
        await page.touchscreen.tap(center.x, center.y);
        const start = await project({ x: 80, y: 120 });
        await drag(start, { x: start.x + 24, y: start.y + 18 });
        assert.notDeepEqual((await saved()).zones, normalizedZones);
        await activate('#undo-action');
        assert.deepEqual((await saved()).zones, normalizedZones);
        report.checks.push('mobile landscape: visible polygon accepts native selection and drag with one-step undo');
      }
      await capture(`viewport-${size.join('x')}`);
    }
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack; process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png') });
} finally {
  await browser.close();
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
