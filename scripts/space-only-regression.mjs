import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer as reservePort } from 'node:net';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { capture, evaluate, setViewport } from '../.omo/evidence/room-studio-improvements/browser-qa-lib.mjs';

const root = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(process.env.SPACE_ONLY_OUTPUT ?? join(root, '.omx/artifacts/space-only', new Date().toISOString().replaceAll(':', '-')));
const report = { output: outputDirectory, renderProfile: 'production', checks: [], errors: [] };
const port = await new Promise((done, reject) => {
  const reservation = reservePort();
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', () => {
    const { port } = reservation.address(); reservation.close(() => done(port));
  });
});
// Fixture setup and observation only: the real 3D renderer, controls and host all run.
const server = await createServer({
  root, cacheDir: join(outputDirectory, 'vite-cache'),
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/.omx/**'] } },
  plugins: [{
    name: 'space-only-regression',
    transform(source, id) {
      if (id.split('?')[0] === join(root, 'src/walkthrough3d.js')) {
        const anchor = "  overlay.dataset.walkthroughReady = 'true';";
        assert.equal(source.split(anchor).length, 2);
        return source.replace(anchor, `
          window.__detailBridge = { furnitureTemplates, onEdit, onUndo, onRedo };
          window.__spaceScene = () => ({ editSession, renderer, scene, destroyed });
          ${anchor}`);
      }
      if (id.split('?')[0] !== join(root, 'src/main.js')) return;
      return `${source}
        window.__spaceRegression = {
          reset(layout) {
            applyProjectDocument({ projectName: 'Space regression', layout });
            starterDialogOpen = false;
            mobilePanel = 'canvas';
            pendingFocus = null;
            render();
          },
          snapshot: () => ({ layout: layoutSnapshot(), selection: state.selection, keys: [...selectionKeys], history: historyPast.length }),
          select: selectEntity,
          staleSelection(kind, id) { state.selection = { kind, id }; selectionKeys = new Set([kind + ':' + id]); render(); },
          portable: () => serializeProjectFile({ projectName: 'Space regression', layout: layoutSnapshot() }),
          import(source) { const project = parseProjectFile(source); applyProjectDocument(project); render(); },
        };`;
    },
  }],
});
let browser;
let chromePage;
let cdp;
const fixture = {
  zones: [{ id: 'room', type: '방', name: 'Room', x: 0, y: 0, width: 600, depth: 500 }],
  items: [{ id: 'chair', type: 'custom', name: 'Chair', x: 260, y: 240, width: 80, depth: 70, height: 80 }],
  structures: [
    { id: 'wall', type: 'wall', x: 300, y: 100, length: 300, height: 240, orientation: 'horizontal' },
    { id: 'door', type: 'door', x: 230, y: 100, width: 90, wallId: 'wall', orientation: 'horizontal' },
    { id: 'window', type: 'window', x: 360, y: 100, width: 80, wallId: 'wall', orientation: 'horizontal' },
  ],
  dimensions: [], wallHeight: 240,
};
try {
  await mkdir(outputDirectory, { recursive: true });
  await server.listen();
  const executablePath = process.env.CHROME_PATH ?? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    chromium.executablePath(),
  ].find(existsSync);
  assert.ok(executablePath && existsSync(executablePath), 'Install Chrome/Chromium or set CHROME_PATH');
  browser = await chromium.launch({ executablePath, headless: true, args: ['--enable-unsafe-swiftshader'] });
  chromePage = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  chromePage.setDefaultTimeout(20000);
  cdp = await chromePage.context().newCDPSession(chromePage);
  const bounded = (promise) => {
    let deadline;
    return Promise.race([promise, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Browser signal timed out')), 15000); })])
      .finally(() => clearTimeout(deadline));
  };
  const input = async (eventType, method, parameters) => {
    await bounded(evaluate(cdp, `window.__inputSignal = new Promise(resolve => document.addEventListener(${JSON.stringify(eventType)}, () => resolve(true), { once: true, capture: true })); true`));
    await cdp.send(method, parameters);
    await bounded(evaluate(cdp, 'window.__inputSignal'));
  };
  const page = {
    evaluate: (fn, value) => bounded(evaluate(cdp, `(${fn})(${value === undefined ? '' : JSON.stringify(value)})`)),
    keyboard: {
      async press(shortcut) {
        const key = shortcut.replace('Control+', '');
        const keyCode = { ArrowRight: 39, Delete: 46, r: 82, d: 68 }[key];
        const modifiers = shortcut.startsWith('Control+') ? 2 : 0;
        await input('keydown', 'Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: keyCode, modifiers });
        await input('keyup', 'Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: keyCode, modifiers });
      },
    },
    mouse: {
      x: 0, y: 0, pressed: false,
      async move(x, y) {
        this.x = x; this.y = y;
        await input('pointermove', 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: this.pressed ? 'left' : 'none', buttons: this.pressed ? 1 : 0 });
      },
      async down() {
        this.pressed = true;
        await input('pointerdown', 'Input.dispatchMouseEvent', { type: 'mousePressed', x: this.x, y: this.y, button: 'left', buttons: 1, clickCount: 1 });
      },
      async up() {
        this.pressed = false;
        await input('pointerup', 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: this.x, y: this.y, button: 'left', buttons: 0, clickCount: 1 });
      },
    },
  };
  const errors = report.errors;
  chromePage.on('pageerror', error => errors.push(error.message));
  await setViewport(cdp, 390, 844);
  await bounded(chromePage.goto(server.resolvedUrls.local[0]));
  let serial = 0;
  const change = async (expression, trigger) => {
    const key = `__spaceSignal${serial++}`;
    await evaluate(cdp, `(() => {
      window[${JSON.stringify(key)}] = new Promise((done, reject) => {
        const observer = new MutationObserver(check);
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error(${JSON.stringify(`State timeout: ${expression}`)})); }, 20000);
        function check() { if (${expression}) { clearTimeout(timer); observer.disconnect(); done(); } }
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); check();
      });
    })()`);
    await trigger();
    await evaluate(cdp, `window[${JSON.stringify(key)}]`);
    await evaluate(cdp, `delete window[${JSON.stringify(key)}]`);
  };
  const ready = `document.querySelector('[data-walkthrough]')?.dataset.studioReady === 'true' && document.querySelector('[data-walkthrough]')?.dataset.assetState === 'ready'`;
  const reset = () => page.evaluate((layout) => window.__spaceRegression.reset(layout), fixture);
  const snapshot = () => page.evaluate(() => window.__spaceRegression.snapshot());
  await reset();
  const before = await snapshot();
  await page.evaluate(() => { window.__spaceRegression.select('zone', 'room'); document.querySelector('#plan-canvas').focus(); });
  await page.keyboard.press('ArrowRight');
  let current = await snapshot();
  assert.equal(current.layout.zones[0].x, 1, 'space keyboard movement remains available');
  assert.deepEqual(current.layout.items, before.layout.items, '2D space movement must not mutate read-only furniture');
  assert.deepEqual(current.layout.structures, before.layout.structures);

  for (const mode of ['simple', 'advanced']) {
    if (mode === 'advanced') await page.evaluate(() => document.querySelector('[data-workspace-mode]').click());
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-add-type], [data-add-structure], #add-custom, #clear-furniture, [data-item-field], [data-structure-field], [data-item-rotate], [data-structure-rotate]').length), 0, `${mode} has no detail mutation controls`);
    for (const [kind, id] of [['item', 'chair'], ['structure', 'door']]) {
      await page.evaluate(([kind, id]) => window.__spaceRegression.staleSelection(kind, id), [kind, id]);
      await page.evaluate(() => document.querySelector('#plan-canvas').focus());
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('r');
      await page.keyboard.press('Control+d');
      await page.keyboard.press('Delete');
      current = await snapshot();
      assert.deepEqual(current.layout.items, before.layout.items, `${mode} ignores stale furniture selections`);
      assert.deepEqual(current.layout.structures, before.layout.structures, `${mode} ignores stale opening selections`);
      assert.equal(current.selection, null);
    }
  }
  await reset();
  // Furniture stays visible but the actual hit test selects the underlying room.
  const point = await page.evaluate(() => {
    const svg = document.querySelector('#plan-canvas');
    const p = new DOMPoint(260, 240).matrixTransform(svg.getScreenCTM());
    return { x: p.x, y: p.y, kind: document.elementFromPoint(p.x, p.y)?.closest('[data-zone-id]')?.dataset.zoneId };
  });
  assert.equal(point.kind, 'room');
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 35, point.y + 20);
  await page.mouse.up();
  current = await snapshot();
  assert.notEqual(current.layout.zones[0].x, 0);
  assert.deepEqual(current.layout.items, before.layout.items, 'pointer space movement leaves details unchanged');
  await page.evaluate(() => {
    document.querySelector('[data-mobile-panel="spaces"]').click();
    document.querySelector('#add-zone').click();
    document.querySelector('[data-mobile-panel="inspector"]').click();
    const name = document.querySelector('[data-zone-field="name"]');
    name.value = 'Bathroom';
    name.dispatchEvent(new Event('input'));
    name.dispatchEvent(new Event('blur'));
    const type = document.querySelector('[data-zone-field="type"]');
    type.value = '욕실';
    type.dispatchEvent(new Event('change'));
    const width = document.querySelector('[data-zone-field="width"]');
    width.value = '260';
    width.dispatchEvent(new Event('blur'));
  });
  const added = (await snapshot()).layout.zones.at(-1);
  assert.equal(added.name, 'Bathroom');
  assert.equal(added.type, '욕실');
  assert.equal(added.width, 260);
  await page.evaluate((id) => {
    window.__spaceRegression.select('zone', 'room');
    window.__spaceRegression.select('zone', id, true);
    document.querySelector('[data-mobile-panel="inspector"]').click();
    document.querySelector('[data-merge-spaces]').click();
  }, added.id);
  current = await snapshot();
  assert.equal(new Set(current.layout.zones.map(({ spaceId }) => spaceId)).size, 1);
  assert.deepEqual(current.layout.structures, before.layout.structures, 'merging spaces does not delete read-only doors');
  await page.evaluate(() => document.querySelector('[data-delete-space]').click());
  assert.equal((await snapshot()).layout.zones.length, 0);
  assert.deepEqual((await snapshot()).layout.items, before.layout.items);
  report.checks.push('simple/advanced retired detail controls absent; stale selection keyboard isolation; read-only details under native room drag; space create/rename/type/resize/merge/delete');
  await reset();
  await change(ready, () => chromePage.locator('#open-walkthrough').click());
  assert.equal(await page.evaluate(() => window.__detailBridge.furnitureTemplates.some(({ type }) => type === 'custom')), true);
  assert.equal(await page.evaluate(() => window.__spaceScene().renderer.shadowMap.enabled), true);
  assert.equal(await page.evaluate(() => window.__spaceScene().renderer.getContext().getContextAttributes().antialias), true);
  assert.equal(await chromePage.locator('#app').evaluate(app => app.inert), true);
  await chromePage.locator('[data-studio-toggle]').click();
  const field = async (key, value) => {
    const control = chromePage.locator(`[data-studio-value="${key}"]`);
    await control.fill(String(value)); await control.press('Tab');
  };
  const apply = async () => {
    const history = (await snapshot()).history;
    await change(`${ready} && !window.__spaceScene().editSession.pending && window.__spaceRegression.snapshot().history === ${history + 1}`, () => chromePage.locator('[data-studio-apply]').click());
  };
  assert.equal(await chromePage.locator('[data-studio-template="custom"]').count(), 1, 'the real host exposes one unambiguous custom furniture action');
  await chromePage.locator('[data-studio-template="custom"]').click();
  assert.equal((await snapshot()).layout.items.length, 1, '3D add is a draft until Apply');
  await apply();
  const nativeItemId = (await snapshot()).layout.items.at(-1).id;
  await field('x', 333); await field('rotation', 45); await apply();
  assert.equal((await snapshot()).layout.items.at(-1).x, 333);
  await chromePage.locator('[data-studio-delete]').click(); await apply();
  assert.equal((await snapshot()).layout.items.some(item => item.id === nativeItemId), false);
  await chromePage.locator('[data-studio-undo]').click();
  assert.equal((await snapshot()).layout.items.at(-1).rotation, 45);
  await chromePage.locator('[data-studio-redo]').click();
  assert.equal((await snapshot()).layout.items.length, 1);
  await chromePage.locator('[data-studio-tab="structure"]').click();
  await chromePage.locator('[data-studio-structure="wall"]').click(); await apply();
  const nativeWallId = (await snapshot()).layout.structures.at(-1).id;
  await chromePage.locator('[data-studio-structure="swing"]').click(); await apply();
  const nativeDoorId = (await snapshot()).layout.structures.at(-1).id;
  assert.equal((await snapshot()).layout.structures.at(-1).wallId, nativeWallId);
  await chromePage.locator('[data-studio-target]').selectOption(`structure:${nativeWallId}`);
  await field('x', 340); await apply();
  assert.equal((await snapshot()).layout.structures.at(-1).x, 340);
  await chromePage.locator('[data-studio-delete]').click(); await apply();
  assert.equal((await snapshot()).layout.structures.some(structure => structure.id === nativeDoorId), false);
  await chromePage.locator('[data-studio-tab="floor"]').click();
  await change(`${ready} && window.__spaceScene().editSession.pending`, () => chromePage.locator('[data-studio-material="oak-natural"]').click());
  await apply();
  assert.equal((await snapshot()).layout.zones[0].floorMaterialId, 'oak-natural');
  await chromePage.screenshot({ path: join(outputDirectory, 'space-only-real-3d.png') });
  report.checks.push('all seven detail action types via real 3D controls: item add/update/delete, structure add/update/delete with attached opening, zone finish; real host undo/redo');
  await change(`!document.querySelector('[data-walkthrough]')`, () => chromePage.locator('[data-walkthrough-exit]').first().click());
  assert.equal(await page.evaluate(() => window.__spaceScene().destroyed), true);
  await reset();
  await change(ready, () => chromePage.locator('#open-walkthrough').click());
  // Preserve hostile/out-of-range host callback boundary cases; do not replace the app surface.
  const edit = (action) => page.evaluate((action) => {
    const next = window.__detailBridge.onEdit(action);
    window.__spaceScene().editSession.refresh(next);
    return next;
  }, action);
  const history = (await snapshot()).history;
  await edit({ type: 'add-item', item: { id: 'new-item', type: 'custom', name: 'New', width: 9999, depth: 80, height: 80, x: 200, y: 200 } });
  assert.equal((await snapshot()).layout.items.at(-1).width, 600);
  await edit({ type: 'update-item', id: 'new-item', updates: { x: 333, rotation: 405 } });
  assert.equal((await snapshot()).layout.items.at(-1).rotation, 45);
  await edit({ type: 'delete-item', id: 'new-item' });
  assert.equal((await snapshot()).history, history + 3);
  await chromePage.locator('[data-studio-undo]').click();
  assert.equal((await snapshot()).layout.items.at(-1).x, 333);
  await chromePage.locator('[data-studio-redo]').click();
  assert.equal((await snapshot()).layout.items.length, 1);
  await edit({ type: 'add-structure', structure: { id: 'new-wall', type: 'wall', x: 300, y: 300, length: 250, height: 240 } });
  await edit({ type: 'add-structure', structure: { id: 'new-door', type: 'door', wallId: 'new-wall', x: 300, y: 300, width: 90 } });
  await edit({ type: 'update-structure', id: 'new-wall', updates: { x: 340 } });
  assert.equal((await snapshot()).layout.structures.at(-1).x, 340, 'attached opening follows its 3D wall');
  await edit({ type: 'delete-structure', id: 'new-wall' });
  assert.equal((await snapshot()).layout.structures.some(({ id }) => id === 'new-door'), false);
  await edit({ type: 'update-zone', id: 'room', updates: { floorMaterialId: 'oak-natural' } });
  assert.equal((await snapshot()).layout.zones[0].floorMaterialId, 'oak-natural');
  await edit({ type: 'update-item', id: 'chair', updates: { locked: true } });
  await assert.rejects(edit({ type: 'delete-item', id: 'chair' }));
  await assert.rejects(edit({ type: 'update-item', id: 'chair', updates: { x: 999 } }));
  await edit({ type: 'update-structure', id: 'door', updates: { locked: true } });
  await assert.rejects(edit({ type: 'delete-structure', id: 'wall' }));
  await assert.rejects(edit({ type: 'update-structure', id: 'wall', updates: { x: 999 } }));
  assert.equal((await snapshot()).selection?.kind === 'item', false);
  await change(`!document.querySelector('[data-walkthrough]')`, () => chromePage.locator('[data-walkthrough-exit]').first().click());
  assert.equal(await chromePage.locator('#app').evaluate(app => app.inert), false);
  report.checks.push('real host boundary normalization, locks and locked attached opening rejection; each successful action owns one history entry');
  const saved = await page.evaluate(() => window.__spaceRegression.portable());
  assert.equal(JSON.parse(saved).schemaVersion, 4);
  const savedLayout = (await snapshot()).layout;
  for (const schemaVersion of [1, 2, 3, 4]) {
    await page.evaluate((source) => window.__spaceRegression.import(source), JSON.stringify({ ...JSON.parse(saved), schemaVersion }));
    assert.deepEqual((await snapshot()).layout, savedLayout);
  }
  await assert.rejects(page.evaluate((source) => window.__spaceRegression.import(source), ' '.repeat(1_048_577)));
  await page.evaluate(() => {
    document.querySelector('[data-workspace-mode]').click();
    document.querySelector('[data-mobile-panel="canvas"]').click();
    window.scrollTo(0, 0);
  });
  assert.equal(await page.evaluate(() => document.querySelector('.workspace').dataset.mode), 'simple');
  const targets = await page.evaluate(() => [...document.querySelectorAll('.mobile-nav button, #open-walkthrough, .workspace-hint button')].map((button) => {
    const rect = button.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  assert(targets.every(({ width, height }) => width >= 44 && height >= 44), 'primary mobile targets are at least 44px');
  assert.deepEqual(errors, []);
  report.checks.push('portable schema 1/2/3 round trips and 1 MiB rejection; primary mobile hit targets >=44px; real renderer cleanup');
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  if (chromePage && !chromePage.isClosed()) await capture(cdp, join(outputDirectory, report.passed ? 'space-only-2d.png' : 'failure.png'));
  await browser?.close();
  await server.close();
  await writeFile(join(outputDirectory, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
