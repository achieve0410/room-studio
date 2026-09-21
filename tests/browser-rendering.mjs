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
  assert.ok(apply || await page.locator('[data-walkthrough]').getAttribute('data-view-mode') === 'walk',
    'The editing footer is visible in overview modes');
  const screenshot = await page.screenshot({ path });
  const painted = await page.evaluate(async ({ data, rectangle, apply }) => {
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
    if (!apply) return { roomPixels: count, buttonContrast: null };
    sample.width = Math.round(apply.width - 16);
    sample.height = Math.round(apply.height - 16);
    context.drawImage(image, (apply.x + 8) * scale, (apply.y + 8) * scale,
      (apply.width - 16) * scale, (apply.height - 16) * scale, 0, 0, sample.width, sample.height);
    const buttonPixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let lightest = 0, darkest = 255;
    for (let i = 0; i < buttonPixels.length; i += 4) {
      const lightness = (buttonPixels[i] + buttonPixels[i + 1] + buttonPixels[i + 2]) / 3;
      lightest = Math.max(lightest, lightness); darkest = Math.min(darkest, lightness);
    }
    return { roomPixels: count, buttonContrast: lightest - darkest };
  }, { data: `data:image/png;base64,${screenshot.toString('base64')}`, rectangle, apply });
  assert.ok(painted.roomPixels >= 24, `Screenshot contains no painted room: ${path} (${painted.roomPixels} warm pixels)`);
  if (apply) assert.ok(painted.buttonContrast >= 35, `Screenshot contains no readable Apply label: ${path} (${painted.buttonContrast})`);
}
