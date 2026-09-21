import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { migrationScenarios, minimumAssertions } from './mobile-audit-scenarios.mjs';
import { studioWallTargets } from '../src/studio3d-edit.js';

const root = resolve(import.meta.dirname, '..');
const STORAGE_KEY = 'room-studio-layout-v2';
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const artifactDir = join(root, '.omx/artifacts/mobile-ux-hardening', runId);
const resultsPath = join(artifactDir, 'browser-results.json');
const chromeCandidates = [process.env.CHROME_BIN, process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    .filter(Boolean).map(path => join(path, 'Google/Chrome/Application/chrome.exe')),
].filter(Boolean);
const chrome = chromeCandidates.find(path => existsSync(path));
const TIMEOUT = 15_000;
const report = { runId, startedAt: new Date().toISOString(), physicalDeviceSmoke: 'not-performed',
  chrome: { executable: chrome, candidatesChecked: chromeCandidates }, viewports: [], screenshots: [],
  interactionAssertions: [], scenarios: [], scenarioMapping: migrationScenarios.map(([id, old, lines, surface]) => ({ id, old, lines, surface })) };
const errors = [];
let server, browser, context, page, cdp, activeScenario, serial = 0, cleanupPromise;

const room = (id, x, y, width, depth) => ({ id, spaceId: id, name: id, type: '방', x, y, width, depth, height: 240, color: '#d6ddd7', locked: false, walkthroughStart: false });
const item = { id: 'audit-item', name: 'Audit desk', type: 'desk', shape: 'rect', x: 170, y: 150,
  width: 100, depth: 60, height: 75, elevation: 0, rotation: 0, color: '#d8b596', locked: false };
const fixture = { wallHeight: 240, zones: [room('room-a', 0, 0, 400, 300), room('room-b', 400, 0, 300, 300), room('room-c', 0, 500, 300, 200)],
  items: [item], structures: [], dimensions: [], backgroundPlan: null };
const singleRoom = { wallHeight: 240, zones: [room('room', 0, 0, 600, 500)], items: [], structures: [], dimensions: [], backgroundPlan: null };
const requestedTypes = ['toilet', 'washbasin', 'kitchenSink', 'kitchenIsland', 'laundryTower', 'clothesRackSingle', 'clothesRackDoubleRow', 'clothesRackDoubleTier'];
const stored = `JSON.parse(localStorage.getItem('${STORAGE_KEY}'))`;
const ready3d = `document.querySelector('[data-walkthrough]')?.dataset.studioReady === 'true' && document.querySelector('[data-walkthrough]')?.dataset.assetState === 'ready' && (document.querySelector('[data-walkthrough]')?.dataset.viewMode === 'walk' || Boolean(document.querySelector('.studio3d-shell:not([hidden])')))`;
const pending = `document.querySelector('.studio3d-shell')?.dataset.pending === 'true'`;

function check(name, pass, actual, expected = true) {
  const result = { scenario: activeScenario, name, pass: Boolean(pass), actual, expected };
  report.interactionAssertions.push(result);
  if (!result.pass) console.error(`FAIL ${activeScenario}: ${name}\n${JSON.stringify({ actual, expected })}`);
  return result.pass;
}
const equal = (name, actual, expected) => check(name, isDeepStrictEqual(actual, expected), actual, expected);
const evaluate = expression => page.evaluate(expression);
const layout = () => evaluate(`(() => { const { draftMetadata, ...drawing } = ${stored}; return drawing; })()`);
const detail = async (id, collection = 'items') => (await layout())[collection].find(entry => entry.id === id);
const value = key => page.locator(`[data-studio-value="${key}"]`);

