import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  capture,
  evaluate,
  launchChrome,
  setViewport,
} from '../room-studio-improvements/browser-qa-lib.mjs';
import { runStarterScenario } from './starter-browser-scenario.mjs';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const evidenceDir = dirname(fileURLToPath(import.meta.url));
const urlIndex = process.argv.indexOf('--url');
const targetUrl = urlIndex >= 0 ? process.argv[urlIndex + 1] : 'http://127.0.0.1:4173';
const scenarioIndex = process.argv.indexOf('--scenario');
const scenario = scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : 'report';

if (!['report', 'starter'].includes(scenario)) {
  throw new Error(`Unsupported market QA scenario: ${scenario}`);
}

const seededLayout = {
  zones: [{
    id: 'zone-qa',
    spaceId: 'space-qa',
    name: 'QA 거실',
    type: '거실',
    x: 0,
    y: 0,
    width: 500,
    depth: 320,
    height: 240,
    color: '#d9d2c2',
  }],
  items: [{
    id: 'item-qa',
    name: 'QA 소파 <img src=x onerror=alert("qa")>',
    type: 'sofa',
    shape: 'roundRect',
    x: 80,
    y: 100,
    width: 210,
    depth: 90,
    height: 85,
    elevation: 0,
    rotation: 0,
    color: '#91a38f',
  }],
  structures: [],
  dimensions: [],
  backgroundPlan: null,
  wallHeight: 240,
  selection: null,
};

if (scenario === 'starter') {
  const starterBrowser = await launchChrome(chrome);
  try {
    const result = await runStarterScenario({
      browser: starterBrowser,
      cdp: starterBrowser.cdp,
      evidenceDir,
      targetUrl,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } finally {
    await starterBrowser.close();
  }
}

if (scenario === 'report') {
  const browser = await launchChrome(chrome);
  const { cdp } = browser;
  try {
  await browser.navigate(targetUrl);
  await evaluate(cdp, `localStorage.setItem(
    'room-studio-layout-v2',
    ${JSON.stringify(JSON.stringify(seededLayout))}
  )`);
  await browser.navigate(targetUrl);
  await setViewport(cdp, 1440, 1000);

  await evaluate(cdp, `(() => {
    window.__reportDownload = null;
    window.__reportBlobPromise = null;
    const originalCreateObjectUrl = URL.createObjectURL;
    URL.createObjectURL = function captureReportBlob(blob) {
      if (blob.type.startsWith('text/html')) window.__reportBlobPromise = blob.text();
      return originalCreateObjectUrl.call(URL, blob);
    };
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function captureReportDownload() {
      if (this.download?.endsWith('.html')) {
        const filename = this.download;
        window.__reportDownloadPromise = window.__reportBlobPromise
          .then((html) => {
            window.__reportDownload = { filename, html };
            return window.__reportDownload;
          });
        return;
      }
      originalClick.call(this);
    };
  })()`);

  const actionState = await evaluate(cdp, `new Promise((resolve) => {
    document.querySelector('[data-project-open]')?.click();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const action = document.querySelector('[data-project-report]');
      resolve({
        dialogOpen: Boolean(document.querySelector('[data-project-backdrop]')),
        actionExists: Boolean(action),
        actionLabel: action?.textContent.trim() ?? null,
      });
    }));
  })`);

  const screenshotName = actionState.actionExists ? 'report.png' : 'report-red.png';
  const screenshot = await capture(cdp, join(evidenceDir, screenshotName));

  let download = null;
  let documentState = null;
  let reportScreenshot = null;
  if (actionState.actionExists) {
    download = await evaluate(cdp, `new Promise((resolve, reject) => {
      document.querySelector('[data-project-report]').click();
      const timeout = setTimeout(() => reject(new Error('Report download was not captured')), 5000);
      window.__reportDownloadPromise.then((result) => {
        clearTimeout(timeout);
        resolve(result);
      }, reject);
    })`);
    await writeFile(join(evidenceDir, 'decision-report.html'), download.html);
    documentState = await evaluate(cdp, `(() => {
      const report = ${JSON.stringify(download.html)};
      const parsed = new DOMParser().parseFromString(report, 'text/html');
      return {
        title: parsed.querySelector('h1')?.textContent ?? '',
        hasSvg: Boolean(parsed.querySelector('svg')),
        hasMetrics: /집 면적/.test(parsed.body.textContent) && /바닥 점유/.test(parsed.body.textContent),
        hasWarnings: /배치 확인/.test(parsed.body.textContent),
        hasFurniture: parsed.body.textContent.includes('QA 소파'),
        hasSafetyBoundary: parsed.body.textContent.includes('전문가의 검토가 필요합니다'),
        hasExecutableMarkup: Boolean(parsed.querySelector('script, [onerror], [onclick], [onload]')),
        hasExternalResource: Boolean(parsed.querySelector('[src^="http"], [href^="http"]')),
      };
    })()`);
    const { frameTree } = await cdp.send('Page.getFrameTree');
    await cdp.send('Page.setDocumentContent', {
      frameId: frameTree.frame.id,
      html: download.html,
    });
    await evaluate(cdp, `new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`);
    await setViewport(cdp, 1200, 900);
    reportScreenshot = await capture(cdp, join(evidenceDir, 'report-surface.png'));
  }

  const assertions = [
    { name: 'project dialog opens', pass: actionState.dialogOpen },
    { name: 'decision report action exists', pass: actionState.actionExists },
    {
      name: 'decision report downloads as HTML',
      pass: download?.filename?.endsWith('-decision-report.html') ?? false,
    },
    {
      name: 'decision report contains plan and decision context',
      pass: Boolean(
        documentState?.hasSvg
        && documentState.hasMetrics
        && documentState.hasWarnings
        && documentState.hasFurniture
        && documentState.hasSafetyBoundary
      ),
    },
    {
      name: 'decision report blocks executable hostile markup',
      pass: Boolean(documentState && !documentState.hasExecutableMarkup && !documentState.hasExternalResource),
    },
  ];
  const result = {
    scenario,
    targetUrl,
    passed: assertions.every(({ pass }) => pass),
    assertions,
    actionState,
    download: download ? { filename: download.filename, bytes: Buffer.byteLength(download.html) } : null,
    documentState,
    screenshot,
    reportScreenshot,
  };
  const resultName = result.passed ? 'report-results.json' : 'report-red-results.json';
  await writeFile(join(evidenceDir, resultName), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}
