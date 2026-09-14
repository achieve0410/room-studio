import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { selectAuditLayouts } from '../.omo/evidence/real-plan-navigation/audit-layouts.mjs';
import { DEMO_LAYOUTS, REGIONAL_DEMO_LAYOUTS } from '../src/demo-layouts.js';

const root = resolve(import.meta.dirname, '..');
const suites = [
  { regional: false, layouts: DEMO_LAYOUTS, otherLayouts: REGIONAL_DEMO_LAYOUTS },
  { regional: true, layouts: REGIONAL_DEMO_LAYOUTS, otherLayouts: DEMO_LAYOUTS },
];

for (const { regional, layouts, otherLayouts } of suites) {
  test(`regional=${regional}: omitted ID preserves the entire canonical suite and order`, () => {
    assert.equal(selectAuditLayouts(regional), layouts);
    assert.equal(selectAuditLayouts(regional, undefined), layouts);
    assert.equal(selectAuditLayouts(regional)[0], layouts[0]);
  });

  for (const layout of layouts) {
    test(`selects only the canonical ${layout.id} without changing fixture data`, () => {
      const before = structuredClone(layout);
      const selected = selectAuditLayouts(regional, layout.id);
      assert.equal(selected.length, 1);
      assert.equal(selected[0], layout);
      assert.deepEqual(selected[0], before);
      assert.equal(selectAuditLayouts(regional), layouts);
    });
  }

  test(`regional=${regional}: rejects unknown, empty, malformed, and wrong-suite IDs`, () => {
    const invalidIds = [
      '', ' ', 'unknown-plan', '*', layouts[0].id.toUpperCase(),
      ` ${layouts[0].id}`, `${layouts[0].id} `,
      layouts.map(({ id }) => id).join(','),
      ...otherLayouts.map(({ id }) => id),
    ];
    for (const id of invalidIds) {
      assert.throws(() => selectAuditLayouts(regional, id), RangeError, id);
    }
  });
}

for (const script of ['browser-qa.mjs', 'door-visibility-qa.mjs', 'responsive-qa.mjs']) {
  test(`${script}: rejects invalid selection before profile, artifact, or browser side effects`, () => {
    const scriptUrl = pathToFileURL(resolve(root, '.omo/evidence/real-plan-navigation', script)).href;
    // The actual entry point runs read-only with child processes forbidden. Any
    // profile/artifact mutation or Chrome launch before validation fails this test.
    const entry = `
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)},
        'http://127.0.0.1:4173/', '.omx/artifacts/real-plan-audit-layouts-test'];
      try {
        await import(${JSON.stringify(scriptUrl)});
      } catch (error) {
        console.log(JSON.stringify({ name: error.name, code: error.code ?? null }));
        console.error(error);
        process.exitCode = 1;
      }
    `;
    for (const regional of [undefined, '0', '1', 'true', '01']) {
      const wrongLayouts = regional === '1' ? DEMO_LAYOUTS : REGIONAL_DEMO_LAYOUTS;
      for (const id of ['', 'unknown-plan', ...wrongLayouts.map((layout) => layout.id)]) {
        const env = { ...process.env, REAL_PLAN_AUDIT_ID: id, CHROME_BIN: process.execPath };
        if (regional === undefined) delete env.REGIONAL_PLANS;
        else env.REGIONAL_PLANS = regional;
        const result = spawnSync(process.execPath, [
          '--permission', '--allow-fs-read=*', '--input-type=module', '--eval', entry,
        ], { cwd: root, env, encoding: 'utf8', timeout: 5_000 });
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, 1, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { name: 'RangeError', code: null }, result.stderr);
      }
    }
  });
}
