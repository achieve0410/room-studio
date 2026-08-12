import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { safeArtifactPath } from './artifact-path.mjs';
import { DEMO_LAYOUTS } from '../../../src/demo-layouts.js';
import {
  doorsForAutomaticWallSegment,
  getDoorLeafSegments,
  getInteriorWallSegments,
  isPointBlockedByDoorLeaves,
  isPointBlockedByFurniture,
  isPointBlockedByInteriorWall,
  isWalkablePoint,
  splitWallSegment,
} from '../../../src/geometry.js';

const chrome = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => candidate && existsSync(candidate));
if (!chrome) throw new Error('Chrome or Chromium is required');

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const outputDir = safeArtifactPath(process.argv[3], '.omx/artifacts/real-plan-navigation/traversal');
const profile = await mkdtemp(join(
  process.env.REAL_PLAN_AUDIT_PROFILE_ROOT ?? tmpdir(),
  'room-studio-real-plan-traversal-',
));
let browser;
let cdp;

class Cdp {
  constructor(socketUrl) {
    this.socket = new WebSocket(socketUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const request = this.pending.get(message.id);
        this.pending.delete(message.id);
        message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
      } else {
        const listeners = this.listeners.get(message.method) ?? [];
        this.listeners.delete(message.method);
        listeners.forEach((resolveEvent) => resolveEvent(message.params));
      }
    });
  }

  connect() {
    return new Promise((resolveConnect, reject) => {
      this.socket.addEventListener('open', resolveConnect, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}) {
    return new Promise((resolveSend, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve: resolveSend, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolveEvent) => {
      const listeners = this.listeners.get(method) ?? [];
      listeners.push(resolveEvent);
      this.listeners.set(method, listeners);
    });
  }
}

async function stopBrowser() {
  cdp?.socket.close();
  if (browser?.exitCode === null) {
    browser.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveExit) => browser.once('exit', resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
    ]);
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function collisionFor(demo) {
  const doors = demo.structures.filter(({ type }) => type === 'door');
  const walls = demo.structures.filter(({ type }) => type === 'wall');
  const spans = getInteriorWallSegments(demo.zones).flatMap((wall) =>
    splitWallSegment(wall, doorsForAutomaticWallSegment(wall, doors, walls)).spans);
  const leaves = getDoorLeafSegments(doors);
  return (point) => !isWalkablePoint(point, demo.zones, 18)
    || isPointBlockedByFurniture(point, demo.items, 18, 165)
    || isPointBlockedByInteriorWall(point, spans, 18)
    || isPointBlockedByDoorLeaves(point, leaves, 18);
}

function routeToZone(demo, start, target, blocked) {
  const step = 10;
  const keyOf = ({ x, y }) => `${Math.round(x / step)},${Math.round(y / step)}`;
  const pointOf = (key) => {
    const [x, y] = key.split(',').map(Number);
    return { x: x * step, y: y * step };
  };
  let origin;
  for (let radius = 0; radius <= 50 && !origin; radius += step) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx += step) {
      for (let dy = -radius; dy <= radius; dy += step) {
        const point = { x: Math.round((start.x + dx) / step) * step, y: Math.round((start.y + dy) / step) * step };
        if (!blocked(point)) candidates.push(point);
      }
    }
    origin = candidates.sort((a, b) =>
      Math.hypot(a.x - start.x, a.y - start.y) - Math.hypot(b.x - start.x, b.y - start.y))[0];
  }
  if (!origin) throw new Error(`${demo.id}: no navigable start`);
  const queue = [keyOf(origin)];
  const previous = new Map([[queue[0], null]]);
  let goal;
  for (let cursor = 0; cursor < queue.length && !goal; cursor += 1) {
    const currentKey = queue[cursor];
    const current = pointOf(currentKey);
    const reached = Number.isFinite(target.width)
      ? current.x > target.x + 20 && current.x < target.x + target.width - 20
        && current.y > target.y + 20 && current.y < target.y + target.depth - 20
      : Math.hypot(current.x - target.x, current.y - target.y) <= step;
    if (reached) {
      goal = currentKey;
      break;
    }
    for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
      const neighbor = { x: current.x + dx, y: current.y + dy };
      const neighborKey = keyOf(neighbor);
      if (previous.has(neighborKey) || blocked(neighbor)) continue;
      previous.set(neighborKey, currentKey);
      queue.push(neighborKey);
    }
  }
  if (!goal) throw new Error(`${demo.id}: no route to ${target.name ?? `${target.x},${target.y}`}`);
  const reverse = [];
  for (let cursor = goal; cursor; cursor = previous.get(cursor)) reverse.push(pointOf(cursor));
  const raw = [{ x: start.x, y: start.y }, ...reverse.reverse()];
  const turns = [raw[0]];
  let direction;
  for (let index = 1; index < raw.length; index += 1) {
    const nextDirection = {
      x: Math.sign(raw[index].x - raw[index - 1].x),
      y: Math.sign(raw[index].y - raw[index - 1].y),
    };
    if (direction && (nextDirection.x !== direction.x || nextDirection.y !== direction.y)) {
      turns.push(raw[index - 1]);
    }
    direction = nextDirection;
  }
  turns.push(raw.at(-1));
  return turns;
}

