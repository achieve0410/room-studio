import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { captureRoomScene } from './browser-rendering.mjs';

const root = resolve(import.meta.dirname, '..');
const output = join(root, '.omx/artifacts/direct-space-editor/3d', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
const report = { output, checks: [], screenshots: [], errors: [] };
const server = await createServer({
  root, cacheDir: join(output, 'vite-cache'),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/.omx/**'] } },
  plugins: [{
    name: 'polygon-3d-observation',
    configureServer(server) {
      server.middlewares.use('/__polygon3d', (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Polygon 3D integration</title><main id="app"></main><script type="module">import "/src/styles.css";</script>');
      });
    },
    transform(source, id) {
      if (id.split('?')[0] !== join(root, 'src/walkthrough3d.js')) return;
      const anchor = "  overlay.dataset.walkthroughReady = 'true';";
      assert.equal(source.split(anchor).length, 2);
      return source.replace(anchor, `
        window.__THREE = THREE;
        window.__scene = () => ({ scene, camera, renderer, center, zones, items, sceneStructures,
          editSession, destroyed, canMoveTo, overviewOrbitTarget, openingControllers, pickEditable });
        ${anchor}`);
    },
  }],
});
let context, page;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  context = await chromium.launchPersistentContext(join(output, 'chrome-profile'), {
    channel: 'chrome', headless: true,
    viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true,
  });
  page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/__polygon3d`);
  let serial = 0;
  const arm = async expression => {
    const key = `__signal${serial++}`;
    await page.evaluate(({ key, expression }) => {
      window[key] = new Promise((resolve, reject) => {
        const test = new Function(`return (${expression})`);
        const observer = new MutationObserver(check);
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`State timeout: ${expression}`)); }, 20000);
        function check() { if (test()) { observer.disconnect(); clearTimeout(timer); resolve(); } }
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        check();
      });
    }, { key, expression });
    return () => page.evaluate(async key => { await window[key]; delete window[key]; }, key);
  };
  const change = async (expression, action) => { const done = await arm(expression); await action(); await done(); };
  const ready = `document.querySelector('[data-walkthrough]')?.dataset.studioReady === 'true' && document.querySelector('[data-walkthrough]')?.dataset.assetState === 'ready'`;
  const paint = () => page.evaluate(() => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Frame timeout')), 20000);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  }));
  const capture = async name => {
    await paint();
    const path = join(output, `${name}.png`);
    await captureRoomScene(page, path); report.screenshots.push(path);
  };
  const open = async shape => {
    await change(ready, () => page.evaluate(async shape => {
      const { openWalkthrough } = await import('/src/walkthrough3d.js');
      const { zoneFromPoints } = await import('/src/geometry.js');
      const { createStudioEditSession } = await import('/src/studio3d-edit.js');
      const points = shape === 'concave' ? [[0, 0], [600, 0], [600, 160], [160, 160], [160, 600], [0, 600]]
        : [[0, 0], [650, 650], [0, 650]];
      const zone = zoneFromPoints({ id: shape, name: shape === 'concave' ? 'ㄱ자 방' : '사선 방',
        type: '거실', height: 260, floorMaterialId: 'oak-natural', wallMaterialId: 'plaster-chalk' },
      points.map(([x, y]) => ({ x, y })));
      let layout = { zones: [zone], items: [], structures: [], wallHeight: 260 };
      if (shape === 'angled') {
        const session = createStudioEditSession({ layout, onEdit: () => {} });
        session.preview({ type: 'add-structure', structure: { id: 'door', type: 'door', name: '사선 문', x: 190, y: 170,
          width: 90, height: 205, doorType: 'swing', openAngle: 0, hinge: 'start', openSide: 1, orientation: 'horizontal' } });
        layout = structuredClone(session.layout); session.refresh(layout);
        session.preview({ type: 'add-structure', structure: { id: 'window', type: 'window', name: '사선 창', x: 460, y: 440,
          width: 130, height: 110, sillHeight: 90, openRatio: 0, slideDirection: 'end', orientation: 'horizontal' } });
        layout = structuredClone(session.layout);
      }
      const history = [];
      window.__canonical = () => layout;
      window.__replaceLayout = next => { layout = structuredClone(next); window.__cleanup.refresh(layout); };
      window.__snapshots = [];
      window.__cleanup = openWalkthrough({ ...layout, initialMode: 'dollhouse', getLayout: () => layout,
        onEdit() { history.push(structuredClone(layout)); layout = structuredClone(window.__scene().editSession.layout); return layout; },
        onUndo() { if (history.length) layout = history.pop(); return layout; },
        historyState: () => ({ canUndo: history.length > 0, canRedo: false }),
        onSnapshot(snapshot) { window.__snapshots.push({ ...snapshot, beforeDisposal: !window.__scene().destroyed && !window.__scene().renderer.getContext().isContextLost() }); },
      });
    }, shape));
  };
  const project = (x, y, height = 0) => page.evaluate(({ x, y, height }) => {
    const { camera, center, renderer } = window.__scene();
    const point = new window.__THREE.Vector3((x - center.x) / 100, height, (y - center.y) / 100).project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return { x: rect.x + (point.x + 1) * rect.width / 2, y: rect.y + (1 - point.y) * rect.height / 2 };
  }, { x, y, height });
  const touch = async (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const tapPoint = async point => { await touch('touchStart', [{ ...point, id: 1 }]); await touch('touchEnd', []); };
  const verifyVoid = async () => assert.deepEqual(await page.evaluate(() => {
    const { scene, center, canMoveTo } = window.__scene();
    scene.updateMatrixWorld(true);
    const THREE = window.__THREE;
    const origin = new THREE.Vector3((350 - center.x) / 100, 4, (350 - center.y) / 100);
    const floors = new THREE.Raycaster(origin, new THREE.Vector3(0, -1, 0)).intersectObjects(scene.children, true)
      .filter(hit => hit.object.userData.type === 'floor').length;
    return { floors, walkable: canMoveTo(origin) };
  }), { floors: 0, walkable: false });

  await open('concave');
  await verifyVoid();
  await change(`window.__scene().editSession.pending && ${ready}`, () => page.locator('[data-studio-template="custom"]').click());
  assert.equal(await page.evaluate(async () => {
    const { pointInZone } = await import('/src/geometry.js');
    const draft = window.__scene().editSession.layout;
    return pointInZone(draft.items.at(-1), draft.zones[0]);
  }), true, 'catalog placement starts inside a concave room rather than its empty bounding center');
  await page.locator('[data-studio-cancel]').click();
  await capture('concave-dollhouse');
  await page.locator('[data-view-mode="top"]').click();
  const floorPoint = await project(80, 320);
  await change(`document.querySelector('.studio3d-shell').dataset.selectionId === 'concave'`, () => page.mouse.click(floorPoint.x, floorPoint.y));
  await change(`window.__scene().editSession.pending && ${ready}`, () => page.locator('[data-studio-material="tile-slate"]').click());
  assert.equal(await page.evaluate(() => window.__canonical().zones[0].floorMaterialId), 'oak-natural');
  await page.locator('[data-studio-cancel]').click();
  await change(`window.__scene().editSession.pending && ${ready}`, () => page.locator('[data-studio-material="tile-slate"]').click());
  await change(`!window.__scene().editSession.pending && ${ready}`, () => page.locator('[data-studio-apply]').click());
  assert.equal(await page.evaluate(() => window.__canonical().zones[0].floorMaterialId), 'tile-slate');
  await page.locator('[data-studio-undo]').click();
  assert.equal(await page.evaluate(() => window.__canonical().zones[0].floorMaterialId), 'oak-natural');
  await capture('concave-top-floor-selected');
  await verifyVoid();
  await page.locator('[data-view-mode="walk"]').click();
  assert.equal(await page.evaluate(() => window.__scene().canMoveTo(window.__scene().camera.position)), true);
  await capture('concave-walk');
  for (const shift of [800, -800]) {
    const revision = await page.locator('[data-walkthrough]').getAttribute('data-scene-revision');
    await change(`document.querySelector('[data-walkthrough]').dataset.sceneRevision !== ${JSON.stringify(revision)} && ${ready}`, () => page.evaluate(shift => {
      const next = structuredClone(window.__canonical()); next.zones[0].x += shift; window.__replaceLayout(next);
    }, shift));
    assert.equal(await page.evaluate(() => window.__scene().canMoveTo(window.__scene().camera.position)), true, 'shape refresh relocates an invalid saved walk pose');
  }
  report.checks.push('host geometry refresh rebuilds polygon scene/minimap and relocates invalid walk poses');
  await page.locator('[data-view-mode="dollhouse"]').click();
  const stage = await page.locator('[data-walkthrough-stage]').boundingBox();
  await page.mouse.move(stage.x + 20, stage.y + 20); await page.mouse.down();
  await page.mouse.move(stage.x + 160, stage.y + 75); await page.mouse.up();
  await capture('concave-orbit');
  await page.locator('[data-walkthrough-exit]').first().click();
  assert.equal(await page.evaluate(() => window.__scene().destroyed && window.__scene().renderer.getContext().isContextLost()), true);
  const snapshot = await page.evaluate(async () => {
    const value = window.__snapshots[0];
    const image = new Image(); image.src = value.imageDataUrl; await image.decode();
    return { jpeg: value.imageDataUrl.startsWith('data:image/jpeg;base64,'), width: image.width, height: image.height,
      beforeDisposal: value.beforeDisposal, points: value.layout.zones[0].points.length };
  });
  assert.ok(snapshot.jpeg && snapshot.beforeDisposal && Math.max(snapshot.width, snapshot.height) === 720);
  assert.equal(snapshot.points, 6);
  report.checks.push('concave real floor/ceiling void, safe walk start, actual floor picking and finish preview/cancel/apply/undo; bounded JPEG before disposal');

  await open('angled');
  assert.ok(await page.evaluate(() => window.__canonical().structures.every(opening => Math.abs(opening.angle - 45) < 1e-6 && opening.wallAttachment.zoneId === 'angled')));
  await capture('angled-dollhouse');
  await page.locator('[data-view-mode="top"]').click();
  await page.locator('[data-view-mode="dollhouse"]').click();
  const wallPoint = await page.evaluate(() => {
    const { camera, renderer, center, pickEditable } = window.__scene();
    const p = new window.__THREE.Vector3((320 - center.x) / 100, 0.3, (320 - center.y) / 100).project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    const x = r.x + (p.x + 1) * r.width / 2, y = r.y + (1 - p.y) * r.height / 2;
    for (let dy = -25; dy <= 25; dy += 2) for (let dx = -25; dx <= 25; dx += 2) {
      const point = { clientX: x + dx, clientY: y + dy };
      const selected = pickEditable(point);
      if (selected?.id === 'angled' && selected.surface === 'wall') return { x: point.clientX, y: point.clientY };
    }
    throw new Error('No visible angled wall face can be picked');
  });
  await change(`document.querySelector('.studio3d-shell').dataset.selectionId === 'angled'`, () => page.mouse.click(wallPoint.x, wallPoint.y));
  assert.equal(await page.locator('[data-studio-tab="wall"]').getAttribute('aria-selected'), 'true');
  await change(`window.__scene().editSession.pending && ${ready}`, () => page.locator('[data-studio-material="plaster-warm"]').click());
  await page.locator('[data-studio-apply]').click();
  await page.locator('[data-studio-target]').selectOption('structure:door');
  assert.equal(await page.locator('[data-studio-wall-target] option').evaluateAll(options =>
    options.some(option => /undefined|NaN/.test(option.textContent))), false, 'angled wall options contain finite geometry');
  await page.locator('[data-studio-nudge="10,0"]').click();
  const draft = await page.evaluate(() => window.__scene().editSession.layout.structures[0]);
  assert.ok(Math.abs(draft.x - draft.y) < 1e-6);
  await page.locator('[data-studio-cancel]').click();
  await page.locator('[data-studio-opening="1"]').click(); await page.locator('[data-studio-apply]').click();
  await page.locator('[data-studio-target]').selectOption('structure:window');
  await page.locator('[data-studio-opening="0.5"]').click(); await page.locator('[data-studio-apply]').click();
  await page.locator('[data-view-mode="top"]').click();
  await capture('angled-top-openings');
  assert.deepEqual(await page.evaluate(() => window.__canonical().structures.map(opening => opening.openAngle ?? opening.openRatio)), [90, 50]);
  await page.locator('[data-view-mode="dollhouse"]').click(); await capture('angled-finished');
  await page.locator('[data-studio-opening="1"]').click();
  await page.locator('[data-walkthrough-exit]').first().click();
  assert.equal(await page.evaluate(() => window.__snapshots.length), 0, 'pending placement/edit is never captured as a committed result');
  report.checks.push('angled wall native picking/material, snapped door/window ownership and cuts, opening previews and pending-snapshot suppression');

  await page.setViewportSize({ width: 390, height: 844 });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await open('concave');
  await page.locator('[data-view-mode="top"]').click();
  const mobileFloor = await project(80, 320);
  await change(`document.querySelector('.studio3d-shell').dataset.selectionId === 'concave'`, () => tapPoint(mobileFloor));
  const canvas = await page.locator('[data-walkthrough-stage]').boundingBox();
  const first = { x: canvas.x + 45, y: canvas.y + 90, id: 1 };
  const second = { x: canvas.x + 170, y: canvas.y + 90, id: 2 };
  const before = await page.evaluate(() => window.__scene().camera.position.distanceTo(window.__scene().overviewOrbitTarget));
  await touch('touchStart', [first]); await touch('touchStart', [first, second]);
  await change(`window.__scene().camera.position.distanceTo(window.__scene().overviewOrbitTarget) < ${before}`, () => touch('touchMove', [first, { ...second, x: second.x + 55 }]));
  await touch('touchEnd', []);
  assert.equal(await page.evaluate(() => window.__scene().editSession.pending), false);
  await capture('mobile-concave-touch-pinch');
  await page.locator('[data-view-mode="walk"]').click();
  const joystick = await page.locator('[data-walkthrough-joystick]').boundingBox();
  const start = await page.evaluate(() => window.__scene().camera.position.toArray());
  await change(`window.__scene().camera.position.x !== ${start[0]} || window.__scene().camera.position.z !== ${start[2]}`, () => touch('touchStart', [{ x: joystick.x + joystick.width / 2, y: joystick.y + joystick.height * 0.3, id: 1 }]));
  await touch('touchEnd', []);
  assert.equal(await page.evaluate(() => window.__scene().canMoveTo(window.__scene().camera.position)), true);
  await capture('mobile-concave-walk');
  await page.locator('[data-walkthrough-exit]').first().click();
  report.checks.push('native emulated mobile floor selection, pinch without edits, joystick navigation within polygon');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack; process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png') });
} finally {
  await context?.close(); await server.close();
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
