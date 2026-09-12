import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { capture, evaluate, launchChrome, setViewport } from '../.omo/evidence/room-studio-improvements/browser-qa-lib.mjs';

const outputDirectory = resolve('.omx/artifacts/simple-workspace', new Date().toISOString().replaceAll(':', '-'));
await mkdir(outputDirectory, { recursive: true });
const port = process.env.AUDIT_URL ? null : await new Promise((resolvePort, reject) => {
  const socket = createNetServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const { port: availablePort } = socket.address();
    socket.close(() => resolvePort(availablePort));
  });
});
const server = process.env.AUDIT_URL ? null : await createServer({
  cacheDir: join(outputDirectory, 'vite-cache'),
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/.omx/**'] } },
});
await server?.listen();
const appUrl = process.env.AUDIT_URL ?? `http://127.0.0.1:${server.httpServer.address().port}`;
const chromePath = process.env.CHROME_PATH ?? (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome');
const receipt = { appUrl, scenarios: [], screenshots: [], errors: [], actions: [] };
let browser;

try {
  browser = await launchChrome(chromePath);
  const cdp = browser.cdp;
  const page = (expression) => evaluate(cdp, expression);
  const frame = () => page('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  cdp.listeners.set('Runtime.exceptionThrown', new Set([(event) => receipt.errors.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text)]));
  let touch = false;
  const clickPoint = async (point) => {
    if (touch) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
      }
    }
    await frame();
  };
  const click = async (selector) => {
    const point = await page(`(async () => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(resolve));
      const current = document.querySelector(${JSON.stringify(selector)});
      const rect = current.getBoundingClientRect();
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      if (!rect.width || !rect.height || !current.contains(document.elementFromPoint(point.x, point.y))) {
        throw new Error('Obscured control: ' + ${JSON.stringify(selector)});
      }
      return point;
    })()`);
    await clickPoint(point);
    receipt.actions.push({ click: selector, touch });
  };
  const input = async (selector, value) => {
    await click(selector);
    await page(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await cdp.send('Input.insertText', { text: String(value) });
  };
  const key = async (key, code) => {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code });
    }
    await frame();
  };
  const screenshot = async (name) => {
    await frame();
    const path = join(outputDirectory, `${name}.png`);
    await capture(cdp, path);
    receipt.screenshots.push(path);
  };
  const state = () => page('JSON.parse(localStorage.getItem("room-studio-layout-v2"))');
  const viewport = async (width, height) => {
    touch = width <= 900;
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 2 });
    await setViewport(cdp, width, height);
  };
  await viewport(1440, 1000);
  await browser.navigate(appUrl);
  await screenshot('desktop-start');
  assert.equal(await page('!!document.querySelector("[data-start-room-form]")'), true, 'first use offers a room-size form');
  await input('[name="roomWidth"]', 420);
  await input('[name="roomDepth"]', 320);
  await click('[data-start-room-form] [type="submit"]');
  let saved = await state();
  assert.equal(saved.zones.length, 1);
  assert.equal(saved.zones[0].width, 420);
  assert.equal(saved.zones[0].depth, 320);
  assert.equal(saved.items.length, 0);
  assert.equal(await page('document.querySelector(".workspace").dataset.mode'), 'simple');
  await screenshot('desktop-room');
  receipt.scenarios.push('two dimensions create a single empty room in simple mode');

  await click('[data-simple-action="furniture"]');
  assert.equal(await page('document.activeElement.matches("[data-furniture-search]")'), true, 'furniture navigation moves focus to the visible destination');
  await input('[data-furniture-search]', '소파');
  assert.equal(await page('document.querySelectorAll(".furniture-library button:not([hidden])").length'), 1);
  await input('[data-furniture-search]', '찾을수없는가구');
  assert.equal(await page('document.querySelector("[data-furniture-empty]").hidden'), false);
  await click('[data-furniture-search-clear]');
  await click('[data-add-type="sofa"]');
  const placement = await page(`(() => {
    const svg = document.querySelector('#plan-canvas');
    const point = new DOMPoint(210, 160).matrixTransform(svg.getScreenCTM());
    return { x: point.x, y: point.y };
  })()`);
  await clickPoint(placement);
  saved = await state();
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].type, 'sofa');
  await screenshot('desktop-selection');
  receipt.scenarios.push('furniture search, empty results, clear and pointer placement work');

  await click('[data-simple-action="rotate"]');
  assert.equal((await state()).items[0].rotation, 90);
  await click('#undo-action');
  assert.equal((await state()).items[0].rotation, 0);
  await click('[data-simple-action="size"]');
  await input('[data-quick-field="width"]', 230);
  await key('Enter', 13);
  assert.equal((await state()).items[0].width, 230);
  await screenshot('desktop-size');
  await key('Escape', 27);
  await click('[data-simple-action="duplicate"]');
  assert.equal((await state()).items.length, 2);
  await click('#undo-action');
  assert.equal((await state()).items.length, 1);
  receipt.scenarios.push('selection actions rotate, resize and duplicate with one-step undo');

  const beforeMode = await state();
  await click('[data-workspace-mode]');
  assert.equal(await page('document.querySelector(".workspace").dataset.mode'), 'advanced');
  assert.equal(await page('document.querySelector("[data-disclosure=structures]").open'), true, 'precision tools are not trapped in a closed disclosure');
  await screenshot('desktop-advanced');
  await click('[data-workspace-mode]');
  assert.deepEqual(await state(), beforeMode, 'changing the workspace must not change the document');
  await browser.navigate(appUrl);
  assert.equal(await page('!!document.querySelector("[data-start-room-form]")'), false);
  assert.deepEqual(await state(), beforeMode);
  receipt.scenarios.push('precision mode and reload preserve the current document');

  for (const [width, height] of [[320, 568], [375, 812], [390, 844], [768, 1024], [844, 390], [1280, 800], [1440, 1000]]) {
    await viewport(width, height);
    assert.equal(await page('document.documentElement.scrollWidth <= innerWidth'), true, `${width} has no horizontal overflow`);
    const canvas = await page(`(() => { const r = document.querySelector('#plan-canvas').getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
    assert.ok(canvas.width >= 200 && canvas.height >= 150, `${width} has a usable canvas`);
    await screenshot(`workspace-${width}x${height}`);
    if (touch) {
      await click('[data-mobile-panel="furniture"]');
      await screenshot(`furniture-${width}x${height}`);
      await click('[data-mobile-panel="spaces"]');
      assert.equal(await page(`(() => {
        const button = document.querySelector('#add-zone');
        const bounds = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
      })()`), true, `${width} space creation is not covered by the inactive canvas`);
      await screenshot(`spaces-${width}x${height}`);
      await click('[data-mobile-panel="inspector"]');
      await screenshot(`inspector-${width}x${height}`);
      await click('[data-mobile-panel="canvas"]');
    } else {
      await click('[data-workspace-panel="spaces"]');
      await screenshot(`spaces-${width}x${height}`);
      await click('[data-workspace-panel="furniture"]');
    }
  }
  receipt.scenarios.push('all seven viewports retain reachable panels and a usable canvas');

  await viewport(390, 844);
  await click('[data-mobile-panel="inspector"]');
  await click('.workspace-panel-back');
  assert.equal(await page('document.activeElement.matches("[data-furniture-search]")'), true, 'mobile inspector Back focuses a visible control');
  await click('[data-mobile-panel="canvas"]');
  await click('[data-start-open]');
  await screenshot('mobile-start');
  await input('[name="roomWidth"]', 90);
  await click('[data-start-room-form] [type="submit"]');
  assert.equal(await page('!!document.querySelector("[data-start-room-form]")'), true, 'invalid room dimensions keep the form open');
  assert.deepEqual(await state(), beforeMode, 'invalid dimensions cannot replace the current drawing');
  await key('Escape', 27);
  assert.deepEqual(await state(), beforeMode);
  await click('[data-start-open]');
  await click('[data-start-sample]');
  const door = (await state()).structures.find((structure) => structure.type === 'door' && structure.doorType === 'swing');
  assert.ok(door, 'real apartment sample includes an operable swing door');
  await click('[data-mobile-panel="spaces"]');
  await click('[data-disclosure="structures"] > summary');
  await click(`[data-select-structure="${door.id}"]`);
  await click('[data-mobile-panel="canvas"]');
  await click('[data-simple-action="opening"]');
  assert.equal((await state()).structures.find(({ id }) => id === door.id).openAngle, 0);
  await click('[data-simple-action="opening"]');
  assert.equal((await state()).structures.find(({ id }) => id === door.id).openAngle, 90);
  await screenshot('mobile-door-actions');
  receipt.scenarios.push('invalid dimensions protect work and sample doors open directly from the selection bar');
  assert.deepEqual(receipt.errors, []);
  receipt.status = 'PASS';
  console.log(`SIMPLE_WORKSPACE_PASS ${receipt.scenarios.length} scenarios`);
} catch (error) {
  receipt.status = 'FAIL';
  receipt.failure = error.stack;
  process.exitCode = 1;
  console.error(`SIMPLE_WORKSPACE_FAIL ${error.message}`);
  if (browser) await capture(browser.cdp, join(outputDirectory, 'failure.png'));
} finally {
  await browser?.close();
  await server?.close();
  receipt.cleanup = 'Owned Chrome, disposable profile and server closed';
  await writeFile(join(outputDirectory, 'results.json'), JSON.stringify(receipt, null, 2));
  console.log(`SIMPLE_WORKSPACE_EVIDENCE ${outputDirectory}`);
}
process.exit(process.exitCode ?? 0);
