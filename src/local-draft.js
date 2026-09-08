import { normalizeProjectName } from './cloud-store.js';
import { preparePersistedLayout } from './consultation.js';

const ACTIVE_KEY = 'room-studio-layout-v2';
const RECOVERY_KEY = 'room-studio-recovery-v1';

function normalizeMetadata(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !(value.ownerId === null || typeof value.ownerId === 'string')
    || !(value.projectId === null || typeof value.projectId === 'string')
    || !(value.baseRevision === null || Number.isInteger(value.baseRevision))
    || typeof value.dirty !== 'boolean'
  ) {
    throw new TypeError('Invalid local draft metadata.');
  }
  return {
    projectName: normalizeProjectName(value.projectName),
    ownerId: value.ownerId,
    projectId: value.projectId,
    baseRevision: value.baseRevision,
    dirty: value.dirty,
  };
}

function prepareDocument({
  projectName,
  layout,
  ownerId = null,
  projectId = null,
  baseRevision = null,
  dirty = true,
}) {
  const metadata = normalizeMetadata({
    projectName, ownerId, projectId, baseRevision, dirty,
  });
  return {
    ...metadata,
    layout: preparePersistedLayout(layout),
  };
}

function decodeDocument(value) {
  if (
    !value
    || typeof value !== 'object'
    || !Array.isArray(value.zones)
    || !Array.isArray(value.items)
  ) {
    throw new TypeError('Invalid local draft layout.');
  }

  let metadata;
  if (Object.hasOwn(value, 'draftMetadata')) {
    if (value.draftMetadata?.version !== 1) {
      throw new TypeError('Unsupported local draft metadata version.');
    }
    metadata = normalizeMetadata(value.draftMetadata);
  } else {
    metadata = normalizeMetadata({
      projectName: undefined,
      ownerId: null,
      projectId: null,
      baseRevision: null,
      dirty: true,
    });
  }

  return {
    ...metadata,
    layout: preparePersistedLayout({
      ...value,
      structures: value.structures ?? [],
      dimensions: value.dimensions ?? [],
      backgroundPlan: value.backgroundPlan ?? null,
      wallHeight: value.wallHeight ?? 240,
    }),
  };
}

/**
 * Documents contain projectName, layout, ownerId, projectId, baseRevision
 * and dirty. Only disk values wrap metadata in draftMetadata.
 * Authentication and ownership decisions belong to the caller.
 */
export function createLocalDraftStore(getStorage) {
  function readRaw(key) {
    try {
      return { ok: true, draft: null, raw: getStorage().getItem(key) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  function readDocument(key) {
    const result = readRaw(key);
    if (!result.ok || result.raw === null) return result;
    try {
      return {
        ok: true,
        draft: decodeDocument(JSON.parse(result.raw)),
        raw: result.raw,
      };
    } catch (error) {
      return { ok: false, error, raw: result.raw };
    }
  }

  function writeDocument(key, input) {
    try {
      const draft = prepareDocument(input);
      const { layout, ...metadata } = draft;
      const raw = JSON.stringify({
        ...layout,
        draftMetadata: { version: 1, ...metadata },
      });
      getStorage().setItem(key, raw);
      return { ok: true, draft };
    } catch (error) {
      return { ok: false, error };
    }
  }

  function remove(key) {
    try {
      getStorage().removeItem(key);
      return { ok: true, draft: null };
    } catch (error) {
      return { ok: false, error };
    }
  }

  return {
    read: () => readDocument(ACTIVE_KEY),
    readRecovery: () => readDocument(RECOVERY_KEY),
    write: (document) => writeDocument(ACTIVE_KEY, document),
    protect: (document) => writeDocument(RECOVERY_KEY, document),
    clear: () => remove(ACTIVE_KEY),
    clearRecovery: () => remove(RECOVERY_KEY),
    readLegacy: (key) => readRaw(key),
    removeLegacy: (key) => remove(key),
  };
}
