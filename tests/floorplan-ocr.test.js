import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFloorplanDimensions } from '../src/floorplan-ocr.js';

const word = (text, confidence = 90, bbox = { x0: 10, y0: 20, x1: 70, y1: 40 }) => ({ text, confidence, bbox });
const output = (...words) => ({ blocks: [{ paragraphs: [{ lines: [{ words }] }] }] });

test('numeric OCR candidates preserve explicit units and do not assign missing ones', () => {
  const labels = ['3600', '3,600mm', '360cm', '3.6m', '3.6 M'];
  const candidates = labels.flatMap(text => parseFloorplanDimensions(output(word(text))));
  assert.deepEqual(candidates.map(({ value, unit }) => ({ value, unit })), [
    { value: 3600, unit: null }, { value: 3600, unit: 'mm' }, { value: 360, unit: 'cm' },
    { value: 3.6, unit: 'm' }, { value: 3.6, unit: 'm' },
  ]);
  assert.equal(candidates[1].text, labels[1]);
  assert.deepEqual(candidates[0].bounds, { x: 10, y: 20, width: 60, height: 20 });
});

test('adjacent separate unit words merge their bounds and use the weaker confidence', () => {
  const candidates = parseFloorplanDimensions(output(word('3500', 94),
    word('mm', 76, { x0: 75, y0: 18, x1: 101, y1: 42 })));
  assert.deepEqual(candidates, [{
    text: '3500 mm', value: 3500, unit: 'mm',
    bounds: { x: 10, y: 18, width: 91, height: 24 }, confidence: 76,
  }]);
  assert.equal(parseFloorplanDimensions(output(word('3500'),
    word('m', 90, { x0: 200, y0: 20, x1: 220, y1: 40 })))[0].unit, null);
  assert.equal(parseFloorplanDimensions(output(word('3500'),
    word('m', 90, { x0: 75, y0: 50, x1: 101, y1: 70 })))[0].unit, null);
});

test('OCR parsing rejects malformed labels, nonpositive lengths, and invalid boxes', () => {
  for (const text of ['room3600', '3600x4500', '3,60', '3.6m2', '0', '-300', '3OOO', '1.2.3', 'Infinity']) {
    assert.deepEqual(parseFloorplanDimensions(output(word(text))), []);
  }
  for (const bbox of [null, { x0: NaN, y0: 0, x1: 5, y1: 5 },
    { x0: -1, y0: 0, x1: 5, y1: 5 }, { x0: 10, y0: 10, x1: 5, y1: 5 }]) {
    assert.deepEqual(parseFloorplanDimensions(output(word('300', 90, bbox))), []);
  }
  assert.deepEqual(parseFloorplanDimensions({}), []);
  assert.deepEqual(parseFloorplanDimensions({ blocks: null }), []);
});

test('confidence stays on the native 0–100 scale and input output remains unchanged', () => {
  const data = output(word('100', 140), word('200', -1), word('300', NaN));
  const before = structuredClone(data);
  assert.deepEqual(parseFloorplanDimensions(data).map(candidate => candidate.confidence), [100, 0, 0]);
  assert.deepEqual(data, before);
});

