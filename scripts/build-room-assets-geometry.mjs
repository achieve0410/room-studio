// Original static furniture designs, expressed in meters. No external model source.
import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const SLOT_DEFINITIONS = {
  wood: { color: '#c8a777', roughness: 0.63, texture: 'wood' },
  fabric: { color: '#c4b8a4', roughness: 0.96, texture: 'fabric' },
  primary: { color: '#d0b79b', roughness: 0.78, texture: 'plaster' },
  piping: { color: '#aea28c', roughness: 1, texture: 'fabric' },
  accent: { color: '#8d745d', roughness: 0.98, texture: 'fabric' },
  linen: { color: '#f1eade', roughness: 1, texture: 'fabric' },
  metal: { color: '#514839', roughness: 0.32, metalness: 0.72 },
  foliage: { color: '#42674b', roughness: 0.7, doubleSided: true },
  stem: { color: '#6a6540', roughness: 0.92 },
  soil: { color: '#30281c', roughness: 1, texture: 'plaster' },
  light: { color: '#fff4d1', roughness: 0.85, emissive: '#e9be73' },
};

function add(group, name, geometry, slot, position = [0, 0, 0], rotation = [0, 0, 0]) {
  const mesh = new T.Mesh(geometry);
  mesh.name = name;
  mesh.userData.slot = slot;
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  group.add(mesh);
  return mesh;
}

function box(group, name, size, position, slot = 'wood', radius = 0.012, rotation) {
  return add(group, name, new RoundedBoxGeometry(...size, 2, Math.min(radius, ...size.map((v) => v / 2))), slot, position, rotation);
}

function lathe(group, name, profile, position, slot = 'wood', segments = 48) {
  return add(group, name, new T.LatheGeometry(profile.map(([r, y]) => new T.Vector2(r, y)), segments), slot, position);
}

function rod(group, name, start, end, bottom = 0.024, top = bottom, slot = 'wood', segments = 16) {
  const a = new T.Vector3(...start);
  const b = new T.Vector3(...end);
  const delta = b.clone().sub(a);
  const mesh = add(group, name, new T.CylinderGeometry(top, bottom, delta.length(), segments), slot, a.add(b).multiplyScalar(0.5).toArray());
  mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), delta.normalize());
  return mesh;
}

function tube(group, name, points, radius, slot, closed = false, segments = 36) {
  const path = new T.CatmullRomCurve3(points.map((point) => new T.Vector3(...point)), closed);
  const getPoint = path.getPoint.bind(path);
  path.getPoint = (t, target) => {
    const point = getPoint(t, target);
    // Picometer samples prevent runtime Math.pow last bits from being amplified by
    // tangent/Frenet calculations, without quantizing the final Float32 geometry.
    for (const axis of ['x', 'y', 'z']) point[axis] = Math.round(point[axis] * 1e12) / 1e12;
    return point;
  };
  return add(group, name, new T.TubeGeometry(path, segments, radius, 6, closed), slot);
}

function roundPath(width, depth, radius, y, centerZ = 0) {
  const points = [];
  for (let corner = 0; corner < 4; corner++) {
    const angle = corner * Math.PI / 2;
    const cx = (corner === 0 || corner === 3 ? 1 : -1) * (width / 2 - radius);
    const cz = (corner < 2 ? 1 : -1) * (depth / 2 - radius);
    for (let j = 0; j <= 5; j++) {
      const a = angle + j * Math.PI / 10;
      points.push([cx + Math.cos(a) * radius, y, centerZ + cz + Math.sin(a) * radius]);
    }
  }
  return points;
}

function cushion(group, name, size, position, slot = 'fabric', rotation = [0, 0, 0]) {
  // Superellipsoid upholstery: genuinely bowed broad faces rather than flat rounded boxes.
  const geometry = new T.SphereGeometry(1, 32, 16);
  const p = geometry.attributes.position;
  const power = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    p.setXYZ(i, power(x, 0.28) * size[0] / 2, power(y, 0.38) * size[1] / 2, power(z, 0.28) * size[2] / 2);
  }
  geometry.computeVertexNormals();
  return add(group, name, geometry, slot, position, rotation);
}

