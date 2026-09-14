import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer as createPortReservation } from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { DEMO_LAYOUTS, REGIONAL_DEMO_LAYOUTS } from '../src/demo-layouts.js';

const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.STUDIO3D_OUTPUT ?? join(root, '.omx/artifacts/studio3d', new Date().toISOString().replaceAll(':', '-')));
await mkdir(output, { recursive: true });
const port = await new Promise((resolvePort, reject) => {
  const reservation = createPortReservation();
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', () => {
    const port = reservation.address().port;
    reservation.close(() => resolvePort(port));
  });
});
const server = await createServer({
  root,
  cacheDir: join(output, 'vite-cache'),
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/.omx/**'] } },
  plugins: [
    {
      name: 'studio-observation',
      transform(source, id) {
        if (id.split('?')[0] !== join(root, 'src/walkthrough3d.js')) return;
        const anchor = "  overlay.dataset.walkthroughReady = 'true';";
        assert.equal(source.split(anchor).length, 2);
        return source.replace(
          anchor,
          `
    window.__scene = () => ({ items, zones, sceneStructures, viewMode, destroyed, canMoveTo, scene, camera, center, editSession, overviewOrbitTarget,
      projectedPoints() { return studioSpatialPoints(overviewSpatialMeshes(scene)).map(point => point.project(camera).toArray()); },
      project(id) { const item = items.find(i => i.id === id); const p = new THREE.Vector3((item.x-center.x)/100, ((item.elevation||0)+item.height/2)/100, (item.y-center.y)/100).project(camera); const r = renderer.domElement.getBoundingClientRect(); return {x:r.x+(p.x+1)*r.width/2,y:r.y+(1-p.y)*r.height/2}; } });
    ${anchor}`,
        );
      },
    },
  ],
});
let browser;
let page;
const report = { output, checks: [], screenshots: [], errors: [] };
try {
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'),
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    acceptDownloads: true,
  });
  page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.addInitScript(
    (layout) => localStorage.setItem('room-studio-layout-v2', JSON.stringify(layout)),
    DEMO_LAYOUTS[0],
  );
  await page.goto(url);
  let serial = 0;
  const arm = async (expression) => {
    const key = `__studioSignal${serial++}`;
    await page.evaluate(`(() => {
      window[${JSON.stringify(key)}]=new Promise((resolveSignal,reject)=>{
        const observer=new MutationObserver(check);
        const timer=setTimeout(()=>{observer.disconnect();reject(new Error(${JSON.stringify(`State timeout: ${expression}`)}));},20000);
        function check(){if(${expression}){clearTimeout(timer);observer.disconnect();resolveSignal();}}
        observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});check();
      });
    })()`);
    return async () => {
      await page.evaluate((key) => window[key], key);
      await page.evaluate((key) => delete window[key], key);
    };
  };
  const change = async (expression, action) => {
    const done = await arm(expression);
    await action();
    await done();
  };
  // Drive canvas gestures directly; observe native delivery after the app handler.
  const mouse = async (type, x, y, modifiers = 0) => {
    if (type === 'mousePressed') {
      assert.equal(await page.evaluate(({ x, y }) =>
        document.elementFromPoint(x, y) === document.querySelector('[data-walkthrough-stage] canvas'),
      { x, y }), true, 'native gesture starts on the actual canvas');
    }
    const eventType = { mousePressed: 'pointerdown', mouseMoved: 'pointermove', mouseReleased: 'pointerup' }[type];
    const key = `__studioPointer${serial++}`;
    await page.evaluate(({ key, eventType, x, y }) => {
      const canvas = document.querySelector('[data-walkthrough-stage] canvas');
      window[key] = new Promise((resolveEvent, reject) => {
        const cleanup = () => { clearTimeout(timer); canvas.removeEventListener(eventType, receive); };
        const receive = event => {
          if (event.pointerType !== 'mouse' || Math.abs(event.clientX - x) > 1 || Math.abs(event.clientY - y) > 1) return;
          cleanup();
          resolveEvent();
        };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Native ${eventType} was not delivered`)); }, 20000);
        canvas.addEventListener(eventType, receive);
      });
    }, { key, eventType, x, y });
    await cdp.send('Input.dispatchMouseEvent', {
      type, x, y, modifiers, button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
    });
    await page.evaluate(async key => { await window[key]; delete window[key]; }, key);
  };
  const assetReady = `document.querySelector('[data-walkthrough]')?.dataset.assetState === 'ready'`;
  const studioReady = `document.querySelector('[data-walkthrough]')?.dataset.studioReady === 'true' && ${assetReady}`;
  const open = async (index = 0, legacy = false, ready = studioReady) => {
    await change(ready, () =>
      page.evaluate(
        async ({ index, legacy }) => {
          const { openWalkthrough } = await import('/src/walkthrough3d.js');
          const { DEMO_LAYOUTS, REGIONAL_DEMO_LAYOUTS } = await import('/src/demo-layouts.js');
          window.__layout = structuredClone((legacy ? DEMO_LAYOUTS : REGIONAL_DEMO_LAYOUTS)[index]);
          window.__history = [];
          window.__future = [];
          window.__actions = [];
          window.__close3d = openWalkthrough({
            ...window.__layout,
            initialMode: 'dollhouse',
            getLayout: () => window.__layout,
            onEdit(action) {
              window.__actions.push(structuredClone(action));
              window.__history.push(structuredClone(window.__layout));
              window.__future = [];
              if (action.type === 'add-item') window.__layout.items.push(action.item);
              if (action.type === 'update-item')
                window.__layout.items = window.__layout.items.map((item) =>
                  item.id === action.id ? { ...item, ...action.updates } : item,
                );
              if (action.type === 'update-zone') {
                const selected = window.__layout.zones.find((zone) => zone.id === action.id);
                window.__layout.zones = window.__layout.zones.map((zone) =>
                  (zone.spaceId ?? zone.id) === (selected.spaceId ?? selected.id)
                    ? { ...zone, ...action.updates }
                    : zone,
                );
              }
              return structuredClone(window.__layout);
            },
            onUndo() {
              if (window.__history.length) {
                window.__future.push(window.__layout);
                window.__layout = window.__history.pop();
              }
              return structuredClone(window.__layout);
            },
            onRedo() {
              if (window.__future.length) {
                window.__history.push(window.__layout);
                window.__layout = window.__future.pop();
              }
              return structuredClone(window.__layout);
            },
            historyState: () => ({
              canUndo: window.__history.length > 0,
              canRedo: window.__future.length > 0,
            }),
          });
        },
        { index, legacy },
      ),
    );
  };
  const paint = () =>
    page.evaluate(
      () =>
        new Promise((resolveFrame, reject) => {
          const timer = setTimeout(() => reject(new Error('Frame timeout')), 20000);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              clearTimeout(timer);
              resolveFrame();
            }),
          );
        }),
    );
  const capture = async (name) => {
    await paint();
    await page.screenshot({ path: join(output, `${name}.png`) });
    report.screenshots.push(`${name}.png`);
  };
  const tap = async (selector) => {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box, selector);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const apply = async () => {
    const count = await page.evaluate(() => window.__actions.length);
    await change(
      `window.__actions.length === ${count + 1} && !window.__scene().editSession.pending && ${assetReady}`,
      () => page.locator('[data-studio-apply]').click(),
    );
  };
  if (process.env.STUDIO_BASELINE) {
    await open(0, true);
    await capture('baseline-dollhouse');
    await page.locator('button[data-view-mode="top"]').click();
    await capture('baseline-top');
    await page.locator('button[data-view-mode="walk"]').click();
    await capture('baseline-walk');
    await page.locator('[data-walkthrough-exit]').first().click();
  } else {
    await open();
    const frameCounts = await page.evaluate(() => {
      const frames = [];
      window.__scene().scene.traverse(object => {
        if (object.isMesh && object.userData.doorFramePart) frames.push(object);
      });
      return {
        actual: frames.length,
        arrays: frames.filter(object => Array.isArray(object.material)).length,
        reported: Number(document.querySelector('[data-walkthrough]').dataset.visibleDoorFramePartCount),
      };
    });
    assert.ok(frameCounts.arrays > 0, 'the real scene has independently finished frame faces');
    assert.equal(frameCounts.reported, frameCounts.actual, 'visible frame telemetry includes material-array meshes');
    report.checks.push('visible frame telemetry counts real independently finished frame faces');
    const background = await page.locator('[data-walkthrough-stage]').boundingBox();
    const targetBeforeRelease = await page.evaluate(() => window.__scene().overviewOrbitTarget.toArray());
    await mouse('mousePressed', background.x + 20, background.y + 20, 8);
    await mouse('mouseReleased', background.x + 90, background.y + 40, 8);
    assert.notDeepEqual(
      await page.evaluate(() => window.__scene().overviewOrbitTarget.toArray()),
      targetBeforeRelease,
      'a native release consumes its final coordinates without an intermediate move event',
    );
    await page.locator('button[data-view-mode="dollhouse"]').click();
    report.checks.push('native release consumes final coordinates even without a dispatched move event');
    const cameraBeforeOrbit = await page.evaluate(() => window.__scene().camera.quaternion.toArray());
    await mouse('mousePressed', background.x + 20, background.y + 20);
    await mouse('mouseMoved', background.x + 120, background.y + 60);
    await mouse('mouseReleased', background.x + 120, background.y + 60);
    assert.notDeepEqual(
      await page.evaluate(() => window.__scene().camera.quaternion.toArray()),
      cameraBeforeOrbit,
    );
    const targetBeforePan = await page.evaluate(() => window.__scene().overviewOrbitTarget.toArray());
    await page.keyboard.down('Shift');
    await mouse('mousePressed', background.x + 20, background.y + 20, 8);
    await mouse('mouseMoved', background.x + 90, background.y + 40, 8);
    await mouse('mouseReleased', background.x + 90, background.y + 40, 8);
    await page.keyboard.up('Shift');
    assert.notDeepEqual(
      await page.evaluate(() => window.__scene().overviewOrbitTarget.toArray()),
      targetBeforePan,
    );
    const distanceBeforeZoom = await page.evaluate(() =>
      window.__scene().camera.position.distanceTo(window.__scene().overviewOrbitTarget),
    );
    await change(
      `window.__scene().camera.position.distanceTo(window.__scene().overviewOrbitTarget) < ${distanceBeforeZoom}`,
      () => cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: background.x + 90, y: background.y + 40, deltaX: 0, deltaY: -120 }),
    );
    assert.equal(await page.evaluate(() => window.__actions.length), 0);
    await capture('desktop-orbit-pan-zoom');
    report.checks.push(
      'native background orbit, Shift-pan and wheel zoom change camera without editing furniture',
    );
    await page.locator('button[data-view-mode="top"]').click();
    const sofa = await page.evaluate(() =>
      window.__layout.items.find((item) => item.assetId === 'seoul-sofa'),
    );
    await page.locator('[data-studio-tab="wall"]').click();
    assert.equal(await page.locator('[data-studio-tab="wall"]').getAttribute('aria-selected'), 'true');
    const point = await page.evaluate((id) => window.__scene().project(id), sofa.id);
    await mouse('mousePressed', point.x, point.y);
    await mouse('mouseReleased', point.x, point.y);
    assert.equal(
      await page.locator('.studio3d-shell').getAttribute('data-selection-id'),
      sofa.id,
      'ray selects actual GLB furniture',
    );
    assert.equal(await page.locator('[data-studio-tab="item"]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('[data-studio-palettes]').isVisible(), true);
    assert.equal(await page.locator('[data-studio-palettes] [data-studio-material="walnut"]').isEnabled(), true);
    await capture('wall-to-sofa-selection');
    report.checks.push('wall-to-sofa native selection reveals applicable furniture material controls');
    await page.locator('[data-studio-rotate]').click();
    assert.equal(await page.evaluate(() => window.__actions.length), 0);
    assert.equal(
      await page.evaluate((id) => window.__scene().items.find((item) => item.id === id).rotation, sofa.id),
      (sofa.rotation + 15) % 360,
    );
    await page.locator('[data-studio-cancel]').click();
    assert.equal(
      await page.evaluate((id) => window.__scene().items.find((item) => item.id === id).rotation, sofa.id),
      sofa.rotation,
    );
    await page.locator('[data-studio-rotate]').click();
    await apply();
    assert.equal(await page.evaluate(() => window.__history.length), 1);
    await page.locator('[data-studio-undo]').click();
    assert.equal(
      await page.evaluate((id) => window.__scene().items.find((item) => item.id === id).rotation, sofa.id),
      sofa.rotation,
    );
    await page.locator('[data-studio-redo]').click();
    assert.equal(
      await page.evaluate((id) => window.__scene().items.find((item) => item.id === id).rotation, sofa.id),
      (sofa.rotation + 15) % 360,
    );
    report.checks.push('ray selection; rotate preview/cancel; one history entry; undo/redo refresh renderer');
    const dragStart = await page.evaluate((id) => window.__scene().project(id), sofa.id);
    const count = await page.evaluate(() => window.__actions.length);
    await mouse('mousePressed', dragStart.x, dragStart.y);
    await mouse('mouseMoved', dragStart.x + 35, dragStart.y + 12);
    assert.equal(await page.evaluate(() => window.__actions.length), count);
    await mouse('mouseReleased', dragStart.x + 35, dragStart.y + 12);
    assert.equal(await page.evaluate(() => window.__actions.length), count + 1);
    const moved = await page.evaluate((id) => window.__layout.items.find((item) => item.id === id), sofa.id);
    assert.notEqual(moved.x, sofa.x);
    assert.deepEqual(
      await page.evaluate((id) => window.__scene().items.find((item) => item.id === id), sofa.id),
      moved,
    );
    const cancelStart = await page.evaluate((id) => window.__scene().project(id), sofa.id);
    await mouse('mousePressed', cancelStart.x, cancelStart.y);
    await mouse('mouseMoved', cancelStart.x + 25, cancelStart.y - 10);
    await page.keyboard.press('Escape');
    await mouse('mouseReleased', cancelStart.x + 25, cancelStart.y - 10);
    assert.deepEqual(
      await page.evaluate((id) => window.__scene().items.find((item) => item.id === id), sofa.id),
      moved,
    );
    assert.equal(await page.evaluate(() => window.__actions.length), count + 1);
    report.checks.push('direct drag commits on release; Escape cancels with no canonical write');
    await change(
      `${assetReady} && window.__scene().items.find(item=>item.id===${JSON.stringify(sofa.id)}).materialId==='walnut'`,
      () => page.locator('[data-studio-material="walnut"]').click(),
    );
    await capture('desktop-material-preview');
    await apply();
    await page.locator('[data-studio-replace]').check();
    await change(
      `${assetReady} && window.__scene().items.find(item=>item.id===${JSON.stringify(sofa.id)}).assetId==='seoul-dining-chair'`,
      () => page.locator('[data-studio-asset="seoul-dining-chair"]').click(),
    );
    await apply();
    assert.equal(
      await page.evaluate((id) => window.__scene().items.find((item) => item.id === id).width, sofa.id),
      52,
    );
    await page.locator('[data-studio-replace]').uncheck();
    const beforeAdd = await page.evaluate(() => window.__layout.items.length);
    await change(`${assetReady} && window.__scene().items.length===${beforeAdd + 1}`, () =>
      page.locator('[data-studio-asset="seoul-side-table"]').click(),
    );
    assert.equal(await page.evaluate(() => window.__layout.items.length), beforeAdd);
    await apply();
    assert.equal(await page.evaluate(() => window.__layout.items.length), beforeAdd + 1);
    report.checks.push('real GLB palette, replacement dimensions, add preview and commit');
    await page.locator('[data-studio-tab="floor"]').click();
    const zoneId = await page.locator('.studio3d-shell').getAttribute('data-selection-id');
    await change(
      `${assetReady} && window.__scene().zones.find(zone=>zone.id===${JSON.stringify(zoneId)}).floorMaterialId==='tile-slate'`,
      () => page.locator('[data-studio-material="tile-slate"]').click(),
    );
    await apply();
    await page.locator('[data-studio-tab="wall"]').click();
    await change(
      `${assetReady} && window.__scene().zones.find(zone=>zone.id===${JSON.stringify(zoneId)}).wallMaterialId==='plaster-chalk'`,
      () => page.locator('[data-studio-material="plaster-chalk"]').click(),
    );
    await apply();
    await capture('desktop-floor-wall-edits');
    report.checks.push('zone floor and independently owned wall PBR finishes commit');
    await page.locator('[data-walkthrough-more]').click();
    const download = page.waitForEvent('download');
    await page.locator('[data-save-snapshot]').click();
    await (await download).saveAs(join(output, 'edited-snapshot.png'));
    await page.keyboard.press('Escape');
    await page.locator('[data-walkthrough-exit]').first().click();
    assert.equal(await page.locator('[data-walkthrough]').count(), 0);
    assert.equal(await page.evaluate(() => window.__scene().destroyed), true);
    report.checks.push('PNG export; cleanup closes canvas and marks renderer destroyed');
    for (const width of [1440, 390])
      for (let index = 0; index < 3; index++) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width === 390, maxTouchPoints: 5 });
        await open(index);
        const counts = await page.evaluate(() => {
          let models = 0,
            meshes = 0,
            textures = 0;
          window.__scene().scene.traverse((object) => {
            if (object.userData.assetState === 'ready') models++;
            if (object.isMesh && object.userData.roomAssetOwned) {
              meshes++;
              if (object.material.map) textures++;
            }
          });
          return { models, meshes, textures };
        });
        assert.equal(counts.models, REGIONAL_DEMO_LAYOUTS[index].items.filter((item) => item.assetId).length);
        assert.ok(counts.textures > 0);
        if (width === 390) {
          assert.equal(await page.locator('[data-studio-toggle]').getAttribute('aria-expanded'), 'false');
          const stage = await page.locator('[data-walkthrough-stage]').boundingBox();
          assert.ok(stage.height > 450);
        }
        for (const mode of ['dollhouse', 'top', 'walk']) {
          await change(`document.querySelector('[data-walkthrough]').dataset.viewMode==='${mode}'`, () =>
            width === 390
              ? tap(`button[data-view-mode="${mode}"]`)
              : page.locator(`button[data-view-mode="${mode}"]`).click(),
          );
          await capture(`${width}-${index}-${mode}`);
          if (mode !== 'walk') {
            const points = await page.evaluate(() => window.__scene().projectedPoints());
            for (const axis of [0, 1]) {
              const minimum = Math.min(...points.map((point) => point[axis]));
              const maximum = Math.max(...points.map((point) => point[axis]));
              assert.ok(
                minimum >= -0.90001 && maximum <= 0.90001,
                JSON.stringify({ width, index, mode, axis, minimum, maximum }),
              );
              assert.ok(
                Math.abs(minimum + maximum) < 0.001,
                'visible envelope is centered, including open doors',
              );
            }
          }
          if (width === 390 && index === 0 && mode === 'top') {
            const item = await page.evaluate(() =>
              window.__layout.items.find((item) => item.assetId === 'seoul-sofa'),
            );
            const point = await page.evaluate((id) => window.__scene().project(id), item.id);
            const first = { ...point, id: 1 };
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
            await change('window.__scene().editSession.pending', () => cdp.send('Input.dispatchTouchEvent', {
              type: 'touchMove',
              touchPoints: [{ ...first, x: first.x + 20 }],
            }));
            assert.equal(await page.evaluate(() => window.__scene().editSession.pending), true);
            await change('!window.__scene().editSession.pending', () => cdp.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: [
                { ...first, x: first.x + 20 },
                { x: first.x - 50, y: first.y - 40, id: 2 },
              ],
            }));
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            assert.equal(await page.evaluate(() => window.__actions.length), 0);
            assert.deepEqual(
              await page.evaluate((id) => window.__scene().items.find((item) => item.id === id), item.id),
              item,
            );
            const distanceBeforePinch = await page.evaluate(() =>
              window.__scene().camera.position.distanceTo(window.__scene().overviewOrbitTarget),
            );
            const second = { x: first.x - 50, y: first.y - 40, id: 2 };
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second] });
            await change(`window.__scene().camera.position.distanceTo(window.__scene().overviewOrbitTarget) < ${distanceBeforePinch}`, () => cdp.send('Input.dispatchTouchEvent', {
              type: 'touchMove',
              touchPoints: [first, { ...second, x: second.x - 40 }],
            }));
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            assert.ok(
              (await page.evaluate(() =>
                window.__scene().camera.position.distanceTo(window.__scene().overviewOrbitTarget),
              )) < distanceBeforePinch,
            );
            assert.equal(await page.evaluate(() => window.__actions.length), 0);
            await capture('mobile-pinch-pan');
            await change('window.__scene().editSession.pending', () => tap('[data-studio-rotate]'));
            assert.equal(
              await page.evaluate(() => window.__scene().editSession.pending),
              true,
              'first native toolbar tap after drag activates',
            );
            await change('window.__actions.length === 1', () => tap('[data-studio-apply]'));
            assert.equal(await page.evaluate(() => window.__actions.length), 1);
            await change('window.__history.length === 0', () => tap('[data-studio-undo]'));
            await change(`document.querySelector('[data-studio-toggle]').getAttribute('aria-expanded') === 'true'`, () => tap('[data-studio-toggle]'));
            await capture('mobile-panel-expanded');
            const box = await page.locator('.studio3d-shell').boundingBox();
            assert.ok(box.height <= 844 * 0.48 + 1);
            for (const bounds of await page.locator('.studio3d-shell button').evaluateAll((buttons) =>
              buttons
                .filter((button) => button.getClientRects().length)
                .map((button) => ({
                  w: button.getBoundingClientRect().width,
                  h: button.getBoundingClientRect().height,
                })),
            ))
              assert.ok(bounds.w >= 44 && bounds.h >= 44, JSON.stringify(bounds));
            await tap('[data-studio-toggle]');
            report.checks.push(
              'native touch drag two-finger cancel; pinch zoom/pan; first toolbar tap; touch apply/undo; collapsed/expanded panel containment',
            );
          }
        }
        const actionCountBeforeWalk = await page.evaluate(() => window.__actions.length);
        const before = await page.locator('[data-map-player]').getAttribute('transform');
        await change(
          `document.querySelector('[data-map-player]').getAttribute('transform')!==${JSON.stringify(before)}`,
          () => page.keyboard.down('w'),
        );
        await page.keyboard.up('w');
        assert.equal(
          await page.evaluate(() => window.__actions.length),
          actionCountBeforeWalk,
          'walk keys cannot edit',
        );
        await page.locator('[data-walkthrough-exit]').first().click();
        report.checks.push(
          `${width}px sample ${index}: ${counts.models} loaded GLBs, ${counts.textures} textured meshes, three views and walk movement`,
        );
      }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await page.route('**/seoul-sofa.glb', (route) =>
      route.fulfill({ status: 503, body: 'Injected asset outage' }),
    );
    await open(
      0,
      false,
      `document.querySelector('[data-walkthrough]')?.dataset.assetState==='error' && document.querySelector('[data-walkthrough]')?.dataset.studioReady==='true'`,
    );
    assert.equal(await page.locator('[data-studio-retry]').isVisible(), true);
    assert.ok(await page.locator('[data-studio-load]').textContent());
    await capture('visible-model-error');
    await page.unroute('**/seoul-sofa.glb');
    await change(assetReady, () => page.locator('[data-studio-retry]').click());
    await capture('model-retry-ready');
    await page.locator('[data-walkthrough-exit]').first().click();
    report.checks.push('real failed GLB request is visibly error, retry loads actual model');

    // The actual parent entry uses main.js history and localStorage, not the harness callbacks.
    await change(studioReady, () => page.locator('#open-walkthrough').click());
    await page.locator('button[data-view-mode="top"]').click();
    const actualItem = await page.evaluate(() => window.__scene().items[0]);
    await page.locator('[data-studio-target]').selectOption(`item:${actualItem.id}`);
    const savedBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('room-studio-layout-v2')));
    await page.locator('[data-studio-rotate]').click();
    assert.deepEqual(
      await page.evaluate(() => JSON.parse(localStorage.getItem('room-studio-layout-v2'))),
      savedBefore,
    );
    await page.locator('[data-studio-apply]').click();
    assert.equal(
      await page.evaluate(
        (id) =>
          JSON.parse(localStorage.getItem('room-studio-layout-v2')).items.find((item) => item.id === id)
            .rotation,
        actualItem.id,
      ),
      (actualItem.rotation + 15) % 360,
    );
    assert.equal(await page.locator('#app').evaluate((app) => app.inert), true);
    assert.equal(await page.locator('[data-walkthrough]').count(), 1);
    await page.locator('[data-studio-undo]').click();
    assert.equal(
      await page.evaluate(
        (id) => window.__scene().items.find((item) => item.id === id).rotation,
        actualItem.id,
      ),
      actualItem.rotation,
    );
    await page.locator('[data-walkthrough-exit]').first().click();
    assert.equal(
      await page.locator('#open-walkthrough').evaluate((button) => document.activeElement === button),
      true,
    );
    await change(studioReady, () => page.locator('#open-walkthrough').click());
    assert.equal(
      await page.evaluate(
        (id) => window.__scene().items.find((item) => item.id === id).rotation,
        actualItem.id,
      ),
      actualItem.rotation,
    );
    await page.locator('[data-walkthrough-exit]').first().click();
    report.checks.push(
      'real main entry: preview does not save, commit persists, app remains inert, undo refreshes, close focus and reopen preserve state',
    );
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  if (page && !page.isClosed()) {
    report.failureDom = await page.evaluate(() => [...document.querySelectorAll('[data-walkthrough], .studio3d-shell, [data-studio-load], [data-studio-retry]')].map(node => ({
      tag: node.tagName, class: node.className, hidden: node.hidden, data: {...node.dataset}, text: node.matches('[data-studio-load], [data-studio-retry]') ? node.textContent : '',
      display: getComputedStyle(node).display, visibility: getComputedStyle(node).visibility, bounds: node.getBoundingClientRect().toJSON(),
    })));
    await page.screenshot({path: join(output, 'failure.png')});
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await writeFile(
    join(output, process.env.STUDIO_BASELINE ? 'baseline.json' : 'results.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
