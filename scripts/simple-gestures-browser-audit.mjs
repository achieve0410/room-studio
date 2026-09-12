import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'vite';
import { capture, evaluate, launchChrome, setViewport } from '../.omo/evidence/room-studio-improvements/browser-qa-lib.mjs';

const outputDirectory = resolve('.omx/artifacts/simple-gestures', new Date().toISOString().replaceAll(':', '-'));
await mkdir(outputDirectory, { recursive: true });
const receipt = { outputDirectory, scenarios: [], screenshots: [], errors: [] };
const fixture = {
  zones: [{ id: 'room', name: 'Gesture room', x: 0, y: 0, width: 600, depth: 500 }],
  items: [
    { id: 'chair', name: 'Touch chair', x: 260, y: 240, width: 200, depth: 180 },
    { id: 'locked', name: 'Locked cabinet', x: 460, y: 150, width: 100, depth: 80, locked: true },
  ],
  structures: [{ id: 'wall', type: 'wall', name: 'Wall', x: 100, y: 100, length: 140, thickness: 12, height: 240, orientation: 'horizontal' }],
  dimensions: [],
  wallHeight: 240,
};
let browser;
let server;
const bounded = (promise, label) => {
  let deadline;
  return Promise.race([
    promise,
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`${label} timed out`)), 15_000); }),
  ]).finally(() => clearTimeout(deadline));
};