function ovalTop(group, name, width, depth, thickness, y, slot = 'wood') {
  const shape = new T.Shape();
  shape.absellipse(0, 0, width / 2 - 0.012, depth / 2 - 0.012, 0, Math.PI * 2, false, 0);
  const geometry = new T.ExtrudeGeometry(shape, { depth: thickness - 0.016, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.008, bevelSegments: 3, steps: 1, curveSegments: 40 });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, y - thickness / 2 + 0.008, 0);
  return add(group, name, geometry, slot);
}

function legs(group, width, depth, y, slot = 'wood', foot = 0.022, shoulder = 0.035) {
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    rod(group, `tapered-leg-${x}-${z}`, [x * width / 2, 0.015, z * depth / 2], [x * width * 0.44, y, z * depth * 0.42], foot, shoulder, slot);
    if (slot === 'wood') rod(group, `foot-cap-${x}-${z}`, [x * width / 2, 0, z * depth / 2], [x * width / 2, 0.018, z * depth / 2], foot, foot, 'metal');
  }
}

function sofa(g) {
  box(g, 'floating-oak-plinth', [2.04, 0.085, 0.79], [0, 0.13, 0.015], 'wood', 0.025);
  for (const x of [-0.91, 0.91]) for (const z of [-0.31, 0.31]) rod(g, 'recessed-oak-foot', [x, 0, z], [x, 0.1, z], 0.028, 0.033);
  cushion(g, 'upholstered-base', [2.11, 0.21, 0.85], [0, 0.255, 0]);
  cushion(g, 'soft-back-shell', [2.02, 0.58, 0.21], [0, 0.535, -0.34], 'fabric', [-0.07, 0, 0]);
  for (const side of [-1, 1]) {
    cushion(g, `rounded-arm-${side}`, [0.215, 0.39, 0.87], [side * 0.985, 0.39, 0.01]);
    cushion(g, `seat-cushion-${side}`, [0.85, 0.17, 0.68], [side * 0.445, 0.407, 0.065]);
    const piping = roundPath(0.817, 0.643, 0.09, 0.433, 0.065).map(([x, y, z]) => [x + side * 0.445, y, z]);
    tube(g, `seat-welt-${side}`, piping, 0.0028, 'piping', true, 48);
    cushion(g, `back-cushion-${side}`, [0.84, 0.38, 0.16], [side * 0.435, 0.624, -0.19], 'fabric', [-0.14, 0, 0]);
  }
  cushion(g, 'linen-throw-pillow', [0.35, 0.35, 0.105], [-0.67, 0.62, -0.03], 'accent', [-0.16, 0.12, -0.18]);
  cushion(g, 'oat-lumbar-pillow', [0.34, 0.23, 0.105], [0.7, 0.565, 0], 'piping', [-0.2, -0.2, 0.15]);
}