async function evaluate(expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
}

async function waitFor(expression, label, timeout = 20_000) {
  const result = await evaluate(`new Promise((resolve) => {
    const check = () => { if (${expression}) { observer.disconnect(); clearTimeout(timer); resolve(true); } };
    const observer = new MutationObserver(check);
    observer.observe(document, { attributes: true, childList: true, subtree: true });
    const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, ${timeout});
    check();
  })`);
  if (!result) throw new Error(`Timed out waiting for ${label}`);
}

async function armSignal(expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: false,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  if (!response.result.objectId) throw new Error('Browser signal did not return a promise');
  return response.result.objectId;
}

async function waitForSignal(promiseObjectId, label, timeout = 3_000) {
  let timer;
  try {
    return await Promise.race([
      cdp.send('Runtime.awaitPromise', {
        promiseObjectId,
        returnByValue: true,
      }).then((response) => {
        if (response.exceptionDetails) {
          throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
        }
        return response.result.value;
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function navigate(target) {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: target });
  await loaded;
}

async function settleFrames() {
  const frames = await armSignal(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`);
  if (await evaluate(`window.__qaFrames?.isControlled() ?? false`)) {
    await evaluate(`window.__qaFrames.step(2)`);
  }
  await waitForSignal(frames, 'browser settling frames');
}

async function telemetry() {
  return evaluate(`(() => {
    const match = document.querySelector('[data-map-player]').getAttribute('transform')
      .match(/translate\\(([-.0-9]+) ([-.0-9]+)\\) rotate\\(([-.0-9]+)\\)/);
    return { x: Number(match[1]), y: Number(match[2]), angle: Number(match[3]),
      room: document.querySelector('[data-current-room]').textContent };
  })()`);
}

async function clickSelector(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({
    block: 'center',
    inline: 'center',
  })`);
  await settleFrames();
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: hit?.closest(${JSON.stringify(selector)}) === element };
  })()`);
  if (!point) throw new Error(`Missing click target: ${selector}`);
  if (!point.hit) throw new Error(`Click target is covered or outside the viewport: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1,
  });
  await settleFrames();
}

async function mouseDrag(start, end) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: end.x, y: end.y, button: 'left', buttons: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1,
  });
  await settleFrames();
}