try {
  const port = await new Promise((resolvePort, reject) => {
    const socket = createNetServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(() => resolvePort(port));
    });
  });
  server = await createServer({
    cacheDir: join(outputDirectory, 'vite-cache'),
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/.omx/**'] } },
    plugins: [{
      name: 'simple-gesture-audit-state',
      transform(source, id) {
        if (id.split('?')[0] !== resolve('src/main.js')) return;
        return `${source}
        const auditLongPressTimers = new Map();
        const auditNativeSetTimeout = window.setTimeout.bind(window);
        const auditNativeClearTimeout = window.clearTimeout.bind(window);
        let auditTimerId = -1;
        window.setTimeout = (callback, delay, ...args) => {
          if (callback !== beginLongPressDrag) return auditNativeSetTimeout(callback, delay, ...args);
          const id = auditTimerId--;
          auditLongPressTimers.set(id, () => callback(...args));
          return id;
        };
        window.clearTimeout = (id) => {
          if (!auditLongPressTimers.delete(id)) auditNativeClearTimeout(id);
        };
        window.__simpleGestureAudit = {
          reset(layout) {
            if (!applyProjectDocument({ projectName: 'Touch gesture audit', layout })) throw new Error('Fixture load rejected');
            starterDialogOpen = false;
            mobilePanel = 'canvas';
            pendingFocus = null;
            editorNotice = '';
            window.__simpleGestureEvents = [];
            render();
          },
          advanceLongPress() {
            const [id, callback] = auditLongPressTimers.entries().next().value;
            auditLongPressTimers.delete(id);
            callback();
          },
          snapshot() {
            return {
              mode: workspaceMode, renderedMode: document.querySelector('.workspace')?.dataset.mode,
              selectionBar: Boolean(document.querySelector('.simple-selection')),
              layout: layoutSnapshot(), selection: state.selection,
              keys: [...selectionKeys], history: historyPast.length, redo: historyFuture.length,
              gesture: gestureMode, contacts: activePointers.size, pressing: Boolean(entityPress),
              pendingLongPress: auditLongPressTimers.size,
              dragging: Boolean(drag), moved: Boolean(drag?.hasMoved), moveArmed: mobileMoveArmed,
              menu: mobileContextMenu, menuVisible: Boolean(document.querySelector('.mobile-context-menu')),
              focusedAction: document.activeElement?.dataset?.contextAction ?? null,
              viewBox: document.querySelector('#plan-canvas')?.getAttribute('viewBox'),
              storage: JSON.stringify(Object.fromEntries(Object.entries(localStorage).sort())),
            };
          },
        };
        window.__simpleGestureEvents = [];
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart', 'touchmove', 'touchend', 'mousedown', 'mouseup', 'click']) {
          document.addEventListener(type, event => {
            const target = event.target;
            const button = target.closest?.('button');
            window.__simpleGestureEvents.push({
              type, pointerId: event.pointerId, touches: event.touches?.length,
              clientX: event.clientX, clientY: event.clientY, timeStamp: event.timeStamp,
              target: target.id || target.tagName, trusted: event.isTrusted,
              button: button?.outerHTML, connectedAtDispatch: target.isConnected,
              final: () => ({
                defaultPrevented: event.defaultPrevented, connectedAfterDispatch: target.isConnected,
                disabled: button?.disabled, inert: Boolean(button?.closest('[inert]')),
                touchAction: getComputedStyle(target).touchAction,
              }),
            });
          }, { capture: true, passive: true });
        }`;
      },
    }],
  });
  await server.listen();
  receipt.url = server.resolvedUrls.local[0];
  browser = await launchChrome(process.env.CHROME_PATH ?? (
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'
  ));
  const { cdp } = browser;
  receipt.browser = await cdp.send('Browser.getVersion');
  cdp.listeners.set('Runtime.exceptionThrown', new Set([
    ({ exceptionDetails }) => receipt.errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text),
  ]));
  const page = (expression) => bounded(evaluate(cdp, expression), 'Page evaluation');
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  await setViewport(cdp, 390, 844);
  await bounded(browser.navigate(receipt.url), 'Application navigation');
  assert.equal(await page('window.__simpleGestureAudit.snapshot().mode'), 'simple', 'simple is the default workspace');
  receipt.clock = 'Only application long-press callbacks are controlled; native Chrome input and compositor clocks remain real';
  const snapshot = () => page('window.__simpleGestureAudit.snapshot()');
  const frame = () => page('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const reset = async (mode = 'simple', layout = fixture) => {
    await page(`window.__simpleGestureAudit.reset(${JSON.stringify(layout)})`);
    await frame();
    if ((await snapshot()).mode !== mode) await tap('[data-workspace-mode]');
    const result = await snapshot();
    assert.equal(result.mode, mode);
    assert.equal(result.renderedMode, mode);
    assert.equal(result.pendingLongPress, 0, 'reset cancels every pending long press');
    return result;
  };
  const screenshot = async (name) => {
    const path = join(outputDirectory, `${name}.png`);
    assert.equal((await snapshot()).contacts, 0, 'screenshots require all contacts to be released');
    await bounded(capture(cdp, path), 'Screenshot');
    receipt.screenshots.push(path);
  };
  const point = (selector) => page(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('Missing target: ' + ${JSON.stringify(selector)});
    const bounds = node.getBoundingClientRect();
    const fractions = [[0.5, 0.5], [0.75, 0.75], [0.25, 0.75], [0.75, 0.25], [0.25, 0.25]];
    const candidates = fractions.map(([x, y]) => ({ x: bounds.x + bounds.width * x, y: bounds.y + bounds.height * y }));
    const p = candidates.find(p => node.contains(document.elementFromPoint(p.x, p.y)));
    if (!p) throw new Error('Obscured target: ' + ${JSON.stringify(selector)});
    return p;
  })()`);
  const blank = () => page(`(() => {
    const bounds = document.querySelector('#plan-canvas').getBoundingClientRect();
    for (let y = bounds.top + 25; y < bounds.bottom - 50; y += 10) {
      for (let x = bounds.left + 25; x < bounds.right - 85; x += 10) {
        if (document.elementFromPoint(x, y)?.classList.contains('grid-background')) return { x, y };
      }
    }
    throw new Error('No exposed blank canvas');
  })()`);
  const arm = async (type) => {
    await page(`window.__gestureSignal = new Promise(resolve => {
      document.addEventListener(${JSON.stringify(type)}, event => resolve({
        type: event.type, pointerType: event.pointerType, pointerId: event.pointerId, trusted: event.isTrusted,
      }), { once: true, capture: true });
    }); true`);
  };
  let liveContacts = 0;
  const touch = async (type, points, eventType) => {
    await arm(eventType);
    const arrived = bounded(evaluate(cdp, 'window.__gestureSignal'), `${eventType} ${JSON.stringify(points)}`);
    await Promise.all([
      cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: points.map(([id, p]) => ({ id, ...p, radiusX: 2, radiusY: 2, force: 1 })),
      }).then(() => { liveContacts = type === 'touchEnd' && points.length ? liveContacts - points.length : points.length; }),
      arrived.then(event => {
        assert.equal(event.pointerType, 'touch');
        assert.equal(event.trusted, true, 'regression must use browser-generated pointers');
      }),
    ]);
    if (!liveContacts || !(await snapshot()).pressing) await frame();
    return snapshot();
  };
  const down = (p) => touch('touchStart', [[1, p]], 'pointerdown');
  const move = (p) => touch('touchMove', [[1, p]], 'pointermove');
  const up = () => touch('touchEnd', [], 'pointerup');
  const tap = async (selector, jitter = null) => {
    const isControl = await page(`document.querySelector(${JSON.stringify(selector)}).matches('button, summary, [role="button"], [role="tab"]')`);
    if (!isControl) {
      await down(await point(selector));
      return up();
    }
    const target = await point(selector);
    await page(`window.__controlClick = new Promise(resolve => {
      const finish = trusted => {
        document.removeEventListener('click', onClick, true);
        resolve(trusted);
      };
      const onClick = event => {
        if (event.composedPath().some(node => node instanceof Element && node.matches(${JSON.stringify(selector)}))) finish(event.isTrusted);
      };
      window.__cancelControlClick = () => finish(false);
      document.addEventListener('click', onClick, true);
    }); true`);
    const clicked = bounded(evaluate(cdp, 'window.__controlClick'), `Native click ${selector}`);
    // Native touch clicks can arrive after pointerup; await the actual activation.
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, ...target }] });
      liveContacts = 1;
      if (jitter) await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ id: 1, x: target.x + jitter.x, y: target.y + jitter.y }],
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      liveContacts = 0;
      assert.equal(await clicked, true, 'controls complete a real browser-generated click');
      await frame();
      return await snapshot();
    } finally {
      await page('window.__cancelControlClick(); delete window.__cancelControlClick; delete window.__controlClick');
    }
  };
  const unchanged = (after, before) => {
    assert.deepEqual(after.layout, before.layout, 'geometry is unchanged');
    assert.equal(after.history, before.history, 'history is unchanged');
    assert.equal(after.redo, before.redo, 'redo is unchanged');
    assert.equal(after.storage, before.storage, 'selection/preview never persists a geometry edit');
  };
  const rolledBack = (after, before) => {
    unchanged(after, before);
    assert.deepEqual(after.selection, before.selection, 'primary selection rolls back');
    assert.deepEqual(after.keys, before.keys, 'selection set rolls back');
    assert.equal(after.moveArmed, before.moveArmed, 'Move mode rolls back');
    assert.equal(after.dragging, false);
    assert.equal(after.pendingLongPress, before.pendingLongPress, 'canceled gesture does not leave a hold callback');
  };
  const scenario = async (name, run) => {
    try {
      const evidence = await run();
      await screenshot(name);
      receipt.scenarios.push({ name, pass: true, evidence, events: await page('window.__simpleGestureEvents.map(({ final, ...entry }) => ({ ...entry, ...final() }))') });
      console.log(`PASS ${name}`);
    } catch (error) {
      receipt.scenarios.push({ name, pass: false, error: error.stack, state: await snapshot(), events: await page('window.__simpleGestureEvents.map(({ final, ...entry }) => ({ ...entry, ...final() }))') });
      console.error(`FAIL ${name}: ${error.message}`);
      // End only this scenario's real contacts before capturing or loading another fixture.
      if (liveContacts) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        liveContacts = 0;
      }
      await screenshot(`${name}-failure`);
    }
  };

  await scenario('fresh-mobile-mode-toggle', async () => {
    const before = await reset();
    const advanced = await tap('[data-workspace-mode]');
    assert.equal(advanced.mode, 'advanced');
    const simple = await tap('[data-workspace-mode]');
    assert.equal(simple.mode, 'simple');
    return { before, advanced, simple };
  });

  await scenario('simple-tap-no-modal', async () => {
    const before = await reset();
    const after = await tap('[data-item-id="chair"]');
    unchanged(after, before);
    assert.deepEqual(after.selection, { kind: 'item', id: 'chair' });
    assert.equal(after.menu, null, 'simple tap must not set mobileContextMenu');
    assert.equal(after.menuVisible, false);
    assert.equal(after.selectionBar, true, 'actual simple UI renders its nonmodal selection action bar');
    const start = await point('[data-item-id="chair"]');
    await down(start);
    await move({ x: start.x + 3, y: start.y + 2 });
    const jitter = await up();
    unchanged(jitter, before);
    assert.equal(jitter.menu, null);
    return { before, after, jitter };
  });

  await scenario('simple-first-touch-drag-and-one-undo', async () => {
    const before = await reset();
    const start = await point('[data-item-id="chair"]');
    const pressed = await down(start);
    assert.equal(pressed.pressing, true);
    assert.equal(pressed.dragging, false);
    assert.equal(pressed.moveArmed, false);
    const preview = await move({ x: start.x + 48, y: start.y + 27 });
    assert.equal(preview.dragging, true, 'unselected furniture must drag on its first touch past slop');
    assert.equal(preview.moved, true);
    assert.notDeepEqual(preview.layout.items[0], before.layout.items[0]);
    assert.equal(preview.history, 0);
    assert.equal(preview.storage, before.storage);
    const committed = await up();
    assert.equal(committed.history, 1, 'one completed drag creates exactly one undo step');
    assert.equal(committed.menu, null);
    assert.notDeepEqual(committed.layout.items[0], before.layout.items[0]);
    await screenshot('simple-first-touch-drag-committed');
    await tap('#undo-action');
    const undone = await snapshot();
    assert.deepEqual(undone.layout, before.layout);
    assert.equal(undone.history, 0);
    assert.equal(undone.redo, 1);
    return { before, preview, committed, undone };
  });

  await scenario('simple-furniture-touch-over-selected-zone', async () => {
    const before = await reset();
    await tap('[data-zone-id="room"]');
    const selectedRoom = await snapshot();
    assert.deepEqual(selectedRoom.selection, { kind: 'zone', id: 'room' });
    assert.equal(selectedRoom.menu, null);
    const start = await point('[data-item-id="chair"]');
    await down(start);
    const preview = await move({ x: start.x + 42, y: start.y + 23 });
    assert.deepEqual(preview.layout.zones, before.layout.zones, 'touching furniture must not drag the selected room below it');
    assert.notDeepEqual(preview.layout.items[0], before.layout.items[0]);
    assert.deepEqual(preview.selection, { kind: 'item', id: 'chair' });
    const canceled = await touch('touchCancel', [], 'pointercancel');
    rolledBack(canceled, selectedRoom);
    return { selectedRoom, preview, canceled };
  });

  await scenario('simple-first-touch-overlapping-furniture', async () => {
    const layout = structuredClone(fixture);
    layout.items.unshift({ ...layout.items[0], id: 'underlay', name: 'Lower furniture', width: 240, depth: 220 });
    const before = await reset('simple', layout);
    const start = await point('[data-item-id="chair"]');
    await down(start);
    const preview = await move({ x: start.x + 42, y: start.y + 23 });
    assert.deepEqual(preview.selection, { kind: 'item', id: 'chair' });
    assert.deepEqual(preview.layout.items[0], before.layout.items[0], 'lower furniture stays put');
    assert.notDeepEqual(preview.layout.items[1], before.layout.items[1], 'touched foreground furniture moves without a picker');
    const canceled = await touch('touchCancel', [], 'pointercancel');
    rolledBack(canceled, before);
    return { before, preview, canceled };
  });

  await scenario('simple-pointer-cancel-rollback', async () => {
    const before = await reset();
    const start = await point('[data-item-id="chair"]');
    await down(start);
    const preview = await move({ x: start.x + 42, y: start.y + 23 });
    assert.equal(preview.moved, true);
    const canceled = await touch('touchCancel', [], 'pointercancel');
    rolledBack(canceled, before);
    assert.equal(canceled.gesture, 'idle');
    assert.equal(canceled.contacts, 0);
    return { before, preview, canceled };
  });

  await scenario('simple-pinch-rolls-back-edit', async () => {
    const before = await reset();
    const start = await point('[data-item-id="chair"]');
    const end = { x: start.x + 44, y: start.y + 25 };
    const second = await blank();
    await down(start);
    const preview = await move(end);
    assert.equal(preview.moved, true);
    const pinching = await touch('touchStart', [[1, end], [2, second]], 'pointerdown');
    rolledBack(pinching, before);
    assert.equal(pinching.gesture, 'pinch');
    const wider = { x: end.x + 24, y: end.y + 18 };
    const zoomed = await touch('touchMove', [[1, wider], [2, second]], 'pointermove');
    assert.notEqual(zoomed.viewBox, pinching.viewBox, 'pinch changes the viewport');
    // CDP touchEnd lists the contacts to release, not the contacts to keep.
    const releasedOne = await touch('touchEnd', [[2, second]], 'pointerup');
    assert.equal(releasedOne.gesture, 'idle-await-release');
    assert.equal(releasedOne.contacts, 1);
    const remaining = await move({ x: wider.x + 40, y: wider.y + 30 });
    assert.equal(remaining.viewBox, releasedOne.viewBox);
    rolledBack(remaining, before);
    const released = await up();
    assert.equal(released.gesture, 'idle');
    assert.equal(released.contacts, 0);
    return { before, preview, pinching, zoomed, released };
  });

  await scenario('simple-blank-pan-and-cancel', async () => {
    await reset();
    await tap('#zoom-out');
    await tap('#zoom-out');
    const before = await snapshot();
    const start = await blank();
    await down(start);
    const preview = await move({ x: start.x + 42, y: start.y + 27 });
    assert.equal(preview.gesture, 'pan');
    assert.notEqual(preview.viewBox, before.viewBox);
    const canceled = await touch('touchCancel', [], 'pointercancel');
    unchanged(canceled, before);
    assert.equal(canceled.gesture, 'idle');
    assert.equal(canceled.contacts, 0);
    return { before, preview, canceled };
  });

  await scenario('simple-blank-pinch-and-release', async () => {
    await reset();
    await tap('#zoom-out');
    await tap('#zoom-out');
    const before = await snapshot();
    const first = await blank();
    const second = { x: first.x + 100, y: first.y };
    assert.equal(await page(`document.elementFromPoint(${second.x}, ${second.y})?.classList.contains('grid-background')`), true);
    await down(first);
    const pinching = await touch('touchStart', [[1, first], [2, second]], 'pointerdown');
    assert.equal(pinching.gesture, 'pinch');
    const wider = { x: second.x + 60, y: second.y + 20 };
    const zoomed = await touch('touchMove', [[1, first], [2, wider]], 'pointermove');
    assert.notEqual(zoomed.viewBox, before.viewBox);
    const released = await touch('touchEnd', [], 'pointerup');
    rolledBack(released, before);
    assert.equal(released.gesture, 'idle');
    assert.equal(released.contacts, 0);
    return { before, pinching, zoomed, released };
  });

  await scenario('simple-locked-and-deliberate-structure-movement', async () => {
    const before = await reset();
    const locked = await tap('[data-item-id="locked"]');
    unchanged(locked, before);
    assert.deepEqual(locked.selection, { kind: 'item', id: 'locked' });
    assert.equal(locked.menu, null);
    for (const selector of ['[data-structure-id="wall"]', '[data-zone-id="room"]']) {
      const origin = await reset();
      const start = await point(selector);
      await down(start);
      await move({ x: start.x + 36, y: start.y + 25 });
      const after = await up();
      unchanged(after, origin);
      assert.equal(after.selection, null, 'unselected zones and walls retain deliberate movement');
    }
    return { before, locked, after: await snapshot() };
  });

  await scenario('advanced-legacy-tap-and-drag', async () => {
    const before = await reset('advanced');
    const start = await point('[data-item-id="chair"]');
    await down(start);
    await move({ x: start.x + 44, y: start.y + 25 });
    const quickSwipe = await up();
    unchanged(quickSwipe, before);
    assert.equal(quickSwipe.selection, null, 'advanced unselected quick swipe remains non-editing');
    const tapped = await tap('[data-item-id="chair"]');
    unchanged(tapped, before);
    assert.deepEqual(tapped.selection, { kind: 'item', id: 'chair' });
    assert.deepEqual(tapped.menu, { kind: 'item', id: 'chair' });
    assert.equal(tapped.menuVisible, true);
    assert.equal(tapped.focusedAction, 'move');
    await screenshot('advanced-legacy-action-menu');
    await tap('[data-context-close]');
    const selectedStart = await point('[data-item-id="chair"]');
    await down(selectedStart);
    const selectedPreview = await move({ x: selectedStart.x + 40, y: selectedStart.y + 22 });
    assert.equal(selectedPreview.moved, true, 'advanced selected direct drag remains available');
    const committed = await up();
    assert.equal(committed.history, 1);
    return { before, quickSwipe, tapped, selectedPreview, committed };
  });

  await scenario('advanced-long-press-retains-real-handler', async () => {
    const before = await reset('advanced');
    const start = await point('[data-item-id="chair"]');
    const pressed = await down(start);
    assert.equal(pressed.pendingLongPress, 1);
    assert.equal(pressed.dragging, false);
    await page('window.__simpleGestureAudit.advanceLongPress()');
    const held = await snapshot();
    assert.equal(held.dragging, true, 'advancing the hold runs the original gesture handler');
    assert.equal(held.pendingLongPress, 0);
    await move({ x: start.x + 40, y: start.y + 22 });
    const committed = await up();
    assert.equal(committed.history, 1);
    assert.notDeepEqual(committed.layout.items[0], before.layout.items[0]);
    return { before, pressed, held, committed };
  });

  await scenario('simple-touch-structure-rotation-and-undo', async () => {
    const before = await reset();
    await tap('[data-structure-id="wall"]');
    await tap('[data-simple-action="size"]');
    const rotated = await tap('[data-structure-rotate="wall"]');
    assert.equal(rotated.layout.structures[0].orientation, 'vertical');
    assert.equal(rotated.history, 1);
    const jittered = await tap('[data-structure-rotate="wall"]', { x: 3, y: 2 });
    assert.equal(jittered.layout.structures[0].orientation, 'horizontal', 'small finger jitter remains a button tap');
    assert.equal(jittered.history, 2);
    const firstUndo = await tap('#undo-action');
    assert.deepEqual(firstUndo.layout, rotated.layout);
    const undone = await tap('#undo-action');
    assert.deepEqual(undone.layout, before.layout);
    assert.equal(undone.history, 0);
    return { before, rotated, jittered, firstUndo, undone };
  });

  await scenario('simple-small-selected-furniture-remains-draggable', async () => {
    await setViewport(cdp, 320, 568);
    const before = await reset('simple', {
      ...fixture,
      zones: [{ ...fixture.zones[0], width: 400, depth: 300 }],
      items: [{ ...fixture.items[0], x: 200, y: 150, width: 100, depth: 70 }],
      structures: [],
    });
    await tap('[data-item-id="chair"]');
    const start = await point('[data-item-id="chair"]');
    await down(start);
    const preview = await move({ x: start.x + 30, y: start.y + 15 });
    assert.equal(preview.dragging, true, 'small selected furniture exposes its body instead of overlapping resize handles');
    const committed = await up();
    assert.equal(committed.layout.items[0].width, 100);
    assert.equal(committed.layout.items[0].depth, 70);
    assert.notEqual(committed.layout.items[0].x, before.layout.items[0].x);
    await tap('[data-simple-action="size"]');
    assert.equal(await page('!!document.querySelector("[data-resize-handle]")'), true, 'size action explicitly reveals resize handles');
    return { before, preview, committed };
  });

  await scenario('simple-wide-touch-tap-and-first-drag', async () => {
    await setViewport(cdp, 1100, 900);
    const before = await reset();
    const tapped = await tap('[data-item-id="chair"]');
    unchanged(tapped, before);
    assert.equal(tapped.menu, null);
    assert.equal(tapped.selectionBar, true);
    await tap('[data-simple-action="clear"]');
    const unselected = await snapshot();
    assert.equal(unselected.selection, null);
    const start = await point('[data-item-id="chair"]');
    const pressed = await down(start);
    assert.equal(pressed.pressing, true, 'wide touch uses the same slop-aware press path');
    assert.equal(pressed.dragging, false);
    await move({ x: start.x + 48, y: start.y + 27 });
    const committed = await up();
    assert.notDeepEqual(committed.layout.items[0], before.layout.items[0]);
    assert.equal(committed.history, 1);
    assert.equal(committed.menu, null);
    return { before, tapped, committed };
  });

  assert.deepEqual(receipt.errors, [], 'no browser exceptions');
  assert.ok(receipt.scenarios.every(({ pass }) => pass), 'all gesture scenarios must pass');
  receipt.pass = true;
} catch (error) {
  receipt.pass = false;
  receipt.failure = error.stack;
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  try { await browser?.close(); } catch (error) { cleanupErrors.push(error.stack); }
  try { await server?.close(); } catch (error) { cleanupErrors.push(error.stack); }
  receipt.cleanup = cleanupErrors.length ? cleanupErrors : 'Owned Chrome, disposable profile, and dynamic-port Vite server closed';
  if (cleanupErrors.length) { receipt.pass = false; process.exitCode = 1; }
  await writeFile(join(outputDirectory, 'results.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`Simple gesture browser audit artifacts: ${outputDirectory}`);
}
process.exit(process.exitCode ?? 0);
