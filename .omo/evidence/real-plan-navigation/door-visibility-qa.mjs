import { mkdir, rm, writeFile } from 'node:fs/promises';
import process from 'node:process';
import {
  capture,
  evaluate,
  launchChrome,
  setViewport,
} from '../room-studio-improvements/browser-qa-lib.mjs';
import { DEMO_LAYOUTS } from '../../../src/demo-layouts.js';
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
  await evaluate(browser.cdp, `localStorage.clear();
    document.querySelector('[data-start-close]')?.click();
    document.querySelector('[data-demo-open]').click();`);
  await waitFor(`document.querySelectorAll('[data-demo-card]').length === ${DEMO_LAYOUTS.length}`, 'demo gallery');

  const reports = [];
  for (const demo of DEMO_LAYOUTS) {
    const expectedInteriorDoors = demo.source.roomAdjacency.length;
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
    await evaluate(browser.cdp, `document.querySelector('[data-demo-layout="${demo.id}"]').click()`);
    if (await evaluate(browser.cdp, `Boolean(document.querySelector('[data-demo-confirm-accept]'))`)) {
      await evaluate(browser.cdp, `document.querySelector('[data-demo-confirm-accept]').click()`);
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
      return {
        id: door.dataset.structureId,
        width: rect.width,
        height: rect.height,
        stroke: style.stroke,
        strokeWidth: Number.parseFloat(style.strokeWidth),
        opacity: Number.parseFloat(style.opacity),
        inViewport: rect.right > 0 && rect.bottom > 0 && rect.left < viewport.width && rect.top < viewport.height,
      };
    }))`);
    await capture(browser.cdp, `${outputDir}/${demo.id}-plan.png`);

    await evaluate(browser.cdp, `document.querySelector('#open-walkthrough').click()`);
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
    await evaluate(browser.cdp, `document.querySelector('[data-walkthrough-exit]').click()`);
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
    await evaluate(browser.cdp, `document.querySelector('[data-demo-open]').click()`);
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
