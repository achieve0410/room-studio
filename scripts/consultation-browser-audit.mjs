import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import {
  capture,
  evaluate,
  launchChrome,
  setViewport,
} from '../.omo/evidence/room-studio-improvements/browser-qa-lib.mjs';

const outputDirectory = resolve('.omx/artifacts/consultation', new Date().toISOString().replaceAll(':', '-'));
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
const receipt = { actions: [], scenarios: [], screenshots: [], errors: [], viewports: [], outputDirectory };
let browser;

try {
  browser = await launchChrome(chromePath);
  const cdp = browser.cdp;
  const evaluatePage = (expression) => evaluate(cdp, expression);
  cdp.listeners.set('Runtime.exceptionThrown', new Set([
    (event) => receipt.errors.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text),
  ]));
  const frame = () => evaluatePage('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  let touchMode = false;
  const screenshot = async (name) => {
    await frame();
    const path = join(outputDirectory, `${name}.png`);
    await capture(cdp, path);
    receipt.screenshots.push(path);
  };
  const click = async (selector) => {
    const point = await evaluatePage(`(async () => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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
        if (!(${predicate})) return;
        observer.disconnect(); clearTimeout(timeout); resolve(true);
      };
      const observer = new MutationObserver(check);
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Expected editor state did not arrive')); }, 15000);
      check();
    }); true`);
  };

  const appUrl = server.resolvedUrls.local[0];
  const projectName = '테스트 고객의 마포 아파트 거실 배치 상담';
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: outputDirectory });
  await viewport(1440, 1000);
  await browser.navigate(appUrl);
  await click('[data-start-sample]');
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
  await browser.navigate(appUrl);
  assert.equal(await evaluatePage('document.querySelector("h1").textContent'), projectName);
  assert.equal(await evaluatePage('Boolean(document.querySelector("[data-start-backdrop]"))'), false);
  receipt.scenarios.push('named consultation and notes survive reload without cloud login');

  await click('[data-option-create]');
  await click('[data-option-select="B"]');
  await click('.plan-item');
  await evaluatePage('document.querySelector("#plan-canvas").focus()');
  await key('ArrowRight', 39);
  const movedB = await state();
  assert.equal(movedB.items[0].x, optionA.items[0].x + 1);
  await click('[data-consultation-open]');
  await input('[name="optionLabel"]', '수납 우선 배치');
  await input('[name="recommendation"]', '가구 위치를 조정한 비교안입니다.');
  await input('[name="nextSteps"]', '수납장 앞 사용 공간을 현장에서 확인합니다.');
  await evaluatePage('document.querySelector("[name=recommendedOption]").value = "B"');
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
  await browser.navigate(appUrl);
  assert.equal((await state()).consultation.activeOption, 'B');
  assert.equal((await state()).items[0].x, movedB.items[0].x);
  receipt.scenarios.push('A/B geometry, active option, notes and recommendation remain independent');

  const selectionBeforeComparison = await evaluatePage('document.querySelectorAll("#plan-canvas .is-selected").length');
  const beforeComparisonDrag = await state();
  await click('[data-options-compare]');
  assert.equal(await evaluatePage('document.querySelectorAll("[data-comparison-option]").length'), 2);
  assert.equal(await evaluatePage('new Set([...document.querySelectorAll(".comparison-plan svg")].map(node => node.id)).size'), 2);
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

  await click('.plan-item');
  await evaluatePage('document.querySelector("#plan-canvas").focus()');
  await key('ArrowRight', 39);
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
  receipt.scenarios.push('portable import preserves both options and becomes a separate local draft');

  const reportPath = await download('[data-consultation-report]');
  const reportHtml = await readFile(reportPath, 'utf8');
  assert.equal(/<script\b|<link\b/i.test(reportHtml), false);
  await browser.navigate(pathToFileURL(reportPath).href);
  assert.equal(await evaluatePage('document.querySelectorAll("article[data-option]").length'), 2);
  assert.equal(await evaluatePage('document.querySelector("[data-field=businessName]").textContent.includes("테스트 공간상담")'), true);
  await screenshot('report-top');
  await evaluatePage('window.scrollTo(0, document.body.scrollHeight)');
  await screenshot('report-bottom');
  const pdf = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
  receipt.reportPdf = join(outputDirectory, 'client-report.pdf');
  await writeFile(receipt.reportPdf, Buffer.from(pdf.data, 'base64'));
  receipt.scenarios.push('self-contained client report contains both options and prints to A4');

  await browser.navigate(appUrl);
  await viewport(390, 844);
  await click('.plan-item');
  await screenshot('mobile-after-touch');
  assert.equal(await evaluatePage('Boolean(document.querySelector(".mobile-context-menu"))'), true);
  assert.equal(await evaluatePage('Boolean(document.querySelector("[data-transform-hud]"))'), false);
  await screenshot('mobile-selection');
  await click('[data-context-action="details"]');
  await input('[data-item-field="width"]', '185');
  await click('[data-item-field="depth"]');
  assert.equal(
    await evaluatePage('document.activeElement.matches("[data-item-field=depth]")'),
    true,
    'clicking the next numeric field must preserve its focus after committing the previous field',
  );
  await input('[data-item-field="depth"]', '215');
  await key('Tab', 9);
  assert.equal(
    await evaluatePage('document.activeElement.matches("[data-item-field=height]")'),
    true,
    'Tab must preserve focus on the next numeric field',
  );
  await click('[data-mobile-panel="canvas"]');
  assert.equal(
    await evaluatePage('document.querySelector("#mobile-tab-canvas").getAttribute("aria-selected")'),
    'true',
    'the first tap after editing a numeric field must activate the canvas tab',
  );
  assert.equal((await state()).items[0].width, 185);
  assert.equal((await state()).items[0].depth, 215);
  await click('[data-option-select="A"]');
  assert.equal((await state()).items[0].width, optionA.items[0].width);
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
    if (touchMode) await click('[data-mobile-panel="furniture"]');
    await click('[data-add-type="plant"]');
    const point = await evaluatePage(`(() => {
      const bounds = document.querySelector('.placement-hud').getBoundingClientRect();
      return { x: bounds.left + 16, y: bounds.top + bounds.height / 2 };
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
    assert.equal((await state()).items.length, itemCount + 1, 'the placement status must not intercept a canvas action');
    await click('#undo-action');
    assert.equal((await state()).items.length, itemCount);
    if (touchMode) await click('[data-mobile-panel="furniture"]');
    await click('[data-add-type="plant"]');
    await click('[data-placement-cancel]');
    assert.equal((await state()).items.length, itemCount, 'the cancel control remains interactive');
  }
  receipt.scenarios.push('placement works beneath its status on mouse and touch, while Cancel stays interactive');

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
  await browser.navigate(appUrl);
  assert.equal(await evaluatePage('document.querySelector("h1").textContent'), '저장 실패 복구 테스트');
  receipt.scenarios.push('storage quota failure preserves old data and explicit retry saves current work');

  assert.deepEqual(receipt.errors, [], 'the consultation path must not raise browser exceptions');
  receipt.status = 'PASS';
  console.log(`CONSULTATION_PASS ${receipt.scenarios.length} scenarios, ${receipt.viewports.length} viewports`);
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
  await browser?.close();
  await server.close();
  receipt.cleanup = 'Owned Chrome, profile, and Vite server closed';
  await writeFile(join(outputDirectory, 'results.json'), JSON.stringify(receipt, null, 2));
  console.log(`CONSULTATION_EVIDENCE ${outputDirectory}`);
}
process.exit(process.exitCode ?? 0);
