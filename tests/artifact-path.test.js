import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { safeArtifactPath } from '../.omo/evidence/real-plan-navigation/artifact-path.mjs';

test('restricts browser evidence cleanup to artifact children', () => {
  const artifactRoot = resolve('.omx/artifacts');
  assert.equal(
    safeArtifactPath('.omx/artifacts/real-plan-navigation', '.omx/artifacts/fallback'),
    resolve(artifactRoot, 'real-plan-navigation'),
  );
  assert.throws(() => safeArtifactPath('.', '.omx/artifacts/fallback'), /must be a child/);
  assert.throws(() => safeArtifactPath('.omx/artifacts', '.omx/artifacts/fallback'), /must be a child/);
  assert.throws(() => safeArtifactPath('/tmp/room-studio-evidence', '.omx/artifacts/fallback'), /must be a child/);
  assert.throws(() => safeArtifactPath('.omx/artifacts/../escape', '.omx/artifacts/fallback'), /must be a child/);
});