function bed(g) {
  box(g, 'recessed-bed-plinth', [1.41, 0.12, 1.86], [0, 0.06, 0.04], 'wood', 0.025);
  box(g, 'oak-platform', [1.6, 0.16, 2.11], [0, 0.2, 0.02], 'wood', 0.035);
  box(g, 'upholstered-headboard', [1.59, 0.83, 0.095], [0, 0.605, -1.025], 'wood', 0.04);
  for (let i = 0; i < 8; i++) cushion(g, `headboard-channel-${i}`, [0.181, 0.66, 0.09], [-0.671 + i * 0.192, 0.685, -0.961]);
  cushion(g, 'fitted-mattress', [1.48, 0.25, 1.96], [0, 0.387, 0.015], 'linen');
  tube(g, 'mattress-piping', roundPath(1.453, 1.932, 0.105, 0.431, 0.015), 0.003, 'piping', true, 64);
  // A draped quilt with deterministic soft folds and real dropped sides.
  const positions = [], uvs = [], indices = [];
  const nx = 40, nz = 32;
  for (let iz = 0; iz <= nz; iz++) for (let ix = 0; ix <= nx; ix++) {
    const u = ix / nx, v = iz / nz;
    const x = (u - 0.5) * 1.59;
    const z = -0.25 + v * 1.31;
    const drop = Math.pow(Math.max(0, (Math.abs(x) - 0.73) / 0.065), 1.5) * 0.22 + Math.pow(Math.max(0, (z - 0.99) / 0.07), 1.6) * 0.18;
    const y = 0.548 - drop + 0.007 * Math.sin(x * 33 + z * 9) + 0.004 * Math.sin(z * 40 + x * 7);
    positions.push(x, y, z); uvs.push(u * 3.2, v * 2.6);
    if (ix < nx && iz < nz) { const a = iz * (nx + 1) + ix; indices.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2); }
  }
  const quilt = new T.BufferGeometry();
  quilt.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  quilt.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2)); quilt.setIndex(indices); quilt.computeVertexNormals();
  add(g, 'draped-quilt', quilt, 'fabric');
  cushion(g, 'folded-quilt-edge', [1.44, 0.045, 0.2], [0, 0.555, -0.21], 'piping');
  for (const side of [-1, 1]) {
    cushion(g, `sleep-pillow-${side}`, [0.62, 0.13, 0.4], [side * 0.37, 0.57, -0.625], 'linen', [0.08, side * 0.055, 0]);
    cushion(g, `small-pillow-${side}`, [0.35, 0.1, 0.31], [side * 0.375, 0.644, -0.6], 'linen', [0.1, side * 0.1, side * 0.025]);
  }
}

function diningTable(g) {
  // A broad corner radius independent of slab thickness, with an actual under-bevel.
  const topShape = new T.Shape();
  topShape.moveTo(-0.595, -0.438);
  topShape.lineTo(0.595, -0.438); topShape.quadraticCurveTo(0.813, -0.438, 0.813, -0.22);
  topShape.lineTo(0.813, 0.22); topShape.quadraticCurveTo(0.813, 0.438, 0.595, 0.438);
  topShape.lineTo(-0.595, 0.438); topShape.quadraticCurveTo(-0.813, 0.438, -0.813, 0.22);
  topShape.lineTo(-0.813, -0.22); topShape.quadraticCurveTo(-0.813, -0.438, -0.595, -0.438);
  const top = new T.ExtrudeGeometry(topShape, { depth: 0.031, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 3, steps: 1, curveSegments: 12 });
  top.rotateX(-Math.PI / 2); top.translate(0, 0.707, 0);
  add(g, 'racetrack-beveled-top', top, 'wood');
  for (const x of [-0.49, 0.49]) {
    for (const side of [-1, 1]) rod(g, 'splayed-trestle-leg', [x, 0.026, side * 0.33], [x, 0.687, side * 0.245], 0.035, 0.048);
    rod(g, 'trestle-crosspiece', [x, 0.61, -0.29], [x, 0.61, 0.29], 0.025, 0.025);
  }
  box(g, 'longitudinal-stretcher', [1.06, 0.068, 0.05], [0, 0.285, 0], 'wood', 0.018);
  for (const x of [-0.525, 0.525]) rod(g, 'end-grain-pin', [x, 0.285, -0.035], [x, 0.285, 0.035], 0.009, 0.009, 'metal');
}

