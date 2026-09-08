import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPlanSvg } from '../src/plan-svg.js';
import { getDoorLeafSegments, itemBounds } from '../src/geometry.js';

const zone = { id: 'room', name: '방', x: 0, y: 0, width: 400, depth: 300, height: 240 };
const door = { id: 'door', name: '문', type: 'door', doorType: 'swing', x: 100, y: 0, width: 80, orientation: 'horizontal', hinge: 'start', openSide: 1, openAngle: 90 };
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
const tags = (svg, name) => [...svg.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map(([tag]) => attributes(tag));

test('automatic and explicit walls cut the same opening instead of drawing across it', () => {
  const wall = { id: 'wall', type: 'wall', x: 200, y: 0, orientation: 'horizontal', length: 400, thickness: 4 };
  const svg = renderPlanSvg({ zones: [zone], structures: [wall, { ...door, wallId: 'wall' }] });
  const spans = tags(svg, 'line').filter((line) => !line.class && line.y1 === '0' && line.y2 === '0');
  assert.equal(spans.filter((line) => line.x1 === '0' && line.x2 === '60').length, 2);
  assert.equal(spans.filter((line) => line.x1 === '140' && line.x2 === '400').length, 2);
  assert.ok(!spans.some((line) => Number(line.x1) < 100 && Number(line.x2) > 100));
});

test('automatic interior walls disappear for compound spaces', () => {
  const neighbor = { ...zone, id: 'neighbor', x: 400 };
  const shared = (svg) => tags(svg, 'line').filter((line) => line.x1 === '400' && line.x2 === '400');
  assert.equal(shared(renderPlanSvg({ zones: [zone, neighbor] })).length, 1);
  assert.equal(shared(renderPlanSvg({ zones: [{ ...zone, spaceId: 'joined' }, { ...neighbor, spaceId: 'joined' }] })).length, 0);
});

test('swing leaf, hinge and arc preserve every orientation and opening state', () => {
  for (const hinge of ['start', 'end']) for (const openSide of [-1, 1]) for (const openAngle of [0, 45, 90, 120]) {
    const saved = { ...door, hinge, openSide, openAngle, orientation: 'vertical' };
    const svg = renderPlanSvg({ structures: [saved] });
    const leaf = tags(svg, 'line').find(({ class: name }) => name === 'door-panel');
    const expected = getDoorLeafSegments([{ ...saved, x: 0, y: 0, orientation: 'horizontal' }])[0];
    assert.equal(Number(leaf.x1), expected.start.x);
    assert.equal(Number(leaf.x2), expected.end.x);
    assert.equal(Number(leaf.y2), expected.end.y);
    assert.equal(tags(svg, 'path').filter(({ class: name }) => name === 'door-swing').length, openAngle ? 1 : 0);
    assert.ok(tags(svg, 'g').some(({ transform }) => transform === 'translate(100 0) rotate(90)'));
  }
});

test('sliding door and window panels preserve saved ratios and direction', () => {
  for (const type of ['door', 'window']) for (const slideDirection of ['start', 'end']) for (const openRatio of [0, 50, 100]) {
    const saved = { ...door, type, doorType: 'sliding', slideDirection, openRatio };
    const svg = renderPlanSvg({ structures: [saved] });
    const moving = tags(svg, 'line').find(({ class: name }) => name === `${type}-panel ${type}-panel-moving`);
    const leaf = getDoorLeafSegments([{ ...saved, type: 'door', x: 0, y: 0 }])[1];
    assert.equal(Number(moving.x1), leaf.start.x);
    assert.equal(Number(moving.x2), leaf.end.x);
    assert.equal(tags(svg, 'rect').filter(({ class: name }) => name === 'window-frame').length, type === 'window' ? 1 : 0);
  }
});

test('viewBox contains remote furniture, dimensions, background and complete door sweep', () => {
  const item = { id: 'remote', name: '원형', shape: 'ellipse', x: -1000, y: 900, width: 100, depth: 60, rotation: 45, height: 50 };
  const backgroundPlan = { dataUrl: 'data:image/png;base64,AAAA', x: -2000, y: -1000, width: 100, depth: 100, opacity: .5 };
  const svg = renderPlanSvg({ zones: [zone], items: [item], backgroundPlan, structures: [door], dimensions: [{ id: 'dim', name: '거리', x1: 2000, y1: -2000, x2: 2300, y2: -1600 }] });
  const [x, y, width, height] = tags(svg, 'svg')[0].viewBox.split(' ').map(Number);
  const box = itemBounds(item);
  assert.ok(x < -2000 && x < box.left && y < -2000);
  assert.ok(x + width > 2300 && y + height > box.bottom);
  assert.equal(tags(svg, 'ellipse')[0].rx, '50');
  assert.ok(tags(svg, 'g').some(({ transform }) => transform === 'translate(-1000 900) rotate(45)'));
  assert.equal(tags(svg, 'line').filter(({ class: name }) => name === 'dimension-tick').length, 2);
  assert.equal(tags(svg, 'image')[0].opacity, '0.5');
  assert.match(svg, />5m<\/text>/);
});

test('embedded image boundary rejects SVG and external resources; labels and IDs are escaped', () => {
  for (const dataUrl of ['https://example.com/a.png', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,AAAA" onload="alert(1)']) {
    assert.equal(tags(renderPlanSvg({ backgroundPlan: { dataUrl } }), 'image').length, 0);
  }
  const first = renderPlanSvg({ zones: [{ ...zone, name: '<script>x</script>', id: 'a" onload="x' }] }, { label: '<bad>', idPrefix: '" onload="x' });
  const second = renderPlanSvg({}, { idPrefix: '" onload="x' });
  assert.notEqual(tags(first, 'svg')[0].id, tags(second, 'svg')[0].id);
  assert.match(first, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(first, /<script| onload="/);
});
