import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  capture,
  evaluate,
  setViewport,
} from '../room-studio-improvements/browser-qa-lib.mjs';

const STORAGE_KEY = 'room-studio-layout-v2';

const existingLayout = {
  zones: [{
    id: 'existing-zone',
    spaceId: 'existing-space',
    name: '기존 방',
    type: '침실',
    x: 10,
    y: 10,
    width: 360,
    depth: 300,
    height: 240,
    color: '#d8c8ba',
  }],
  items: [{
    id: 'existing-item',
    name: '기존 침대',
    type: 'bed',
    shape: 'roundRect',
    x: 180,
    y: 160,
    width: 200,
    depth: 160,
    height: 50,
    elevation: 0,
    rotation: 0,
    color: '#c8b49d',
  }],
  structures: [],
  dimensions: [],
  backgroundPlan: null,
  wallHeight: 240,
  selection: null,
};

const nextFrames = `new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
})`;

export async function runStarterScenario({
  browser,
  cdp,
  evidenceDir,
  targetUrl,
}) {
  await browser.navigate(targetUrl);
  await evaluate(cdp, 'localStorage.clear()');
  await browser.navigate(targetUrl);
  await setViewport(cdp, 1440, 1000);

  const cleanState = await evaluate(cdp, `new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const backdrop = document.querySelector('[data-start-backdrop]');
      resolve({
        openerExists: Boolean(document.querySelector('[data-start-open]')),
        surfaceOpen: Boolean(backdrop),
        focusInside: Boolean(backdrop?.contains(document.activeElement)),
        blankExists: Boolean(document.querySelector('[data-start-blank]')),
        sampleExists: Boolean(document.querySelector('[data-start-sample]')),
        importExists: Boolean(document.querySelector('[data-start-import]')),
      });
    }));
  })`);
  const cleanScreenshot = await capture(
    cdp,
    join(evidenceDir, cleanState.surfaceOpen ? 'starter.png' : 'starter-red.png'),
  );

  let sampleState = null;
  if (cleanState.sampleExists) {
    sampleState = await evaluate(cdp, `new Promise((resolve) => {
      document.querySelector('[data-start-sample]').click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const saved = JSON.parse(localStorage.getItem('${STORAGE_KEY}') ?? '{}');
        resolve({
          surfaceClosed: !document.querySelector('[data-start-backdrop]'),
          zoneCount: saved.zones?.length ?? 0,
          itemCount: saved.items?.length ?? 0,
          sampleZone: saved.zones?.[0]?.name ?? null,
          sampleItem: saved.items?.[0]?.name ?? null,
          canvasFocused: document.activeElement?.id === 'plan-canvas',
        });
      }));
    })`);
  }

  await evaluate(cdp, `localStorage.setItem(
    '${STORAGE_KEY}',
    ${JSON.stringify(JSON.stringify(existingLayout))}
  )`);
  await browser.navigate(targetUrl);
  await evaluate(cdp, nextFrames);
  const existingState = await evaluate(cdp, `(() => {
    const saved = JSON.parse(localStorage.getItem('${STORAGE_KEY}') ?? '{}');
    return {
      surfaceOpen: Boolean(document.querySelector('[data-start-backdrop]')),
      zoneCount: saved.zones?.length ?? 0,
      itemCount: saved.items?.length ?? 0,
      zoneName: saved.zones?.[0]?.name ?? null,
      itemName: saved.items?.[0]?.name ?? null,
    };
  })()`);
  const existingScreenshot = await capture(cdp, join(evidenceDir, 'starter-existing.png'));

  const assertions = [
    { name: 'persistent starter action exists', pass: cleanState.openerExists },
    {
      name: 'clean profile opens an accessible starter surface',
      pass: cleanState.surfaceOpen
        && cleanState.focusInside
        && cleanState.blankExists
        && cleanState.sampleExists
        && cleanState.importExists,
    },
    {
      name: 'sample creates a complete layout and restores canvas focus',
      pass: Boolean(
        sampleState?.surfaceClosed
        && sampleState.zoneCount > 0
        && sampleState.itemCount > 0
        && sampleState.canvasFocused
      ),
    },
    {
      name: 'existing local data is neither prompted nor overwritten',
      pass: !existingState.surfaceOpen
        && existingState.zoneCount === 1
        && existingState.itemCount === 1
        && existingState.zoneName === '기존 방'
        && existingState.itemName === '기존 침대',
    },
  ];
  const result = {
    scenario: 'starter',
    targetUrl,
    passed: assertions.every(({ pass }) => pass),
    assertions,
    cleanState,
    sampleState,
    existingState,
    screenshots: {
      clean: cleanScreenshot,
      existing: existingScreenshot,
    },
  };
  const resultName = result.passed ? 'starter-results.json' : 'starter-red-results.json';
  await writeFile(join(evidenceDir, resultName), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
