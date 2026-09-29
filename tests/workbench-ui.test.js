import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkbenchNavigation } from '../src/workbench-ui.js';

test('workspace navigation keeps mode state and distinct entry and return hooks', () => {
  const space = renderWorkbenchNavigation('Room', 'space');
  const studio = renderWorkbenchNavigation('Room', 'studio');
  assert.match(space, /id="open-walkthrough"/);
  assert.doesNotMatch(space, /data-walkthrough-exit/);
  assert.match(studio, /data-walkthrough-exit/);
  assert.doesNotMatch(studio, /id="open-walkthrough"/);
  assert.deepEqual([...space.matchAll(/aria-pressed="([^"]+)"/g)].map(match => match[1]), ['true', 'false']);
  assert.deepEqual([...studio.matchAll(/aria-pressed="([^"]+)"/g)].map(match => match[1]), ['false', 'true']);
});

test('project names cannot introduce markup or escape the shared heading attribute', () => {
  for (const mode of ['space', 'studio']) {
    const markup = renderWorkbenchNavigation('"><img src=x onerror=alert(1)>&', mode);
    assert.doesNotMatch(markup, /<img|title="">/);
    assert.match(markup, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;&amp;/);
  }
});
