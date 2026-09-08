import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { safeArtifactPath } from './artifact-path.mjs';
import { DEMO_LAYOUTS, REGIONAL_DEMO_LAYOUTS } from '../../../src/demo-layouts.js';

const chrome = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => candidate && existsSync(candidate));
if (!chrome) throw new Error('Chrome or Chromium is required');

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const outputDir = safeArtifactPath(process.argv[3], '.omx/artifacts/real-plan-navigation/responsive');
const profile = await mkdtemp(join(
  process.env.REAL_PLAN_AUDIT_PROFILE_ROOT ?? tmpdir(),
  'room-studio-real-plan-responsive-',
));
let browser;
let socket;

const ready = new Promise((resolveReady, reject) => {
  let stderr = '';
  browser = spawn(chrome, [
    '--headless=new', '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-extensions', '--disable-sync', '--hide-scrollbars', '--no-first-run',
    '--remote-debugging-port=0', '--window-size=1440,1000', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  browser.stderr.on('data', (chunk) => {
    stderr += chunk;
    const match = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/\S+)/);
    if (match) resolveReady({ browserSocket: match[1], port: Number(match[2]) });
  });
  browser.once('exit', (code) => reject(new Error(`Chrome exited before CDP readiness: ${code}`)));
});

async function cleanup() {
  socket?.close();
  if (browser?.exitCode === null) {
    browser.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveExit) => browser.once('exit', resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
    ]);
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

let failure;
try {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const { port } = await ready;
  const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
  const page = pages.find((candidate) => candidate.type === 'page' && candidate.url === 'about:blank');
  if (!page) throw new Error('Chrome did not expose the intended about:blank page target');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    } else {
      const waiting = listeners.get(message.method) ?? [];
      listeners.delete(message.method);
      waiting.forEach((resolveEvent) => resolveEvent(message.params));
    }
  });
  const send = (method, params = {}) => new Promise((resolveSend, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveSend, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const once = (method) => new Promise((resolveEvent) => {
    const waiting = listeners.get(method) ?? [];
    waiting.push(resolveEvent);
    listeners.set(method, waiting);
  });
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  const waitFor = async (expression, label) => {
    const result = await evaluate(`new Promise((resolve) => {
      const check = () => { if (${expression}) { observer.disconnect(); clearTimeout(timer); resolve(true); } };
      const observer = new MutationObserver(check);
      observer.observe(document, { attributes: true, childList: true, subtree: true });
      const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, 15000);
      check();
    })`);
    if (!result) throw new Error(`Timed out waiting for ${label}`);
  };
  await send('Page.enable');
  await send('Runtime.enable');
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url });
  await loaded;
  await send('Runtime.enable');
  await waitFor(`document.querySelector('[data-demo-open]')`, 'application shell');
  await evaluate(`localStorage.clear(); document.querySelector('[data-demo-open]').click()`);
  await waitFor(`document.querySelectorAll('[data-demo-card]').length === ${DEMO_LAYOUTS.length + REGIONAL_DEMO_LAYOUTS.length}`, 'all model-home cards');

  const viewports = [
    { name: 'portrait-390x844', width: 390, height: 844 },
    { name: 'compact-landscape-844x390', width: 844, height: 390 },
  ];
  const results = [];
  for (const viewport of viewports) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: true,
    });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await waitFor(`window.innerWidth === ${viewport.width} && window.innerHeight === ${viewport.height}`, viewport.name);
    await evaluate(`document.querySelector('[data-demo-gallery]').scrollTop = 0`);
    const metrics = await evaluate(`(() => {
      const gallery = document.querySelector('[data-demo-gallery]');
      const cards = [...document.querySelectorAll('[data-demo-card]')];
      const controls = [...document.querySelectorAll('[data-demo-layout], [data-demo-close]')];
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentOverflow: document.documentElement.scrollWidth - innerWidth,
        galleryOverflow: gallery.scrollWidth - gallery.clientWidth,
        cardWidths: cards.map((card) => Math.round(card.getBoundingClientRect().width)),
        controls: controls.filter(visible).map((control) => {
          const rect = control.getBoundingClientRect();
          return { label: control.textContent.trim() || control.getAttribute('aria-label'),
            width: Math.round(rect.width), height: Math.round(rect.height) };
        }),
        clippedText: [...gallery.querySelectorAll('h2, h3, p, dd, small')].filter((element) =>
          element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
          .map((element) => element.textContent.trim().slice(0, 80)),
      };
    })()`);
    const pass = metrics.documentOverflow <= 0
      && metrics.galleryOverflow <= 0
      && metrics.cardWidths.every((width) => width > 0)
      && metrics.controls.every(({ width, height }) => width >= 44 && height >= 44)
      && metrics.clippedText.length === 0;
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(outputDir, `${viewport.name}.png`), Buffer.from(screenshot.data, 'base64'));
    results.push({ ...viewport, pass, metrics });
  }
  const report = { passed: results.every(({ pass }) => pass), url, results };
  await writeFile(join(outputDir, 'responsive-green.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) throw new Error('Responsive model-home gallery audit failed');
} catch (error) {
  failure = error;
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'responsive-error.txt'), error.stack ?? String(error));
} finally {
  await cleanup();
}
if (failure) throw failure;