async function moveTo(waypoint, demoId) {
  let current;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    current = await telemetry();
    const dx = waypoint.x - current.x;
    const dy = waypoint.y - current.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= 20) return;
    const desired = { x: dx / distance, y: dy / distance };
  const angle = current.angle * Math.PI / 180;
  const forward = { x: Math.sin(angle), y: -Math.cos(angle) };
  const right = { x: -forward.y, y: forward.x };
  const joystickX = desired.x * right.x + desired.y * right.y;
  const joystickY = -(desired.x * forward.x + desired.y * forward.y);
  const joystickPoint = await evaluate(`(() => {
    const joystick = document.querySelector('[data-walkthrough-joystick]');
    const rect = joystick.getBoundingClientRect();
    const radius = Math.max(20, rect.width * 0.31);
    window.__qaJoystickPointerTypes ??= [];
    if (!window.__qaJoystickPointerObserver) {
      joystick.addEventListener('pointerdown', (event) => window.__qaJoystickPointerTypes.push(event.pointerType));
      window.__qaJoystickPointerObserver = true;
    }
    return {
      coarse: matchMedia('(pointer: coarse)').matches,
      display: getComputedStyle(joystick).display,
      hit: document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      )?.closest('[data-walkthrough-joystick]') === joystick,
      width: rect.width,
      height: rect.height,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      x: rect.left + rect.width / 2 + radius * ${joystickX},
      y: rect.top + rect.height / 2 + radius * ${joystickY},
    };
  })()`);
  if (!joystickPoint.coarse || joystickPoint.display === 'none'
    || joystickPoint.width <= 0 || joystickPoint.height <= 0 || !joystickPoint.hit) {
    throw new Error(`${demoId}: joystick is not touch-ready ${JSON.stringify(joystickPoint)}`);
  }
  const touchStartObserved = await armSignal(`new Promise((resolve) => {
    const joystick = document.querySelector('[data-walkthrough-joystick]');
    joystick.addEventListener('pointerdown', (event) => resolve({
      active: joystick.classList.contains('is-active'),
      pointerId: event.pointerId,
      pointerType: event.pointerType,
    }), { once: true });
  })`);
  let touchActive = false;
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{
        x: joystickPoint.centerX,
        y: joystickPoint.centerY,
        id: 41,
        radiusX: 1,
        radiusY: 1,
      }],
    });
    touchActive = true;
    const touchStart = await waitForSignal(touchStartObserved, `${demoId} joystick pointerdown`);
    if (!touchStart.active || touchStart.pointerType !== 'touch') {
      throw new Error(`${demoId}: joystick rejected touch start ${JSON.stringify(touchStart)}`);
    }
    const touchMoveObserved = await armSignal(`new Promise((resolve) => {
      const joystick = document.querySelector('[data-walkthrough-joystick]');
      joystick.addEventListener('pointermove', (event) => resolve({
        active: joystick.classList.contains('is-active'),
        knob: document.querySelector('[data-joystick-knob]').style.transform,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
      }), { once: true });
    })`);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{
        x: joystickPoint.x,
        y: joystickPoint.y,
        id: 41,
        radiusX: 1,
        radiusY: 1,
      }],
    });
    const touchMove = await waitForSignal(touchMoveObserved, `${demoId} joystick pointermove`);
    if (!touchMove.active || touchMove.pointerType !== 'touch'
      || touchMove.pointerId !== touchStart.pointerId || touchMove.knob === 'translate(0px, 0px)') {
      throw new Error(`${demoId}: joystick rejected touch move ${JSON.stringify(touchMove)}`);
    }
    const chunkDistance = Math.min(20, Math.max(5, distance - 20));
    const movement = await evaluate(`(() => {
      const player = document.querySelector('[data-map-player]');
      for (let frame = 1; frame <= 90; frame += 1) {
        window.__qaFrames.step(1);
        const next = player.getAttribute('transform').match(/translate\\(([-.0-9]+) ([-.0-9]+)\\)/);
        const remaining = Math.hypot(${waypoint.x} - Number(next[1]), ${waypoint.y} - Number(next[2]));
        const moved = Math.hypot(Number(next[1]) - ${current.x}, Number(next[2]) - ${current.y});
        if (remaining <= 20 || moved >= ${chunkDistance}) return { frame, moved, remaining };
      }
      const next = player.getAttribute('transform').match(/translate\\(([-.0-9]+) ([-.0-9]+)\\)/);
      return {
        frame: 0,
        moved: Math.hypot(Number(next[1]) - ${current.x}, Number(next[2]) - ${current.y}),
        remaining: Math.hypot(${waypoint.x} - Number(next[1]), ${waypoint.y} - Number(next[2])),
      };
    })()`);
    if (!movement.frame) {
      throw new Error(`${demoId}: camera advanced only ${movement.moved.toFixed(1)} cm; ${movement.remaining.toFixed(1)} cm remain`);
    }
  } finally {
    if (touchActive) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
  }
  }
  throw new Error(`${demoId}: did not reach ${JSON.stringify(waypoint)} from ${JSON.stringify(current)}`);
}

