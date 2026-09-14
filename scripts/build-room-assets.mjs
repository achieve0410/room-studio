import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { Color } from 'three';
import { ROOM_ASSETS, ROOM_MATERIALS, LEGACY_ASSET_COMPATIBILITY } from '../src/asset-library.js';
import { createAssetGeometry, SLOT_DEFINITIONS } from './build-room-assets-geometry.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'public/assets/room-studio');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
const pad = (buffer, fill = 0) => Buffer.concat([buffer, Buffer.alloc((4 - buffer.length % 4) % 4, fill)]);

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width, height, pixels) {
  const chunk = (kind, data) => {
    const type = Buffer.from(kind);
    const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([header, type, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) Buffer.from(pixels.subarray(y * width * 3, (y + 1) * width * 3)).copy(rows, y * (width * 3 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function texturePixels(kind, size = 256) {
  const height = new Float64Array(size * size);
  const color = new Uint8Array(size * size * 3);
  const roughness = new Uint8Array(size * size * 3);
  const normal = new Uint8Array(size * size * 3);
  const tau = Math.PI * 2;
  // Periodic functions make all texture edges tile seamlessly; no image or sampled source.
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, index = y * size + x;
    const noise = (Math.sin(tau * (u * 37 + v * 23)) + Math.sin(tau * (u * 59 - v * 41)) + Math.cos(tau * (u * 97 + v * 73))) / 3;
    let h, c, r;
    if (kind === 'wood' || kind === 'oak') {
      const warp = 0.7 * Math.sin(v * tau) + 0.23 * Math.sin(v * tau * 3 + u * tau * 2);
      const grain = Math.sin(tau * (u * 43) + warp * 3) * 0.5 + Math.sin(tau * u * 89 + warp * 4) * 0.22;
      const broad = Math.sin(tau * u * 7 + Math.sin(tau * v) * 0.8);
      h = 0.006 * grain + 0.002 * noise;
      c = 237 + grain * 10 + broad * 6 + noise * 2;
      r = 214 + grain * 12;
      if (kind === 'oak') {
        const row = Math.floor(x / 32);
        const seam = x % 32 < 1 || (y + (row % 2) * 128) % 256 < 1;
        if (seam) { h = -0.3; c = 171; r = 231; }
        else c += Math.sin(row * 9) * 6;
      }
    } else if (kind === 'fabric') {
      const warp = Math.cos(u * tau * 64), weft = Math.cos(v * tau * 64);
      const over = Math.sin(u * tau * 32) * Math.sin(v * tau * 32);
      h = (warp + weft) * 0.045 + over * 0.025;
      c = 235 + warp * 5 + weft * 5 + over * 6 + noise * 2;
      r = 241 + noise * 8;
    } else if (kind === 'tile') {
      const seam = x % 128 < 2 || y % 128 < 2;
      h = seam ? -0.35 : noise * 0.025;
      c = seam ? 191 : 240 + noise * 5 + Math.sin(u * tau * 3 + v * tau * 5) * 3;
      r = seam ? 252 : 217 + noise * 10;
    } else {
      h = noise * 0.04 + Math.sin(u * tau * 7 + v * tau * 11) * 0.014;
      c = 244 + noise * 7;
      r = 244 + noise * 7;
    }
    height[index] = h;
    for (let channel = 0; channel < 3; channel++) { color[index * 3 + channel] = clamp(c); roughness[index * 3 + channel] = clamp(r); }
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sample = (dx, dy) => height[((y + dy + size) % size) * size + (x + dx + size) % size];
    const nx = (sample(-1, 0) - sample(1, 0)) * 2.6;
    const ny = (sample(0, -1) - sample(0, 1)) * 2.6;
    const length = Math.hypot(nx, ny, 1), i = (y * size + x) * 3;
    normal[i] = clamp((nx / length * 0.5 + 0.5) * 255);
    normal[i + 1] = clamp((ny / length * 0.5 + 0.5) * 255);
    normal[i + 2] = clamp((1 / length * 0.5 + 0.5) * 255);
  }
  return { color: png(size, size, color), normal: png(size, size, normal), roughness: png(size, size, roughness) };
}

function encodeGLB(asset, parts) {
  const gltf = {
    asset: { version: '2.0', generator: 'Room Studio original Seoul furniture generator v1', copyright: 'Room Studio contributors; Apache-2.0' },
    scene: 0, scenes: [{ name: asset.name, nodes: [] }], nodes: [], meshes: [],
    accessors: [], bufferViews: [], buffers: [], materials: [], textures: [], images: [],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    extras: { id: asset.id, units: 'm', origin: 'bottom-center', front: '+Z', dimensions: asset.dimensions, source: 'scripts/build-room-assets-geometry.mjs' },
  };
  const binary = [];
  let byteOffset = 0;
  const accessor = (array, itemSize, target, bounds) => {
    const data = pad(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
    const view = gltf.bufferViews.push({ buffer: 0, byteOffset, byteLength: array.byteLength, target }) - 1;
    byteOffset += data.length; binary.push(data);
    return gltf.accessors.push({ bufferView: view, componentType: array instanceof Float32Array ? 5126 : array instanceof Uint32Array ? 5125 : 5123, count: array.length / itemSize, type: itemSize === 1 ? 'SCALAR' : `VEC${itemSize}`, ...bounds }) - 1;
  };
  const textures = new Map();
  const texture = (name, type) => {
    const key = `${name}-${type}`;
    if (!textures.has(key)) {
      const source = gltf.images.push({ uri: `../textures/${key}.png`, mimeType: 'image/png' }) - 1;
      textures.set(key, gltf.textures.push({ sampler: 0, source }) - 1);
    }
    return { index: textures.get(key) };
  };
  const color = (hex) => new Color(hex).toArray();
  for (const { slot, geometry, components } of parts) {
    const definition = SLOT_DEFINITIONS[slot];
    const pbr = { baseColorFactor: [...color(definition.color), 1], metallicFactor: definition.metalness ?? 0, roughnessFactor: definition.roughness };
    if (definition.texture) {
      pbr.baseColorTexture = texture(definition.texture, 'color');
      pbr.metallicRoughnessTexture = texture(definition.texture, 'roughness');
    }
    const material = gltf.materials.push({
      name: slot, extras: { slot }, pbrMetallicRoughness: pbr,
      doubleSided: definition.doubleSided || ['fabric', 'linen', 'light'].includes(slot),
      ...(definition.texture ? { normalTexture: { ...texture(definition.texture, 'normal'), scale: 0.3 } } : {}),
      ...(definition.emissive ? { emissiveFactor: color(definition.emissive) } : {}),
    }) - 1;
    const bounds = geometry.boundingBox;
    const attributes = {
      POSITION: accessor(geometry.attributes.position.array, 3, 34962, { min: bounds.min.toArray(), max: bounds.max.toArray() }),
      NORMAL: accessor(geometry.attributes.normal.array, 3, 34962),
      TEXCOORD_0: accessor(geometry.attributes.uv.array, 2, 34962),
    };
    const indices = accessor(geometry.index.array, 1, 34963);
    const mesh = gltf.meshes.push({ name: `${asset.id}-${slot}`, primitives: [{ attributes, indices, material, mode: 4 }], extras: { components } }) - 1;
    gltf.scenes[0].nodes.push(gltf.nodes.push({ name: `${asset.id}-${slot}`, mesh }) - 1);
  }
  gltf.buffers.push({ byteLength: byteOffset });
  const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20), bin = Buffer.concat(binary);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + json.length + bin.length, 8);
  const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(json.length); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(bin.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, json, binHeader, bin]);
}

export async function generateAssets() {
  await Promise.all(['models', 'textures', 'thumbnails'].map((directory) => mkdir(join(output, directory), { recursive: true })));
  const textures = [];
  for (const name of ['wood', 'fabric', 'oak', 'tile', 'plaster']) {
    for (const [kind, buffer] of Object.entries(texturePixels(name))) {
      const path = `textures/${name}-${kind}.png`;
      await writeFile(join(output, path), buffer);
      textures.push({ path, bytes: buffer.length, sha256: hash(buffer), width: 256, height: 256, kind, colorSpace: kind === 'color' ? 'sRGB' : 'linear', method: `Periodic deterministic ${name} field; seed-free analytic generation` });
    }
  }
  const models = [];
  for (const asset of ROOM_ASSETS) {
    const parts = createAssetGeometry(asset);
    const buffer = encodeGLB(asset, parts);
    await writeFile(join(output, asset.modelPath), buffer);
    models.push({ ...asset, bytes: buffer.length, sha256: hash(buffer), triangles: parts.reduce((sum, part) => sum + part.geometry.index.count / 3, 0), drawCalls: parts.length, components: parts.reduce((sum, part) => sum + part.components.length, 0) });
    parts.forEach((part) => part.geometry.dispose());
  }
  const sources = [];
  for (const path of ['scripts/build-room-assets.mjs', 'scripts/build-room-assets-geometry.mjs', 'scripts/build-room-assets-render.mjs', 'src/asset-library.js', 'src/asset-library-loader.js', 'src/asset-library-preview.js']) sources.push({ path, sha256: hash(await readFile(join(root, path))) });
  const provenance = {
    version: 1, author: 'Room Studio contributors', license: 'Apache-2.0',
    attribution: 'Original Room Studio Seoul collection. No vendor affiliation or replica claim.',
    externalAssets: [], externalImages: [], aiGeneratedImages: false,
    method: 'Original code-authored rounded joinery, superellipsoid upholstery, quilt drapes, bentwood shells, turned profiles, pleated shades, and curved botanical surfaces. Analytic tileable PBR textures. No external downloads.',
    sourceLicense: 'LICENSE.txt', sources,
    generatorDependencies: [{ name: 'three', version: '0.185.1', license: 'MIT', use: 'Geometry algorithms; no third-party model or image content' }],
    units: 'meters', origin: 'bottom-center', axes: { up: '+Y', front: '+Z' },
    textures, models: models.map(({ id, modelPath, bytes, sha256, triangles }) => ({ id, path: modelPath, bytes, sha256, triangles })),
    thumbnailMethod: 'Real WebGL renders of shipped GLB models, generated with --render; not a substitute for geometry. Rendered thumbnails may differ slightly between GPU/Chrome versions.',
  };
  const manifest = { version: 1, pack: 'room-studio-seoul-v1', units: 'm', origin: 'bottom-center', license: 'Apache-2.0', assets: models, materials: ROOM_MATERIALS, compatibility: LEGACY_ASSET_COMPATIBILITY, textures, totals: { modelBytes: models.reduce((sum, entry) => sum + entry.bytes, 0), textureBytes: textures.reduce((sum, entry) => sum + entry.bytes, 0), triangles: models.reduce((sum, entry) => sum + entry.triangles, 0) } };
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(output, 'PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  await writeFile(join(output, 'LICENSE.txt'), await readFile(join(root, 'LICENSE')));
  await writeFile(join(output, 'THREE-LICENSE.txt'), await readFile(join(root, 'node_modules/three/LICENSE')));
  console.log(JSON.stringify(manifest.totals));
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateAssets();
  if (process.argv.includes('--render')) {
    const { renderAssets } = await import('./build-room-assets-render.mjs');
    await renderAssets({ thumbnails: true });
  }
}
