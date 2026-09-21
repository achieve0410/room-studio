import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { createDecisionReport } from '../src/project-report.js';
import { captureRoomScene, settleBrowserPaint } from './browser-rendering.mjs';

const execute = promisify(execFile);
const output = resolve('.omx/artifacts/consultation-presentation', new Date().toISOString().replaceAll(':', '-'));
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = await new Promise((accept, reject) => {
  const socket = createNetServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const address = socket.address();
    socket.close(() => accept(address.port));
  });
});
const server = await createServer({
  cacheDir: join(output, 'vite-cache'),
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/.omx/**'] } },
});
let browser;
const evidence = { output, screenshots: [], reports: [], checks: [], errors: [] };

async function screenshot(page, name, options = {}) {
  const path = join(output, `${name}.png`);
  if (await page.locator('[data-walkthrough-canvas]').count()) await captureRoomScene(page, path);
  else { await settleBrowserPaint(page); await page.screenshot({ path, ...options }); }
  evidence.screenshots.push(path);
}

async function renderPdfPages(pdfPath, prefix) {
  const swiftPath = join(output, `render-${prefix}.swift`);
  await writeFile(swiftPath, `import AppKit\nimport PDFKit\nlet source = CommandLine.arguments[1]\nlet destination = CommandLine.arguments[2]\nguard let document = PDFDocument(url: URL(fileURLWithPath: source)) else { fatalError("Cannot open PDF") }\nprint(document.pageCount)\nfor index in 0..<document.pageCount {\n  guard let page = document.page(at: index) else { continue }\n  let bounds = page.bounds(for: .mediaBox)\n  let scale: CGFloat = 2\n  let image = NSImage(size: NSSize(width: bounds.width * scale, height: bounds.height * scale))\n  image.lockFocus()\n  guard let context = NSGraphicsContext.current?.cgContext else { fatalError("No context") }\n  context.setFillColor(NSColor.white.cgColor)\n  context.fill(CGRect(origin: .zero, size: image.size))\n  context.saveGState()\n  context.scaleBy(x: scale, y: scale)\n  page.draw(with: .mediaBox, to: context)\n  context.restoreGState()\n  image.unlockFocus()\n  guard let data = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: data), let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("Cannot encode page") }\n  try png.write(to: URL(fileURLWithPath: destination + "-page-" + String(index + 1) + ".png"))\n}\n`);
  const result = await execute('swift', [swiftPath, pdfPath, join(output, prefix)], { timeout: 120_000 });
  const count = Number(result.stdout.trim());
  assert.ok(Number.isInteger(count) && count > 0, `${prefix} PDF has pages`);
  const pages = Array.from({ length: count }, (_, index) => join(output, `${prefix}-page-${index + 1}.png`));
  evidence.screenshots.push(...pages);
  return pages;
}

async function downloadTo(page, selector, name) {
  const pending = page.waitForEvent('download');
  await page.locator(selector).click();
  const download = await pending;
  const path = join(output, name);
  await download.saveAs(path);
  evidence.reports.push(path);
  return path;
}

async function openStudio(page) {
  await page.locator('#open-walkthrough').click();
  await page.locator('[data-walkthrough]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const overlay = document.querySelector('[data-walkthrough]');
    return overlay?.dataset.studioReady === 'true' && overlay?.dataset.assetState === 'ready';
  });
  const body = page.locator('.studio3d-body');
  if (await body.isHidden()) await page.locator('[data-studio-toggle]').click();
  await body.waitFor({ state: 'visible' });
}

async function closeStudio(page) {
  await page.locator('[data-walkthrough-exit]').first().click();
  await page.locator('[data-walkthrough]').waitFor({ state: 'detached' });
}

try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', error => evidence.errors.push(error.message));
  await page.addInitScript(() => { window.__roomStudioQaRenderProfile = true; });
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator('[data-start-room-form]').waitFor();
  await page.locator('[name="roomWidth"]').fill('420');
  await page.locator('[name="roomDepth"]').fill('300');
  await page.locator('[data-start-room-form] [type="submit"]').click();
  await page.locator('#plan-canvas').waitFor();
  await page.locator('[data-workspace-mode]').click();
  await page.waitForFunction(() => document.querySelector('.workspace')?.dataset.mode === 'advanced');

  await page.locator('[data-consultation-open]').click();
  const hostileProject = '서울 <가족 & 반려견> 배치';
  await page.locator('[name="projectName"]').fill(hostileProject);
  await page.locator('[name="businessName"]').fill('한결 공간 <스튜디오>');
  await page.locator('[name="clientName"]').fill('김고객 & 가족');
  await page.locator('[name="requirements"]').fill('창가를 비우고 아이의 동선을 확보합니다. <외부 링크 없음>');
  await page.locator('[name="optionLabel"]').fill('대화 중심');
  await page.locator('[name="recommendation"]').fill('마주 보는 자리를 우선합니다.');
  await page.locator('[name="nextSteps"]').fill('현장에서 창가 폭을 확인합니다.');
  await screenshot(page, 'desktop-consultation-form');
  await page.locator('[data-consultation-form] [type="submit"]').click();
  await page.locator('[data-consultation-form]').waitFor({ state: 'detached' });

  await openStudio(page);
  await page.locator('[data-studio-asset="seoul-side-table"]').click();
  await page.waitForFunction(() => document.querySelector('.studio3d-shell')?.dataset.pending === 'true');
  await page.locator('[data-studio-apply]').click();
  await page.waitForFunction(() => document.querySelector('.studio3d-shell')?.dataset.pending === 'false');
  await screenshot(page, 'desktop-option-a-3d');
  await closeStudio(page);

  await page.locator('[data-option-create]').click();
  await page.locator('[data-option-select="B"]').click();
  await openStudio(page);
  await page.locator('[data-studio-asset="seoul-dining-chair"]').click();
  await page.waitForFunction(() => document.querySelector('.studio3d-shell')?.dataset.pending === 'true');
  await page.locator('[data-studio-apply]').click();
  await page.waitForFunction(() => document.querySelector('.studio3d-shell')?.dataset.pending === 'false');
  await screenshot(page, 'desktop-option-b-3d');
  await closeStudio(page);

  await page.locator('[data-consultation-open]').click();
  await page.locator('[name="optionLabel"]').fill('수납과 독서');
  await page.locator('[name="recommendation"]').fill('독서 의자를 창에서 떨어뜨린 배치입니다.');
  await page.locator('[name="nextSteps"]').fill('의자 회전 반경을 현장에서 확인합니다.');
  await page.locator('[name="recommendedOption"]').selectOption('B');
  await page.locator('[data-consultation-form] [type="submit"]').click();

  await page.locator('[data-options-compare]').click();
  await page.locator('[data-comparison-option="B"]').waitFor();
  assert.equal(await page.locator('[data-comparison-option="A"] .plan-item').count(), 1);
  assert.equal(await page.locator('[data-comparison-option="B"] .plan-item').count(), 2);
  await screenshot(page, 'desktop-comparison');
  await page.keyboard.press('Escape');

  const completeReportPath = await downloadTo(page, '[data-consultation-report]', 'client-report-complete.html');
  const completeHtml = await readFile(completeReportPath, 'utf8');
  assert.equal((completeHtml.match(/<figure class="scene-card">/g) ?? []).length, 2, 'both current snapshots are used');
  assert.equal(new Set([...completeHtml.matchAll(/<img src="(data:image\/jpeg;base64,[^"]+)"/g)].map(match => match[1])).size, 2, 'A/B snapshots remain distinct');
  assert.equal(/<script\b|<link\b|<iframe\b|<object\b|<embed\b/i.test(completeHtml), false);
  assert.equal(/(?:src|href)=["']https?:/i.test(completeHtml), false);
  assert.ok(completeHtml.includes('서울 &lt;가족 &amp; 반려견&gt; 배치'));
  assert.equal(completeHtml.includes('서울 <가족 & 반려견> 배치'), false);

  const currentLayout = await page.evaluate(() => JSON.parse(localStorage.getItem('room-studio-layout-v2')));
  await page.locator('#undo-action').click();
  await page.locator('#undo-action').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('room-studio-layout-v2')).items.length === 1);
  const staleReportPath = await downloadTo(page, '[data-consultation-report]', 'client-report-stale-filtered.html');
  const staleHtml = await readFile(staleReportPath, 'utf8');
  const staleOptions = Object.fromEntries([...staleHtml.matchAll(/<article data-option="([AB])">([\s\S]*?)<\/article>/g)]
    .map(([, option, html]) => [option, html]));
  assert.match(staleOptions.A, /<figure class="scene-card">/);
  assert.doesNotMatch(staleOptions.B, /<figure class="scene-card">/);
  evidence.checks.push('a geometry edit invalidates only that option snapshot');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-consultation-open]').click();
  await screenshot(page, 'mobile-consultation-form');
  await page.keyboard.press('Escape');
  await page.locator('[data-options-compare]').click();
  await screenshot(page, 'mobile-comparison');
  await page.keyboard.press('Escape');

  const reportRequests = [];
  const reportPage = await context.newPage();
  reportPage.on('request', request => reportRequests.push(request.url()));
  await reportPage.setViewportSize({ width: 1440, height: 1000 });
  await reportPage.goto(`file://${completeReportPath}`);
  await reportPage.locator('article[data-option="B"] .scene-card img').waitFor();
  assert.equal(await reportPage.locator('.scene-card img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), true);
  assert.deepEqual(reportRequests.filter(url => /^https?:/i.test(url)), []);
  await screenshot(reportPage, 'desktop-report', { fullPage: true });
  await reportPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(await reportPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await screenshot(reportPage, 'mobile-report', { fullPage: true });

  const shortPdf = join(output, 'client-report-short.pdf');
  await reportPage.pdf({ path: shortPdf, printBackground: true, preferCSSPageSize: true });
  evidence.reports.push(shortPdf);
  const shortPages = await renderPdfPages(shortPdf, 'short-report');
  evidence.checks.push(`short two-option report rendered to ${shortPages.length} inspected A4 page images`);

  const saved = currentLayout;
  const previews = Object.fromEntries([...completeHtml.matchAll(/<article data-option="([AB])">[\s\S]*?<img src="([^"]+)"/g)]
    .map(([, option, image]) => [option, image.replaceAll('&amp;', '&')]));
  const longLayout = structuredClone(saved);
  const paragraph = '가구 간격과 창가 동선을 현장에서 확인하고, 가족의 사용 순서에 따라 좌석 방향을 다시 검토합니다.';
  longLayout.consultation.requirements = Array.from({ length: 28 }, () => paragraph).join('\n');
  longLayout.consultation.options.A.recommendation = Array.from({ length: 20 }, () => `A안 ${paragraph}`).join('\n');
  longLayout.consultation.options.B.nextSteps = Array.from({ length: 20 }, () => `B안 ${paragraph}`).join('\n');
  const longHtml = createDecisionReport({ projectName: hostileProject, layout: longLayout, previews, generatedAt: '2026-09-21T00:00:00.000Z' });
  const longPath = join(output, 'client-report-long-notes.html');
  await writeFile(longPath, longHtml);
  const longPage = await context.newPage();
  await longPage.goto(`file://${longPath}`);
  const longPdf = join(output, 'client-report-long-notes.pdf');
  await longPage.emulateMedia({ media: 'print' });
  assert.equal(await longPage.locator('.note').first().evaluate(node => getComputedStyle(node).display), 'block');
  await longPage.pdf({ path: longPdf, printBackground: true, preferCSSPageSize: true });
  evidence.reports.push(longPath, longPdf);
  const longPages = await renderPdfPages(longPdf, 'long-report');
  assert.ok(longPages.length > shortPages.length, 'long notes flow naturally to additional pages');
  evidence.checks.push(`long notes rendered to ${longPages.length} inspected page images`);

  const polygonLayout = structuredClone(saved);
  polygonLayout.zones[0] = {
    ...polygonLayout.zones[0], x: 0, y: 0, width: 420, depth: 300,
    points: [{ x: -210, y: -150 }, { x: 210, y: -150 }, { x: 210, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 150 }, { x: -210, y: 150 }],
  };
  polygonLayout.items = [];
  polygonLayout.structures = [];
  delete polygonLayout.consultation;
  const polygonHtml = createDecisionReport({ projectName: '현재 ㄱ자 공간', layout: polygonLayout });
  assert.match(polygonHtml, /<path[^>]+d="M -210 -150 L 210 -150 L 210 0 L 60 0 L 60 150 L -210 150 Z"/);
  evidence.checks.push('standalone report uses current polygon points');

  await page.goto(server.resolvedUrls.local[0]);
  await page.evaluate(() => {
    const current = JSON.parse(localStorage.getItem('room-studio-layout-v2'));
    delete current.consultation;
    current.draftMetadata.projectName = '이전 형식 프로젝트';
    localStorage.setItem('room-studio-layout-v2', JSON.stringify(current));
  });
  await page.reload();
  await page.locator('#plan-canvas').waitFor();
  assert.equal(await page.locator('h1').textContent(), '이전 형식 프로젝트');
  assert.equal(await page.locator('[data-option-select="A"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-option-select="B"]').isDisabled(), true);
  evidence.checks.push('legacy project without consultation metadata loads as editable A');

  assert.deepEqual(evidence.errors, []);
  evidence.status = 'PASS';
  console.log(`CONSULTATION_PRESENTATION_PASS ${output}`);
} catch (error) {
  evidence.status = 'FAIL';
  evidence.failure = error.stack;
  process.exitCode = 1;
  console.error(error.stack);
} finally {
  try { await browser?.close(); } catch (error) { evidence.errors.push(`browser cleanup: ${error.message}`); process.exitCode = 1; }
  try { await server.close(); } catch (error) { evidence.errors.push(`server cleanup: ${error.message}`); process.exitCode = 1; }
  evidence.cleanup = 'Owned Chrome and Vite server closed';
  if (output) await writeFile(join(output, 'results.json'), JSON.stringify(evidence, null, 2));
}
