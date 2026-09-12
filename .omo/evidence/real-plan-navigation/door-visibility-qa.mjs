import { mkdir, rm, writeFile } from 'node:fs/promises';
import process from 'node:process';
import {
  capture,
  evaluate,
  launchChrome,
  setViewport,
} from '../room-studio-improvements/browser-qa-lib.mjs';
import { DEMO_LAYOUTS, REGIONAL_DEMO_LAYOUTS } from '../../../src/demo-layouts.js';
import { safeArtifactPath } from './artifact-path.mjs';

const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const outputDir = safeArtifactPath(process.argv[3], '.omx/artifacts/real-plan-navigation/visibility');
const browser = await launchChrome(CHROME);

async function nextFrames() {
  await evaluate(browser.cdp, `new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`);
}

async function click(selector) {
  const point = await evaluate(browser.cdp, `(async () => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!control) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
    control.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = control.getBoundingClientRect();
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    if (control.closest('[inert]') || !control.contains(document.elementFromPoint(point.x, point.y))) {
      throw new Error('Obscured control: ' + ${JSON.stringify(selector)});
    }
    return point;
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  }
  await nextFrames();
}

async function waitFor(expression, label, timeout = 20_000) {
  const passed = await evaluate(browser.cdp, `new Promise((resolve) => {
    const check = () => {
      if (!(${expression})) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(true);
    };
    const observer = new MutationObserver(check);
    observer.observe(document, { attributes: true, childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, ${timeout});
    check();
  })`);
  if (!passed) throw new Error(`Timed out waiting for ${label}`);
}

let failure;
try {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await browser.navigate(url);
  await setViewport(browser.cdp, 1440, 1000);
  await waitFor(`document.querySelector('[data-demo-open]')`, 'application shell');
  await evaluate(browser.cdp, `localStorage.clear()`);
  if (await evaluate(browser.cdp, `Boolean(document.querySelector('[data-start-close]'))`)) {
    await click('[data-start-close]');
  }
  await click('[data-workspace-mode]');
  if (await evaluate(browser.cdp, `document.querySelector('.workspace')?.dataset.mode`) !== 'advanced') {
    throw new Error('Precision workspace did not open');
  }
  await click('[data-demo-open]');
  await waitFor(`document.querySelectorAll('[data-demo-card]').length === ${DEMO_LAYOUTS.length + REGIONAL_DEMO_LAYOUTS.length}`, 'demo gallery');

  const reports = [];
  for (const demo of process.env.REGIONAL_PLANS === '1' ? REGIONAL_DEMO_LAYOUTS : DEMO_LAYOUTS) {
    const expectedInteriorDoors = demo.structures.filter(({ type, exterior }) => type === 'door' && !exterior).length;
    const previewDoors = await evaluate(browser.cdp,
      `(() => {
        const card = document.querySelector('[data-demo-card="${demo.id}"]');
        const doors = [...card.querySelectorAll('[data-demo-preview-door]')].map((door) => {
          const rect = door.getBoundingClientRect();
          const style = getComputedStyle(door);
          const leaf = getComputedStyle(door, '::before');
          return {
            kind: door.dataset.demoPreviewDoor,
            width: rect.width,
            height: rect.height,
            display: style.display,
            visibility: style.visibility,
            leafWidth: Number.parseFloat(leaf.borderTopWidth),
            leafColor: leaf.borderTopColor,
          };
        });
        return {
          total: doors.length,
          interior: doors.filter(({ kind }) => kind === 'interior').length,
          doors,
        };
      })()`);
    await click(`[data-demo-layout="${demo.id}"]`);
    if (await evaluate(browser.cdp, `Boolean(document.querySelector('[data-demo-confirm-accept]'))`)) {
      await click('[data-demo-confirm-accept]');
    }
    await waitFor(
      `document.querySelectorAll('.plan-door').length === ${demo.structures.filter(({ type }) => type === 'door').length}`,
      `${demo.id} plan doors`,
    );
    await nextFrames();
    const planDoors = await evaluate(browser.cdp, `([...document.querySelectorAll('.plan-door')].map((door) => {
      const rect = door.getBoundingClientRect();
      const panel = door.querySelector('.door-panel');
      const style = getComputedStyle(panel);
      const viewport = { width: innerWidth, height: innerHeight };
      const canvas = document.querySelector('#plan-canvas').getBoundingClientRect();
      return {
        id: door.dataset.structureId,
        width: rect.width,
        height: rect.height,
        stroke: style.stroke,
        strokeWidth: Number.parseFloat(style.strokeWidth),
        opacity: Number.parseFloat(style.opacity),
        inViewport: rect.left >= Math.max(0, canvas.left) && rect.top >= Math.max(0, canvas.top)
          && rect.right <= Math.min(viewport.width, canvas.right) && rect.bottom <= Math.min(viewport.height, canvas.bottom),
      };
    }))`);
    await capture(browser.cdp, `${outputDir}/${demo.id}-plan.png`);

    await click('#open-walkthrough');
    await waitFor(`document.querySelector('[data-walkthrough-ready="true"]')`, `${demo.id} 3D`, 30_000);
    await waitFor(
      `getComputedStyle(document.querySelector('.walkthrough-curtain')).opacity === '0'`,
      `${demo.id} settled 3D transition`,
    );
    const threeDimensionalDoors = await evaluate(browser.cdp, `(() => {
      const overlay = document.querySelector('[data-walkthrough]');
      return {
        curtainOpacity: getComputedStyle(overlay.querySelector('.walkthrough-curtain')).opacity,
        controllers: Number(overlay.dataset.doorControllerCount),
        visibleMeshes: Number(overlay.dataset.visibleDoorMeshCount),
        visibleFrameParts: Number(overlay.dataset.visibleDoorFramePartCount),
      };
    })()`);
    await capture(browser.cdp, `${outputDir}/${demo.id}-3d.png`);
    await click('[data-walkthrough-exit]');
    await waitFor(`!document.querySelector('[data-walkthrough]')`, `${demo.id} 3D cleanup`);

    reports.push({
      id: demo.id,
      expectedInteriorDoors,
      previewDoors,
      planDoorCount: planDoors.length,
      planDoors,
      threeDimensionalDoors,
      passed: previewDoors.total === demo.structures.filter(({ type }) => type === 'door').length
        && previewDoors.interior === expectedInteriorDoors
        && previewDoors.doors.every(({ width, height, display, visibility, leafWidth }) => (
          Math.min(width, height) >= 7 && Math.max(width, height) >= 9
          && display !== 'none' && visibility === 'visible' && leafWidth >= 2
        ))
        && planDoors.length === demo.structures.filter(({ type }) => type === 'door').length
        && planDoors.every(({ width, height, stroke, strokeWidth, opacity, inViewport }) => (
          width > 0 && height > 0 && stroke !== 'none' && strokeWidth >= 3 && opacity > 0 && inViewport
        ))
        && threeDimensionalDoors.curtainOpacity === '0'
        && threeDimensionalDoors.controllers === demo.structures.filter(({ type }) => type === 'door').length
        && threeDimensionalDoors.visibleMeshes >= threeDimensionalDoors.controllers
        && threeDimensionalDoors.visibleFrameParts >= threeDimensionalDoors.controllers * 3,
    });
    await click('[data-demo-open]');
    await waitFor(`document.querySelector('[data-demo-layout="${demo.id}"]')`, `${demo.id} gallery return`);
  }
  const report = { passed: reports.every(({ passed }) => passed), reports };
  await writeFile(`${outputDir}/door-visibility.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) throw new Error('Demo room-door visibility audit failed');
} catch (error) {
  failure = error;
} finally {
  await browser.close();
}
if (failure) throw failure;