function diningChair(g) {
  legs(g, 0.45, 0.45, 0.44, 'wood', 0.016, 0.025);
  box(g, 'seat-apron', [0.455, 0.043, 0.435], [0, 0.422, 0.017], 'wood', 0.02);
  cushion(g, 'upholstered-seat', [0.48, 0.075, 0.46], [0, 0.47, 0.025]);
  for (const side of [-1, 1]) rod(g, 'back-upright', [side * 0.193, 0.43, -0.168], [side * 0.225, 0.754, -0.24], 0.02, 0.017);
  // Bent laminated back rail, an arc with a thick closed cross section.
  const backRail = (name, radius, thickness, height, bottom, arc, slot) => {
    const positions = [], uv = [], indices = [];
    for (let i = 0; i <= 32; i++) {
      const t = i / 32, angle = (t - 0.5) * arc;
      for (const [dr, dy] of [[0, 0], [0, height], [thickness, height], [thickness, 0]]) {
        const r = radius + dr;
        positions.push(Math.sin(angle) * r, bottom + dy + 0.025 * Math.cos(angle), 0.095 - Math.cos(angle) * r);
        uv.push(t * 1.6, dy * 3);
      }
      if (i < 32) for (let j = 0; j < 4; j++) {
        const a = i * 4 + j, b = i * 4 + (j + 1) % 4;
        indices.push(a, b, a + 4, b, b + 4, a + 4);
      }
    }
    indices.push(0, 2, 1, 0, 3, 2, 128, 129, 130, 128, 130, 131);
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(positions, 3)); geo.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); geo.setIndex(indices); geo.computeVertexNormals();
    add(g, name, geo, slot);
  };
  backRail('bentwood-back-shell', 0.348, 0.022, 0.15, 0.625, 1.56, 'wood');
  backRail('curved-upholstered-pad', 0.323, 0.024, 0.1, 0.65, 1.18, 'fabric');
}

function desk(g) {
  legs(g, 1.12, 0.52, 0.704, 'wood', 0.023, 0.036);
  box(g, 'beveled-desktop', [1.25, 0.045, 0.62], [0, 0.7375, 0], 'wood', 0.022);
  box(g, 'rear-apron', [1.07, 0.12, 0.04], [0, 0.65, -0.23], 'wood', 0.012);
  box(g, 'drawer-carcass', [0.42, 0.125, 0.48], [0.29, 0.646, 0.008], 'wood', 0.012);
  box(g, 'drawer-reveal', [0.382, 0.085, 0.022], [0.29, 0.645, 0.253], 'metal', 0.008);
  box(g, 'drawer-front', [0.372, 0.078, 0.025], [0.29, 0.645, 0.268], 'primary', 0.007);
  rod(g, 'drawer-pull', [0.23, 0.647, 0.291], [0.35, 0.647, 0.291], 0.005, 0.005, 'metal');
  box(g, 'cable-grommet', [0.13, 0.003, 0.035], [-0.38, 0.761, -0.22], 'metal', 0.001);
}

function flutedColumn(g, x, height, radius, slot = 'wood') {
  lathe(g, 'pedestal-core', [[0, 0], [radius - 0.008, 0], [radius, 0.02], [radius, height - 0.02], [radius - 0.006, height], [0, height]], [x, 0, 0], slot);
  for (let i = 0; i < 28; i++) {
    const angle = i * Math.PI / 14;
    const px = x + Math.cos(angle) * radius, pz = Math.sin(angle) * radius;
    rod(g, `vertical-flute-${i}`, [px, 0.018, pz], [px, height - 0.015, pz], 0.007, 0.007, slot, 8);
  }
}

function coffeeTable(g) {
  ovalTop(g, 'pebble-edge-top', 1.12, 0.66, 0.045, 0.3375, 'primary');
  for (const x of [-0.28, 0.28]) flutedColumn(g, x, 0.318, 0.12);
}

function sideTable(g) {
  lathe(g, 'turned-tray-top', [[0, 0.442], [0.218, 0.442], [0.23, 0.452], [0.23, 0.476], [0.22, 0.48], [0.213, 0.468], [0, 0.468]], [0, 0, 0]);
  lathe(g, 'sculpted-pedestal', [[0, 0], [0.14, 0], [0.149, 0.016], [0.13, 0.035], [0.051, 0.115], [0.038, 0.37], [0.068, 0.443], [0, 0.443]], [0, 0, 0]);
  lathe(g, 'brass-collar', [[0.039, 0.35], [0.041, 0.35], [0.041, 0.363], [0.039, 0.363]], [0, 0, 0], 'metal');
}

