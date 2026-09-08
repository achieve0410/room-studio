export const CURRENT_SCHEMA_VERSION = 3;
export const MAX_LAYOUT_BYTES = 1_048_576;

const GEOMETRY_KEYS = ['zones', 'items', 'structures', 'dimensions', 'backgroundPlan', 'wallHeight'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isOption = (value) => value === 'A' || value === 'B';
const otherOption = (value) => value === 'A' ? 'B' : 'A';
const invalid = () => {
  const error = new TypeError('유효한 도면 또는 상담 데이터가 아닙니다.');
  error.code = 'INVALID_LAYOUT';
  return error;
};
const clone = (value) => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (cause) {
    throw new TypeError('유효한 도면 데이터가 아닙니다.', { cause });
  }
};
const boundedText = (value, maximum) => {
  if (typeof value !== 'string' || [...value].length > maximum) throw invalid();
  return value;
};

/** Geometry only: never copies document metadata or the inactive option. */
export function geometrySnapshot(layout) {
  if (!isObject(layout)
    || !Array.isArray(layout.zones) || !Array.isArray(layout.items) || !Array.isArray(layout.structures)
    || (layout.dimensions !== undefined && !Array.isArray(layout.dimensions))
    || (layout.backgroundPlan != null && !isObject(layout.backgroundPlan))
    || !Number.isFinite(Number(layout.wallHeight))) throw invalid();
  return clone({
    zones: layout.zones,
    items: layout.items,
    structures: layout.structures,
    dimensions: layout.dimensions ?? [],
    backgroundPlan: layout.backgroundPlan ?? null,
    wallHeight: Number(layout.wallHeight),
  });
}

function prepareConsultation(input) {
  if (!isObject(input) || input.version !== 1 || !isOption(input.activeOption)
    || (input.recommendedOption !== null && !isOption(input.recommendedOption))
    || !isObject(input.options)
    || Object.keys(input.options).some((key) => !isOption(key))) throw invalid();
  const options = {};
  for (const option of ['A', 'B']) {
    const notes = input.options[option];
    if (!isObject(notes)) throw invalid();
    options[option] = {
      label: boundedText(notes.label, 80),
      recommendation: boundedText(notes.recommendation, 4000),
      nextSteps: boundedText(notes.nextSteps, 4000),
    };
  }
  let inactiveGeometry = null;
  if (input.inactiveGeometry !== null) {
    if (!isObject(input.inactiveGeometry)
      || Object.keys(input.inactiveGeometry).some((key) => !GEOMETRY_KEYS.includes(key))) throw invalid();
    inactiveGeometry = geometrySnapshot(input.inactiveGeometry);
  } else if (input.activeOption !== 'A' || input.recommendedOption === 'B') {
    throw invalid();
  }
  return {
    version: 1,
    businessName: boundedText(input.businessName, 120),
    clientName: boundedText(input.clientName, 120),
    requirements: boundedText(input.requirements, 8000),
    activeOption: input.activeOption,
    recommendedOption: input.recommendedOption,
    options,
    inactiveGeometry,
  };
}

/** Editable defaults only; external file/cloud boundaries use strict preparation. */
export function normalizeConsultation(input = {}) {
  if (!isObject(input) || (input.options !== undefined && !isObject(input.options))) throw invalid();
  const options = {};
  for (const option of ['A', 'B']) {
    const notes = input.options?.[option];
    if (notes !== undefined && !isObject(notes)) throw invalid();
    options[option] = { label: `${option}안`, recommendation: '', nextSteps: '', ...notes };
  }
  return prepareConsultation({
    version: 1, businessName: '', clientName: '', requirements: '',
    activeOption: 'A', recommendedOption: null, inactiveGeometry: null,
    ...input,
    options,
  });
}

/** The shared portable/cloud whitelist; consultation is absent for legacy drawings. */
export function preparePersistedLayout(layout) {
  const snapshot = geometrySnapshot(layout);
  if (Object.hasOwn(layout, 'consultation')) snapshot.consultation = prepareConsultation(layout.consultation);
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_LAYOUT_BYTES) {
    const error = new RangeError('도면 파일이 너무 큽니다. 최대 크기는 1 MiB입니다.');
    error.code = 'FILE_TOO_LARGE';
    throw error;
  }
  return snapshot;
}

export function createComparisonOption(layout) {
  const snapshot = preparePersistedLayout(layout);
  const consultation = snapshot.consultation ?? normalizeConsultation();
  if (consultation.inactiveGeometry !== null) throw new Error('B안이 이미 있습니다.');
  snapshot.consultation = { ...consultation, inactiveGeometry: geometrySnapshot(snapshot) };
  return preparePersistedLayout(snapshot);
}

export function geometryForOption(layout, option) {
  if (!isOption(option)) throw invalid();
  const snapshot = preparePersistedLayout(layout);
  const active = snapshot.consultation?.activeOption ?? 'A';
  if (option === active) return geometrySnapshot(snapshot);
  if (!snapshot.consultation?.inactiveGeometry) throw new Error('B안을 먼저 만들어주세요.');
  return geometrySnapshot(snapshot.consultation.inactiveGeometry);
}

export function switchConsultationOption(layout, target) {
  if (!isOption(target)) throw invalid();
  const snapshot = preparePersistedLayout(layout);
  const active = snapshot.consultation?.activeOption ?? 'A';
  if (target === active) return snapshot;
  if (!snapshot.consultation?.inactiveGeometry) throw new Error('B안을 먼저 만들어주세요.');
  return {
    ...geometrySnapshot(snapshot.consultation.inactiveGeometry),
    consultation: {
      ...snapshot.consultation,
      activeOption: otherOption(active),
      inactiveGeometry: geometrySnapshot(snapshot),
    },
  };
}
