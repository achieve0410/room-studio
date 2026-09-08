import { CURRENT_SCHEMA_VERSION, MAX_LAYOUT_BYTES, preparePersistedLayout } from './consultation.js';

export { CURRENT_SCHEMA_VERSION } from './consultation.js';

const PROJECT_FORMAT = 'room-studio';
const PROJECT_FORMAT_VERSION = 1;

export const MAX_PROJECT_FILE_BYTES = MAX_LAYOUT_BYTES;

export class ProjectFileError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ProjectFileError';
    this.code = code;
  }
}

const byteLength = (value) => new TextEncoder().encode(value).byteLength;

const normalizeProjectName = (value) => {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  return name.slice(0, 80) || '내 집 도면';
};

function persistedLayout(layout) {
  try {
    return preparePersistedLayout(layout);
  } catch (error) {
    if (error.code === 'FILE_TOO_LARGE') throw new ProjectFileError(error.code, error.message, { cause: error });
    throw new ProjectFileError('INVALID_LAYOUT', '유효한 도면 데이터가 아닙니다.', { cause: error });
  }
}

export function serializeProjectFile({ projectName, layout }) {
  const serialized = JSON.stringify({
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projectName: normalizeProjectName(projectName),
    layout: persistedLayout(layout),
  }, null, 2);

  if (byteLength(serialized) > MAX_PROJECT_FILE_BYTES) {
    throw new ProjectFileError('FILE_TOO_LARGE', '도면 파일이 너무 큽니다. 배경 이미지를 제거하거나 줄여주세요.');
  }
  return serialized;
}

export function parseProjectFile(source) {
  if (typeof source !== 'string') {
    throw new ProjectFileError('INVALID_FILE', 'Room Studio 도면 파일을 읽을 수 없습니다.');
  }
  if (byteLength(source) > MAX_PROJECT_FILE_BYTES) {
    throw new ProjectFileError('FILE_TOO_LARGE', '도면 파일이 너무 큽니다. 최대 크기는 1 MiB입니다.');
  }

  let envelope;
  try {
    envelope = JSON.parse(source);
  } catch (error) {
    throw new ProjectFileError('INVALID_FILE', 'Room Studio 도면 파일의 JSON 형식이 올바르지 않습니다.', { cause: error });
  }

  if (!envelope || typeof envelope !== 'object' || envelope.format !== PROJECT_FORMAT) {
    throw new ProjectFileError('INVALID_FILE', 'Room Studio 도면 파일이 아닙니다.');
  }
  if (envelope.formatVersion !== PROJECT_FORMAT_VERSION) {
    throw new ProjectFileError('UNSUPPORTED_VERSION', '지원하지 않는 파일 버전입니다.');
  }
  if (![1, 2, CURRENT_SCHEMA_VERSION].includes(envelope.schemaVersion)) {
    throw new ProjectFileError('UNSUPPORTED_SCHEMA', '지원하지 않는 도면 스키마입니다.');
  }

  return {
    projectName: normalizeProjectName(envelope.projectName),
    schemaVersion: envelope.schemaVersion,
    layout: persistedLayout(envelope.layout),
  };
}

export function projectFileName(projectName) {
  const slug = normalizeProjectName(projectName)
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `room-studio-${slug || 'project'}.roomstudio.json`;
}
