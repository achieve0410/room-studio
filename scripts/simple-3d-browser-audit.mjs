import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection, createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { DEMO_LAYOUTS } from '../src/demo-layouts.js';
import { capture, evaluate, launchChrome } from '../.omo/evidence/room-studio-improvements/browser-qa-lib.mjs';

const output = resolve(process.env.SIMPLE_3D_OUTPUT ?? join('.omx/artifacts/simple-3d', new Date().toISOString().replaceAll(':', '-')));
const touchFollowupOnly = process.argv.includes('--touch-followup-only');
await mkdir(join(output, 'downloads'), { recursive: true });
const receipt = { output, surface: 'real editor entry; QA-profile touch regression and production-profile scene matrix', viewports: [], screenshots: [], errors: [] };
const bounded = (promise, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), 20_000);
  })]).finally(() => clearTimeout(timer));
};
let server;
let browser;
let chromeProcess;
let profile;
let serverPort;
let chromePort;
let sequence = 0;

try {
  serverPort = await new Promise((resolvePort, reject) => {
    const reservation = createNetServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const { port } = reservation.address();
      reservation.close(() => resolvePort(port));
    });
  });
  server = await createServer({
    cacheDir: join(output, 'vite-cache'),
    server: { host: '127.0.0.1', port: serverPort, strictPort: true, hmr: false, watch: { ignored: ['**/.omx/**'] } },
    plugins: [{
      name: 'simple-3d-read-only-observations',
      transform(source, id) {
        if (id.split('?')[0] !== resolve('src/walkthrough3d.js')) return;
        const anchor = "  overlay.dataset.walkthroughReady = 'true';";
        assert.equal(source.split(anchor).length, 2, 'one audit instrumentation point');
        return source.replace(anchor, `
  // Audit-only getters and disposal event subscriptions; no simulation/render replacements.
  const auditResources = { geometry: new Set(), material: new Set(), texture: new Set() };
  const auditDisposed = { geometry: new Set(), material: new Set(), texture: new Set() };
  scene.traverse(object => {
    if (object.geometry) auditResources.geometry.add(object.geometry);
    for (const entry of [object.material].flat().filter(Boolean)) {
      auditResources.material.add(entry);
      if (entry.map) auditResources.texture.add(entry.map);
    }
  });
  for (const kind of Object.keys(auditResources)) {
    for (const resource of auditResources[kind]) resource.addEventListener('dispose', () => auditDisposed[kind].add(resource));
  }
  window.__simple3dAudit = () => {
    const bounds = overviewSpatialBounds(scene);
    const corners = [];
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      corners.push(new THREE.Vector3(x, y, z).project(camera).toArray());
    }
    return {
      destroyed, connected: overlay.isConnected, navigationActive, viewMode, ceilingsVisible, keys: [...keys],
      ceilingVisibility: ceilingObjects.map(object => object.visible),
      target: overviewTarget, selectedTarget: selectedFocusTarget,
      bounds: [bounds.min.toArray(), bounds.max.toArray()], corners,
      camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), projection: camera.projectionMatrix.toArray(), aspect: camera.aspect },
      structure: sceneStructures, walls: interiorWalls, leaves: doorLeafSegments,
      resources: Object.fromEntries(Object.keys(auditResources).map(kind => [kind, { total: auditResources[kind].size, disposed: auditDisposed[kind].size }])),
      renderer: { pixelRatio: renderer.getPixelRatio(), shadows: renderer.shadowMap.enabled },
    };
  };
${anchor}`);
      },
    }],
  });
  await server.listen();
  receipt.url = `http://127.0.0.1:${serverPort}`;
  browser = await launchChrome(process.env.CHROME_PATH ?? (
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'
  ));
  const { cdp } = browser;
  chromePort = Number(new URL(cdp.socket.url).port);
  // The existing launcher owns its child/profile. Record the same owned child for independent cleanup checks.
  const children = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n');
  const child = children.find(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match && Number(match[2]) === process.pid && match[3].includes('--remote-debugging-port=0');
  });
  assert.ok(child, 'owned Chrome child is identifiable');
  chromeProcess = Number(child.trim().split(/\s+/)[0]);
  profile = child.match(/--user-data-dir=(\S+)/)[1];
  receipt.chrome = { ...(await cdp.send('Browser.getVersion')), pid: chromeProcess, profile, port: chromePort };
  const page = expression => bounded(evaluate(cdp, expression), `Page evaluation: ${expression.slice(0, 120)}`);
  cdp.listeners.set('Runtime.exceptionThrown', new Set([event => receipt.errors.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text)]));
  cdp.listeners.set('Runtime.consoleAPICalled', new Set([event => {
    if (event.type === 'error') receipt.errors.push(event.args.map(arg => arg.value ?? arg.description).join(' '));
  }]));
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: join(output, 'downloads'), eventsEnabled: true });
  const seed = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('room-studio-layout-v2', ${JSON.stringify(JSON.stringify(DEMO_LAYOUTS[0]))});` });

  // Arm the exact state observer before input; separate installation from awaiting its promise.
  const armState = async (expression, label, events = []) => {
    const id = `__simple3dSignal${sequence++}`;
    await page(`(() => {
      window[${JSON.stringify(id)}] = new Promise((resolveSignal, reject) => {
        const check = () => { if (${expression}) { finish(); resolveSignal(true); } };
        const observer = new MutationObserver(check);
        const finish = () => { clearTimeout(timer); observer.disconnect(); for (const type of ${JSON.stringify(events)}) document.removeEventListener(type, check, true); };
        const timer = setTimeout(() => { finish(); reject(new Error(${JSON.stringify(`${label} state timeout`)})); }, 15000);
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        for (const type of ${JSON.stringify(events)}) document.addEventListener(type, check, true);
        check();
      });
      window[${JSON.stringify(id)}].catch(() => {});
    })()`);
    return async () => {
      await page(`window[${JSON.stringify(id)}]`);
      await page(`delete window[${JSON.stringify(id)}]`);
    };
  };
  const paint = () => page(`new Promise((resolveFrame, reject) => {
    const timer = setTimeout(() => reject(new Error('Paint timeout')), 15000);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolveFrame(); }));
  })`);
  const settled = async () => {
    await paint();
    // The room toast owns a delayed dismissal; observe that exact class change, not a guessed delay.
    const toastDismissed = await armState(`!document.querySelector('[data-room-toast]')?.classList.contains('is-visible')`, 'room toast dismissed');
    await toastDismissed();
    await page(`Promise.all(document.getAnimations().filter(animation => {
      const target = animation.effect?.target;
      return target?.closest('[data-walkthrough]') && animation.effect.getComputedTiming().iterations !== Infinity;
    }).map(animation => animation.finished))`);
    await paint();
  };
  let touch = false;
  const pointFor = selector => page(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) throw new Error('Missing target: ' + ${JSON.stringify(selector)});
    const rect = target.getBoundingClientRect();
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    if (!rect.width || !rect.height || !target.contains(document.elementFromPoint(point.x, point.y))) throw new Error('Obscured target: ' + ${JSON.stringify(selector)});
    return point;
  })()`);
  const click = async selector => {
    const point = await pointFor(selector);
    const id = `__simple3dClick${sequence++}`;
    receipt.lastAction = selector;
    // The editor replaces selected SVG nodes on pointerup, before a click can reach the old node.
    await page(`window[${JSON.stringify(id)}] = new Promise(resolveClick => document.addEventListener('pointerup', event => resolveClick(event.isTrusted), { once: true, capture: true })); true`);
    if (touch) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    }
    assert.equal(await page(`window[${JSON.stringify(id)}]`), true, 'real browser-generated pointer release');
    await page(`delete window[${JSON.stringify(id)}]`);
  };
  const key = async (keyName, code, keyCode, modifiers = 0) => {
    const text = keyName === 'Enter' ? '\r' : keyName === ' ' ? ' ' : undefined;
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', {
      type, key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers,
      ...(type === 'keyDown' && text ? { text, unmodifiedText: text } : {}),
    });
  };
  const snapshot = () => page('window.__simple3dAudit()');
  const screenshot = async name => {
    await settled();
    const path = join(output, `${name}.png`);
    await bounded(capture(cdp, path), 'Screenshot');
    receipt.screenshots.push(path);
  };
  const rects = () => page(`(() => {
    const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const panel = document.querySelector('[data-walkthrough-more-panel]');
    return {
      stage: rect(document.querySelector('[data-walkthrough-stage]')),
      toolbar: rect(document.querySelector('.walkthrough-view-tools')),
      location: rect(document.querySelector('.walkthrough-location')),
      panel: panel && !panel.hidden ? rect(panel) : null,
      controls: [...document.querySelectorAll('.walkthrough-view-tools button, .walkthrough-exit')].filter(node => node.getClientRects().length).map(node => ({ ...rect(node), disabled: node.disabled, hit: node.contains(document.elementFromPoint(rect(node).x + rect(node).width / 2, rect(node).y + rect(node).height / 2)), selector: [...node.attributes].find(a => a.name.startsWith('data-'))?.name })),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  })()`);
  const noOverlap = (a, b) => a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y;
  const checkControls = (geometry, width, height, count) => {
    assert.equal(geometry.overflow, false);
    assert.equal(geometry.controls.length, count, 'only disclosed controls are rendered');
    for (const control of geometry.controls) {
      assert.ok(control.width >= 44 && control.height >= 44, `44px target: ${JSON.stringify(control)}`);
      assert.ok(control.x >= 0 && control.y >= 0 && control.right <= width && control.bottom <= height, `onscreen: ${JSON.stringify(control)}`);
      assert.ok(control.hit, `reachable: ${JSON.stringify(control)}`);
    }
    for (const [index, control] of geometry.controls.entries()) for (const other of geometry.controls.slice(index + 1)) assert.ok(noOverlap(control, other), 'controls do not overlap');
    assert.ok(noOverlap(geometry.location, geometry.toolbar), 'location does not overlap toolbar');
    if (geometry.panel) assert.ok(noOverlap(geometry.panel, geometry.toolbar), 'panel is below its own trigger and view modes');
  };
  const checkFit = state => {
    for (const [x, y, z] of state.corners) assert.ok(Math.abs(x) <= 0.900001 && Math.abs(y) <= 0.900001 && z >= -1 && z <= 1, `actual scene framing: ${[x, y, z]}`);
  };
  const setMode = async mode => {
    const done = await armState(`document.querySelector('[data-walkthrough]')?.dataset.viewMode === ${JSON.stringify(mode)}`, `${mode} mode`);
    await click(`button[data-view-mode="${mode}"]`);
    await done();
    await paint();
    assert.equal(await page(`document.querySelector('button[data-view-mode="${mode}"]').getAttribute('aria-pressed')`), 'true');
  };
  const openMore = async (keyboard = false) => {
    const done = await armState(`document.querySelector('[data-walkthrough-more]')?.getAttribute('aria-expanded') === 'true'`, 'More open');
    if (keyboard) await key('Enter', 'Enter', 13);
    else await click('[data-walkthrough-more]');
    await done();
    assert.equal(await page(`document.getElementById(document.querySelector('[data-walkthrough-more]').getAttribute('aria-controls')) === document.querySelector('[data-walkthrough-more-panel]')`), true);
    assert.equal(await page(`document.querySelector('[data-walkthrough-more-panel]').hidden`), false);
  };
  const closeMore = async () => {
    const done = await armState(`document.querySelector('[data-walkthrough-more]')?.getAttribute('aria-expanded') === 'false' && document.activeElement === document.querySelector('[data-walkthrough-more]')`, 'More Escape close', ['focusin']);
    const before = await snapshot();
    await key('Escape', 'Escape', 27);
    await done();
    assert.equal(await page(`document.querySelector('[data-walkthrough-more-panel]').hidden`), true);
    assert.equal(await page(`document.querySelector('[data-walkthrough-menu]').hidden`), true, 'Escape dismisses More, not the 3D mode');
    const after = await snapshot();
    assert.equal(after.navigationActive, before.navigationActive, 'Escape does not pause walking');
    assert.equal(after.viewMode, before.viewMode);
  };
  const download = async name => {
    const cameraBefore = (await snapshot()).camera;
    const before = await page(`document.querySelector('[data-walkthrough-canvas]').toDataURL('image/png')`);
    const began = bounded(cdp.once('Browser.downloadWillBegin'), 'PNG download begins');
    const completed = new Promise(resolveDownload => {
      const listener = event => {
        if (event.state === 'completed' || event.state === 'canceled') {
          cdp.listeners.get('Browser.downloadProgress').delete(listener);
          resolveDownload(event);
        }
      };
      const listeners = cdp.listeners.get('Browser.downloadProgress') ?? new Set();
      listeners.add(listener);
      cdp.listeners.set('Browser.downloadProgress', listeners);
    });
    const saved = await armState(`document.querySelector('[data-walkthrough]')?.dataset.lastSnapshot === 'png'`, 'PNG saved');
    await click('[data-save-snapshot]');
    const [start, end] = await Promise.all([began, bounded(completed, 'PNG completed'), saved()]);
    assert.equal(end.state, 'completed');
    assert.equal(end.guid, start.guid);
    assert.match(start.suggestedFilename, /^room-studio-3d-.*\.png$/);
    const bytes = await readFile(join(output, 'downloads', end.guid));
    const expected = Buffer.from(before.split(',')[1], 'base64');
    assert.deepEqual(bytes, expected, 'download is the actual unchanged framed canvas');
    assert.deepEqual((await snapshot()).camera, cameraBefore, 'PNG preserves the camera');
    const path = join(output, `${name}-download.png`);
    await writeFile(path, bytes);
    return { path, bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: createHash('sha256').update(bytes).digest('hex') };
  };

  // A small real room keeps software rendering from waiting out Linux fling suppression.
  // This uses the editor entry and the existing QA render profile, without replacing rendering.
  // The full scene production-profile matrix follows independently.
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: true });
  await bounded(browser.navigate(receipt.url), 'Touch fixture editor navigation');
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seed.identifier });
  const touchLayout = {
    wallHeight: 240,
    zones: [{ id: 'touch-room', name: 'Touch room', type: '방', x: 0, y: 0, width: 400, depth: 400, height: 240, color: '#c9b8a6' }],
    items: [{ id: 'touch-table', name: 'Table', type: 'table', shape: 'roundRect', x: 200, y: 200, width: 120, depth: 70, height: 74, color: '#b78d65', rotation: 0, elevation: 0 }],
    structures: [],
  };
  await page(`localStorage.setItem('room-studio-layout-v2', ${JSON.stringify(JSON.stringify(touchLayout))})`);
  await bounded(browser.navigate(receipt.url), 'Touch fixture loaded');
  await page('window.__roomStudioQaRenderProfile = true');
  touch = true;
  await page(`document.querySelector('#open-walkthrough').scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await paint();
  const touchReady = await armState(`document.querySelector('[data-walkthrough-ready="true"]')`, 'touch 3D ready');
  await click('#open-walkthrough');
  await touchReady();
  await setMode('walk');
  await screenshot('touch-before-look');
  const touchBefore = await snapshot();
  assert.equal(touchBefore.renderer.pixelRatio, 0.5);
  assert.equal(touchBefore.renderer.shadows, false);
  const morePoint = await pointFor('[data-walkthrough-more]');
  const lookPoint = await page(`(() => {
    const canvas = document.querySelector('[data-walkthrough-canvas]');
    const rect = canvas.getBoundingClientRect();
    const point = { x: rect.x + rect.width * .65, y: rect.y + rect.height * .48 };
    for (const x of [point.x, point.x + 48]) if (document.elementFromPoint(x, point.y) !== canvas) throw new Error('Touch look is obscured');
    return point;
  })()`);
  const cameraChanged = await armState(`window.__simple3dAudit().camera.quaternion.some((value, index) => Math.abs(value - ${JSON.stringify(touchBefore.camera.quaternion)}[index]) > .001)`, 'touch changes actual camera');
  const moreOpened = await armState(`document.querySelector('[data-walkthrough-more]').getAttribute('aria-expanded') === 'true'`, 'first post-look More tap');
  await page(`(() => {
    const canvas = document.querySelector('[data-walkthrough-canvas]');
    const more = document.querySelector('[data-walkthrough-more]');
    window.__touchLookEvents = [];
    const record = event => {
      if (event.target !== canvas && !more.contains(event.target)) return;
      window.__touchLookEvents.push({ type: event.type, target: event.target === canvas ? 'canvas' : 'more',
        trusted: event.isTrusted, pointerType: event.pointerType, time: event.timeStamp, cancelable: event.cancelable,
        defaultPrevented: event.defaultPrevented, touches: event.touches?.length });
    };
    const types = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart', 'touchmove', 'touchend', 'click'];
    for (const type of types) document.addEventListener(type, record);
    window.__stopTouchLookEvents = () => { for (const type of types) document.removeEventListener(type, record); };
    window.__touchMoreClick = new Promise((resolveClick, reject) => {
      let timer;
      const finish = () => { clearTimeout(timer); more.removeEventListener('pointerdown', started); more.removeEventListener('click', clicked); };
      const clicked = event => { finish(); resolveClick({ trusted: event.isTrusted, pointerType: event.pointerType }); };
      // The deadline measures this tap, not tracing setup or the preceding camera gesture.
      const started = () => { timer = setTimeout(() => { finish(); reject(new Error('First native post-look toolbar click missing')); }, 1500); };
      more.addEventListener('pointerdown', started, { once: true });
      more.addEventListener('click', clicked);
    });
    window.__touchMoreClick.catch(() => {});
  })()`);
  const trace = [];
  const traceListener = ({ value }) => trace.push(...value);
  cdp.listeners.set('Tracing.dataCollected', new Set([traceListener]));
  await cdp.send('Tracing.start', { categories: 'input,latencyInfo,devtools.timeline,benchmark,disabled-by-default-input', transferMode: 'ReportEvents' });
  receipt.touchFollowup = { viewport: [320, 568], profile: 'QA input isolation, real rendering', layout: touchLayout, before: touchBefore };
  try {
    // Precompute coordinates and arm every signal BEFORE the swipe. No evaluations,
    // rendering waits, screenshots or activation retries between release and first tap.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...lookPoint, id: 1 }] });
    for (const step of [1, 2, 3]) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: lookPoint.x + step * 16, y: lookPoint.y + step * 9, id: 1 }] });
    }
    // Queue in protocol order without waiting for a slow render-thread ACK between contacts.
    await Promise.all([
      cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
      cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...morePoint, id: 1 }] }),
      cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
    ]);
    const clicked = await page('window.__touchMoreClick');
    assert.equal(clicked.trusted, true, 'first toolbar activation is a trusted click');
    assert.equal(clicked.pointerType, 'touch');
    await moreOpened();
    await cameraChanged();
  } finally {
    receipt.touchFollowup.after = await snapshot();
    receipt.touchFollowup.events = await page('window.__stopTouchLookEvents(); window.__touchLookEvents');
    const events = receipt.touchFollowup.events;
    receipt.touchFollowup.releaseToTapMs = events.find(event => event.target === 'more' && event.type === 'pointerdown')?.time
      - events.find(event => event.target === 'canvas' && event.type === 'touchend')?.time;
    const complete = bounded(cdp.once('Tracing.tracingComplete'), 'touch trace complete');
    await cdp.send('Tracing.end');
    await complete;
    cdp.listeners.get('Tracing.dataCollected').delete(traceListener);
    receipt.touchFollowup.trace = join(output, 'touch-look-trace.json');
    await writeFile(receipt.touchFollowup.trace, JSON.stringify({ traceEvents: trace }));
    receipt.touchFollowup.flingStarts = trace.filter(event => event.name === 'FlingBooster::GetVelocityForFlingStart').length;
    receipt.touchFollowup.tapSuppressions = trace.filter(event => event.name === 'FilterTapSuppression').length;
    await screenshot('touch-after-look-first-tap');
  }
  const touchEvents = receipt.touchFollowup.events;
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'touchend']) {
    assert.ok(touchEvents.some(event => event.target === 'canvas' && event.type === type && event.trusted), `genuine canvas ${type}`);
  }
  assert.equal(touchEvents.some(event => event.type === 'pointercancel'), false);
  assert.equal(touchEvents.filter(event => event.target === 'more' && event.type === 'pointerdown').length, 1, 'one toolbar tap, not a retry');
  assert.equal(touchEvents.filter(event => event.target === 'more' && event.type === 'click' && event.trusted).length, 1);
  assert.ok(receipt.touchFollowup.releaseToTapMs >= 0 && receipt.touchFollowup.releaseToTapMs < 180, 'tap must not wait out native fling suppression');
  assert.notDeepEqual(receipt.touchFollowup.after.camera.quaternion, touchBefore.camera.quaternion, 'real camera rotated');
  assert.equal(receipt.touchFollowup.after.viewMode, 'walk');
  assert.equal(receipt.touchFollowup.after.navigationActive, true);
  assert.equal(await page(`document.querySelector('[data-walkthrough-more-panel]').hidden`), false);
  await closeMore();
  const touchExited = await armState(`!document.querySelector('[data-walkthrough]')`, 'touch fixture closed');
  await click('.walkthrough-exit');
  await touchExited();
  const touchCleanup = await snapshot();
  assert.equal(touchCleanup.destroyed, true);
  for (const counts of Object.values(touchCleanup.resources)) assert.equal(counts.disposed, counts.total);
  receipt.touchFollowup.cleanup = touchCleanup.resources;

  // Exercise the actual raycast/pointerup contract, including its persisted editor callback.
  receipt.openingActivations = [];
  for (const kind of ['door', 'window']) {
    const layout = {
      ...touchLayout, items: [],
      structures: [
        { id: 'wall', type: 'wall', x: 200, y: 200, length: 400, height: 240, thickness: 6, orientation: 'vertical' },
        { id: kind, type: kind, wallId: 'wall', x: 200, y: 200, width: 90, height: kind === 'door' ? 205 : 120,
          sillHeight: 90, orientation: 'vertical', doorType: 'swing', hinge: 'start', openSide: -1, openAngle: 0, openRatio: 0, slideDirection: 'end' },
      ],
    };
    await page(`localStorage.setItem('room-studio-layout-v2', ${JSON.stringify(JSON.stringify(layout))})`);
    await bounded(browser.navigate(receipt.url), `${kind} editor fixture`);
    await page(`window.__roomStudioQaRenderProfile = true; document.querySelector('#open-walkthrough').scrollIntoView({ block: 'center', behavior: 'instant' })`);
    await paint();
    const ready = await armState(`document.querySelector('[data-walkthrough-ready="true"]')`, `${kind} ready`);
    await click('#open-walkthrough');
    await ready();
    const targeted = await armState(`document.querySelector('[data-walkthrough]').getAttribute('data-target-${kind}-id') === '${kind}'`, `${kind} raycast target`);
    await setMode('walk');
    await targeted();
    const field = kind === 'door' ? 'openAngle' : 'openRatio';
    const opening = kind === 'door' ? 90 : 100;
    for (const [input, value] of [['touch', opening], ['keyboard', 0], ['mouse', opening]]) {
      touch = input !== 'mouse';
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 2 });
      const changed = await armState(`document.querySelector('[data-walkthrough]').getAttribute('data-last-${kind}-action') === '${kind}:${value}'`, `${input} ${kind} activation`);
      if (input === 'mouse') await page(`window.__openingClick = new Promise(resolveClick => document.querySelector('[data-walkthrough-canvas]').addEventListener('click', event => resolveClick(event.isTrusted), { once: true })); true`);
      if (input === 'keyboard') await key('e', 'KeyE', 69);
      else await click('[data-walkthrough-canvas]');
      await changed();
      if (input === 'mouse') assert.equal(await page('window.__openingClick'), true, 'native canvas mouse click remains intact');
      const saved = await page(`JSON.parse(localStorage.getItem('room-studio-layout-v2')).structures.find(entry => entry.id === '${kind}').${field}`);
      assert.equal(saved, value, 'raycast activation reaches the real editor persistence callback');
      assert.equal(await page('document.pointerLockElement === null'), true, 'opening activation does not fall through to pointer lock');
      receipt.openingActivations.push({ kind, input, [field]: saved });
    }
    await screenshot(`${kind}-native-activation`);
    const exited = await armState(`!document.querySelector('[data-walkthrough]')`, `${kind} fixture closed`);
    await click('.walkthrough-exit');
    await exited();
  }
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('room-studio-layout-v2', ${JSON.stringify(JSON.stringify(DEMO_LAYOUTS[0]))});` });

  // Narrow geometry runs first so this regression is RED on the old 230px toolbar.
  for (const [width, height] of touchFollowupOnly ? [] : [[390, 844], [320, 568], [1440, 1000], [844, 390]]) {
    touch = width <= 900;
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 2 });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch });
    await bounded(browser.navigate(receipt.url), 'Editor navigation');
    await paint();
    // The short landscape workspace scrolls; use native scrolling before actual SVG input.
    await page(`document.querySelector('[data-item-id="${DEMO_LAYOUTS[0].items[0].id}"]').scrollIntoView({ block: 'center', behavior: 'instant' })`);
    await paint();
    await click(`[data-item-id="${DEMO_LAYOUTS[0].items[0].id}"]`);
    const documentBefore = await page(`localStorage.getItem('room-studio-layout-v2')`);
    await page(`document.querySelector('#open-walkthrough').scrollIntoView({ block: 'center', behavior: 'instant' })`);
    await paint();
    const ready = await armState(`document.querySelector('[data-walkthrough-ready="true"]')`, '3D ready');
    await click('#open-walkthrough');
    await ready();
    const entryFocusInside = await page(`Boolean(document.activeElement?.closest('[data-walkthrough]'))`);
    const backgroundInert = await page(`document.querySelector('#app').inert`);
    await setMode('walk');
    // Linux grants native pointer lock here; arm its actual transition before the click.
    const acquired = !touch && process.platform === 'linux'
      ? await armState(`document.pointerLockElement === document.querySelector('[data-walkthrough-canvas]')`, 'native canvas pointer lock', ['pointerlockchange'])
      : null;
    await click('[data-walkthrough-canvas]');
    if (acquired) await acquired();
    const beforeArrow = await page(`localStorage.getItem('room-studio-layout-v2')`);
    await key('ArrowRight', 'ArrowRight', 39);
    assert.equal(await page(`localStorage.getItem('room-studio-layout-v2')`), beforeArrow, '3D arrow keys must not change the saved 2D drawing');
    if (!touch) {
      const wasLocked = await page('document.pointerLockElement !== null');
      receipt.desktopPointerLock = { wasLocked };
      if (wasLocked) {
        const paused = await armState(`!document.pointerLockElement && !document.querySelector('[data-walkthrough-menu]').hidden`, 'Escape recovers toolbar access', ['pointerlockchange']);
        await page(`window.__nativeUnlock = new Promise(resolveUnlock => document.addEventListener('pointerlockchange', event => resolveUnlock({ trusted: event.isTrusted, locked: !!document.pointerLockElement }), { once: true })); true`);
        await key('Escape', 'Escape', 27);
        await paused();
        receipt.desktopPointerLock.escape = await page('window.__nativeUnlock');
        assert.deepEqual(receipt.desktopPointerLock.escape, { trusted: true, locked: false });
        assert.equal((await snapshot()).navigationActive, false);
      }
    }
    await setMode('dollhouse');
    assert.equal(entryFocusInside, true, '3D entry moves keyboard focus inside the overlay');
    assert.equal(backgroundInert, true, 'the background editor is inert during 3D');
    await screenshot(`${width}x${height}-overview`);
    const geometry = await rects();
    receipt.viewports.push({ width, height, closed: geometry });
    assert.ok(geometry.stage.y <= 134, `closed overview stage begins at ${geometry.stage.y}px; maximum 134px`);
    checkControls(geometry, width, height, 5);
    assert.ok(geometry.toolbar.bottom <= geometry.stage.y, 'primary controls end before the scene begins');
    const initial = await snapshot();
    assert.equal(initial.viewMode, 'dollhouse');
    assert.ok(initial.selectedTarget, 'real editor selection reaches 3D');
    assert.equal(initial.renderer.pixelRatio, 1);
    assert.equal(initial.renderer.shadows, true, 'screenshots use production rendering');
    checkFit(initial);

    await openMore();
    const openGeometry = await rects();
    checkControls(openGeometry, width, height, 9);
    assert.deepEqual(openGeometry.stage, geometry.stage, 'disclosure does not resize the stage');
    assert.deepEqual((await snapshot()).camera, initial.camera, 'disclosure does not reframe the camera');
    await screenshot(`${width}x${height}-more`);
    await closeMore();
    // Escape returned focus to More; Enter and Space both use native button activation.
    await openMore(true);
    const spaceClosed = await armState(`document.querySelector('[data-walkthrough-more]').getAttribute('aria-expanded') === 'false'`, 'Space closes More');
    await key(' ', 'Space', 32);
    await spaceClosed();
    await openMore(true);
    // Native Tab reaches every enabled tool in DOM order.
    for (const selector of ['[data-toggle-ceiling]', '[data-toggle-walls]', '[data-focus-selection]', '[data-save-snapshot]']) {
      const focused = await armState(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`, `Tab ${selector}`, ['focusin']);
      await key('Tab', 'Tab', 9);
      await focused();
    }
    await key('Tab', 'Tab', 9);
    assert.equal(await page(`Boolean(document.activeElement?.closest('[data-walkthrough]'))`), true, 'Tab beyond the last tool stays inside 3D');
    await key('Tab', 'Tab', 9, 8);
    assert.equal(await page(`Boolean(document.activeElement?.closest('[data-walkthrough]'))`), true, 'reverse Tab stays inside 3D');
    await closeMore();
    await openMore();
    const shown = await armState(`document.querySelector('[data-toggle-ceiling]').getAttribute('aria-pressed') === 'false'`, 'ceiling shown');
    await click('[data-toggle-ceiling]');
    await shown();
    assert.ok((await snapshot()).ceilingVisibility.every(Boolean));
    await click('[data-toggle-ceiling]');
    assert.ok((await snapshot()).ceilingVisibility.every(visible => !visible));
    await click('[data-toggle-walls]');
    assert.equal(await page(`document.querySelector('[data-walkthrough]').dataset.dollhouseCutaway`), 'false');
    const fullWalls = await snapshot();
    assert.deepEqual(fullWalls.bounds, initial.bounds);
    assert.deepEqual(fullWalls.structure, initial.structure);
    assert.deepEqual(fullWalls.walls, initial.walls);
    assert.deepEqual(fullWalls.leaves, initial.leaves);
    await closeMore();
    await screenshot(`${width}x${height}-full-walls`);
    await openMore();
    await click('[data-toggle-walls]');
    await click('[data-focus-selection]');
    const focused = await snapshot();
    assert.deepEqual(focused.target, focused.selectedTarget);
    assert.notDeepEqual(focused.camera, initial.camera);
    checkFit(focused);
    await closeMore();
    await screenshot(`${width}x${height}-selection`);
    await setMode('top');
    checkFit(await snapshot());
    await screenshot(`${width}x${height}-top`);
    await openMore();
    receipt.viewports.at(-1).download = await download(`${width}x${height}-top`);
    await closeMore();
    await setMode('walk');
    assert.equal((await snapshot()).navigationActive, true);
    assert.equal(await page(`document.querySelector('[data-toggle-walls]').disabled`), true);
    assert.equal(await page(`document.querySelector('[data-walkthrough]').dataset.dollhouseCutaway`), 'false');
    await openMore();
    const beforeMenuKeys = await snapshot();
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
    assert.deepEqual((await snapshot()).keys, [], 'More does not route keyboard input to camera movement');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
    await key('e', 'KeyE', 69);
    assert.deepEqual((await snapshot()).structure, beforeMenuKeys.structure, 'More does not activate scene openings');
    await closeMore();
    assert.equal(await page(`document.activeElement === document.querySelector('[data-walkthrough-more]')`), true);
    // Subscribe before a held key; translation (not heading interpolation) proves actual movement.
    const beforeMove = await page(`document.querySelector('[data-map-player]').getAttribute('transform').split(')')[0]`);
    const moved = await armState(`document.querySelector('[data-map-player]').getAttribute('transform').split(')')[0] !== ${JSON.stringify(beforeMove)}`, 'walk movement');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
    await moved();
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
    // Opening More uses the real stopMovement event path, without pausing navigation.
    await openMore();
    await closeMore();
    await screenshot(`${width}x${height}-walk`);
    await setMode('dollhouse');
    checkFit(await snapshot());
    await screenshot(`${width}x${height}-returned-overview`);
    await page(`window.__simple3dContextLost = false; document.querySelector('[data-walkthrough-canvas]').addEventListener('webglcontextlost', () => { window.__simple3dContextLost = true; document.dispatchEvent(new Event('webglcontextlost')); }, { once: true });`);
    const contextLost = await armState(`window.__simple3dContextLost === true`, 'WebGL context released', ['webglcontextlost']);
    const exited = await armState(`!document.querySelector('[data-walkthrough]')`, 'return 2D');
    await click('.walkthrough-exit');
    await exited();
    await contextLost();
    const cleanup = await snapshot();
    assert.equal(cleanup.destroyed, true);
    assert.equal(cleanup.connected, false);
    for (const counts of Object.values(cleanup.resources)) assert.equal(counts.disposed, counts.total, 'all observed GPU resources disposed');
    assert.equal(await page(`localStorage.getItem('room-studio-layout-v2')`), documentBefore, '3D controls do not modify the plan');
    assert.equal(await page(`!!document.querySelector('#plan-canvas') && !document.fullscreenElement && !document.pointerLockElement`), true);
    assert.equal(await page(`document.querySelector('#app').inert`), false);
    assert.equal(await page(`document.activeElement === document.querySelector('#open-walkthrough')`), true, 'closing 3D restores focus to its opener');
    receipt.viewports.at(-1).open = openGeometry;
    receipt.viewports.at(-1).cleanup = cleanup.resources;
    await screenshot(`${width}x${height}-return-2d`);
  }
  assert.deepEqual(receipt.errors, []);
  receipt.status = 'PASS';
  console.log(`SIMPLE_3D_PASS touch follow-up + ${receipt.viewports.length} production viewports`);
} catch (error) {
  receipt.status = 'FAIL';
  receipt.failure = error.stack;
  process.exitCode = 1;
  console.error(`SIMPLE_3D_FAIL ${error.stack}`);
  if (browser) await bounded(capture(browser.cdp, join(output, 'failure.png')), 'Failure screenshot');
} finally {
  await bounded(browser?.close(), 'Chrome cleanup');
  await bounded(server?.close(), 'Vite cleanup');
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const portClosed = port => bounded(new Promise((resolveClosed, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolveClosed(false); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolveClosed(true) : reject(error));
  }), 'Port closure');
  receipt.cleanup = {
    chromeStopped: chromeProcess ? !alive(chromeProcess) : null,
    profileRemoved: profile ? await access(profile).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; }) : null,
    chromePortClosed: chromePort ? await portClosed(chromePort) : null,
    serverPortClosed: serverPort ? await portClosed(serverPort) : null,
  };
  if (Object.values(receipt.cleanup).some(value => value === false)) {
    receipt.status = 'FAIL';
    process.exitCode = 1;
  }
  await writeFile(join(output, 'results.json'), JSON.stringify(receipt, null, 2));
  console.log(`SIMPLE_3D_EVIDENCE ${output}`);
}
process.exit(process.exitCode ?? 0);