async function scanVisibleDoors(targetedDoorIds) {
  const canvas = await evaluate(`(() => {
    const rect = document.querySelector('[data-walkthrough-canvas]').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  const tenDegrees = 10 / (0.0028 * 180 / Math.PI);
  for (let step = 0; step < 36; step += 1) {
    const target = await evaluate(`document.querySelector('[data-walkthrough]')?.dataset.targetDoorId ?? null`);
    if (target) targetedDoorIds.add(target);
    await mouseDrag(canvas, { x: canvas.x + tenDegrees, y: canvas.y });
  }
}

let error;
try {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const ready = new Promise((resolveReady, reject) => {
    let stderr = '';
    browser = spawn(chrome, [
      '--headless=new', '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-extensions', '--disable-renderer-backgrounding', '--disable-sync', '--hide-scrollbars', '--no-first-run',
      '--force-prefers-reduced-motion', '--remote-debugging-port=0', '--window-size=1440,1000',
      `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/\S+)/);
      if (match) resolveReady(Number(match[2]));
    });
    browser.once('exit', (code) => reject(new Error(`Chrome exited before CDP readiness: ${code}`)));
  });
  const port = await ready;
  const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
  const page = pages.find((candidate) => candidate.type === 'page' && candidate.url === 'about:blank');
  if (!page) throw new Error('Chrome did not expose the intended about:blank page target');
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__roomStudioQaRenderProfile = true;
      const nativeRequest = window.requestAnimationFrame.bind(window);
      const nativeCancel = window.cancelAnimationFrame.bind(window);
      let controlled = false;
      let clock = 0;
      let nextId = -1;
      let queue = new Map();
      window.requestAnimationFrame = (callback) => {
        if (!controlled) return nativeRequest(callback);
        const id = nextId--;
        queue.set(id, callback);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        if (id < 0) queue.delete(id);
        else nativeCancel(id);
      };
      window.__qaFrames = {
        isControlled() {
          return controlled;
        },
        takeControl() {
          controlled = true;
          return new Promise((resolve) => {
            nativeRequest((timestamp) => {
              clock = timestamp;
              resolve(queue.size);
            });
          });
        },
        step(count = 1, interval = 1000 / 60) {
          for (let frame = 0; frame < count; frame += 1) {
            clock += interval;
            const callbacks = queue;
            queue = new Map();
            callbacks.forEach((callback) => callback(clock));
          }
          return { clock, pending: queue.size };
        },
      };
    })();`,
  });
  await cdp.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'pointer', value: 'coarse' },
    { name: 'any-pointer', value: 'coarse' },
  ] });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const reports = [];
  for (const demo of DEMO_LAYOUTS) {
    await navigate(url);
    await waitFor(`document.querySelector('[data-demo-open]')`, `${demo.id} app shell`);
    await evaluate(`localStorage.clear()`);
    if (await evaluate(`Boolean(document.querySelector('[data-start-close]'))`)) {
      await clickSelector('[data-start-close]');
    }
    await clickSelector('[data-demo-open]');
    await waitFor(`document.querySelector('[data-demo-layout="${demo.id}"]')`, `${demo.id} gallery card`);
    await clickSelector(`[data-demo-layout="${demo.id}"]`);
    await waitFor(
      `document.querySelector('[data-demo-confirm-accept]') || document.querySelectorAll('.plan-door').length === ${demo.structures.filter(({ type }) => type === 'door').length}`,
      `${demo.id} replacement decision`,
    );
    if (await evaluate(`Boolean(document.querySelector('[data-demo-confirm-accept]'))`)) {
      await clickSelector('[data-demo-confirm-accept]');
    }
    await waitFor(`document.querySelectorAll('.plan-door').length === ${demo.structures.filter(({ type }) => type === 'door').length}`, `${demo.id} 2D doors`);
    const loadedStartCount = await evaluate(`JSON.parse(localStorage.getItem('room-studio-layout-v2')).zones
      .filter((zone) => zone.walkthroughStart).length`);
    if (loadedStartCount !== 1) throw new Error(`${demo.id}: entrance walkthrough marker was not preserved`);
    await clickSelector('#open-walkthrough');
    await waitFor(`document.querySelector('[data-walkthrough-ready="true"]')`, `${demo.id} walkthrough`, 30_000);
    await clickSelector('[data-view-mode="walk"]');
    await waitFor(`document.querySelector('[data-walkthrough]').classList.contains('is-active')`, `${demo.id} walk mode`);
    const pageState = await evaluate(`({
      focused: document.hasFocus(),
      visibility: document.visibilityState,
    })`);
    if (!pageState.focused || pageState.visibility !== 'visible') {
      throw new Error(`${demo.id}: walkthrough page is backgrounded ${JSON.stringify(pageState)}`);
    }
    const animationReady = await armSignal(`new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
    })`);
    await waitForSignal(animationReady, `${demo.id} walkthrough animation frames`);
    await waitFor(
      `document.querySelector('[data-current-room]').textContent === ${JSON.stringify(demo.zones.find(({ walkthroughStart }) => walkthroughStart).name)}`,
      `${demo.id} starts at entrance`,
    );
    await evaluate(`window.__qaVisitedRooms = new Set([document.querySelector('[data-current-room]').textContent]);
      new MutationObserver(() => window.__qaVisitedRooms.add(document.querySelector('[data-current-room]').textContent))
        .observe(document.querySelector('[data-current-room]'), { childList: true, subtree: true, characterData: true });`);
    const blocked = collisionFor(demo);
    const targetedDoorIds = new Set();
    await scanVisibleDoors(targetedDoorIds);
    const frameControl = await armSignal(`window.__qaFrames.takeControl()`);
    const pendingFrames = await waitForSignal(frameControl, `${demo.id} frame control`);
    if (pendingFrames < 1) throw new Error(`${demo.id}: walkthrough animation loop was not captured`);
    let current = await telemetry();
    for (const zone of demo.zones.filter(({ name }) => name !== current.room)) {
      const route = routeToZone(demo, current, zone, blocked);
      for (const waypoint of route.slice(1)) {
        if ((await telemetry()).room === zone.name) break;
        await moveTo(waypoint, demo.id);
      }
      await waitFor(`document.querySelector('[data-current-room]').textContent === ${JSON.stringify(zone.name)}`, `${demo.id} entered ${zone.name}`);
      current = await telemetry();
      await scanVisibleDoors(targetedDoorIds);
    }
    const visited = await evaluate(`[...window.__qaVisitedRooms]`);
    const joystickPointerTypes = await evaluate(`[...new Set(window.__qaJoystickPointerTypes ?? [])]`);
    if (joystickPointerTypes.length !== 1 || joystickPointerTypes[0] !== 'touch') {
      throw new Error(`${demo.id}: unsupported joystick pointer semantics ${JSON.stringify(joystickPointerTypes)}`);
    }
    const expected = demo.zones.map(({ name }) => name);
    const missing = expected.filter((name) => !visited.includes(name));
    if (missing.length) throw new Error(`${demo.id}: unvisited rooms ${missing.join(', ')}`);
    const expectedDoorIds = demo.structures.filter(({ type }) => type === 'door').map(({ id }) => id);
    const missingDoorIds = expectedDoorIds.filter((id) => !targetedDoorIds.has(id));
    if (missingDoorIds.length) throw new Error(`${demo.id}: doors never visibly targeted ${missingDoorIds.join(', ')}`);
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(outputDir, `${demo.id}-traversal.png`), Buffer.from(screenshot.data, 'base64'));
    reports.push({
      id: demo.id,
      name: demo.name,
      expected,
      visited,
      targetedDoorIds: [...targetedDoorIds],
      joystickPointerTypes,
      final: current,
      passed: true,
    });
    await clickSelector('[data-walkthrough-exit]');
    await waitFor(`!document.querySelector('[data-walkthrough]')`, `${demo.id} walkthrough cleanup`);
  }
  await writeFile(join(outputDir, 'traversal-green.json'), JSON.stringify({ passed: true, reports }, null, 2));
  console.log(JSON.stringify({ passed: true, reports }, null, 2));
} catch (cause) {
  error = cause;
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'traversal-error.txt'), cause.stack ?? String(cause));
} finally {
  await stopBrowser();
}
if (error) throw error;
