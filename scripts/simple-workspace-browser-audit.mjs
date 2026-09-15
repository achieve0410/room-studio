import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { capture, evaluate, launchChrome, setViewport } from '../.omo/evidence/room-studio-improvements/browser-qa-lib.mjs';

assert.equal(Boolean(process.env.AUDIT_URL), false, 'This integrated workflow gate requires its read-only instrumented Vite server');
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
  plugins: [{
    name: 'simple-workflow-read-only-scene',
    transform(source, id) {
      if (id.split('?')[0] !== resolve('src/walkthrough3d.js')) return;
      const anchor = "  overlay.dataset.walkthroughReady = 'true';";
      assert.equal(source.split(anchor).length, 2, 'one machine-consumed readiness anchor');
      return source.replace(anchor, `
        window.__simpleWorkflowScene = () => ({
          items, structures: sceneStructures, pending: editSession.pending,
          projectItem(id) {
            const item = items.find(entry => entry.id === id);
            const p = new THREE.Vector3((item.x-center.x)/100, ((item.elevation||0)+item.height/2)/100, (item.y-center.y)/100).project(camera);
            const r = renderer.domElement.getBoundingClientRect();
            return { x: r.x + (p.x+1)*r.width/2, y: r.y + (1-p.y)*r.height/2 };
          },
        });
${anchor}`);
    },
  }],
});
await server?.listen();
const appUrl = process.env.AUDIT_URL ?? `http://127.0.0.1:${server.httpServer.address().port}`;
const chromePath = process.env.CHROME_PATH ?? (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome');
const receipt = { appUrl, scenarios: [], screenshots: [], errors: [], actions: [], scenarioMapping: [
  {
    "old": "room size startup",
    "new": "unchanged: native room form"
  },
  {
    "old": "2D furniture search/empty/clear/pointer placement",
    "new": "3D catalog search/zero results/native clear/real scene drag/Apply + 2D absence boundary"
  },
  {
    "old": "2D rotate/resize/duplicate/undo",
    "new": "3D preview/Apply/one-step undo, Escape rollback; read-only 2D roundtrip"
  },
  {
    "old": "precision structures disclosure and reload",
    "new": "precision tracing accessible; detail controls absent in both modes; reload equality"
  },
  {
    "old": "seven viewport 2D furniture/spaces/inspector panels",
    "new": "seven viewport spaces/inspector + real 3D catalog containment and return"
  },
  {
    "old": "mobile Back focus, invalid startup, sample door toggle",
    "new": "space tab focus, unchanged invalid startup protection, 3D sample opening preview/Apply"
  }
] };
let browser;
let controls;
const bounded = (promise, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), 20_000);
  })]).finally(() => clearTimeout(timer));
};

