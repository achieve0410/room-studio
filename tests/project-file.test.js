import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PROJECT_FILE_BYTES,
  parseProjectFile,
  projectFileName,
  serializeProjectFile,
} from '../src/project-file.js';

const completeLayout = {
  zones: [{ id: 'zone-1', name: '거실' }],
  items: [{ id: 'item-1', name: '소파' }],
  structures: [{ id: 'wall-1', type: 'wall' }],
  dimensions: [{ id: 'dimension-1', x1: 0, y1: 0, x2: 100, y2: 0 }],
  backgroundPlan: {
    name: 'plan.jpg',
    dataUrl: 'data:image/jpeg;base64,AA==',
    x: 0,
    y: 0,
    width: 800,
    depth: 600,
    opacity: 0.4,
    locked: true,
  },
  wallHeight: 260,
  selection: { kind: 'item', id: 'item-1' },
  ownerId: 'must-not-export',
  revision: 9,
};

test('portable project files round-trip drawing data without cloud metadata', () => {
  // Given a complete drawing carrying transient and cloud-only fields
  const serialized = serializeProjectFile({
    projectName: '  우리   집  ',
    layout: completeLayout,
  });

  // When the portable envelope is parsed again
  const envelope = JSON.parse(serialized);
  const parsed = parseProjectFile(serialized);

  // Then the format is self-describing and only persisted drawing data survives
  assert.equal(envelope.format, 'room-studio');
  assert.equal(envelope.formatVersion, 1);
  assert.equal(envelope.schemaVersion, 2);
  assert.equal(parsed.projectName, '우리 집');
  assert.deepEqual(parsed.layout, {
    zones: completeLayout.zones,
    items: completeLayout.items,
    structures: completeLayout.structures,
    dimensions: completeLayout.dimensions,
    backgroundPlan: completeLayout.backgroundPlan,
    wallHeight: 260,
  });
  assert.equal(serialized.includes('must-not-export'), false);
  assert.equal(serialized.includes('"revision"'), false);
});

test('portable project files migrate schema v1 optional fields', () => {
  // Given a supported legacy drawing envelope without schema-v2 additions
  const legacy = JSON.stringify({
    format: 'room-studio',
    formatVersion: 1,
    schemaVersion: 1,
    projectName: '이전 도면',
    layout: {
      zones: [],
      items: [],
      structures: [],
      wallHeight: 240,
    },
  });

  // When it is imported
  const parsed = parseProjectFile(legacy);

  // Then schema-v2 optional fields receive safe defaults
  assert.deepEqual(parsed.layout.dimensions, []);
  assert.equal(parsed.layout.backgroundPlan, null);
});

test('portable project files reject malformed unsupported and oversized input', () => {
  // Given invalid envelopes at the file boundary
  const wrongFormat = JSON.stringify({ format: 'other', formatVersion: 1 });
  const futureVersion = JSON.stringify({ format: 'room-studio', formatVersion: 99 });
  const malformedLayout = JSON.stringify({
    format: 'room-studio',
    formatVersion: 1,
    schemaVersion: 2,
    projectName: '깨진 도면',
    layout: { zones: [] },
  });

  // When each input is parsed, then it fails with a user-actionable boundary error
  assert.throws(() => parseProjectFile(wrongFormat), /Room Studio 도면 파일/);
  assert.throws(() => parseProjectFile(futureVersion), /지원하지 않는 파일 버전/);
  assert.throws(() => parseProjectFile(malformedLayout), /유효한 도면 데이터/);
  assert.throws(() => parseProjectFile('x'.repeat(MAX_PROJECT_FILE_BYTES + 1)), /파일이 너무 큽니다/);
});

test('portable project filenames stay readable and filesystem-safe', () => {
  // Given a project name with path and punctuation characters
  // When a download filename is generated, then separators cannot escape the download directory
  assert.equal(projectFileName(' 우리 집 / 1층? '), 'room-studio-우리-집-1층.roomstudio.json');
});