function wardrobe(g) {
  box(g, 'toe-kick', [1.37, 0.08, 0.49], [0, 0.04, -0.015], 'metal', 0.01);
  box(g, 'cabinet-carcass', [1.5, 2.02, 0.555], [0, 1.09, -0.022], 'wood', 0.018);
  for (const side of [-1, 1]) {
    box(g, 'dark-door-reveal', [0.725, 1.94, 0.021], [side * 0.368, 1.09, 0.267], 'metal', 0.008);
    box(g, 'inset-door-panel', [0.701, 1.91, 0.025], [side * 0.368, 1.09, 0.283], 'primary', 0.009);
    for (const dx of [-0.327, 0.327]) box(g, 'door-stile', [0.031, 1.895, 0.035], [side * 0.368 + dx, 1.09, 0.296], 'wood', 0.008);
    for (const y of [0.158, 2.022]) box(g, 'door-rail', [0.654, 0.032, 0.035], [side * 0.368, y, 0.296], 'wood', 0.008);
    rod(g, 'brushed-pull', [side * 0.085, 0.99, 0.327], [side * 0.085, 1.24, 0.327], 0.008, 0.008, 'metal');
  }
}

function consoleUnit(g) {
  for (const x of [-0.73, 0.73]) for (const z of [-0.14, 0.14]) rod(g, 'low-tapered-foot', [x, 0, z], [x * 0.96, 0.12, z], 0.015, 0.024);
  box(g, 'console-bottom', [1.8, 0.032, 0.42], [0, 0.13, 0], 'wood', 0.015);
  box(g, 'console-top', [1.8, 0.034, 0.42], [0, 0.463, 0], 'wood', 0.016);
  box(g, 'console-back', [1.76, 0.3, 0.02], [0, 0.298, -0.19], 'wood', 0.008);
  for (const x of [-0.879, -0.302, 0.302, 0.879]) box(g, 'console-divider', [0.025, 0.3, 0.39], [x, 0.298, 0], 'wood', 0.009);
  for (const side of [-1, 1]) {
    box(g, 'tambour-door-backing', [0.542, 0.282, 0.026], [side * 0.589, 0.298, 0.174], 'primary', 0.008);
    for (let i = 0; i < 21; i++) box(g, `tambour-slat-${side}-${i}`, [0.016, 0.276, 0.016], [side * 0.589 - 0.251 + i * 0.0251, 0.298, 0.194], 'wood', 0.007);
    rod(g, 'console-pull', [side * 0.365, 0.27, 0.212], [side * 0.365, 0.326, 0.212], 0.004, 0.004, 'metal');
  }
  box(g, 'open-compartment-shelf', [0.58, 0.019, 0.345], [0, 0.287, 0.006], 'wood', 0.008);
  box(g, 'media-box', [0.275, 0.052, 0.225], [0.08, 0.188, 0.04], 'metal', 0.012);
  box(g, 'linen-book-1', [0.33, 0.019, 0.24], [-0.07, 0.32, 0.01], 'linen', 0.005);
  box(g, 'linen-book-2', [0.29, 0.023, 0.21], [-0.055, 0.343, 0.015], 'primary', 0.005, [0, 0.075, 0]);
}

