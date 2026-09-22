import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { settleBrowserPaint } from './browser-rendering.mjs';

const outputDirectory = resolve('.omx/artifacts/direct-space-editor');
let server;
let browser;

try {
  server = await createServer({
    cacheDir: resolve(outputDirectory, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/.omx/**'] } },
  });
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const capture = async name => {
    await settleBrowserPaint(page);
    await page.screenshot({ path: resolve(outputDirectory, `${name}.png`) });
  };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '이 크기로 시작', exact: true }).tap();
  const canvas = page.locator('#plan-canvas');
  const zone = canvas.locator('[data-zone-id]').first();
  await zone.tap();
  const before = {
    viewBox: await canvas.getAttribute('viewBox'),
    box: await zone.boundingBox(),
    position: await zone.locator('rect').first().evaluate(node => ({
      x: Number(node.getAttribute('x')),
      y: Number(node.getAttribute('y')),
    })),
  };
  const cdp = await context.newCDPSession(page);
  const origin = { x: before.box.x + before.box.width / 2, y: before.box.y + before.box.height / 2 };
  const signal = async type => {
    await page.evaluate(eventType => {
      window.directSpaceSignal = new Promise((resolveEvent, reject) => {
        const listener = event => {
          clearTimeout(deadline);
          resolveEvent({ trusted: event.isTrusted, pointerType: event.pointerType });
        };
        const deadline = setTimeout(() => {
          document.removeEventListener(eventType, listener, true);
          reject(new Error(`No ${eventType} acknowledgement`));
        }, 10_000);
        document.addEventListener(eventType, listener, { capture: true, once: true });
      });
    }, type);
  };
  const touch = async (type, point, eventType) => {
    await signal(eventType);
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ ...point, id: 1 }] : [] });
    const event = await page.evaluate(() => window.directSpaceSignal);
    assert.equal(event.trusted, true);
    assert.equal(event.pointerType, 'touch');
  };
  await touch('touchStart', origin, 'pointerdown');
  await touch('touchMove', { x: origin.x + 28, y: origin.y + 22 }, 'pointermove');
  await touch('touchMove', { x: origin.x + 42, y: origin.y + 32 }, 'pointermove');
  await touch('touchEnd', null, 'pointerup');
  const after = {
    viewBox: await canvas.getAttribute('viewBox'),
    box: await zone.boundingBox(),
    position: await zone.locator('rect').first().evaluate(node => ({
      x: Number(node.getAttribute('x')),
      y: Number(node.getAttribute('y')),
    })),
  };
  await capture('mobile-drag-viewport');
  assert.notDeepEqual(after.position, before.position, 'native touch must move the room');
  assert.equal(after.viewBox, before.viewBox, 'committing a room drag must not recenter the viewport');
  assert.ok(after.box.x - before.box.x > 20, 'the room must remain at its dragged screen position after release');
  await page.getByRole('button', { name: '실행 취소', exact: true }).tap();
  assert.equal(await canvas.getAttribute('viewBox'), before.viewBox, 'undo must not move the viewport');
  assert.deepEqual(await zone.locator('rect').first().evaluate(node => ({
    x: Number(node.getAttribute('x')),
    y: Number(node.getAttribute('y')),
  })), before.position, 'one undo restores the dragged room');
  assert.deepEqual(errors, []);
  console.log('PASS native touch drag preserves the viewport and one-step undo');

  const firstZoneId = await zone.getAttribute('data-zone-id');
  await page.getByRole('button', { name: '상세', exact: true }).tap();
  await page.locator('[data-add-zone-part]').tap();
  await page.locator('[data-mobile-panel="canvas"]').tap();
  await page.getByRole('button', { name: '전체 보기', exact: true }).tap();
  const firstRoom = canvas.locator(`[data-zone-id="${firstZoneId}"]`);
  const insideFirstRoom = await firstRoom.evaluate(node => {
    const rect = node.querySelector('rect:not(.zone-hit-target)');
    const matrix = node.ownerSVGElement.getScreenCTM();
    const point = new DOMPoint(
      Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) - 8 / matrix.a,
      Number(rect.getAttribute('y')) + Number(rect.getAttribute('height')) / 4,
    ).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });
  await touch('touchStart', insideFirstRoom, 'pointerdown');
  await touch('touchEnd', null, 'pointerup');
  await capture('mobile-adjacent-selection');
  assert.equal(
    await canvas.locator('[data-zone-id].is-selected').getAttribute('data-zone-id'),
    firstZoneId,
    'a neighboring transparent hit target must not steal a tap inside the visible room',
  );
  assert.deepEqual(errors, []);
  console.log('PASS visible room geometry wins over neighboring touch padding');

  await page.locator('[data-start-open]').tap();
  await page.locator('[data-start-blank]').tap();
  assert.equal(await page.locator('[data-space-tool="draw"]').count(), 1, 'direct space drawing is available on the canvas');
  await page.locator('[data-space-tool="draw"]').tap();
  const outline = [
    { x: 40, y: 30 }, { x: 360, y: 30 }, { x: 360, y: 140 },
    { x: 210, y: 140 }, { x: 210, y: 270 }, { x: 40, y: 270 },
  ];
  for (const point of outline) {
    const screen = await canvas.evaluate((svg, value) => {
      const result = new DOMPoint(value.x, value.y).matrixTransform(svg.getScreenCTM());
      return { x: result.x, y: result.y };
    }, point);
    await touch('touchStart', screen, 'pointerdown');
    await touch('touchEnd', null, 'pointerup');
  }
  await page.getByRole('button', { name: '공간 완성', exact: true }).tap();
  const persisted = () => page.evaluate(() => JSON.parse(localStorage.getItem('room-studio-layout-v2')));
  const undoPoints = async points => {
    await page.evaluate(points => {
      window.directSpaceUndo = new Promise((done, reject) => {
        const observer = new MutationObserver(check);
        const deadline = setTimeout(() => { observer.disconnect(); reject(new Error('Undo did not restore polygon points')); }, 10000);
        function check() {
          const zone = JSON.parse(localStorage.getItem('room-studio-layout-v2')).zones[0];
          if (JSON.stringify(zone.points) === JSON.stringify(points)) {
            clearTimeout(deadline); observer.disconnect(); done();
          }
        }
        observer.observe(document.querySelector('#app'), { subtree: true, childList: true });
        check();
      });
    }, points);
    await page.getByRole('button', { name: '실행 취소', exact: true }).tap();
    await page.evaluate(() => window.directSpaceUndo);
  };
  const drawn = (await persisted()).zones[0];
  assert.equal(drawn.points.length, 6, 'a concave outline remains a six-vertex space');
  assert.deepEqual(drawn.points.map(point => ({ x: point.x + drawn.x, y: point.y + drawn.y })), outline);
  assert.equal(await canvas.locator('[data-zone-id] polygon:not(.zone-hit-target)').count(), 1);
  await canvas.locator('[data-space-edge="0"]').tap();
  assert.equal(await canvas.locator('[data-space-fixed]').count(), 1, 'length editing identifies the fixed endpoint on the drawing');
  const fixedPoint = () => canvas.locator('[data-space-fixed]').evaluate(node => ({
    x: Number(node.dataset.fixedX), y: Number(node.dataset.fixedY),
  }));
  assert.deepEqual(await fixedPoint(), outline[0]);
  await page.locator('[data-edge-length]').fill('350');
  assert.deepEqual(await fixedPoint(), outline[0], 'the fixed endpoint stays in place during the length preview');
  await settleBrowserPaint(page);
  const labelBounds = await canvas.locator('.space-edge-dimension').evaluateAll(labels => labels.map(label => {
    const text = label.querySelector('text').getBoundingClientRect();
    const chip = label.querySelector('.space-edge-chip').getBoundingClientRect();
    const svg = label.ownerSVGElement.getBoundingClientRect();
    return { value: label.textContent.trim(), contained: text.left >= Math.max(chip.left, svg.left) - 1
      && text.right <= Math.min(chip.right, svg.right) + 1 && text.top >= Math.max(chip.top, svg.top) - 1
      && text.bottom <= Math.min(chip.bottom, svg.bottom) + 1 };
  }));
  assert.ok(labelBounds.every(label => label.contained), `every dimension value fits its chip and canvas: ${JSON.stringify(labelBounds)}`);
  await capture('mobile-fixed-endpoint');
  await page.getByRole('button', { name: '치수 적용', exact: true }).tap();
  const lengthEdited = (await persisted()).zones[0];
  assert.equal(lengthEdited.points[1].x - lengthEdited.points[0].x, 350);
  await undoPoints(drawn.points);
  assert.deepEqual((await persisted()).zones[0].points, drawn.points, 'one undo restores the original wall length');
  await capture('mobile-concave-room');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await canvas.waitFor({ state: 'visible' });
  assert.deepEqual((await persisted()).zones[0].points, drawn.points, 'reload preserves polygon vertices');
  assert.deepEqual(errors, []);
  console.log('PASS native touch concave drawing, wall length editing, undo and reload');

  const projectPoint = point => canvas.evaluate((svg, value) => {
    const result = new DOMPoint(value.x, value.y).matrixTransform(svg.getScreenCTM());
    return { x: result.x, y: result.y };
  }, point);
  await canvas.locator('[data-zone-id] polygon:not(.zone-hit-target)').tap({ position: { x: 20, y: 20 } });
  await page.locator('[data-space-shape]').tap();
  const corner = await projectPoint(outline[0]);
  const newCorner = await projectPoint({ x: 20, y: 20 });
  await touch('touchStart', corner, 'pointerdown');
  await touch('touchMove', newCorner, 'pointermove');
  await touch('touchEnd', null, 'pointerup');
  const vertexEdited = (await persisted()).zones[0];
  assert.deepEqual({ x: vertexEdited.x + vertexEdited.points[0].x, y: vertexEdited.y + vertexEdited.points[0].y }, { x: 20, y: 20 });
  await undoPoints(drawn.points);
  const edgeMiddle = await projectPoint({ x: 200, y: 30 });
  const shiftedEdge = await projectPoint({ x: 200, y: 0 });
  await touch('touchStart', edgeMiddle, 'pointerdown');
  await touch('touchMove', shiftedEdge, 'pointermove');
  await touch('touchEnd', null, 'pointerup');
  const wallEdited = (await persisted()).zones[0];
  assert.equal(wallEdited.y + wallEdited.points[0].y, 0);
  assert.equal(wallEdited.y + wallEdited.points[1].y, 0);
  await undoPoints(drawn.points);
  assert.deepEqual((await persisted()).zones[0].points, drawn.points);
  assert.deepEqual(errors, []);
  console.log('PASS native touch vertex and wall dragging with one-step undo');
} finally {
  await browser?.close();
  await server?.close();
}
