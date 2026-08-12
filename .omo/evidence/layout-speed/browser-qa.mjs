import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  capture,
  evaluate,
  launchChrome,
  setViewport,
} from '../room-studio-improvements/browser-qa-lib.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const STORAGE_KEY = 'room-studio-layout-v2';
const defaultEvidenceDir = dirname(fileURLToPath(import.meta.url));
const outputDirIndex = process.argv.indexOf('--output-dir');
const evidenceDir = outputDirIndex >= 0
  ? resolve(process.argv[outputDirIndex + 1])
  : defaultEvidenceDir;
const urlIndex = process.argv.indexOf('--url');
const targetUrl = urlIndex >= 0 ? process.argv[urlIndex + 1] : 'http://127.0.0.1:4173';
const scenarioIndex = process.argv.indexOf('--scenario');
const scenario = scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : 'placement';
const phaseIndex = process.argv.indexOf('--phase');
const phase = phaseIndex >= 0 ? process.argv[phaseIndex + 1] : 'green';

if (!['placement', 'overlap', 'numeric', 'demos', 'mobile'].includes(scenario)) {
  throw new Error(`Unknown scenario: ${scenario}`);
}
if (!['red', 'green'].includes(phase)) {
  throw new Error(`Unknown phase: ${phase}`);
}

const item = (overrides = {}) => ({
  id: 'fixture-item',
  name: '테스트 소파',
  type: 'sofa',
  shape: 'roundRect',
  x: 260,
  y: 190,
  width: 180,
  depth: 90,
  height: 80,
  elevation: 0,
  rotation: 0,
  color: '#c8a985',
  ...overrides,
});

const zone = (overrides = {}) => ({
  id: 'fixture-zone',
  spaceId: 'fixture-space',
  name: '테스트 거실',
  type: 'living',
  x: 0,
  y: 0,
  width: 640,
  depth: 420,
  height: 260,
  color: '#e7dccd',
  ...overrides,
});

const layout = (overrides = {}) => ({
  zones: [zone()],
  items: [],
  structures: [],
  dimensions: [],
  backgroundPlan: null,
  wallHeight: 260,
  ...overrides,
});

const result = {
  scenario,
  phase,
  url: targetUrl,
  passed: false,
  assertions: [],
  actions: [],
  consoleErrors: [],
  unexpectedError: null,
};

const record = (name, pass, details = null) => {
  result.assertions.push({ name, pass: Boolean(pass), details });
};

const action = (name, details = null) => {
  result.actions.push({ name, details });
};

const nextFrames = (cdp) => evaluate(cdp, `new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
})`);

const readLayout = (cdp) => evaluate(cdp, `JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}))`);

async function seedAndReload(cdp, seededLayout) {
  const loaded = cdp.once('Page.loadEventFired');
  await evaluate(cdp, `(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(seededLayout))});
    location.reload();
  })()`);
  await loaded;
  await nextFrames(cdp);
  action('seed-layout', {
    zones: seededLayout.zones.length,
    items: seededLayout.items.length,
    structures: seededLayout.structures.length,
  });
}

