import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalDraftStore } from '../src/local-draft.js';

const ACTIVE = 'room-studio-layout-v2';
const RECOVERY = 'room-studio-recovery-v1';

const layout = () => ({
  zones: [],
  items: [],
  structures: [],
  dimensions: [],
  backgroundPlan: null,
  wallHeight: 240,
});

const document = (overrides = {}) => ({
  projectName: 'My room',
  layout: layout(),
  ownerId: null,
  projectId: null,
  baseRevision: null,
  dirty: true,
  ...overrides,
});

function fixture() {
  const values = new Map();
  const writes = [];
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, raw) {
      writes.push([key, raw]);
      values.set(key, raw);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  return {
    values,
    writes,
    storage,
    store: createLocalDraftStore(() => storage),
  };
}

function assertPortableLayout(value) {
  for (const key of [
    'ownerId', 'projectId', 'baseRevision', 'revision',
    'dirty', 'draftMetadata', 'projectName', 'selection',
  ]) {
    assert.equal(Object.hasOwn(value, key), false, key);
  }
}

test('legacy geometry loads anonymously without rewriting stored bytes', () => {
  const { values, writes, store } = fixture();
  assert.deepEqual(store.read(), { ok: true, draft: null, raw: null });
  const raw = JSON.stringify({ zones: [], items: [] });
  values.set(ACTIVE, raw);

  const result = store.read();
  assert.equal(result.ok, true);
  assert.equal(result.raw, raw);
  assert.equal(typeof result.draft.projectName, 'string');
  assert.ok(result.draft.projectName.length > 0);
  assert.equal(result.draft.ownerId, null);
  assert.equal(result.draft.projectId, null);
  assert.equal(result.draft.baseRevision, null);
  assert.equal(result.draft.dirty, true);
  for (const [key, value] of Object.entries(layout())) {
    assert.deepEqual(result.draft.layout[key], value);
  }
  assertPortableLayout(result.draft.layout);
  assert.equal(values.get(ACTIVE), raw);
  assert.deepEqual(writes, []);
});

test('name, identity, revision, dirty state and geometry commit atomically', () => {
  const { values, writes, store } = fixture();
  const input = document({
    projectName: '  My   room  ',
    ownerId: 'owner',
    projectId: 'project',
    baseRevision: 7,
    dirty: false,
  });
  Object.assign(input.layout, {
    ownerId: 'must-not-leak',
    projectId: 'must-not-leak',
    baseRevision: 55,
    revision: 55,
    dirty: true,
    draftMetadata: {},
    selection: {},
  });

  const result = store.write(input);
  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], ACTIVE);
  const stored = JSON.parse(values.get(ACTIVE));
  assert.deepEqual(stored.draftMetadata, {
    version: 1,
    projectName: 'My room',
    ownerId: 'owner',
    projectId: 'project',
    baseRevision: 7,
    dirty: false,
  });
  assert.deepEqual(stored.zones, []);
  assert.deepEqual(stored.items, []);
  assert.equal(Object.hasOwn(stored, 'layout'), false);
  assert.equal(values.get(ACTIVE).includes('must-not-leak'), false);
  const { draftMetadata, ...persistedLayout } = stored;
  assertPortableLayout(persistedLayout);
  assert.deepEqual(result.draft, {
    ...document({
      ownerId: 'owner',
      projectId: 'project',
      baseRevision: 7,
      dirty: false,
    }),
    layout: persistedLayout,
  });
  assert.deepEqual(store.read().draft, result.draft);
  assertPortableLayout(result.draft.layout);

  input.layout.zones.push({ id: 'later' });
  assert.deepEqual(result.draft.layout.zones, []);
  result.draft.layout.items.push({ id: 'also-later' });
  assert.deepEqual(store.read().draft.layout.items, []);
});

test('nullable identity, zero revision and normalized bounded names survive', () => {
  const { store } = fixture();
  const anonymous = store.write(document()).draft;
  assert.equal(anonymous.ownerId, null);
  assert.equal(anonymous.projectId, null);
  assert.equal(anonymous.baseRevision, null);
  assert.equal(anonymous.dirty, true);
  assert.equal(
    store.write(document({ baseRevision: 0, dirty: false })).draft.baseRevision,
    0,
  );
  assert.equal(
    store.write(document({ projectName: 'x'.repeat(100) })).draft.projectName.length,
    80,
  );
});

test('invalid metadata and layout fail before changing either stored copy', () => {
  const { values, writes, store } = fixture();
  assert.equal(store.write(document()).ok, true);
  assert.equal(store.protect(document()).ok, true);
  const before = [...values];
  const writeCount = writes.length;

  for (const patch of [
    { ownerId: 1 },
    { projectId: {} },
    { baseRevision: 1.2 },
    { baseRevision: Infinity },
    { baseRevision: NaN },
    { baseRevision: '2' },
    { dirty: 'false' },
    { layout: null },
    { layout: { zones: [], items: 'invalid' } },
  ]) {
    for (const method of ['write', 'protect']) {
      const result = store[method](document(patch));
      assert.equal(result.ok, false);
      assert.ok(result.error instanceof Error);
    }
  }
  const cyclic = layout();
  cyclic.zones.push(cyclic);
  assert.equal(store.write(document({ layout: cyclic })).ok, false);
  assert.deepEqual([...values], before);
  assert.equal(writes.length, writeCount);
});

