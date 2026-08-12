import { relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const artifactRoot = resolve(repositoryRoot, '.omx/artifacts');

export function safeArtifactPath(value, fallback) {
  const output = resolve(value ?? fallback);
  const pathFromRoot = relative(artifactRoot, output);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || resolve(artifactRoot, pathFromRoot) !== output) {
    throw new Error(`Artifact output must be a child of ${artifactRoot}`);
  }
  return output;
}
