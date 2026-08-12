import { GRID_CM, snap } from './geometry.js';

const HIT_PRIORITY = {
  control: 0,
  opening: 1,
  structure: 1,
  item: 2,
  zone: 3,
};

export function snapPendingPlacement(pending, point, grid = GRID_CM) {
  return {
    ...pending,
    x: snap(point.x, grid),
    y: snap(point.y, grid),
  };
}

export function rankHitCandidates(candidates) {
  const unique = [];
  const seen = new Set();

  candidates.forEach((candidate) => {
    const key = `${candidate.kind}:${candidate.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(candidate);
  });

  unique.sort((first, second) => (
    (HIT_PRIORITY[first.kind] ?? Number.MAX_SAFE_INTEGER)
    - (HIT_PRIORITY[second.kind] ?? Number.MAX_SAFE_INTEGER)
  ));
  const foreground = unique.filter((candidate) => candidate.kind !== 'zone');
  return foreground.length ? foreground : unique;
}

export function createNumericEditTransaction(original) {
  let preview = { ...original };
  let committed = null;
  let finished = false;

  return {
    preview(changes) {
      if (finished) throw new Error('Numeric edit transaction is already finished');
      Object.values(changes).forEach((value) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new TypeError('Numeric edit values must be finite numbers');
        }
      });
      preview = { ...preview, ...changes };
      return preview;
    },
    commit() {
      if (!committed) committed = preview;
      finished = true;
      return committed;
    },
    cancel() {
      finished = true;
      return original;
    },
  };
}
