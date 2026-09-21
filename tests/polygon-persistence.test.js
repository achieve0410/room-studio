import test from 'node:test';
import assert from 'node:assert/strict';
import { createComparisonOption, geometryForOption, preparePersistedLayout } from '../src/consultation.js';
import { parseProjectFile, serializeProjectFile } from '../src/project-file.js';
import { createCloudStore } from '../src/cloud-store.js';

const polygon = {
  id: 'concave-room', spaceId: 'concave-room', name: '거실',
  x: 20, y: 30, width: 500, depth: 400,
  points: [
    { x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 180 },
    { x: 240, y: 180 }, { x: 240, y: 400 }, { x: 0, y: 400 },
  ],
};
const drawing = () => ({
  zones: [structuredClone(polygon)], items: [],
  structures: [{
    id: 'entry', type: 'door', x: 120, y: 30, width: 80,
    orientation: 'horizontal', angle: 0, wallId: null,
    wallAttachment: { zoneId: 'concave-room', edgeIndex: 0, offset: 100 },
  }],
  dimensions: [], backgroundPlan: null, wallHeight: 240,
});

test('polygon projects use schema 4 and preserve both alternatives and opening ownership', () => {
  const layout = createComparisonOption(drawing());
  layout.consultation.inactiveGeometry.zones[0].points[2].x = 450;
  const envelope = JSON.parse(serializeProjectFile({ projectName: '직접 그린 집', layout }));
  assert.equal(envelope.schemaVersion, 4);
  const parsed = parseProjectFile(JSON.stringify(envelope)).layout;
  assert.deepEqual(parsed, layout);
  assert.deepEqual(geometryForOption(parsed, 'B').zones[0].points, layout.consultation.inactiveGeometry.zones[0].points);
});

test('portable readers retain all four supported schema versions', () => {
  for (const schemaVersion of [1, 2, 3, 4]) {
    const envelope = {
      format: 'room-studio', formatVersion: 1, schemaVersion,
      layout: { zones: [], items: [], structures: [], wallHeight: 240 },
    };
    assert.equal(parseProjectFile(JSON.stringify(envelope)).schemaVersion, schemaVersion);
  }
});

test('invalid polygon outlines are rejected in active and inactive layouts before normalization', () => {
  for (const points of [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    [{ x: 0, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }, { x: 400, y: 0 }],
    [{ x: 0, y: 0 }, { x: null, y: 400 }, { x: 400, y: 0 }],
  ]) {
    const active = drawing();
    active.zones[0].points = points;
    assert.throws(() => preparePersistedLayout(active), TypeError);
    const options = createComparisonOption(drawing());
    options.consultation.inactiveGeometry.zones[0].points = points;
    assert.throws(() => preparePersistedLayout(options), TypeError);
  }
});

test('invalid directed angles and edge ownership cannot cross persistence boundaries', () => {
  for (const updates of [
    { angle: null },
    { wallAttachment: { zoneId: 'missing', edgeIndex: 0, offset: 100 } },
    { wallAttachment: { zoneId: 'concave-room', edgeIndex: 99, offset: 100 } },
    { wallAttachment: { zoneId: 'concave-room', edgeIndex: 0, offset: -1 } },
    { wallId: 'explicit-wall' },
  ]) {
    const layout = drawing();
    Object.assign(layout.structures[0], updates);
    assert.throws(() => preparePersistedLayout(layout), TypeError);
  }
});

test('cloud readers preserve schema 3 and 4 and saves never downgrade polygons', async () => {
  const layout = drawing();
  let schema = 3;
  const rejection = new Error('schema_version constraint rejects 4');
  const query = {
    select() { return this; },
    eq() { return this; },
    async single() {
      return { data: { id: 'project', schema_version: schema, layout_json: layout }, error: null };
    },
  };
  const calls = [];
  const store = createCloudStore({ client: {
    auth: { getUser: async () => ({ data: { user: { id: 'owner' } }, error: null }) },
    from() { return query; },
    async rpc(name, parameters) {
      calls.push({ name, parameters });
      return { data: null, error: rejection };
    },
  } });
  assert.deepEqual((await store.loadProject('project')).layout_json, layout);
  schema = 4;
  assert.deepEqual((await store.loadProject('project')).layout_json, layout);
  await assert.rejects(store.saveProject({
    id: 'project', layout, expectedRevision: 7, expectedUserId: 'owner',
  }), error => error === rejection);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].parameters.p_schema_version, 4);
  assert.equal(calls[0].parameters.p_expected_revision, 7);
  assert.deepEqual(calls[0].parameters.p_layout_json.zones[0].points, polygon.points);
});
