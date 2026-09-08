import assert from 'node:assert/strict';
import test from 'node:test';
import { createDecisionReport, decisionReportFileName } from '../src/project-report.js';
import { calculateCoverage } from '../src/geometry.js';

const layout = {
  zones: [
    {
      id: 'zone-1',
      name: '거실 <script>alert("zone")</script>',
      type: '거실',
      x: 0,
      y: 0,
      width: 500,
      depth: 320,
      height: 240,
      color: '#d9d2c2',
    },
  ],
  items: [
    {
      id: 'item-1',
      name: '소파 <img src=x onerror=alert("item")>',
      shape: 'roundRect',
      x: 70,
      y: 90,
      width: 210,
      depth: 90,
      height: 85,
      elevation: 0,
      rotation: 15,
      color: '#91a38f',
    },
  ],
  structures: [
    {
      id: 'wall-1',
      type: 'wall',
      name: '가벽',
      x: 250,
      y: 160,
      length: 180,
      height: 240,
      thickness: 4,
      orientation: 'vertical',
    },
  ],
  dimensions: [],
  backgroundPlan: null,
  wallHeight: 240,
};

const metrics = {
  areaSquareMeters: 16,
  coveragePercent: 12,
  warningCounts: {
    collisions: 1,
    outOfBounds: 0,
    height: 0,
    zoneOverlaps: 0,
  },
};

test('decision report is self-contained, useful, and safe for hostile names', () => {
  const report = createDecisionReport({
    projectName: '우리 집 </title><script>alert("title")</script>',
    layout,
    metrics,
    generatedAt: '2026-08-11T15:00:00.000Z',
  });

  assert.match(report, /^<!doctype html>/i);
  assert.match(report, /우리 집 &lt;\/title&gt;&lt;script&gt;/);
  assert.match(report, /거실 &lt;script&gt;alert/);
  assert.match(report, /소파 &lt;img src=x onerror=alert/);
  assert.match(report, /<svg[^>]+viewBox=/);
  assert.match(report, /16\.0m²/);
  assert.match(report, new RegExp(`${calculateCoverage(layout.items, layout.zones)}%`));
  assert.match(report, /data-warning-kind="outOfBounds" data-entity-id="item-1"/);
  assert.match(report, /210 × 90 × 85cm/);
  assert.doesNotMatch(report, /<script[\s>]/i);
  assert.doesNotMatch(report, /<img[\s>]/i);
  assert.doesNotMatch(report, /src=["']https?:/i);
});

test('decision report handles an empty draft without inventing furniture', () => {
  const report = createDecisionReport({
    projectName: '빈 도면',
    layout: {
      zones: [],
      items: [],
      structures: [],
      dimensions: [],
      backgroundPlan: null,
      wallHeight: 240,
    },
    metrics: {
      areaSquareMeters: 0,
      coveragePercent: 0,
      warningCounts: {
        collisions: 0,
        outOfBounds: 0,
        height: 0,
        zoneOverlaps: 0,
      },
    },
    generatedAt: '2026-08-11T15:00:00.000Z',
  });

  assert.match(report, /등록된 가구가 없습니다/);
  assert.match(report, /배치 경고 없음/);
  assert.match(report, /viewBox="0 0 800 500"/);
});

test('decision report filename stays readable and filesystem-safe', () => {
  assert.equal(
    decisionReportFileName('  우리 집 / 최종:*?  '),
    'room-studio-우리-집-최종-decision-report.html',
  );
});

test('report preserves persistent dimensions and opening state', () => {
  const report = createDecisionReport({ layout: {
    ...layout,
    dimensions: [{ id: 'measure-1', name: '통로', x1: -200, y1: -100, x2: -100, y2: -100 }],
    structures: [{ id: 'door-1', name: '출입문', type: 'door', doorType: 'swing', x: 100, y: 0, width: 80, orientation: 'horizontal', hinge: 'start', openSide: 1, openAngle: 90 }],
  }, metrics });
  assert.match(report, /data-dimension-id="measure-1"/);
  assert.match(report, /class="door-swing"/);
  assert.match(report, /class="door-panel"/);
});

test('warnings are derived from layout and identify each affected object', () => {
  const items = [
    { ...layout.items[0], id: 'tall', name: '<높은 장>', x: 250, y: 150, rotation: 0, height: 300 },
    { ...layout.items[0], id: 'other', name: '다른 장', x: 250, y: 150, rotation: 0 },
    { ...layout.items[0], id: 'outside', name: '밖의 장', x: -500, y: -500, rotation: 0 },
  ];
  const report = createDecisionReport({ layout: { ...layout, items }, metrics: { warningCounts: {} } });
  for (const [kind, id] of [['collisions', 'tall'], ['collisions', 'other'], ['height', 'tall'], ['outOfBounds', 'outside']]) {
    assert.match(report, new RegExp(`data-warning-kind="${kind}" data-entity-id="${id}"`));
  }
  assert.match(report, /&lt;높은 장&gt;/);
});

test('consultation options keep geometry, warnings, metrics and escaped notes separate', () => {
  const alternate = { ...layout, items: [], zones: [{ ...layout.zones[0], width: 100, depth: 100 }], structures: [] };
  const report = createDecisionReport({ layout: { ...layout, consultation: {
    version: 1, businessName: '<업체>', clientName: '<고객>', requirements: '<요청>', activeOption: 'B', recommendedOption: 'A',
    options: { A: { label: '대안', recommendation: '<추천 A>', nextSteps: '<수정 A>' }, B: { label: '현재', recommendation: '<추천 B>', nextSteps: '<수정 B>' } },
    inactiveGeometry: alternate,
  } }, metrics: { areaSquareMeters: 999, coveragePercent: 999 } });
  const sections = [...report.matchAll(/<article data-option="([AB])">([\s\S]*?)<\/article>/g)];
  assert.equal(sections.length, 2);
  const options = Object.fromEntries(sections.map(([, key, html]) => [key, html]));
  assert.match(options.A, /data-metric="area">1\.0m²/);
  assert.match(options.B, /data-metric="area">16\.0m²/);
  assert.doesNotMatch(options.A, /data-warning-kind=/);
  assert.match(options.B, /data-warning-kind="outOfBounds"/);
  for (const value of ['업체', '고객', '요청', '추천 A', '추천 B', '수정 A', '수정 B']) assert.ok(report.includes(`&lt;${value}&gt;`));
  assert.doesNotMatch(report, /999/);
});

test('legacy missing layouts stay empty and blank notes do not invent recommendations', () => {
  for (const layout of [undefined, null, {}]) {
    const report = createDecisionReport({ layout });
    assert.equal([...report.matchAll(/<article data-option=/g)].length, 1);
    assert.doesNotMatch(report, /data-field="recommendation"|data-field="nextSteps"/);
    assert.match(report, /data-metric="items">0개/);
  }
});

test('space overlap warnings identify both spaces, including duplicate names', () => {
  const zones = [layout.zones[0], { ...layout.zones[0], id: 'zone-2', x: 100 }];
  const report = createDecisionReport({ layout: { ...layout, zones, items: [] } });
  for (const id of ['zone-1', 'zone-2']) assert.match(report, new RegExp(`data-warning-kind="zoneOverlaps" data-entity-id="${id}"`));
});
