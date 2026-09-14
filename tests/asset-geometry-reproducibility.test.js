import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOM_ASSETS } from '../src/asset-library.js';
import { createAssetGeometry } from '../scripts/build-room-assets-geometry.mjs';

// Actual Math.pow(x, 0.25) results from Node 22.23.2 and 24.14.1.
// These feed petiole-8 and bound-rug-edge's centripetal spline knot distances.
const cases = [
  ['seoul-plant', new Map([
    [0.0056978819147830454, [0.2747440912691671, 0.27474409126916705]],
  ])],
  ['seoul-rug', new Map([
    [1.907161, [1.175159563633807, 1.1751595636338072]],
    [3.8455209999999993, [1.4003570973148243, 1.400357097314824]],
    [0.00010023625462752694, [0.10005901140114692, 0.10005901140114691]],
  ])],
];

for (const [id, powers] of cases) test(`${id}: tube buffers are byte-identical across runtime quarter-power results`, (t) => {
  const nativePow = Math.pow;
  let runtime = 0;
  let calls = 0;
  t.mock.method(Math, 'pow', (base, exponent) => {
    if (exponent === 0.25 && powers.has(base)) {
      calls++;
      return powers.get(base)[runtime];
    }
    return nativePow(base, exponent);
  });
  const snapshots = [];
  for (runtime = 0; runtime < 2; runtime++) {
    calls = 0;
    const buffers = new Map();
    for (const { slot, geometry } of createAssetGeometry(ROOM_ASSETS.find((asset) => asset.id === id))) {
      for (const [name, attribute] of [...Object.entries(geometry.attributes), ['index', geometry.index]]) {
        const array = attribute.array;
        buffers.set(`${slot}/${name}`, Buffer.from(array.buffer, array.byteOffset, array.byteLength));
      }
      geometry.dispose();
    }
    assert.ok(calls > 0, 'exercise the differing spline knot calculation');
    snapshots.push(buffers);
  }
  assert.deepEqual([...snapshots[0].keys()], [...snapshots[1].keys()]);
  for (const [name, buffer] of snapshots[0]) {
    assert.ok(buffer.equals(snapshots[1].get(name)), `${id}/${name} differs between runtime pow results`);
  }
});
