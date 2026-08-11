import assert from 'node:assert/strict';
import test from 'node:test';
import { createDecisionReport, decisionReportFileName } from '../src/project-report.js';

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
  assert.match(report, /12%/);
  assert.match(report, /충돌 1/);
  assert.match(report, /210 × 90 × 85cm/);
  assert.match(report, /건축 인허가·구조·접근성·시공 판단은 관련 전문가의 검토가 필요합니다/);
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
