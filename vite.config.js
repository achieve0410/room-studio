import { defineConfig } from 'vite';
import { readFileSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';

// Dependency binaries stay out of git and app bundles. Development and builds
// expose the same pinned files, including v7's relaxed-SIMD variants.
function floorplanOcrAssets() {
  const dependencies = resolve(import.meta.dirname, 'node_modules');
  const assets = new Map([
    ['worker.min.js', resolve(dependencies, 'tesseract.js/dist/worker.min.js')],
    ['worker.min.js.LICENSE.txt', resolve(dependencies, 'tesseract.js/dist/worker.min.js.LICENSE.txt')],
    ['core/LICENSE', resolve(dependencies, 'tesseract.js-core/LICENSE')],
    ['lang/eng.traineddata.gz', resolve(dependencies, '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz')],
  ]);
  for (const variant of ['', '-lstm', '-simd', '-simd-lstm', '-relaxedsimd', '-relaxedsimd-lstm']) {
    for (const suffix of ['.wasm.js', '.wasm']) {
      const file = `tesseract-core${variant}${suffix}`;
      assets.set(`core/${file}`, resolve(dependencies, 'tesseract.js-core', file));
    }
  }
  let base;
  return {
    name: 'floorplan-ocr-assets',
    configResolved(config) { base = config.base; },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const prefix = `${base}ocr/`;
        if (!pathname.startsWith(prefix)) return next();
        const name = pathname.slice(prefix.length);
        const file = assets.get(name);
        if (!file) { response.statusCode = 404; response.end(); return; }
        response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript'
          : name.endsWith('.wasm') ? 'application/wasm'
            : name.endsWith('.gz') ? 'application/gzip' : 'text/plain');
        createReadStream(file).on('error', next).pipe(response);
      });
    },
    generateBundle() {
      for (const [name, file] of assets) {
        this.emitFile({ type: 'asset', fileName: `ocr/${name}`, source: readFileSync(file) });
      }
    },
  };
}

const allowedHosts = String(process.env.ROOM_STUDIO_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [floorplanOcrAssets()],
  optimizeDeps: {
    entries: ['index.html'],
  },
  server: {
    watch: {
      ignored: ['**/.omx/**'],
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
  },
  preview: {
    allowedHosts,
  },
});
