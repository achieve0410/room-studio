import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { normalizeConsultation } from '../src/consultation.js';
import {
  capture, evaluate, launchChrome, setViewport,
} from '../.omo/evidence/room-studio-improvements/browser-qa-lib.mjs';

const mobile = process.argv.includes('--mobile');
const root = resolve('.');
const mainPath = resolve('src/main.js');
const virtualId = '\0consultation-cloud-fixture';
const outputDirectory = resolve(
  '.omx/artifacts/consultation-cloud',
  `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
);
const receipt = {
  mobile, outputDirectory, actions: [], scenarios: [], screenshots: [], errors: [],
  scenarioMap: [
    { scenarios: [5, 6], before: 'manual save of seeded remote furniture', after: 'real 3D numeric move and Apply trigger the real autosave; only its Supabase response is held' },
    { scenarios: [6], before: 'account switch with an open 3D preview', after: 'account switch with a selected furniture edit pending in the real 3D inspector' },
    { scenarios: [1, 2, 3, 4, 7, 8, 9, 10], after: 'existing restoration, protection, privacy and late-response cases retained; no legacy editor or frozen persistence timer' },
  ],
};
const ACTIVE = 'room-studio-layout-v2';
const RECOVERY = 'room-studio-recovery-v1';
const owner = 'fixture-owner-a';
const secondOwner = 'fixture-owner-b';
const projectId = 'fixture-original';
const localName = 'LOCAL-DIRTY-CONSULTATION';
const remoteName = 'REMOTE-REVISION-FOUR';
const localLayout = {
  zones: [{
    id: 'audit-room', spaceId: 'audit-room', name: 'Audit room', type: '거실',
    x: 0, y: 0, width: 600, depth: 400, height: 240, color: '#d9d2c2',
    locked: false, walkthroughStart: false,
  }],
  items: [{
    id: 'audit-sofa', name: 'Audit sofa', type: 'sofa', shape: 'rect',
    x: 123, y: 180, width: 180, depth: 80, height: 80,
    rotation: 0, elevation: 0, color: '#7f9884', locked: false,
  }],
  structures: [], dimensions: [], backgroundPlan: null, wallHeight: 240,
  consultation: normalizeConsultation({
    clientName: 'LOCAL-CLIENT', requirements: 'LOCAL-PRIVATE-NOTES',
  }),
};
const remoteLayout = structuredClone(localLayout);
remoteLayout.items[0].x = 350;
remoteLayout.consultation.clientName = 'REMOTE-CLIENT';
remoteLayout.consultation.requirements = 'REMOTE-NOTES';
const cached = {
  ...localLayout,
  draftMetadata: {
    version: 1, projectName: localName, ownerId: owner,
    projectId, baseRevision: 3, dirty: true,
  },
};

// Serialized into the browser: only the Supabase service boundary is replaced.
function installFixture(configuration) {
  const copy = (value) => structuredClone(value);
  const calls = [];
  const subscribers = new Set();
  const controls = new Map();
  const failures = new Map();
  let nextProject = 1;
  let user = { id: configuration.owner, user_metadata: { full_name: 'Fixture A' } };
  const records = new Map([[configuration.projectId, {
    id: configuration.projectId, owner_id: user.id,
    name: configuration.remoteName, revision: 4, schema_version: 3,
    updated_at: '2026-01-01T00:00:00.000Z',
    layout_json: configuration.remoteLayout,
  }]]);
  const emit = () => window.dispatchEvent(new Event('cloud-fixture-change'));
  const log = (kind, details = {}) => {
    calls.push({ kind, ownerId: user?.id ?? null, ...copy(details) });
    emit();
  };
  const session = () => user ? { user: copy(user) } : null;
  // A task boundary, not a delay: all promise continuations from release drain.
  const checkpoint = () => new Promise((resolveCheckpoint) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolveCheckpoint();
    };
    channel.port2.postMessage(null);
  });
  async function respond(kind, operation) {
    const control = controls.get(kind);
    if (control) {
      controls.delete(kind);
      control.entered = true;
      emit();
      await control.promise;
    }
    const error = failures.get(kind);
    failures.delete(kind);
    return error ? { data: null, error } : operation();
  }
  const client = {
    auth: {
      async getSession() {
        log('getSession');
        return { data: { session: session() }, error: null };
      },
      async getUser() {
        log('getUser');
        return { data: { user: copy(user) }, error: null };
      },
      onAuthStateChange(callback) {
        subscribers.add(callback);
        log('authSubscribed');
        return { data: { subscription: {
          unsubscribe() { subscribers.delete(callback); },
        } } };
      },
    },
    from(table) {
      if (table !== 'projects') throw new Error(`Unexpected table: ${table}`);
      return {
        select(columns) {
          return {
            async order(column, options) {
              const requestOwner = user?.id;
              log('list', { columns, column, options });
              return respond('list', () => ({
                data: [...records.values()]
                  .filter((record) => record.owner_id === requestOwner)
                  .map(({ id, name, revision, updated_at }) => ({
                    id, name, revision, updated_at,
                  })),
                error: null,
              }));
            },
            eq(column, id) {
              if (column !== 'id') throw new Error(`Unexpected filter: ${column}`);
              return {
                async single() {
                  const requestOwner = user?.id;
                  log('load', { id, columns });
                  return respond('load', () => {
                    const record = records.get(id);
                    return record?.owner_id === requestOwner
                      ? { data: copy(record), error: null }
                      : { data: null, error: { code: 'PGRST116', message: 'Not found' } };
                  });
                },
              };
            },
          };
        },
      };
    },
    async rpc(name, args) {
      if (name !== 'save_project') throw new Error(`Unexpected RPC: ${name}`);
      const requestOwner = user?.id;
      log('rpc', { name, args });
      return respond('rpc', () => {
        const existing = records.get(args.p_project_id);
        if (!requestOwner || (args.p_project_id && existing?.owner_id !== requestOwner)) {
          return { data: null, error: { code: '42501', message: 'Owner mismatch' } };
        }
        if (existing && existing.revision !== args.p_expected_revision) {
          return { data: null, error: { code: '40001', message: 'PROJECT_CONFLICT' } };
        }
        const record = {
          id: args.p_project_id ?? `fixture-copy-${nextProject++}`,
          owner_id: requestOwner, name: args.p_name,
          revision: existing ? existing.revision + 1 : 1,
          schema_version: args.p_schema_version,
          layout_json: copy(args.p_layout_json),
          updated_at: '2026-01-02T00:00:00.000Z',
        };
        records.set(record.id, record);
        return { data: [copy(record)], error: null };
      });
    },
  };
  const held = new Map();
  window.__cloudFixture = {
    client, calls, checkpoint,
    hold(kind) {
      if (held.has(kind)) throw new Error(`Already held: ${kind}`);
      let resolveResponse;
      const control = {
        entered: false,
        promise: new Promise((resolvePromise) => { resolveResponse = resolvePromise; }),
        release: () => resolveResponse(),
      };
      held.set(kind, control);
      controls.set(kind, control);
    },
    entered(kind) { return held.get(kind)?.entered === true; },
    async release(kind) {
      const control = held.get(kind);
      if (!control?.entered) throw new Error(`No pending response: ${kind}`);
      held.delete(kind);
      control.release();
      await checkpoint();
    },
    failNext(kind) {
      failures.set(kind, { code: 'FIXTURE_NETWORK', message: 'Fixture network unavailable' });
    },
    async switchUser(id) {
      user = { id, user_metadata: { full_name: 'Fixture B' } };
      log('authChanged');
      for (const callback of subscribers) callback('SIGNED_IN', session());
      await checkpoint();
    },
  };
  if (window.__holdLoginList) window.__cloudFixture.hold('list');
}

const fixtureSource = `
import { createCloudStore } from '/src/cloud-store.js';
export { normalizeProjectName, resolveAuthRedirectUrl } from '/src/cloud-store.js';
(${installFixture.toString()})(${JSON.stringify({
  owner, projectId, remoteName, remoteLayout,
})});
export const hasCloudConfiguration = () => true;
export const createConfiguredCloudStore = async () =>
  createCloudStore({ client: window.__cloudFixture.client });
`;
const port = await new Promise((resolvePort, reject) => {
  const socket = createNetServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const address = socket.address();
    socket.close(() => resolvePort(address.port));
  });
});
let server;
let browser;
let bootScript;
let scenario = 'setup';
await mkdir(outputDirectory, { recursive: true });

try {
  server = await createServer({
    root,
    cacheDir: join(outputDirectory, 'vite-cache'),
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/.omx/**'] } },
    plugins: [{
      name: 'consultation-cloud-audit',
      enforce: 'pre',
      resolveId(source, importer) {
        if (source === './cloud-store.js' && importer?.split('?')[0] === mainPath) {
          return virtualId;
        }
      },
      load(id) { if (id === virtualId) return fixtureSource; },
      transform(source, id) {
        if (id.split('?')[0] !== mainPath) return;
        // Read-only scheduling observation. The actual editor, timer, 3D edit,
        // local store and cloud adapter all execute without replacements.
        return { code: `${source}\nwindow.__cloudAuditAutosaveScheduled = () => cloudSaveTimer !== null;`, map: null };
      },
    }],
  });
  await server.listen();
  browser = await launchChrome(
    process.env.CHROME_PATH
      ?? (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : process.platform === 'win32'
          ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
          : '/usr/bin/google-chrome'),
  );
  const { cdp } = browser;
  const connection = await chromium.connectOverCDP(`http://${new URL(cdp.socket.url).host}`);
  const editor = connection.contexts()[0].pages()[0];
  const page = (expression) => evaluate(cdp, expression);
  const fixture = (expression) => page(`window.__cloudFixture.${expression}`);
  const stored = (key = ACTIVE) => page(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))`);
  const visible = (selector) => `Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`;
  cdp.listeners.set('Runtime.exceptionThrown', new Set([(event) => {
    receipt.errors.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text);
  }]));
  await cdp.send('Network.enable');
  // Block all off-origin requests, including accidentally configured real auth.
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  const address = server.httpServer.address();
  const appUrl = `http://127.0.0.1:${address.port}/`;
  const intercepted = new Set();
  cdp.listeners.set('Fetch.requestPaused', new Set([(event) => {
    const allowed = event.request.url.startsWith(appUrl)
      || /^(data:|blob:)/.test(event.request.url);
    if (!allowed) receipt.errors.push(`Blocked external request: ${event.request.url}`);
    const task = cdp.send(
      allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
      allowed ? { requestId: event.requestId }
        : { requestId: event.requestId, errorReason: 'BlockedByClient' },
    );
    intercepted.add(task);
    task.then(() => intercepted.delete(task), (error) => {
      receipt.errors.push(error.message);
      intercepted.delete(task);
    });
  }]));
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 2 });
  await setViewport(cdp, mobile ? 390 : 1440, mobile ? 844 : 1000);

  async function arm(predicate) {
    await page(`(() => {
      window.__cloudAuditWait = new Promise((resolveWait, reject) => {
        let timeout;
        const cleanup = () => {
          observer.disconnect();
          window.removeEventListener('cloud-fixture-change', check);
          clearTimeout(timeout);
        };
        const check = () => {
          try {
            if (!(${predicate})) return;
            cleanup(); resolveWait(true);
          } catch (error) { cleanup(); reject(error); }
        };
        const observer = new MutationObserver(check);
        observer.observe(document, {
          subtree: true, childList: true, attributes: true, characterData: true,
        });
        window.addEventListener('cloud-fixture-change', check);
        timeout = setTimeout(() => {
          cleanup(); reject(new Error('Expected cloud state did not arrive'));
        }, 15000);
        check();
      });
      return true;
    })()`);
  }
  const wait = () => page('window.__cloudAuditWait');
  async function click(selector, predicate) {
    if (predicate) await arm(predicate);
    const point = await page(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled || element.closest('[inert]')) {
        throw new Error('Unavailable control: ' + ${JSON.stringify(selector)});
      }
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = element.getBoundingClientRect();
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      if (!element.contains(document.elementFromPoint(point.x, point.y))) {
        throw new Error('Obscured control: ' + ${JSON.stringify(selector)});
      }
      return point;
    })()`);
    receipt.actions.push({ scenario, click: selector, point });
    if (mobile) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', {
          type, ...point, button: 'left', clickCount: 1,
        });
      }
    }
    if (predicate) await wait();
  }
  async function shot(name) {
    const path = join(outputDirectory, `${name}.png`);
    await capture(cdp, path);
    receipt.screenshots.push(path);
  }
  async function reset({ anonymous = false, holdLoginList = false, clean = false } = {}) {
    if (bootScript) {
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: bootScript });
    }
    const baseDraft = clean ? {
      ...remoteLayout,
      draftMetadata: { ...cached.draftMetadata, projectName: remoteName, baseRevision: 4, dirty: false },
    } : cached;
    const initialDraft = anonymous ? {
      ...baseDraft,
      draftMetadata: { ...baseDraft.draftMetadata, ownerId: null, projectId: null, baseRevision: null },
    } : baseDraft;
    const installed = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__holdLoginList = ${holdLoginList};
        localStorage.clear();
        localStorage.setItem(${JSON.stringify(ACTIVE)}, ${JSON.stringify(JSON.stringify(initialDraft))});
        localStorage.setItem('room-studio-active-project-v1:${owner}', ${JSON.stringify(projectId)});`,
    });
    bootScript = installed.identifier;
    const loaded = new Promise((resolveLoad, reject) => {
      const listeners = cdp.listeners.get('Page.loadEventFired') ?? new Set();
      const listener = () => {
        clearTimeout(timeout); listeners.delete(listener); resolveLoad();
      };
      const timeout = setTimeout(() => {
        listeners.delete(listener); reject(new Error('Navigation timed out'));
      }, 15000);
      listeners.add(listener);
      cdp.listeners.set('Page.loadEventFired', listeners);
    });
    await cdp.send('Page.navigate', { url: appUrl });
    await loaded;
    await arm(holdLoginList
      ? 'window.__cloudFixture?.entered("list")'
      : `window.__cloudFixture?.calls.some(call => call.kind === 'authSubscribed')`);
    await wait();
    await fixture('checkpoint()');
    await click('[data-workspace-mode]', `document.querySelector('.workspace')?.dataset.mode === 'advanced'`);
  }
  const studioReady = `document.querySelector('[data-walkthrough]')?.dataset.studioReady === 'true'
    && document.querySelector('[data-walkthrough]')?.dataset.assetState === 'ready'`;
  async function openStudio() {
    await click('#open-walkthrough', studioReady);
    assert.equal(await page('document.querySelector("#app").inert'), true);
    if (await page('document.querySelector(".studio3d-body").hidden')) {
      await click('[data-studio-toggle]', `!document.querySelector('.studio3d-body').hidden`);
    }
    await editor.locator('[data-studio-target]').selectOption('item:audit-sofa', { timeout: 15000 });
    receipt.actions.push({ scenario, select: '[data-studio-target]', value: 'item:audit-sofa' });
    assert.equal(await page('document.querySelector(".studio3d-shell").dataset.selectionId'), 'audit-sofa');
  }
  async function previewMove() {
    const before = await stored();
    await openStudio();
    await click('[data-studio-value="x"]');
    await page('document.querySelector("[data-studio-value=x]").select()');
    await cdp.send('Input.insertText', { text: String(before.items[0].x + 1) });
    await arm(`document.querySelector('.studio3d-shell').dataset.pending === 'true' && ${studioReady}`);
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    }
    await wait();
    assert.deepEqual(await stored(), before, 'A pending 3D preview cannot mutate local persistence');
    return before;
  }
  async function closeStudio() {
    await click('[data-walkthrough-exit]', `!${visible('[data-walkthrough]')}`);
    assert.equal(await page('document.querySelector("#app").inert'), false);
  }
  async function openCloud() {
    await click('[data-cloud-open]', visible('[data-cloud-project-name]'));
  }
  function sameContent(actual, expected = cached) {
    assert.deepEqual(actual.zones, expected.zones, `${scenario}: zones`);
    assert.deepEqual(actual.items, expected.items, `${scenario}: items`);
    for (const field of ['structures', 'dimensions', 'backgroundPlan', 'wallHeight']) {
      assert.deepEqual(actual[field], expected[field], `${scenario}: ${field}`);
    }
    assert.deepEqual(actual.consultation, expected.consultation, `${scenario}: consultation`);
  }
  async function originalIntact() {
    const draft = await stored();
    sameContent(draft);
    assert.equal(draft.draftMetadata.projectId, projectId);
    assert.equal(draft.draftMetadata.baseRevision, 3);
    assert.equal(draft.draftMetadata.projectName, localName);
  }
  async function recoveryAccessible() {
    const recovery = await stored(RECOVERY);
    assert.ok(recovery, 'Recovery document must exist');
    sameContent(recovery);
    assert.equal(recovery.draftMetadata.projectName, localName);
    assert.equal(recovery.draftMetadata.projectId, projectId);
    assert.equal(recovery.draftMetadata.baseRevision, 3);
    assert.equal(await page(visible('[data-recovery-restore]')), true);
  }
  const rpcCalls = () => fixture('calls.filter(call => call.kind === "rpc")');
  const idleError = `${visible('[data-cloud-feedback][data-tone="error"]')}
    && !document.querySelector('[data-cloud-copy]')?.disabled`;
  async function pass(name) {
    await shot(name);
    receipt.scenarios.push({ scenario, status: 'PASS', calls: await fixture('calls') });
  }

  scenario = '1 dirty owner draft restoration';
  await reset();
  assert.equal((await stored()).items[0].x, localLayout.items[0].x,
    'Scenario 1: auth restoration overwrote dirty local geometry');
  await originalIntact();
  assert.equal(await page('document.querySelector("h1").textContent'), localName);
  await openCloud();
  assert.equal(await page(visible('[data-cloud-recovery]')), true);
  assert.equal(await page(visible('[data-cloud-copy]')), true);
  assert.equal(await page('window.__cloudAuditAutosaveScheduled()'), false, 'Conflict must not even schedule an automatic upload');
  assert.deepEqual(await rpcCalls(), [], 'Conflict must not automatically save stale data');
  await pass('01-restored-conflict');

  scenario = '2 conflict copy failure and retry';
  await fixture('failNext("rpc")');
  await click('[data-cloud-copy]', idleError);
  await originalIntact();
  await recoveryAccessible();
  assert.equal((await rpcCalls()).length, 1);
  assert.equal((await rpcCalls())[0].args.p_project_id, null);
  await click('[data-cloud-copy]', `!${visible('[data-cloud-backdrop]')}`);
  const copied = await stored();
  sameContent(copied);
  assert.equal(copied.draftMetadata.projectId, 'fixture-copy-1');
  assert.equal(copied.draftMetadata.baseRevision, 1);
  await recoveryAccessible();
  const copies = await rpcCalls();
  assert.equal(copies.length, 2);
  for (const call of copies) {
    assert.equal(call.args.p_project_id, null, 'Never flush stale original before copying');
    assert.equal(call.args.p_expected_revision, null);
    sameContent(call.args.p_layout_json);
  }
  await pass('02-copy');

  scenario = '3 protected reload failure and retry';
  await reset();
  await openCloud();
  await fixture('failNext("load")');
  await fixture('hold("load")');
  await click('[data-cloud-reload]', 'window.__cloudFixture.entered("load")');
  await originalIntact();
  await recoveryAccessible();
  await arm(idleError);
  await fixture('release("load")');
  await wait();
  await originalIntact();
  await click('[data-cloud-reload]', `!${visible('[data-cloud-backdrop]')}`);
  const loaded = await stored();
  sameContent(loaded, remoteLayout);
  assert.equal(loaded.draftMetadata.baseRevision, 4);
  assert.equal(loaded.draftMetadata.projectName, remoteName);
  await recoveryAccessible();
  assert.deepEqual(await rpcCalls(), []);
  await pass('03-reload');

  scenario = '4 protection quota prevents destructive operations';
  await reset();
  await openCloud();
  await page(`window.__nativeStorageSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === ${JSON.stringify(RECOVERY)}) {
        throw new DOMException('Fixture quota', 'QuotaExceededError');
      }
      return window.__nativeStorageSetItem.call(this, key, value);
    };`);
  const beforeQuotaCalls = await fixture('calls.length');
  const beforeQuotaFeedback = await page('document.querySelector("[data-cloud-feedback]").textContent');
  for (const selector of ['[data-cloud-reload]', '[data-cloud-copy]']) {
    await click(selector);
    await fixture('checkpoint()');
    await originalIntact();
    assert.equal(await fixture('calls.length'), beforeQuotaCalls);
    assert.equal(await page(visible('[data-cloud-feedback][data-tone="error"]')), true);
    assert.ok(await page('document.querySelector("[data-cloud-feedback]").textContent.trim().length'));
    assert.notEqual(
      await page('document.querySelector("[data-cloud-feedback]").textContent'),
      beforeQuotaFeedback,
      'Recovery storage failure must update the visible dialog feedback',
    );
    assert.equal(await page(visible('[data-cloud-recovery-export]')), true);
  }
  await page('Storage.prototype.setItem = window.__nativeStorageSetItem');
  await pass('04-quota');

  async function beginNormalPendingSave() {
    await reset();
    await openCloud();
    await click('[data-cloud-reload]', `!${visible('[data-cloud-backdrop]')}`);
    await fixture('hold("rpc")');
    const beforeEdit = await previewMove();
    // Subscribe before Apply; await the actual debounce's RPC instead of
    // freezing, flushing or sleeping through application persistence timers.
    await click('[data-studio-apply]', 'window.__cloudFixture.entered("rpc")');
    const edited = await stored();
    assert.deepEqual(edited.items, beforeEdit.items.map(item => ({ ...item, x: item.x + 1 })));
    assert.deepEqual(edited.consultation, beforeEdit.consultation);
    await shot(`3d-committed-${scenario.slice(0, 1)}`);
    await closeStudio();
    await openCloud();
    const calls = await rpcCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.p_project_id, projectId);
    assert.equal(calls[0].args.p_expected_revision, 4);
    sameContent(calls[0].args.p_layout_json, edited);
    for (const field of ['draftMetadata', 'ownerId', 'projectId', 'baseRevision']) {
      assert.equal(Object.hasOwn(calls[0].args.p_layout_json, field), false, 'Cloud layout must exclude local/account metadata');
    }
  }

  scenario = '5 stale save cannot replace new local draft';
  await beginNormalPendingSave();
  await click('[data-cloud-close]', `!${visible('[data-cloud-backdrop]')}`);
  await click('[data-start-open]', visible('[data-start-blank]'));
  await click('[data-start-blank]', `!${visible('[data-start-backdrop]')}`);
  const newDraft = await stored();
  assert.equal(newDraft.draftMetadata.projectId, null);
  assert.equal(newDraft.draftMetadata.baseRevision, null);
  assert.equal(newDraft.items.length, 0);
  assert.equal(newDraft.zones.length, 0);
  const newHeading = await page('document.querySelector("h1").textContent');
  assert.notEqual(newHeading, remoteName);
  await fixture('release("rpc")');
  assert.deepEqual(await stored(), newDraft, 'Old completion must not mutate new draft');
  assert.equal(await page('document.querySelector("h1").textContent'), newHeading);
  await pass('05-stale-save');

  scenario = '6 owner switch isolates pending work and recovery';
  await beginNormalPendingSave();
  await click('[data-cloud-close]', `!${visible('[data-cloud-backdrop]')}`);
  assert.ok(await stored(RECOVERY), 'Owner A recovery must exist before switching');
  await previewMove();
  await fixture(`switchUser(${JSON.stringify(secondOwner)})`);
  // Check before releasing the old response: account isolation cannot wait on it.
  assert.equal(await page(visible('[data-walkthrough]')), false,
    'Previous owner 3D document must close immediately when the account changes');
  assert.equal(await page('document.querySelector("#app").inert'), false,
    'Closing the previous owner 3D view must restore the current editor');
  assert.notEqual(await page('document.querySelector("h1").textContent'), remoteName,
    'Scenario 6: previous owner document remains rendered while old save is pending');
  assert.equal(await page(visible('[data-recovery-restore]')), false,
    'Previous owner recovery must immediately become inaccessible');
  await fixture('release("rpc")');
  await arm(`document.querySelector('[data-cloud-open]')?.textContent.includes('Fixture B')`);
  await wait();
  const nextDraft = await stored();
  assert.equal(nextDraft.draftMetadata.ownerId, secondOwner);
  assert.equal(nextDraft.draftMetadata.projectId, null);
  assert.equal(nextDraft.items.length, 0);
  assert.equal(nextDraft.zones.length, 0);
  assert.equal(await stored(RECOVERY), null);
  await openCloud();
  await click('[data-cloud-save]', `!document.querySelector('[data-cloud-save]')?.disabled
    && document.querySelector('[data-cloud-feedback]')?.dataset.tone === 'success'`);
  await fixture('checkpoint()');
  const nextOwnerSaves = (await rpcCalls()).filter((call) => call.ownerId === secondOwner);
  assert.equal(nextOwnerSaves.length, 1);
  assert.equal(nextOwnerSaves[0].args.p_project_id, null);
  assert.equal(nextOwnerSaves[0].args.p_layout_json.items.length, 0);
  assert.equal(nextOwnerSaves[0].args.p_layout_json.zones.length, 0);
  assert.equal(nextOwnerSaves[0].args.p_layout_json.consultation?.requirements ?? '', '');
  await pass('06-owner-isolation');

  scenario = '7 late copy list response preserves the next owner dialog';
  await reset();
  await openCloud();
  await fixture('hold("list")');
  await click('[data-cloud-copy]', 'window.__cloudFixture.entered("list")');
  await arm(`document.querySelector('[data-cloud-open]')?.textContent.includes('Fixture B')`);
  await fixture(`switchUser(${JSON.stringify(secondOwner)})`);
  await wait();
  if (!(await page(visible('[data-cloud-backdrop]')))) await openCloud();
  await page(`const field = document.querySelector('[data-cloud-project-name]');
    field.value = 'OWNER-B-CURRENT';
    field.dispatchEvent(new Event('change', { bubbles: true }));`);
  const nextOwnerDraft = await stored();
  await fixture('release("list")');
  assert.deepEqual(await stored(), nextOwnerDraft);
  await click('[data-cloud-save]', `window.__cloudFixture.calls.some(call => call.kind === 'rpc' && call.ownerId === ${JSON.stringify(secondOwner)})`);
  await fixture('checkpoint()');
  assert.equal(await page(visible('[data-cloud-backdrop]')), true, 'An old list response must not close the next owner dialog on its next update');
  assert.equal((await stored()).draftMetadata.projectName, 'OWNER-B-CURRENT');
  await pass('07-late-list');

  scenario = '8 selecting the first saved project preserves an unlinked local draft';
  await reset({ anonymous: true });
  assert.equal((await stored()).draftMetadata.projectId, null);
  await openCloud();
  assert.equal(await page('document.querySelector("[data-cloud-project]").value'), '', 'An unlinked draft needs an explicit saved-project choice');
  await arm(`!${visible('[data-cloud-backdrop]')}`);
  await page(`const projects = document.querySelector('[data-cloud-project]');
    projects.value = ${JSON.stringify(projectId)};
    projects.dispatchEvent(new Event('change', { bubbles: true }));`);
  await wait();
  assert.equal((await stored()).draftMetadata.projectId, projectId);
  assert.equal((await stored()).items[0].x, remoteLayout.items[0].x);
  assert.equal((await stored(RECOVERY)).items[0].x, localLayout.items[0].x);
  assert.deepEqual(await rpcCalls(), [], 'Opening an existing project must not upload an unlinked local draft');
  await pass('08-local-to-remote');

  scenario = '9 clean unlinked sample is protected before opening a remote project';
  await reset();
  await click('[data-start-open]', visible('[data-start-sample]'));
  await click('[data-start-sample]', `!${visible('[data-start-backdrop]')}`);
  const cleanSample = await stored();
  assert.equal(cleanSample.draftMetadata.projectId, null);
  assert.equal(cleanSample.draftMetadata.dirty, false);
  await openCloud();
  await arm(`!${visible('[data-cloud-backdrop]')}`);
  await page(`const list = document.querySelector('[data-cloud-project]');
    list.value = ${JSON.stringify(projectId)};
    list.dispatchEvent(new Event('change', { bubbles: true }));`);
  await wait();
  const protectedSample = await stored(RECOVERY);
  assert.equal(protectedSample.draftMetadata.projectName, cleanSample.draftMetadata.projectName, 'A clean unlinked sample must replace the recovery slot before remote loading');
  sameContent(protectedSample, cleanSample);
  assert.deepEqual(await rpcCalls(), [], 'Preserving a clean unlinked document must not upload it');
  await pass('09-clean-unlinked');

  for (const kind of ['replacement', 'anonymous-edit', 'owned-edit']) {
    scenario = `10 login list completion preserves ${kind}`;
    await reset({ anonymous: kind !== 'owned-edit', clean: kind === 'owned-edit', holdLoginList: true });
    if (kind === 'replacement') {
      await click('[data-start-open]', visible('[data-start-blank]'));
      await click('[data-start-blank]', `!${visible('[data-start-backdrop]')}`);
    }
    await click('[data-consultation-open]', visible('[data-consultation-form]'));
    await page(`document.querySelector('[name="projectName"]').value = ${JSON.stringify(`NEW-${kind}`)};
      document.querySelector('[name="clientName"]').value = 'NEW-CUSTOMER';
      document.querySelector('[name="requirements"]').value = 'NEW-REQUIREMENTS';`);
    // Release at the submitted-state transition and capture at auth completion.
    // A later intentional autosave must not race the test driver's CDP round trips.
    await page(`window.__loginCompletion = new Promise((resolveLogin, reject) => {
      let changedDuringLogin;
      const readDraft = () => JSON.parse(localStorage.getItem(${JSON.stringify(ACTIVE)}));
      const cleanup = () => {
        observer.disconnect();
        window.removeEventListener('cloud-fixture-change', completed);
        clearTimeout(timeout);
      };
      const fail = error => { cleanup(); reject(error); };
      const completed = () => {
        if (!window.__cloudFixture.calls.some(call => call.kind === 'authSubscribed')) return;
        const result = { before: changedDuringLogin, after: readDraft(),
          heading: document.querySelector('h1').textContent,
          rpc: structuredClone(window.__cloudFixture.calls.filter(call => call.kind === 'rpc')) };
        cleanup(); resolveLogin(result);
      };
      const observer = new MutationObserver(() => {
        if (document.querySelector('[data-consultation-form]')) return;
        observer.disconnect();
        changedDuringLogin = readDraft();
        window.addEventListener('cloud-fixture-change', completed);
        window.__cloudFixture.release('list').catch(fail);
      });
      const timeout = setTimeout(() => fail(new Error('Submitted consultation did not complete login')), 15000);
      observer.observe(document, { childList: true, subtree: true });
    }); true`);
    await click('[data-consultation-form] [type="submit"]', `!${visible('[data-consultation-backdrop]')}`);
    const completion = await page('window.__loginCompletion');
    assert.deepEqual(completion.after, completion.before, 'A late login list must preserve newer documents and edits');
    assert.equal(completion.heading, `NEW-${kind}`);
    assert.deepEqual(completion.rpc, [], 'Login restoration must not silently upload the preserved edit');
    await pass(`10-login-${kind}`);
  }

  await Promise.all([...intercepted]);
  assert.deepEqual(receipt.errors, []);
  receipt.status = 'PASS';
  console.log(`CLOUD_PASS ${mobile ? 'mobile' : 'desktop'} ${receipt.scenarios.length} scenarios`);
} catch (error) {
  receipt.status = 'FAIL';
  receipt.failedScenario = scenario;
  receipt.failure = error.stack;
  process.exitCode = 1;
  console.error(`CLOUD_FAIL ${scenario}: ${error.message}`);
  if (browser) {
    try {
      receipt.finalCalls = await evaluate(browser.cdp, 'window.__cloudFixture?.calls');
      const path = join(outputDirectory, 'failure.png');
      await capture(browser.cdp, path);
      receipt.screenshots.push(path);
    } catch (evidenceError) {
      receipt.evidenceError = evidenceError.stack;
    }
  }
} finally {
  const cleanupErrors = [];
  try { await browser?.close(); } catch (error) { cleanupErrors.push(error.stack); }
  try { await server?.close(); } catch (error) { cleanupErrors.push(error.stack); }
  receipt.cleanup = cleanupErrors.length ? cleanupErrors : 'Owned Chrome/profile/server closed';
  if (cleanupErrors.length) {
    receipt.status = 'FAIL';
    process.exitCode = 1;
    console.error(`CLOUD_FAIL cleanup: ${cleanupErrors.join('\n')}`);
  }
  await writeFile(join(outputDirectory, 'results.json'), JSON.stringify(receipt, null, 2));
  console.log(`CLOUD_EVIDENCE ${outputDirectory}`);
}
process.exit(process.exitCode ?? 0);