function leaf(g, start, end, width, bend, index) {
  const positions = [], uv = [], indices = [];
  const a = new T.Vector3(...start), b = new T.Vector3(...end), delta = b.clone().sub(a);
  const across = new T.Vector3(delta.z, 0, -delta.x).normalize();
  for (let i = 0; i <= 12; i++) for (let j = 0; j <= 4; j++) {
    const t = i / 12, s = j / 2 - 1;
    const p = a.clone().addScaledVector(delta, t).addScaledVector(across, s * width * Math.pow(Math.sin(Math.PI * t), 0.8));
    p.y += Math.sin(Math.PI * t) * bend - Math.abs(s) * Math.sin(Math.PI * t) * 0.025;
    positions.push(...p.toArray()); uv.push(j / 4, t);
    if (i < 12 && j < 4) { const k = i * 5 + j; indices.push(k, k + 5, k + 1, k + 1, k + 5, k + 6); }
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3)); geometry.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); geometry.setIndex(indices); geometry.computeVertexNormals();
  add(g, `curved-leaf-${index}`, geometry, 'foliage');
  tube(g, `leaf-midrib-${index}`, [start, [(a.x + b.x) / 2, (a.y + b.y) / 2 + bend + 0.001, (a.z + b.z) / 2], end], 0.0016, 'stem', false, 12);
}

function plant(g) {
  lathe(g, 'ceramic-planter', [[0, 0], [0.114, 0], [0.126, 0.016], [0.149, 0.235], [0.153, 0.266], [0.147, 0.277], [0.136, 0.277], [0.133, 0.257], [0.126, 0.035], [0, 0.035]], [0, 0, 0], 'primary');
  add(g, 'visible-soil', new T.CylinderGeometry(0.132, 0.132, 0.01, 40), 'soil', [0, 0.247, 0]);
  tube(g, 'branching-trunk', [[0, 0.24, 0], [-0.024, 0.56, 0.018], [0.014, 0.83, -0.009], [0.026, 1.06, -0.015]], 0.007, 'stem', false, 28);
  for (let i = 0; i < 16; i++) {
    const angle = i * 2.39996;
    const y = 0.39 + i * 0.039;
    const reach = 0.28 - i * 0.004;
    const start = [0.01 * Math.sin(i), y, 0];
    const neck = [Math.cos(angle) * 0.075, y + 0.037, Math.sin(angle) * 0.075];
    const end = [Math.cos(angle) * reach, y + 0.11 + (i % 3) * 0.017, Math.sin(angle) * reach];
    tube(g, `petiole-${i}`, [start, neck], 0.003, 'stem', false, 8);
    leaf(g, neck, end, 0.056 + (i % 3) * 0.009, 0.032, i);
  }
  leaf(g, [0.026, 0.98, -0.015], [0.07, 1.15, 0.022], 0.039, 0.012, 16);
}

function lamp(g) {
  lathe(g, 'weighted-spun-base', [[0, 0], [0.157, 0], [0.174, 0.012], [0.17, 0.022], [0.146, 0.033], [0.045, 0.042], [0, 0.042]], [0, 0, 0], 'metal');
  rod(g, 'slender-stem', [0, 0.033, 0], [0, 1.3, 0], 0.01, 0.01, 'metal', 24);
  lathe(g, 'ceramic-stem-collar', [[0.012, 0], [0.036, 0.02], [0.04, 0.13], [0.03, 0.22], [0.012, 0.23]], [0, 0.1, 0], 'primary');
  const p = [], uv = [], ix = [], segments = 144;
  for (let i = 0; i <= segments; i++) {
    const angle = i / segments * Math.PI * 2;
    for (let j = 0; j < 2; j++) {
      const r = (j ? 0.153 : 0.236) + (i % 2 ? 0.004 : -0.004);
      p.push(Math.cos(angle) * r, j ? 1.5 : 1.18, Math.sin(angle) * r);
      uv.push(i / segments * 3, j);
    }
    if (i < segments) { const k = i * 2; ix.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.Float32BufferAttribute(p, 3)); geo.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); geo.setIndex(ix); geo.computeVertexNormals();
  add(g, 'pleated-linen-shade', geo, 'linen');
  for (const [r, y] of [[0.238, 1.18], [0.155, 1.5]]) add(g, 'rolled-shade-binding', new T.TorusGeometry(r, 0.0032, 6, 72), 'linen', [0, y, 0], [Math.PI / 2, 0, 0]);
  add(g, 'diffuser', new T.CircleGeometry(0.223, 48), 'light', [0, 1.188, 0], [Math.PI / 2, 0, 0]);
  for (let i = 0; i < 3; i++) {
    const a = i * Math.PI * 2 / 3;
    rod(g, 'shade-support', [0, 1.26, 0], [Math.cos(a) * 0.223, 1.185, Math.sin(a) * 0.223], 0.002, 0.002, 'metal');
  }
}

