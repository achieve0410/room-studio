// Focused dev-surface audit. PLAYWRIGHT_CORE_PATH may point to an existing install.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { DEMO_LAYOUTS } from '../src/demo-layouts.js';

const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');

const root = resolve(import.meta.dirname, '..');
const artifacts = join(root, '.omx/artifacts/consultation-3d');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'room-3d-consultation-'));
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise((resolveClose) => reservation.close(resolveClose));
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root });
const report = { viewports: [], profile, serverPid: server.pid, errors: [], injectedConsoleErrors: [] };
let context;
let injectingFailure = false;
try {
  const url = await new Promise((resolveUrl, reject) => {
    const timeout = setTimeout(() => reject(new Error('Vite readiness timeout')), 15000);
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`Vite exited ${code}`)));
    server.stdout.on('data', (chunk) => {
      const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolveUrl(match[0]); }
    });
    server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  });
  report.url = url;
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check'],
    reducedMotion: 'reduce',
    acceptDownloads: true,
  });
  const page = context.pages()[0];
  page.setDefaultTimeout(15000);
  const capture = async (name) => {
    // Wait for the next painted frame, not a duration, after changing renderer viewports.
    await page.evaluate(() => new Promise((resolveFrame, reject) => {
      const timer = setTimeout(() => reject(new Error('Paint frame timeout')), 15000);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolveFrame(); }));
    }));
    await page.screenshot({ path: join(artifacts, name) });
  };
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') (injectingFailure ? report.injectedConsoleErrors : report.errors).push(message.text());
  });
  const cdp = await context.newCDPSession(page);
  const browserCdp = await context.browser().newBrowserCDPSession();
  report.chromePids = (await browserCdp.send('SystemInfo.getProcessInfo')).processInfo.map(({ id }) => id);
  if (process.env.THREE_ISOLATED) {
    await page.route('**/__3d-audit', (route) => route.fulfill({ contentType: 'text/html', body: `
      <html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/styles.css"></head>
      <body><button id="open-walkthrough">3D 미리보기</button><script type="module">
        import { openWalkthrough } from '/src/walkthrough3d.js';
        import { DEMO_LAYOUTS } from '/src/demo-layouts.js';
        document.querySelector('button').onclick = () => openWalkthrough({ ...DEMO_LAYOUTS[0], initialMode: 'dollhouse' });
      </script></body></html>` }));
    await page.goto(`${url}/__3d-audit`);
  } else {
    await page.addInitScript((layout) => localStorage.setItem('room-studio-layout-v2', JSON.stringify(layout)), DEMO_LAYOUTS[0]);
    await page.goto(url);
  }
  report.surface = process.env.THREE_ISOLATED ? 'isolated-real-module' : 'editor-entry';
  const waitState = (selector, attribute, expected) => page.evaluate(({ selector, attribute, expected }) => new Promise((resolveState, reject) => {
    const matches = () => document.querySelector(selector)?.getAttribute(attribute) === expected;
    if (matches()) { resolveState(); return; }
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`State timeout: ${selector} ${attribute}`)); }, 15000);
    const observer = new MutationObserver(() => {
      if (matches()) { clearTimeout(timer); observer.disconnect(); resolveState(); }
    });
    observer.observe(document.body, { subtree: true, attributes: true, childList: true });
  }), { selector, attribute, expected });
  for (const [width, height] of [[1440, 1000], [320, 568], [390, 844], [768, 1024], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 900, maxTouchPoints: 5 });
    await Promise.all([
      waitState('[data-walkthrough]', 'data-walkthrough-ready', 'true'),
      page.locator('#open-walkthrough').click(),
    ]);
    const overlay = page.locator('[data-walkthrough]');
    assert.equal(await overlay.getAttribute('data-view-mode'), 'dollhouse');
    assert.equal(await overlay.getAttribute('data-dollhouse-cutaway'), 'true');
    const controls = await page.locator('.walkthrough-view-tools button, .walkthrough-exit').evaluateAll((buttons) => buttons.map((button) => {
      const { x, y, width, height } = button.getBoundingClientRect();
      return { x, y, width, height, label: button.getAttribute('aria-label') || button.textContent.trim() };
    }));
    for (const control of controls) {
      assert.ok(control.width >= 44 && control.height >= 44, JSON.stringify(control));
      assert.ok(control.x >= 0 && control.y >= 0 && control.x + control.width <= width && control.y + control.height <= height, JSON.stringify(control));
      assert.ok(control.label);
    }
    await capture(`${width}x${height}-cutaway.png`);
    const wallButton = page.locator('[data-toggle-walls]');
    await wallButton.focus();
    await page.keyboard.press('Space');
    assert.equal(await wallButton.getAttribute('aria-pressed'), 'false');
    assert.equal(await overlay.getAttribute('data-dollhouse-cutaway'), 'false');
    await capture(`${width}x${height}-full-walls.png`);
    await wallButton.press('Enter');
    await page.locator('button[data-view-mode="top"]').click();
    assert.equal(await overlay.getAttribute('data-dollhouse-cutaway'), 'true');
    await capture(`${width}x${height}-top.png`);
    const download = page.waitForEvent('download', { timeout: 15000 });
    await page.locator('[data-save-snapshot]').click();
    const png = await download;
    assert.ok(png.suggestedFilename().endsWith('.png'));
    await png.saveAs(join(artifacts, `${width}x${height}-snapshot.png`));
    await page.locator('button[data-view-mode="walk"]').click();
    assert.equal(await overlay.getAttribute('data-view-mode'), 'walk');
    assert.equal(await page.locator('button[data-view-mode="walk"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await overlay.getAttribute('data-dollhouse-cutaway'), 'false');
    assert.equal(await wallButton.isDisabled(), true);
    const before = await page.locator('[data-map-player]').getAttribute('transform');
    const movement = page.evaluate((before) => new Promise((resolveMove, reject) => {
      const marker = document.querySelector('[data-map-player]');
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Movement timeout')); }, 15000);
      const observer = new MutationObserver(() => {
        if (marker.getAttribute('transform') !== before) { clearTimeout(timer); observer.disconnect(); resolveMove(); }
      });
      observer.observe(marker, { attributes: true, attributeFilter: ['transform'] });
    }), before);
    await Promise.all([movement, page.keyboard.down('w')]);
    await page.keyboard.up('w');
    await capture(`${width}x${height}-walk.png`);
    await page.locator('[data-walkthrough-exit]').first().click();
    assert.equal(await overlay.count(), 0);
    report.viewports.push({ width, height, controls, entry: true, keyboardToggle: true, top: true, png: true, walkMovement: true, exit: true });
  }
  await Promise.all([
    waitState('[data-walkthrough]', 'data-walkthrough-ready', 'true'),
    page.evaluate(async () => {
      const { openWalkthrough } = await import('/src/walkthrough3d.js');
      openWalkthrough({ zones: [], items: [], structures: [], initialMode: 'top' });
    }),
  ]);
  await capture('empty-top.png');
  await page.locator('[data-walkthrough-exit]').first().click();
  assert.equal(await page.locator('[data-walkthrough]').count(), 0);
  report.emptyOverview = true;
  report.openings = [];
  for (const mobile of [false, true]) {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 });
    for (const kind of ['door', 'window']) {
      await page.evaluate(async (kind) => {
        const { openWalkthrough } = await import('/src/walkthrough3d.js');
        window.__openingChanges = [];
        openWalkthrough({
          zones: [{ id: 'room', name: 'Room', type: '거실', x: 0, y: 0, width: 400, depth: 400, height: 240 }],
          items: [],
          structures: [
            { id: 'wall', type: 'wall', x: 200, y: 200, length: 400, height: 240, thickness: 6, orientation: 'vertical' },
            { id: kind, type: kind, wallId: 'wall', x: 200, y: 200, width: 90, height: kind === 'door' ? 205 : 120, sillHeight: 90, orientation: 'vertical', doorType: 'swing', hinge: 'start', openSide: -1, openAngle: 0, openRatio: 0, slideDirection: 'end' },
          ],
          initialMode: 'dollhouse',
          onStructureChange: (id, updates) => window.__openingChanges.push({ id, updates }),
        });
      }, kind);
      await Promise.all([
        waitState('[data-walkthrough]', `data-target-${kind}-id`, kind),
        page.locator('button[data-view-mode="walk"]').click(),
      ]);
      await capture(`${mobile ? 'mobile' : 'desktop'}-${kind}-before-interaction.png`);
      await Promise.all([
        waitState('[data-walkthrough]', `data-last-${kind}-action`, `${kind}:${kind === 'door' ? 90 : 100}`),
        (async () => {
          if (mobile) {
            const canvas = await page.locator('[data-walkthrough-canvas]').boundingBox();
            const point = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          } else {
            await page.keyboard.press('e');
          }
        })(),
      ]);
      const changes = await page.evaluate(() => window.__openingChanges);
      assert.deepEqual(changes, [{ id: kind, updates: kind === 'door' ? { openAngle: 90 } : { openRatio: 100 } }]);
      await capture(`${mobile ? 'mobile' : 'desktop'}-${kind}-interaction.png`);
      await page.locator('[data-walkthrough-exit]').first().click();
      report.openings.push({ mobile, kind, changes });
    }
  }
  injectingFailure = true;
  report.failureCleanup = await page.evaluate(async () => {
    const { openWalkthrough } = await import('/src/walkthrough3d.js');
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type.startsWith('webgl')) throw new Error('Injected context construction failure');
      return getContext.call(this, type, ...args);
    };
    try {
      openWalkthrough({ zones: [{ id: 'room', name: 'Room', x: 0, y: 0, width: 400, depth: 400, height: 240 }], items: [], initialMode: 'dollhouse' });
      return { threw: false };
    } catch (error) {
      return { threw: true, cause: error.cause?.message, message: error.message, overlays: document.querySelectorAll('[data-walkthrough]').length, canvases: document.querySelectorAll('[data-walkthrough-canvas]').length };
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
    }
  });
  injectingFailure = false;
  assert.equal(report.failureCleanup.threw, true);
  assert.equal(report.failureCleanup.cause, 'Injected context construction failure');
  assert.equal(report.failureCleanup.overlays, 0);
  assert.equal(report.failureCleanup.canvases, 0);
  await Promise.all([
    waitState('[data-walkthrough]', 'data-walkthrough-ready', 'true'),
    page.locator('#open-walkthrough').click(),
  ]);
  await page.locator('[data-walkthrough-exit]').first().click();
  assert.equal(await page.locator('[data-walkthrough]').count(), 0);
  report.reopenAfterFailure = true;
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await context?.close();
  const exit = once(server, 'exit', { signal: AbortSignal.timeout(10000) });
  server.kill('SIGTERM');
  await exit;
  await rm(profile, { recursive: true, force: true });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  report.cleanup = { serverStopped: !alive(server.pid), chromeStillAlive: (report.chromePids ?? []).filter(alive), profileRemoved: true };
  await writeFile(join(artifacts, 'browser-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
