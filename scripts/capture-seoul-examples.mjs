import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as reserveServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { REGIONAL_DEMO_LAYOUTS } from '../src/demo-layouts.js';
import { preparePersistedLayout } from '../src/consultation.js';
import { capture, evaluate, launchChrome, setViewport } from '../.omo/evidence/room-studio-improvements/browser-qa-lib.mjs';

const output = resolve('public/assets/seoul-examples');
const evidence = resolve('.omx/artifacts/seoul-assets/example-captures');
await mkdir(output, { recursive: true });
await mkdir(evidence, { recursive: true });
const manifest = { version: 1, source: 'Room Studio 3D canvas', license: 'Apache-2.0', examples: [] };
let server;
let browser;
try {
  const port = await new Promise((resolvePort, reject) => {
    const reservation = reserveServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const { port: available } = reservation.address();
      reservation.close(() => resolvePort(available));
    });
  });
  server = await createServer({
    cacheDir: join(evidence, 'vite-cache'),
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/.omx/**', '**/public/assets/seoul-examples/**'] } },
  });
  await server.listen();
  browser = await launchChrome(process.env.CHROME_PATH ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'));
  const { cdp } = browser;
  const page = (expression) => evaluate(cdp, expression);
  const errors = [];
  cdp.listeners.set('Runtime.exceptionThrown', new Set([(event) => errors.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text)]));
  let sequence = 0;
  const arm = async (expression) => {
    const key = `__captureSignal${sequence++}`;
    await page(`(() => {
      window[${JSON.stringify(key)}] = new Promise((resolveSignal, reject) => {
        const check = () => { if (${expression}) { clearTimeout(timer); observer.disconnect(); resolveSignal(true); } };
        const observer = new MutationObserver(check);
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Capture state timed out')); }, 30000);
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        check();
      });
      window[${JSON.stringify(key)}].catch(() => {});
    })()`);
    return () => page(`window[${JSON.stringify(key)}]`);
  };
  const click = async (selector) => {
    const point = await page(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('Missing: ' + ${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      const rect = element.getBoundingClientRect();
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      if (!rect.width || !rect.height || !element.contains(document.elementFromPoint(point.x, point.y))) throw new Error('Obscured: ' + ${JSON.stringify(selector)});
      return point;
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  };
  await setViewport(cdp, 1440, 1000);
  await browser.navigate(`http://127.0.0.1:${port}`);
  await click('[data-start-sample]');
  for (const [index, fixture] of REGIONAL_DEMO_LAYOUTS.entries()) {
    const ready = await arm(`document.querySelector('[data-walkthrough]')?.dataset.assetState === 'ready' && document.querySelector('[data-walkthrough]')?.dataset.studioReady === 'true'`);
    if (index === 0) await click('#open-walkthrough');
    else {
      await click('[data-demo-open]');
      await click(`[data-demo-studio="${fixture.id}"]`);
      await click('[data-demo-confirm-accept]');
    }
    await ready();
    const saved = await page('JSON.parse(localStorage.getItem("room-studio-layout-v2"))');
    assert.equal(saved.draftMetadata.projectName, fixture.name);
    const sourceHash = createHash('sha256').update(JSON.stringify(preparePersistedLayout(saved))).digest('hex');
    const images = [];
    for (const mode of ['dollhouse', 'top']) {
      const modeReady = await arm(`document.querySelector('[data-walkthrough]')?.dataset.viewMode === ${JSON.stringify(mode)}`);
      await click(`button[data-view-mode="${mode}"]`);
      await modeReady();
      await page('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      assert.equal(await page('document.querySelector("[data-studio-target]").value'), '', 'Example images must not contain an editing selection');
      const image = await page(`(() => {
        const canvas = document.querySelector('[data-walkthrough-stage] canvas');
        const previews = ${mode === 'dollhouse' ? '[160, 320, 640]' : '[]'}.map(width => {
          const preview = document.createElement('canvas');
          preview.width = width;
          preview.height = Math.round(canvas.height * width / canvas.width);
          const context = preview.getContext('2d');
          context.imageSmoothingQuality = 'high';
          context.drawImage(canvas, 0, 0, preview.width, preview.height);
          return { width, height: preview.height, data: preview.toDataURL('image/webp', .86).split(',')[1] };
        });
        return { width: canvas.width, height: canvas.height, data: canvas.toDataURL('image/webp', .9).split(',')[1], previews };
      })()`);
      const filename = `${fixture.assetStyle.cover}-${mode}.webp`;
      const bytes = Buffer.from(image.data, 'base64');
      assert.ok(bytes.length > 10_000, 'A scene image must contain actual rendered content');
      assert.equal(bytes.subarray(8, 12).toString(), 'WEBP');
      await writeFile(join(output, filename), bytes);
      const previews = [];
      for (const preview of image.previews) {
        const previewFilename = filename.replace('.webp', `-${preview.width}.webp`);
        const previewBytes = Buffer.from(preview.data, 'base64');
        await writeFile(join(output, previewFilename), previewBytes);
        previews.push({ filename: previewFilename, width: preview.width, height: preview.height, bytes: previewBytes.length, sha256: createHash('sha256').update(previewBytes).digest('hex') });
      }
      images.push({ filename, mode, width: image.width, height: image.height, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...(previews.length ? { previews } : {}) });
      await capture(cdp, join(evidence, `${fixture.assetStyle.cover}-${mode}.png`));
    }
    manifest.examples.push({ id: fixture.id, name: fixture.name, styleId: fixture.assetStyle.id, sourceHash, images });
    const closed = await arm(`!document.querySelector('[data-walkthrough]')`);
    await click('.walkthrough-exit');
    await closed();
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ status: 'PASS', examples: manifest.examples.map(({ id, images }) => ({ id, images: images.length })) }));
} finally {
  await browser?.close();
  await server?.close();
}
