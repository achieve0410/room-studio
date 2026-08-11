import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, evaluate, launchChrome, measureLandscape, setViewport } from './browser-qa-lib.mjs';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const urlIndex = process.argv.indexOf('--url');
const targetUrl = urlIndex >= 0 ? process.argv[urlIndex + 1] : 'http://127.0.0.1:4173';
const landscapeOnly = process.argv.includes('--landscape-only');
const evidenceDir = dirname(fileURLToPath(import.meta.url));
const resultsPath = join(evidenceDir, 'browser-results.json');

await mkdir(evidenceDir, { recursive: true });

const browser = await launchChrome(chrome);
const { cdp } = browser;
const captureEvidence = (name) => capture(cdp, join(evidenceDir, name));
try {
  await browser.navigate(targetUrl);

  if (landscapeOnly) {
    await setViewport(cdp, 844, 390);
    const landscapeResult = await measureLandscape(cdp);
    const screenshots = { landscape: await captureEvidence('green-landscape.png') };
    const assertions = [
      { name: 'landscape canvas remains fully visible above navigation', pass: landscapeResult.canvasVisible },
      { name: 'landscape primary controls remain above navigation', pass: landscapeResult.controlsVisible },
      { name: 'landscape has no horizontal document overflow', pass: landscapeResult.noDocumentOverflow },
    ];
    const result = {
      targetUrl,
      assertions,
      passed: assertions.every(({ pass }) => pass),
      landscapeResult,
      screenshots,
    };
    await writeFile(join(evidenceDir, 'landscape-results.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } else {
  const assertions = [];
  const screenshots = {};
  await setViewport(cdp, 1440, 1000);
  assertions.push(...await evaluate(cdp, `(() => {
    const left = document.querySelector('.left-panel');
    const right = document.querySelector('.right-panel');
    const scope = document.querySelector('[data-planning-scope]');
    const stats = document.querySelector('.stats-bar');
    return [
      { name: 'desktop project data control exists', pass: Boolean(document.querySelector('[data-project-open]')) },
      { name: 'desktop planning scope is visible', pass: Boolean(scope && scope.getClientRects().length) },
      { name: 'desktop statistics remain visible', pass: Boolean(stats && stats.getBoundingClientRect().bottom <= innerHeight) },
      { name: 'desktop left panel scrolls independently', pass: getComputedStyle(left).overflowY === 'auto' },
      { name: 'desktop right panel scrolls independently', pass: getComputedStyle(right).overflowY === 'auto' },
    ];
  })()`));
  screenshots.desktop = await captureEvidence('green-desktop.png');

  const projectResult = await evaluate(cdp, `(async () => {
    const originalClick = HTMLAnchorElement.prototype.click;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    let download = null;
    let downloadBlob = null;
    HTMLAnchorElement.prototype.click = function captureDownload() {
      download = { href: this.href, filename: this.download };
    };
    URL.createObjectURL = (blob) => {
      downloadBlob = blob;
      return originalCreate(blob);
    };
    URL.revokeObjectURL = () => {};
    document.querySelector('[data-project-open]').click();
    const dialog = document.querySelector('.project-dialog');
    const initialFocusInside = dialog.contains(document.activeElement);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    const trappedFocus = dialog.contains(document.activeElement);
    document.querySelector('[data-project-export]').click();
    const text = await downloadBlob.text();
    const envelope = JSON.parse(text);
    URL.revokeObjectURL = originalRevoke;
    URL.createObjectURL = originalCreate;
    HTMLAnchorElement.prototype.click = originalClick;

    envelope.projectName = '브라우저 QA 도면';
    envelope.layout.zones[0].name = 'QA 거실';
    document.querySelector('[data-project-open]').click();
    const input = document.querySelector('[data-project-import]');
    const transfer = new DataTransfer();
    transfer.items.add(new File([JSON.stringify(envelope)], 'browser-qa.roomstudio.json', { type: 'application/json' }));
    const imported = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('import state did not render')), 5000);
      const done = () => {
        const stored = JSON.parse(localStorage.getItem('room-studio-layout-v2'));
        if (stored?.zones?.[0]?.name !== 'QA 거실') return false;
        clearTimeout(timeout);
        observer.disconnect();
        resolve(true);
        return true;
      };
      const observer = new MutationObserver(done);
      observer.observe(document.body, { childList: true, subtree: true });
      done();
    });
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await imported;
    return {
      filename: download.filename,
      envelope: {
        format: envelope.format,
        formatVersion: envelope.formatVersion,
        schemaVersion: envelope.schemaVersion,
        hasOwnerMetadata: ['ownerId', 'revision', 'projectId'].some((key) => key in envelope),
      },
      initialFocusInside,
      trappedFocus,
      importedName: document.body.textContent.includes('브라우저 QA 도면을 가져왔습니다'),
      importedZone: JSON.parse(localStorage.getItem('room-studio-layout-v2')).zones[0].name,
    };
  })()`);
  assertions.push(
    { name: 'project dialog receives initial focus', pass: projectResult.initialFocusInside },
    { name: 'project dialog traps Tab focus', pass: projectResult.trappedFocus },
    { name: 'portable download format is versioned', pass: projectResult.envelope.format === 'room-studio' && projectResult.envelope.formatVersion === 1 && projectResult.envelope.schemaVersion === 2 },
    { name: 'portable download excludes cloud metadata', pass: !projectResult.envelope.hasOwnerMetadata },
    { name: 'portable download uses the dedicated extension', pass: projectResult.filename.endsWith('.roomstudio.json') },
    { name: 'portable import updates project and layout', pass: projectResult.importedName && projectResult.importedZone === 'QA 거실' },
  );

  await evaluate(cdp, `document.querySelector('[data-project-open]').click()`);
  screenshots.projectDialog = await captureEvidence('green-project-dialog.png');
  await evaluate(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

  await setViewport(cdp, 390, 844);
  const portraitResult = await evaluate(cdp, `(() => {
    const tap = (node) => {
      const rect = node.getBoundingClientRect();
      const init = {
        bubbles: true,
        pointerId: 7,
        pointerType: 'touch',
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      node.dispatchEvent(new PointerEvent('pointerdown', init));
      document.dispatchEvent(new PointerEvent('pointerup', init));
    };
    tap(document.querySelector('.plan-item'));
    tap(document.querySelector('.plan-item'));
    const menu = document.querySelector('.mobile-context-menu');
    const toolbar = document.querySelector('.canvas-actions > div');
    const helperSizes = [...document.querySelectorAll('.section-help, .stats-bar span, .stats-bar small')]
      .filter((node) => node.getClientRects().length)
      .map((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    return {
      toolbarFits: toolbar.scrollWidth <= toolbar.clientWidth + 1,
      helperTextAtLeastTen: helperSizes.length > 0 && Math.min(...helperSizes) >= 10,
      modal: menu?.getAttribute('aria-modal') === 'true',
      backgroundInert: document.querySelector('.workspace').hasAttribute('inert'),
      focusTrapped: menu?.contains(document.activeElement) ?? false,
    };
  })()`);
  assertions.push(
    { name: 'portrait primary commands fit without horizontal scrolling', pass: portraitResult.toolbarFits },
    { name: 'portrait helper text is at least 10px', pass: portraitResult.helperTextAtLeastTen },
    { name: 'mobile action sheet is modal', pass: portraitResult.modal },
    { name: 'mobile action sheet makes editor inert', pass: portraitResult.backgroundInert },
    { name: 'mobile action sheet traps Tab focus', pass: portraitResult.focusTrapped },
  );
  screenshots.portrait = await captureEvidence('green-portrait.png');
  const escapeResult = await evaluate(cdp, `(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return {
      closed: !document.querySelector('.mobile-context-menu'),
      focusRestored: document.activeElement?.id === 'plan-canvas',
    };
  })()`);
  assertions.push(
    { name: 'mobile action sheet closes with Escape', pass: escapeResult.closed },
    { name: 'mobile Escape restores canvas focus', pass: escapeResult.focusRestored },
  );

  await setViewport(cdp, 844, 390);
  const landscapeResult = await measureLandscape(cdp);
  assertions.push(
    { name: 'landscape canvas remains visible above navigation', pass: landscapeResult.canvasVisible },
    { name: 'landscape primary controls remain above navigation', pass: landscapeResult.controlsVisible },
    { name: 'landscape has no horizontal document overflow', pass: landscapeResult.noDocumentOverflow },
  );
  screenshots.landscape = await captureEvidence('green-landscape.png');

  await setViewport(cdp, 1440, 1000);
  const deleteResult = await evaluate(cdp, `new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('project deletion did not render')), 5000);
    window.confirm = () => true;
    document.querySelector('[data-project-open]').click();
    const observer = new MutationObserver(() => {
      const stored = JSON.parse(localStorage.getItem('room-studio-layout-v2'));
      if (stored?.zones?.length || stored?.items?.length || stored?.structures?.length) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve({
        blank: true,
        notice: document.body.textContent.includes('빈 초안을 열었습니다'),
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.querySelector('[data-project-delete]').click();
  })`);
  assertions.push(
    { name: 'explicit local project deletion leaves a blank draft', pass: deleteResult.blank },
    { name: 'project deletion reports the resulting state', pass: deleteResult.notice },
  );

  const result = {
    targetUrl,
    assertions,
    passed: assertions.every(({ pass }) => pass),
    projectResult,
    portraitResult,
    escapeResult,
    landscapeResult,
    deleteResult,
    screenshots,
  };
  await writeFile(resultsPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
  }
} finally {
  await browser.close();
}
