import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { ROOM_ASSETS } from '../src/asset-library.js';
import { capture, evaluate, launchChrome } from '../.omo/evidence/room-studio-improvements/browser-qa-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, '.omx/artifacts/seoul-assets');
const bounded = (promise, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 45000); })]).finally(() => clearTimeout(timer));
};

export async function renderAssets({ thumbnails = false } = {}) {
  await mkdir(output, { recursive: true });
  const errors = [], requests = [], renders = [];
  const server = await createServer({
    root, base: '/room-studio/', cacheDir: join(output, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/.omx/**'] } },
    plugins: [{ name: 'asset-preview-only', configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (!req.url?.split('?')[0].endsWith('/__asset-preview')) return next();
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html><head><link rel="icon" href="data:,"><title>Original Seoul asset collection</title></head><body style="margin:0;background:#f2efe9"><main id="stage"></main></body></html>');
      });
    } }],
  });
  let browser;
  try {
    await server.listen();
    const port = server.httpServer.address().port;
    browser = await launchChrome(process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    const { cdp } = browser;
    cdp.listeners.set('Runtime.exceptionThrown', new Set([(event) => errors.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text)]));
    cdp.listeners.set('Runtime.consoleAPICalled', new Set([(event) => { if (event.type === 'error') errors.push(event.args.map((arg) => arg.value ?? arg.description).join(' ')); }]));
    cdp.listeners.set('Network.responseReceived', new Set([(event) => {
      if (event.response.url.includes('/assets/room-studio/')) requests.push({ url: event.response.url, status: event.response.status });
    }]));
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await bounded(browser.navigate(`http://127.0.0.1:${port}/room-studio/__asset-preview`), 'Navigation');
    const page = (expression) => bounded(evaluate(cdp, expression), 'Asset rendering');
    await page(`(async () => { window.assetStudio = (await import('/room-studio/src/asset-library-preview.js')).createAssetPreview(document.querySelector('#stage')); return true; })()`);
    const groups = {
      seating: ['seoul-sofa', 'seoul-dining-chair'],
      bedroom: ['seoul-bed', 'seoul-wardrobe'],
      tables: ['seoul-dining-table', 'seoul-desk', 'seoul-coffee-table', 'seoul-side-table'],
      living: ['seoul-tv-console', 'seoul-plant', 'seoul-floor-lamp', 'seoul-rug'],
    };
    for (const [name, ids] of Object.entries(groups)) for (const materialId of ['warm-oak', 'walnut', 'soft-modern']) for (const angle of ['front', 'rear', 'top']) {
      const result = await page(`window.assetStudio.show(${JSON.stringify({ ids, materialId, angle })})`);
      const screenshot = `${name}-${materialId}-${angle}.png`;
      await bounded(capture(cdp, join(output, screenshot)), 'Screenshot');
      for (const entry of result.entries) {
        const asset = ROOM_ASSETS.find(({ id }) => id === entry.id);
        const expected = [asset.dimensions.width, asset.dimensions.height, asset.dimensions.depth];
        expected.forEach((value, index) => assert.ok(Math.abs(entry.dimensions[index] - value) < 1e-5, `${asset.id} axis ${index}`));
        assert.ok(Math.abs(entry.min[1]) < 1e-6, `${asset.id} bottom origin`);
        for (const axis of [0, 2]) assert.ok(Math.abs(entry.min[axis] + entry.max[axis]) < 1e-6, `${asset.id} centered`);
        assert.ok(entry.textures.length > 0 && entry.textures.every((texture) => texture.complete), `${asset.id} texture decode`);
      }
      renders.push({ ...result, screenshot });
    }
    for (const [name, surfaceIds] of Object.entries({ wood: ['oak-natural', 'walnut-smoked', 'oak-pale'], mineral: ['tile-ivory', 'tile-slate', 'plaster-warm', 'plaster-chalk'] })) {
      const result = await page(`window.assetStudio.show(${JSON.stringify({ surfaceIds, angle: 'top' })})`);
      assert.ok(result.entries.every((entry) => entry.textures.length === 3 && entry.textures.every((texture) => texture.complete)), 'Surface color/normal/roughness maps decoded');
      const screenshot = `surfaces-${name}.png`;
      await bounded(capture(cdp, join(output, screenshot)), 'Surface screenshot');
      renders.push({ ...result, screenshot });
    }
    if (thumbnails) for (const asset of ROOM_ASSETS) {
      await page(`window.assetStudio.show(${JSON.stringify({ ids: [asset.id], width: 512, height: 512 })})`);
      const png = await page('window.assetStudio.png()');
      await writeFile(join(root, 'public/assets/room-studio', asset.thumbnailPath), Buffer.from(png, 'base64'));
    }
    await page('window.assetStudio.dispose(); true');
    assert.deepEqual(errors, [], 'No browser exceptions or rendering/texture errors');
    assert.ok(requests.length >= ROOM_ASSETS.length);
    assert.ok(requests.every(({ status, url }) => status === 200 && url.startsWith(`http://127.0.0.1:${port}/room-studio/assets/room-studio/`)), 'Every model/texture loaded from same-origin nested base');
    const report = { status: 'passed', browser: await cdp.send('Browser.getVersion'), renders, requests, errors, thumbnails };
    await writeFile(join(output, 'render-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Rendered ${renders.length} group views; nested-base loads, bounds and textures verified.`);
    return report;
  } finally {
    await browser?.close();
    await server.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await renderAssets({ thumbnails: process.argv.includes('--thumbnails') });