test('quota failures preserve old data without an in-memory success fallback', () => {
  const { storage, values, store } = fixture();
  assert.equal(store.write(document()).ok, true);
  assert.equal(store.protect(document({ projectName: 'Protected' })).ok, true);
  const before = [...values];
  const error = new DOMException('full', 'QuotaExceededError');
  storage.setItem = () => { throw error; };

  for (const method of ['write', 'protect']) {
    assert.deepEqual(
      store[method](document({ projectName: 'Not saved' })),
      { ok: false, error },
    );
  }
  assert.deepEqual([...values], before);
  assert.equal(store.read().draft.projectName, 'My room');
  assert.equal(store.readRecovery().draft.projectName, 'Protected');
});

test('storage acquisition and operation failures are explicit for every method', () => {
  const error = new DOMException('blocked', 'SecurityError');
  const stores = [
    createLocalDraftStore(() => { throw error; }),
    createLocalDraftStore(() => ({
      getItem() { throw error; },
      setItem() { throw error; },
      removeItem() { throw error; },
    })),
  ];
  for (const store of stores) {
    for (const [method, argument] of [
      ['read'],
      ['readRecovery'],
      ['write', document()],
      ['protect', document()],
      ['clear'],
      ['clearRecovery'],
      ['readLegacy', 'old'],
      ['removeLegacy', 'old'],
    ]) {
      assert.deepEqual(store[method](argument), { ok: false, error });
    }
  }
});

test('malformed values retain raw bytes and never become anonymous fallbacks', () => {
  const { values, writes, store } = fixture();
  const validMetadata = {
    version: 1,
    projectName: 'Owned',
    ownerId: 'owner',
    projectId: 'project',
    baseRevision: 2,
    dirty: false,
  };
  const malformed = [
    '{broken',
    'null',
    '{}',
    JSON.stringify({ ...layout(), draftMetadata: null }),
    JSON.stringify({
      ...layout(),
      draftMetadata: { ...validMetadata, version: 99 },
    }),
    JSON.stringify({
      ...layout(),
      draftMetadata: { ...validMetadata, ownerId: 42 },
    }),
    JSON.stringify({
      ...layout(),
      draftMetadata: { version: 1, projectName: 'Incomplete' },
    }),
  ];
  for (const raw of malformed) {
    for (const [key, method] of [[ACTIVE, 'read'], [RECOVERY, 'readRecovery']]) {
      values.set(key, raw);
      const result = store[method]();
      assert.equal(result.ok, false);
      assert.ok(result.error instanceof Error);
      assert.equal(result.raw, raw);
      assert.equal(values.get(key), raw);
    }
  }
  assert.deepEqual(writes, []);
});

test('reads whitelist layouts without making authentication decisions', () => {
  const { values, store } = fixture();
  assert.equal(store.write(document({
    ownerId: 'another-owner',
    projectId: 'private-project',
    baseRevision: 8,
  })).ok, true);
  const stored = JSON.parse(values.get(ACTIVE));
  Object.assign(stored, {
    ownerId: 'root-leak',
    revision: 99,
    dirty: true,
    selection: {},
  });
  values.set(ACTIVE, JSON.stringify(stored));

  const result = store.read();
  assert.equal(result.ok, true);
  assert.equal(result.draft.ownerId, 'another-owner');
  assert.equal(result.draft.projectId, 'private-project');
  assert.equal(result.draft.baseRevision, 8);
  assertPortableLayout(result.draft.layout);
});

test('recovery changes only through protect or clearRecovery', () => {
  const { values, store } = fixture();
  assert.deepEqual(store.readRecovery(), { ok: true, draft: null, raw: null });
  assert.equal(store.write(document()).ok, true);
  assert.equal(store.protect(store.read().draft).ok, true);
  assert.equal(store.write(document({ projectName: 'Next' })).ok, true);
  assert.equal(store.readRecovery().draft.projectName, 'My room');
  assert.deepEqual(store.clear(), { ok: true, draft: null });
  assert.equal(values.has(ACTIVE), false);
  assert.equal(values.has(RECOVERY), true);

  assert.equal(store.protect(document({
    projectName: 'Replacement',
    layout: { ...layout(), ownerId: 'must-not-leak' },
  })).ok, true);
  assert.equal(store.readRecovery().draft.projectName, 'Replacement');
  assertPortableLayout(store.readRecovery().draft.layout);
  assert.equal(values.get(RECOVERY).includes('must-not-leak'), false);
  assert.equal(store.write(document()).ok, true);
  assert.deepEqual(store.clearRecovery(), { ok: true, draft: null });
  assert.equal(values.has(RECOVERY), false);
  assert.equal(store.read().draft.projectName, 'My room');
});

test('legacy keys are returned raw and removed only explicitly', () => {
  const { values, store } = fixture();
  values.set('old-owner', 'owner-id');
  assert.deepEqual(store.readLegacy('old-owner'), {
    ok: true,
    draft: null,
    raw: 'owner-id',
  });
  assert.equal(values.get('old-owner'), 'owner-id');
  assert.deepEqual(store.removeLegacy('old-owner'), { ok: true, draft: null });
  assert.equal(values.has('old-owner'), false);
  assert.deepEqual(store.readLegacy('missing'), {
    ok: true,
    draft: null,
    raw: null,
  });
});
