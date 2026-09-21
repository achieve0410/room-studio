import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { zoneFromPoints, attachOpeningToZoneEdge } from '../src/geometry.js';

const root = resolve(import.meta.dirname, '..');
const output = join(root, '.omx/artifacts/direct-space-editor/transactions');
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [] };
const server = await createServer({
  root, cacheDir: join(output, 'vite-cache'),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/.omx/**'] } },
  plugins: [{
    name: 'observe-space-transactions',
    transform(source, id) {
      if (id.split('?')[0] !== join(root, 'src/main.js')) return;
      return `${source}\nwindow.__spaceTransactions = () => ({ layout: layoutSnapshot(), history: historyPast.length });`;
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const scenario = async (name, options, run) => {
    const zone = options.rectangle
      ? { id: 'room', spaceId: 'room', name: '거실', type: '방', x: 0, y: 0, width: 400, depth: 300, height: 240 }
      : zoneFromPoints({ id: 'room', spaceId: 'room', name: '거실', type: '방', height: 240 }, [
        { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 },
      ]);
    const door = attachOpeningToZoneEdge({
      id: 'door', name: '문', type: 'door', x: 150, y: 0, width: 90, height: 205, locked: Boolean(options.locked),
    }, zone, 0);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      await context.addInitScript(layout => localStorage.setItem('room-studio-layout-v2', JSON.stringify(layout)), {
        zones: [zone], structures: [door], items: [], dimensions: [], wallHeight: 240,
      });
      const page = await context.newPage(), cdp = await context.newCDPSession(page);
      const errorsBefore = report.errors.length;
      page.on('pageerror', error => report.errors.push({ name, error: error.message }));
      await page.goto(server.resolvedUrls.local[0]);
      const state = () => page.evaluate(() => window.__spaceTransactions());
      const persisted = () => page.evaluate(() => localStorage.getItem('room-studio-layout-v2'));
      const point = (x, y) => page.locator('#plan-canvas').evaluate((svg, p) => {
        const screen = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
        return { x: screen.x, y: screen.y };
      }, { x, y });
      const touch = async (type, position) => {
        const event = { touchStart: 'pointerdown', touchMove: 'pointermove', touchEnd: 'pointerup', touchCancel: 'pointercancel' }[type];
        await page.evaluate(type => {
          window.__transactionPointer = new Promise((done, reject) => {
            const handler = event => { clearTimeout(timer); done(event.isTrusted && event.pointerType === 'touch'); };
            const timer = setTimeout(() => { document.removeEventListener(type, handler, true); reject(new Error(type)); }, 10000);
            document.addEventListener(type, handler, { capture: true, once: true });
          });
        }, event);
        await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: position ? [{ ...position, id: 1 }] : [] });
        assert.equal(await page.evaluate(() => window.__transactionPointer), true);
      };
      const drag = async (from, to, cancel = false) => {
        await touch('touchStart', from); await touch('touchMove', to);
        await touch(cancel ? 'touchCancel' : 'touchEnd');
      };
      const select = async () => { const p = await point(200, 150); await page.touchscreen.tap(p.x, p.y); };
      await run({ page, state, persisted, point, drag, select });
      assert.equal(report.errors.length, errorsBefore, `no browser errors in ${name}`);
      report.checks.push(name);
      console.log(`PASS ${name}`);
    } catch (error) {
      report.failures.push({ name, error: error.stack });
      process.exitCode = 1;
      console.error(`FAIL ${name}: ${error.message}`);
    } finally { await context.close(); }
  };
  await scenario('room drag carries its attached opening and one undo restores both', {}, async ({ page, state, point, drag, select }) => {
    const before = await state();
    await select();
    const start = await point(200, 150);
    await drag(start, { x: start.x + 35, y: start.y + 20 });
    const after = await state(), delta = { x: after.layout.zones[0].x, y: after.layout.zones[0].y };
    assert.ok(delta.x && delta.y);
    assert.deepEqual([after.layout.structures[0].x, after.layout.structures[0].y], [150 + delta.x, delta.y]);
    assert.equal(after.history, before.history + 1);
    await page.locator('#undo-action').tap();
    assert.deepEqual((await state()).layout, before.layout);
    const origin = await point(200, 150);
    await drag(origin, { x: origin.x + 30, y: origin.y + 20 }, true);
    assert.deepEqual(await state(), before);
  });
  await scenario('locked opening rejects room drag, keyboard movement and deletion without an undo entry', { locked: true }, async ({ page, state, point, drag, select }) => {
    const before = await state();
    await select();
    const start = await point(200, 150);
    await drag(start, { x: start.x + 35, y: start.y + 20 });
    assert.deepEqual(await state(), before);
    await page.locator('#plan-canvas').focus();
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await state(), before);
    await page.locator('[data-simple-action="delete"]').tap();
    assert.deepEqual(await state(), before);
    await page.locator('[data-simple-action="details"]').tap();
    await page.locator('[data-delete-zone-part]').tap();
    assert.deepEqual(await state(), before);
    await page.locator('[data-delete-space]').tap();
    assert.deepEqual(await state(), before);
  });
  await scenario('keyboard movement carries the opening atomically', {}, async ({ page, state, select }) => {
    const before = await state();
    await select(); await page.locator('#plan-canvas').focus(); await page.keyboard.press('ArrowRight');
    const after = await state();
    assert.equal(after.layout.zones[0].x, 1);
    assert.equal(after.layout.structures[0].x, 151);
    assert.equal(after.history, 1);
    await page.locator('#undo-action').tap();
    assert.deepEqual(await state(), before);
  });
  await scenario('quick polygon size changes vertices rather than only its bounding metadata', {}, async ({ page, state, select }) => {
    const before = await state();
    await select(); await page.locator('[data-simple-action="size"]').tap();
    await page.locator('[data-quick-field="width"]').fill('500');
    await page.locator('[data-quick-field="width"]').press('Enter');
    const after = await state();
    assert.equal(after.layout.zones[0].width, 500);
    assert.equal(after.layout.zones[0].points[1].x, 500);
    assert.equal(after.layout.structures[0].x, 150);
    assert.equal(after.history, 1);
    await page.locator('#undo-action').tap();
    assert.deepEqual(await state(), before);
  });
  await scenario('inspector geometry stays uncommitted until blur and resizes actual polygon points', {}, async ({ page, state, persisted, select }) => {
    const before = await state(), saved = await persisted();
    await select(); await page.locator('[data-simple-action="details"]').tap();
    await page.locator('[data-zone-field="width"]').fill('500');
    assert.equal(await persisted(), saved);
    await page.locator('[data-zone-field="depth"]').tap();
    const after = await state();
    assert.equal(after.layout.zones[0].points[1].x, 500);
    assert.equal(after.history, before.history + 1);
  });
  await scenario('rectangle corner resize carries attached openings', { rectangle: true }, async ({ page, state, select, drag }) => {
    const before = await state();
    await select(); await page.locator('[data-simple-action="size"]').tap();
    const box = await page.locator('.resize-handle[data-resize-handle="nw"]').boundingBox();
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await drag(start, { x: start.x - 18, y: start.y - 18 });
    const after = await state();
    assert.notEqual(after.layout.zones[0].x, 0);
    assert.deepEqual([after.layout.structures[0].x, after.layout.structures[0].y],
      [150 + after.layout.zones[0].x, after.layout.zones[0].y]);
    await page.locator('#undo-action').tap();
    assert.deepEqual(await state(), before);
  });
  assert.deepEqual(report.errors, []);
} finally {
  await browser?.close(); await server.close();
  report.passed = report.failures.length === 0 && report.errors.length === 0;
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
}