try {
  browser = await launchChrome(chromePath);
  const cdp = browser.cdp;
  controls = await chromium.connectOverCDP(`http://127.0.0.1:${new URL(cdp.socket.url).port}`);
  const controlPage = controls.contexts()[0].pages()[0];
  const page = (expression) => bounded(evaluate(cdp, expression), expression.slice(0, 120));
  const frame = () => page('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  cdp.listeners.set('Runtime.exceptionThrown', new Set([(event) => receipt.errors.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text)]));
  let touch = false;
  let sequence = 0;
  const armState = async (expression, events = []) => {
    const id = `__workflowSignal${sequence++}`;
    await page(`(() => {
      window[${JSON.stringify(id)}] = new Promise((done, reject) => {
        const finish = () => { clearTimeout(timer); observer.disconnect(); for (const type of ${JSON.stringify(events)}) document.removeEventListener(type, check, true); };
        const check = () => { if (${expression}) { finish(); done(true); } };
        const observer = new MutationObserver(check);
        const timer = setTimeout(() => { finish(); reject(new Error(${JSON.stringify('State timeout: ' + expression)})); }, 15000);
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        for (const type of ${JSON.stringify(events)}) document.addEventListener(type, check, true);
        check();
      });
      window[${JSON.stringify(id)}].catch(() => {});
    })()`);
    return async () => { await page(`window[${JSON.stringify(id)}]`); await page(`delete window[${JSON.stringify(id)}]`); };
  };
  const clickPoint = async (point, selector = null) => {
    const eventType = selector && await page(`document.querySelector(${JSON.stringify(selector)}).matches('button, summary, [role=tab]')`) ? 'click' : 'pointerup';
    await page(`window.__workflowInput = new Promise(resolveInput => document.addEventListener(${JSON.stringify(eventType)}, event => resolveInput(event.isTrusted), { once: true, capture: true })); true`);
    if (touch) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
      }
    }
    assert.equal(await page('window.__workflowInput'), true, 'native input completes before assertions');
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
    await clickPoint(point, selector);
    receipt.actions.push({ click: selector, touch });
  };
  const input = async (selector, value) => {
    await click(selector);
    await page(`document.querySelector(${JSON.stringify(selector)}).select()`);
    if (String(value)) await cdp.send('Input.insertText', { text: String(value) });
    else await key('Backspace', 8);
  };
  const key = async (key, code, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code, modifiers });
    }
    await frame();
  };
  const screenshot = async (name) => {
    await frame();
    const path = join(outputDirectory, `${name}.png`);
    await bounded(capture(cdp, path), 'Screenshot');
    receipt.screenshots.push(path);
  };
  const state = () => page('JSON.parse(localStorage.getItem("room-studio-layout-v2"))');
  const viewport = async (width, height) => {
    touch = width <= 900;
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 2 });
    await setViewport(cdp, width, height);
  };
  await viewport(1440, 1000);
  await bounded(browser.navigate(appUrl), 'Navigation');
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

  const noLegacyDetails = async () => {
    assert.equal(await page('!!document.querySelector("[data-furniture-search], [data-add-type], [data-item-field], [data-structure-field], [data-select-structure], [data-structure-rotate], [data-rotate-handle], [data-resize-kind=item], [data-overlap-picker]")'), false,
      '2D has no catalog, detail inspector, picker or furniture/structure mutation handles');
  };
  const scene = () => page('(() => { const { projectItem, ...state } = window.__simpleWorkflowScene(); return state; })()');
  const open3d = async (selector = '#open-walkthrough') => {
    const ready = await armState(`document.querySelector('[data-walkthrough]')?.dataset.studioReady === 'true' && document.querySelector('[data-walkthrough]')?.dataset.assetState === 'ready'`);
    await click(selector);
    await ready();
    assert.equal(await page('document.querySelector("#app").inert'), true);
    assert.equal(await page('!!document.activeElement.closest("[data-walkthrough]")'), true);
    if (await page('document.querySelector("[data-studio-toggle]").getAttribute("aria-expanded") === "false"')) await click('[data-studio-toggle]');
  };
  const apply3d = async () => {
    const ready = await armState(`!document.querySelector('[data-studio-apply]').disabled`);
    await ready();
    const applied = await armState(`document.querySelector('.studio3d-shell').dataset.pending === 'false'`);
    await click('[data-studio-apply]');
    await applied();
  };
  const close3d = async () => {
    const closed = await armState(`!document.querySelector('[data-walkthrough]') && document.activeElement === document.querySelector('#open-walkthrough')`, ['focusin']);
    await click('.walkthrough-exit');
    await closed();
    assert.equal(await page('document.querySelector("#app").inert'), false);
  };
  const chooseTarget = async value => {
    const chosen = await armState(`document.querySelector('[data-studio-target]').value === ${JSON.stringify(value)}`, ['change']);
    // Use the real HTML select, not platform-specific native popup key routing.
    await controlPage.locator('[data-studio-target]').selectOption(value, { timeout: 15000 });
    await chosen();
  };

  await noLegacyDetails();
  await open3d();
  await click('[data-studio-tab="item"]');
  await input('[data-studio-search]', '소파');
  assert.deepEqual(await page(`[...document.querySelectorAll('[data-studio-asset]:not([hidden])')].map(button => button.dataset.studioAsset).sort()`),
    ['seoul-coffee-table', 'seoul-sofa'], '3D search returns the sofa and matching table, not unrelated models');
  await input('[data-studio-search]', '찾을수없는가구');
  assert.equal(await page('document.querySelectorAll("[data-studio-catalog] button:not([hidden])").length'), 0);
  await input('[data-studio-search]', '');
  assert.ok(await page('document.querySelectorAll("[data-studio-asset]:not([hidden])").length') > 2, 'clearing the real search restores the catalog');
  const placed = await armState(`document.querySelector('.studio3d-shell').dataset.pending === 'true' && document.querySelector('[data-walkthrough]').dataset.assetState === 'ready'`);
  await click('[data-studio-asset="seoul-sofa"]');
  await placed();
  assert.equal((await state()).items.length, 0, 'placement is a scene preview until Apply');
  let draft = await scene();
  assert.equal(draft.items.length, 1);
  assert.equal(draft.items[0].assetId, 'seoul-sofa');
  const sofaId = draft.items[0].id;
  await click('[data-view-mode="top"]');
  const placement = await page(`window.__simpleWorkflowScene().projectItem(${JSON.stringify(sofaId)})`);
  assert.equal(await page(`document.elementFromPoint(${placement.x}, ${placement.y})?.matches('[data-walkthrough-canvas]')`), true, 'preview is on the actual scene');
  const moved = await armState(`window.__simpleWorkflowScene().items[0].x !== ${draft.items[0].x}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...placement, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: placement.x + 35, y: placement.y + 12, button: 'left', buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: placement.x + 35, y: placement.y + 12, button: 'left', clickCount: 1 });
  await moved();
  draft = await scene();
  assert.equal((await state()).items.length, 0);
  await screenshot('desktop-3d-placement-preview');
  await apply3d();
  saved = await state();
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].type, 'sofa');
  assert.equal(saved.items[0].x, draft.items[0].x);
  receipt.scenarios.push('3D furniture search, no results, native clear, real scene pointer placement and explicit Apply');

  for (let rotation = 0; rotation < 6; rotation++) await click('[data-studio-rotate]');
  assert.equal((await scene()).items[0].rotation, 90);
  assert.equal((await state()).items[0].rotation, 0);
  await apply3d();
  assert.equal((await state()).items[0].rotation, 90);
  await click('[data-studio-undo]');
  assert.equal((await state()).items[0].rotation, 0, 'six preview rotations commit as one undo step');
  await input('[data-studio-value="width"]', 230);
  await key('Tab', 9);
  assert.equal((await scene()).items[0].width, 230);
  await apply3d();
  assert.equal((await state()).items[0].width, 230);
  await screenshot('desktop-3d-size');
  await click('[data-studio-duplicate]');
  assert.equal((await state()).items.length, 1);
  await apply3d();
  assert.equal((await state()).items.length, 2);
  await click('[data-studio-undo]');
  assert.equal((await state()).items.length, 1);
  await chooseTarget(`item:${sofaId}`);
  const beforeCancel = await state();
  await input('[data-studio-value="width"]', 250);
  await key('Tab', 9);
  await key('Escape', 27);
  assert.equal((await scene()).pending, false, 'Escape cancels the 3D numeric preview');
  assert.deepEqual(await state(), beforeCancel);
  await close3d();
  await noLegacyDetails();
  const renderedSofa = await page(`(() => {
    const node = document.querySelector('[data-item-id="${sofaId}"]');
    const r = node.getBoundingClientRect();
    return { visible: r.width > 0 && r.height > 0, readOnly: getComputedStyle(node).pointerEvents === 'none' };
  })()`);
  assert.deepEqual(renderedSofa, { visible: true, readOnly: true });
  receipt.scenarios.push('3D rotate, size, duplicate, one-step undo and Escape cancellation persist into read-only 2D');

  const beforeMode = await state();
  await click('[data-workspace-mode]');
  assert.equal(await page('document.querySelector(".workspace").dataset.mode'), 'advanced');
  await noLegacyDetails();
  await click('[data-disclosure=tracing] > summary');
  assert.equal(await page('document.querySelector("[data-disclosure=tracing]").open'), true, 'supported precision tracing remains reachable');
  await screenshot('desktop-advanced');
  await click('[data-workspace-mode]');
  assert.deepEqual(await state(), beforeMode, 'changing the workspace must not change the document');
  await bounded(browser.navigate(appUrl), 'Navigation');
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
      await screenshot(`spaces-${width}x${height}`);
    }
    await noLegacyDetails();
    await open3d(touch ? '.mobile-nav [data-open-detail]' : '#open-walkthrough');
    await click('[data-studio-tab="item"]');
    await input('[data-studio-search]', '소파');
    const geometry = await page(`(() => {
      const stage = document.querySelector('[data-walkthrough-stage]').getBoundingClientRect();
      const panel = document.querySelector('.studio3d-shell').getBoundingClientRect();
      const apply = document.querySelector('[data-studio-apply]').getBoundingClientRect();
      return { separated: stage.right <= panel.left || stage.bottom <= panel.top, height: stage.height,
        overflow: document.documentElement.scrollWidth > innerWidth, applyVisible: apply.top >= 0 && apply.bottom <= innerHeight };
    })()`);
    assert.equal(geometry.separated, true, `${width} 3D panel does not cover the scene`);
    assert.ok(geometry.height >= 150, `${width} has a usable 3D stage`);
    assert.equal(geometry.overflow, false);
    assert.equal(geometry.applyVisible, true);
    await screenshot(`furniture-3d-${width}x${height}`);
    await close3d();
    assert.deepEqual(await state(), beforeMode, 'viewport and panel navigation never edit the drawing');
  }
  receipt.scenarios.push('all seven viewports retain reachable space/inspector panels, a usable 2D canvas and a separate real 3D catalog');

  await viewport(390, 844);
  await click('[data-mobile-panel="inspector"]');
  await click('.workspace-panel-back');
  assert.equal(await page('document.activeElement.matches("[data-mobile-panel=spaces]")'), true, 'mobile inspector Back focuses the visible space destination');
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
  await noLegacyDetails();
  const sampleBefore = await state();
  assert.equal(await page(`!!document.querySelector('[data-structure-id="${door.id}"]')`), true, 'sample opening remains rendered in 2D');
  await open3d('.mobile-nav [data-open-detail]');
  await chooseTarget(`structure:${door.id}`);
  await click('[data-studio-opening="0"]');
  assert.deepEqual(await state(), sampleBefore, 'opening preview does not persist before Apply');
  await apply3d();
  assert.equal((await state()).structures.find(({ id }) => id === door.id).openAngle, 0);
  await click('[data-studio-opening="1"]');
  await apply3d();
  assert.equal((await state()).structures.find(({ id }) => id === door.id).openAngle, 90);
  await screenshot('mobile-3d-door-actions');
  const beforeWall = await state();
  await click('[data-studio-structure="wall"]');
  await apply3d();
  const wall = (await state()).structures.at(-1);
  assert.equal(wall.type, 'wall');
  await click('[data-studio-rotate]');
  assert.equal((await scene()).structures.find(({ id }) => id === wall.id).orientation, 'vertical');
  await apply3d();
  const rotated = await state();
  await click('[data-studio-rotate]');
  await apply3d();
  assert.equal((await state()).structures.find(({ id }) => id === wall.id).orientation, 'horizontal');
  await click('[data-studio-undo]');
  assert.deepEqual(await state(), rotated);
  await click('[data-studio-undo]');
  assert.equal((await state()).structures.find(({ id }) => id === wall.id).orientation, 'horizontal');
  await click('[data-studio-undo]');
  assert.deepEqual(await state(), beforeWall, 'wall placement and each committed rotation have their own undo boundary');
  await close3d();
  await noLegacyDetails();
  receipt.scenarios.push('invalid dimensions protect work; sample doors and wall rotation use the real 3D inspector with one-step undo');
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
  await bounded(controls?.close(), 'Control connection cleanup');
  await bounded(browser?.close(), 'Chrome cleanup');
  await bounded(server?.close(), 'Vite cleanup');
  receipt.cleanup = 'Owned Chrome, disposable profile and server closed';
  await writeFile(join(outputDirectory, 'results.json'), JSON.stringify(receipt, null, 2));
  console.log(`SIMPLE_WORKSPACE_EVIDENCE ${outputDirectory}`);
}
process.exit(process.exitCode ?? 0);
