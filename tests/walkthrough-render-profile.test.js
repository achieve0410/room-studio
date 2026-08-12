import assert from 'node:assert/strict';
import test from 'node:test';
import { walkthroughRendererProfile } from '../src/walkthrough3d.js';

test('QA traversal reduces render cost without changing the normal profile', () => {
  globalThis.window = { devicePixelRatio: 2 };
  try {
    assert.deepEqual(walkthroughRendererProfile(false), {
      antialias: true,
      pixelRatio: 2,
      shadows: true,
    });
    assert.deepEqual(walkthroughRendererProfile(true), {
      antialias: false,
      pixelRatio: 0.5,
      shadows: false,
    });
  } finally {
    delete globalThis.window;
  }
});
