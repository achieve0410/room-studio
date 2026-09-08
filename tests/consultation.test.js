import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_SCHEMA_VERSION, geometrySnapshot, preparePersistedLayout,
  normalizeConsultation, createComparisonOption, switchConsultationOption, geometryForOption,
} from '../src/consultation.js';

const drawing = () => ({
  zones: [{ id: 'z', name: 'A' }], items: [], structures: [],
  dimensions: [], backgroundPlan: null, wallHeight: 240,
});

test('legacy layouts remain single drawings and editable metadata defaults do not create B', () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 3);
  assert.equal(Object.hasOwn(preparePersistedLayout(drawing()), 'consultation'), false);
  const notes = normalizeConsultation();
  assert.deepEqual(notes, {
    version: 1, businessName: '', clientName: '', requirements: '',
    activeOption: 'A', recommendedOption: null,
    options: {
      A: { label: 'A안', recommendation: '', nextSteps: '' },
      B: { label: 'B안', recommendation: '', nextSteps: '' },
    },
    inactiveGeometry: null,
  });
  assert.equal(normalizeConsultation({ clientName: 'Client' }).inactiveGeometry, null);
  assert.throws(() => geometryForOption(drawing(), 'B'));
  assert.throws(() => switchConsultationOption(drawing(), 'B'));
});

test('B is explicitly cloned once; switching swaps geometry without moving option notes', () => {
  const original = { ...drawing(), consultation: normalizeConsultation({ clientName: 'Client' }) };
  const compared = createComparisonOption(original);
  assert.equal(original.consultation.inactiveGeometry, null);
  assert.equal(compared.consultation.activeOption, 'A');
  assert.deepEqual(compared.consultation.inactiveGeometry, drawing());
  assert.throws(() => createComparisonOption(compared));
  compared.consultation.options.B.recommendation = 'B recommendation';
  const activeB = switchConsultationOption(compared, 'B');
  activeB.zones[0].name = 'B';
  activeB.consultation.recommendedOption = 'B';
  const activeA = switchConsultationOption(activeB, 'A');
  assert.equal(activeA.zones[0].name, 'A');
  assert.equal(activeA.consultation.inactiveGeometry.zones[0].name, 'B');
  assert.equal(activeA.consultation.options.B.recommendation, 'B recommendation');
  assert.equal(activeA.consultation.recommendedOption, 'B');
  assert.equal(compared.zones[0].name, 'A');
  const same = switchConsultationOption(activeA, 'A');
  same.zones[0].name = 'changed';
  assert.equal(activeA.zones[0].name, 'A');
  const selected = geometryForOption(activeA, 'B');
  selected.zones[0].name = 'changed';
  assert.equal(activeA.consultation.inactiveGeometry.zones[0].name, 'B');
  assert.throws(() => switchConsultationOption(activeA, 'C'));
});

test('geometry and consultation snapshots whitelist fields and deep-copy both options', () => {
  const source = createComparisonOption(drawing());
  source.ownerId = 'secret';
  source.selection = { id: 'z' };
  source.consultation.ownerId = 'secret';
  source.consultation.options.A.revision = 12;
  const snapshot = preparePersistedLayout(source);
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  assert.equal(Object.hasOwn(snapshot.consultation.options.A, 'revision'), false);
  assert.equal(Object.hasOwn(geometrySnapshot(source), 'consultation'), false);
  source.consultation.inactiveGeometry.zones[0].name = 'changed';
  assert.equal(snapshot.consultation.inactiveGeometry.zones[0].name, 'A');
});

test('external boundary rejects malformed, recursive, unavailable-option and overlong consultation', () => {
  const valid = normalizeConsultation();
  const invalid = [null, [], 'notes', {},
    { ...valid, version: 2 }, { ...valid, businessName: 1 },
    { ...valid, businessName: 'x'.repeat(121) },
    { ...valid, clientName: 'x'.repeat(121) },
    { ...valid, requirements: 'x'.repeat(8001) },
    { ...valid, activeOption: 'B' }, { ...valid, recommendedOption: 'B' },
    { ...valid, options: { A: valid.options.A } },
    { ...valid, options: { ...valid.options, A: { ...valid.options.A, label: 'x'.repeat(81) } } },
    { ...valid, options: { ...valid.options, A: { ...valid.options.A, recommendation: 'x'.repeat(4001) } } },
    { ...valid, options: { ...valid.options, B: { ...valid.options.B, nextSteps: 'x'.repeat(4001) } } },
    { ...valid, inactiveGeometry: { ...drawing(), consultation: valid } },
    { ...valid, inactiveGeometry: { ...drawing(), layout: drawing() } },
    { ...valid, inactiveGeometry: { ...drawing(), ownerId: 'secret' } },
    { ...valid, inactiveGeometry: { ...drawing(), dimensions: {} } },
  ];
  for (const consultation of invalid) {
    assert.throws(() => preparePersistedLayout({ ...drawing(), consultation }));
  }
  const cyclic = drawing();
  cyclic.zones.push(cyclic);
  assert.throws(() => preparePersistedLayout(cyclic));
});

test('complete two-option payload obeys the 1 MiB UTF-8 boundary', () => {
  const source = drawing();
  source.backgroundPlan = { dataUrl: 'x'.repeat(600_000) };
  assert.doesNotThrow(() => preparePersistedLayout(source));
  assert.throws(() => createComparisonOption(source), (error) => error.code === 'FILE_TOO_LARGE');
});