// Explicit browser gate; ordinary node --test runs remain browser-free.
// FLOORPLAN_OCR_BROWSER=1 node --test tests/floorplan-ocr.test.js
if (process.env.FLOORPLAN_OCR_BROWSER === '1') {
  test('real self-hosted OCR recognizes text and cleans workers in dev and built subpaths', { timeout: 180_000 }, async () => {
    const { existsSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const { createServer: reservePort } = await import('node:net');
    const { createServer, build, preview } = await import('vite');
    const { chromium } = await import('playwright-core');
    const root = resolve(import.meta.dirname, '..');
    const artifact = join(root, '.omx/artifacts/floorplan-ocr');
    const executablePath = process.env.CHROME_PATH ?? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath(),
    ].find(existsSync);
    assert.ok(executablePath, 'Chrome or Chromium is required for the OCR browser gate');
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      await build({
        root, base: './',
        build: {
          outDir: join(artifact, 'dist'), emptyOutDir: true,
          rollupOptions: {
            preserveEntrySignatures: 'strict',
            input: { index: join(root, 'index.html'), 'floorplan-ocr': join(root, 'src/floorplan-ocr.js') },
            output: { entryFileNames: 'assets/[name].js' },
          },
        },
      });
      for (const mode of ['dev', 'built']) {
        const port = await new Promise((resolve, reject) => {
          const reservation = reservePort();
          reservation.once('error', reject);
          reservation.listen(0, '127.0.0.1', () => {
            const { port } = reservation.address();
            reservation.close(() => resolve(port));
          });
        });
        const server = mode === 'dev'
          ? await createServer({ root, server: { port, strictPort: true, host: '127.0.0.1', hmr: false } })
          : await preview({ root, base: '/room-studio/', build: { outDir: join(artifact, 'dist') },
            preview: { port, strictPort: true, host: '127.0.0.1' } });
        const page = await browser.newPage();
        const errors = [];
        const external = [];
        const requests = [];
        try {
          if (mode === 'dev') await server.listen();
          const url = server.resolvedUrls.local[0];
          const origin = new URL(url).origin;
          page.on('pageerror', error => errors.push(error.message));
          // Block and record every nonlocal request, including worker fetches.
          await page.context().route('**/*', route => {
            const request = route.request().url();
            requests.push(request);
            if (new URL(request).origin !== origin) {
              external.push(request);
              return route.abort();
            }
            return route.continue();
          });
          await page.addInitScript(() => {
            const NativeWorker = window.Worker;
            window.__ocrWorkers = { created: 0, active: 0, terminated: 0 };
            window.Worker = class extends NativeWorker {
              constructor(...args) {
                super(...args);
                this.ocrOwned = String(args[0]).includes('/ocr/');
                if (this.ocrOwned) {
                  window.__ocrWorkers.created += 1;
                  window.__ocrWorkers.active += 1;
                }
              }
              terminate() {
                if (this.ocrOwned) {
                  this.ocrOwned = false;
                  window.__ocrWorkers.active -= 1;
                  window.__ocrWorkers.terminated += 1;
                }
                return super.terminate();
              }
            };
          });
          await page.goto(url);
          assert.equal(requests.some(request => request.includes('/ocr/')), false);
          const moduleUrl = new URL(mode === 'dev' ? 'src/floorplan-ocr.js' : 'assets/floorplan-ocr.js', url).href;
          const result = await page.evaluate(async (moduleUrl) => {
            window.__ocr = await import(moduleUrl);
            const canvas = document.createElement('canvas');
            canvas.width = 800;
            canvas.height = 360;
            const context = canvas.getContext('2d');
            context.fillStyle = '#fff';
            context.fillRect(0, 0, 800, 360);
            context.fillStyle = '#000';
            context.font = '64px Arial';
            context.fillText('3600 mm', 80, 100);
            context.fillText('240 cm', 80, 200);
            context.fillText('3.6 m', 80, 300);
            window.__ocrImage = canvas;
            document.body.replaceChildren(canvas);
            const bounded = async operation => {
              let timeout;
              try {
                return await Promise.race([operation, new Promise((_, reject) => {
                  timeout = setTimeout(() => reject(new Error('OCR gate timed out')), 60_000);
                })]);
              } finally { clearTimeout(timeout); }
            };
            window.__boundedOcr = bounded;
            let progress = 0;
            const candidates = await bounded(window.__ocr.readFloorplanDimensions(canvas, { onProgress() { progress += 1; } }));
            return { candidates, progress, workers: { ...window.__ocrWorkers } };
          }, moduleUrl);
          assert.ok(result.progress > 0);
          for (const [value, unit] of [[3600, 'mm'], [240, 'cm'], [3.6, 'm']]) {
            const candidate = result.candidates.find(item => item.value === value && item.unit === unit);
            assert.ok(candidate, `${mode}: missing ${value} ${unit}: ${JSON.stringify(result.candidates)}`);
            assert.ok(candidate.confidence > 50);
            assert.ok(candidate.bounds.x >= 75 && candidate.bounds.x < 150);
            assert.ok(candidate.bounds.width > 0 && candidate.bounds.height > 0);
          }
          assert.deepEqual(result.workers, { created: 1, active: 0, terminated: 1 });
          await page.screenshot({ path: join(artifact, `${mode}.png`) });
          for (const stage of ['loading tesseract core', 'loading language traineddata', 'recognizing text']) {
            const aborted = await page.evaluate(async stage => {
              const controller = new AbortController();
              let afterAbort = 0;
              let didAbort = false;
              try {
                await window.__boundedOcr(window.__ocr.readFloorplanDimensions(window.__ocrImage, {
                  signal: controller.signal,
                  onProgress(event) {
                    if (didAbort) afterAbort += 1;
                    if (!didAbort && event.status === stage) { didAbort = true; controller.abort(); }
                  },
                }));
                return { resolved: true };
              } catch (error) {
                return { name: error.name, didAbort, afterAbort, active: window.__ocrWorkers.active };
              }
            }, stage);
            assert.deepEqual(aborted, { name: 'AbortError', didAbort: true, afterAbort: 0, active: 0 });
          }
          // A loading failure must settle and terminate, not become an empty success.
          for (const asset of ['worker.min.js', 'lang/eng.traineddata.gz']) {
            const pattern = `**/ocr/${asset}`;
            await page.context().route(pattern, route => route.fulfill({ status: 404, body: '' }));
            const failed = await page.evaluate(async () => {
              try {
                await window.__boundedOcr(window.__ocr.readFloorplanDimensions(window.__ocrImage));
                return { rejected: false };
              } catch (error) {
                return { rejected: true, timeout: error.message.includes('timed out'), active: window.__ocrWorkers.active };
              }
            });
            assert.deepEqual(failed, { rejected: true, timeout: false, active: 0 });
            await page.context().unroute(pattern);
          }
          const preaborted = await page.evaluate(async () => {
            const controller = new AbortController();
            controller.abort();
            const before = window.__ocrWorkers.created;
            try { await window.__ocr.readFloorplanDimensions(window.__ocrImage, { signal: controller.signal }); }
            catch (error) { return { name: error.name, created: window.__ocrWorkers.created - before }; }
          });
          assert.deepEqual(preaborted, { name: 'AbortError', created: 0 });
          assert.deepEqual(external, []);
          assert.deepEqual(errors, []);
          assert.ok(requests.some(request => request.includes('/ocr/core/') && request.endsWith('.wasm.js')));
          assert.ok(requests.some(request => request.endsWith('/ocr/lang/eng.traineddata.gz')));
          console.log(JSON.stringify({ mode, candidates: result.candidates, externalRequests: external.length,
            cleanup: await page.evaluate(() => window.__ocrWorkers) }));
        } finally {
          await page.close();
          if (mode === 'dev') await server.close();
          else await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
        }
      }
    } finally { await browser.close(); }
  });
}
