import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { constants, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const vite = join(root, 'node_modules', '.bin', 'vite');
const chromeCandidates = [
  ...(process.env.CHROME_BIN ? [process.env.CHROME_BIN] : []),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const chrome = chromeCandidates.find((candidate) => existsSync(candidate));
const STORAGE_KEY = 'room-studio-layout-v2';
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const artifactDir = join(root, '.omx', 'artifacts', 'mobile-ux-hardening', runId);
const resultsPath = join(artifactDir, 'browser-results.json');

let previewProcess;
let chromeProcess;
let chromeProfile;
let cdp;
let cleanupPromise;

function stopProcessSync(child) {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let timer;
    const finish = (exited) => {
      if (timer) clearTimeout(timer);
      child.off('exit', onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    if (timeoutMs !== undefined) timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 3_000)) return;
  child.kill('SIGKILL');
  await waitForExit(child);
}

function cleanup() {
  cleanupPromise ??= (async () => {
    cdp?.close();
    await Promise.all([stopProcess(chromeProcess), stopProcess(previewProcess)]);
    if (chromeProfile) await rm(chromeProfile, { force: true, recursive: true });
  })();
  return cleanupPromise;
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(128 + constants.signals[signal]));
  });
}

process.once('exit', () => {
  stopProcessSync(chromeProcess);
  stopProcessSync(previewProcess);
});

function allocatePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForUrl(url, label, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${label} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError?.message ?? 'unavailable'}`);
}

class CdpClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(url);
  }

  async connect() {
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('CDP WebSocket connection failed')), { once: true });
    });
    this.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    });
    this.socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP WebSocket closed'));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    return new Promise((resolveCommand, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolveCommand, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolveEvent) => {
      const listener = (params) => {
        this.off(method, listener);
        resolveEvent(params);
      };
      this.on(method, listener);
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
  }

  off(method, listener) {
    const listeners = this.listeners.get(method);
    listeners?.delete(listener);
    if (!listeners?.size) this.listeners.delete(method);
  }

  close() {
    if (this.socket?.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

function assertion(name, pass, actual, expected) {
  return { name, pass: Boolean(pass), actual, expected };
}

async function evaluate(expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
}

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function doubleRaf() {
  await evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

async function waitForExpression(expression, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await evaluate(expression);
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
}

async function setViewport(width, height, touch) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: touch,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', {
    enabled: touch,
    maxTouchPoints: touch ? 5 : 1,
  });
}

async function loadViewport(url, width, height, touch = width <= 900) {
  await setViewport(width, height, touch);
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  await doubleRaf();
  await waitForExpression(
    `document.querySelector('.mobile-nav') !== null && document.querySelector('.workspace') !== null`,
    'application shell after page load',
  );
}

async function reloadViewport(url, width, height, touch = width <= 900) {
  await loadViewport(url, width, height, touch);
  await evaluate('localStorage.clear()');
  await loadViewport(url, width, height, touch);
}

async function screenshot(name) {
  const response = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const file = `${name}.png`;
  await writeFile(join(artifactDir, file), Buffer.from(response.data, 'base64'));
  return file;
}

async function centerOf(selector, index = 0) {
  return evaluate(`(() => {
    const node = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
  })()`);
}

async function mouseClick(point, modifiers = 0) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers });
  await doubleRaf();
}

async function mouseDrag(start, end, modifiers = 0) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, modifiers });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1, modifiers });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: end.x, y: end.y, button: 'left', buttons: 1, modifiers });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1, modifiers });
  await doubleRaf();
}

function touchPoint(id, point) {
  return { id, x: point.x, y: point.y, radiusX: 2, radiusY: 2, force: 1 };
}

async function dispatchTouch(type, points) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
}

async function keyEvent(type, key, code, modifiers = 0) {
  const keyCodes = { Escape: 27, ArrowRight: 39, KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, KeyY: 89, KeyZ: 90 };
  await cdp.send('Input.dispatchKeyEvent', {
    type,
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: keyCodes[code] ?? 0,
    nativeVirtualKeyCode: keyCodes[code] ?? 0,
  });
}

async function keyStroke(key, code, modifiers = 0) {
  await keyEvent('keyDown', key, code, modifiers);
  await keyEvent('keyUp', key, code, modifiers);
  await doubleRaf();
}

function parseTransform(transform) {
  const match = transform?.match(/translate\(([-\d.]+)[ ,]+([-\d.]+)\).*rotate\(([-\d.]+)/);
  return match ? { x: Number(match[1]), y: Number(match[2]), rotation: Number(match[3]) } : null;
}

function distance(first, second) {
  return first && second ? Math.hypot(second.x - first.x, second.y - first.y) : 0;
}

async function inspectViewport() {
  return evaluate(`(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const sizes = (selector) => [...document.querySelectorAll(selector)].filter(visible).map((element) => {
      const rect = element.getBoundingClientRect();
      return { id: element.id || element.getAttribute('aria-label') || element.textContent.trim(), width: rect.width, height: rect.height };
    });
    return {
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      mobileNavVisible: visible(document.querySelector('.mobile-nav')),
      mobileNavDisplay: getComputedStyle(document.querySelector('.mobile-nav')).display,
      workspaceVisible: visible(document.querySelector('.workspace')),
      workspaceDisplay: getComputedStyle(document.querySelector('.workspace')).display,
      mobileNavButtons: sizes('.mobile-nav [role="tab"]'),
      toolbarButtons: sizes('.canvas-toolbar button'),
      canvasActionButtons: sizes('.canvas-actions button'),
    };
  })()`);
}

function noConsoleAssertion(label, errors) {
  return assertion(`${label} has no console or uncaught errors`, errors.length === 0, errors, '[]');
}

const report = {
  runId,
  startedAt: new Date().toISOString(),
  physicalDeviceSmoke: 'not-performed',
  viewports: [],
  interactionAssertions: [],
  screenshots: [],
};

let exitCode = 1;
try {
  if (!chrome) throw new Error(`Chrome executable not found. Checked: ${chromeCandidates.join(', ')}`);
  await mkdir(artifactDir, { recursive: true });
  const previewPort = await allocatePort();
  let chromePort = await allocatePort();
  while (chromePort === previewPort) chromePort = await allocatePort();
  report.ports = { preview: previewPort, chromeDebugging: chromePort };
  report.chrome = { executable: chrome, candidatesChecked: chromeCandidates };

  previewProcess = spawn(vite, ['preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  await waitForUrl(`http://127.0.0.1:${previewPort}/`, 'Vite preview', previewProcess);

  chromeProfile = await mkdtemp(join(tmpdir(), 'room-studio-mobile-audit-'));
  chromeProcess = spawn(chrome, [
    '--headless=new',
    '--enable-unsafe-swiftshader',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${chromeProfile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  await waitForUrl(`http://127.0.0.1:${chromePort}/json/version`, 'Chrome debugging endpoint', chromeProcess);
  const targetsResponse = await waitForUrl(`http://127.0.0.1:${chromePort}/json/list`, 'Chrome target list', chromeProcess);
  const targets = await targetsResponse.json();
  const page = targets.find((target) => target.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('Chrome did not expose a page target');

  cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.connect();
  await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Log.enable')]);
  const browserErrors = [];
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    browserErrors.push({ source: 'exception', text: exceptionDetails.exception?.description ?? exceptionDetails.text });
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error') browserErrors.push({ source: entry.source, text: entry.text });
  });

  const pageUrl = `http://127.0.0.1:${previewPort}/`;

  // A: viewport matrix, 390x844 accessibility, and hostile persisted-color handling.
  for (const [width, height] of [[320, 700], [390, 844], [430, 932], [768, 1024], [844, 390], [1024, 768], [1440, 1000]]) {
    const touch = width <= 900;
    await reloadViewport(pageUrl, width, height, touch);
    const data = await inspectViewport();
    const viewportAssertions = [
      assertion(`A viewport ${width}x${height} has no horizontal document overflow`, data.scrollWidth <= data.innerWidth, data.scrollWidth, `<= ${data.innerWidth}`),
      assertion(`A viewport ${width}x${height} mobile navigation matches the 900px breakpoint`, data.mobileNavVisible === touch, { visible: data.mobileNavVisible, display: data.mobileNavDisplay }, touch ? 'visible' : 'hidden'),
    ];
    if (width === 1024 || width === 1440) {
      viewportAssertions.push(
        assertion(`A viewport ${width}x${height} desktop workspace is visible`, data.workspaceVisible, { visible: data.workspaceVisible, display: data.workspaceDisplay }, 'visible'),
        assertion(`A viewport ${width}x${height} desktop workspace uses grid layout`, data.workspaceDisplay === 'grid', data.workspaceDisplay, 'grid'),
      );
    }
    report.viewports.push({
      width,
      height,
      touch,
      screenshot: await screenshot(`viewport-${width}x${height}`),
      data,
      assertions: viewportAssertions,
    });
  }

  await reloadViewport(pageUrl, 390, 844, true);
  const base390 = await inspectViewport();
  report.interactionAssertions.push(
    assertion('A 390x844 has no horizontal overflow', base390.scrollWidth <= base390.innerWidth, base390, `scrollWidth <= ${base390.innerWidth}`),
    assertion('A 390x844 mobile controls meet 44px target', [base390.mobileNavButtons, base390.toolbarButtons, base390.canvasActionButtons].every((items) => items.length && items.every(({ width, height }) => width >= 44 && height >= 44)), base390, 'all visible mobile nav, toolbar, and canvas action buttons >=44x44'),
    assertion('A 390x844 visible mobile nav controls each meet 44px target', base390.mobileNavButtons.length > 0 && base390.mobileNavButtons.every(({ width, height }) => width >= 44 && height >= 44), base390.mobileNavButtons, 'all visible mobile navigation controls >=44x44'),
    assertion('A 390x844 visible toolbar controls each meet 44px target', base390.toolbarButtons.length > 0 && base390.toolbarButtons.every(({ width, height }) => width >= 44 && height >= 44), base390.toolbarButtons, 'all visible toolbar controls >=44x44'),
    assertion('A 390x844 visible action controls each meet 44px target', base390.canvasActionButtons.length > 0 && base390.canvasActionButtons.every(({ width, height }) => width >= 44 && height >= 44), base390.canvasActionButtons, 'all visible canvas action controls >=44x44'),
  );

  const cloudAccountButton = await centerOf('[data-cloud-open]');
  await mouseClick(cloudAccountButton);
  const cloudSetupDialog = await evaluate(`(() => {
    const dialog = document.querySelector('.cloud-dialog');
    const close = document.querySelector('[data-cloud-close]')?.getBoundingClientRect();
    const google = document.querySelector('[data-cloud-google]')?.getBoundingClientRect();
    const email = document.querySelector('[data-cloud-email-form] input')?.getBoundingClientRect();
    const emailSubmit = document.querySelector('[data-cloud-email-form] button')?.getBoundingClientRect();
    return {
      visible: Boolean(dialog),
      title: dialog?.querySelector('h2')?.textContent ?? null,
      variables: dialog?.textContent.includes('VITE_SUPABASE_URL') && dialog?.textContent.includes('VITE_SUPABASE_PUBLISHABLE_KEY'),
      backgroundInert: document.querySelector('.workspace')?.inert ?? false,
      close: close ? { width: close.width, height: close.height } : null,
      loginControls: [google, email, emailSubmit].map((rect) => rect ? { width: rect.width, height: rect.height } : null),
    };
  })()`);
  report.screenshots.push(await screenshot('mobile-cloud-setup-390x844'));
  report.interactionAssertions.push(assertion(
    'A 390x844 cloud entry and setup dialog are accessible without credentials',
    cloudAccountButton?.width >= 44 && cloudAccountButton?.height >= 44 && cloudSetupDialog.visible
      && (cloudSetupDialog.title === '클라우드 연결 설정'
        ? cloudSetupDialog.variables
        : cloudSetupDialog.title === '로그인하고 도면 저장'
          && cloudSetupDialog.loginControls.every((rect) => rect?.width >= 44 && rect.height >= 44))
      && cloudSetupDialog.backgroundInert
      && cloudSetupDialog.close?.width >= 44 && cloudSetupDialog.close.height >= 44,
    { cloudAccountButton, cloudSetupDialog },
    '44px account/close controls, setup variables shown, and modal background inert',
  ));
  await mouseClick(await centerOf('[data-cloud-close]'));

  const mobileTabs = await evaluate(`(() => ({
    tablistRole: document.querySelector('.mobile-nav')?.getAttribute('role') ?? null,
    tabs: [...document.querySelectorAll('.mobile-nav [role="tab"]')].map((tab) => {
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      return {
        id: tab.id,
        role: tab.getAttribute('role'),
        controls: tab.getAttribute('aria-controls'),
        selected: tab.getAttribute('aria-selected'),
        tabindex: tab.getAttribute('tabindex'),
        panelExists: Boolean(panel),
        panelRole: panel?.getAttribute('role') ?? null,
        panelLabelledBy: panel?.getAttribute('aria-labelledby') ?? null,
        iconAriaHidden: tab.querySelector('b')?.getAttribute('aria-hidden') ?? null,
      };
    }),
  }))()`);
  report.interactionAssertions.push(
    assertion('A 390x844 mobile navigation has tablist role', mobileTabs.tablistRole === 'tablist', mobileTabs.tablistRole, 'tablist'),
    assertion(
      'A 390x844 tabs link to labelled tabpanels',
      mobileTabs.tabs.length > 0 && mobileTabs.tabs.every((tab) => tab.role === 'tab' && tab.panelExists && tab.panelRole === 'tabpanel' && tab.panelLabelledBy === tab.id),
      mobileTabs.tabs,
      'each tab aria-controls a tabpanel whose aria-labelledby is the tab id',
    ),
    assertion(
      'A 390x844 tabs have one aria-selected and keyboard-focusable active tab',
      mobileTabs.tabs.filter(({ selected }) => selected === 'true').length === 1
        && mobileTabs.tabs.filter(({ tabindex }) => tabindex === '0').length === 1
        && mobileTabs.tabs.every(({ selected, tabindex }) => selected === 'true' ? tabindex === '0' : selected === 'false' && tabindex === '-1'),
      mobileTabs.tabs.map(({ id, selected, tabindex }) => ({ id, selected, tabindex })),
      'one aria-selected=true tab with tabindex=0; all others aria-selected=false with tabindex=-1',
    ),
    assertion('A 390x844 tab icons are aria-hidden', mobileTabs.tabs.length > 0 && mobileTabs.tabs.every(({ iconAriaHidden }) => iconAriaHidden === 'true'), mobileTabs.tabs.map(({ id, iconAriaHidden }) => ({ id, iconAriaHidden })), 'all true'),
  );

  const inertFocus = await evaluate(`(async () => {
    const read = () => [...document.querySelectorAll('[role="tabpanel"]')].map((panel) => ({
      id: panel.id,
      hidden: panel.getAttribute('aria-hidden'),
      inert: panel.hasAttribute('inert'),
      activeInside: panel.contains(document.activeElement),
    }));
    const before = read();
    document.querySelector('#mobile-tab-spaces').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { before, after: read(), activeElementId: document.activeElement?.id ?? null };
  })()`);
  const panelStateValid = (panels) => panels.filter(({ hidden }) => hidden === 'false').length === 1
    && panels.every(({ hidden, inert }) => hidden === 'false' ? !inert : hidden === 'true' && inert);
  report.interactionAssertions.push(assertion(
    'A 390x844 inactive panels are inert and selected-panel focus is restored',
    panelStateValid(inertFocus.before) && panelStateValid(inertFocus.after)
      && inertFocus.activeElementId === 'mobile-tab-spaces'
      && inertFocus.after.every(({ hidden, activeInside }) => hidden === 'false' || !activeInside),
    inertFocus,
    'exactly one non-inert aria-visible tabpanel before/after; focus on mobile-tab-spaces and never inside an inert panel',
  ));

  const requestedFurnitureTypes = [
    'toilet', 'washbasin', 'kitchenSink', 'kitchenIsland', 'laundryTower',
    'clothesRackSingle', 'clothesRackDoubleRow', 'clothesRackDoubleTier',
  ];
  const mobileRequestedFurniture = await evaluate(`(async () => {
    document.querySelector('#mobile-tab-furniture').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return ${JSON.stringify([
      'toilet', 'washbasin', 'kitchenSink', 'kitchenIsland', 'laundryTower',
      'clothesRackSingle', 'clothesRackDoubleRow', 'clothesRackDoubleTier',
    ])}.map((type) => {
      const button = document.querySelector('[data-add-type="' + type + '"]');
      const rect = button?.getBoundingClientRect();
      return { type, name: button?.querySelector('strong')?.textContent ?? null, width: rect?.width ?? 0, height: rect?.height ?? 0 };
    });
  })()`);
  report.screenshots.push(await screenshot('mobile-requested-furniture-library-390x844'));
  report.interactionAssertions.push(assertion(
    'A requested bathroom, kitchen, laundry, and rack furniture are mobile 44px targets',
    mobileRequestedFurniture.map(({ type }) => type).join(',') === requestedFurnitureTypes.join(',')
      && mobileRequestedFurniture.every(({ name, width, height }) => name && width >= 44 && height >= 44),
    mobileRequestedFurniture,
    'all eight requested furniture buttons have names and measure at least 44x44',
  ));
  await evaluate(`(async () => {
    document.querySelector('#mobile-tab-spaces').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);

  const mobileStructureControls = await evaluate(`(() => [...document.querySelectorAll('[data-add-structure]')].map((button) => {
    const rect = button.getBoundingClientRect();
    return { type: button.dataset.addStructure, width: rect.width, height: rect.height };
  }))()`);
  report.screenshots.push(await screenshot('mobile-wall-door-library-390x844'));
  report.interactionAssertions.push(assertion(
    'A 390x844 wall, door, and window controls are visible 44px targets',
    mobileStructureControls.map(({ type }) => type).sort().join(',') === 'sliding,swing,wall,window'
      && mobileStructureControls.every(({ width, height }) => width >= 44 && height >= 44),
    mobileStructureControls,
    'wall/sliding/swing/window buttons each measure at least 44x44',
  ));
  await evaluate(`(() => {
    document.querySelector('[data-add-structure="wall"]').click();
    document.querySelector('[data-add-structure="swing"]').click();
  })()`);
  await evaluate(`(() => {
    const node = document.querySelector('.plan-door.is-selected');
    const rect = node.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, pointerId: 12, pointerType: 'touch', isPrimary: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    node.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
  })()`);
  await doubleRaf();
  const mobileDoorActions = await evaluate(`(() => [...document.querySelectorAll('[data-context-door-opening]')].map((button) => {
    const rect = button.getBoundingClientRect();
    return { value: Number(button.dataset.contextDoorOpening), width: rect.width, height: rect.height };
  }))()`);
  await mouseClick(await centerOf('[data-context-door-opening="90"]'));
  const mobileOpenedDoor = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ doorType }) => doorType === 'swing')`);
  report.interactionAssertions.push(assertion(
    'A mobile selected door exposes 44px close/open actions and persists opening',
    mobileDoorActions.map(({ value }) => value).join(',') === '0,90'
      && mobileDoorActions.every(({ width, height }) => width >= 44 && height >= 44)
      && mobileOpenedDoor.openAngle === 90,
    { mobileDoorActions, openAngle: mobileOpenedDoor.openAngle },
    '44px close/open actions and openAngle 90',
  ));

  const hostileLayout = {
    wallHeight: 240,
    zones: [{ id: '\" onpointerdown=window.__zoneIdInjected=1', spaceId: '\"><img id=space-id-injection>', name: 'Hostile zone', type: '방', x: '0\" onpointerdown=window.__zoneIdInjected=2', y: 0, width: 400, depth: 300, height: 240, color: '\"><img id=layout-color-injection src=x onerror=window.__layoutColorInjected=1>' }],
    items: [{ id: '\" onclick=window.__itemIdInjected=1', name: 'Hostile item', type: 'desk', shape: 'rect', x: 150, y: 120, width: 100, depth: 60, height: 70, elevation: 0, rotation: '0\" onclick=window.__itemIdInjected=2', color: 'red;fill:url(javascript:window.__layoutColorInjected=2)' }],
    structures: [
      { id: 'hostile-wall', type: 'wall', name: 'Hostile wall', x: 200, y: 220, length: 40, height: 240, thickness: 4, orientation: 'horizontal' },
      { id: '\"><img id=structure-injection src=x onerror=window.__structureInjected=1>', type: 'door', doorType: 'sliding\" onpointerdown=window.__structureInjected=2', name: 'Hostile door', x: 200, y: 220, width: 300, height: 205, orientation: 'diagonal', wallId: 'hostile-wall' },
    ],
  };
  await evaluate(`localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(hostileLayout))})`);
  await loadViewport(pageUrl, 390, 844, true);
  const hostileResult = await evaluate(`(() => {
    const readStructureField = (name, field) => {
      [...document.querySelectorAll('[data-select-structure]')].find((button) => button.textContent.includes(name))?.click();
      return Number(document.querySelector('[data-structure-field="' + field + '"]')?.value);
    };
    const wallLength = readStructureField('Hostile wall', 'length');
    const doorWidth = readStructureField('Hostile door', 'width');
    return {
      zoneFill: document.querySelector('.plan-zone rect:not(.zone-hit-target)')?.getAttribute('fill') ?? null,
      itemFill: document.querySelector('.plan-item .item-shape')?.getAttribute('fill') ?? null,
      injectionNodes: document.querySelectorAll('#layout-color-injection, img[onerror], iframe[src^="javascript:"]').length,
      injectedValue: window.__layoutColorInjected ?? 0,
      htmlContainsPayload: document.documentElement.innerHTML.includes('layout-color-injection'),
      structureInjectionNodes: document.querySelectorAll('#structure-injection, [onpointerdown]').length,
      structureInjectedValue: window.__structureInjected ?? 0,
      normalizedStructure: Boolean(document.querySelector('.plan-door.door-swing')) && !document.documentElement.innerHTML.includes('sliding\\" onpointerdown'),
      normalizedZoneItemIds: /^[\\w-]+$/.test(document.querySelector('.plan-zone')?.dataset.zoneId ?? '')
        && /^[\\w-]+$/.test(document.querySelector('.plan-item')?.dataset.itemId ?? ''),
      zoneItemInjectedValue: (window.__zoneIdInjected ?? 0) + (window.__itemIdInjected ?? 0),
      zoneItemPayloadPresent: document.documentElement.innerHTML.includes('space-id-injection')
        || document.documentElement.innerHTML.includes('zoneIdInjected') || document.documentElement.innerHTML.includes('itemIdInjected'),
      wallLength,
      doorWidth,
    };
  })()`);
  report.interactionAssertions.push(assertion(
    'A malicious saved-layout colors use safe fallbacks without markup or script injection',
    hostileResult.zoneFill === '#d9d2c2' && hostileResult.itemFill === '#d8b596'
      && hostileResult.injectionNodes === 0 && hostileResult.injectedValue === 0 && !hostileResult.htmlContainsPayload
      && hostileResult.structureInjectionNodes === 0 && hostileResult.structureInjectedValue === 0 && hostileResult.normalizedStructure
      && hostileResult.normalizedZoneItemIds && hostileResult.zoneItemInjectedValue === 0 && !hostileResult.zoneItemPayloadPresent
      && hostileResult.wallLength === 50 && hostileResult.doorWidth === 50,
    hostileResult,
    { zoneFill: '#d9d2c2', itemFill: '#d8b596', injectionNodes: 0, injectedValue: 0, htmlContainsPayload: false, structureInjectionNodes: 0, structureInjectedValue: 0, normalizedStructure: true, wallLength: 50, doorWidth: 50 },
  ));

  // B: browser-generated touch pointer streams for 2D gestures.
  await reloadViewport(pageUrl, 390, 844, true);
  await evaluate(`document.querySelector('#zoom-out').click(); document.querySelector('#zoom-out').click()`);
  await doubleRaf();
  const blank = await evaluate(`(() => {
    const rect = document.querySelector('#plan-canvas').getBoundingClientRect();
    let start = null;
    for (let y = rect.top + 5; y < rect.bottom - 5 && !start; y += 10) {
      for (let x = rect.left + 5; x < rect.right - 5; x += 10) {
        if (document.elementFromPoint(x, y)?.classList.contains('grid-background')) { start = { x, y }; break; }
      }
    }
    return { start, before: document.querySelector('#plan-canvas').getAttribute('viewBox'), storage: JSON.stringify(localStorage) };
  })()`);
  const blankEnd = { x: blank.start.x + 64, y: blank.start.y + 46 };
  await dispatchTouch('touchStart', [touchPoint(1, blank.start)]);
  await dispatchTouch('touchMove', [touchPoint(1, blankEnd)]);
  await dispatchTouch('touchEnd', []);
  await doubleRaf();
  const blankAfter = await evaluate(`({ viewBox: document.querySelector('#plan-canvas').getAttribute('viewBox'), storage: JSON.stringify(localStorage), selected: document.querySelectorAll('.is-selected').length })`);
  report.interactionAssertions.push(assertion(
    'B real CDP blank touch drag pans without persisting an edit',
    blank.before !== blankAfter.viewBox && blank.storage === blankAfter.storage,
    { transport: 'Input.dispatchTouchEvent', before: blank, after: blankAfter },
    'viewBox changes while serialized localStorage stays identical',
  ));

  await reloadViewport(pageUrl, 390, 844, true);
  const pinchBase = await centerOf('#plan-canvas');
  const p1 = { x: pinchBase.x - 45, y: pinchBase.y };
  const p2 = { x: pinchBase.x + 45, y: pinchBase.y };
  const p1Wide = { x: pinchBase.x - 100, y: pinchBase.y };
  const p2Wide = { x: pinchBase.x + 100, y: pinchBase.y };
  const pinchBefore = await evaluate(`document.querySelector('#plan-canvas').getAttribute('viewBox')`);
  await dispatchTouch('touchStart', [touchPoint(1, p1)]);
  await dispatchTouch('touchStart', [touchPoint(1, p1), touchPoint(2, p2)]);
  await dispatchTouch('touchMove', [touchPoint(1, p1Wide), touchPoint(2, p2Wide)]);
  const pinchZoomed = await evaluate(`document.querySelector('#plan-canvas').getAttribute('viewBox')`);
  await dispatchTouch('touchEnd', [touchPoint(1, p1Wide)]);
  const afterOneRelease = await evaluate(`document.querySelector('#plan-canvas').getAttribute('viewBox')`);
  await dispatchTouch('touchMove', [touchPoint(1, { x: p1Wide.x - 50, y: p1Wide.y + 40 })]);
  const afterRemainingMove = await evaluate(`document.querySelector('#plan-canvas').getAttribute('viewBox')`);
  await dispatchTouch('touchEnd', []);
  report.interactionAssertions.push(assertion(
    'B real CDP pinch enters await-release and ignores the remaining contact',
    pinchZoomed !== pinchBefore && afterOneRelease === afterRemainingMove,
    { transport: 'Input.dispatchTouchEvent', pinchBefore, pinchZoomed, afterOneRelease, afterRemainingMove },
    'pinch changes viewBox; releasing either contact freezes exact viewBox until all contacts release',
  ));

  await reloadViewport(pageUrl, 390, 844, true);
  const pinchLimitBase = await centerOf('#plan-canvas');
  const minStart1 = { x: pinchLimitBase.x - 100, y: pinchLimitBase.y };
  const minStart2 = { x: pinchLimitBase.x + 100, y: pinchLimitBase.y };
  const minEnd1 = { x: pinchLimitBase.x - 2, y: pinchLimitBase.y };
  const minEnd2 = { x: pinchLimitBase.x + 2, y: pinchLimitBase.y };
  await dispatchTouch('touchStart', [touchPoint(11, minStart1)]);
  await dispatchTouch('touchStart', [touchPoint(11, minStart1), touchPoint(12, minStart2)]);
  await dispatchTouch('touchMove', [touchPoint(11, minEnd1), touchPoint(12, minEnd2)]);
  await dispatchTouch('touchEnd', []);
  await doubleRaf();
  const pinchMinimum = await evaluate(`document.querySelector('#zoom-level').textContent`);
  await reloadViewport(pageUrl, 390, 844, true);
  const maxStart1 = { x: pinchLimitBase.x - 20, y: pinchLimitBase.y };
  const maxStart2 = { x: pinchLimitBase.x + 20, y: pinchLimitBase.y };
  const maxEnd1 = { x: pinchLimitBase.x - 170, y: pinchLimitBase.y };
  const maxEnd2 = { x: pinchLimitBase.x + 170, y: pinchLimitBase.y };
  await dispatchTouch('touchStart', [touchPoint(13, maxStart1)]);
  await dispatchTouch('touchStart', [touchPoint(13, maxStart1), touchPoint(14, maxStart2)]);
  await dispatchTouch('touchMove', [touchPoint(13, maxEnd1), touchPoint(14, maxEnd2)]);
  await dispatchTouch('touchEnd', []);
  await doubleRaf();
  const pinchMaximum = await evaluate(`document.querySelector('#zoom-level').textContent`);
  report.interactionAssertions.push(assertion(
    'B real CDP pinch clamps canvas zoom to 5 and 600 percent',
    pinchMinimum === '5%' && pinchMaximum === '600%',
    { transport: 'Input.dispatchTouchEvent', pinchMinimum, pinchMaximum },
    { pinchMinimum: '5%', pinchMaximum: '600%' },
  ));

  await reloadViewport(pageUrl, 390, 844, true);
  let mobileItemCenter = await centerOf('.plan-item');
  await dispatchTouch('touchStart', [touchPoint(21, mobileItemCenter)]);
  await dispatchTouch('touchEnd', []);
  await doubleRaf();
  const firstTapMenu = await evaluate(`({
    selected: document.querySelectorAll('.plan-item.is-selected').length,
    menuOpen: Boolean(document.querySelector('.mobile-context-menu')),
    focusedAction: document.activeElement?.dataset?.contextAction ?? null,
    actions: [...document.querySelectorAll('[data-context-action]')].map((button) => {
      const rect = button.getBoundingClientRect();
      return { action: button.dataset.contextAction, width: rect.width, height: rect.height };
    }),
  })`);
  report.screenshots.push(await screenshot('mobile-entity-action-menu-390x844'));
  report.interactionAssertions.push(assertion(
    'B mobile first tap selects and opens the entity action menu',
    firstTapMenu.selected === 1 && firstTapMenu.menuOpen && firstTapMenu.focusedAction === 'move'
      && ['move', 'rotate', 'delete'].every((action) => firstTapMenu.actions.some((entry) => entry.action === action))
      && firstTapMenu.actions.every(({ width, height }) => width >= 44 && height >= 44),
    firstTapMenu,
    'first tap selects, focuses move, and exposes 44px move/rotate/delete actions',
  ));

  await keyStroke('Escape', 'Escape');
  const escapedMenu = await evaluate(`({ menuOpen: Boolean(document.querySelector('.mobile-context-menu')), activeElementId: document.activeElement?.id ?? null })`);
  report.interactionAssertions.push(assertion(
    'B mobile action menu closes with Escape and returns focus to the canvas',
    !escapedMenu.menuOpen && escapedMenu.activeElementId === 'plan-canvas',
    escapedMenu,
    { menuOpen: false, activeElementId: 'plan-canvas' },
  ));
  mobileItemCenter = await centerOf('.plan-item.is-selected');
  await dispatchTouch('touchStart', [touchPoint(24, mobileItemCenter)]);
  await dispatchTouch('touchEnd', []);
  await doubleRaf();

  const contextRotationBefore = await evaluate(`Number(document.querySelector('.plan-item.is-selected').getAttribute('transform').match(/rotate\\(([-\\d.]+)/)?.[1] ?? 0)`);
  await mouseClick(await centerOf('[data-context-action="rotate"]'));
  const contextRotationAfter = await evaluate(`({ rotation: Number(document.querySelector('.plan-item.is-selected').getAttribute('transform').match(/rotate\\(([-\\d.]+)/)?.[1] ?? 0), menuOpen: Boolean(document.querySelector('.mobile-context-menu')) })`);
  report.interactionAssertions.push(assertion(
    'B mobile action menu rotates the selected item once and closes',
    contextRotationAfter.rotation === (contextRotationBefore + 90) % 360 && !contextRotationAfter.menuOpen,
    { before: contextRotationBefore, after: contextRotationAfter },
    'rotation advances by 90 degrees and menu closes',
  ));

  const selectedDragStart = await centerOf('.plan-item.is-selected');
  const selectedDragBefore = await evaluate(`document.querySelector('.plan-item.is-selected').getAttribute('transform')`);
  await dispatchTouch('touchStart', [touchPoint(25, selectedDragStart)]);
  await dispatchTouch('touchMove', [touchPoint(25, { x: selectedDragStart.x + 54, y: selectedDragStart.y + 31 })]);
  await dispatchTouch('touchEnd', []);
  await doubleRaf();
  const selectedDragAfter = await evaluate(`document.querySelector('.plan-item.is-selected').getAttribute('transform')`);
  report.interactionAssertions.push(assertion(
    'B mobile selected entity drags immediately without pressing the move action',
    selectedDragAfter !== selectedDragBefore,
    { transport: 'Input.dispatchTouchEvent', selectedDragBefore, selectedDragAfter },
    'selected transform changes after a direct touch drag with no hold or move-button click',
  ));

  await evaluate(`document.querySelector('#zoom-out').click(); document.querySelector('#zoom-out').click()`);
  await doubleRaf();
  const blankTap = await evaluate(`(() => {
    const rect = document.querySelector('#plan-canvas').getBoundingClientRect();
    const occupied = [...document.querySelectorAll('[data-zone-id], [data-item-id]')].map((node) => node.getBoundingClientRect());
    for (let y = rect.top + 5; y < rect.bottom - 5; y += 10) {
      for (let x = rect.left + 5; x < rect.right - 5; x += 10) {
        const safelyBlank = occupied.every((bounds) => x < bounds.left - 32 || x > bounds.right + 32 || y < bounds.top - 32 || y > bounds.bottom + 32);
        if (safelyBlank && document.elementFromPoint(x, y)?.classList.contains('grid-background')) return { x, y };
      }
    }
    return null;
  })()`);
  await dispatchTouch('touchStart', [touchPoint(23, blankTap)]);
  await dispatchTouch('touchEnd', []);
  await doubleRaf();
  const blankTapResult = await evaluate(`({ selected: document.querySelectorAll('.is-selected').length, menuOpen: Boolean(document.querySelector('.mobile-context-menu')) })`);
  report.interactionAssertions.push(assertion(
    'B mobile blank tap clears selection and closes the action menu',
    blankTapResult.selected === 0 && !blankTapResult.menuOpen,
    blankTapResult,
    { selected: 0, menuOpen: false },
  ));

  await reloadViewport(pageUrl, 390, 844, true);
  const dragStart = await centerOf('.plan-item');
  const dragEnd = { x: dragStart.x + 54, y: dragStart.y + 31 };
  const dragOrigin = await evaluate(`document.querySelector('.plan-item').getAttribute('transform')`);
  const dragStorage = await evaluate(`JSON.stringify(Object.fromEntries(Object.entries(localStorage)))`);
  const dragSelectionBefore = await evaluate(`[...document.querySelectorAll('.is-selected')].map((node) => node.dataset.itemId ?? node.dataset.zoneId).sort()`);
  await dispatchTouch('touchStart', [touchPoint(1, dragStart)]);
  await dispatchTouch('touchMove', [touchPoint(1, dragEnd)]);
  await dispatchTouch('touchEnd', []);
  const quickDragResult = await evaluate(`document.querySelector('.plan-item').getAttribute('transform')`);
  await dispatchTouch('touchStart', [touchPoint(2, dragStart)]);
  await sleep(520);
  await dispatchTouch('touchMove', [touchPoint(2, dragEnd)]);
  const dragMoved = await evaluate(`document.querySelector('.plan-item').getAttribute('transform')`);
  const second = { x: dragStart.x - 65, y: dragStart.y };
  await dispatchTouch('touchStart', [touchPoint(2, dragEnd), touchPoint(3, second)]);
  const dragRolledBack = await evaluate(`({ transform: document.querySelector('.plan-item').getAttribute('transform'), storage: JSON.stringify(Object.fromEntries(Object.entries(localStorage))), undoDisabled: document.querySelector('#undo-action').disabled, selected: [...document.querySelectorAll('.is-selected')].map((node) => node.dataset.itemId ?? node.dataset.zoneId).sort(), menuOpen: Boolean(document.querySelector('.mobile-context-menu')) })`);
  await dispatchTouch('touchEnd', [touchPoint(2, dragEnd)]);
  await dispatchTouch('touchEnd', []);
  report.interactionAssertions.push(assertion(
    'B mobile movement requires a long press and second touch rolls the edit back before pinch',
    quickDragResult === dragOrigin && dragMoved !== dragOrigin
      && dragRolledBack.transform === dragOrigin && dragRolledBack.storage === dragStorage
      && dragRolledBack.undoDisabled && JSON.stringify(dragRolledBack.selected) === JSON.stringify(dragSelectionBefore)
      && !dragRolledBack.menuOpen,
    { transport: 'Input.dispatchTouchEvent', dragOrigin, dragSelectionBefore, quickDragResult, dragMoved, ...dragRolledBack },
    'quick swipe does not move; 520ms hold moves; second touch restores transform/storage/selection with undo disabled',
  ));

  await reloadViewport(pageUrl, 390, 844, true);
  const resizeItem = await centerOf('.plan-item');
  await dispatchTouch('touchStart', [touchPoint(61, resizeItem)]);
  await dispatchTouch('touchEnd', []);
  await doubleRaf();
  const mobileResizeBefore = await evaluate(`(() => {
    const item = document.querySelector('.plan-item.is-selected');
    const rect = item.querySelector('.item-shape rect');
    const ellipse = item.querySelector('.item-shape ellipse');
    return {
      id: item.dataset.itemId,
      width: rect ? Number(rect.getAttribute('width')) : Number(ellipse.getAttribute('rx')) * 2,
      depth: rect ? Number(rect.getAttribute('height')) : Number(ellipse.getAttribute('ry')) * 2,
    };
  })()`);
  const mobileResizeHandle = await centerOf('.resize-handle.handle-se');
  await dispatchTouch('touchStart', [touchPoint(62, mobileResizeHandle)]);
  await dispatchTouch('touchMove', [touchPoint(62, { x: mobileResizeHandle.x + 48, y: mobileResizeHandle.y + 36 })]);
  await dispatchTouch('touchEnd', []);
  await doubleRaf();
  const mobileResizeAfter = await evaluate(`(() => {
    const saved = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));
    const value = saved.items.find(({ id }) => id === ${JSON.stringify(mobileResizeBefore.id)});
    return { width: value.width, depth: value.depth, undoEnabled: !document.querySelector('#undo-action').disabled };
  })()`);
  report.interactionAssertions.push(assertion(
    'B real CDP touch drag on a resize handle changes both saved item dimensions',
    mobileResizeAfter.width !== mobileResizeBefore.width && mobileResizeAfter.depth !== mobileResizeBefore.depth && mobileResizeAfter.undoEnabled,
    { transport: 'Input.dispatchTouchEvent', before: mobileResizeBefore, after: mobileResizeAfter },
    'width/depth both change and one undo step becomes available',
  ));
  await mouseClick(await centerOf('#undo-action'));
  await doubleRaf();
  const mobileResizeUndo = await evaluate(`(() => {
    const saved = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));
    const value = saved.items.find(({ id }) => id === ${JSON.stringify(mobileResizeBefore.id)});
    return { width: value.width, depth: value.depth, undoDisabled: document.querySelector('#undo-action').disabled };
  })()`);
  const resizeReselect = await centerOf(`[data-item-id="${mobileResizeBefore.id}"]`);
  await dispatchTouch('touchStart', [touchPoint(63, resizeReselect)]);
  await dispatchTouch('touchEnd', []);
  await doubleRaf();
  const rollbackHandle = await centerOf('.resize-handle.handle-se');
  const rollbackStorage = await evaluate(`JSON.stringify(Object.fromEntries(Object.entries(localStorage)))`);
  await dispatchTouch('touchStart', [touchPoint(64, rollbackHandle)]);
  const rollbackMovedPoint = { x: rollbackHandle.x + 42, y: rollbackHandle.y + 30 };
  await dispatchTouch('touchMove', [touchPoint(64, rollbackMovedPoint)]);
  const rollbackSecondPoint = { x: rollbackHandle.x - 70, y: rollbackHandle.y - 40 };
  await dispatchTouch('touchStart', [touchPoint(64, rollbackMovedPoint), touchPoint(65, rollbackSecondPoint)]);
  const mobileResizeRolledBack = await evaluate(`({ storage: JSON.stringify(Object.fromEntries(Object.entries(localStorage))), undoDisabled: document.querySelector('#undo-action').disabled, selected: document.querySelectorAll('.is-selected').length })`);
  await dispatchTouch('touchEnd', [touchPoint(64, rollbackMovedPoint)]);
  await dispatchTouch('touchEnd', []);
  report.interactionAssertions.push(assertion(
    'B touch resize undo restores dimensions and a second touch rolls an in-flight resize back',
    mobileResizeUndo.width === mobileResizeBefore.width && mobileResizeUndo.depth === mobileResizeBefore.depth
      && mobileResizeUndo.undoDisabled && mobileResizeRolledBack.storage === rollbackStorage
      && mobileResizeRolledBack.undoDisabled && mobileResizeRolledBack.selected === 1,
    { undo: mobileResizeUndo, rollback: mobileResizeRolledBack },
    'undo restores original dimensions; second touch preserves storage/history and selected item',
  ));

  await reloadViewport(pageUrl, 390, 844, true);
  await mouseClick(await centerOf('#multi-select-action'));
  const mobileGroupDrag = await evaluate(`(async () => {
    const pointer = (target, type, point, pointerId) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: point.x,
      clientY: point.y,
    }));
    const center = (node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const tapUnselected = async (pointerId) => {
      const node = document.querySelector('.plan-item:not(.is-selected)');
      const point = center(node);
      pointer(node, 'pointerdown', point, pointerId);
      pointer(document, 'pointerup', point, pointerId);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    };
    await tapUnselected(31);
    await tapUnselected(32);
    const groupBar = {
      visible: Boolean(document.querySelector('.mobile-selection-bar')),
      count: document.querySelector('.mobile-selection-bar [data-selection-count]')?.textContent ?? '',
      buttons: [...document.querySelectorAll('.mobile-selection-bar button')].map((button) => {
        const rect = button.getBoundingClientRect();
        return { action: button.dataset.groupAction, width: rect.width, height: rect.height };
      }),
    };
    const rotationsBefore = Object.fromEntries([...document.querySelectorAll('.plan-item.is-selected')].map((node) => {
      const match = node.getAttribute('transform')?.match(/rotate\\(([-\\d.]+)/);
      return [node.dataset.itemId, Number(match?.[1] ?? 0)];
    }));
    document.querySelector('[data-group-action="rotate"]')?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rotationsAfter = Object.fromEntries([...document.querySelectorAll('.plan-item.is-selected')].map((node) => {
      const match = node.getAttribute('transform')?.match(/rotate\\(([-\\d.]+)/);
      return [node.dataset.itemId, Number(match?.[1] ?? 0)];
    }));
    document.querySelector('[data-group-action="move"]')?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const before = Object.fromEntries([...document.querySelectorAll('.plan-item.is-selected')].map((node) => [node.dataset.itemId, node.getAttribute('transform')]));
    const dragged = document.querySelector('.plan-item.is-selected');
    const start = center(dragged);
    const end = { x: start.x + 52, y: start.y + 36 };
    pointer(dragged, 'pointerdown', start, 33);
    pointer(document, 'pointermove', end, 33);
    pointer(document, 'pointerup', end, 33);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const after = Object.fromEntries([...document.querySelectorAll('.plan-item.is-selected')].map((node) => [node.dataset.itemId, node.getAttribute('transform')]));
    const translate = (value) => {
      const match = value?.match(/translate\\(([-\\d.]+)[ ,]+([-\\d.]+)/);
      return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
    };
    const deltas = Object.keys(before).filter((id) => after[id]).map((id) => {
      const origin = translate(before[id]);
      const moved = translate(after[id]);
      return { id, x: moved.x - origin.x, y: moved.y - origin.y };
    });
    const rotationsAdvanced = Object.keys(rotationsBefore).every((id) => rotationsAfter[id] === (rotationsBefore[id] + 90) % 360);
    return { transport: 'deterministic mobile PointerEvent', selectedCount: Object.keys(after).length, groupBar, rotationsBefore, rotationsAfter, rotationsAdvanced, before, after, deltas };
  })()`);
  const groupScroll = await evaluate(`(() => {
    document.scrollingElement?.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    window.scrollTo(0, 0);
    return { x: window.scrollX, y: window.scrollY, visualX: window.visualViewport?.offsetLeft ?? 0, visualY: window.visualViewport?.offsetTop ?? 0 };
  })()`);
  mobileGroupDrag.groupScroll = groupScroll;
  await doubleRaf();
  report.screenshots.push(await screenshot('mobile-group-action-bar-390x844'));
  report.interactionAssertions.push(assertion(
    'B mobile group bar exposes an explicit move action and moves selected items by equal deltas',
    mobileGroupDrag.groupScroll.x === 0 && mobileGroupDrag.groupScroll.y === 0
      && mobileGroupDrag.groupBar.visible && mobileGroupDrag.groupBar.buttons.every(({ width, height }) => width >= 44 && height >= 44)
      && mobileGroupDrag.rotationsAdvanced
      && mobileGroupDrag.selectedCount >= 2 && mobileGroupDrag.deltas.length >= 2
      && (mobileGroupDrag.deltas[0].x !== 0 || mobileGroupDrag.deltas[0].y !== 0)
      && mobileGroupDrag.deltas.every(({ x, y }) => x === mobileGroupDrag.deltas[0].x && y === mobileGroupDrag.deltas[0].y),
    mobileGroupDrag,
    'group bar visible, all selected items rotate 90 degrees, and at least two move by the same nonzero SVG x/y delta',
  ));

  await reloadViewport(pageUrl, 390, 844, true);
  await mouseClick(await centerOf('#multi-select-action'));
  const mobileMarquee = await evaluate(`(async () => {
    const items = [...document.querySelectorAll('.plan-item')].slice(0, 2).map((node) => {
      const rect = node.getBoundingClientRect();
      return { id: node.dataset.itemId, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    const start = { x: Math.min(...items.map(({ left }) => left)) - 8, y: Math.min(...items.map(({ top }) => top)) - 8 };
    const end = { x: Math.max(...items.map(({ right }) => right)) + 8, y: Math.max(...items.map(({ bottom }) => bottom)) + 8 };
    const pointer = (target, type, point) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 41,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: point.x,
      clientY: point.y,
    }));
    pointer(document.querySelector('.grid-background'), 'pointerdown', start);
    pointer(document, 'pointermove', end);
    const during = { marqueePresent: Boolean(document.querySelector('.selection-marquee')), selectedCount: document.querySelectorAll('.is-selected').length };
    pointer(document, 'pointerup', end);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const after = { marqueePresent: Boolean(document.querySelector('.selection-marquee')), selectedCount: document.querySelectorAll('.is-selected').length };
    return { transport: 'deterministic mobile PointerEvent', items, start, end, during, after };
  })()`);
  report.interactionAssertions.push(assertion(
    'B mobile multi-select blank drag shows then clears a marquee and selects at least two entities',
    mobileMarquee.during.marqueePresent && !mobileMarquee.after.marqueePresent && mobileMarquee.after.selectedCount >= 2,
    mobileMarquee,
    'marquee present during move, absent after release, and at least two entities selected',
  ));

  await reloadViewport(pageUrl, 390, 844, true);
  const hitTargetEvidence = await evaluate(`(async () => {
    const pointer = (target, type, point) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 51,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: point.x,
      clientY: point.y,
    }));
    const center = (node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const probeZoneHalo = (zoneId) => {
      const groups = zoneId
        ? [document.querySelector('[data-zone-id="' + CSS.escape(zoneId) + '"]')].filter(Boolean)
        : [...document.querySelectorAll('.plan-zone')];
      for (const group of groups) {
        const hit = group.querySelector('.zone-hit-target');
        const visual = group.querySelector('rect:not(.zone-hit-target)');
        if (!hit || !visual) continue;
        const rect = visual.getBoundingClientRect();
        const candidates = [
          { edge: 'left', x: rect.left - 10, y: rect.top + rect.height / 2 },
          { edge: 'right', x: rect.right + 10, y: rect.top + rect.height / 2 },
          { edge: 'top', x: rect.left + rect.width / 2, y: rect.top - 10 },
          { edge: 'bottom', x: rect.left + rect.width / 2, y: rect.bottom + 10 },
        ];
        for (const point of candidates) {
          if (point.x < 0 || point.y < 0 || point.x >= innerWidth || point.y >= innerHeight) continue;
          const resolved = document.elementFromPoint(point.x, point.y);
          if (resolved !== hit) continue;
          return {
            zoneId: group.dataset.zoneId,
            selected: group.classList.contains('is-selected'),
            edge: point.edge,
            point: { x: point.x, y: point.y },
            visualRect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
            outsideVisibleFill: point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom,
            resolvedClass: resolved.getAttribute('class'),
            resolvesZoneHitTarget: true,
          };
        }
      }
      return null;
    };
    const normalHalo = probeZoneHalo();
    const zone = normalHalo ? document.querySelector('[data-zone-id="' + CSS.escape(normalHalo.zoneId) + '"]') : document.querySelector('.plan-zone');
    const zonePoint = normalHalo?.point ?? center(zone);
    pointer(zone, 'pointerdown', zonePoint);
    pointer(document, 'pointerup', zonePoint);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const selectedHalo = probeZoneHalo(normalHalo?.zoneId ?? zone.dataset.zoneId);
    const item = document.querySelector('.plan-item');
    const point = center(item);
    pointer(item, 'pointerdown', point);
    pointer(document, 'pointerup', point);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const inspect = (label) => {
      const zoneHit = document.querySelector('.zone-hit-target');
      const zoneVisual = zoneHit?.parentElement?.querySelector('rect:not(.zone-hit-target)');
      const itemHit = document.querySelector('.item-hit-target > *');
      const itemVisual = document.querySelector('.item-shape > *');
      const resizeHit = document.querySelector('.resize-hit-target');
      const resizeVisual = resizeHit?.nextElementSibling;
      const read = (hit, visual) => {
        const style = hit ? getComputedStyle(hit) : null;
        return {
          exists: Boolean(hit),
          separateVisibleNode: Boolean(hit && visual && hit !== visual),
          strokeWidth: style?.strokeWidth ?? null,
          strokeWidthValue: style ? Number.parseFloat(style.strokeWidth) : null,
          vectorEffect: style?.vectorEffect ?? null,
        };
      };
      return { label, zone: read(zoneHit, zoneVisual), item: read(itemHit, itemVisual), resize: read(resizeHit, resizeVisual) };
    };
    const results = [inspect(document.querySelector('#zoom-level').textContent)];
    document.querySelector('#zoom-out').click();
    document.querySelector('#zoom-out').click();
    results.push(inspect(document.querySelector('#zoom-level').textContent));
    for (let index = 0; index < 22; index += 1) document.querySelector('#zoom-in').click();
    results.push(inspect(document.querySelector('#zoom-level').textContent));
    return { halo: { normal: normalHalo, selected: selectedHalo }, zooms: results };
  })()`);
  const validHitTarget = ({ exists, separateVisibleNode, strokeWidthValue, vectorEffect }) => exists && separateVisibleNode && strokeWidthValue === 44 && vectorEffect === 'non-scaling-stroke';
  report.interactionAssertions.push(assertion(
    'B SVG zone item and resize hit targets stay separate 44px non-scaling strokes at 100 50 and 600 percent zoom',
    hitTargetEvidence.zooms.map(({ label }) => label).join(',') === '100%,50%,600%'
      && hitTargetEvidence.zooms.every(({ zone, item, resize }) => [zone, item, resize].every(validHitTarget))
      && [hitTargetEvidence.halo.normal, hitTargetEvidence.halo.selected].every((probe) => probe?.outsideVisibleFill && probe.resolvesZoneHitTarget)
      && hitTargetEvidence.halo.normal.zoneId === hitTargetEvidence.halo.selected.zoneId
      && !hitTargetEvidence.halo.normal.selected && hitTargetEvidence.halo.selected.selected,
    hitTargetEvidence,
    '100%, 50%, and 600% each use separate visible zone/item/resize nodes with computed stroke-width 44 and non-scaling-stroke; normal and selected 10px halo probes resolve the same zone hit target',
  ));

  await reloadViewport(pageUrl, 768, 1024, true);
  const breakpointBefore = await evaluate(`(() => {
    const windowToken = crypto.randomUUID();
    const documentToken = crypto.randomUUID();
    Object.defineProperty(window, '__auditBreakpointWindowToken', { value: windowToken });
    Object.defineProperty(document, '__auditBreakpointDocumentToken', { value: documentToken });
    return {
      token: { window: windowToken, document: documentToken },
      panels: [...document.querySelectorAll('[role="tabpanel"]')].map((panel) => ({
        id: panel.id,
        ariaHidden: panel.getAttribute('aria-hidden'),
        inert: panel.hasAttribute('inert'),
      })),
    };
  })()`);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1024,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitForExpression(`(() => {
    const panels = [...document.querySelectorAll('[role="tabpanel"]')];
    return panels.length > 0 && panels.every((panel) => panel.getAttribute('aria-hidden') === 'false' && !panel.hasAttribute('inert'));
  })()`, 'desktop tabpanels after no-reload breakpoint change');
  const breakpointDesktop = await evaluate(`([...document.querySelectorAll('[role="tabpanel"]')].map((panel) => ({
    id: panel.id,
    ariaHidden: panel.getAttribute('aria-hidden'),
    inert: panel.hasAttribute('inert'),
  })))`);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 768,
    height: 1024,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await waitForExpression(`(() => {
    const panels = [...document.querySelectorAll('[role="tabpanel"]')];
    return panels.filter((panel) => panel.getAttribute('aria-hidden') === 'false' && !panel.hasAttribute('inert')).length === 1
      && panels.every((panel) => panel.getAttribute('aria-hidden') === 'false' ? !panel.hasAttribute('inert') : panel.getAttribute('aria-hidden') === 'true' && panel.hasAttribute('inert'));
  })()`, 'mobile tabpanels after no-reload breakpoint change');
  const breakpointAfter = await evaluate(`(() => ({
    token: {
      window: window.__auditBreakpointWindowToken ?? null,
      document: document.__auditBreakpointDocumentToken ?? null,
    },
    panels: [...document.querySelectorAll('[role="tabpanel"]')].map((panel) => ({
      id: panel.id,
      ariaHidden: panel.getAttribute('aria-hidden'),
      inert: panel.hasAttribute('inert'),
    })),
  }))()`);
  const breakpointMobileStateValid = (panels) => panels.filter(({ ariaHidden, inert }) => ariaHidden === 'false' && !inert).length === 1
    && panels.every(({ ariaHidden, inert }) => ariaHidden === 'false' ? !inert : ariaHidden === 'true' && inert);
  report.interactionAssertions.push(assertion(
    'A tabpanels rerender across the 900px breakpoint without navigation or reload',
    breakpointMobileStateValid(breakpointBefore.panels)
      && breakpointDesktop.length > 0
      && breakpointDesktop.every(({ ariaHidden, inert }) => ariaHidden === 'false' && !inert)
      && breakpointMobileStateValid(breakpointAfter.panels)
      && breakpointBefore.token.window === breakpointAfter.token.window
      && breakpointBefore.token.document === breakpointAfter.token.document,
    { before: breakpointBefore.panels, desktop: breakpointDesktop, after: breakpointAfter.panels, tokenBefore: breakpointBefore.token, tokenAfter: breakpointAfter.token },
    'one active mobile panel, then all desktop panels active, then one active mobile panel again, with unchanged window/document tokens',
  ));

  async function openWalkthrough() {
    await mouseClick(await centerOf('#open-walkthrough'));
    await waitForExpression(`document.querySelector('[data-walkthrough-ready="true"]') !== null`, '3D walkthrough ready');
    await mouseClick(await centerOf('[data-walkthrough-start]'));
    await waitForExpression(`document.querySelector('.walkthrough-overlay.is-active') !== null`, '3D navigation active');
    await sleep(120);
  }

  async function walkthroughState() {
    return evaluate(`(() => {
      const visible = (node) => {
        if (!node) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const joystick = document.querySelector('[data-walkthrough-joystick]');
      const joystickRect = joystick?.getBoundingClientRect();
      const exitRect = document.querySelector('[data-walkthrough-exit]')?.getBoundingClientRect();
      return {
        mapTransform: document.querySelector('[data-map-player]')?.getAttribute('transform') ?? null,
        joystick: joystickRect ? { width: joystickRect.width, height: joystickRect.height, visible: visible(joystick) } : null,
        exit: exitRect ? { width: exitRect.width, height: exitRect.height } : null,
        lookGuideVisible: visible(document.querySelector('[data-look-zone]')),
        directionConeVisible: visible(document.querySelector('.walkthrough-view-cone')),
        keyboardHudVisible: visible(document.querySelector('[data-walkthrough-controls]')),
        canvasLabel: document.querySelector('[data-walkthrough-canvas]')?.getAttribute('aria-label') ?? null,
        canvasFocused: document.activeElement === document.querySelector('[data-walkthrough-canvas]'),
        menuInert: document.querySelector('[data-walkthrough-menu]')?.inert ?? false,
        menuAriaHidden: document.querySelector('[data-walkthrough-menu]')?.getAttribute('aria-hidden') ?? null,
        lastDoorAction: document.querySelector('[data-walkthrough]')?.dataset.lastDoorAction ?? null,
        overlayCount: document.querySelectorAll('[data-walkthrough]').length,
      };
    })()`);
  }

  // C: coarse-pointer 3D portrait and landscape gates.
  for (const [width, height] of [[600, 800], [844, 390]]) {
    await reloadViewport(pageUrl, width, height, true);
    const errorStart = browserErrors.length;
    await openWalkthrough();
    const initial = await walkthroughState();
    report.interactionAssertions.push(assertion(
      `C coarse 3D ${width}x${height} shows joystick/right-look controls and hides keyboard HUD`,
      initial.joystick?.visible && initial.joystick.width >= 44 && initial.joystick.height >= 44
        && initial.exit?.width >= 44 && initial.exit.height >= 44
        && initial.lookGuideVisible && initial.directionConeVisible && !initial.keyboardHudVisible
        && initial.canvasFocused && initial.menuInert && initial.menuAriaHidden === 'true',
      initial,
      'joystick/right-look/direction cone visible, keyboard HUD hidden, and focus moved to canvas while menu is inert',
    ));

    const joystickCenter = await centerOf('[data-walkthrough-joystick]');
    const joystickDiagonal = { x: joystickCenter.x + 34, y: joystickCenter.y - 34 };
    const before = parseTransform(initial.mapTransform);
    await dispatchTouch('touchStart', [touchPoint(11, joystickCenter)]);
    await dispatchTouch('touchMove', [touchPoint(11, joystickDiagonal)]);
    await sleep(420);
    const moving = parseTransform((await walkthroughState()).mapTransform);
    await dispatchTouch('touchEnd', []);
    await sleep(220);
    const stopped1 = parseTransform((await walkthroughState()).mapTransform);
    await sleep(220);
    const stopped2 = parseTransform((await walkthroughState()).mapTransform);
    report.interactionAssertions.push(assertion(
      `C coarse 3D ${width}x${height} analog diagonal movement and touchEnd have zero drift`,
      distance(before, moving) > 0.5 && distance(stopped1, stopped2) < 0.05,
      { transport: 'Input.dispatchTouchEvent', before, moving, stopped1, stopped2, moved: distance(before, moving), drift: distance(stopped1, stopped2) },
      'movement >0.5 plan units and post-touchEnd drift <0.05',
    ));

    await dispatchTouch('touchStart', [touchPoint(13, joystickCenter)]);
    await dispatchTouch('touchMove', [touchPoint(13, { x: joystickCenter.x, y: joystickCenter.y + 34 })]);
    await sleep(120);
    await dispatchTouch('touchCancel', []);
    await sleep(180);
    const cancel1 = parseTransform((await walkthroughState()).mapTransform);
    await sleep(220);
    const cancel2 = parseTransform((await walkthroughState()).mapTransform);
    report.interactionAssertions.push(assertion(
      `C coarse 3D ${width}x${height} touchCancel stops with zero drift`,
      distance(cancel1, cancel2) < 0.05,
      { transport: 'Input.dispatchTouchEvent touchCancel', cancel1, cancel2, drift: distance(cancel1, cancel2) },
      'post-touchCancel drift <0.05',
    ));

    await evaluate(`(() => {
      window.__auditJoystickPointerId = null;
      document.querySelector('[data-walkthrough-joystick]').addEventListener('pointerdown', (event) => { window.__auditJoystickPointerId = event.pointerId; }, { once: true });
    })()`);
    await dispatchTouch('touchStart', [touchPoint(14, joystickCenter)]);
    await dispatchTouch('touchMove', [touchPoint(14, { x: joystickCenter.x + 34, y: joystickCenter.y })]);
    await sleep(100);
    const captureResult = await evaluate(`(() => {
      const joystick = document.querySelector('[data-walkthrough-joystick]');
      const pointerId = window.__auditJoystickPointerId;
      const hadCapture = pointerId !== null && joystick.hasPointerCapture(pointerId);
      if (hadCapture) joystick.releasePointerCapture(pointerId);
      joystick.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId, pointerType: 'touch' }));
      return { pointerId, hadCapture, dispatchedLostPointerCapture: true, hasCaptureAfterRelease: pointerId !== null && joystick.hasPointerCapture(pointerId) };
    })()`);
    await sleep(180);
    const lost1 = parseTransform((await walkthroughState()).mapTransform);
    await sleep(220);
    const lost2 = parseTransform((await walkthroughState()).mapTransform);
    await dispatchTouch('touchEnd', []);
    report.interactionAssertions.push(assertion(
      `C coarse 3D ${width}x${height} lostpointercapture deterministically clears movement`,
      captureResult.hadCapture && !captureResult.hasCaptureAfterRelease && distance(lost1, lost2) < 0.05,
      { captureResult, lost1, lost2, drift: distance(lost1, lost2) },
      'real touch owns pointer capture, explicit release loses it, and drift <0.05',
    ));

    const canvasRect = await evaluate(`(() => {
      const rect = document.querySelector('[data-walkthrough-canvas]').getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    })()`);
    const lookStart = { x: canvasRect.left + canvasRect.width * 0.72, y: canvasRect.top + canvasRect.height * 0.48 };
    const lookEnd = { x: lookStart.x - 90, y: lookStart.y + 24 };
    const lookBefore = parseTransform((await walkthroughState()).mapTransform);
    await dispatchTouch('touchStart', [touchPoint(15, lookStart)]);
    await dispatchTouch('touchMove', [touchPoint(15, lookEnd)]);
    await dispatchTouch('touchEnd', []);
    await sleep(180);
    const lookAfter = parseTransform((await walkthroughState()).mapTransform);
    report.interactionAssertions.push(assertion(
      `C coarse 3D ${width}x${height} right-side drag changes view direction`,
      lookBefore && lookAfter && Math.abs(lookAfter.rotation - lookBefore.rotation) > 0.5,
      { transport: 'Input.dispatchTouchEvent', lookBefore, lookAfter, rotationDelta: lookAfter && lookBefore ? lookAfter.rotation - lookBefore.rotation : null },
      'right-side drag changes minimap/camera rotation by >0.5 degrees',
    ));

    await mouseClick(await centerOf('[data-walkthrough-exit]'));
    await waitForExpression(`document.querySelector('[data-walkthrough]') === null`, '3D close cleanup');
    await openWalkthrough();
    const reopened1 = parseTransform((await walkthroughState()).mapTransform);
    await sleep(260);
    const reopened2 = parseTransform((await walkthroughState()).mapTransform);
    report.interactionAssertions.push(assertion(
      `C coarse 3D ${width}x${height} close/reopen has no stale movement`,
      distance(reopened1, reopened2) < 0.05,
      { reopened1, reopened2, drift: distance(reopened1, reopened2) },
      'reopened walkthrough remains stationary with drift <0.05',
    ));
    report.screenshots.push(await screenshot(`coarse-3d-${width}x${height}`));
    await mouseClick(await centerOf('[data-walkthrough-exit]'));
    report.interactionAssertions.push(noConsoleAssertion(`C coarse 3D ${width}x${height}`, browserErrors.slice(errorStart)));
  }

  // D: desktop mouse/keyboard and desktop 3D gates.
  await reloadViewport(pageUrl, 1440, 1000, false);
  const desktopErrorStart = browserErrors.length;
  const desktopUi = await evaluate(`(() => {
    const visible = (node) => node && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    return { mobileNavVisible: visible(document.querySelector('.mobile-nav')), workspaceVisible: visible(document.querySelector('.workspace')) };
  })()`);
  report.interactionAssertions.push(assertion(
    'D desktop 1440 has touch emulation disabled and hides mobile navigation',
    !desktopUi.mobileNavVisible && desktopUi.workspaceVisible,
    { touchEmulation: false, ...desktopUi },
    { touchEmulation: false, mobileNavVisible: false, workspaceVisible: true },
  ));

  const canvasCenter = await centerOf('#plan-canvas');
  const wheelBefore = await evaluate(`({ viewBox: document.querySelector('#plan-canvas').getAttribute('viewBox'), zoom: document.querySelector('#zoom-level').textContent })`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: canvasCenter.x, y: canvasCenter.y, deltaX: 0, deltaY: -180 });
  await doubleRaf();
  const wheelAfter = await evaluate(`({ viewBox: document.querySelector('#plan-canvas').getAttribute('viewBox'), zoom: document.querySelector('#zoom-level').textContent })`);
  report.interactionAssertions.push(assertion(
    'D desktop real mouseWheel zoom changes the canvas view',
    wheelBefore.viewBox !== wheelAfter.viewBox && wheelBefore.zoom !== wheelAfter.zoom,
    { transport: 'Input.dispatchMouseEvent mouseWheel', wheelBefore, wheelAfter },
    'viewBox and zoom label both change',
  ));

  await mouseClick(await centerOf('.plan-item:not(.is-selected)', 0), 8);
  await mouseClick(await centerOf('.plan-item:not(.is-selected)', 0), 8);
  const groupBefore = await evaluate(`Object.fromEntries([...document.querySelectorAll('.plan-item.is-selected')].map((node) => [node.dataset.itemId, node.getAttribute('transform')]))`);
  const groupStart = await centerOf('.plan-item.is-selected', 0);
  await mouseDrag(groupStart, { x: groupStart.x + 72, y: groupStart.y + 43 });
  const groupAfter = await evaluate(`Object.fromEntries([...document.querySelectorAll('.plan-item.is-selected')].map((node) => [node.dataset.itemId, node.getAttribute('transform')]))`);
  const translate = (value) => {
    const match = value?.match(/translate\(([-\d.]+)[ ,]+([-\d.]+)/);
    return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
  };
  const groupDeltas = Object.keys(groupBefore).filter((id) => groupAfter[id]).map((id) => {
    const before = translate(groupBefore[id]);
    const after = translate(groupAfter[id]);
    return { id, x: after.x - before.x, y: after.y - before.y };
  });
  report.interactionAssertions.push(assertion(
    'D desktop Shift-click selects two items and grouped drag applies equal deltas',
    groupDeltas.length >= 2 && (groupDeltas[0].x !== 0 || groupDeltas[0].y !== 0)
      && groupDeltas.every(({ x, y }) => x === groupDeltas[0].x && y === groupDeltas[0].y),
    { transport: 'Input.dispatchMouseEvent modifiers=Shift', selectedBefore: Object.keys(groupBefore), groupDeltas },
    'at least two selected IDs move by the same nonzero x/y delta',
  ));

  await mouseClick(await centerOf('[data-select-zone]', 0));
  await mouseClick(await centerOf('[data-select-zone]', 5), 8);
  const disconnectedMergeButton = await centerOf('[data-merge-spaces]');
  report.interactionAssertions.push(assertion(
    'D disconnected spaces do not expose the merge action',
    disconnectedMergeButton === null,
    disconnectedMergeButton,
    null,
  ));
  await mouseClick(await centerOf('[data-select-zone]', 0));
  await evaluate(`(() => {
    document.querySelector('[data-add-structure="swing"]').click();
    let input = document.querySelector('[data-structure-field="orientation"]');
    input.value = 'vertical';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input = document.querySelector('[data-structure-field="x"]');
    input.value = '400';
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    input = document.querySelector('[data-structure-field="y"]');
    input.value = '90';
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  })()`);
  await mouseClick(await centerOf('[data-select-zone]', 0));
  await mouseClick(await centerOf('[data-select-zone]', 1), 8);
  const mergeSpacesButton = await centerOf('[data-merge-spaces]');
  await mouseClick(mergeSpacesButton);
  const mergedSpaces = await evaluate(`(() => {
    const saved = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));
    const [first, second] = saved.zones;
    const sharedBoundary = [...document.querySelectorAll('.structural-walls line')].some((line) =>
      line.getAttribute('x1') === '400' && line.getAttribute('x2') === '400'
      && line.getAttribute('y1') === '0' && line.getAttribute('y2') === '180');
    return { firstSpaceId: first.spaceId, secondSpaceId: second.spaceId, sharedBoundary, structures: saved.structures.length };
  })()`);
  report.interactionAssertions.push(assertion(
    'D grouping adjacent spaces removes their shared wall for doorless movement',
    mergedSpaces.firstSpaceId === mergedSpaces.secondSpaceId && !mergedSpaces.sharedBoundary && mergedSpaces.structures === 0,
    mergedSpaces,
    'same spaceId, no shared structural wall, and no obsolete boundary door',
  ));
  await mouseClick(await centerOf('[data-layout="apartment"]'));
  await mouseClick(await centerOf('.plan-item', 0));
  await mouseClick(await centerOf('.plan-item:not(.is-selected)', 0), 8);

  const desktopBlank = await evaluate(`(() => {
    const rect = document.querySelector('#plan-canvas').getBoundingClientRect();
    for (let y = rect.top + 5; y < rect.bottom - 5; y += 10) {
      for (let x = rect.left + 5; x < rect.right - 5; x += 10) {
        if (document.elementFromPoint(x, y)?.classList.contains('grid-background')) return { x, y };
      }
    }
    return null;
  })()`);
  const desktopSelectionBeforeShiftBlank = await evaluate(`document.querySelectorAll('.is-selected').length`);
  await mouseClick(desktopBlank, 8);
  const desktopSelectionAfterShiftBlank = await evaluate(`document.querySelectorAll('.is-selected').length`);
  report.interactionAssertions.push(assertion(
    'D desktop Shift-clicking blank canvas preserves the current multi-selection',
    desktopSelectionBeforeShiftBlank >= 2 && desktopSelectionAfterShiftBlank === desktopSelectionBeforeShiftBlank,
    { before: desktopSelectionBeforeShiftBlank, after: desktopSelectionAfterShiftBlank },
    'selection count remains unchanged and includes at least two entities',
  ));
  await mouseClick(desktopBlank);
  await mouseClick(await centerOf('.plan-item', 0));
  const resizeBefore = await evaluate(`(() => { const item = document.querySelector('.plan-item.is-selected'); const saved = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})); const value = saved.items.find(({ id }) => id === item.dataset.itemId); return { id: value.id, width: value.width, depth: value.depth }; })()`);
  const handle = await centerOf('.resize-handle.handle-se');
  await mouseDrag(handle, { x: handle.x + 55, y: handle.y + 37 });
  const resizeAfter = await evaluate(`(() => { const saved = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})); const value = saved.items.find(({ id }) => id === ${JSON.stringify(resizeBefore.id)}); return { id: value.id, width: value.width, depth: value.depth }; })()`);
  report.interactionAssertions.push(assertion(
    'D desktop resize handle changes saved item dimensions',
    resizeAfter.width !== resizeBefore.width && resizeAfter.depth !== resizeBefore.depth,
    { transport: 'Input.dispatchMouseEvent drag', resizeBefore, resizeAfter },
    'both width and depth change numerically',
  ));

  await keyStroke('z', 'KeyZ', 4);
  const afterUndo = await evaluate(`(() => { const saved = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})); const value = saved.items.find(({ id }) => id === ${JSON.stringify(resizeBefore.id)}); return { width: value.width, depth: value.depth }; })()`);
  await keyStroke('y', 'KeyY', 2);
  const afterRedo = await evaluate(`(() => { const saved = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})); const value = saved.items.find(({ id }) => id === ${JSON.stringify(resizeBefore.id)}); return { width: value.width, depth: value.depth }; })()`);
  report.interactionAssertions.push(assertion(
    'D desktop Meta+Z undo and Ctrl+Y redo restore and reapply resize',
    afterUndo.width === resizeBefore.width && afterUndo.depth === resizeBefore.depth
      && afterRedo.width === resizeAfter.width && afterRedo.depth === resizeAfter.depth,
    { resizeBefore, resizeAfter, afterUndo, afterRedo },
    'undo equals before dimensions; redo equals resized dimensions',
  ));

  const automaticDoorCount = await evaluate(`document.querySelectorAll('.plan-door').length`);
  report.interactionAssertions.push(assertion(
    'D connected spaces do not receive automatic doors',
    automaticDoorCount === 0,
    automaticDoorCount,
    0,
  ));
  await mouseClick(await centerOf('[data-add-structure="swing"]'));
  const standaloneDoor = await evaluate(`(() => ({
    saved: JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures[0],
    openingMasks: document.querySelectorAll('.plan-door .door-opening').length,
  }))()`);
  report.interactionAssertions.push(assertion(
    'D adding a door without a selected wall creates a directly placeable door',
    standaloneDoor.saved.type === 'door' && standaloneDoor.saved.wallId === null && standaloneDoor.openingMasks === 0,
    standaloneDoor,
    { saved: { type: 'door', wallId: null }, openingMasks: 0 },
  ));
  await mouseClick(await centerOf('[data-delete-selection]'));
  await mouseClick(await centerOf('[data-add-structure="wall"]'));
  await mouseClick(await centerOf('[data-add-structure="swing"]'));
  await mouseClick(await centerOf('[data-add-structure="sliding"]'));
  const structureCreation = await evaluate(`(() => {
    const saved = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));
    const hitTargets = [...document.querySelectorAll('.plan-structure .structure-hit-target')].map((node) => {
      const style = getComputedStyle(node);
      return { strokeWidth: Number.parseFloat(style.strokeWidth), pointerEvents: style.pointerEvents };
    });
    return {
      structures: saved.structures.map(({ id, type, doorType, wallId, thickness, width, hinge, openSide, slideDirection }) => ({ id, type, doorType, wallId, thickness, width, hinge, openSide, slideDirection })),
      wallCount: document.querySelectorAll('.plan-wall').length,
      swingCount: document.querySelectorAll('.plan-door.door-swing').length,
      slidingCount: document.querySelectorAll('.plan-door.door-sliding').length,
      manualWallSpans: document.querySelectorAll('.plan-wall .wall-stroke').length,
      attachedDoorOpeningMasks: document.querySelectorAll('.plan-door .door-opening').length,
      hitTargets,
    };
  })()`);
  const explicitWall = structureCreation.structures.find(({ type }) => type === 'wall');
  const explicitDoors = structureCreation.structures.filter(({ type }) => type === 'door');
  report.interactionAssertions.push(assertion(
    'D desktop creates a thin wall with distinct swing and sliding doors',
    structureCreation.structures.length === 3 && explicitWall?.thickness === 4
      && explicitDoors.map(({ doorType }) => doorType).sort().join(',') === 'sliding,swing'
      && explicitDoors.every(({ wallId }) => wallId === explicitWall.id)
      && structureCreation.wallCount === 1 && structureCreation.swingCount === 1 && structureCreation.slidingCount === 1
      && structureCreation.manualWallSpans === 3 && structureCreation.attachedDoorOpeningMasks === 0,
    structureCreation,
    'one 4cm wall split into three owned spans and attached swing/sliding doors without an automatic-wall mask',
  ));
  report.interactionAssertions.push(assertion(
    'D desktop wall and door plan hit targets meet 44px minimum',
    structureCreation.hitTargets.length === structureCreation.manualWallSpans + explicitDoors.length
      && structureCreation.hitTargets.every(({ strokeWidth, pointerEvents }) => strokeWidth >= 44 && pointerEvents === 'stroke'),
    structureCreation.hitTargets,
    'every rendered wall span and door uses pointer-events: stroke with a >=44px stroke',
  ));

  const swingDoorId = explicitDoors.find(({ doorType }) => doorType === 'swing').id;
  const slidingDoorId = explicitDoors.find(({ doorType }) => doorType === 'sliding').id;
  const setStructureField = async (id, field, value) => evaluate(`(() => {
    document.querySelector('[data-select-structure="${id}"]').click();
    const input = document.querySelector('[data-structure-field="${field}"]');
    input.value = ${JSON.stringify(String(value))};
    input.dispatchEvent(new Event(input.tagName === 'SELECT' || input.type === 'range' ? 'change' : 'blur', { bubbles: true }));
    return true;
  })()`);
  await setStructureField(swingDoorId, 'width', 130);
  await setStructureField(swingDoorId, 'hinge', 'end');
  await setStructureField(swingDoorId, 'openSide', 1);
  await setStructureField(swingDoorId, 'openAngle', 65);
  await setStructureField(slidingDoorId, 'width', 140);
  await setStructureField(slidingDoorId, 'slideDirection', 'start');
  await setStructureField(slidingDoorId, 'openRatio', 75);
  const customizedDoors = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.filter(({ type }) => type === 'door')`);
  const customizedSwing = customizedDoors.find(({ doorType }) => doorType === 'swing');
  const customizedSliding = customizedDoors.find(({ doorType }) => doorType === 'sliding');
  report.interactionAssertions.push(assertion(
    'D desktop customizes door width and swing or sliding direction',
    customizedSwing.width === 130 && customizedSwing.hinge === 'end' && customizedSwing.openSide === 1 && customizedSwing.openAngle === 65
      && customizedSliding.width === 140 && customizedSliding.slideDirection === 'start' && customizedSliding.openRatio === 75,
    customizedDoors,
    { swing: { width: 130, hinge: 'end', openSide: 1, openAngle: 65 }, sliding: { width: 140, slideDirection: 'start', openRatio: 75 } },
  ));
  await evaluate(`document.querySelector('[data-select-structure="${slidingDoorId}"]').click()`);
  const slidingDoorPanels = await evaluate(`(() => ({
    panels: [...document.querySelectorAll('[data-structure-id="${slidingDoorId}"] .door-panel')].map((line) => ({
      className: line.getAttribute('class'), x1: Number(line.getAttribute('x1')), x2: Number(line.getAttribute('x2')), y1: Number(line.getAttribute('y1')),
    })),
    actions: [...document.querySelectorAll('[data-door-opening]')].map((button) => button.textContent.trim()),
  }))()`);
  report.interactionAssertions.push(assertion(
    'D sliding door renders fixed rear and moving front panels with opening actions',
    slidingDoorPanels.panels.length === 2 && slidingDoorPanels.panels[0].y1 !== slidingDoorPanels.panels[1].y1
      && slidingDoorPanels.actions.join(',') === '닫기,반 열기,완전히 열기',
    slidingDoorPanels,
    'two offset panels and close/half/open actions',
  ));
  await mouseClick(await centerOf('[data-door-opening="100"]'));
  const openedSlidingDoor = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(slidingDoorId)})`);
  report.interactionAssertions.push(assertion(
    'D door opening action persists the selected sliding door state',
    openedSlidingDoor.openRatio === 100,
    openedSlidingDoor.openRatio,
    100,
  ));

  await evaluate(`document.querySelector('[data-select-structure="${explicitWall.id}"]').click()`);
  const wallOpeningHit = await evaluate(`(() => {
    const door = document.querySelector('[data-structure-id="${swingDoorId}"] .structure-hit-target');
    const rect = door.getBoundingClientRect();
    return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      ?.closest('[data-structure-id]')?.dataset.structureId ?? null;
  })()`);
  report.interactionAssertions.push(assertion(
    'D desktop selected wall leaves its door opening available for pointer selection',
    wallOpeningHit !== explicitWall.id,
    wallOpeningHit,
    'a door id rather than the selected wall id',
  ));
  const wallOverlayControls = await evaluate(`(() => {
    const endpoints = [...document.querySelectorAll('.structure-resize-overlay .structure-endpoint-hit')].map((node) => Number.parseFloat(getComputedStyle(node).strokeWidth));
    const rotateStrokeWidth = Number.parseFloat(getComputedStyle(document.querySelector('.structure-resize-overlay .structure-rotate-hit')).strokeWidth);
    return { endpoints, rotateStrokeWidth };
  })()`);
  report.interactionAssertions.push(assertion(
    'D desktop selected wall exposes two 44px endpoint handles and a 44px rotate handle',
    wallOverlayControls.endpoints.length === 2 && wallOverlayControls.endpoints.every((strokeWidth) => strokeWidth >= 44)
      && wallOverlayControls.rotateStrokeWidth >= 44,
    wallOverlayControls,
    'two endpoint strokes >=44px and rotate target >=44x44',
  ));
  const wallLengthBefore = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(explicitWall.id)}).length`);
  const wallEndHandle = await centerOf('.structure-resize-overlay .structure-endpoint[data-resize-handle="end"]');
  await mouseDrag(wallEndHandle, { x: wallEndHandle.x + 54, y: wallEndHandle.y });
  const wallLengthAfter = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(explicitWall.id)}).length`);
  report.interactionAssertions.push(assertion(
    'D desktop wall endpoint handle changes saved wall length',
    wallLengthAfter > wallLengthBefore,
    { wallLengthBefore, wallLengthAfter },
    'wallLengthAfter > wallLengthBefore',
  ));
  await mouseClick(await centerOf('.structure-resize-overlay [data-structure-rotate]'));
  const rotatedWallGroup = await evaluate(`(() => {
    const saved = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));
    const wall = saved.structures.find(({ id }) => id === ${JSON.stringify(explicitWall.id)});
    const doors = saved.structures.filter(({ type }) => type === 'door');
    return { wall, doors };
  })()`);
  report.interactionAssertions.push(assertion(
    'D desktop wall rotate handle turns the wall and attached doors by 90 degrees',
    rotatedWallGroup.wall.orientation === 'vertical'
      && rotatedWallGroup.doors.every(({ orientation, wallId }) => orientation === 'vertical' && wallId === rotatedWallGroup.wall.id),
    rotatedWallGroup,
    'wall and attached doors are vertical with the same wallId',
  ));
  const structureMoveBefore = await evaluate(`(() => {
    const saved = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));
    return Object.fromEntries(saved.structures.map(({ id, x, y }) => [id, { x, y }]));
  })()`);
  const wallDragStart = await evaluate(`(() => {
    const line = document.querySelector('.plan-wall.is-selected .wall-stroke');
    const point = line.getPointAtLength(line.getTotalLength() * 0.47).matrixTransform(line.getScreenCTM());
    return { x: point.x, y: point.y };
  })()`);
  await mouseDrag(wallDragStart, { x: wallDragStart.x + 68, y: wallDragStart.y + 42 });
  const structureMoveAfter = await evaluate(`(() => {
    const saved = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));
    return Object.fromEntries(saved.structures.map(({ id, x, y }) => [id, { x, y }]));
  })()`);
  const structureDeltas = Object.keys(structureMoveBefore).map((id) => ({
    id,
    x: structureMoveAfter[id].x - structureMoveBefore[id].x,
    y: structureMoveAfter[id].y - structureMoveBefore[id].y,
  }));
  report.interactionAssertions.push(assertion(
    'D desktop moving a wall keeps its attached doors aligned',
    structureDeltas.length === 3 && (structureDeltas[0].x !== 0 || structureDeltas[0].y !== 0)
      && structureDeltas.every(({ x, y }) => x === structureDeltas[0].x && y === structureDeltas[0].y),
    structureDeltas,
    'wall and both attached doors move by the same nonzero x/y delta',
  ));
  await evaluate(`document.querySelector('[data-select-structure="${swingDoorId}"]').click()`);
  const doorWidthBeforeHandle = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(swingDoorId)}).width`);
  const doorEndHandle = await centerOf('.structure-resize-overlay .structure-endpoint[data-resize-handle="end"]');
  await mouseDrag(doorEndHandle, { x: doorEndHandle.x, y: doorEndHandle.y + 48 });
  const doorWidthAfterHandle = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(swingDoorId)}).width`);
  report.interactionAssertions.push(assertion(
    'D desktop door endpoint handle changes saved door width',
    doorWidthAfterHandle > doorWidthBeforeHandle,
    { doorWidthBeforeHandle, doorWidthAfterHandle },
    'doorWidthAfterHandle > doorWidthBeforeHandle',
  ));
  const attachedDoorStart = await centerOf(`[data-structure-id="${swingDoorId}"] .structure-hit-target`);
  const horizontalBoundaryTarget = await evaluate(`(() => {
    const screen = new DOMPoint(650, 560).matrixTransform(document.querySelector('#plan-canvas').getScreenCTM());
    return { x: screen.x, y: screen.y };
  })()`);
  await mouseDrag(attachedDoorStart, horizontalBoundaryTarget);
  const relocatedDoor = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(swingDoorId)})`);
  report.interactionAssertions.push(assertion(
    'D desktop moving a door to a horizontal space boundary changes its orientation and ownership',
    relocatedDoor.wallId === null && relocatedDoor.orientation === 'horizontal' && relocatedDoor.y === 560,
    relocatedDoor,
    { wallId: null, orientation: 'horizontal', y: 560 },
  ));
  await keyStroke('z', 'KeyZ', 4);
  const restoredAttachedDoor = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(swingDoorId)})`);
  await evaluate(`document.querySelector('[data-select-structure="${swingDoorId}"]').click()`);
  await mouseClick(await centerOf('.structure-resize-overlay [data-structure-rotate]'));
  const rotatedDoor = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(swingDoorId)})`);
  report.interactionAssertions.push(assertion(
    'D desktop door rotate handle toggles orientation and detaches it for free placement',
    restoredAttachedDoor.orientation === 'vertical' && restoredAttachedDoor.wallId === explicitWall.id
      && rotatedDoor.orientation === 'horizontal' && rotatedDoor.wallId === null,
    { restoredAttachedDoor, rotatedDoor },
    'attached vertical door becomes a detached horizontal door',
  ));
  await keyStroke('z', 'KeyZ', 4);
  await evaluate(`document.querySelector('[data-select-structure="${swingDoorId}"]').click()`);
  const keyboardDoorBefore = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(swingDoorId)})`);
  await keyStroke('ArrowRight', 'ArrowRight', 8);
  const keyboardDoorAfter = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(swingDoorId)})`);
  report.interactionAssertions.push(assertion(
    'D Shift+Arrow moves an attached door beyond the wall snap range for keyboard relocation',
    keyboardDoorAfter.wallId === null && keyboardDoorAfter.x === keyboardDoorBefore.x + 40,
    { keyboardDoorBefore, keyboardDoorAfter },
    'door detaches and moves 40cm in the arrow direction',
  ));
  await keyStroke('z', 'KeyZ', 4);
  await evaluate(`document.querySelector('[data-select-structure="${explicitWall.id}"]').click()`);
  report.screenshots.push(await screenshot('desktop-wall-and-doors-1440x1000'));

  await openWalkthrough();
  const desktop3dUi = await walkthroughState();
  report.interactionAssertions.push(assertion(
    'D desktop 3D hides mobile controls and shows keyboard HUD',
    !desktop3dUi.joystick?.visible && !desktop3dUi.lookGuideVisible && desktop3dUi.keyboardHudVisible
      && desktop3dUi.directionConeVisible && desktop3dUi.canvasLabel?.includes('문이나 창을 클릭')
      && desktop3dUi.canvasFocused && desktop3dUi.menuInert && desktop3dUi.menuAriaHidden === 'true',
    desktop3dUi,
    { joystickVisible: false, keyboardHudVisible: true, directionConeVisible: true, canvasFocused: true, menuInert: true, menuAriaHidden: 'true' },
  ));
  const walkthroughCanvas = await centerOf('[data-walkthrough-canvas]');
  let targetedDoorId = await evaluate(`document.querySelector('[data-walkthrough]')?.dataset.targetDoorId ?? null`);
  for (let step = 0; !targetedDoorId && step < 30; step += 1) {
    await mouseDrag(
      { x: walkthroughCanvas.x - 45, y: walkthroughCanvas.y },
      { x: walkthroughCanvas.x + 35, y: walkthroughCanvas.y },
    );
    await sleep(45);
    targetedDoorId = await evaluate(`document.querySelector('[data-walkthrough]')?.dataset.targetDoorId ?? null`);
  }
  const doorBefore = targetedDoorId
    ? await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(targetedDoorId)})`)
    : null;
  if (targetedDoorId) {
    await mouseClick(walkthroughCanvas);
    await sleep(140);
  }
  const doorAfter = targetedDoorId
    ? await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(targetedDoorId)})`)
    : null;
  const doorAction = await evaluate(`document.querySelector('[data-walkthrough]')?.dataset.lastDoorAction ?? null`);
  const openingChanged = doorBefore && doorAfter && (doorBefore.doorType === 'sliding'
    ? doorBefore.openRatio !== doorAfter.openRatio
    : doorBefore.openAngle !== doorAfter.openAngle);
  report.interactionAssertions.push(assertion(
    'D desktop 3D center crosshair finds a visible door and a real canvas click toggles it',
    Boolean(targetedDoorId && openingChanged && doorAction?.startsWith(`${targetedDoorId}:`)),
    { targetedDoorId, doorBefore, doorAfter, doorAction },
    'a visible door is targeted and direct canvas click persists the opposite open/closed state',
  ));
  const keyboardBefore = parseTransform(desktop3dUi.mapTransform);
  await keyEvent('keyDown', 'w', 'KeyW');
  await keyEvent('keyDown', 'd', 'KeyD');
  await sleep(420);
  await keyEvent('keyUp', 'w', 'KeyW');
  await keyEvent('keyUp', 'd', 'KeyD');
  await sleep(120);
  const keyboardAfter = parseTransform((await walkthroughState()).mapTransform);
  report.interactionAssertions.push(assertion(
    'D desktop 3D real keyDown/keyUp WASD moves the camera',
    distance(keyboardBefore, keyboardAfter) > 0.5,
    { transport: 'Input.dispatchKeyEvent', keyboardBefore, keyboardAfter, moved: distance(keyboardBefore, keyboardAfter) },
    'W+D movement >0.5 plan units',
  ));

  const lookBefore = parseTransform((await walkthroughState()).mapTransform);
  await mouseDrag(
    { x: walkthroughCanvas.x - 80, y: walkthroughCanvas.y },
    { x: walkthroughCanvas.x + 90, y: walkthroughCanvas.y + 35 },
  );
  await sleep(180);
  const lookAfter = parseTransform((await walkthroughState()).mapTransform);
  report.interactionAssertions.push(assertion(
    'D desktop 3D real pointer drag changes look rotation',
    lookBefore && lookAfter && Math.abs(lookAfter.rotation - lookBefore.rotation) > 0.5,
    { transport: 'Input.dispatchMouseEvent drag', lookBefore, lookAfter, rotationDelta: lookAfter && lookBefore ? lookAfter.rotation - lookBefore.rotation : null },
    'minimap/camera rotation changes by >0.5 degrees',
  ));
  report.screenshots.push(await screenshot('desktop-3d-1440x1000'));
  await mouseClick(await centerOf('[data-walkthrough-exit]'));
  const desktopClosed = await waitForExpression(`document.querySelector('[data-walkthrough]') === null && document.fullscreenElement === null`, 'desktop 3D clean close');
  report.interactionAssertions.push(assertion('D desktop 3D closes cleanly', desktopClosed, desktopClosed, true));
  await evaluate(`document.querySelector('[data-select-structure="${explicitWall.id}"]').click()`);
  await mouseClick(await centerOf('[data-delete-selection]'));
  const structureDeleteCount = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.length`);
  await keyStroke('z', 'KeyZ', 4);
  const structureUndoCount = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.length`);
  report.interactionAssertions.push(assertion(
    'D deleting a wall removes attached doors and undo restores the structure group',
    structureDeleteCount === 0 && structureUndoCount === 3,
    { structureDeleteCount, structureUndoCount },
    { structureDeleteCount: 0, structureUndoCount: 3 },
  ));

  await setStructureField(explicitWall.id, 'height', 100);
  await evaluate(`document.querySelector('[data-select-structure="${explicitWall.id}"]').click()`);
  await mouseClick(await centerOf('[data-add-structure="window"]'));
  const windowId = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ type }) => type === 'window').id`);
  const lowWallWindow = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(windowId)})`);
  report.interactionAssertions.push(assertion(
    'D a new sliding window stays within a 100cm low wall',
    lowWallWindow.sillHeight === 50 && lowWallWindow.height === 50,
    lowWallWindow,
    { sillHeight: 50, height: 50 },
  ));
  await setStructureField(explicitWall.id, 'height', 240);
  await setStructureField(windowId, 'width', 180);
  await setStructureField(windowId, 'height', 110);
  await setStructureField(windowId, 'sillHeight', 80);
  await setStructureField(windowId, 'openRatio', 50);
  const windowState = await evaluate(`(() => {
    const saved = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(windowId)});
    const node = document.querySelector('[data-structure-id="${windowId}"]');
    const hit = node.querySelector('.structure-hit-target');
    const style = getComputedStyle(hit);
    return {
      saved,
      frameCount: node.querySelectorAll('.window-frame').length,
      panelCount: node.querySelectorAll('.window-panel').length,
      hitTarget: { strokeWidth: Number.parseFloat(style.strokeWidth), pointerEvents: style.pointerEvents },
    };
  })()`);
  report.interactionAssertions.push(assertion(
    'D sliding sash window stays wall-attached and exposes size, sill, opening, and 44px plan controls',
    windowState.saved.wallId === explicitWall.id && windowState.saved.width === 180
      && windowState.saved.height === 110 && windowState.saved.sillHeight === 80 && windowState.saved.openRatio === 50
      && windowState.frameCount === 1 && windowState.panelCount === 2
      && windowState.hitTarget.strokeWidth >= 44 && windowState.hitTarget.pointerEvents === 'stroke',
    windowState,
    'attached 180x110cm sliding window with 80cm sill, 50% opening, one frame, two panels, and >=44px hit target',
  ));
  report.screenshots.push(await screenshot('desktop-sliding-window-2d'));

  await setStructureField(windowId, 'x', 200);
  await setStructureField(windowId, 'y', 300);
  await evaluate(`(() => {
    document.querySelector('#custom-name').value = '반려견 휴식장';
    document.querySelector('#custom-width').value = '120';
    document.querySelector('#custom-depth').value = '80';
    document.querySelector('#custom-height').value = '70';
    document.querySelector('#add-custom').click();
    const setField = (field, value) => {
      const input = document.querySelector('[data-item-field="' + field + '"]');
      input.value = String(value);
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    };
    setField('x', 200);
    setField('y', 150);
  })()`);
  await openWalkthrough();
  const windowWalkthroughCanvas = await centerOf('[data-walkthrough-canvas]');
  let targetedWindowId = await evaluate(`document.querySelector('[data-walkthrough]')?.dataset.targetWindowId ?? null`);
  for (let step = 0; !targetedWindowId && step < 32; step += 1) {
    await mouseDrag(
      { x: windowWalkthroughCanvas.x - 45, y: windowWalkthroughCanvas.y },
      { x: windowWalkthroughCanvas.x + 35, y: windowWalkthroughCanvas.y },
    );
    await sleep(45);
    targetedWindowId = await evaluate(`document.querySelector('[data-walkthrough]')?.dataset.targetWindowId ?? null`);
  }
  const windowBefore3dClick = targetedWindowId
    ? await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(windowId)})`)
    : null;
  if (targetedWindowId) {
    await mouseClick(windowWalkthroughCanvas);
    await sleep(160);
  }
  const windowAfter3dClick = targetedWindowId
    ? await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(windowId)})`)
    : null;
  const windowAction = await evaluate(`document.querySelector('[data-walkthrough]')?.dataset.lastWindowAction ?? null`);
  report.interactionAssertions.push(assertion(
    'D 3D center crosshair finds a sash window and canvas click persists open or closed state',
    targetedWindowId === windowId && windowBefore3dClick?.openRatio !== windowAfter3dClick?.openRatio
      && windowAction?.startsWith(`${windowId}:`),
    { targetedWindowId, windowBefore3dClick, windowAfter3dClick, windowAction },
    'the visible window is targeted and direct canvas click toggles persisted openRatio',
  ));
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', repeat: true, bubbles: true }))`);
  await sleep(80);
  const windowAfterRepeatedKey = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === ${JSON.stringify(windowId)})`);
  report.interactionAssertions.push(assertion(
    'D holding E does not repeatedly toggle the targeted window',
    windowAfterRepeatedKey?.openRatio === windowAfter3dClick?.openRatio,
    { windowAfter3dClick, windowAfterRepeatedKey },
    'a repeated KeyE keydown leaves the persisted opening unchanged',
  ));
  const customFurnitureSummary = await evaluate(`document.querySelector('[data-custom-furniture-names]')?.textContent ?? null`);
  report.interactionAssertions.push(assertion(
    'D 3D exposes the custom furniture name alongside its rendered name tag',
    customFurnitureSummary?.includes('반려견 휴식장'),
    customFurnitureSummary,
    '3D 커스텀 가구 이름표: 반려견 휴식장',
  ));
  report.screenshots.push(await screenshot('desktop-window-and-custom-furniture-3d'));
  await mouseClick(await centerOf('[data-walkthrough-exit]'));
  await waitForExpression(`document.querySelector('[data-walkthrough]') === null`, 'window and custom furniture 3D cleanup');

  await evaluate(`(async () => {
    for (const type of ${JSON.stringify([
      'toilet', 'washbasin', 'kitchenSink', 'kitchenIsland', 'laundryTower',
      'clothesRackSingle', 'clothesRackDoubleRow', 'clothesRackDoubleTier',
    ])}) {
      document.querySelector('[data-add-type="' + type + '"]').click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  })()`);
  const requestedFurnitureState = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).items.filter(({ type }) => ${JSON.stringify([
    'toilet', 'washbasin', 'kitchenSink', 'kitchenIsland', 'laundryTower',
    'clothesRackSingle', 'clothesRackDoubleRow', 'clothesRackDoubleTier',
  ])}.includes(type)).map(({ type, name }) => ({ type, name }))`);
  await openWalkthrough();
  report.interactionAssertions.push(assertion(
    'D all requested furniture types persist and build a 3D walkthrough without model errors',
    requestedFurnitureState.map(({ type }) => type).sort().join(',') === [...requestedFurnitureTypes].sort().join(','),
    requestedFurnitureState,
    requestedFurnitureTypes,
  ));
  report.screenshots.push(await screenshot('desktop-requested-furniture-3d'));
  await mouseClick(await centerOf('[data-walkthrough-exit]'));
  await waitForExpression(`document.querySelector('[data-walkthrough]') === null`, 'requested furniture 3D cleanup');

  const boundaryDoorLayout = {
    zones: [
      { id: 'room-1', spaceId: 'room-1', name: '방 1', type: '방', x: 0, y: 0, width: 220, depth: 260, height: 240, color: '#d6ddd7' },
      { id: 'room-2', spaceId: 'room-2', name: '방 2', type: '방', x: 0, y: 260, width: 120, depth: 130, height: 240, color: '#dbc9d8' },
      { id: 'hall', spaceId: 'hall', name: '복도', type: '복도', x: 120, y: 260, width: 100, depth: 130, height: 240, color: '#e8cfac' },
    ],
    items: [],
    structures: [
      { id: 'room-1-wall', type: 'wall', name: '방 1 경계벽', x: 170, y: 260, length: 100, height: 240, thickness: 4, orientation: 'horizontal' },
      { id: 'room-1-door', type: 'door', doorType: 'swing', name: '방 1 문', x: 170, y: 260, width: 80, height: 205, orientation: 'horizontal', hinge: 'end', openSide: 1, slideDirection: 'end', wallId: 'room-1-wall' },
      { id: 'room-2-wall', type: 'wall', name: '방 2 경계벽', x: 120, y: 325, length: 130, height: 240, thickness: 4, orientation: 'vertical' },
      { id: 'room-2-door', type: 'door', doorType: 'swing', name: '방 2 문', x: 120, y: 325, width: 80, height: 205, orientation: 'vertical', hinge: 'start', openSide: -1, openAngle: 90, openRatio: 0, slideDirection: 'end', wallId: 'room-2-wall' },
    ],
    wallHeight: 240,
  };
  await evaluate(`localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(boundaryDoorLayout))})`);
  await loadViewport(pageUrl, 1440, 1000, false);
  const boundaryOpeningState = await evaluate(`(() => {
    const doors = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.filter(({ type }) => type === 'door');
    const spans = [...document.querySelectorAll('.structural-walls line')].map((line) => ({
      x1: Number(line.getAttribute('x1')), x2: Number(line.getAttribute('x2')),
      y1: Number(line.getAttribute('y1')), y2: Number(line.getAttribute('y2')),
    }));
    const coveredDoorIds = doors.filter((door) => spans.some((span) => door.orientation === 'horizontal'
      ? span.y1 === door.y && span.y2 === door.y && Math.min(span.x1, span.x2) < door.x && Math.max(span.x1, span.x2) > door.x
      : span.x1 === door.x && span.x2 === door.x && Math.min(span.y1, span.y2) < door.y && Math.max(span.y1, span.y2) > door.y)).map(({ id }) => id);
    return {
      doorIds: doors.map(({ id }) => id),
      coveredDoorIds,
      automaticSpanCount: spans.length,
      legacyRoom1Closed: !document.querySelector('[data-structure-id="room-1-door"] .door-swing'),
    };
  })()`);
  report.interactionAssertions.push(assertion(
    'D doors attached to user walls also cut coincident automatic room boundaries',
    boundaryOpeningState.doorIds.length === 2 && boundaryOpeningState.coveredDoorIds.length === 0
      && boundaryOpeningState.legacyRoom1Closed,
    boundaryOpeningState,
    'both directions have automatic-wall gaps and a legacy door without opening fields defaults closed',
  ));
  report.screenshots.push(await screenshot('desktop-attached-boundary-doors-2d'));

  await openWalkthrough();
  const boundaryWalkthroughCanvas = await centerOf('[data-walkthrough-canvas]');
  const boundaryTargetDoorIds = new Set();
  let boundaryDoorScreenshot = null;
  let openDoorwayRetargeted = false;
  for (let step = 0; step < 48; step += 1) {
    const targetDoorId = await evaluate(`document.querySelector('[data-walkthrough]')?.dataset.targetDoorId ?? null`);
    if (targetDoorId) {
      boundaryTargetDoorIds.add(targetDoorId);
      if (targetDoorId === 'room-1-door' && !openDoorwayRetargeted) {
        await mouseClick(boundaryWalkthroughCanvas);
        await sleep(520);
        const openedDoorState = await evaluate(`(() => ({
          angle: JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).structures.find(({ id }) => id === 'room-1-door').openAngle,
          targetDoorId: document.querySelector('[data-walkthrough]')?.dataset.targetDoorId ?? null,
        }))()`);
        openDoorwayRetargeted = openedDoorState.angle === 90 && openedDoorState.targetDoorId === 'room-1-door';
        boundaryDoorScreenshot = await screenshot('desktop-attached-boundary-doors-3d');
      }
    }
    await mouseDrag(
      { x: boundaryWalkthroughCanvas.x - 25, y: boundaryWalkthroughCanvas.y },
      { x: boundaryWalkthroughCanvas.x + 25, y: boundaryWalkthroughCanvas.y },
    );
    await sleep(45);
  }
  const boundaryTargetDoorId = await evaluate(`document.querySelector('[data-walkthrough]')?.dataset.targetDoorId ?? null`);
  if (boundaryTargetDoorId) boundaryTargetDoorIds.add(boundaryTargetDoorId);
  const targetedBoundaryDoors = [...boundaryTargetDoorIds].sort();
  report.interactionAssertions.push(assertion(
    'D an attached room-boundary door remains visible and targetable in 3D',
    targetedBoundaryDoors.length >= 1 && targetedBoundaryDoors.every((id) => ['room-1-door', 'room-2-door'].includes(id)),
    targetedBoundaryDoors,
    'at least one of the two attached boundary doors is directly targetable from the starting room',
  ));
  report.interactionAssertions.push(assertion(
    'D an open swing doorway keeps an interaction target for closing the hidden leaf',
    openDoorwayRetargeted,
    openDoorwayRetargeted,
    true,
  ));
  report.screenshots.push(boundaryDoorScreenshot ?? await screenshot('desktop-attached-boundary-doors-3d'));
  await mouseClick(await centerOf('[data-walkthrough-exit]'));
  await waitForExpression(`document.querySelector('[data-walkthrough]') === null`, 'attached boundary door 3D cleanup');
  report.interactionAssertions.push(noConsoleAssertion('D desktop scenario', browserErrors.slice(desktopErrorStart)));

  report.interactionAssertions.push(noConsoleAssertion('Global browser audit', browserErrors));
  const allAssertions = [
    ...report.viewports.flatMap(({ assertions = [] }) => assertions),
    ...report.interactionAssertions,
  ];
  report.assertionCounts = {
    total: allAssertions.length,
    passed: allAssertions.filter(({ pass }) => pass).length,
    failed: allAssertions.filter(({ pass }) => !pass).length,
  };
  report.consoleErrors = browserErrors;
  exitCode = report.assertionCounts.failed === 0 ? 0 : 1;
} catch (error) {
  report.error = { name: error.name, message: error.message, stack: error.stack };
} finally {
  report.finishedAt = new Date().toISOString();
  try {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await cleanup();
  }
}

console.log(`Mobile browser audit artifacts: ${artifactDir}`);
if (report.assertionCounts) {
  console.log(`Assertions: ${report.assertionCounts.passed}/${report.assertionCounts.total} passed (${report.assertionCounts.failed} failed)`);
  const failedAssertions = [
    ...report.viewports.flatMap(({ assertions = [] }) => assertions),
    ...report.interactionAssertions,
  ].filter(({ pass }) => !pass);
  for (const { name, actual, expected } of failedAssertions) {
    console.error(`Failed assertion: ${name}`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
  }
}
if (report.error) console.error(report.error.stack);
process.exitCode = exitCode;
