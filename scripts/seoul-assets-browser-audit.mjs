import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as reserveServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { REGIONAL_DEMO_LAYOUTS } from '../src/demo-layouts.js';
import { capture, evaluate, launchChrome, setViewport } from '../.omo/evidence/room-studio-improvements/browser-qa-lib.mjs';

const output = resolve(process.env.SEOUL_ASSETS_OUTPUT ?? join('.omx/artifacts/seoul-assets', new Date().toISOString().replaceAll(':', '-')));
await mkdir(output, { recursive: true });
const receipt = { url: '', checks: [], errors: [], screenshots: [] };
let server;
let browser;
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
  browser = await launchChrome(process.env.CHROME_PATH ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'));
  const { cdp } = browser;
  const page = (expression) => evaluate(cdp, expression);
  cdp.listeners.set('Runtime.exceptionThrown', new Set([(event) => receipt.errors.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text)]));
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
  await browser.navigate(receipt.url);
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
    await browser.navigate(receipt.url);
    await click('#zoom-in');
    current = await saved();
    assert.equal(JSON.stringify(current), before, `${fixture.id}: reloading and navigating preserve the drawing`);
    receipt.checks.push(`${fixture.id}: model and material references survive editor load and reload`);
    const path = join(output, `${fixture.assetStyle.cover}-editor.png`);
    await capture(cdp, path);
    receipt.screenshots.push(path);
  }
  const beforeAdd = (await saved()).items.length;
  await click('[data-add-type="sofa"]');
  const placement = await page(`(() => {
    const point = new DOMPoint(550, 650).matrixTransform(document.querySelector('#plan-canvas').getScreenCTM());
    return { x: point.x, y: point.y };
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, ...placement, button: 'left', clickCount: 1 });
  }
  const added = (await saved()).items;
  assert.equal(added.length, beforeAdd + 1);
  assert.equal(added.at(-1).assetId, 'seoul-sofa', 'furniture catalog places an editable model reference');
  await click('#undo-action');
  assert.equal((await saved()).items.length, beforeAdd, 'one undo removes only the new model');
  receipt.checks.push('catalog placement uses a real model reference and one-step undo');
  const sofa = (await saved()).items.find((item) => item.type === 'sofa');
  await click(`#plan-canvas [data-item-id="${sofa.id}"]`);
  await click('[data-simple-action="details"]');
  const materialPath = join(output, 'material-inspector.png');
  await capture(cdp, materialPath);
  receipt.screenshots.push(materialPath);
  await click('[data-appearance-field="materialId"][data-appearance-value="walnut"]');
  assert.equal((await saved()).items.find((item) => item.id === sofa.id).materialId, 'walnut', 'material selection updates the canonical drawing');
  await click('#undo-action');
  assert.equal((await saved()).items.find((item) => item.id === sofa.id).materialId, sofa.materialId, 'material selection is one undoable edit');
  receipt.checks.push('material selection updates the drawing with one-step undo');
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
  await click(`[data-demo-studio="${REGIONAL_DEMO_LAYOUTS[0].id}"]`);
  assert.equal(JSON.stringify(await saved()), beforeReplacement, '3D sample entry protects the current drawing until confirmed');
  await click('[data-demo-confirm-cancel]');
  assert.equal(JSON.stringify(await saved()), beforeReplacement, 'canceling a 3D sample preserves the current drawing');
  receipt.checks.push('each Seoul example offers protected direct 3D entry');
  assert.deepEqual(receipt.errors, []);
  receipt.status = 'PASS';
} catch (error) {
  receipt.status = 'FAIL';
  receipt.failure = error.stack;
  throw error;
} finally {
  await browser?.close();
  await server?.close();
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ status: receipt.status, checks: receipt.checks, failure: receipt.failure, output }));
}
