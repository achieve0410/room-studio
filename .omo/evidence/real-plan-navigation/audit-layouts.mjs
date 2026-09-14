import { DEMO_LAYOUTS, REGIONAL_DEMO_LAYOUTS } from '../../../src/demo-layouts.js';

export function selectAuditLayouts(regional, id) {
  const layouts = regional ? REGIONAL_DEMO_LAYOUTS : DEMO_LAYOUTS;
  if (id === undefined) return layouts;

  const layout = layouts.find((candidate) => candidate.id === id);
  if (!layout) {
    throw new RangeError(`Invalid REAL_PLAN_AUDIT_ID ${JSON.stringify(id)} for ${regional ? 'regional' : 'LH'} plans`);
  }
  return [layout];
}
