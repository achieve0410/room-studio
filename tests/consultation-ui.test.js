import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConsultationToolbar, renderConsultationDialog, renderComparisonDialog } from '../src/consultation-ui.js';
import { normalizeConsultation } from '../src/consultation.js';

const geometry = (width, itemCount) => ({
  zones: [{ id: `z-${width}`, name: '공간', x: 0, y: 0, width, depth: 100, height: 240 }],
  items: Array.from({ length: itemCount }, (_, index) => ({ id: `i-${index}`, name: '가구', x: 20, y: 20, width: 10, depth: 10, height: 10 })),
  structures: [], dimensions: [], backgroundPlan: null, wallHeight: 240,
});

test('consultation renderers preserve every action hook and task dialog contract', () => {
  const consultation = normalizeConsultation();
  const toolbar = renderConsultationToolbar({ projectName: '집', consultation });
  for (const hook of ['data-consultation-open', 'data-option-select="A"', 'data-option-select="B"', 'data-option-create', 'data-options-compare', 'data-consultation-report']) assert.match(toolbar, new RegExp(hook));
  const dialog = renderConsultationDialog({ projectName: '집', consultation });
  for (const hook of ['data-consultation-backdrop', 'data-consultation-close', 'data-consultation-form']) assert.match(dialog, new RegExp(hook));
  assert.match(dialog, /role="dialog" aria-modal="true" aria-labelledby="consultation-dialog-title"/);
});

test('comparison option metrics follow A and B geometry when B is currently active', () => {
  const activeB = geometry(500, 3);
  activeB.consultation = normalizeConsultation({
    activeOption: 'B',
    inactiveGeometry: geometry(200, 1),
    options: { A: { label: '적은 안' }, B: { label: '많은 안' } },
  });
  const html = renderComparisonDialog({ projectName: '비교', layout: activeB });
  const cards = Object.fromEntries([...html.matchAll(/data-comparison-option="([AB])"([\s\S]*?)<\/article>/g)].map(([, key, card]) => [key, card]));
  assert.match(cards.A, /data-comparison-items="1"/);
  assert.match(cards.A, /data-comparison-area="2\.0"/);
  assert.match(cards.B, /data-comparison-items="3"/);
  assert.match(cards.B, /data-comparison-area="5\.0"/);
  for (const hook of ['data-comparison-backdrop', 'data-comparison-close', 'data-comparison-edit="A"', 'data-comparison-edit="B"']) assert.match(html, new RegExp(hook));
});
