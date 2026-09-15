import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { geometryForOption } from '../src/consultation.js';
import {
  capture,
  evaluate,
  launchChrome,
  setViewport,
} from '../.omo/evidence/room-studio-improvements/browser-qa-lib.mjs';

const mobile = process.argv.includes('--mobile');
const outputDirectory = resolve('.omx/artifacts/consultation', `${new Date().toISOString().replaceAll(':', '-')}-${mobile ? 'mobile' : 'desktop'}`);
await mkdir(outputDirectory, { recursive: true });
const port = await new Promise((resolvePort, reject) => {
  const socket = createNetServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const address = socket.address();
    socket.close(() => resolvePort(address.port));
  });
});
const server = await createServer({
  cacheDir: join(outputDirectory, 'vite-cache'),
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/.omx/**'] } },
});
await server.listen();
const chromePath = process.env.CHROME_PATH ?? (
  process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : '/usr/bin/google-chrome'
);
const receipt = { mobile, actions: [], scenarios: [], screenshots: [], errors: [], viewports: [], outputDirectory,
  scenarioMap: [
    { scenario: 'A/B independence', before: '2D furniture click and ArrowRight', after: '3D target, X + 1 preview, Apply, return to 2D' },
    { scenario: 'modal shortcut isolation and portable export', before: '2D furniture nudge creates undo history', after: '3D numeric move and Apply create shared undo history' },
    { scenario: 'touch numeric editing', before: '2D furniture context menu and inspector', after: '3D target and width/depth inspector, Apply, close to canvas' },
    { scenario: 'placement and cancellation', before: '2D plant library and placement HUD', after: '3D model catalog preview, scene contact, Apply, Undo and Cancel' },
  ],
};
let browser;

try {
  browser = await launchChrome(chromePath);
  const cdp = browser.cdp;
  // Attach to the owned browser, not another worker/browser. Native select menus
  // are platform UI; Playwright's selectOption operates their public form surface.
  const connection = await chromium.connectOverCDP(`http://${new URL(cdp.socket.url).host}`);
  const page = connection.contexts()[0].pages()[0];
  const evaluatePage = (expression) => evaluate(cdp, expression);
  cdp.listeners.set('Runtime.exceptionThrown', new Set([
    (event) => receipt.errors.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text),
  ]));
  const frame = () => evaluatePage(`new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Animation frame did not arrive')), 15000);
    requestAnimationFrame(() => { clearTimeout(timeout); resolve(); });
  })`);
  let touchMode = false;
  const screenshot = async (name) => {
    await frame();
    const path = join(outputDirectory, `${name}.png`);
    await capture(cdp, path);
    receipt.screenshots.push(path);
  };
  const click = async (selector, predicate) => {
    if (predicate) await armState(predicate);
    const point = await evaluatePage(`(async () => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled || element.closest('[inert]')) throw new Error('Unavailable control: ' + ${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const current = document.querySelector(${JSON.stringify(selector)});
      const bounds = current.getBoundingClientRect();
      const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      if (!current.contains(document.elementFromPoint(point.x, point.y))) {
        throw new Error('Obscured control: ' + ${JSON.stringify(selector)});
      }
      return point;
    })()`);
    receipt.actions.push({
      selector,
      point,
      hit: await evaluatePage(`document.elementsFromPoint(${point.x}, ${point.y}).slice(0, 3).map(node => node.getAttribute('class') || node.tagName)`),
    });
    if (touchMode) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
      }
    }
    if (predicate) await evaluatePage('window.__consultationAuditState');
    await frame();
    receipt.actions.push({ [touchMode ? 'tap' : 'click']: selector });
  };
  const input = async (selector, value) => {
    await click(selector);
    await evaluatePage(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await cdp.send('Input.insertText', { text: value });
    receipt.actions.push({ input: selector, value });
  };
  const key = async (value, code) => {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: value, code: value, windowsVirtualKeyCode: code });
    }
    await frame();
  };
  const state = () => evaluatePage('JSON.parse(localStorage.getItem("room-studio-layout-v2"))');
  const event = (method, predicate = () => true) => new Promise((resolveEvent, reject) => {
    const listeners = cdp.listeners.get(method) ?? new Set();
    const listener = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timeout);
      listeners.delete(listener);
      resolveEvent(value);
    };
    const timeout = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error(`${method} did not arrive`));
    }, 15000);
    listeners.add(listener);
    cdp.listeners.set(method, listeners);
  });
  const download = async (selector) => {
    const started = event('Page.downloadWillBegin');
    const finished = event('Page.downloadProgress', (progress) => ['completed', 'canceled'].includes(progress.state));
    await click(selector);
    const [description, progress] = await Promise.all([started, finished]);
    assert.equal(progress.state, 'completed');
    const path = join(outputDirectory, description.suggestedFilename);
    receipt.actions.push({ download: path });
    return path;
  };
  const viewport = async (width, height) => {
    touchMode = width <= 900;
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: touchMode, maxTouchPoints: 2 });
    await setViewport(cdp, width, height);
  };
  const armState = async (predicate) => {
    await evaluatePage(`window.__consultationAuditState = new Promise((resolve, reject) => {
      const check = () => {
        try {
          if (!(${predicate})) return;
          observer.disconnect(); clearTimeout(timeout); resolve(true);
        } catch (error) { observer.disconnect(); clearTimeout(timeout); reject(error); }
      };
      const observer = new MutationObserver(check);
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(${JSON.stringify(`Expected editor state: ${predicate}`)})); }, 15000);
      check();
    }); true`);
  };

  const select = async (selector, value) => {
    await page.locator(selector).selectOption(value, { timeout: 15000 });
    receipt.actions.push({ select: selector, value });
    assert.equal(await evaluatePage(`document.querySelector(${JSON.stringify(selector)}).value`), value);
  };
  const studioReady = `document.querySelector('[data-walkthrough]')?.dataset.studioReady === 'true'
    && document.querySelector('[data-walkthrough]')?.dataset.assetState === 'ready'`;
  const openStudio = async (itemId) => {
    await click('#open-walkthrough', studioReady);
    assert.equal(await evaluatePage('document.querySelector("#app").inert'), true);
    if (await evaluatePage('document.querySelector(".studio3d-body").hidden')) {
      await click('[data-studio-toggle]', `!document.querySelector('.studio3d-body').hidden`);
    }
    if (itemId) {
      await select('[data-studio-target]', `item:${itemId}`);
      assert.equal(await evaluatePage('document.querySelector(".studio3d-shell").dataset.selectionId'), itemId);
    }
  };
  const closeStudio = async () => {
    await click('[data-walkthrough-exit]', `!document.querySelector('[data-walkthrough]')`);
    assert.equal(await evaluatePage('document.querySelector("#app").inert'), false);
    assert.equal(await evaluatePage('document.activeElement.matches("#open-walkthrough")'), true);
  };
  const moveFurniture = async (item) => {
    const before = await state();
    await openStudio(item.id);
    await input('[data-studio-value="x"]', String(item.x + 1));
    await armState(`document.querySelector('.studio3d-shell').dataset.pending === 'true'`);
    await key('Tab', 9);
    await evaluatePage('window.__consultationAuditState');
    assert.deepEqual(await state(), before, '3D preview must not persist before Apply');
    await click('[data-studio-apply]', `document.querySelector('.studio3d-shell').dataset.pending === 'false'
      && JSON.parse(localStorage.getItem('room-studio-layout-v2')).items.find(item => item.id === ${JSON.stringify(item.id)}).x === ${item.x + 1}`);
    const after = await state();
    assert.deepEqual(after.items, before.items.map(entry => entry.id === item.id ? { ...entry, x: entry.x + 1 } : entry));
    assert.deepEqual(after.consultation, before.consultation);
    await screenshot(`3d-move-${receipt.actions.length}`);
    await closeStudio();
  };
  const assertPlanParity = async (scope, items) => {
    const actual = await evaluatePage(`[...document.querySelectorAll(${JSON.stringify(`${scope} .plan-item`)})].map(node => {
      const shape = node.querySelector('rect, ellipse');
      return { id: node.dataset.itemId, transform: node.querySelector('g').getAttribute('transform'),
        width: Number(shape.getAttribute(shape.tagName === 'ellipse' ? 'rx' : 'width')) * (shape.tagName === 'ellipse' ? 2 : 1),
        depth: Number(shape.getAttribute(shape.tagName === 'ellipse' ? 'ry' : 'height')) * (shape.tagName === 'ellipse' ? 2 : 1) };
    })`);
    assert.deepEqual(actual, items.map(item => ({ id: item.id,
      transform: `translate(${item.x} ${item.y}) rotate(${item.rotation ?? 0})`, width: item.width, depth: item.depth })), `${scope}: actual furniture geometry`);
  };

  const appUrl = server.resolvedUrls.local[0];
  const enterAdvancedWorkspace = async () => {
    await click('[data-workspace-mode]');
    assert.equal(await evaluatePage('document.querySelector(".workspace").dataset.mode'), 'advanced');
  };
  const navigateEditor = async () => {
    const loaded = event('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: appUrl });
    await loaded;
    if (!await evaluatePage('Boolean(document.querySelector("[data-start-backdrop]"))')) {
      await enterAdvancedWorkspace();
    }
  };
  const projectName = '테스트 고객의 마포 아파트 거실 배치 상담';
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: outputDirectory });
  await viewport(mobile ? 390 : 1440, mobile ? 844 : 1000);
  await navigateEditor();
  await click('[data-start-sample]');
  await enterAdvancedWorkspace();
  assert.equal(await evaluatePage('Boolean(document.querySelector("#plan-canvas"))'), true, 'the editor must finish booting');
  await screenshot('desktop-before-consultation');
  assert.equal(
    await evaluatePage('Boolean(document.querySelector("[data-consultation-open]"))'),
    true,
    'a local-only consultant must be able to name the customer and project',
  );
  await click('[data-consultation-open]');
  assert.equal(
    await evaluatePage('Boolean(document.querySelector("[data-consultation-form]"))'),
    true,
    'consultation details must be editable without cloud login',
  );
  await input('[name="projectName"]', projectName);
  await input('[name="businessName"]', '테스트 공간상담');
  await input('[name="clientName"]', '테스트 고객');
  await input('[name="requirements"]', '기존 소파를 유지하고 아이가 다닐 공간을 확보합니다.');
  await input('[name="optionLabel"]', '기존 가구 활용');
  await input('[name="recommendation"]', '기존 소파를 유지합니다.\n창가 쪽에 여유 공간을 둡니다.');
  await input('[name="nextSteps"]', '창과 문 주변의 실제 치수를 다시 확인합니다.');
  await screenshot('desktop-consultation');
  await click('[data-consultation-form] [type="submit"]');
  const optionA = await state();
  assert.equal(optionA.draftMetadata.projectName, projectName);
  assert.equal(optionA.consultation.clientName, '테스트 고객');
  assert.equal(optionA.consultation.inactiveGeometry, null);
  await navigateEditor();
  assert.equal(await evaluatePage('document.querySelector("h1").textContent'), projectName);
  assert.equal(await evaluatePage('Boolean(document.querySelector("[data-start-backdrop]"))'), false);
  receipt.scenarios.push('named consultation and notes survive reload without cloud login');

  await click('[data-option-create]');
  await click('[data-option-select="B"]');
  await moveFurniture(optionA.items[0]);
  const movedB = await state();
  assert.equal(movedB.items[0].x, optionA.items[0].x + 1);
  await click('[data-consultation-open]');
  await input('[name="optionLabel"]', '수납 우선 배치');
  await input('[name="recommendation"]', '가구 위치를 조정한 비교안입니다.');
  await input('[name="nextSteps"]', '수납장 앞 사용 공간을 현장에서 확인합니다.');
  await select('[name="recommendedOption"]', 'B');
  await click('[data-consultation-form] [type="submit"]');
  await click('[data-option-select="A"]');
  assert.equal((await state()).items[0].x, optionA.items[0].x);
  await click('[data-option-select="B"]');
  assert.equal((await state()).items[0].x, movedB.items[0].x);
  assert.equal(await evaluatePage('document.querySelector("#undo-action").disabled'), true);
  const twoOptions = await state();
  assert.equal(twoOptions.consultation.options.A.label, '기존 가구 활용');
  assert.equal(twoOptions.consultation.options.B.label, '수납 우선 배치');
  assert.equal(twoOptions.consultation.recommendedOption, 'B');
  await navigateEditor();
  assert.equal((await state()).consultation.activeOption, 'B');
  assert.equal((await state()).items[0].x, movedB.items[0].x);
  receipt.scenarios.push('A/B geometry, active option, notes and recommendation remain independent');

  const selectionBeforeComparison = await evaluatePage('document.querySelectorAll("#plan-canvas .is-selected").length');
  const beforeComparisonDrag = await state();
  await click('[data-options-compare]');
  assert.equal(await evaluatePage('document.querySelectorAll("[data-comparison-option]").length'), 2);
  assert.equal(await evaluatePage('new Set([...document.querySelectorAll(".comparison-plan svg")].map(node => node.id)).size'), 2);
  for (const option of ['A', 'B']) await assertPlanParity(`[data-comparison-option="${option}"]`, geometryForOption(twoOptions, option).items);
  const comparisonItem = await evaluatePage(`(() => {
    const bounds = document.querySelector('[data-comparison-option="A"] .plan-item').getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...comparisonItem, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: comparisonItem.x + 28, y: comparisonItem.y + 16, button: 'left', buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: comparisonItem.x + 28, y: comparisonItem.y + 16, button: 'left', buttons: 0, clickCount: 1 });
  await frame();
  assert.deepEqual(await state(), beforeComparisonDrag, 'dragging a read-only comparison must not edit either layout');
  assert.equal(
    await evaluatePage('document.querySelectorAll("#plan-canvas .is-selected").length'),
    selectionBeforeComparison,
    'read-only comparison objects must not change editor selection',
  );
  await screenshot('desktop-comparison');
  await key('Escape', 27);
  assert.equal(await evaluatePage('document.activeElement.matches("[data-options-compare]")'), true);
  await click('[data-consultation-open]');
  await input('[name="projectName"]', '취소할 수정');
  await key('Escape', 27);
  assert.equal((await state()).draftMetadata.projectName, projectName);
  assert.equal(await evaluatePage('document.activeElement.matches("[data-consultation-open]")'), true);
  receipt.scenarios.push('comparison and metadata dialogs cancel and restore focus');

  await moveFurniture(movedB.items[0]);
  assert.equal(await evaluatePage('document.querySelector("#undo-action").disabled'), false, '3D Apply creates real shared undo history');
  const beforeFileDialogShortcut = await state();
  await click('[data-project-open]');
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  }
  await frame();
  assert.deepEqual(await state(), beforeFileDialogShortcut, 'a modal must not apply editor shortcuts to the hidden drawing');
  const portablePath = await download('[data-project-export]');
  const portable = JSON.parse(await readFile(portablePath, 'utf8'));
  assert.equal(portable.schemaVersion, 3);
  assert.equal(portable.projectName, projectName);
  assert.equal(portable.layout.consultation.activeOption, 'B');
  assert.deepEqual(portable.layout.items, beforeFileDialogShortcut.items);
  assert.deepEqual(portable.layout.consultation, beforeFileDialogShortcut.consultation);
  assert.equal(JSON.stringify(portable).includes('draftMetadata'), false);
  assert.equal(Object.hasOwn(portable.layout, 'ownerId'), false);
  await click('[data-start-open]');
  await click('[data-start-blank]');
  assert.equal((await state()).zones.length, 0);
  await click('[data-recovery-restore]');
  assert.equal((await state()).draftMetadata.projectName, projectName);
  assert.equal((await state()).consultation.options.B.label, '수납 우선 배치');
  receipt.scenarios.push('blank replacement protects and restores the complete consultation');

  await click('[data-start-open]');
  await click('[data-start-blank]');
  await click('[data-project-open]');
  const dom = await cdp.send('DOM.getDocument');
  const fileInput = await cdp.send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '[data-project-import]' });
  await armState(`document.querySelector('h1')?.textContent === ${JSON.stringify(projectName)}`);
  await cdp.send('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [portablePath] });
  await evaluatePage('window.__consultationAuditState');
  const imported = await state();
  assert.equal(imported.draftMetadata.projectName, projectName);
  assert.equal(imported.draftMetadata.projectId, null);
  assert.deepEqual(imported.consultation, twoOptions.consultation);
  assert.deepEqual(imported.items, beforeFileDialogShortcut.items);
  receipt.scenarios.push('portable import preserves both options and becomes a separate local draft');

  const reportPath = await download('[data-consultation-report]');
  const reportHtml = await readFile(reportPath, 'utf8');
  assert.equal(/<script\b|<link\b/i.test(reportHtml), false);
  const reportLoaded = event('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: pathToFileURL(reportPath).href });
  await reportLoaded;
  assert.equal(await evaluatePage('document.querySelectorAll("article[data-option]").length'), 2);
  assert.equal(await evaluatePage('document.querySelector("[data-field=businessName]").textContent.includes("테스트 공간상담")'), true);
  assert.equal(await evaluatePage('document.querySelectorAll("script, link, iframe, object, embed, [onclick]").length'), 0);
  assert.equal(await evaluatePage('document.querySelectorAll(".is-selected, [data-transform-hud], .resize-handle").length'), 0);
  for (const option of ['A', 'B']) {
    const items = geometryForOption(imported, option).items;
    await assertPlanParity(`article[data-option="${option}"]`, items);
    const rows = await evaluatePage(`[...document.querySelectorAll('article[data-option="${option}"] tbody tr')].map(row => {
      const cells = [...row.cells];
      return { name: cells[0].textContent, size: cells[1].textContent.match(/-?\\d+/g).map(Number), position: cells[2].textContent.match(/-?\\d+/g).map(Number) };
    })`);
    assert.deepEqual(rows, items.map(item => ({ name: item.name,
      size: [item.width, item.depth, item.height].map(Math.round),
      position: [item.x, item.y, item.rotation ?? 0, item.elevation ?? 0].map(Math.round) })));
  }
  await screenshot('report-top');
  await evaluatePage('window.scrollTo(0, document.body.scrollHeight)');
  await screenshot('report-bottom');
  const pdf = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
  receipt.reportPdf = join(outputDirectory, 'client-report.pdf');
  await writeFile(receipt.reportPdf, Buffer.from(pdf.data, 'base64'));
  const mediaBoxes = [...Buffer.from(pdf.data, 'base64').toString('latin1').matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/g)];
  assert.ok(mediaBoxes.length > 0, 'Printed PDF must expose its page dimensions');
  assert.ok(mediaBoxes.every(([, width, height]) => Math.abs(Number(width) - 595.28) < 2 && Math.abs(Number(height) - 841.89) < 2), 'Every printed page must use A4');
  receipt.reportPages = mediaBoxes.length;
  receipt.scenarios.push('self-contained client report contains both options and prints to A4');

  await navigateEditor();
  await viewport(390, 844);
  const editedItemId = imported.items[0].id;
  await openStudio(editedItemId);
  await screenshot('mobile-after-touch');
  assert.equal(await evaluatePage('document.querySelectorAll(".studio3d-shell:not([hidden])").length'), 1);
  assert.equal(await evaluatePage('Boolean(document.querySelector(".mobile-context-menu"))'), false);
  assert.equal(await evaluatePage('Boolean(document.querySelector("[data-transform-hud]"))'), false);
  await screenshot('mobile-selection');
  const beforeNumericEdit = await state();
  await input('[data-studio-value="width"]', '185');
  await click('[data-studio-value="depth"]', `document.querySelector('.studio3d-shell').dataset.pending === 'true'`);
  assert.equal(
    await evaluatePage('document.activeElement.matches("[data-studio-value=depth]")'),
    true,
    'clicking the next numeric field must preserve its focus after committing the previous field',
  );
  await input('[data-studio-value="depth"]', '215');
  await key('Tab', 9);
  assert.equal(
    await evaluatePage('document.activeElement.matches("[data-studio-value=height]")'),
    true,
    'Tab must preserve focus on the next numeric field',
  );
  assert.deepEqual(await state(), beforeNumericEdit, 'Both numeric changes remain a 3D preview until Apply');
  await click('[data-studio-apply]', `document.querySelector('.studio3d-shell').dataset.pending === 'false' && ${studioReady}`);
  await closeStudio();
  await click('[data-mobile-panel="canvas"]');
  assert.equal(
    await evaluatePage('document.querySelector("#mobile-tab-canvas").getAttribute("aria-selected")'),
    'true',
    'the first tap after editing a numeric field must activate the canvas tab',
  );
  const afterNumericEdit = await state();
  assert.equal(afterNumericEdit.items.find(item => item.id === editedItemId).width, 185);
  assert.equal(afterNumericEdit.items.find(item => item.id === editedItemId).depth, 215);
  assert.deepEqual(afterNumericEdit.items.filter(item => item.id !== editedItemId),
    beforeNumericEdit.items.filter(item => item.id !== editedItemId), 'numeric edits change only the selected furniture');
  await click('[data-option-select="A"]');
  assert.deepEqual((await state()).items, optionA.items, 'the other option remains unchanged');
  await click('[data-option-select="B"]');
  receipt.scenarios.push('genuine touch opens one editing surface and changes only the current option');

  for (const [width, height] of [[320, 568], [375, 812], [390, 844], [768, 1024], [844, 390], [1280, 800], [1440, 1000], [1920, 1080]]) {
    await viewport(width, height);
    const geometry = await evaluatePage(`(() => {
      const canvas = document.querySelector('#plan-canvas').getBoundingClientRect();
      const controls = [...document.querySelectorAll('.consultation-toolbar button:not(:disabled)')].map(node => {
        const rect = node.getBoundingClientRect();
        return { label: node.textContent.trim(), width: rect.width, height: rect.height };
      });
      const headerFits = [...document.querySelectorAll('.topbar button')].every(node => {
        const rect = node.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth;
      });
      return { scrollWidth: document.documentElement.scrollWidth, canvasHeight: canvas.height, controls, headerFits };
    })()`);
    receipt.lastGeometry = { width, height, ...geometry };
    assert.ok(geometry.scrollWidth <= width, `${width}×${height} must not overflow horizontally`);
    assert.ok(geometry.headerFits, `${width}×${height} header controls remain inside the display`);
    assert.ok(geometry.canvasHeight >= 150, `${width}×${height} needs a usable canvas`);
    if (width > 900) assert.ok(geometry.canvasHeight >= 480, `${width}×${height} desktop canvas must remain the main working area`);
    assert.ok(geometry.controls.every(control => control.width >= 43.5 && control.height >= 43.5), `${width}×${height} controls need 44px targets`);
    await screenshot(`editor-${width}x${height}`);
    await click('[data-consultation-open]');
    const dialog = await evaluatePage(`(() => {
      const bounds = document.querySelector('.consultation-dialog').getBoundingClientRect();
      const submit = document.querySelector('[data-consultation-form] [type="submit"]').getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, submitBottom: submit.bottom };
    })()`);
    assert.ok(dialog.left >= 0 && dialog.right <= width && dialog.top >= 0 && dialog.bottom <= height, `${width}×${height} dialog fits the display`);
    assert.ok(dialog.submitBottom <= height, `${width}×${height} submit remains reachable`);
    await screenshot(`form-${width}x${height}`);
    await key('Escape', 27);
    await click('[data-options-compare]');
    assert.ok(await evaluatePage('document.documentElement.scrollWidth <= innerWidth'), 'comparison must reflow');
    await screenshot(`comparison-${width}x${height}`);
    await key('Escape', 27);
    receipt.viewports.push({ width, height, ...geometry, dialog });
  }
  receipt.scenarios.push('editor, consultation form and comparison work across eight display sizes');

  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    await viewport(width, height);
    const itemCount = (await state()).items.length;
    await openStudio();
    await click('[data-studio-asset="seoul-side-table"]', `document.querySelector('.studio3d-shell').dataset.pending === 'true' && ${studioReady}`);
    const placementId = await evaluatePage('document.querySelector(".studio3d-shell").dataset.selectionId');
    assert.equal((await state()).items.length, itemCount, 'Catalog selection only previews furniture');
    // Scene contact remains usable while the separate placement status is visible.
    const point = await evaluatePage(`(() => {
      const stage = document.querySelector('[data-walkthrough-stage]').getBoundingClientRect();
      const status = document.querySelector('.studio3d-selection').getBoundingClientRect();
      if (!(status.top >= stage.bottom || status.left >= stage.right)) throw new Error('Placement status overlaps scene');
      const point = { x: stage.left + 4, y: stage.top + 4 };
      if (!document.elementFromPoint(point.x, point.y)?.matches('canvas')) throw new Error('Scene contact is obscured');
      return point;
    })()`);
    if (touchMode) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
      }
    }
    await frame();
    assert.equal(await evaluatePage('document.querySelector(".studio3d-shell").dataset.selectionId'), placementId);
    assert.equal((await state()).items.length, itemCount, 'Scene contact must not accidentally commit placement');
    await screenshot(`placement-${width}x${height}`);
    await click('[data-studio-apply]', `JSON.parse(localStorage.getItem('room-studio-layout-v2')).items.length === ${itemCount + 1}
      && document.querySelector('.studio3d-shell').dataset.pending === 'false'`);
    assert.equal((await state()).items.find(item => item.id === placementId).assetId, 'seoul-side-table');
    await click('[data-studio-undo]', `JSON.parse(localStorage.getItem('room-studio-layout-v2')).items.length === ${itemCount}`);
    assert.equal((await state()).items.length, itemCount);
    await click('[data-studio-asset="seoul-side-table"]', `document.querySelector('.studio3d-shell').dataset.pending === 'true' && ${studioReady}`);
    await click('[data-studio-cancel]', `document.querySelector('.studio3d-shell').dataset.pending === 'false'`);
    assert.equal((await state()).items.length, itemCount, 'the cancel control remains interactive');
    await closeStudio();
  }
  receipt.scenarios.push('3D placement preview, scene contact, Apply, Undo and Cancel work with mouse and touch');

  await viewport(390, 500);
  await click('[data-consultation-open]');
  assert.ok(await evaluatePage('document.querySelector("[type=submit]").getBoundingClientRect().bottom <= innerHeight'), 'reduced viewport height keeps Apply visible');
  await screenshot('mobile-reduced-height');
  await key('Escape', 27);
  await viewport(1440, 1000);
  const savedBeforeQuota = await state();
  await evaluatePage(`window.__draftOriginalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'room-studio-layout-v2') throw new DOMException('full', 'QuotaExceededError');
      return window.__draftOriginalSetItem.call(this, key, value);
    }`);
  await click('[data-consultation-open]');
  await input('[name="projectName"]', '저장 실패 복구 테스트');
  await click('[data-consultation-form] [type="submit"]');
  assert.equal((await state()).draftMetadata.projectName, savedBeforeQuota.draftMetadata.projectName);
  assert.equal(await evaluatePage('document.querySelector("[data-draft-status]").hidden'), false);
  await screenshot('storage-quota-error');
  await evaluatePage('Storage.prototype.setItem = window.__draftOriginalSetItem');
  await click('[data-draft-retry]');
  assert.equal((await state()).draftMetadata.projectName, '저장 실패 복구 테스트');
  await navigateEditor();
  assert.equal(await evaluatePage('document.querySelector("h1").textContent'), '저장 실패 복구 테스트');
  receipt.scenarios.push('storage quota failure preserves old data and explicit retry saves current work');

  const savedBeforeUnavailable = await state();
  await evaluatePage(`window.__draftStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('disabled', 'SecurityError'); } }); true`);
  await click('[data-consultation-open]');
  await input('[name="projectName"]', 'UNAVAILABLE-STORAGE-DRAFT');
  await click('[data-consultation-form] [type="submit"]', `document.querySelector('[data-draft-status]').dataset.tone === 'error'`);
  const unavailablePath = await download('[data-draft-export]');
  const unavailablePortable = JSON.parse(await readFile(unavailablePath, 'utf8'));
  assert.equal(unavailablePortable.projectName, 'UNAVAILABLE-STORAGE-DRAFT');
  assert.deepEqual(unavailablePortable.layout.items, savedBeforeUnavailable.items);
  assert.deepEqual(unavailablePortable.layout.consultation, savedBeforeUnavailable.consultation);
  assert.equal(JSON.stringify(unavailablePortable).includes('draftMetadata'), false);
  await screenshot('storage-unavailable-export');
  await evaluatePage(`Object.defineProperty(window, 'localStorage', window.__draftStorageDescriptor); true`);
  assert.deepEqual(await state(), savedBeforeUnavailable, 'Unavailable storage must not overwrite the last saved consultation');
  await click('[data-draft-retry]', `document.querySelector('[data-draft-status]').dataset.tone !== 'error'`);
  await navigateEditor();
  assert.equal((await state()).draftMetadata.projectName, 'UNAVAILABLE-STORAGE-DRAFT');
  receipt.scenarios.push('unavailable storage retains the saved consultation and exports current work before retry');

  assert.deepEqual(receipt.errors, [], 'the consultation path must not raise browser exceptions');
  receipt.status = 'PASS';
  console.log(`CONSULTATION_PASS ${mobile ? 'mobile' : 'desktop'} ${receipt.scenarios.length} scenarios, ${receipt.viewports.length} viewports`);
} catch (error) {
  receipt.status = 'FAIL';
  receipt.failure = error.stack;
  process.exitCode = 1;
  console.error(`CONSULTATION_FAIL ${error.message}`);
  if (browser) {
    const path = join(outputDirectory, 'failure.png');
    try {
      await capture(browser.cdp, path);
      receipt.screenshots.push(path);
    } catch (captureError) {
      receipt.captureError = captureError.message;
    }
  }
} finally {
  const cleanupErrors = [];
  try { await browser?.close(); } catch (error) { cleanupErrors.push(error.stack); }
  try { await server.close(); } catch (error) { cleanupErrors.push(error.stack); }
  receipt.cleanup = cleanupErrors.length ? cleanupErrors : 'Owned Chrome, profile, and Vite server closed';
  if (cleanupErrors.length) {
    receipt.status = 'FAIL'; process.exitCode = 1;
    console.error(`CONSULTATION_FAIL cleanup: ${cleanupErrors.join('\n')}`);
  }
  await writeFile(join(outputDirectory, 'results.json'), JSON.stringify(receipt, null, 2));
  console.log(`CONSULTATION_EVIDENCE ${outputDirectory}`);
}
process.exit(process.exitCode ?? 0);