async function selectorCenter(cdp, selector) {
  return evaluate(cdp, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      disabled: Boolean(node.disabled),
    };
  })()`);
}

async function clickSelector(cdp, selector) {
  const center = await selectorCenter(cdp, selector);
  if (!center) return false;
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: center.x,
    y: center.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: center.x,
    y: center.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await nextFrames(cdp);
  action('click', { selector, center });
  return true;
}

async function clientPoint(cdp, worldX, worldY) {
  return evaluate(cdp, `(() => {
    const svg = document.querySelector('#plan-canvas');
    if (!svg) return null;
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(${worldX}, ${worldY}).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  })()`);
}

async function clickWorld(cdp, worldX, worldY) {
  const point = await clientPoint(cdp, worldX, worldY);
  if (!point) return null;
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
    buttons: 0,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await nextFrames(cdp);
  action('click-world', { worldX, worldY, point });
  return point;
}

async function touchWorld(cdp, worldX, worldY) {
  const point = await clientPoint(cdp, worldX, worldY);
  if (!point) return null;
  const touchPoint = {
    x: point.x,
    y: point.y,
    radiusX: 5,
    radiusY: 5,
    force: 1,
    id: 1,
  };
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [touchPoint],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await nextFrames(cdp);
  action('touch-world', { worldX, worldY, point });
  return point;
}

async function pressKey(cdp, key, code = key) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
  });
  await nextFrames(cdp);
  action('key', { key, code });
}

async function setQuickField(cdp, field, values, commitKey = 'Enter') {
  const changed = await evaluate(cdp, `(() => {
    const input = document.querySelector('[data-quick-field="${field}"]');
    if (!input) return false;
    input.focus();
    for (const value of ${JSON.stringify(values)}) {
      input.value = value;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }
    return true;
  })()`);
  if (!changed) return false;
  await nextFrames(cdp);
  if (commitKey) await pressKey(cdp, commitKey, commitKey);
  action('quick-field', { field, values, commitKey });
  return true;
}

async function waitForSelector(cdp, selector, timeoutMs = 8_000) {
  return evaluate(cdp, `new Promise((resolve) => {
    const selector = ${JSON.stringify(selector)};
    const current = document.querySelector(selector);
    if (current) {
      resolve(true);
      return;
    }
    const observer = new MutationObserver(() => {
      if (!document.querySelector(selector)) return;
      observer.disconnect();
      clearTimeout(timeout);
      resolve(true);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const timeout = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, ${timeoutMs});
  })`);
}

async function runPlacement(cdp) {
  const seeded = layout();
  await seedAndReload(cdp, seeded);
  const before = await readLayout(cdp);
  await clickSelector(cdp, '[data-add-type="sofa"]');
  const armed = await evaluate(cdp, `Boolean(document.querySelector('[data-placement-session]'))`);
  const ghost = await evaluate(cdp, `Boolean(document.querySelector('[data-placement-ghost]'))`);
  await capture(cdp, join(evidenceDir, `placement-${phase}-armed.png`));
  await clickWorld(cdp, 500, 300);
  const afterPlacement = await readLayout(cdp);
  const beforeIds = new Set(before.items.map(({ id }) => id));
  const created = afterPlacement.items.find(({ id }) => !beforeIds.has(id));
  const selected = created
    ? await evaluate(cdp, `document.querySelector('[data-item-id="${created.id}"]')?.classList.contains('is-selected') ?? false`)
    : false;
  const targetPlacement = Boolean(created)
    && Math.abs(created.x - 500) <= 15
    && Math.abs(created.y - 300) <= 15;

  const undoAvailable = !(await selectorCenter(cdp, '#undo-action'))?.disabled;
  if (undoAvailable) await clickSelector(cdp, '#undo-action');
  const afterUndo = await readLayout(cdp);
  const undoRemoved = afterUndo.items.length === before.items.length;

  await clickSelector(cdp, '[data-add-type="sofa"]');
  const countBeforeEscape = (await readLayout(cdp)).items.length;
  await pressKey(cdp, 'Escape', 'Escape');
  const afterEscape = await readLayout(cdp);
  const escapeCancelled = afterEscape.items.length === before.items.length
    && countBeforeEscape === before.items.length;

  record('library arms placement session', armed, { armed });
  record('placement ghost is visible', ghost, { ghost });
  record('drop commits at snapped pointer target', targetPlacement, { created });
  record('newly placed item remains selected', selected, { createdId: created?.id ?? null });
  record('one undo removes exactly the placement', undoRemoved, {
    before: before.items.length,
    afterUndo: afterUndo.items.length,
  });
  record('Escape cancels without adding an item', escapeCancelled, {
    before: before.items.length,
    countBeforeEscape,
    afterEscape: afterEscape.items.length,
  });
}

async function runOverlap(cdp) {
  const overlapA = item({ id: 'overlap-a', name: '겹친 소파', x: 280, y: 190 });
  const overlapB = item({
    id: 'overlap-b',
    name: '겹친 테이블',
    type: 'table',
    shape: 'rect',
    x: 280,
    y: 190,
    width: 140,
    depth: 100,
    color: '#b59069',
  });
  const single = item({ id: 'single-item', name: '단독 의자', type: 'chair', x: 510, y: 150, width: 60, depth: 60 });
  await seedAndReload(cdp, layout({ items: [overlapA, overlapB, single] }));
  const original = await readLayout(cdp);

  await clickWorld(cdp, 280, 190);
  const pickerState = await evaluate(cdp, `(() => {
    const picker = document.querySelector('[data-overlap-picker]');
    return {
      visible: Boolean(picker),
      choices: [...document.querySelectorAll('[data-overlap-choice]')].map((node) => ({
        value: node.getAttribute('data-overlap-choice'),
        text: node.textContent.trim(),
      })),
      active: document.activeElement?.getAttribute?.('data-overlap-choice') ?? null,
    };
  })()`);
  await capture(cdp, join(evidenceDir, `overlap-${phase}-picker.png`));
  await pressKey(cdp, 'Escape', 'Escape');
  const escapeState = await evaluate(cdp, `({
    pickerClosed: !document.querySelector('[data-overlap-picker]'),
    canvasFocused: document.activeElement?.id === 'plan-canvas',
  })`);

  await clickWorld(cdp, 280, 190);
  const choseRequested = await clickSelector(cdp, '[data-overlap-choice="item:overlap-b"]');
  const selectionState = await evaluate(cdp, `({
    requested: document.querySelector('[data-item-id="overlap-b"]')?.classList.contains('is-selected') ?? false,
    other: document.querySelector('[data-item-id="overlap-a"]')?.classList.contains('is-selected') ?? false,
  })`);
  const afterChoice = await readLayout(cdp);

  await clickWorld(cdp, 510, 150);
  const loneItemState = await evaluate(cdp, `({
    pickerVisible: Boolean(document.querySelector('[data-overlap-picker]')),
    selected: document.querySelector('[data-item-id="single-item"]')?.classList.contains('is-selected') ?? false,
  })`);

  record('multiple foreground hits open deterministic picker', pickerState.visible, pickerState);
  record('picker lists both foreground candidates', pickerState.choices.length === 2, pickerState.choices);
  record('Escape closes picker and restores canvas focus', escapeState.pickerClosed && escapeState.canvasFocused, escapeState);
  record('requested overlap candidate alone is selected', choseRequested && selectionState.requested && !selectionState.other, selectionState);
  record('overlap selection never mutates geometry', JSON.stringify(afterChoice.items) === JSON.stringify(original.items));
  record('single foreground item bypasses picker', loneItemState.selected && !loneItemState.pickerVisible, loneItemState);
}

async function runNumeric(cdp) {
  const selectedItem = item({ id: 'numeric-item', width: 180, rotation: 0 });
  await seedAndReload(cdp, layout({ items: [selectedItem] }));
  await clickWorld(cdp, selectedItem.x, selectedItem.y);

  const quickState = await evaluate(cdp, `(() => {
    const width = document.querySelector('[data-quick-field="width"]');
    const rotation = document.querySelector('[data-quick-field="rotation"]');
    return {
      widthExists: Boolean(width),
      rotationExists: Boolean(rotation),
      widthValue: width?.value ?? null,
      rotationValue: rotation?.value ?? null,
    };
  })()`);
  await capture(cdp, join(evidenceDir, `numeric-${phase}-hud.png`));

  const widthChanged = await setQuickField(cdp, 'width', ['190', '215', '230'], null);
  const liveWidth = await evaluate(cdp, `(() => {
    const node = document.querySelector('[data-item-id="numeric-item"] .item-shape > *');
    return node?.getBBox?.().width ?? null;
  })()`);
  const rotationChanged = await setQuickField(cdp, 'rotation', ['15', '30']);
  const committed = await readLayout(cdp);
  const committedItem = committed.items.find(({ id }) => id === 'numeric-item');
  const undoBefore = await selectorCenter(cdp, '#undo-action');
  if (undoBefore && !undoBefore.disabled) await clickSelector(cdp, '#undo-action');
  const afterUndo = await readLayout(cdp);
  const restored = afterUndo.items.find(({ id }) => id === 'numeric-item');
  const undoAfter = await selectorCenter(cdp, '#undo-action');

  await clickWorld(cdp, selectedItem.x, selectedItem.y);
  const cancelChanged = await setQuickField(cdp, 'width', ['260'], 'Escape');
  const afterCancel = await readLayout(cdp);
  const cancelled = afterCancel.items.find(({ id }) => id === 'numeric-item');
  const undoAfterCancel = await selectorCenter(cdp, '#undo-action');

  record('selected item exposes immediate quick fields', quickState.widthExists && quickState.rotationExists, quickState);
  record('multiple inputs preview geometry live', widthChanged && Number(liveWidth) > 180, { liveWidth });
  record('Enter commits final width and rotation', rotationChanged && committedItem?.width === 230 && committedItem?.rotation === 30, committedItem);
  record('one undo restores the complete pre-edit snapshot', rotationChanged && restored?.width === 180 && restored?.rotation === 0 && undoAfter?.disabled, {
    restored,
    undoAfter,
  });
  record('Escape cancels draft without adding history', cancelChanged && cancelled?.width === 180 && undoAfterCancel?.disabled, {
    cancelled,
    undoAfterCancel,
  });
}

async function installReportCapture(cdp) {
  await evaluate(cdp, `(() => {
    window.__layoutSpeedReport = null;
    window.__layoutSpeedReportPromise = null;
    window.__layoutSpeedReportReady = new Promise((resolve) => {
      window.__layoutSpeedReportResolve = resolve;
    });
    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob.type.startsWith('text/html')) window.__layoutSpeedReportPromise = blob.text();
      return originalCreateObjectURL(blob);
    };
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function captureDownload() {
      if (this.download?.endsWith('.html')) {
        const filename = this.download;
        window.__layoutSpeedReportPromise?.then((html) => {
          window.__layoutSpeedReport = { filename, html };
          window.__layoutSpeedReportResolve(window.__layoutSpeedReport);
        });
        return;
      }
      originalClick.call(this);
    };
  })()`);
}

async function runDemos(cdp) {
  await seedAndReload(cdp, layout({ items: [item({ id: 'protected-user-item', name: '보존할 사용자 소파' })] }));
  const existingBefore = await readLayout(cdp);
  const openerClicked = await clickSelector(cdp, '[data-demo-open]');
  const gallery = await evaluate(cdp, `(() => ({
    open: Boolean(document.querySelector('[data-demo-gallery]')),
    cards: [...document.querySelectorAll('[data-demo-card]')].map((card) => ({
      id: card.getAttribute('data-demo-card'),
      text: card.textContent.trim(),
      source: card.querySelector('[data-demo-source]')?.textContent.trim() ?? null,
      area: card.querySelector('[data-demo-area]')?.textContent.trim() ?? null,
      rooms: card.querySelector('[data-demo-rooms]')?.textContent.trim() ?? null,
      adaptation: card.querySelector('[data-demo-adaptation]')?.textContent.trim() ?? null,
    })),
  }))()`);
  await capture(cdp, join(evidenceDir, `demos-${phase}-gallery.png`));
  const demos = [];

  for (const card of gallery.cards) {
    await clickSelector(cdp, `[data-demo-layout="${card.id}"]`);
    const confirmationVisible = await evaluate(cdp, `Boolean(document.querySelector('[data-demo-confirm]'))`);
    const protectedState = await readLayout(cdp);
    if (confirmationVisible) await clickSelector(cdp, '[data-demo-confirm-accept]');
    const demoLayout = await readLayout(cdp);

    const walkthroughPromise = evaluate(cdp, `new Promise((resolve) => {
      const current = document.querySelector('.walkthrough-overlay');
      if (current) return resolve(true);
      const observer = new MutationObserver(() => {
        if (!document.querySelector('.walkthrough-overlay')) return;
        observer.disconnect();
        clearTimeout(timeout);
        resolve(true);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const timeout = setTimeout(() => {
        observer.disconnect();
        resolve(false);
      }, 12000);
    })`);
    await clickSelector(cdp, '#open-walkthrough');
    const walkthroughOpened = await walkthroughPromise;
    if (walkthroughOpened) await clickSelector(cdp, '[data-walkthrough-exit]');

    await installReportCapture(cdp);
    await clickSelector(cdp, '[data-project-open]');
    await clickSelector(cdp, '[data-project-report]');
    const report = await evaluate(cdp, `Promise.race([
      window.__layoutSpeedReportReady,
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ])`);
    await pressKey(cdp, 'Escape', 'Escape');

    if (report?.html) {
      await writeFile(join(evidenceDir, `${card.id}-${phase}-decision-report.html`), report.html);
    }
    demos.push({
      id: card.id,
      confirmationVisible,
      userLayoutProtectedBeforeConfirm: JSON.stringify(protectedState) === JSON.stringify(existingBefore)
        || demos.length > 0,
      zones: demoLayout.zones.length,
      items: demoLayout.items.length,
      structures: demoLayout.structures.length,
      geometry: JSON.stringify({
        zones: demoLayout.zones.map(({ x, y, width, depth }) => ({ x, y, width, depth })),
        items: demoLayout.items.map(({ x, y, width, depth }) => ({ x, y, width, depth })),
      }),
      walkthroughOpened,
      report: report ? {
        filename: report.filename,
        containsName: report.html.includes(card.id) || report.html.includes(card.text.split(/\s+/)[0]),
      } : null,
    });

    await clickSelector(cdp, '[data-demo-open]');
  }

  const uniqueGeometry = new Set(demos.map(({ geometry }) => geometry)).size === demos.length;
  const completeCards = gallery.cards.every((card) => card.source && card.area && card.rooms && card.adaptation);
  const completeLayouts = demos.every((demo) => demo.zones > 0 && demo.items > 0 && demo.structures > 0);
  const protectedExisting = demos[0]?.confirmationVisible && demos[0]?.userLayoutProtectedBeforeConfirm;
  const completeSurfaces = demos.every((demo) => demo.walkthroughOpened && demo.report?.filename?.endsWith('-decision-report.html'));

  record('persistent demo entry opens gallery', openerClicked && gallery.open, gallery);
  record('gallery exposes at least three attributed plans', gallery.cards.length >= 3 && completeCards, gallery.cards);
  record('demo replacement protects existing local work', protectedExisting, demos[0] ?? null);
  record('every demo has furnished unique layout geometry', demos.length >= 3 && completeLayouts && uniqueGeometry, demos);
  record('every demo builds 3D and exports report', demos.length >= 3 && completeSurfaces, demos);
}

async function runMobile(cdp) {
  await setViewport(cdp, 390, 844);
  await seedAndReload(cdp, layout());
  await clickSelector(cdp, '[data-mobile-panel="furniture"]');
  const addControl = {
    selector: '[data-add-type="sofa"]',
    ...(await selectorCenter(cdp, '[data-add-type="sofa"]') ?? { width: 0, height: 0 }),
  };
  await clickSelector(cdp, '[data-add-type="sofa"]');
  const armed = await evaluate(cdp, `Boolean(document.querySelector('[data-placement-session]'))`);
  const placementControl = {
    selector: '[data-placement-cancel]',
    ...(await selectorCenter(cdp, '[data-placement-cancel]') ?? { width: 0, height: 0 }),
  };
  const demoControl = {
    selector: '[data-demo-open]',
    ...(await selectorCenter(cdp, '[data-demo-open]') ?? { width: 0, height: 0 }),
  };
  await touchWorld(cdp, 480, 280);
  const placed = await readLayout(cdp);
  const controls = [addControl, placementControl, demoControl];
  const surfaceState = await evaluate(cdp, `({
    noOverflow: document.documentElement.scrollWidth <= innerWidth,
    contextMenuOpen: Boolean(document.querySelector('[data-mobile-context-menu]')),
    canvasFocused: document.activeElement?.id === 'plan-canvas',
  })`);
  const directPlacement = placed.items.length === 1
    && Math.abs(placed.items[0].x - 480) <= 15
    && Math.abs(placed.items[0].y - 280) <= 15;

  await clickSelector(cdp, '[data-demo-open]');
  const demoFocusSetup = await evaluate(cdp, `(() => {
    const dialog = document.querySelector('[data-demo-gallery][aria-modal="true"]');
    const focusable = dialog
      ? [...dialog.querySelectorAll('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')]
        .filter((node) => node.getClientRects().length)
      : [];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first) first.dataset.qaFirstFocus = 'true';
    last?.focus();
    return { opened: Boolean(dialog), focusableCount: focusable.length };
  })()`);
  await pressKey(cdp, 'Tab', 'Tab');
  const demoFocusWrapped = await evaluate(cdp, `document.activeElement?.dataset.qaFirstFocus === 'true'`);
  await pressKey(cdp, 'Escape', 'Escape');
  const demoFocusRestored = await evaluate(cdp, `(
    !document.querySelector('[data-demo-gallery]')
    && document.activeElement?.matches('[data-demo-open]')
  )`);

  const overlapA = item({ id: 'mobile-overlap-a', name: '모바일 겹침 A', x: 280, y: 190 });
  const overlapB = item({
    id: 'mobile-overlap-b',
    name: '모바일 겹침 B',
    type: 'table',
    shape: 'rect',
    x: 280,
    y: 190,
    width: 140,
    depth: 100,
    color: '#b59069',
  });
  await seedAndReload(cdp, layout({ items: [overlapA, overlapB] }));
  await clickWorld(cdp, 280, 190);
  const overlapFocusSetup = await evaluate(cdp, `(() => {
    const dialog = document.querySelector('[data-overlap-picker][aria-modal="true"]');
    const choices = dialog ? [...dialog.querySelectorAll('[data-overlap-choice]')] : [];
    const first = choices[0];
    const last = choices.at(-1);
    if (first) first.dataset.qaFirstFocus = 'true';
    last?.focus();
    return { opened: Boolean(dialog), choiceCount: choices.length };
  })()`);
  await pressKey(cdp, 'Tab', 'Tab');
  const overlapFocusWrapped = await evaluate(cdp, `document.activeElement?.dataset.qaFirstFocus === 'true'`);
  await pressKey(cdp, 'Escape', 'Escape');
  const overlapFocusRestored = await evaluate(cdp, `(
    !document.querySelector('[data-overlap-picker]')
    && document.activeElement?.id === 'plan-canvas'
  )`);

  record('touch library action arms placement immediately', armed, { armed });
  record('single direct touch commits at target', directPlacement, placed.items[0] ?? null);
  record('touch placement avoids context-menu takeover', !surfaceState.contextMenuOpen, surfaceState);
  record('mobile controls meet 44px target', controls.every(({ width, height }) => width >= 44 && height >= 44), controls);
  record('mobile surface has no horizontal overflow', surfaceState.noOverflow, surfaceState);
  record(
    'mobile demo dialog traps focus and Escape restores opener',
    demoFocusSetup.opened && demoFocusSetup.focusableCount >= 2 && demoFocusWrapped && demoFocusRestored,
    { ...demoFocusSetup, wrapped: demoFocusWrapped, restored: demoFocusRestored },
  );
  record(
    'mobile overlap dialog traps focus and Escape restores canvas',
    overlapFocusSetup.opened && overlapFocusSetup.choiceCount >= 2 && overlapFocusWrapped && overlapFocusRestored,
    { ...overlapFocusSetup, wrapped: overlapFocusWrapped, restored: overlapFocusRestored },
  );
}

await mkdir(evidenceDir, { recursive: true });
const browser = await launchChrome(CHROME);
try {
  const { cdp } = browser;
  const runtimeListeners = cdp.listeners.get('Runtime.consoleAPICalled') ?? new Set();
  runtimeListeners.add(({ type, args }) => {
    if (type !== 'error') return;
    result.consoleErrors.push(args.map(({ value, description }) => value ?? description ?? '').join(' '));
  });
  cdp.listeners.set('Runtime.consoleAPICalled', runtimeListeners);
  const exceptionListeners = cdp.listeners.get('Runtime.exceptionThrown') ?? new Set();
  exceptionListeners.add(({ exceptionDetails }) => {
    result.consoleErrors.push(exceptionDetails.exception?.description ?? exceptionDetails.text);
  });
  cdp.listeners.set('Runtime.exceptionThrown', exceptionListeners);

  await browser.navigate(targetUrl);
  await setViewport(cdp, scenario === 'mobile' ? 390 : 1440, scenario === 'mobile' ? 844 : 1000);

  if (scenario === 'placement') await runPlacement(cdp);
  if (scenario === 'overlap') await runOverlap(cdp);
  if (scenario === 'numeric') await runNumeric(cdp);
  if (scenario === 'demos') await runDemos(cdp);
  if (scenario === 'mobile') await runMobile(cdp);

  await capture(cdp, join(evidenceDir, `${scenario}-${phase}.png`));
  result.passed = result.assertions.every(({ pass }) => pass) && result.consoleErrors.length === 0;
} catch (error) {
  result.unexpectedError = error.stack ?? String(error);
  result.passed = false;
  try {
    await capture(browser.cdp, join(evidenceDir, `${scenario}-${phase}.png`));
  } catch {
    // The JSON result below is the primary failure artifact if Chrome is already gone.
  }
} finally {
  await browser.close();
}

await writeFile(join(evidenceDir, `${scenario}-${phase}.json`), `${JSON.stringify(result, null, 2)}\n`);
await writeFile(join(evidenceDir, `${scenario}-${phase}-actions.json`), `${JSON.stringify(result.actions, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