function rug(g) {
  box(g, 'woven-rug-body', [2.04, 0.012, 1.46], [0, 0.006, 0], 'fabric', 0.006);
  tube(g, 'bound-rug-edge', roundPath(2.025, 1.445, 0.032, 0.011), 0.0034, 'piping', true, 100);
  for (const side of [-1, 1]) {
    box(g, 'woven-border-stripe', [1.98, 0.0015, 0.011], [0, 0.0127, side * 0.64], 'accent', 0.0007);
    box(g, 'woven-border-hairline', [1.98, 0.0015, 0.004], [0, 0.0127, side * 0.62], 'piping', 0.0007);
    for (let i = 0; i < 55; i++) {
      const x = -0.976 + i * 0.036;
      tube(g, `fringe-${side}-${i}`, [[x, 0.007, side * 0.722], [x + 0.004, 0.007, side * 0.738], [x - 0.003, 0.005, side * 0.75]], 0.002, 'piping', false, 3);
    }
  }
}

const builders = { sofa, bed, 'dining-table': diningTable, 'dining-chair': diningChair, desk, 'coffee-table': coffeeTable, 'side-table': sideTable, wardrobe, 'tv-console': consoleUnit, plant, 'floor-lamp': lamp, rug };

export function createAssetGeometry(asset) {
  const group = new T.Group();
  builders[asset.category](group);
  group.updateMatrixWorld(true);
  const bounds = new T.Box3().setFromObject(group, true);
  const size = bounds.getSize(new T.Vector3());
  const center = bounds.getCenter(new T.Vector3());
  const normalization = new T.Matrix4().makeScale(asset.dimensions.width / size.x, asset.dimensions.height / size.y, asset.dimensions.depth / size.z)
    .multiply(new T.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z));
  const bySlot = new Map();
  group.traverse((mesh) => {
    if (!mesh.isMesh) return;
    let geometry = mesh.geometry.clone();
    geometry.applyMatrix4(normalization.clone().multiply(mesh.matrixWorld));
    // Meter-based projection keeps fine grain/weave at a credible scale on broad faces.
    const slot = mesh.userData.slot;
    if (SLOT_DEFINITIONS[slot].texture) {
      const p = geometry.attributes.position, n = geometry.attributes.normal;
      const uv = new Float32Array(p.count * 2);
      for (let i = 0; i < p.count; i++) {
        const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
        const fabric = SLOT_DEFINITIONS[slot].texture === 'fabric';
        uv[i * 2] = (ay > ax && ay > az ? p.getX(i) : ax > az ? p.getZ(i) : p.getX(i)) * (fabric ? 6 : slot === 'wood' ? 4 : 1);
        uv[i * 2 + 1] = (ay > ax && ay > az ? p.getZ(i) : p.getY(i)) * (fabric ? 6 : 1);
      }
      geometry.setAttribute('uv', new T.BufferAttribute(uv, 2));
    }
    if (!geometry.index) geometry = mergeVertices(geometry, 1e-5);
    geometry.deleteAttribute('uv1');
    const bucket = bySlot.get(slot) ?? { geometries: [], components: [] };
    bucket.components.push({ name: mesh.name, triangles: geometry.index.count / 3 });
    bucket.geometries.push(geometry);
    bySlot.set(slot, bucket);
  });
  const result = [...bySlot].map(([slot, { geometries, components }]) => {
    const geometry = mergeGeometries(geometries);
    geometry.computeBoundingBox();
    geometries.forEach((entry) => entry.dispose());
    return { slot, geometry, components };
  });
  group.traverse((mesh) => { if (mesh.isMesh) { mesh.geometry.dispose(); mesh.material.dispose(); } });
  return result;
}