// Subscribe before the action. DOM observers also observe the render following a
// synchronous localStorage write; no storage monkeypatch or application bypass.
async function arm(expression, { event, target = 'document', mutations = true } = {}) {
  const key = `__mobileAuditSignal${serial++}`;
  await page.evaluate(({ key, expression, event, target, mutations, timeout }) => {
    const predicate = new Function(`return (${expression})`);
    const node = new Function(`return (${target})`)();
    let observer, timer;
    window[key] = new Promise(resolveSignal => {
      const finish = result => {
        clearTimeout(timer); observer?.disconnect();
        if (event) node.removeEventListener(event, receive, true);
        resolveSignal(result);
      };
      const inspect = () => {
        try { if (predicate()) finish({ ok: true }); }
        catch (error) { finish({ ok: false, error: error.message }); }
      };
      const receive = () => queueMicrotask(inspect);
      timer = setTimeout(() => finish({ ok: false, error: `State/event timeout: ${expression} (${event ?? 'DOM mutation'})` }), timeout);
      if (mutations) {
        observer = new MutationObserver(inspect);
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      }
      if (event) node.addEventListener(event, receive, true);
      if (!event) inspect();
    });
  }, { key, expression, event, target, mutations, timeout: TIMEOUT });
  return async () => {
    const result = await page.evaluate(async key => { const result = await window[key]; delete window[key]; return result; }, key);
    if (!result.ok) throw new Error(result.error);
  };
}
async function change(expression, trigger, options) {
  const received = await arm(expression, options);
  await trigger();
  await received();
}
async function click(selector) {
  // Playwright supplies real pointer input and hit testing; the click event is
  // the completion signal, rather than a pair of animation frames or a sleep.
  await change('true', () => page.locator(selector).click(), { event: 'click', mutations: false });
}
async function key(shortcut) {
  await change('true', () => page.keyboard.press(shortcut), { event: 'keyup', mutations: false });
}
async function input(selector, text) {
  const control = page.locator(selector);
  if (await control.evaluate(node => node.tagName === 'SELECT')) {
    await change('true', () => control.selectOption(String(text)), { event: 'change', mutations: false });
  } else {
    await control.fill(String(text));
    await key('Tab');
  }
}
async function field(key, text) { await input(`[data-studio-value="${key}"]`, text); }
async function capture(name) {
  const file = `${name}.png`;
  await page.screenshot({ path: join(artifactDir, file) });
  report.screenshots.push(file);
  return file;
}
async function point(selector, index = 0) {
  const control = page.locator(selector).nth(index);
  await control.scrollIntoViewIfNeeded();
  const rect = await control.boundingBox();
  assert(rect, `Missing visible ${selector}`);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
async function world(x, y) {
  return page.evaluate(({ x, y }) => {
    const p = new DOMPoint(x, y).matrixTransform(document.querySelector('#plan-canvas').getScreenCTM());
    return { x: p.x, y: p.y };
  }, { x, y });
}
async function mouseAt(p) {
  await change('true', () => page.mouse.click(p.x, p.y), { event: 'pointerup', mutations: false });
}
async function drag(start, end) {
  await page.mouse.move(start.x, start.y);
  await change('true', () => page.mouse.down(), { event: 'pointerdown', mutations: false });
  await change('true', () => page.mouse.move(end.x, end.y), { event: 'pointermove', mutations: false });
  await change('true', () => page.mouse.up(), { event: 'pointerup', mutations: false });
}
const contact = (id, p) => ({ id, x: p.x, y: p.y, radiusX: 2, radiusY: 2, force: 1 });
async function touch(type, points) {
  console.log(`  native ${type} ${JSON.stringify(points.map(p => [p.id, Math.round(p.x), Math.round(p.y)]))}`);
  const event = { touchStart: 'pointerdown', touchMove: 'pointermove', touchEnd: 'pointerup', touchCancel: 'pointercancel' }[type];
  assert(!['touchEnd', 'touchCancel'].includes(type) || points.length === 0, 'CDP end/cancel requires an empty active-contact list');
  await change('true', () => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points }), { event, mutations: false });
}
async function tap(p, id = 1) { await touch('touchStart', [contact(id, p)]); await touch('touchEnd', []); }
async function sizes(selector) {
  return page.locator(selector).evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.closest('[hidden]') && getComputedStyle(node).visibility !== 'hidden')
    .map(node => { const r = node.getBoundingClientRect(); return { name: node.getAttribute('aria-label') || node.textContent.trim(), width: r.width, height: r.height }; }));
}
const targets44 = entries => entries.length > 0 && entries.every(({ width, height }) => width >= 44 && height >= 44);
async function reset(width = 390, height = 844, initial = fixture, advanced = true) {
  await context?.close();
  context = await browser.newContext({ viewport: { width, height }, hasTouch: width <= 900, isMobile: width <= 900, reducedMotion: 'reduce', acceptDownloads: true });
  context.setDefaultTimeout(TIMEOUT);
  if (initial) await context.addInitScript(({ key, initial }) => {
    if (!sessionStorage.getItem('mobile-audit-initialized')) {
      localStorage.setItem(key, JSON.stringify(initial));
      sessionStorage.setItem('mobile-audit-initialized', 'true');
    }
  }, { key: STORAGE_KEY, initial });
  page = await context.newPage();
  page.on('pageerror', error => errors.push({ scenario: activeScenario, source: 'pageerror', text: error.message }));
  page.on('console', message => { if (message.type() === 'error') errors.push({ scenario: activeScenario, source: 'console', text: message.text() }); });
  cdp = await context.newCDPSession(page);
  await page.goto(report.url, { waitUntil: 'load' });
  await change(`Boolean(document.querySelector('.workspace'))`, async () => {});
  if (advanced && initial) await click('[data-workspace-mode]');
}
async function open3d(mode = 'dollhouse', expanded = false) {
  await change(ready3d, () => click('#open-walkthrough'));
  if (mode !== 'dollhouse') await change(`document.querySelector('[data-walkthrough]')?.dataset.viewMode === '${mode}'${mode === 'walk' ? " && Boolean(document.querySelector('[data-map-player][transform]'))" : ''}`, () => click(`[data-view-mode="${mode}"]`));
  if (expanded && await page.locator('[data-studio-toggle]').getAttribute('aria-expanded') === 'false') await togglePanel();
}
async function togglePanel() {
  const next = await page.locator('[data-studio-toggle]').getAttribute('aria-expanded') !== 'true';
  await change(`(() => { const shell = document.querySelector('.studio3d-shell'); return document.querySelector('[data-studio-toggle]').getAttribute('aria-expanded') === '${next}' && Math.abs(Number.parseFloat(document.querySelector('[data-walkthrough]').style.getPropertyValue('--studio-panel-height')) - shell.getBoundingClientRect().height) < 1; })()`,
    () => click('[data-studio-toggle]'));
  await change(`(() => { const stage = document.querySelector('[data-walkthrough-stage]').getBoundingClientRect(), panel = document.querySelector('.studio3d-shell').getBoundingClientRect();
    return matchMedia('(orientation: landscape)').matches ? stage.right <= panel.left : Math.abs(stage.bottom + 8 - panel.top) < 1; })()`, async () => {});
}
async function close3d() {
  await change(`!document.querySelector('[data-walkthrough]') && !document.fullscreenElement`, () => click('.walkthrough-exit[data-walkthrough-exit]'));
}
async function choose(kind, id) { await input('[data-studio-target]', `${kind}:${id}`); }
async function apply() {
  assert.equal(await evaluate(pending), true, 'Apply must commit a real pending edit');
  await change(`!(${pending}) && ${ready3d}`, () => click('[data-studio-apply]'));
}
async function add(type, kind = 'item') {
  await click(`[data-studio-tab="${kind === 'item' ? 'item' : 'structure'}"]`);
  const selector = `[data-studio-${kind === 'item' ? 'template' : 'structure'}="${type}"]`;
  await change(pending, () => click(selector));
  return page.locator('.studio3d-shell').getAttribute('data-selection-id');
}
async function boundaryControls() {
  return evaluate(`({ controls: document.querySelectorAll('[data-add-type], [data-add-structure], #add-custom, #clear-furniture, [data-item-field], [data-structure-field], [data-item-rotate], [data-structure-rotate], [data-select-item], [data-select-structure]').length,
    selectedDetails: document.querySelectorAll('.plan-item.is-selected, .plan-structure.is-selected').length,
    interactiveDetails: [...document.querySelectorAll('.plan-item, .plan-structure')].filter(n => getComputedStyle(n).pointerEvents !== 'none').length })`);
}
async function scenario(id, body) {
  activeScenario = id;
  console.log(`START ${id}`);
  const entry = { id, startedAt: new Date().toISOString() };
  report.scenarios.push(entry);
  const first = report.interactionAssertions.length;
  try { await body(); }
  catch (error) {
    entry.error = { message: error.message, stack: error.stack };
    check(`${id} completes every mapped action`, false, error.message, 'all mapped actions execute');
    if (page && !page.isClosed()) await capture(`failure-${id}`);
  }
  entry.assertions = report.interactionAssertions.length - first;
  entry.pass = report.interactionAssertions.slice(first).every(result => result.pass);
  entry.finishedAt = new Date().toISOString();
  await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${entry.pass ? 'PASS' : 'FAIL'} ${id}: ${entry.assertions} assertions`);
}
async function cleanup() {
  cleanupPromise ??= (async () => { await browser?.close(); await server?.close(); })();
  return cleanupPromise;
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { void cleanup().finally(() => { process.exitCode = 1; }); });

try {
  await mkdir(artifactDir, { recursive: true });
  assert(chrome, `Chrome not found: ${chromeCandidates.join(', ')}`);
  const port = await new Promise((resolvePort, reject) => {
    const socket = createServer(); socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const { port } = socket.address(); socket.close(error => error ? reject(error) : resolvePort(port)); });
  });
  // Vite's listening promise and Playwright's browser pipe replace URL polling.
  server = await preview({ root, preview: { host: '127.0.0.1', port, strictPort: true, open: false } });
  report.url = `http://127.0.0.1:${port}/`;
  report.ports = { preview: port, chromeDebugging: 'isolated pipe' };
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-unsafe-swiftshader'], timeout: TIMEOUT });

  await scenario('viewport', async () => {
    for (const [width, height] of [[320, 700], [390, 844], [430, 932], [768, 1024], [844, 390], [1024, 768], [1440, 1000]]) {
      await reset(width, height);
      const data = await evaluate(`({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, nav: getComputedStyle(document.querySelector('.mobile-nav')).display,
        workspace: getComputedStyle(document.querySelector('.workspace')).display })`);
      check(`${width}x${height} no horizontal overflow`, data.scrollWidth <= data.width, data);
      equal(`${width}x${height} navigation breakpoint`, data.nav !== 'none', width <= 900);
      if (width > 900) { check(`${width} desktop workspace visible`, data.workspace !== 'none', data); equal(`${width} desktop grid`, data.workspace, 'grid'); }
      report.viewports.push({ width, height, touch: width <= 900, data, screenshot: await capture(`viewport-${width}x${height}`) });
    }
    await reset();
    const groups = [];
    for (const [name, selector] of [['navigation', '.mobile-nav [role="tab"]'], ['toolbar', '.canvas-toolbar button'], ['actions', '.canvas-actions button']]) {
      const entries = await sizes(selector); groups.push(entries);
      check(`390x844 ${name} 44px targets`, targets44(entries), entries);
    }
    check('390x844 all mobile controls 44px', groups.every(targets44), groups);
    equal('390x844 no document overflow', await evaluate('document.documentElement.scrollWidth'), 390);
    await click('[data-cloud-open]');
    const account = await evaluate(`({ modal: Boolean(document.querySelector('.cloud-dialog[role="dialog"][aria-modal="true"]')), inert: document.querySelector('.workspace').inert,
      focused: document.querySelector('.cloud-dialog').contains(document.activeElement), setup: !document.querySelector('[data-cloud-email-form]') || Boolean(document.querySelector('[data-cloud-google]')) })`);
    check('account works without credentials with inert background and focus', account.modal && account.inert && account.focused && account.setup, account);
    check('account close 44px target', targets44(await sizes('[data-cloud-close]')), await sizes('[data-cloud-close]'));
    await capture('mobile-account');
    await click('[data-cloud-close]');
    equal('account close restores entry focus', await evaluate(`document.activeElement.matches('[data-cloud-open]')`), true);
    await reset(390, 844, null, false);
    await click('[data-start-sample]');
    const starter = await layout();
    check('starter sample creates a real complete drawing', starter.zones.length > 0 && starter.items.length > 0 && !await page.locator('[data-start-backdrop]').count(), { zones: starter.zones.length, items: starter.items.length });
  });

  await scenario('tabs', async () => {
    await reset();
    const tabs = await evaluate(`({ role: document.querySelector('.mobile-nav [role="tablist"]').getAttribute('role'), tabs: [...document.querySelectorAll('.mobile-nav [role="tab"]')].map(tab => {
      const panel = document.getElementById(tab.getAttribute('aria-controls')); return { id: tab.id, selected: tab.getAttribute('aria-selected'), tabIndex: tab.tabIndex,
        linked: panel?.getAttribute('role') === 'tabpanel' && panel.getAttribute('aria-labelledby') === tab.id, hiddenIcon: tab.querySelector('b')?.getAttribute('aria-hidden') }; }) })`);
    equal('mobile nav tablist role', tabs.role, 'tablist');
    check('tabs link to labelled panels', tabs.tabs.length === 3 && tabs.tabs.every(t => t.linked), tabs);
    check('one roving active tab', tabs.tabs.filter(t => t.selected === 'true' && t.tabIndex === 0).length === 1 && tabs.tabs.every(t => t.selected === 'true' || t.tabIndex === -1), tabs);
    check('tab icons hidden from accessibility tree', tabs.tabs.every(t => t.hiddenIcon === 'true'), tabs);
    await click('#mobile-tab-spaces');
    const panels = await panelState();
    check('inactive panels inert and focus restored', mobilePanels(panels) && await evaluate(`document.activeElement.id === 'mobile-tab-spaces'`), panels);
    await key('ArrowRight');
    equal('tab ArrowRight selects inspector', await evaluate('document.activeElement.id'), 'mobile-tab-inspector');
    await key('Home');
    equal('tab Home selects canvas', await evaluate('document.activeElement.id'), 'mobile-tab-canvas');
    equal('removed furniture tab absent', await page.locator('#mobile-tab-furniture').count(), 0);
  });

  await scenario('catalog', async () => {
    await reset(390, 844, singleRoom);
    equal('2D exposes no furniture/structure mutators', await boundaryControls(), { controls: 0, selectedDetails: 0, interactiveDetails: 0 });
    await open3d('top', true);
    for (const type of requestedTypes) {
      const entries = await sizes(`[data-studio-template="${type}"]`);
      check(`3D ${type} named 44px catalog target`, targets44(entries) && entries.every(e => e.name), entries);
    }
    await capture('mobile-furniture-catalog');
    await click('[data-studio-tab="structure"]');
    const types = await page.locator('[data-studio-structure]').evaluateAll(nodes => nodes.map(n => n.dataset.studioStructure).sort());
    equal('3D all four structure catalog types', types, ['sliding', 'swing', 'wall', 'window']);
    check('structure catalog 44px targets', targets44(await sizes('[data-studio-structure]')), await sizes('[data-studio-structure]'));
    const wallId = await add('wall', 'structure'); await apply();
    const doorId = await add('swing', 'structure');
    equal('door preview does not seed persisted state', (await layout()).structures.length, 1);
    await apply();
    check('door attaches to real selected wall', (await detail(doorId, 'structures')).wallId === wallId, await detail(doorId, 'structures'));
    const actions = await sizes('[data-studio-opening]');
    check('selected mobile door has three 44px opening actions', actions.length === 3 && targets44(actions), actions);
    await click('[data-studio-opening="1"]'); await apply();
    equal('mobile open persists 90 degrees', (await detail(doorId, 'structures')).openAngle, 90);
    await inspectContainment('portrait');
    await capture('mobile-door-inspector');
    await close3d();
    equal('return to 2D leaves details read-only', await boundaryControls(), { controls: 0, selectedDetails: 0, interactiveDetails: 0 });
  });

  await scenario('hostile', async () => {
    const hostile = { wallHeight: 240,
      zones: [{ ...room('" onpointerdown=window.__zoneIdInjected=1', 0, 0, 400, 300), name: 'Hostile zone', spaceId: '"><img id=space-id-injection>', x: '0" onpointerdown=window.__zoneIdInjected=2', color: '"><img id=layout-color-injection src=x onerror=window.__layoutColorInjected=1>' }],
      items: [{ ...item, id: '" onclick=window.__itemIdInjected=1', rotation: '0" onclick=window.__itemIdInjected=2', color: 'red;fill:url(javascript:window.__layoutColorInjected=2)' }],
      structures: [{ id: 'hostile-wall', name: 'Hostile wall', type: 'wall', x: 200, y: 220, length: 40, height: 240, thickness: 4, orientation: 'horizontal' },
        { id: '"><img id=structure-injection src=x onerror=window.__structureInjected=1>', name: 'Hostile door', type: 'door', doorType: 'sliding" onpointerdown=window.__structureInjected=2', x: 200, y: 220, width: 300, height: 205, orientation: 'diagonal', wallId: 'hostile-wall' }] };
    await reset(390, 844, hostile);
    const state = await evaluate(`({ zoneFill: document.querySelector('.plan-zone rect:not(.zone-hit-target)')?.getAttribute('fill'), itemFill: document.querySelector('.plan-item .item-shape')?.getAttribute('fill'),
      injections: document.querySelectorAll('#layout-color-injection, #structure-injection, img[onerror], [onpointerdown], iframe[src^="javascript:"]').length,
      values: (window.__zoneIdInjected ?? 0) + (window.__itemIdInjected ?? 0) + (window.__layoutColorInjected ?? 0) + (window.__structureInjected ?? 0),
      ids: [...document.querySelectorAll('.plan-zone, .plan-item')].map(n => n.dataset.zoneId ?? n.dataset.itemId), swing: Boolean(document.querySelector('.plan-door.door-swing')),
      payload: /space-id-injection|zoneIdInjected|itemIdInjected|layout-color-injection|sliding&quot; onpointerdown/.test(document.documentElement.innerHTML) })`);
    equal('hostile colors use safe fallbacks', [state.zoneFill, state.itemFill], ['#d9d2c2', '#d8b596']);
    check('hostile IDs/markup cannot inject into 2D', state.injections === 0 && state.values === 0 && !state.payload && state.ids.every(id => /^[\w-]+$/.test(id)) && state.swing, state);
    await open3d('top', true);
    await choose('structure', 'hostile-wall');
    equal('normalized wall length observed through 3D inspector', await value('length').inputValue(), '50');
    const doorOption = await page.locator('[data-studio-target] option').evaluateAll(nodes => nodes.find(n => n.textContent.includes('Hostile door')).value);
    await input('[data-studio-target]', doorOption);
    equal('attached hostile door width clamped to owner', await value('width').inputValue(), '50');
    equal('invalid door type normalized in real inspector', await value('doorType').inputValue(), 'swing');
    equal('hostile markup cannot inject into 3D', await page.locator('img[onerror], [onpointerdown]').count(), 0);
    await close3d();
  });

  await scenario('pan-pinch', async () => {
    await reset();
    await click('#zoom-out'); await click('#zoom-out');
    const blank = await blankPoint();
    const before = await evaluate(`({ view: document.querySelector('#plan-canvas').getAttribute('viewBox'), storage: JSON.stringify(localStorage) })`);
    await touch('touchStart', [contact(1, blank)]);
    await touch('touchMove', [contact(1, { x: blank.x + 40, y: blank.y + 30 })]);
    await touch('touchEnd', []);
    const after = await evaluate(`({ view: document.querySelector('#plan-canvas').getAttribute('viewBox'), storage: JSON.stringify(localStorage) })`);
    check('native blank drag pans without persistence', before.view !== after.view && before.storage === after.storage, { before, after });
    await reset();
    const center = await point('#plan-canvas');
    const a = { x: center.x - 45, y: center.y }, b = { x: center.x + 45, y: center.y };
    const wideA = { x: center.x - 100, y: center.y }, wideB = { x: center.x + 100, y: center.y };
    const view = await page.locator('#plan-canvas').getAttribute('viewBox');
    await touch('touchStart', [contact(1, a)]); await touch('touchStart', [contact(1, a), contact(2, b)]);
    await touch('touchMove', [contact(1, wideA), contact(2, wideB)]);
    const zoomed = await page.locator('#plan-canvas').getAttribute('viewBox');
    // Chromium's native WebTouchEvent driver treats nonempty touchEnd points as
    // the RELEASED IDs (content/browser/devtools/protocol/input_handler.cc,
    // CreateWebTouchEvents). The legacy test ended ID 1, then moved that ended
    // ID, rather than moving the live contact. End ID 2 and really move ID 1.
    await change('true', () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [contact(2, wideB)] }), { event: 'pointerup', mutations: false });
    const released = await page.locator('#plan-canvas').getAttribute('viewBox');
    await touch('touchMove', [contact(1, { x: wideA.x - 30, y: wideA.y + 20 })]);
    equal('pinch await-release ignores remaining contact', await page.locator('#plan-canvas').getAttribute('viewBox'), released);
    check('native two-contact pinch actually zooms', view !== zoomed, { view, zoomed });
    await touch('touchEnd', []);
    for (const [from, to, expected] of [[100, 2, '5%'], [20, 170, '600%']]) {
      await reset(); const c = await point('#plan-canvas');
      const p = spread => [contact(1, { x: c.x - spread, y: c.y }), contact(2, { x: c.x + spread, y: c.y })];
      await touch('touchStart', p(from).slice(0, 1)); await touch('touchStart', p(from)); await touch('touchMove', p(to)); await touch('touchEnd', []);
      equal(`native pinch clamps ${expected}`, await page.locator('#zoom-level').textContent(), expected);
    }
  });

  await scenario('space-touch', async () => {
    await reset();
    await tap(await zonePoint('room-a'));
    const menu = await sizes('[data-context-action]');
    check('first native space tap selects and opens accessible menu', await page.locator('.plan-zone.is-selected').count() === 1 && await page.locator('.mobile-context-menu').count() === 1 && targets44(menu), menu);
    equal('space menu initially focuses move', await evaluate('document.activeElement.dataset.contextAction'), 'move');
    equal('2D space menu does not offer furniture rotation', await page.locator('[data-context-action="rotate"]').count(), 0);
    await key('Escape');
    check('Escape closes menu and restores canvas focus', !await page.locator('.mobile-context-menu').count() && await evaluate(`document.activeElement.id === 'plan-canvas'`), await evaluate('document.activeElement.id'));
    const before = await layout();
    const start = await zonePoint('room-a');
    await touch('touchStart', [contact(1, start)]); await touch('touchMove', [contact(1, { x: start.x + 30, y: start.y + 20 })]); await touch('touchEnd', []);
    const moved = await layout();
    check('selected space moves immediately with native touch', moved.zones[0].x !== before.zones[0].x || moved.zones[0].y !== before.zones[0].y, { before: before.zones[0], after: moved.zones[0] });
    equal('space drag never moves read-only furniture', moved.items, before.items);
    await click('#zoom-out'); await click('#zoom-out'); await tap(await blankPoint());
    equal('blank native tap clears selection/menu', await evaluate(`({ selected: document.querySelectorAll('.plan-zone.is-selected').length, menu: Boolean(document.querySelector('.mobile-context-menu')) })`), { selected: 0, menu: false });
    await reset();
    const unselected = await layout(), p = await world(100, 80);
    await touch('touchStart', [contact(1, p)]); await touch('touchMove', [contact(1, { x: p.x + 35, y: p.y + 20 })]); await touch('touchEnd', []);
    equal('advanced unselected swipe does not accidentally mutate a space', (await layout()).zones, unselected.zones);
    await tap(await zonePoint('room-a')); await key('Escape');
    const handle = await point('[data-resize-kind="zone"][data-resize-handle="se"]');
    check('space resize handle is hit-testable without modal', await evaluate(`document.elementFromPoint(${handle.x}, ${handle.y})?.closest('[data-resize-kind="zone"]') !== null`), handle);
    await touch('touchStart', [contact(1, handle)]); await touch('touchMove', [contact(1, { x: handle.x + 24, y: handle.y + 18 })]); await touch('touchEnd', []);
    const resized = (await layout()).zones[0];
    check('native space resize changes both persisted dimensions', resized.width !== unselected.zones[0].width && resized.depth !== unselected.zones[0].depth, resized);
    await click('#undo-action');
    equal('one undo restores native resize dimensions', (await layout()).zones, unselected.zones);
    await tap(await zonePoint('room-a')); await key('Escape');
    const h = await point('[data-resize-kind="zone"][data-resize-handle="se"]'), rollback = await layout();
    await touch('touchStart', [contact(1, h)]); const end = { x: h.x + 20, y: h.y + 16 };
    await touch('touchMove', [contact(1, end)]); await touch('touchStart', [contact(1, end), contact(2, { x: h.x - 50, y: h.y - 35 })]);
    await touch('touchEnd', []);
    equal('second touch rolls in-flight space resize back', await layout(), rollback);
    equal('cancelled resize leaves history empty', await page.locator('#undo-action').isDisabled(), true);
    await click('[data-mobile-panel="spaces"]'); await click('#add-zone'); await click('[data-mobile-panel="inspector"]');
    await input('[data-zone-field="name"]', 'Mobile bathroom'); await input('[data-zone-field="type"]', '욕실');
    await input('[data-zone-field="width"]', 260); await input('[data-zone-field="depth"]', 220); await input('[data-zone-field="height"]', 250);
    const created = (await layout()).zones.at(-1);
    equal('mobile real space CRUD persists name/type/size/height', [created.name, created.type, created.width, created.depth, created.height], ['Mobile bathroom', '욕실', 260, 220, 250]);
    await click('[data-delete-space]');
    check('mobile space deletion preserves furniture and other spaces', (await layout()).zones.length === 3 && !(await layout()).zones.some(z => z.id === created.id) && isDeepStrictEqual((await layout()).items, unselected.items), await layout());
  });

  await scenario('detail-touch', async () => {
    await reset(390, 844, { ...singleRoom, items: [{ ...item, x: 300, y: 250, width: 150, depth: 120 }] });
    await open3d('top', true);
    await choose('item', item.id);
    const origin = await detail(item.id);
    // The top-view scene is centered on this single centered item. Native hit
    // testing must select it; no projected test-only scene accessor is used.
    await togglePanel();
    const p = await sceneItemPoint(item.id);
    await tap(p);
    equal('native scene tap selects actual furniture', await page.locator('.studio3d-shell').getAttribute('data-selection-id'), item.id);
    await touch('touchStart', [contact(1, p)]);
    await change(pending, () => touch('touchMove', [contact(1, { x: p.x + 22, y: p.y + 12 })]));
    await touch('touchEnd', []);
    equal('immediate 3D drag is preview-only until Apply', await detail(item.id), origin);
    await apply();
    const moved = await detail(item.id);
    check('native furniture drag commits changed coordinates and unchanged rotation', (moved.x !== origin.x || moved.y !== origin.y) && moved.rotation === origin.rotation, { origin, moved });
    await click('[data-studio-undo]');
    equal('one 3D undo restores entire drag', await detail(item.id), origin);
    for (const cancellation of ['touchCancel', 'second-contact']) {
      const baseline = await layout();
      await touch('touchStart', [contact(1, p)]);
      const end = { x: p.x + 20, y: p.y + 10 };
      await change(pending, () => touch('touchMove', [contact(1, end)]));
      if (cancellation === 'touchCancel') await change(`!(${pending})`, () => touch('touchCancel', []));
      else { await change(`!(${pending})`, () => touch('touchStart', [contact(1, end), contact(2, { x: p.x - 45, y: p.y })])); await touch('touchEnd', []); }
      equal(`${cancellation} rolls preview back without persistence`, await layout(), baseline);
      equal(`${cancellation} leaves undo empty`, await page.locator('[data-studio-undo]').isDisabled(), true);
    }
    await togglePanel(); await choose('item', item.id);
    check('numeric resize/rotate touch alternatives meet 44px', targets44(await sizes('[data-studio-value="width"], [data-studio-value="depth"], [data-studio-value="rotation"], [data-studio-rotate]')), await sizes('[data-studio-value="width"], [data-studio-value="depth"], [data-studio-value="rotation"], [data-studio-rotate]'));
    await field('width', 190); await field('depth', 140);
    equal('numeric resize remains a disposable preview', await detail(item.id), origin);
    await click('[data-studio-cancel]');
    equal('numeric resize cancel restores inspector', [await value('width').inputValue(), await value('depth').inputValue()], ['150', '120']);
    await field('width', 190); await field('depth', 140); await apply();
    equal('3D dimensions commit together', [ (await detail(item.id)).width, (await detail(item.id)).depth ], [190, 140]);
    await click('[data-studio-undo]'); equal('resize single undo', await detail(item.id), origin);
    await field('rotation', 73);
    check('continuous rotation preview is announced without persistence', await evaluate(pending) && await page.locator('[data-studio-draft]').getAttribute('class') !== 'hidden' && (await detail(item.id)).rotation === 0, { preview: await value('rotation').inputValue(), saved: (await detail(item.id)).rotation });
    await apply(); equal('continuous numeric rotation persists', (await detail(item.id)).rotation, 73);
    await click('[data-studio-rotate]'); await apply();
    equal('mobile rotate action advances exactly once by 15 degrees', (await detail(item.id)).rotation, 88);
    await capture('mobile-detail-edit'); await close3d();
    equal('removed 2D item resize and rotation handles stay absent', await page.locator('[data-resize-kind="item"], [data-item-rotate]').count(), 0);
  });

  await scenario('space-group', async () => {
    await reset(); await click('#multi-select-action');
    await tap(await zonePoint('room-a')); await tap(await zonePoint('room-b'));
    equal('native mobile multi-select chooses two spaces', await page.locator('.plan-zone.is-selected').count(), 2);
    check('space group bar exposes 44px actions', targets44(await sizes('.mobile-selection-bar button')), await sizes('.mobile-selection-bar button'));
    equal('removed furniture group rotation is absent', await page.locator('[data-group-action="rotate"]').count(), 0);
    const before = await layout(); await click('[data-group-action="move"]');
    const p = await zonePoint('room-a');
    await touch('touchStart', [contact(1, p)]); await touch('touchMove', [contact(1, { x: p.x + 24, y: p.y + 16 })]); await touch('touchEnd', []);
    const after = await layout(), deltas = after.zones.slice(0, 2).map((z, i) => ({ x: z.x - before.zones[i].x, y: z.y - before.zones[i].y }));
    check('mobile group move applies equal nonzero deltas', JSON.stringify(deltas[0]) === JSON.stringify(deltas[1]) && (deltas[0].x || deltas[0].y), deltas);
    equal('space grouping never mutates furniture', after.items, before.items);
    await capture('mobile-space-group');
    await reset(); await click('#zoom-out'); await click('#multi-select-action');
    const start = await world(-100, -100), end = await world(800, 400);
    equal('marquee starts on actual blank canvas outside 44px space halos', await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.classList.contains('grid-background'), start), true);
    await touch('touchStart', [contact(1, start)]); await touch('touchMove', [contact(1, end)]);
    equal('native marquee visible during gesture', await page.locator('.selection-marquee').count(), 1);
    await touch('touchEnd', []);
    check('marquee clears and selects at least two spaces only', !await page.locator('.selection-marquee').count() && await page.locator('.plan-zone.is-selected').count() >= 2 && !await page.locator('.plan-item.is-selected').count(), await page.locator('.plan-zone.is-selected').count());
    await reset(); await tap(await zonePoint('room-a')); await key('Escape');
    for (const [label, count, selector] of [['100%', 0, '#zoom-in'], ['50%', 2, '#zoom-out'], ['600%', 22, '#zoom-in']]) {
      for (let i = 0; i < count; i++) await click(selector);
      const targets = await page.locator('.zone-hit-target, .resize-hit-target').evaluateAll(nodes => nodes.map(node => ({ width: parseFloat(getComputedStyle(node).strokeWidth), vector: getComputedStyle(node).vectorEffect, separate: node.classList.contains('zone-hit-target') ? Boolean(node.parentElement.querySelector('rect:not(.zone-hit-target)')) : Boolean(node.nextElementSibling) })));
      check(`${label} space/resize hit targets separate non-scaling 44px`, await page.locator('#zoom-level').textContent() === label && targets.length > 1 && targets.every(t => t.width === 44 && t.vector === 'non-scaling-stroke' && t.separate), targets);
    }
    await reset();
    const halo = await zoneHalo(); check('unselected zone halo resolves outside visible fill', Boolean(halo), halo);
    await tap(halo); await key('Escape');
    const selectedHalo = await zoneHalo(halo.id);
    check('selected zone retains same usable outside halo', selectedHalo?.id === halo.id, selectedHalo);
    const haloLayout = await layout();
    await tap(selectedHalo); await key('Escape');
    equal('selected outside halo remains a real touch target without changing geometry', await layout(), haloLayout);
  });

  await scenario('breakpoint', async () => {
    await reset(768, 1024);
    const token = await evaluate(`window.__mobileAuditDocumentToken = crypto.randomUUID()`);
    const before = await panelState();
    await change(`matchMedia('(min-width:901px)').matches && [...document.querySelectorAll('[role="tabpanel"]')].every(p => p.getAttribute('aria-hidden') === 'false' && !p.inert)`, () => page.setViewportSize({ width: 1024, height: 768 }));
    const desktop = await panelState();
    await change(`matchMedia('(max-width:900px)').matches && [...document.querySelectorAll('[role="tabpanel"]')].filter(p => p.getAttribute('aria-hidden') === 'false' && !p.inert).length === 1`, () => page.setViewportSize({ width: 768, height: 1024 }));
    const after = await panelState();
    check('same-document breakpoint restores mobile/desktop panel accessibility', mobilePanels(before) && desktop.every(p => !p.inert && p.hidden === 'false') && mobilePanels(after), { before, desktop, after });
    equal('breakpoint transition never reloads document', await evaluate('window.__mobileAuditDocumentToken'), token);
  });

  await scenario('walk-mobile', async () => {
    for (const [width, height] of [[390, 844], [844, 390]]) {
      await reset(width, height, singleRoom); const errorStart = errors.length;
      await open3d('walk');
      const ui = await walkUI(), entryPose = await pose();
      check(`${width}x${height} coarse controls and modal focus`, ui.joystick && ui.look && ui.cone && !ui.keyboard && ui.focused && ui.menuInert && ui.menuHidden === 'true', ui);
      check(`${width}x${height} joystick/exit 44px`, targets44(await sizes('[data-walkthrough-joystick], [data-walkthrough-exit]')), await sizes('[data-walkthrough-joystick], [data-walkthrough-exit]'));
      const p = await point('[data-walkthrough-joystick]');
      for (const ending of ['touchEnd', 'touchCancel', 'lostpointercapture']) {
        const origin = await pose();
        await touch('touchStart', [contact(1, p)]);
        await change(movedExpression(origin), () => touch('touchMove', [contact(1, { x: p.x + 24, y: p.y - 24 })]));
        const moved = await pose();
        let stationary;
        if (ending === 'lostpointercapture') {
          const capture = await evaluate(`(() => { const j = document.querySelector('[data-walkthrough-joystick]'); return j.classList.contains('is-active'); })()`);
          // A real capture is released; a subsequent native move emits the exact
          // lostpointercapture event (no synthetic application cancellation).
          await page.evaluate(() => {
            const j = document.querySelector('[data-walkthrough-joystick]');
            window.__mobileCapturedPointer = null;
            j.addEventListener('pointermove', event => { window.__mobileCapturedPointer = event.pointerId; }, { once: true });
          });
          await touch('touchMove', [contact(1, { x: p.x + 26, y: p.y - 24 })]);
          const owned = await evaluate(`document.querySelector('[data-walkthrough-joystick]').hasPointerCapture(window.__mobileCapturedPointer)`);
          stationary = await stationaryFrames('lostpointercapture', async () => {
            await evaluate(`document.querySelector('[data-walkthrough-joystick]').releasePointerCapture(window.__mobileCapturedPointer)`);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [contact(1, { x: p.x + 27, y: p.y - 24 })] });
          });
          await touch('touchEnd', []);
          check(`${width} actual pointer capture was acquired and released`, capture && owned && !await evaluate(`document.querySelector('[data-walkthrough-joystick]').hasPointerCapture(window.__mobileCapturedPointer)`), { capture, owned });
        } else stationary = await stationaryFrames(ending === 'touchEnd' ? 'pointerup' : 'pointercancel', () => touch(ending, []));
        check(`${width} ${ending} stops analog movement with zero drift`, distance(origin, moved) > .5 && stationary.drift < .05, { origin, moved, stationary });
      }
      const canvas = await page.locator('[data-walkthrough-canvas]').boundingBox();
      const start = { x: canvas.x + canvas.width * .75, y: canvas.y + canvas.height * .5 }, end = { x: start.x - 70, y: start.y + 18 };
      const beforeLook = await pose();
      await touch('touchStart', [contact(1, start)]);
      await change(rotatedExpression(beforeLook), () => touch('touchMove', [contact(1, end)])); await touch('touchEnd', []);
      check(`${width} native right-look changes camera direction`, Math.abs((await pose()).rotation - beforeLook.rotation) > .5, { beforeLook, after: await pose() });
      await capture(`coarse-3d-${width}x${height}`); await close3d(); await open3d('walk');
      const reopenedPose = await pose(), reopened = await stationaryFrames();
      check(`${width} close/reopen has no stale movement`, reopened.drift < .05 && distance(entryPose, reopenedPose) < .05, { entryPose, reopenedPose, ...reopened });
      await close3d(); equal(`${width} walkthrough no browser errors`, errors.slice(errorStart), []);
    }
  });

  await scenario('space-desktop', async () => {
    await reset(1440, 1000);
    equal('desktop hides mobile navigation', await page.locator('.mobile-nav').isVisible(), false);
    const p = await point('#plan-canvas'), zoom = await page.locator('#zoom-level').textContent();
    await page.mouse.move(p.x, p.y);
    await change(`document.querySelector('#zoom-level').textContent !== ${JSON.stringify(zoom)}`, () => page.mouse.wheel(0, -180));
    check('real mouse wheel changes canvas zoom', await page.locator('#zoom-level').textContent() !== zoom, await page.locator('#zoom-level').textContent());
    await click('[data-select-zone="room-a"]'); const before = await layout();
    const start = await world(90, 70); await drag(start, { x: start.x + 40, y: start.y + 25 });
    const moved = await layout();
    check('desktop direct space drag persists coordinates', moved.zones[0].x !== before.zones[0].x || moved.zones[0].y !== before.zones[0].y, moved.zones[0]);
    equal('desktop space drag leaves furniture unchanged', moved.items, before.items);
    await page.keyboard.down('Shift'); await click('[data-select-zone="room-b"]'); await page.keyboard.up('Shift');
    const groupBefore = await layout(), g = await world(moved.zones[0].x + 90, moved.zones[0].y + 70);
    await drag(g, { x: g.x + 32, y: g.y + 20 });
    const groupAfter = await layout(), delta = groupAfter.zones.slice(0, 2).map((z, i) => [z.x - groupBefore.zones[i].x, z.y - groupBefore.zones[i].y]);
    check('Shift-selected spaces move by equal nonzero deltas', JSON.stringify(delta[0]) === JSON.stringify(delta[1]) && delta[0].some(Boolean), delta);
    const count = await page.locator('.plan-zone.is-selected').count(); await page.keyboard.down('Shift'); await mouseAt(await blankPoint()); await page.keyboard.up('Shift');
    check('Shift blank click preserves multi-selection', count >= 2 && await page.locator('.plan-zone.is-selected').count() === count, count);
    await reset(1440, 1000); await click('[data-select-zone="room-a"]'); await page.keyboard.down('Shift'); await click('[data-select-zone="room-c"]'); await page.keyboard.up('Shift');
    equal('disconnected spaces cannot merge', await page.locator('[data-merge-spaces]').count(), 0);
    await click('[data-select-zone="room-a"]'); await page.keyboard.down('Shift'); await click('[data-select-zone="room-b"]'); await page.keyboard.up('Shift');
    const mergeBefore = await layout(); await click('[data-merge-spaces]'); const merged = await layout();
    check('adjacent spaces merge without automatic doors', merged.zones[0].spaceId === merged.zones[1].spaceId && merged.structures.length === 0, merged);
    equal('space merge preserves read-only furniture', merged.items, mergeBefore.items);
    const sharedWall = await evaluate(`Array.from(document.querySelectorAll('.structural-walls line')).some(l => l.getAttribute('x1') === '400' && l.getAttribute('x2') === '400' && l.getAttribute('y1') === '0' && l.getAttribute('y2') === '300')`);
    equal('merged space loses automatic internal boundary', sharedWall, false);
    await reset(1440, 1000); await click('[data-select-zone="room-a"]');
    const original = (await layout()).zones[0], h = await point('[data-resize-kind="zone"][data-resize-handle="se"]');
    await drag(h, { x: h.x + 30, y: h.y + 20 }); const resized = (await layout()).zones[0];
    check('desktop resize persists both space dimensions', resized.width !== original.width && resized.depth !== original.depth, { original, resized });
    await key('Meta+z'); equal('Meta+Z restores resize', (await layout()).zones[0], original);
    await key('Control+y'); equal('Ctrl+Y reapplies resize', (await layout()).zones[0], resized);
    equal('2D item mutation affordances remain absent', (await boundaryControls()).controls, 0);
  });

  await scenario('detail-desktop', async () => {
    await reset(1440, 1000, singleRoom); await open3d('top', true);
    const id = await add('custom'); await field('x', 300); await field('y', 250); await apply();
    await field('rotation', 37); await apply();
    equal('exact 3D rotation commits 37 degrees', (await detail(id)).rotation, 37);
    // A number input replaces the removed 2D slider; its complete keyboard path
    // must reach the formerly asserted 359-degree value, not a hidden handle.
    await value('rotation').focus(); await key('ControlOrMeta+a'); await page.keyboard.insertText('359'); await key('Tab'); await apply();
    equal('accessible numeric rotation reaches 359 degrees', [(await detail(id)).rotation, await value('rotation').inputValue()], [359, '359']);
    const origin = await detail(id); const p = await sceneItemPoint(id, false);
    await drag(p, { x: p.x + 35, y: p.y + 20 });
    equal('real desktop 3D drag remains uncommitted preview', await detail(id), origin);
    await apply(); const moved = await detail(id);
    check('real desktop 3D drag changes saved coordinates not rotation', (moved.x !== origin.x || moved.y !== origin.y) && moved.rotation === origin.rotation, { origin, moved });
    await field('width', 130); await field('depth', 90); await apply();
    equal('desktop 3D numeric resize persists both dimensions', [(await detail(id)).width, (await detail(id)).depth], [130, 90]);
    const wallId = await add('wall', 'structure'); await field('length', 500); await field('thickness', 4); await field('x', 300); await field('y', 180); await apply();
    const swingId = await add('swing', 'structure'); await field('x', 170); await field('width', 130); await field('hinge', 'end'); await field('openSide', 1); await field('openAngle', 65); await apply();
    await choose('structure', wallId);
    const slidingId = await add('sliding', 'structure'); await field('x', 430); await field('width', 140); await field('slideDirection', 'start'); await field('openRatio', 75); await apply();
    const wall = await detail(wallId, 'structures'), swing = await detail(swingId, 'structures'), sliding = await detail(slidingId, 'structures');
    check('real 3D creates thin wall and two distinct attached doors', wall.thickness === 4 && swing.wallId === wallId && sliding.wallId === wallId && swing.doorType === 'swing' && sliding.doorType === 'sliding', { wall, swing, sliding });
    equal('swing width/hinge/side/open angle persist', [swing.width, swing.hinge, swing.openSide, swing.openAngle], [130, 'end', 1, 65]);
    equal('sliding width/direction/open percentage persist', [sliding.width, sliding.slideDirection, sliding.openRatio], [140, 'start', 75]);
    equal('opening actions are complete machine values', await page.locator('[data-studio-opening]').evaluateAll(nodes => nodes.map(n => Number(n.dataset.studioOpening))), [0, .5, 1]);
    await click('[data-studio-opening="1"]'); await apply(); equal('sliding open persists 100 percent', (await detail(slidingId, 'structures')).openRatio, 100);
    await capture('desktop-wall-doors-3d'); await close3d();
    const symbols = await evaluate(`({ walls: document.querySelectorAll('.plan-wall').length, swing: document.querySelectorAll('.plan-door.door-swing').length, sliding: document.querySelectorAll('.plan-door.door-sliding').length,
      spans: document.querySelectorAll('.plan-wall .wall-stroke').length, masks: document.querySelectorAll('.plan-door .door-opening').length,
      panels: [...document.querySelectorAll('.door-sliding .door-panel')].map(n => Number(n.getAttribute('y1'))) })`);
    check('read-only 2D preserves distinct door symbols and three wall spans', symbols.walls === 1 && symbols.swing === 1 && symbols.sliding === 1 && symbols.spans === 3 && symbols.masks === 0, symbols);
    check('sliding door retains two offset panels', symbols.panels.length === 2 && symbols.panels[0] !== symbols.panels[1], symbols.panels);
    equal('2D wall/door old pointer edit handles are absent', await page.locator('.structure-resize-overlay').count(), 0);
    equal('2D rendered structures have no pointer editing', (await boundaryControls()).interactiveDetails, 0);
    const saved = await layout(); await page.reload({ waitUntil: 'load' });
    equal('fresh navigation restores the shared 3D-edited document from storage', await layout(), saved);
    equal('simple workspace retains 2D read-only detail boundary', await boundaryControls(), { controls: 0, selectedDetails: 0, interactiveDetails: 0 });
  });

  await scenario('structure-edit', async () => {
    await reset(1440, 1000, singleRoom); await open3d('top', true);
    const freeDoor = await add('swing', 'structure'); await apply();
    const snapped = await detail(freeDoor, 'structures');
    check('door without selected wall snaps to actual room boundary, not free space', snapped.wallId === null && (snapped.y === 0 || snapped.y === 500 || snapped.x === 0 || snapped.x === 600), snapped);
    equal('opening free-rotation command is disabled', await page.locator('[data-studio-rotate]').isDisabled(), true);
    await click('[data-studio-delete]'); await apply();
    equal('real door delete persists', (await layout()).structures.length, 0);
    const wallId = await add('wall', 'structure'); await field('length', 400); await apply();
    const doorId = await add('swing', 'structure'); await apply(); await choose('structure', wallId);
    const slideId = await add('sliding', 'structure'); await apply();
    await choose('structure', wallId);
    check('wall size and rotate alternatives meet 44px', targets44(await sizes('[data-studio-value="length"], [data-studio-rotate]')), await sizes('[data-studio-value="length"], [data-studio-rotate]'));
    await field('length', 500); await apply(); equal('3D wall length edit persists', (await detail(wallId, 'structures')).length, 500);
    await click('[data-studio-rotate]'); await apply();
    const rotated = (await layout()).structures;
    check('wall rotation also turns both owned doors', rotated.length === 3 && rotated.every(s => s.orientation === 'vertical') && [doorId, slideId].every(id => rotated.find(s => s.id === id)?.wallId === wallId), rotated);
    const before = await layout(); await click('[data-studio-nudge="10,0"]'); await apply(); const after = await layout();
    check('wall move carries both attached doors by same delta', after.structures.length === 3 && after.structures.every((s, i) => s.x === before.structures[i].x + 10 && s.y === before.structures[i].y), { before: before.structures, after: after.structures });
    await choose('structure', doorId);
    equal('door can be independently selected while wall owns opening', await page.locator('.studio3d-shell').getAttribute('data-selection-id'), doorId);
    await field('width', 150); await apply(); equal('door width alternative persists', (await detail(doorId, 'structures')).width, 150);
    const boundaryIndex = studioWallTargets(await layout()).findIndex(wall => !wall.wallId && wall.orientation === 'horizontal' && wall.y === 500);
    const option = await page.locator('[data-studio-wall-target] option').evaluateAll((nodes, index) => nodes.find(n => n.value === String(index))?.value, boundaryIndex);
    assert.notEqual(option, undefined, 'actual horizontal boundary target exists');
    await input('[data-studio-wall-target]', option); await apply();
    const relocated = await detail(doorId, 'structures');
    check('wall picker relocates door with orientation and ownership', relocated.wallId === null && relocated.orientation === 'horizontal' && relocated.y === 500, relocated);
    await click('[data-studio-undo]');
    check('relocation undo restores vertical wall ownership', (await detail(doorId, 'structures')).wallId === wallId && (await detail(doorId, 'structures')).orientation === 'vertical', await detail(doorId, 'structures'));
    await field('x', 600); await apply();
    const numericMove = await detail(doorId, 'structures');
    check('numeric relocation replaces removed Shift-arrow/free-door gesture', numericMove.wallId === null && numericMove.x === 600 && numericMove.orientation === 'vertical', numericMove);
    await close3d(); const baseline = await layout();
    await mouseAt(await world(numericMove.x, numericMove.y)); await page.locator('#plan-canvas').focus(); await key('Shift+ArrowRight');
    equal('2D Shift-arrow cannot relocate doors', (await layout()).structures, baseline.structures);
  });

  await scenario('walk-desktop', async () => {
    await reset(1440, 1000, walkFixture('door')); await open3d('walk');
    const ui = await walkUI();
    check('desktop 3D uses keyboard HUD and focused canvas', !ui.joystick && !ui.look && ui.keyboard && ui.cone && ui.focused && ui.menuInert, ui);
    await targetOpening('door', 'opening');
    const before = await detail('opening', 'structures');
    await toggleOpening('door', 'opening'); const after = await detail('opening', 'structures');
    check('real crosshair canvas click toggles persisted door', before.openAngle !== after.openAngle, { before, after });
    const origin = await pose();
    await change(movedExpression(origin), async () => { await page.keyboard.down('w'); await page.keyboard.down('d'); });
    await page.keyboard.up('w'); await page.keyboard.up('d');
    check('native WASD moves camera', distance(origin, await pose()) > .5, { origin, after: await pose() });
    const p = await point('[data-walkthrough-canvas]'), beforeLook = await pose();
    await change(rotatedExpression(beforeLook), () => drag({ x: p.x - 70, y: p.y }, { x: p.x + 70, y: p.y + 20 }));
    check('real desktop drag changes look rotation', Math.abs((await pose()).rotation - beforeLook.rotation) > .5, { beforeLook, after: await pose() });
    await capture('desktop-walk'); await close3d();
    equal('desktop walkthrough exits without stale overlay/fullscreen', await evaluate(`({ overlays: document.querySelectorAll('[data-walkthrough]').length, fullscreen: Boolean(document.fullscreenElement) })`), { overlays: 0, fullscreen: false });
  });

  await scenario('window-custom', async () => {
    await reset(1440, 1000, singleRoom); await open3d('top', true);
    const wallId = await add('wall', 'structure'); await field('length', 500); await apply();
    const swingId = await add('swing', 'structure'); await apply(); await choose('structure', wallId);
    await add('sliding', 'structure'); await apply(); await choose('structure', wallId);
    await click('[data-studio-delete]');
    equal('wall deletion preview does not persist prematurely', (await layout()).structures.length, 3);
    await apply(); equal('delete wall cascades to owned doors', (await layout()).structures.length, 0);
    await click('[data-studio-undo]'); equal('single undo restores entire structure group', (await layout()).structures.length, 3);
    await choose('structure', wallId); await field('height', 100); await apply();
    const windowId = await add('window', 'structure'); await apply();
    const low = await detail(windowId, 'structures'); equal('new window fits 100cm wall', [low.sillHeight, low.height], [50, 50]);
    await choose('structure', wallId); await field('height', 240); await apply(); await choose('structure', windowId);
    await field('width', 180); await field('sillHeight', 80); await field('height', 110); await field('openRatio', 50); await apply();
    const customized = await detail(windowId, 'structures');
    equal('window width/height/sill/open state persists with wall ownership', [customized.wallId, customized.width, customized.height, customized.sillHeight, customized.openRatio], [wallId, 180, 110, 80, 50]);
    check('window size/sill/open controls meet 44px', targets44(await sizes('[data-studio-value="width"], [data-studio-value="height"], [data-studio-value="sillHeight"], [data-studio-opening]')), await sizes('[data-studio-value="width"], [data-studio-value="height"], [data-studio-value="sillHeight"], [data-studio-opening]'));
    const customId = await add('custom'); await field('name', '반려견 휴식장'); await field('width', 120); await field('depth', 80); await field('height', 70); await apply();
    equal('custom furniture exact name and dimensions persist', [(await detail(customId)).name, (await detail(customId)).width, (await detail(customId)).depth, (await detail(customId)).height], ['반려견 휴식장', 120, 80, 70]);
    await field('elevation', 15); await field('shape', 'ellipse'); await apply();
    equal('custom elevation and shape persist through 3D properties', [(await detail(customId)).elevation, (await detail(customId)).shape], [15, 'ellipse']);
    await close3d();
    const symbols = await page.locator(`[data-structure-id="${windowId}"]`).evaluate(node => ({ frames: node.querySelectorAll('.window-frame').length, panels: node.querySelectorAll('.window-panel').length, pointer: getComputedStyle(node).pointerEvents }));
    equal('2D window keeps one frame/two panels as read-only observation', symbols, { frames: 1, panels: 2, pointer: 'none' });
    await open3d('walk');
    check('real 3D exposes custom furniture name', (await page.locator('[data-custom-furniture-names]').textContent()).includes('반려견 휴식장'), await page.locator('[data-custom-furniture-names]').textContent());
    await close3d(); await open3d('top', true);
    for (const [index, type] of requestedTypes.entries()) {
      await add(type); await field('x', 100 + index % 4 * 120); await field('y', 100 + Math.floor(index / 4) * 140); await apply();
    }
    const added = (await layout()).items.filter(i => requestedTypes.includes(i.type));
    equal('all eight requested furniture types created through 3D UI', added.map(i => i.type).sort(), [...requestedTypes].sort());
    await close3d(); await open3d('walk');
    equal('all requested models rebuild ready in real walkthrough', await evaluate(`document.querySelector('[data-walkthrough]').dataset.assetState`), 'ready');
    await capture('requested-furniture-3d'); await close3d();
    // Independent initial visibility fixture; the opening action is still a real
    // canvas click, not a seeded opening state or mocked raycast.
    await reset(1440, 1000, walkFixture('window')); await open3d('walk');
    await targetOpening('window', 'opening');
    const beforeClick = await detail('opening', 'structures'); await toggleOpening('window', 'opening');
    const afterClick = await detail('opening', 'structures');
    check('window crosshair click persists opposite opening state', beforeClick.openRatio !== afterClick.openRatio, { beforeClick, afterClick });
    await change('true', () => cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69, autoRepeat: true }), { event: 'keydown', mutations: false });
    await page.keyboard.up('e'); equal('repeated E does not toggle window again', await detail('opening', 'structures'), afterClick);
    await close3d();
    assert(swingId);
  });

  await scenario('boundary', async () => {
    const initial = { wallHeight: 240, zones: [room('room-1', 0, 0, 220, 260), room('room-2', 0, 260, 120, 130), room('hall', 120, 260, 100, 130)], items: [], structures: [
      { id: 'room-1-wall', type: 'wall', name: 'Room 1 wall', x: 170, y: 260, length: 100, height: 240, thickness: 4, orientation: 'horizontal' },
      { id: 'room-1-door', type: 'door', name: 'Room 1 door', doorType: 'swing', x: 170, y: 260, width: 80, height: 205, orientation: 'horizontal', hinge: 'end', openSide: 1, wallId: 'room-1-wall' },
      { id: 'room-2-wall', type: 'wall', name: 'Room 2 wall', x: 120, y: 325, length: 130, height: 240, thickness: 4, orientation: 'vertical' },
      { id: 'room-2-door', type: 'door', name: 'Room 2 door', doorType: 'swing', x: 120, y: 325, width: 80, height: 205, orientation: 'vertical', hinge: 'start', openSide: -1, openAngle: 90, wallId: 'room-2-wall' },
    ] };
    await reset(1440, 1000, initial);
    const blocked = await page.evaluate(doors => {
      const spans = [...document.querySelectorAll('.structural-walls line')].map(n => Object.fromEntries(['x1', 'x2', 'y1', 'y2'].map(k => [k, Number(n.getAttribute(k))])));
      return doors.filter(door => spans.some(s => door.orientation === 'horizontal' ? s.y1 === door.y && s.y2 === door.y && Math.min(s.x1, s.x2) < door.x && Math.max(s.x1, s.x2) > door.x : s.x1 === door.x && s.x2 === door.x && Math.min(s.y1, s.y2) < door.y && Math.max(s.y1, s.y2) > door.y)).map(d => d.id);
    }, initial.structures.filter(s => s.type === 'door'));
    equal('attached doors cut coincident automatic boundaries in both axes', blocked, []);
    equal('legacy missing opening fields render closed', await page.locator('[data-structure-id="room-1-door"] .door-swing').count(), 0);
    await capture('attached-boundary-2d'); await open3d('walk'); await targetOpening('door', 'room-1-door');
    equal('attached boundary door targetable in actual 3D', await page.locator('[data-walkthrough]').getAttribute('data-target-door-id'), 'room-1-door');
    await toggleOpening('door', 'room-1-door');
    await change(`document.querySelector('[data-walkthrough]')?.dataset.targetDoorId === 'room-1-door'`, async () => {});
    check('open doorway keeps target for closing hidden leaf', (await detail('room-1-door', 'structures')).openAngle === 90 && await page.locator('[data-walkthrough]').getAttribute('data-target-door-id') === 'room-1-door', await detail('room-1-door', 'structures'));
    await toggleOpening('door', 'room-1-door'); equal('same canvas target closes opened doorway', (await detail('room-1-door', 'structures')).openAngle, 0);
    await capture('attached-boundary-3d'); await close3d();
    // Space merge must now preserve explicit details, even when it removes the
    // automatic boundary. This deliberately replaces the obsolete deletion test.
    await click('[data-select-zone="room-1"]'); await page.keyboard.down('Shift'); await click('[data-select-zone="hall"]'); await page.keyboard.up('Shift');
    const before = (await layout()).structures; await click('[data-merge-spaces]');
    equal('2D space merge never deletes explicit read-only doors/walls', (await layout()).structures, before);
  });

  await scenario('precision', async () => {
    await reset(1440, 1000, singleRoom);
    const png = await evaluate(`new Promise((resolve, reject) => { const c = document.createElement('canvas'); c.width = 320; c.height = 240; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0,0,320,240); g.strokeStyle = '#222'; g.lineWidth = 8; g.strokeRect(24,24,272,192); c.toBlob(blob => blob ? blob.arrayBuffer().then(a => resolve([...new Uint8Array(a)]), reject) : reject(new Error('PNG fixture encoding failed')), 'image/png'); })`);
    await change(`Boolean(${stored}.backgroundPlan)`, () => page.locator('#background-file').setInputFiles({ name: 'fixture-floor-plan.png', mimeType: 'image/png', buffer: Buffer.from(png) }));
    const background = (await layout()).backgroundPlan;
    check('PNG import optimizes/persists/renders locked background', background.name === 'fixture-floor-plan.png' && background.dataUrl.length <= 700000 && background.dataUrl.startsWith('data:image/jpeg') && background.locked && await page.locator('[data-background-plan]').count() === 1, { ...background, dataUrl: background.dataUrl.slice(0, 30), bytes: background.dataUrl.length });
    await click('[data-disclosure="tracing"] > summary');
    await input('#calibration-distance', 200); await click('#calibrate-background');
    await mouseAt(await world(background.x + 20, background.y + 20)); await mouseAt(await world(background.x + 120, background.y + 20));
    const calibrated = (await layout()).backgroundPlan;
    check('two-point calibration doubles background dimensions', Math.abs(calibrated.width - background.width * 2) < .01 && Math.abs(calibrated.depth - background.depth * 2) < .01, { before: [background.width, background.depth], after: [calibrated.width, calibrated.depth] });
    await page.locator('#background-opacity').focus(); await key('Home');
    equal('background opacity keyboard control persists minimum', (await layout()).backgroundPlan.opacity, .05);
    await click('#toggle-background-lock'); await input('#background-x', 35); await input('#background-y', 45);
    equal('background unlock and numeric position remain 2D', [(await layout()).backgroundPlan.locked, (await layout()).backgroundPlan.x, (await layout()).backgroundPlan.y], [false, 35, 45]);
    await click('#toggle-background-lock'); check('background relock disables coordinate mutators', await page.locator('#background-x').isDisabled() && await page.locator('#background-y').isDisabled(), (await layout()).backgroundPlan.locked);
    await click('#add-dimension'); await mouseAt(await world(20, 20)); await mouseAt(await world(50, 60));
    const dimensions = (await layout()).dimensions;
    check('two real clicks persist exact 50cm dimension', dimensions.length === 1 && Math.abs(Math.hypot(dimensions[0].x2 - dimensions[0].x1, dimensions[0].y2 - dimensions[0].y1) - 50) < .01 && await page.locator('[data-dimension-id]').count() > 0, dimensions);
    check('dimension inspector exposes measured value', (await page.locator('.dimension-result').textContent()).includes('50cm'), await page.locator('.dimension-result').textContent());
    await click('[data-select-zone="room"]'); await page.locator('#plan-canvas').focus(); const origin = (await layout()).zones[0];
    await key('ArrowRight'); equal('2D keyboard nudges space exactly 1cm', (await layout()).zones[0].x, origin.x + 1);
    await key('Shift+ArrowRight'); equal('2D Shift-arrow moves space exactly 40cm', (await layout()).zones[0].x, origin.x + 41);
    await click('[data-toggle-selection-lock]'); const locked = (await layout()).zones[0];
    await page.locator('#plan-canvas').focus(); await key('ArrowRight'); equal('locked space ignores keyboard movement', (await layout()).zones[0], locked);
    await click('#duplicate-selection'); const duplicated = (await layout()).zones;
    check('space duplicate is unlocked and offset without altering protected original', duplicated.length === 2 && !duplicated[1].locked && duplicated[1].x === locked.x + 20 && JSON.stringify(duplicated[0]) === JSON.stringify(locked), duplicated);
    await key('Meta+c'); await key('Meta+v'); equal('2D copy/paste adds another space', (await layout()).zones.length, 3);
    equal('space clipboard never creates furniture', (await layout()).items.length, 0);
    await open3d('top', true); const id = await add('custom'); await apply();
    const initial = await detail(id); await field('x', initial.x + 1); await apply(); equal('3D numeric furniture precision retains 1cm option', (await detail(id)).x, initial.x + 1);
    await click('[data-studio-lock]'); await apply(); const protectedItem = await detail(id);
    check('3D lock disables movement/resize/rotate/delete/duplicate', await value('x').isDisabled() && await value('width').isDisabled() && await page.locator('[data-studio-rotate]').isDisabled() && await page.locator('[data-studio-delete]').isDisabled() && await page.locator('[data-studio-duplicate]').isDisabled(), protectedItem);
    await click('[data-studio-lock]'); await apply(); const source = await detail(id);
    await click('[data-studio-duplicate]'); equal('furniture duplicate previews without saving', (await layout()).items.length, 1); await apply();
    const clone = (await layout()).items.at(-1);
    check('3D duplicate is unlocked +20cm and preserves original', clone.id !== source.id && clone.x === source.x + 20 && clone.y === source.y + 20 && !clone.locked && JSON.stringify(await detail(id)) === JSON.stringify(source), { source, clone });
    const assetId = await page.locator('[data-studio-asset]').first().getAttribute('data-studio-asset');
    await change(pending, () => click(`[data-studio-asset="${assetId}"]`)); await apply();
    const model = (await layout()).items.at(-1);
    equal('3D real model catalog persists selected asset', model.assetId, assetId);
    await click('[data-studio-material="walnut"]'); await apply();
    equal('3D material swatch persists furniture finish', (await detail(model.id)).materialId, 'walnut');
    const finishZoneId = duplicated[1].id;
    await choose('zone', finishZoneId); await click('[data-studio-tab="floor"]');
    const floorMaterial = await page.locator('[data-studio-catalog] [data-studio-material]').first().getAttribute('data-studio-material');
    await click(`[data-studio-catalog] [data-studio-material="${floorMaterial}"]`); await apply();
    equal('3D floor finish persists on shared space', (await detail(finishZoneId, 'zones')).floorMaterialId, floorMaterial);
    await click('[data-studio-tab="wall"]');
    const wallMaterial = await page.locator('[data-studio-catalog] [data-studio-material]').last().getAttribute('data-studio-material');
    await click(`[data-studio-catalog] [data-studio-material="${wallMaterial}"]`); await apply();
    equal('3D wall finish persists on shared space', (await detail(finishZoneId, 'zones')).wallMaterialId, wallMaterial);
    await close3d();
  });

  await scenario('preview', async () => {
    await reset(1440, 1000, singleRoom); await click('[data-select-zone="room"]'); await open3d();
    const initial = await evaluate(`({ mode: document.querySelector('[data-walkthrough]').dataset.viewMode, cutaway: document.querySelector('[data-walkthrough]').dataset.dollhouseCutaway, ceiling: document.querySelector('[data-toggle-ceiling]').getAttribute('aria-pressed'), focusDisabled: document.querySelector('[data-focus-selection]').disabled })`);
    equal('dollhouse opens with cutaway and ceilings hidden', initial, { mode: 'dollhouse', cutaway: 'true', ceiling: 'true', focusDisabled: false });
    await click('[data-view-mode="top"]');
    equal('top view retains overview/cutaway', await evaluate(`({ mode: document.querySelector('[data-walkthrough]').dataset.viewMode, overview: document.querySelector('[data-walkthrough]').classList.contains('is-overview'), cutaway: document.querySelector('[data-walkthrough]').dataset.dollhouseCutaway })`), { mode: 'top', overview: true, cutaway: 'true' });
    await click('[data-walkthrough-more]'); await click('[data-focus-selection]');
    equal('focus selected space returns to dollhouse', await page.locator('[data-walkthrough]').getAttribute('data-view-mode'), 'dollhouse');
    const downloaded = page.waitForEvent('download', { timeout: TIMEOUT });
    await change(`document.querySelector('[data-walkthrough]')?.dataset.lastSnapshot === 'png'`, () => click('[data-save-snapshot]'));
    const download = await downloaded, path = join(artifactDir, '3d-snapshot.png'); await download.saveAs(path);
    const bytes = await readFile(path);
    equal('current 3D canvas downloads actual PNG bytes', [...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    check('snapshot is nonempty scene image', bytes.length > 1000, bytes.length);
    await capture('precision-preview-3d'); await close3d();
  });

  await scenario('portable-modal', async () => {
    for (const [width, height] of [[390, 844], [844, 390], [1440, 1000]]) {
      await reset(width, height, { ...singleRoom, items: [item] });
      if (width <= 900) { await click('[data-mobile-panel="spaces"]'); await click('[data-select-zone="room"]'); await click('[data-mobile-panel="canvas"]'); }
      else await click('[data-select-zone="room"]');
      const before = await layout();
      for (const [open, modal, close] of [['[data-project-open]', '.project-dialog', '[data-project-close]'], ['[data-cloud-open]', '.cloud-dialog', '[data-cloud-close]']]) {
        await click(open); await modalIsolation(modal, before, width);
        check(`${width} modal close meets 44px`, targets44(await sizes(close)), await sizes(close));
        await key('Escape');
        equal(`${width} modal Escape restores opener focus`, await page.locator(open).evaluate(n => n === document.activeElement), true);
      }
      await click('[data-project-open]');
      const exported = page.waitForEvent('download', { timeout: TIMEOUT }); await click('[data-project-export]');
      const download = await exported; const source = join(artifactDir, `portable-${width}.roomstudio.json`); await download.saveAs(source);
      const portable = JSON.parse(await readFile(source, 'utf8'));
      check(`${width} portable export contains same document without account metadata`, portable.schemaVersion === 4 && isDeepStrictEqual(portable.layout, before) && !('ownerId' in portable) && !('userId' in portable), { schemaVersion: portable.schemaVersion, keys: Object.keys(portable) });
      equal(`${width} portable export restores opener focus`, await page.locator('[data-project-open]').evaluate(n => n === document.activeElement), true);
      await click('[data-project-open]');
      const reportDownload = page.waitForEvent('download', { timeout: TIMEOUT }); await click('[data-project-report]');
      const htmlDownload = await reportDownload; const htmlPath = join(artifactDir, `decision-report-${width}.html`); await htmlDownload.saveAs(htmlPath);
      const html = await readFile(htmlPath, 'utf8');
      check(`${width} decision report is standalone escaped HTML`, /<!doctype html>/i.test(html) && !/<script\b/i.test(html) && html.includes(item.name), { bytes: html.length, script: /<script\b/i.test(html) });
      equal(`${width} report export restores opener focus`, await page.locator('[data-project-open]').evaluate(n => n === document.activeElement), true);
      await click('[data-project-open]');
      await modalIsolation('.project-dialog', before, width);
      const changed = structuredClone(portable); changed.projectName = 'Mobile portable roundtrip'; changed.layout.zones[0].width += 10;
      await change(`${stored}.zones[0].width === ${changed.layout.zones[0].width}`, () => page.locator('[data-project-import]').setInputFiles({ name: 'roundtrip.roomstudio.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(changed)) }));
      equal(`${width} real portable import restores details and changed space`, await layout(), changed.layout);
      const imported = await layout();
      await click('[data-project-open]');
      await change(`Boolean(document.querySelector('[data-project-feedback][data-tone="error"]'))`, () => page.locator('[data-project-import]').setInputFiles({ name: 'invalid.roomstudio.json', mimeType: 'application/json', buffer: Buffer.from('{not-json') }));
      equal(`${width} rejected portable import preserves document`, await layout(), imported);
      await key('Escape'); await open3d('top', true);
      await modalIsolation('[data-walkthrough]', imported, width);
      await inspectContainment(`${width} 3D panel`);
      await close3d();
      check(`${width} 3D close restores 2D focus and removes inert`, await page.locator('#open-walkthrough').evaluate(n => n === document.activeElement) && !await page.locator('.workspace').evaluate(n => n.inert), await evaluate('document.activeElement.id'));
    }
  });

  activeScenario = 'coverage';
  equal('every mapped scenario executes exactly once', report.scenarios.map(s => s.id), migrationScenarios.map(([id]) => id));
  check('required assertion count is not reduced', report.interactionAssertions.length >= minimumAssertions, report.interactionAssertions.length, `>=${minimumAssertions}`);
  equal('global browser console/uncaught errors', errors, []);
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  console.error(error.stack);
} finally {
  report.consoleErrors = errors;
  report.finishedAt = new Date().toISOString();
  report.assertionCounts = { total: report.interactionAssertions.length, passed: report.interactionAssertions.filter(r => r.pass).length, failed: report.interactionAssertions.filter(r => !r.pass).length };
  await mkdir(artifactDir, { recursive: true });
  await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  await cleanup();
}
console.log(`Mobile browser audit artifacts: ${artifactDir}`);
console.log(`Assertions: ${report.assertionCounts.passed}/${report.assertionCounts.total} passed (${report.assertionCounts.failed} failed)`);
process.exitCode = report.error || report.assertionCounts.failed ? 1 : 0;

async function panelState() {
  return evaluate(`Array.from(document.querySelectorAll('[role="tabpanel"]'), p => ({ id: p.id, hidden: p.getAttribute('aria-hidden'), inert: p.inert }))`);
}
function mobilePanels(panels) { return panels.filter(p => p.hidden === 'false' && !p.inert).length === 1 && panels.every(p => p.hidden === 'false' ? !p.inert : p.hidden === 'true' && p.inert); }
async function blankPoint() {
  const result = await evaluate(`(() => { const r = document.querySelector('#plan-canvas').getBoundingClientRect();
    for (let y = r.top + 8; y < r.bottom - 8; y += 8) for (let x = r.left + 8; x < r.right - 8; x += 8)
      if (document.elementFromPoint(x,y)?.classList.contains('grid-background')) return {x,y}; return null; })()`);
  assert(result, 'real exposed blank canvas point'); return result;
}
async function zonePoint(id) {
  const result = await page.evaluate(id => {
    const zone = document.querySelector(`[data-zone-id="${id}"]`), r = zone.getBoundingClientRect();
    for (const yRatio of [.65, .5, .8, .3]) for (const xRatio of [.5, .3, .7]) {
      const x = r.left + r.width * xRatio, y = r.top + r.height * yRatio;
      const hit = document.elementFromPoint(x, y);
      if (hit?.closest('[data-zone-id]') === zone && !hit.closest('[data-resize-handle]')) return { x, y };
    }
    return null;
  }, id);
  assert(result, `Exposed actual space body: ${id}`); return result;
}
async function sceneItemPoint(id, native = true) {
  const canvas = await page.locator('[data-walkthrough-canvas]').boundingBox();
  for (const yRatio of [.5, .45, .55, .4, .6]) for (const xRatio of [.5, .55, .45, .6, .4]) {
    const p = { x: canvas.x + canvas.width * xRatio, y: canvas.y + canvas.height * yRatio };
    if (native) await tap(p); else await mouseAt(p);
    if (await page.locator('.studio3d-shell').getAttribute('data-selection-id') === id) return p;
  }
  throw new Error(`Real scene clicks did not select furniture ${id}`);
}
async function zoneHalo(id) {
  return page.evaluate(id => {
    for (const zone of document.querySelectorAll('.plan-zone')) {
      if (id && zone.dataset.zoneId !== id) continue;
      const hit = zone.querySelector('.zone-hit-target'), rect = zone.querySelector('rect:not(.zone-hit-target)').getBoundingClientRect();
      for (const ratio of [.5, .25, .75]) {
        const across = rect.left + rect.width * ratio, down = rect.top + rect.height * ratio;
        for (const [x,y] of [[rect.left - 10, down], [rect.right + 10, down], [across, rect.top - 10], [across, rect.bottom + 10]])
          if (document.elementFromPoint(x,y) === hit) return { x, y, id: zone.dataset.zoneId };
      }
    }
    return null;
  }, id);
}
async function inspectContainment(label) {
  const data = await evaluate(`(() => { const stage = document.querySelector('[data-walkthrough-stage]').getBoundingClientRect(), panel = document.querySelector('.studio3d-shell').getBoundingClientRect(), apply = document.querySelector('[data-studio-apply]').getBoundingClientRect(), overlay = document.querySelector('[data-walkthrough]');
    return { mode: overlay.dataset.viewMode, classes: overlay.className, separate: stage.bottom <= panel.top + 1 || stage.right <= panel.left + 1, stage: {width:stage.width,height:stage.height}, applyVisible: apply.top >= 0 && apply.bottom <= innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
      scrollBody: document.querySelector('.studio3d-body').scrollHeight >= document.querySelector('.studio3d-body').clientHeight }; })()`);
  check(`${label} scene/panel do not overlap and Apply remains reachable`, data.separate && data.stage.height >= 150 && data.applyVisible && !data.overflow && data.scrollBody, data);
}
async function walkUI() {
  return evaluate(`(() => { const visible = selector => { const n = document.querySelector(selector); return Boolean(n && n.getClientRects().length && getComputedStyle(n).display !== 'none' && getComputedStyle(n).visibility !== 'hidden'); };
    return { joystick: visible('[data-walkthrough-joystick]'), look: visible('[data-look-zone]'), cone: visible('.walkthrough-view-cone'), keyboard: visible('[data-walkthrough-controls]'), focused: document.activeElement.matches('[data-walkthrough-canvas]'), menuInert: document.querySelector('[data-walkthrough-menu]').inert, menuHidden: document.querySelector('[data-walkthrough-menu]').getAttribute('aria-hidden') }; })()`);
}
async function pose() {
  const text = await page.locator('[data-map-player]').getAttribute('transform');
  const parts = text.match(/translate\(([-\d.]+)[ ,]+([-\d.]+)\).*rotate\(([-\d.]+)/);
  assert(parts, `readable minimap pose: ${text}`);
  return { x: Number(parts[1]), y: Number(parts[2]), rotation: Number(parts[3]) };
}
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function movedExpression(origin) { return `(() => { const p = document.querySelector('[data-map-player]').getAttribute('transform').match(/translate\\(([-\\d.]+)[ ,]+([-\\d.]+)/); return p && Math.hypot(Number(p[1]) - ${origin.x}, Number(p[2]) - ${origin.y}) > .5; })()`; }
function rotatedExpression(origin) { return `Math.abs(Number(document.querySelector('[data-map-player]').getAttribute('transform').match(/rotate\\(([-\\d.]+)/)?.[1]) - ${origin.rotation}) > .5`; }
// Drift is a render-loop property: observe exactly eight subsequent minimap
// updates, with a timeout only as failure bound. No elapsed-time sleep/polling.
async function stationaryFrames(event, trigger = async () => {}) {
  const key = `__mobileAuditFrames${serial++}`;
  await page.evaluate(({ key, event, timeout }) => {
    window[key] = new Promise(resolveFrames => {
      const node = document.querySelector('[data-map-player]'), positions = [];
      let started = !event;
      const start = () => { started = true; };
      const finish = result => { observer.disconnect(); clearTimeout(timer); if (event) document.removeEventListener(event, start, true); resolveFrames(result); };
      const timer = setTimeout(() => finish({ error: `Missing ${event ?? 'minimap'} render events` }), timeout);
      const observer = new MutationObserver(() => {
        if (!started) return;
        const match = node.getAttribute('transform').match(/translate\(([-\d.]+)[ ,]+([-\d.]+)/);
        positions.push([Number(match[1]), Number(match[2])]);
        if (positions.length === 8) finish({ frames: positions.length, drift: Math.max(...positions.map(p => Math.hypot(p[0] - positions[0][0], p[1] - positions[0][1]))), positions });
      });
      observer.observe(node, { attributes: true, attributeFilter: ['transform'] });
      if (event) document.addEventListener(event, start, { once: true, capture: true });
    });
  }, { key, event, timeout: TIMEOUT });
  await trigger();
  const result = await page.evaluate(async key => { const result = await window[key]; delete window[key]; return result; }, key);
  if (result.error) throw new Error(result.error);
  return result;
}
function walkFixture(type) {
  return { ...singleRoom, zones: [room('room', 0, 0, 300, 300)], structures: [{ id: 'opening', name: `Audit ${type}`, type, doorType: 'swing',
    x: 150, y: 0, width: 200, height: type === 'window' ? 150 : 205, sillHeight: type === 'window' ? 50 : 0, orientation: 'horizontal',
    wallId: null, hinge: 'start', openSide: 1, openAngle: 0, openRatio: 0, slideDirection: 'end' }] };
}
async function targetOpening(kind, id) {
  // A deterministic camera scan, not a retry/poll loop: each input changes yaw
  // and we await its exact damped endpoint from the minimap render events.
  const canvas = await point('[data-walkthrough-canvas]');
  for (let turn = 0; turn < 40; turn++) {
    if (await page.locator('[data-walkthrough]').getAttribute(`data-target-${kind}-id`) === id) return;
    await settleLook(() => drag({ x: canvas.x - 30, y: canvas.y }, { x: canvas.x + 30, y: canvas.y }));
  }
  throw new Error(`Actual 3D crosshair could not target ${kind}:${id} after a full camera turn`);
}
async function settleLook(trigger) {
  const key = `__mobileAuditLook${serial++}`;
  await page.evaluate(({ key, timeout }) => {
    window[key] = new Promise(resolveSettled => {
      const node = document.querySelector('[data-map-player]');
      const read = () => Number(node.getAttribute('transform').match(/rotate\(([-\d.]+)/)[1]);
      const origin = read(); let previous = origin, changed = false, stable = 0;
      const finish = result => { observer.disconnect(); clearTimeout(timer); resolveSettled(result); };
      const timer = setTimeout(() => finish({ error: 'Camera direction did not change and settle' }), timeout);
      const observer = new MutationObserver(() => {
        const angle = read(); changed ||= Math.abs(angle - origin) > .5;
        stable = changed && Math.abs(angle - previous) < .01 ? stable + 1 : 0; previous = angle;
        if (stable === 3) finish({ ok: true });
      }); observer.observe(node, { attributes: true, attributeFilter: ['transform'] });
    });
  }, { key, timeout: TIMEOUT });
  await trigger();
  const result = await page.evaluate(async key => { const result = await window[key]; delete window[key]; return result; }, key);
  if (result.error) throw new Error(result.error);
}
async function toggleOpening(kind, id) {
  const old = await detail(id, 'structures'), field = kind === 'window' || old.doorType === 'sliding' ? 'openRatio' : 'openAngle';
  const canvas = await point('[data-walkthrough-canvas]');
  await change(`${stored}.structures.find(s => s.id === ${JSON.stringify(id)}).${field} !== ${old[field] ?? 0} && document.querySelector('[data-walkthrough]')?.dataset.${kind === 'window' ? 'lastWindowAction' : 'lastDoorAction'}?.startsWith(${JSON.stringify(`${id}:`)})`, () => mouseAt(canvas));
}
async function modalIsolation(selector, baseline, width) {
  const modal = page.locator(selector);
  const initialView = await modal.getAttribute('data-view-mode');
  check(`${width} ${selector} owns focus and background inert`, await modal.evaluate(n => n.contains(document.activeElement)) && await page.locator('.workspace').evaluate(n => n.inert || n.closest('[inert]') !== null), await evaluate('document.activeElement.outerHTML'));
  await modal.evaluate(n => {
    const controls = [...n.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])')].filter(el => el.getClientRects().length && !el.closest('[hidden], [inert]'));
    controls.at(-1).focus();
  });
  await key('Tab'); check(`${width} ${selector} Tab traps focus`, await modal.evaluate(n => n.contains(document.activeElement)), await evaluate('document.activeElement.outerHTML'));
  await key('Shift+Tab'); check(`${width} ${selector} reverse Tab traps focus`, await modal.evaluate(n => n.contains(document.activeElement)), await evaluate('document.activeElement.outerHTML'));
  // Focus the dialog itself so key dispatch cannot accidentally click a button.
  await modal.evaluate(n => { n.tabIndex = -1; n.focus(); });
  for (const shortcut of ['ArrowRight', 'Shift+ArrowRight', 'Meta+d', 'Meta+c', 'Meta+v', 'Delete', 'Meta+z', 'Control+y']) await key(shortcut);
  if (initialView) {
    const finalView = await modal.evaluate(node => ({ mode: node.dataset.viewMode, overview: node.classList.contains('is-overview') }));
    check(`${width} 3D modal shortcuts preserve overview mode`, finalView.mode === initialView && finalView.overview, finalView);
  }
  equal(`${width} ${selector} isolates 2D editing keyboard commands`, await layout(), baseline);
}
