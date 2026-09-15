import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as reserveServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { REGIONAL_DEMO_LAYOUTS } from '../src/demo-layouts.js';
import { capture, evaluate, setViewport } from '../.omo/evidence/room-studio-improvements/browser-qa-lib.mjs';

const output = resolve(process.env.SEOUL_ASSETS_OUTPUT ?? join('.omx/artifacts/seoul-assets', new Date().toISOString().replaceAll(':', '-')));
await mkdir(output, { recursive: true });
const receipt = { url: '', checks: [], errors: [], screenshots: [] };
let server;
let browser;
let chromePage;
try {
  if (!process.env.AUDIT_URL) {
    const port = await new Promise((resolvePort, reject) => {
      const reservation = reserveServer();
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', () => {
        const { port: available } = reservation.address();
        reservation.close(() => resolvePort(available));
      });
    });
    server = await createServer({
      cacheDir: join(output, 'vite-cache'),
      server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/.omx/**'] } },
    });
    await server.listen();
    receipt.url = `http://127.0.0.1:${server.httpServer.address().port}`;
  } else receipt.url = process.env.AUDIT_URL;
  const executablePath = process.env.CHROME_PATH ?? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    chromium.executablePath(),
  ].find(existsSync);
  assert.ok(executablePath && existsSync(executablePath), 'Install Chrome/Chromium or set CHROME_PATH');
  // Playwright launches with a fresh temporary profile and an isolated debugging pipe.
  browser = await chromium.launch({ executablePath, headless: true, args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ acceptDownloads: true, reducedMotion: 'reduce' });
  chromePage = await context.newPage();
  chromePage.setDefaultTimeout(20000);
  const cdp = await context.newCDPSession(chromePage);
  const page = (expression) => evaluate(cdp, expression);
  chromePage.on('pageerror', error => receipt.errors.push(error.message));
  let signal = 0;
  const change = async (expression, trigger) => {
    const key = `__seoulSignal${signal++}`;
    await page(`(() => {
      window[${JSON.stringify(key)}] = new Promise((done, reject) => {
        const observer = new MutationObserver(check);
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error(${JSON.stringify(`State timeout: ${expression}`)})); }, 20000);
        function check() { if (${expression}) { clearTimeout(timer); observer.disconnect(); done(); } }
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        check();
      });
    })()`);
    await trigger();
    await page(`window[${JSON.stringify(key)}]`);
    await page(`delete window[${JSON.stringify(key)}]`);
  };
  const ready = `document.querySelector('[data-walkthrough]')?.dataset.studioReady === 'true' && document.querySelector('[data-walkthrough]')?.dataset.assetState === 'ready'`;
  const applied = `${ready} && document.querySelector('.studio3d-shell')?.dataset.pending === 'false'`;
  const click = async (selector) => {
    const point = await page(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = node.getBoundingClientRect();
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      if (!rect.width || !rect.height || !node.contains(document.elementFromPoint(point.x, point.y))) throw new Error('Obscured control: ' + ${JSON.stringify(selector)});
      return point;
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    }
    await page('new Promise(resolve => requestAnimationFrame(resolve))');
  };
  const saved = () => page('JSON.parse(localStorage.getItem("room-studio-layout-v2"))');
  await setViewport(cdp, 1440, 1000);
  await chromePage.goto(receipt.url);
  assert.equal(await page('document.querySelectorAll("[data-start-studio]").length'), 3, 'first use exposes all three Seoul 3D examples');
  for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1440, 1000]]) {
    await setViewport(cdp, width, height);
    await page(`(() => {
      let timer;
      return Promise.race([
        Promise.all([...document.querySelectorAll('.starter-example-grid img')].map(image => image.decode())),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Example image decode timed out')), 15000); }),
      ]).finally(() => clearTimeout(timer));
    })()`);
    await page('document.querySelector(".starter-dialog").scrollTop = 0');
    assert.equal(await page('document.documentElement.scrollWidth <= innerWidth'), true, `${width}px: no horizontal overflow`);
    const startPath = join(output, `starter-${width}-top.png`);
    await capture(cdp, startPath);
    receipt.screenshots.push(startPath);
    await page('document.querySelector(".starter-examples").scrollIntoView({ block: "center", behavior: "instant" })');
    const examplesPath = join(output, `starter-${width}-examples.png`);
    await capture(cdp, examplesPath);
    receipt.screenshots.push(examplesPath);
    const controls = await page(`(() => {
      const closeButton = document.querySelector('[data-start-close]');
      const close = closeButton.getBoundingClientRect();
      const heading = document.querySelector('.starter-heading').getBoundingClientRect();
      const dialog = document.querySelector('.starter-dialog').getBoundingClientRect();
      return {
        headingFlush: heading.top <= dialog.top + 1,
        closeVisible: close.top >= 0 && close.bottom <= innerHeight
          && closeButton.contains(document.elementFromPoint(close.x + close.width / 2, close.y + close.height / 2)),
        images: [...document.querySelectorAll('.starter-example-grid img')].every(image => image.complete && image.naturalWidth > 0),
        targets: [...document.querySelectorAll('[data-start-studio]')].every(button => {
          const rect = button.getBoundingClientRect();
          return rect.width >= 44 && rect.height >= 44;
        }),
      };
    })()`);
    assert.ok(controls.images && controls.targets, `${width}px: actual images and usable example targets`);
    assert.ok(controls.closeVisible, `${width}px: starter close remains visible while browsing examples`);
    assert.ok(controls.headingFlush, `${width}px: scrolled content cannot bleed above the fixed heading`);
    receipt.checks.push(`${width}px starter: three rendered examples, readable layout and persistent close`);
  }
  await click('[data-start-sample]');
  for (const fixture of REGIONAL_DEMO_LAYOUTS) {
    if (fixture !== REGIONAL_DEMO_LAYOUTS[0]) {
      await click('[data-demo-open]');
      await click(`[data-demo-layout="${fixture.id}"]`);
      await click('[data-demo-confirm-accept]');
    }
    let current = await saved();
    assert.ok(current.items.filter((item) => item.assetId).length >= 5, `${fixture.id}: editor normalization preserves model IDs`);
    assert.ok(current.zones.every((zone) => zone.floorMaterialId && zone.wallMaterialId), `${fixture.id}: editor normalization preserves surface IDs`);
    const before = JSON.stringify(current);
    await chromePage.goto(receipt.url);
    await click('#zoom-in');
    current = await saved();
    assert.equal(JSON.stringify(current), before, `${fixture.id}: reloading and navigating preserve the drawing`);
    receipt.checks.push(`${fixture.id}: model and material references survive editor load and reload`);
    const path = join(output, `${fixture.assetStyle.cover}-editor.png`);
    await capture(cdp, path);
    receipt.screenshots.push(path);
  }
  assert.equal(await page('document.querySelectorAll("[data-add-type], [data-appearance-field], [data-item-field], [data-structure-field]").length'), 0,
    '2D exposes no retired furniture or finish mutation controls');
  const beforeAdd = (await saved()).items.length;
  await change(ready, () => click('#open-walkthrough'));
  await change(`${ready} && document.querySelector('.studio3d-shell').dataset.pending === 'true'`, () => click('[data-studio-asset="seoul-sofa"]'));
  assert.equal((await saved()).items.length, beforeAdd, '3D catalog placement previews without a canonical write');
  await change(applied, () => click('[data-studio-apply]'));
  const added = (await saved()).items;
  assert.equal(added.length, beforeAdd + 1);
  assert.equal(added.at(-1).assetId, 'seoul-sofa', '3D furniture catalog places an editable model reference');
  await change(`${ready} && JSON.parse(localStorage.getItem('room-studio-layout-v2')).items.length === ${beforeAdd}`, () => click('[data-studio-undo]'));
  assert.equal((await saved()).items.length, beforeAdd, 'one undo removes only the new model');
  receipt.checks.push('retired 2D detail controls absent; real 3D catalog preview, model reference and one-step undo');
  const sofa = (await saved()).items.find((item) => item.type === 'sofa');
  await chromePage.locator('[data-studio-target]').selectOption(`item:${sofa.id}`);
  const materialPath = join(output, 'material-inspector.png');
  await capture(cdp, materialPath);
  receipt.screenshots.push(materialPath);
  await change(`${ready} && document.querySelector('.studio3d-shell').dataset.pending === 'true'`, () => click('[data-studio-material="walnut"]'));
  assert.equal((await saved()).items.find((item) => item.id === sofa.id).materialId, sofa.materialId, '3D material preview does not save');
  await change(applied, () => click('[data-studio-apply]'));
  assert.equal((await saved()).items.find((item) => item.id === sofa.id).materialId, 'walnut', 'material selection updates the canonical drawing');
  await change(`${ready} && JSON.parse(localStorage.getItem('room-studio-layout-v2')).items.find(item => item.id === ${JSON.stringify(sofa.id)}).materialId === ${JSON.stringify(sofa.materialId)}`, () => click('[data-studio-undo]'));
  assert.equal((await saved()).items.find((item) => item.id === sofa.id).materialId, sofa.materialId, 'material selection is one undoable edit');
  await change(`!document.querySelector('[data-walkthrough]')`, () => click('[data-walkthrough-exit]'));
  receipt.checks.push('real 3D material preview updates the drawing with one-step undo');

  const optionA = await saved();
  await click('[data-disclosure="consultation"] > summary');
  await click('[data-option-create]');
  await click('[data-option-select="B"]');
  await change(ready, () => click('#open-walkthrough'));
  await chromePage.locator('[data-studio-target]').selectOption(`item:${sofa.id}`);
  await click('[data-studio-rotate]');
  await change(applied, () => click('[data-studio-apply]'));
  await change(`!document.querySelector('[data-walkthrough]')`, () => click('[data-walkthrough-exit]'));
  const optionB = await saved();
  assert.equal(optionB.items.find(item => item.id === sofa.id).rotation, (sofa.rotation + 15) % 360);
  await click('[data-option-select="A"]');
  assert.deepEqual((await saved()).items, optionA.items, '3D edits in B do not alter A');
  await click('[data-option-select="B"]');
  assert.deepEqual((await saved()).items, optionB.items, 'switching options preserves model/material IDs and the 3D edit');
  await click('[data-project-open]');
  const downloaded = chromePage.waitForEvent('download', { timeout: 20000 });
  await click('[data-project-export]');
  const file = join(output, 'seoul-options.roomstudio.json');
  await (await downloaded).saveAs(file);
  const portable = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(portable.schemaVersion, 3);
  assert.deepEqual(portable.layout.items, optionB.items);
  assert.deepEqual(portable.layout.consultation.inactiveGeometry.items, optionA.items);
  await click('[data-project-open]');
  await change(`!document.querySelector('[data-project-import]')`, () => chromePage.locator('[data-project-import]').setInputFiles(file));
  assert.deepEqual((await saved()).items, optionB.items);
  assert.deepEqual((await saved()).consultation.inactiveGeometry.items, optionA.items);
  assert.deepEqual((await saved()).zones, optionB.zones, 'portable file preserves finish IDs');
  receipt.checks.push('native file export/import and A/B switching preserve model IDs, finish IDs and independent 3D detail edits');
  await click('[data-demo-open]');
  for (const [width, height] of [[320, 568], [390, 844], [1440, 1000]]) {
    await setViewport(cdp, width, height);
    await page('document.querySelector(".demo-gallery").scrollTop = 0');
    const galleryPath = join(output, `seoul-gallery-${width}.png`);
    await capture(cdp, galleryPath);
    receipt.screenshots.push(galleryPath);
    assert.equal(await page('document.documentElement.scrollWidth <= innerWidth'), true, `${width}px gallery has no horizontal overflow`);
    for (const fixture of REGIONAL_DEMO_LAYOUTS) {
      const card = `[data-demo-card="${fixture.id}"]`;
      for (const [part, selector] of [['cover', `${card} .demo-card-cover`], ['actions', `${card} [data-demo-studio]`]]) {
        await page(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center', behavior: 'instant' })`);
        const file = join(output, `gallery-${width}-${fixture.assetStyle.cover}-${part}.png`);
        await capture(cdp, file);
        receipt.screenshots.push(file);
      }
      if (width === 390) {
        await click(`${card} .demo-source-details > summary`);
        await page(`(() => {
          const gallery = document.querySelector('.demo-gallery');
          const summary = document.querySelector(${JSON.stringify(`${card} .demo-source-details > summary`)});
          const heading = document.querySelector('.demo-gallery-heading');
          gallery.scrollTop += summary.getBoundingClientRect().top - heading.getBoundingClientRect().bottom - 8;
        })()`);
        const file = join(output, `gallery-${width}-${fixture.assetStyle.cover}-details.png`);
        await capture(cdp, file);
        receipt.screenshots.push(file);
        await click(`${card} .demo-source-details > summary`);
      }
    }
    await page('[...document.querySelectorAll("[data-demo-studio]")].at(-1).scrollIntoView({ block: "center", behavior: "instant" })');
    const scrolledPath = join(output, `seoul-gallery-${width}-scrolled.png`);
    await capture(cdp, scrolledPath);
    receipt.screenshots.push(scrolledPath);
    assert.equal(await page(`(() => {
      const heading = document.querySelector('.demo-gallery-heading').getBoundingClientRect();
      const dialog = document.querySelector('.demo-gallery').getBoundingClientRect();
      const button = document.querySelector('[data-demo-close]');
      const rect = button.getBoundingClientRect();
      return heading.top <= dialog.top + 1 && button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })()`), true, `${width}px gallery keeps its header and close usable while scrolling`);
    receipt.checks.push(`${width}px gallery: scrollable examples with persistent heading and close`);
  }
  const beforeReplacement = JSON.stringify(await saved());
  for (const fixture of REGIONAL_DEMO_LAYOUTS) {
    await click(`[data-demo-studio="${fixture.id}"]`);
    assert.equal(JSON.stringify(await saved()), beforeReplacement, `${fixture.id}: 3D sample entry protects the drawing until confirmed`);
    await click('[data-demo-confirm-cancel]');
    assert.equal(JSON.stringify(await saved()), beforeReplacement, `${fixture.id}: canceling preserves the drawing`);
  }
  receipt.checks.push('each Seoul example offers protected direct 3D entry');
  assert.deepEqual(receipt.errors, []);
  receipt.status = 'PASS';
} catch (error) {
  receipt.status = 'FAIL';
  receipt.failure = error.stack;
  if (chromePage && !chromePage.isClosed()) await chromePage.screenshot({ path: join(output, 'failure.png') });
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ status: receipt.status, checks: receipt.checks, failure: receipt.failure, output }));
}
