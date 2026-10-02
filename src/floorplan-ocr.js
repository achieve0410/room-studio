// Tesseract confidence is a 0–100 score, not a probability. Missing units stay null.
const numericLabel = /^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:\s*(mm|cm|m))?$/i;
const unitLabel = /^(mm|cm|m)$/i;

function wordBounds(word) {
  const { x0, y0, x1, y1 } = word.bbox ?? {};
  if (![x0, y0, x1, y1].every(Number.isFinite) || x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function wordConfidence(word) {
  return Number.isFinite(word.confidence) ? Math.max(0, Math.min(100, word.confidence)) : 0;
}

// Browser-free parsing of v7's explicitly requested blocks output.
export function parseFloorplanDimensions(data) {
  const candidates = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const words = line.words ?? [];
        for (let i = 0; i < words.length; i += 1) {
          const word = words[i];
          const text = String(word.text ?? '').trim();
          const match = numericLabel.exec(text);
          const bounds = wordBounds(word);
          if (!match || !bounds) continue;
          const value = Number(match[1].replaceAll(',', ''));
          if (!Number.isFinite(value) || value <= 0) continue;
          let unit = match[2]?.toLowerCase() ?? null;
          let confidence = wordConfidence(word);
          let candidateText = text;
          const next = words[i + 1];
          const nextUnit = next && unitLabel.exec(String(next.text ?? '').trim());
          const nextBounds = nextUnit && wordBounds(next);
          // A separate unit belongs to this number only when immediately adjacent.
          if (!unit && nextBounds && nextBounds.x >= bounds.x + bounds.width
            && nextBounds.x - bounds.x - bounds.width <= Math.max(bounds.height, nextBounds.height)
            && Math.min(bounds.y + bounds.height, nextBounds.y + nextBounds.height) > Math.max(bounds.y, nextBounds.y)) {
            unit = nextUnit[1].toLowerCase();
            confidence = Math.min(confidence, wordConfidence(next));
            candidateText += ` ${String(next.text).trim()}`;
            const right = Math.max(bounds.x + bounds.width, nextBounds.x + nextBounds.width);
            const bottom = Math.max(bounds.y + bounds.height, nextBounds.y + nextBounds.height);
            bounds.y = Math.min(bounds.y, nextBounds.y);
            bounds.width = right - bounds.x;
            bounds.height = bottom - bounds.y;
            i += 1;
          }
          candidates.push({ text: candidateText, value, unit, bounds, confidence });
        }
      }
    }
  }
  return candidates;
}

async function imageBytes(image, signal) {
  if (typeof image?.toBlob === 'function') {
    image = await new Promise((resolve, reject) => {
      image.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Image encoding failed')), 'image/png');
    });
  } else if (typeof image?.convertToBlob === 'function') {
    image = await image.convertToBlob({ type: 'image/png' });
  } else if (image?.tagName === 'IMG') {
    image = image.currentSrc || image.src;
  }
  if (typeof image === 'string') {
    const url = new URL(image, location.href);
    if (!(url.protocol === 'data:' && url.href.startsWith('data:image/'))
      && !((url.protocol === 'blob:' || url.protocol === location.protocol) && url.origin === location.origin)) {
      throw new Error('OCR requires a local image');
    }
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Image loading failed (${response.status})`);
    image = await response.arrayBuffer();
  } else if (image instanceof Blob) {
    image = await image.arrayBuffer();
  }
  if (image instanceof ArrayBuffer) return new Uint8Array(image);
  if (image instanceof Uint8Array) return image;
  throw new TypeError('OCR requires an image, canvas, Blob, or image URL');
}

/**
 * Read optional dimension labels without assigning scale or guessing units.
 * Coordinates refer to the supplied image's intrinsic pixels; confidence is 0–100.
 * Progress receives Tesseract's {status, progress}; rejection leaves no owned worker.
 */
export async function readFloorplanDimensions(image, { signal, onProgress } = {}) {
  if (signal?.aborted) throw new DOMException('OCR cancelled', 'AbortError');
  let worker;
  let active = true;
  let serial = 0;
  const pending = new Map();
  let rejectStop;
  const stopped = new Promise((_, reject) => { rejectStop = reject; });
  const stop = (error) => {
    if (!active) return;
    active = false;
    worker?.terminate();
    worker = null;
    for (const job of pending.values()) job.reject(error);
    pending.clear();
    rejectStop(error);
  };
  const abort = () => stop(new DOMException('OCR cancelled', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });

  // Own the native v7 worker from creation: createWorker() only exposes it after
  // initialization and does not settle in-flight jobs on terminate().
  const operation = (async () => {
    const bytes = await imageBytes(image, signal);
    if (!active) throw new DOMException('OCR cancelled', 'AbortError');
    const base = new URL(`${import.meta.env.BASE_URL}ocr/`, location.href);
    worker = new Worker(new URL('worker.min.js', base));
    const job = (action, payload) => new Promise((resolve, reject) => {
      const jobId = `dimension-${serial++}`;
      pending.set(jobId, { resolve, reject });
      worker.postMessage({ workerId: 'floorplan', jobId, action, payload });
    });
    worker.onmessage = ({ data }) => {
      if (!active) return;
      if (data.status === 'progress') {
        try {
          onProgress?.({ status: data.data.status, progress: data.data.progress });
        } catch (error) {
          stop(error);
        }
        return;
      }
      const current = pending.get(data.jobId);
      if (!current) return;
      pending.delete(data.jobId);
      if (data.status === 'reject') current.reject(new Error(String(data.data)));
      else current.resolve(data.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      stop(new Error(event.message || 'OCR worker loading failed'));
    };
    worker.onmessageerror = () => stop(new Error('OCR worker message failed'));
    await job('load', { options: { lstmOnly: true, corePath: new URL('core/', base).href, logging: false } });
    await job('loadLanguage', { langs: 'eng', options: {
      langPath: new URL('lang', base).href, gzip: true, lstmOnly: true, cacheMethod: 'none',
    } });
    await job('initialize', { langs: 'eng', oem: 1, config: {} });
    const data = await job('recognize', {
      image: bytes,
      options: { tessedit_pageseg_mode: '11' },
      output: { text: true, blocks: true },
    });
    return parseFloorplanDimensions(data);
  })();
  try {
    return await Promise.race([operation, stopped]);
  } finally {
    active = false;
    signal?.removeEventListener('abort', abort);
    worker?.terminate();
    worker = null;
    pending.clear();
  }
}
