import assert from 'node:assert/strict';

export async function settleBrowserPaint(page) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => new Promise((done, reject) => {
    let frame;
    const timeout = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error('Browser paint timed out')); }, 20000);
    document.fonts.ready.then(async () => {
      const animations = document.getAnimations().filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity);
      await Promise.all(animations.map(animation => animation.finished.catch(error => {
        if (error.name !== 'AbortError') throw error;
      })));
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => { clearTimeout(timeout); done(); });
      });
    }).catch(error => { clearTimeout(timeout); reject(error); });
  }));
}

// These scene fixtures use warm wood floors. Check actual pixels, not readiness
// flags: both an unpainted canvas and a blank compositor capture must fail.
export async function captureRoomScene(page, path) {
  await settleBrowserPaint(page);
  await page.evaluate(() => new Promise((done, reject) => {
    const source = document.querySelector('[data-walkthrough-canvas]');
    const sample = document.createElement('canvas');
    sample.width = sample.height = 80;
    const context = sample.getContext('2d', { willReadFrequently: true });
    let frame;
    const timeout = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error('No painted room in WebGL canvas')); }, 20000);
    const inspect = () => {
      context.clearRect(0, 0, 80, 80);
      context.drawImage(source, 0, 0, 80, 80);
      const pixels = context.getImageData(0, 0, 80, 80).data;
      let roomPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] && pixels[i] - pixels[i + 1] > 8 && pixels[i + 1] - pixels[i + 2] > 8) roomPixels += 1;
      }
      if (roomPixels >= 24) { clearTimeout(timeout); done(); }
      else frame = requestAnimationFrame(inspect);
    };
    frame = requestAnimationFrame(inspect);
  }));
  const rectangle = await page.locator('[data-walkthrough-stage]').boundingBox();
  const apply = await page.locator('[data-studio-apply]').boundingBox();
  const walking = await page.locator('[data-walkthrough]').getAttribute('data-view-mode') === 'walk';
  const catalogIdle = !walking && await page.locator('.studio3d-shell').evaluate(node =>
    node.dataset.catalogIdle === 'true' && node.classList.contains('is-expanded'));
  if (!walking) assert.equal(Boolean(apply), !catalogIdle, 'Only an idle expanded catalog omits the editing footer');
  const control = apply ?? (catalogIdle
    ? await page.locator('[data-studio-category]:visible, [data-studio-search]:visible, [data-studio-catalog] button:visible').first().boundingBox()
    : null);
  assert.ok(control || walking, 'Overview exposes a real editing or catalog control');
  const screenshot = await page.screenshot({ path });
  const painted = await page.evaluate(async ({ data, rectangle, control }) => {
    const image = new Image();
    image.src = data;
    await image.decode();
    const sample = document.createElement('canvas');
    sample.width = sample.height = 80;
    const context = sample.getContext('2d', { willReadFrequently: true });
    const scale = image.width / innerWidth;
    context.drawImage(image, rectangle.x * scale, rectangle.y * scale, rectangle.width * scale, rectangle.height * scale, 0, 0, 80, 80);
    const pixels = context.getImageData(0, 0, 80, 80).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] && pixels[i] - pixels[i + 1] > 8 && pixels[i + 1] - pixels[i + 2] > 8) count += 1;
    }
    if (!control) return { roomPixels: count, controlContrast: null };
    sample.width = Math.round(control.width - 16);
    sample.height = Math.round(control.height - 16);
    context.drawImage(image, (control.x + 8) * scale, (control.y + 8) * scale,
      (control.width - 16) * scale, (control.height - 16) * scale, 0, 0, sample.width, sample.height);
    const buttonPixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let lightest = 0, darkest = 255;
    for (let i = 0; i < buttonPixels.length; i += 4) {
      const lightness = (buttonPixels[i] + buttonPixels[i + 1] + buttonPixels[i + 2]) / 3;
      lightest = Math.max(lightest, lightness); darkest = Math.min(darkest, lightness);
    }
    return { roomPixels: count, controlContrast: lightest - darkest };
  }, { data: `data:image/png;base64,${screenshot.toString('base64')}`, rectangle, control });
  assert.ok(painted.roomPixels >= 24, `Screenshot contains no painted room: ${path} (${painted.roomPixels} warm pixels)`);
  if (control) assert.ok(painted.controlContrast >= 35, `Screenshot contains no readable control label: ${path} (${painted.controlContrast})`);
}
