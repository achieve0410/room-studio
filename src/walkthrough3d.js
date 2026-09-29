import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createStudioEditSession, studioWallRuns } from './studio3d-edit.js';
import { createStudioAssets, disposeStudioScene } from './studio3d-assets.js';
import { createStudioPanel } from './studio3d-panel.js';
import { studioSpatialPoints, studioRoomPoints, fitStudioCamera, createStudioNavigation } from './studio3d-camera.js';
import { renderWorkbenchNavigation } from './workbench-ui.js';
import {
  doorsForAutomaticWallSegment,
  getExteriorWallSegments,
  getDoorLeafSegments,
  getInteriorWallSegments,
  getLayoutBounds,
  resizeItemFromHandle,
  rotationFromPointer,
  snap,
  isPointBlockedByFurniture,
  isPointBlockedByDoorLeaves,
  isPointBlockedByInteriorWall,
  isWalkablePoint,
  pointInZone,
  splitWallSegment,
  splitWallSegmentLocal,
  spaceIdOf,
  structureSegment,
  structureBounds,
  segmentEndpoints,
  segmentFrame,
  structureAngle,
  zonePoints,
  zoneInteriorPoint,
} from './geometry.js';

const DEFAULT_EYE_HEIGHT_CM = 165;
const CAMERA_RADIUS_CM = 18;
const MOVE_SPEED_MPS = 2.25;
const WALL_THICKNESS_M = 0.06;
const DOOR_HEIGHT_M = 2.05;
let activeCleanup = null;

export function walkthroughRendererProfile(qaRenderProfile = false) {
  return {
    antialias: !qaRenderProfile,
    pixelRatio: qaRenderProfile ? 0.5 : Math.min(window.devicePixelRatio, 2),
    shadows: !qaRenderProfile,
  };
}

export function createWalkthroughRenderer(stage, overlay, profile, createRenderer = (options) => new THREE.WebGLRenderer(options)) {
  let renderer;
  try {
    renderer = createRenderer({
      antialias: profile.antialias,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(profile.pixelRatio);
    renderer.setSize(stage.clientWidth, stage.clientHeight, false);
    renderer.shadowMap.enabled = profile.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.localClippingEnabled = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.92;
    return renderer;
  } catch (cause) {
    renderer?.dispose();
    renderer?.forceContextLoss();
    overlay.remove();
    throw new Error('3D 화면을 열 수 없습니다. 2D 편집을 계속하거나 다른 브라우저에서 다시 시도해 주세요.', { cause });
  }
}

export function createWallPresentation(scene) {
  const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0.65);
  const materials = new Map();
  const walls = [];
  const position = new THREE.Vector3();
  const variants = (entry) => {
    if (!materials.has(entry)) {
      const full = entry.clone();
      const cut = entry.clone();
      full.clippingPlanes = null;
      full.clipShadows = false;
      cut.clippingPlanes = [plane];
      cut.clipShadows = true;
      materials.set(entry, { full, cut });
    }
    return materials.get(entry);
  };
  scene.traverse((object) => {
    if (!object.isMesh || !['wall', 'wall-trim'].includes(object.userData.type)
      || object.userData.doorFramePart) return;
    const original = object.material;
    const full = Array.isArray(original) ? original.map(entry => variants(entry).full) : variants(original).full;
    const cut = Array.isArray(original) ? original.map(entry => variants(entry).cut) : variants(original).cut;
    object.material = full;
    walls.push({ object, original, full, cut });
  });
  return {
    setMode(mode, enabled = true, camera = null, target = null) {
      const cutaway = enabled && (mode === 'dollhouse' || mode === 'top');
      for (const wall of walls) {
        let near = true;
        if (cutaway && mode === 'dollhouse' && camera && target) {
          wall.object.getWorldPosition(position);
          near = (position.x - target.x) * (camera.position.x - target.x)
            + (position.z - target.z) * (camera.position.z - target.z) >= 0;
        }
        wall.object.material = cutaway && near ? wall.cut : wall.full;
      }
      return cutaway;
    },
    dispose() {
      walls.forEach(({ object, original }) => { object.material = original; });
      materials.forEach(({ full, cut }) => { full.dispose(); cut.dispose(); });
    },
  };
}

export function overviewSpatialMeshes(scene) {
  const meshes = [];
  scene.updateMatrixWorld(true);
  scene.traverseVisible((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (!materials.some((material) => material.visible && material.colorWrite && material.opacity > 0)) return;
    let relevant = Boolean(object.userData.openingController);
    for (let ancestor = object; ancestor; ancestor = ancestor.parent) {
      if (['floor', 'wall', 'wall-trim', 'furniture'].includes(ancestor.userData.type)) relevant = true;
      if (['ceiling', 'ceiling-fixture', 'furniture-label'].includes(ancestor.userData.type)) return;
    }
    if (relevant) meshes.push(object);
  });
  return meshes;
}

export function overviewSpatialBounds(scene) {
  const bounds = new THREE.Box3();
  overviewSpatialMeshes(scene).forEach((object) => {
    object.geometry.computeBoundingBox();
    bounds.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
  });
  return bounds;
}

export function fitOverviewCamera(camera, bounds, mode, target = null) {
  const center = target
    ? new THREE.Vector3(target.x, target.y, target.z)
    : bounds.getCenter(new THREE.Vector3());
  const direction = mode === 'top'
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(0.62, 1.05, 0.78).normalize();
  camera.up.set(0, mode === 'top' ? 0 : 1, mode === 'top' ? -1 : 0);
  camera.fov = mode === 'top' ? 42 : 48;
  camera.position.copy(center).add(direction);
  camera.lookAt(center);
  const inverseRotation = camera.quaternion.clone().invert();
  const verticalSlope = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / camera.zoom;
  const horizontalSlope = verticalSlope * camera.aspect;
  const padding = 0.9;
  let distance = 0;
  const corners = [];
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        const corner = new THREE.Vector3(x, y, z).sub(center).applyQuaternion(inverseRotation);
        corners.push(corner);
        distance = Math.max(
          distance,
          corner.z + Math.abs(corner.x) / (horizontalSlope * padding),
          corner.z + Math.abs(corner.y) / (verticalSlope * padding),
          corner.z + camera.near * 2,
        );
      }
    }
  }
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.far = Math.max(100, ...corners.map((corner) => (distance - corner.z) * 1.1));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

export function pickWalkthroughOpening(raycaster, scene) {
  const intersection = raycaster.intersectObjects(scene.children, true)
    .find((entry) => entry.distance <= 4 && entry.object.isMesh);
  return intersection?.object.userData.openingController ?? null;
}

export function setStatusMessage(status, message) {
  const documentRef = status.ownerDocument;
  status.replaceChildren(
    documentRef.createElement('i'),
    documentRef.createTextNode(` ${message}`),
  );
}

const material = (color, roughness = 0.72, metalness = 0.02) => new THREE.MeshStandardMaterial({
  color, roughness, metalness,
});

function adjustedColor(color, lightness) {
  const adjusted = new THREE.Color(color);
  adjusted.offsetHSL(0, 0, lightness);
  return adjusted;
}

function addBox(group, size, position, boxMaterial, options = {}) {
  const radius = Math.min(options.radius ?? 0, ...size.map((value) => value / 2));
  const geometry = radius > 0
    ? new RoundedBoxGeometry(...size, 4, radius)
    : new THREE.BoxGeometry(...size);
  const mesh = new THREE.Mesh(geometry, boxMaterial);
  mesh.position.set(...position);
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  group.add(mesh);
  return mesh;
}

function addCylinder(group, radiusTop, radiusBottom, height, position, cylinderMaterial, segments = 32) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), cylinderMaterial);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function createSofa(item, width, depth, height) {
  const group = new THREE.Group();
  const upholstery = material(item.color, 0.94);
  const cushion = material(adjustedColor(item.color, 0.055), 0.98);
  const dark = material(adjustedColor(item.color, -0.13), 0.8);
  addBox(group, [width * 0.9, height * 0.18, depth * 0.76], [0, height * 0.19, depth * 0.05], upholstery, { radius: 0.045 });
  addBox(group, [width * 0.88, height * 0.48, depth * 0.16], [0, height * 0.62, -depth * 0.36], upholstery, { radius: 0.055 });
  addBox(group, [width * 0.1, height * 0.46, depth * 0.76], [-width * 0.44, height * 0.39, depth * 0.02], upholstery, { radius: 0.045 });
  addBox(group, [width * 0.1, height * 0.46, depth * 0.76], [width * 0.44, height * 0.39, depth * 0.02], upholstery, { radius: 0.045 });
  const cushionWidth = width * 0.39;
  [-1, 1].forEach((side) => {
    addBox(group, [cushionWidth, height * 0.13, depth * 0.53], [side * width * 0.21, height * 0.34, depth * 0.08], cushion, { radius: 0.055 });
    addBox(group, [width * 0.37, height * 0.35, depth * 0.1], [side * width * 0.2, height * 0.61, -depth * 0.25], cushion, { radius: 0.045 });
  });
  [-1, 1].forEach((x) => [-1, 1].forEach((z) => {
    addBox(group, [0.045, height * 0.13, 0.045], [x * width * 0.38, height * 0.065, z * depth * 0.29], dark);
  }));
  return group;
}

function createBed(item, width, depth, height) {
  const group = new THREE.Group();
  const frame = material(adjustedColor(item.color, -0.16), 0.75);
  const linen = material(0xf4eee5, 1);
  const cover = material(item.color, 0.96);
  const pillow = material(0xfffbf3, 1);
  addBox(group, [width, height * 0.2, depth], [0, height * 0.1, 0], frame);
  addBox(group, [width * 0.95, height * 0.48, depth * 0.9], [0, height * 0.42, depth * 0.02], linen, { radius: 0.06 });
  addBox(group, [width, height * 1.28, depth * 0.09], [0, height * 0.64, -depth * 0.455], frame);
  addBox(group, [width * 0.91, height * 0.09, depth * 0.48], [0, height * 0.705, depth * 0.22], cover, { radius: 0.025 });
  [-1, 1].forEach((side) => addBox(
    group,
    [width * 0.38, height * 0.16, depth * 0.18],
    [side * width * 0.22, height * 0.73, -depth * 0.28],
    pillow,
    { radius: 0.06 },
  ));
  return group;
}

function createTable(item, width, depth, height) {
  const group = new THREE.Group();
  const wood = material(item.color, 0.52);
  const darkWood = material(adjustedColor(item.color, -0.16), 0.65);
  const round = item.shape === 'circle' || item.shape === 'ellipse';
  if (round) {
    const top = addCylinder(group, 0.5, 0.5, Math.max(0.07, height * 0.08), [0, height * 0.94, 0], wood, 48);
    top.scale.x = width;
    top.scale.z = depth;
    addCylinder(group, Math.min(width, depth) * 0.09, Math.min(width, depth) * 0.12, height * 0.82, [0, height * 0.49, 0], darkWood);
    const base = addCylinder(group, 0.5, 0.5, 0.055, [0, 0.028, 0], darkWood, 40);
    base.scale.x = width * 0.48;
    base.scale.z = depth * 0.48;
  } else {
    addBox(group, [width, Math.max(0.07, height * 0.08), depth], [0, height * 0.94, 0], wood);
    [-1, 1].forEach((x) => [-1, 1].forEach((z) => {
      addBox(group, [0.06, height * 0.88, 0.06], [x * width * 0.42, height * 0.45, z * depth * 0.36], darkWood);
    }));
  }
  return group;
}

function createWardrobe(item, width, depth, height) {
  const group = new THREE.Group();
  const body = material(item.color, 0.68);
  const door = material(adjustedColor(item.color, 0.045), 0.72);
  const handle = material(0x4f4942, 0.32, 0.45);
  addBox(group, [width, height, depth], [0, height / 2, 0], body);
  [-1, 1].forEach((side) => {
    addBox(group, [width * 0.47, height * 0.93, 0.025], [side * width * 0.242, height * 0.5, depth * 0.515], door);
    addBox(group, [0.018, height * 0.18, 0.026], [side * width * 0.045, height * 0.52, depth * 0.54], handle);
  });
  return group;
}

function createTvConsole(item, width, depth, height) {
  const group = new THREE.Group();
  const body = material(item.color, 0.65);
  const front = material(adjustedColor(item.color, -0.09), 0.7);
  const metal = material(0x252b2c, 0.24, 0.25);
  addBox(group, [width, height * 0.72, depth], [0, height * 0.45, 0], body);
  [-1, 0, 1].forEach((section) => addBox(
    group,
    [width * 0.29, height * 0.5, 0.024],
    [section * width * 0.315, height * 0.45, depth * 0.515],
    front,
  ));
  addBox(group, [width * 0.7, 0.025, depth * 0.25], [0, height * 0.94, 0], metal);
  return group;
}

function createPlant(item, width, depth, height) {
  const group = new THREE.Group();
  const pot = material(0x9e694d, 0.88);
  const soil = material(0x30281f, 1);
  const stem = material(0x526e42, 0.96);
  const leaf = material(item.color, 0.92);
  const potHeight = height * 0.32;
  addCylinder(group, width * 0.31, width * 0.24, potHeight, [0, potHeight / 2, 0], pot, 24);
  addCylinder(group, width * 0.25, width * 0.25, 0.025, [0, potHeight + 0.013, 0], soil, 24);
  addCylinder(group, 0.018, 0.025, height * 0.48, [0, height * 0.55, 0], stem, 10);
  const leafGeometry = new THREE.SphereGeometry(0.5, 16, 10);
  [[-0.18, 0.62, 0.02], [0.18, 0.68, -0.04], [-0.08, 0.82, -0.1], [0.1, 0.9, 0.05], [0, 0.74, 0.14]].forEach(([x, y, z], index) => {
    const mesh = new THREE.Mesh(leafGeometry, leaf);
    mesh.position.set(x * width, y * height, z * depth);
    mesh.scale.set(width * 0.42, height * (index === 3 ? 0.16 : 0.12), depth * 0.25);
    mesh.rotation.z = x * 1.6;
    mesh.castShadow = true;
    group.add(mesh);
  });
  return group;
}

function addRod(group, radius, length, position, rodMaterial, axis = 'y') {
  const rod = addCylinder(group, radius, radius, length, position, rodMaterial, 16);
  if (axis === 'x') rod.rotation.z = Math.PI / 2;
  if (axis === 'z') rod.rotation.x = Math.PI / 2;
  return rod;
}

function createToilet(item, width, depth, height) {
  const group = new THREE.Group();
  const porcelain = material(item.color, 0.28);
  const water = material(0xa9d5de, 0.18);
  const base = addCylinder(group, width * 0.25, width * 0.31, height * 0.52, [0, height * 0.26, depth * 0.05], porcelain, 32);
  base.scale.z = 1.18;
  const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.5, 28, 18), porcelain);
  bowl.scale.set(width * 0.48, height * 0.2, depth * 0.42);
  bowl.position.set(0, height * 0.54, depth * 0.08);
  bowl.castShadow = true;
  group.add(bowl);
  const seat = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.035, 12, 32), porcelain);
  seat.scale.set(width * 1.35, depth * 1.2, 1);
  seat.rotation.x = Math.PI / 2;
  seat.position.set(0, height * 0.68, depth * 0.12);
  group.add(seat);
  const waterSurface = addCylinder(group, width * 0.2, width * 0.2, 0.012, [0, height * 0.66, depth * 0.12], water, 32);
  waterSurface.scale.z = 1.25;
  addBox(group, [width * 0.75, height * 0.46, depth * 0.3], [0, height * 0.72, -depth * 0.31], porcelain, { radius: 0.05 });
  return group;
}

function createWashbasin(item, width, depth, height) {
  const group = new THREE.Group();
  const porcelain = material(item.color, 0.3);
  const metal = material(0xaeb7b6, 0.2, 0.75);
  addCylinder(group, width * 0.13, width * 0.2, height * 0.74, [0, height * 0.37, -depth * 0.08], porcelain, 28);
  const basin = new THREE.Mesh(new THREE.SphereGeometry(0.5, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), porcelain);
  basin.scale.set(width * 0.52, height * 0.18, depth * 0.48);
  basin.position.set(0, height * 0.78, 0);
  group.add(basin);
  addBox(group, [width, height * 0.09, depth], [0, height * 0.87, 0], porcelain, { radius: 0.04 });
  addRod(group, 0.018, height * 0.1, [0, height * 0.94, -depth * 0.16], metal);
  addRod(group, 0.014, depth * 0.18, [0, height * 0.98, -depth * 0.08], metal, 'z');
  return group;
}

function createKitchenUnit(item, width, depth, height, island = false) {
  const group = new THREE.Group();
  const body = material(item.color, 0.72);
  const front = material(adjustedColor(item.color, 0.055), 0.66);
  const counter = material(0xd8d2c6, 0.35, 0.08);
  const metal = material(0x8d9899, 0.22, 0.7);
  const bodyHeight = height * (island ? 0.9 : 0.78);
  const counterHeight = height * (island ? 0.08 : 0.06);
  const counterY = height * (island ? 0.94 : 0.8);
  addBox(group, [width * (island ? 0.88 : 0.96), bodyHeight, depth * 0.9], [0, bodyHeight / 2, 0], body);
  addBox(group, [width, counterHeight, depth], [0, counterY, 0], counter);
  const sections = Math.max(2, Math.round(width / 0.6));
  for (let index = 0; index < sections; index += 1) {
    const x = -width * 0.44 + (index + 0.5) * width * 0.88 / sections;
    addBox(group, [width * 0.8 / sections, height * 0.68, 0.024], [x, height * 0.47, depth * 0.46], front);
  }
  if (!island) {
    addBox(group, [Math.min(0.7, width * 0.3), 0.018, depth * 0.48], [width * 0.2, height * 0.835, 0], metal);
    addRod(group, 0.018, height * 0.15, [width * 0.2, height * 0.91, -depth * 0.08], metal);
    addRod(group, 0.014, depth * 0.19, [width * 0.2, height * 0.985, 0], metal, 'z');
  }
  return group;
}

function createLaundryTower(item, width, depth, height) {
  const group = new THREE.Group();
  const body = material(item.color, 0.48, 0.18);
  const trim = material(0x4e5758, 0.25, 0.42);
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x28383d, roughness: 0.08, transparent: true, opacity: 0.72 });
  addBox(group, [width, height, depth], [0, height / 2, 0], body, { radius: 0.04 });
  [0.28, 0.73].forEach((ratio) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(width * 0.25, 0.035, 12, 36), trim);
    ring.position.set(0, height * ratio, depth * 0.505);
    group.add(ring);
    const door = new THREE.Mesh(new THREE.CircleGeometry(width * 0.24, 36), glass);
    door.position.set(0, height * ratio, depth * 0.515);
    group.add(door);
  });
  addBox(group, [width * 0.72, height * 0.055, 0.02], [0, height * 0.5, depth * 0.52], trim);
  return group;
}

function createClothesRack(item, width, depth, height, variant) {
  const group = new THREE.Group();
  const metal = material(item.color, 0.3, 0.72);
  const rodRadius = Math.max(0.012, Math.min(width, depth) * 0.025);
  [-1, 1].forEach((side) => {
    addRod(group, rodRadius, height * 0.94, [side * width * 0.44, height * 0.47, 0], metal);
    addRod(group, rodRadius, depth * 0.84, [side * width * 0.44, rodRadius, 0], metal, 'z');
  });
  const addRail = (y, z = 0) => addRod(group, rodRadius, width * 0.88, [0, y, z], metal, 'x');
  if (variant === 'doubleRow') {
    addRail(height * 0.9, -depth * 0.28);
    addRail(height * 0.9, depth * 0.28);
  } else if (variant === 'doubleTier') {
    addRail(height * 0.92);
    addRail(height * 0.5);
  } else {
    addRail(height * 0.9);
  }
  return group;
}

function createFurnitureNameTag(item, height) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  context.fillStyle = 'rgba(24, 30, 27, .86)';
  context.fillRect(8, 8, 496, 112);
  context.strokeStyle = 'rgba(255, 255, 255, .72)';
  context.lineWidth = 3;
  context.strokeRect(8, 8, 496, 112);
  context.fillStyle = '#fffaf3';
  context.font = '700 40px Inter, Pretendard, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const name = typeof item.name === 'string' && item.name.trim() ? item.name : '커스텀 가구';
  const label = name.length > 18 ? `${name.slice(0, 17)}…` : name;
  context.fillText(label, 256, 64, 450);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  }));
  sprite.position.set(0, height + 0.13, 0);
  sprite.scale.set(Math.min(1.05, Math.max(0.58, label.length * 0.075)), 0.16, 1);
  sprite.userData = { type: 'furniture-label', id: item.id, name: item.name };
  sprite.renderOrder = 2;
  return sprite;
}

function createFurnitureGroup(item) {
  const width = item.width / 100;
  const depth = item.depth / 100;
  const height = Math.max(item.height / 100, 0.02);
  let group;

  if (item.type === 'sofa') group = createSofa(item, width, depth, height);
  else if (item.type === 'bed') group = createBed(item, width, depth, height);
  else if (item.type === 'table') group = createTable(item, width, depth, height);
  else if (item.type === 'desk') group = createTable(item, width, depth, height);
  else if (item.type === 'wardrobe') group = createWardrobe(item, width, depth, height);
  else if (item.type === 'tv') group = createTvConsole(item, width, depth, height);
  else if (item.type === 'plant') group = createPlant(item, width, depth, height);
  else if (item.type === 'toilet') group = createToilet(item, width, depth, height);
  else if (item.type === 'washbasin') group = createWashbasin(item, width, depth, height);
  else if (item.type === 'kitchenSink') group = createKitchenUnit(item, width, depth, height);
  else if (item.type === 'kitchenIsland') group = createKitchenUnit(item, width, depth, height, true);
  else if (item.type === 'laundryTower') group = createLaundryTower(item, width, depth, height);
  else if (item.type === 'clothesRackSingle') group = createClothesRack(item, width, depth, height, 'single');
  else if (item.type === 'clothesRackDoubleRow') group = createClothesRack(item, width, depth, height, 'doubleRow');
  else if (item.type === 'clothesRackDoubleTier') group = createClothesRack(item, width, depth, height, 'doubleTier');
  else {
    group = new THREE.Group();
    if (item.shape === 'circle' || item.shape === 'ellipse') {
      const mesh = addCylinder(group, 0.5, 0.5, height, [0, height / 2, 0], material(item.color, item.type === 'rug' ? 1 : 0.72), 40);
      mesh.scale.x = width;
      mesh.scale.z = depth;
    } else {
      addBox(group, [width, height, depth], [0, height / 2, 0], material(item.color));
    }
  }

  group.position.y = (item.elevation ?? 0) / 100;
  group.rotation.y = -((item.rotation ?? 0) * Math.PI) / 180;
  group.userData = { type: 'furniture', id: item.id, name: item.name };
  if (item.type === 'custom') group.add(createFurnitureNameTag(item, height));
  return group;
}

function createFloorTexture(zone) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  const tiled = ['주방', '욕실', '다용도실'].includes(zone.type);

  if (tiled) {
    context.fillStyle = zone.type === '욕실' ? '#ccd6d5' : '#d6d8d4';
    context.fillRect(0, 0, 512, 512);
    context.strokeStyle = 'rgba(255,255,255,.72)';
    context.lineWidth = 1.5;
    for (let position = 0; position <= 512; position += 128) {
      context.beginPath(); context.moveTo(position, 0); context.lineTo(position, 512); context.stroke();
      context.beginPath(); context.moveTo(0, position); context.lineTo(512, position); context.stroke();
    }
  } else {
    context.fillStyle = '#c5b391';
    context.fillRect(0, 0, 512, 512);
    for (let row = 0; row < 8; row += 1) {
      for (let column = -1; column < 5; column += 1) {
        const x = column * 128 + (row % 2) * 64;
        const y = row * 64;
        const shade = (row * 17 + column * 23 + 80) % 28;
        context.fillStyle = `rgba(255,245,225,${0.025 + shade / 800})`;
        context.fillRect(x + 2, y + 2, 124, 60);
        context.strokeStyle = 'rgba(74,45,24,.12)';
        context.lineWidth = 1;
        context.strokeRect(x, y, 128, 64);
        context.strokeStyle = 'rgba(255,255,255,.08)';
        context.beginPath(); context.moveTo(x + 12, y + 20); context.lineTo(x + 110, y + 20); context.stroke();
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  const tileWidth = tiled ? 240 : 480;
  const tileDepth = tiled ? 240 : 144;
  texture.repeat.set(zone.width / tileWidth, zone.depth / tileDepth);
  texture.offset.set(zone.x / tileWidth, -(zone.y + zone.depth) / tileDepth);
  texture.anisotropy = 8;
  return texture;
}

function buildWallPiece(
  scene, segment, center, height, centerHeight, wallMaterial, trimMaterial,
  thickness = WALL_THICKNESS_M, dollhouseCutaway = false,
) {
  const frame = segmentFrame(segment);
  const length = frame.length / 100;
  if (length <= 0.01 || height <= 0.01) return;
  const wall = new THREE.Mesh(new THREE.BoxGeometry(length, height, thickness), wallMaterial);
  wall.position.set(
    (frame.start.x + frame.end.x - center.x * 2) / 200,
    centerHeight,
    (frame.start.y + frame.end.y - center.y * 2) / 200,
  );
  wall.rotation.y = -frame.angle * Math.PI / 180;
  wall.castShadow = true;
  wall.receiveShadow = true;
  wall.userData = { type: 'wall', dollhouseCutaway };
  scene.add(wall);
  if (centerHeight === height / 2 && height > 1) {
    const baseboard = new THREE.Mesh(new THREE.BoxGeometry(length, 0.09, thickness + 0.035), trimMaterial);
    baseboard.position.set(wall.position.x, 0.045, wall.position.z);
    baseboard.rotation.copy(wall.rotation);
    baseboard.receiveShadow = true;
    baseboard.userData = { type: 'wall-trim', dollhouseCutaway };
    scene.add(baseboard);
  }
  return wall;
}

function isPositiveFacingExterior(segment, zones) {
  const [run] = studioWallRuns(segment, zones);
  return Boolean(run?.negative && !run.positive);
}

// Three triangulates the canonical outline; normalized UVs keep existing surface repeats.
function zoneSurfaceGeometry(zone) {
  if (!zone.points) return new THREE.PlaneGeometry(zone.width / 100, zone.depth / 100);
  const shape = new THREE.Shape(zonePoints(zone).map(point => new THREE.Vector2(
    (point.x - zone.x - zone.width / 2) / 100,
    -(point.y - zone.y - zone.depth / 2) / 100,
  )));
  const geometry = new THREE.ShapeGeometry(shape);
  const position = geometry.attributes.position, uv = geometry.attributes.uv;
  for (let index = 0; index < position.count; index++) {
    uv.setXY(index, position.getX(index) * 100 / zone.width + 0.5, position.getY(index) * 100 / zone.depth + 0.5);
  }
  return geometry;
}

function buildDoorLeaf(scene, door, center, doorMaterial, frameMaterial) {
  const width = door.width / 100;
  const height = door.height / 100;
  const group = new THREE.Group();
  const meshes = [];
  group.position.set((door.x - center.x) / 100, 0, (door.y - center.y) / 100);
  group.rotation.y = -structureAngle(door) * Math.PI / 180;
  let applyOpening;
  if (door.doorType === 'sliding') {
    const direction = door.slideDirection === 'start' ? -1 : 1;
    const panelWidth = width / 2;
    const fixedPanel = new THREE.Mesh(new THREE.BoxGeometry(panelWidth, height, 0.03), doorMaterial);
    fixedPanel.position.set(direction * width / 4, height / 2, -0.018);
    fixedPanel.castShadow = true;
    group.add(fixedPanel);
    meshes.push(fixedPanel);
    const movingPanel = new THREE.Mesh(new THREE.BoxGeometry(panelWidth, height, 0.03), doorMaterial);
    movingPanel.castShadow = true;
    group.add(movingPanel);
    meshes.push(movingPanel);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(width + 0.08, 0.035, 0.045), frameMaterial);
    rail.position.y = height + 0.025;
    group.add(rail);
    meshes.push(rail);
    applyOpening = (opening) => {
      const ratio = Math.min(100, Math.max(0, opening)) / 100;
      movingPanel.position.set(-direction * width / 4 + direction * width / 2 * ratio, height / 2, 0.018);
    };
  } else {
    const hingeDirection = door.hinge === 'end' ? -1 : 1;
    const pivot = new THREE.Group();
    pivot.position.x = door.hinge === 'end' ? width / 2 : -width / 2;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.035), doorMaterial);
    panel.position.set(hingeDirection * width / 2, height / 2, 0);
    panel.castShadow = true;
    pivot.add(panel);
    group.add(pivot);
    meshes.push(panel);
    applyOpening = (opening) => {
      pivot.rotation.y = -Number(door.openSide ?? -1) * hingeDirection
        * Math.min(120, Math.max(0, opening)) * Math.PI / 180;
    };
  }
  const initialOpening = door.doorType === 'sliding'
    ? Math.min(100, Math.max(0, Number(door.openRatio) || 0))
    : Math.min(120, Math.max(0, Number(door.openAngle) || 0));
  const interactionPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  interactionPlane.position.y = height / 2;
  group.add(interactionPlane);
  meshes.push(interactionPlane);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const controller = {
    kind: 'door',
    structure: door,
    door,
    meshes,
    currentOpening: initialOpening,
    targetOpening: initialOpening,
    setOpening(opening) {
      this.targetOpening = opening;
      if (door.doorType === 'sliding') door.openRatio = opening;
      else door.openAngle = opening;
    },
    tick(delta) {
      const difference = this.targetOpening - this.currentOpening;
      if (reduceMotion || Math.abs(difference) < 0.05) {
        this.currentOpening = this.targetOpening;
      } else {
        this.currentOpening += difference * Math.min(1, delta * 8);
      }
      if (door.doorType === 'sliding') door.openRatio = this.currentOpening;
      else door.openAngle = this.currentOpening;
      applyOpening(this.currentOpening);
    },
  };
  meshes.forEach((mesh) => {
    mesh.userData.doorController = controller;
    mesh.userData.openingController = controller;
  });
  applyOpening(initialOpening);
  scene.add(group);
  return controller;
}

function buildWindowSash(scene, windowStructure, center, frameMaterial) {
  const width = windowStructure.width / 100;
  const height = windowStructure.height / 100;
  const sillHeight = windowStructure.sillHeight / 100;
  const direction = windowStructure.slideDirection === 'start' ? -1 : 1;
  const initialOpening = Math.min(100, Math.max(0, Number(windowStructure.openRatio) || 0));
  const panelWidth = width / 2;
  const group = new THREE.Group();
  group.position.set((windowStructure.x - center.x) / 100, sillHeight, (windowStructure.y - center.y) / 100);
  group.rotation.y = -structureAngle(windowStructure) * Math.PI / 180;
  const sashMaterial = material(0xe8ece9, 0.42, 0.34);
  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xb9dce8,
    roughness: 0.08,
    metalness: 0,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const bar = 0.045;
  const depth = 0.075;
  addBox(group, [width + bar * 2, bar, depth], [0, 0, 0], frameMaterial);
  addBox(group, [width + bar * 2, bar, depth], [0, height, 0], frameMaterial);
  [-1, 1].forEach((side) => addBox(group, [bar, height, depth], [side * (width / 2 + bar / 2), height / 2, 0], frameMaterial));

  const addPanel = (centerX, z) => {
    const panel = new THREE.Group();
    panel.position.set(centerX, 0, z);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(0.05, panelWidth - bar * 2), Math.max(0.05, height - bar * 2)), glassMaterial);
    glass.position.y = height / 2;
    panel.add(glass);
    addBox(panel, [panelWidth, bar, 0.035], [0, bar / 2, 0], sashMaterial);
    addBox(panel, [panelWidth, bar, 0.035], [0, height - bar / 2, 0], sashMaterial);
    [-1, 1].forEach((side) => addBox(panel, [bar, height, 0.035], [side * (panelWidth / 2 - bar / 2), height / 2, 0], sashMaterial));
    group.add(panel);
    return panel;
  };
  addPanel(direction * width / 4, -0.022);
  const movingPanel = addPanel(-direction * width / 4, 0.022);
  const interactionPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  interactionPlane.position.y = height / 2;
  interactionPlane.position.z = 0.045;
  group.add(interactionPlane);
  const applyOpening = (opening) => {
    const ratio = Math.min(100, Math.max(0, opening)) / 100;
    movingPanel.position.x = -direction * width / 4 + direction * width / 2 * ratio;
  };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const controller = {
    kind: 'window',
    structure: windowStructure,
    currentOpening: initialOpening,
    targetOpening: initialOpening,
    setOpening(opening) {
      this.targetOpening = opening;
      windowStructure.openRatio = opening;
    },
    tick(delta) {
      const difference = this.targetOpening - this.currentOpening;
      if (reduceMotion || Math.abs(difference) < 0.05) this.currentOpening = this.targetOpening;
      else this.currentOpening += difference * Math.min(1, delta * 8);
      windowStructure.openRatio = this.currentOpening;
      applyOpening(this.currentOpening);
    },
  };
  group.traverse((object) => {
    if (object.isMesh) object.userData.openingController = controller;
  });
  applyOpening(initialOpening);
  scene.add(group);
  return controller;
}

export function buildScene(scene, zones, items, structures, wallHeight, center, assets) {
  const wallHeightMeters = Math.max(wallHeight, ...zones.map((zone) => zone.height ?? wallHeight)) / 100;
  const toWorld = (x, y) => ({ x: (x - center.x) / 100, z: (y - center.y) / 100 });
  const wallMaterial = material(0xe8e4db, 0.9);
  const trimMaterial = material(0xf7f4ed, 0.78);
  const doorMaterial = material(0xb77857, 0.6);
  const ceilingMaterial = material(0xf1eee7, 0.96);
  const lightMaterial = new THREE.MeshStandardMaterial({
    color: 0xfff8e8,
    emissive: 0xffe6ad,
    emissiveIntensity: 1.8,
    roughness: 0.3,
  });

  zones.forEach((zone) => {
    const zoneHeightMeters = (zone.height ?? wallHeight) / 100;
    const world = toWorld(zone.x + zone.width / 2, zone.y + zone.depth / 2);
    const floor = new THREE.Mesh(
      zoneSurfaceGeometry(zone),
      new THREE.MeshStandardMaterial({ map: zone.floorMaterialId ? null : createFloorTexture(zone), roughness: 0.8, metalness: 0.01 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(world.x, 0, world.z);
    floor.receiveShadow = true;
    floor.userData = { type: 'floor', id: zone.id, name: zone.name };
    if (zone.floorMaterialId) assets.surface(floor.material, zone.floorMaterialId, zone.width / 100, zone.depth / 100, zone.name);
    scene.add(floor);

    const ceilingGeometry = zoneSurfaceGeometry(zone);
    // Mirror the source Y coordinates for the downward-facing ceiling rotation.
    if (zone.points) {
      ceilingGeometry.scale(1, -1, 1);
      const index = ceilingGeometry.index;
      for (let i = 0; i < index.count; i += 3) {
        const first = index.getX(i);
        index.setX(i, index.getX(i + 2));
        index.setX(i + 2, first);
      }
      ceilingGeometry.computeVertexNormals();
    }
    const ceiling = new THREE.Mesh(ceilingGeometry, ceilingMaterial);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(world.x, zoneHeightMeters, world.z);
    ceiling.receiveShadow = true;
    ceiling.userData = { type: 'ceiling', id: zone.id };
    scene.add(ceiling);

    const interior = zoneInteriorPoint(zone);
    const lightWorld = toWorld(interior.x, interior.y);
    const fixture = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.035, 32), lightMaterial);
    fixture.position.set(lightWorld.x, zoneHeightMeters - 0.025, lightWorld.z);
    fixture.rotation.x = Math.PI;
    fixture.userData = { type: 'ceiling-fixture', id: zone.id };
    scene.add(fixture);

    const light = new THREE.PointLight(0xffdfb0, 2.1, Math.max(zone.width, zone.depth) / 38, 2);
    light.position.set(lightWorld.x, zoneHeightMeters - 0.22, lightWorld.z);
    if (zone.type === '거실') {
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.bias = -0.002;
    }
    scene.add(light);
  });

  const doors = structures.filter((structure) => structure.type === 'door');
  const windows = structures.filter((structure) => structure.type === 'window');
  const openings = [...doors, ...windows];
  const userWalls = structures.filter((structure) => structure.type === 'wall');
  const automaticWallOpenings = (segment) => doorsForAutomaticWallSegment(segment, openings, userWalls);
  const buildWallRun = (
    segment,
    wallOpenings,
    heightMeters = wallHeightMeters,
    thickness = WALL_THICKNESS_M,
    dollhouseCutaway = false,
    owners = null,
  ) => {
    const frame = segmentFrame(segment);
    const wallFaces = Array(6).fill(wallMaterial);
    const reversedFace = segment.orientation === 'vertical' && frame.normal.x < 0;
    for (const [side, face] of [['positive', reversedFace ? 5 : 4], ['negative', reversedFace ? 4 : 5]]) {
      const zone = owners?.[side];
      if (zone?.wallMaterialId) {
        wallFaces[face] = material(0xe8e4db, 0.9);
        assets.surface(wallFaces[face], zone.wallMaterialId, frame.length / 100, heightMeters, zone.name);
      }
    }
    const runMaterial = owners ? wallFaces : wallMaterial;
    const layout = splitWallSegmentLocal(segment, wallOpenings);
    const piece = (span, height, elevation) => buildWallPiece(
      scene, span, center, height, elevation, runMaterial, trimMaterial, thickness, dollhouseCutaway,
    );
    layout.spans.forEach(span => piece(span, heightMeters, heightMeters / 2));
    layout.openings.forEach((opening) => {
      const openingSegment = {
        orientation: 'diagonal',
        x1: frame.start.x + frame.tangent.x * opening.start,
        y1: frame.start.y + frame.tangent.y * opening.start,
        x2: frame.start.x + frame.tangent.x * opening.end,
        y2: frame.start.y + frame.tangent.y * opening.end,
      };
      const openingBottom = opening.doors.length
        ? Math.min(...opening.doors.map(entry => entry.type === 'window' ? entry.sillHeight / 100 : 0)) : 0;
      const openingTop = Math.min(heightMeters, opening.doors.length
        ? Math.max(...opening.doors.map(entry => entry.type === 'window' ? (entry.sillHeight + entry.height) / 100 : entry.height / 100))
        : DOOR_HEIGHT_M);
      if (openingBottom > 0) piece(openingSegment, openingBottom, openingBottom / 2);
      const lintelHeight = Math.max(0, heightMeters - openingTop);
      const lintel = piece(openingSegment, lintelHeight, openingTop + lintelHeight / 2);
      const doorFramePart = opening.doors.some(({ type }) => type === 'door');
      if (lintel && doorFramePart) lintel.userData.doorFramePart = true;
      const endpoints = segmentEndpoints(openingSegment);
      [endpoints.start, endpoints.end].forEach((point) => {
        // Ownership seams clip the opening interval, but are not physical frame edges.
        if (opening.doors.length && !opening.doors.some(door => {
          const along = (point.x - door.x) * frame.tangent.x + (point.y - door.y) * frame.tangent.y;
          return Math.abs(Math.abs(along) - door.width / 2) < 1e-5;
        })) return;
        const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.055, openingTop - openingBottom, thickness + 0.035), trimMaterial);
        jamb.rotation.y = -frame.angle * Math.PI / 180;
        jamb.position.set((point.x - center.x) / 100, (openingBottom + openingTop) / 2, (point.y - center.y) / 100);
        jamb.userData = { type: 'wall-trim', dollhouseCutaway, doorFramePart };
        scene.add(jamb);
      });
    });
  };

  const buildWallSegment = (segment, openings, height, thickness, cutaway) => {
    const runs = studioWallRuns(segment, zones);
    // Keep the legacy wall/opening geometry intact until a finish is explicitly chosen.
    if (!zones.some(zone => zone.wallMaterialId)) {
      const first = scene.children.length;
      buildWallRun(segment, openings, height, thickness, cutaway);
      scene.children.slice(first).forEach(object => {
        if (object.userData.type === 'wall') object.userData.wallRuns = runs;
      });
      return;
    }
    runs.forEach(run => {
      const first = scene.children.length;
      buildWallRun(run.segment, openings, height, thickness, cutaway, run);
      scene.children.slice(first).forEach(object => {
        if (object.userData.type === 'wall') object.userData.wallRuns = [run];
      });
    });
  };

  getExteriorWallSegments(zones).forEach((segment) => buildWallSegment(
    segment,
    automaticWallOpenings(segment),
    wallHeightMeters,
    WALL_THICKNESS_M,
    isPositiveFacingExterior(segment, zones),
  ));
  getInteriorWallSegments(zones).forEach((segment) => buildWallSegment(segment, automaticWallOpenings(segment)));
  userWalls.forEach((wall) => {
    const first = scene.children.length;
    buildWallSegment(
      structureSegment(wall),
      openings.filter((opening) => opening.wallId === wall.id),
      wall.height / 100,
      Math.max(0.02, wall.thickness / 100),
    );
    scene.children.slice(first).forEach(object => { object.userData.structureId = wall.id; });
  });
  const doorControllers = doors.map((door) => buildDoorLeaf(scene, door, center, doorMaterial, trimMaterial));
  const windowControllers = windows.map((windowStructure) => buildWindowSash(scene, windowStructure, center, trimMaterial));

  let contactShadowMaterial;
  items.forEach((item) => {
    const group = item.assetId ? assets.furniture(item) : createFurnitureGroup(item);
    const world = toWorld(item.x, item.y);
    group.position.x = world.x;
    group.position.z = world.z;
    scene.add(group);

    if (item.type !== 'rug') {
      if (!contactShadowMaterial) {
        const pixels = new Uint8Array(64 * 64 * 4);
        for (let y = 0; y < 64; y++) {
          for (let x = 0; x < 64; x++) {
            const index = (y * 64 + x) * 4;
            const fade = Math.max(0, 1 - Math.hypot((x - 31.5) / 31.5, (y - 31.5) / 31.5));
            pixels.set([32, 35, 30, Math.round(fade * fade * 64)], index);
          }
        }
        const texture = new THREE.DataTexture(pixels, 64, 64);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = texture.magFilter = THREE.LinearFilter;
        texture.needsUpdate = true;
        contactShadowMaterial = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
      }
      const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        contactShadowMaterial,
      );
      shadow.scale.set((item.width + 16) / 100, 1, (item.depth + 16) / 100);
      shadow.rotation.y = -(item.rotation ?? 0) * Math.PI / 180;
      shadow.position.set(world.x, 0.006, world.z);
      shadow.userData = { type: 'furniture-shadow', id: item.id };
      scene.add(shadow);
    }
  });
  return [...doorControllers, ...windowControllers];
}

function findStartView(zones, items) {
  const preferred = zones.find((zone) => zone.walkthroughStart)
    ?? zones.find((zone) => zone.type === '거실')
    ?? zones[0];
  const orderedZones = preferred ? [preferred, ...zones.filter((zone) => zone.id !== preferred.id)] : zones;

  for (const zone of orderedZones) {
    const candidates = [
      [0.78, 0.2], [0.22, 0.2], [0.78, 0.78], [0.22, 0.78], [0.5, 0.5],
    ].map(([x, y]) => ({ x: zone.x + zone.width * x, y: zone.y + zone.depth * y }));
    candidates.push(zoneInteriorPoint(zone));
    const available = candidates.filter((point) =>
      isWalkablePoint(point, zones, CAMERA_RADIUS_CM)
      && !isPointBlockedByFurniture(point, items, CAMERA_RADIUS_CM, DEFAULT_EYE_HEIGHT_CM),
    );
    if (!available.length) continue;
    const point = available.reduce((best, candidate) => {
      const clearance = Math.min(...items.map((item) => Math.hypot(candidate.x - item.x, candidate.y - item.y)), 1000);
      return clearance > best.clearance ? { point: candidate, clearance } : best;
    }, { point: available[0], clearance: -1 }).point;
    const roomItems = items.filter((item) => pointInZone({ x: item.x, y: item.y }, zone));
    const target = roomItems.length ? {
      x: roomItems.reduce((sum, item) => sum + item.x, 0) / roomItems.length,
      y: roomItems.reduce((sum, item) => sum + item.y, 0) / roomItems.length,
    } : zoneInteriorPoint(zone);
    return { point, target };
  }

  const bounds = getLayoutBounds(zones);
  const point = preferred ? zoneInteriorPoint(preferred) : { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.depth / 2 };
  return { point, target: point };
}

function miniMapMarkup(zones, layout) {
  return `
    <div class="walkthrough-map-title"><span>LIVE PLAN</span><b><i>▲</i> 보는 방향</b></div>
    <svg viewBox="${layout.left - 20} ${layout.top - 20} ${layout.width + 40} ${layout.depth + 40}" aria-label="현재 위치 미니맵">
      ${zones.map((zone) => `<path d="M ${zonePoints(zone).map(point => `${point.x} ${point.y}`).join(' L ')} Z" fill="#d8d0bf" stroke="#756e60" stroke-width="3"></path>`).join('')}
      <text class="walkthrough-map-north" x="${layout.left + layout.width / 2}" y="${layout.top + 6}">N</text>
      <g data-map-player>
        <path class="walkthrough-view-cone" d="M 0 -8 L -42 -76 Q 0 -92 42 -76 Z"></path>
        <circle class="walkthrough-player-halo" r="25"></circle>
        <path class="walkthrough-heading-arrow" d="M 0 -43 L -11 -16 L 0 -22 L 11 -16 Z"></path>
        <circle class="walkthrough-player-dot" r="13"></circle>
      </g>
    </svg>`;
}

function focusTargetForSelection(focus, zones, items, structures, center, wallHeight) {
  if (!focus) return null;
  if (focus.kind === 'zone') {
    const zone = zones.find(({ id }) => id === focus.id);
    if (!zone) return null;
    const point = zoneInteriorPoint(zone);
    return {
      x: (point.x - center.x) / 100,
      y: Math.min(1.2, (zone.height ?? wallHeight) / 200),
      z: (point.y - center.y) / 100,
      name: zone.name,
    };
  }
  if (focus.kind === 'item') {
    const item = items.find(({ id }) => id === focus.id);
    if (!item) return null;
    return {
      x: (item.x - center.x) / 100,
      y: ((item.elevation ?? 0) + item.height / 2) / 100,
      z: (item.y - center.y) / 100,
      name: item.name,
    };
  }
  if (focus.kind === 'structure') {
    const structure = structures.find(({ id }) => id === focus.id);
    if (!structure) return null;
    return {
      x: (structure.x - center.x) / 100,
      y: Math.min(1.2, structure.height / 200),
      z: (structure.y - center.y) / 100,
      name: structure.name,
    };
  }
  return null;
}

export function openWalkthrough({
  zones,
  items,
  structures = [],
  wallHeight = 240,
  projectName = '내 공간',
  focus = null,
  initialMode = 'walk',
  initialView = null,
  onDoorChange = null,
  onStructureChange = onDoorChange,
  onClose = null,
  onSnapshot = null,
  getLayout = null,
  onEdit = null,
  onUndo = null,
  onRedo = null,
  historyState = null,
  furnitureTemplates = [],
}) {
  activeCleanup?.();
  if (initialView) {
    focus = initialView.selection;
    initialMode = initialView.mode;
  }

  const previousFocus = document.activeElement;
  const background = document.querySelector('#app');
  const previousInert = background?.inert;
  const previousHidden = background?.getAttribute('aria-hidden');
  zones = structuredClone(zones);
  items = structuredClone(items);
  let layout = getLayoutBounds(zones);
  let studioPanel = null;
  let editSession = null;
  let assetState = { pending: 0, errors: [] };
  let refreshAssetPresentation = () => {};
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const openingPromptCopy = coarsePointer ? '탭하여' : '클릭 또는 E로';
  const overlay = document.createElement('section');
  overlay.className = 'walkthrough-overlay is-workbench';
  overlay.dataset.walkthrough = 'true';
  overlay.innerHTML = `
    <div class="walkthrough-stage" data-walkthrough-stage></div>
    <div class="walkthrough-vignette"></div>
    <div class="walkthrough-curtain"></div>
    <header class="workbench-header">
      ${renderWorkbenchNavigation(projectName, 'studio')}
      <div class="workbench-utilities"><select data-studio-room aria-label="작업 공간 보기"></select><button type="button" data-save-snapshot>이미지 저장</button></div>
    </header>
    <div class="walkthrough-hud">
      <strong class="sr-only" data-current-room>불러오는 중</strong>
      <div class="sr-only" data-walkthrough-status role="status" aria-live="polite">둘러보기 준비</div>
      <div class="walkthrough-view-tools" aria-label="3D 보기 도구">
        <div class="walkthrough-view-modes">
          <button data-view-mode="dollhouse" type="button">입체 보기</button>
          <button data-view-mode="top" type="button">위에서</button>
          <button data-view-mode="walk" type="button">걸어보기</button>
        </div>
        <button data-walkthrough-more type="button" aria-expanded="false" aria-controls="walkthrough-more-panel">도구 더보기</button>
        <div class="walkthrough-more-panel" id="walkthrough-more-panel" data-walkthrough-more-panel role="group" aria-label="추가 3D 도구" hidden>
          <button data-toggle-ceiling type="button" aria-pressed="false">천장 숨기기</button>
          <button data-toggle-walls type="button" aria-pressed="true" aria-label="발표용 벽 낮추기" title="전체 보기·위에서 보기에서만 벽을 낮춰 표시합니다. 실제 벽 높이와 통행 충돌은 유지됩니다.">발표용 벽 낮추기</button>
          <button data-focus-selection type="button" ${focus ? '' : 'disabled'}>선택 보기</button>
        </div>
      </div>
      <div class="walkthrough-minimap" data-minimap>${miniMapMarkup(zones, layout)}</div>
      <div class="walkthrough-controls" data-walkthrough-controls>
        <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><small>이동</small></span>
        <em></em>
        <span><b class="mouse-icon"></b><small>드래그 시야 · 문/창 클릭</small></span>
        <em></em>
        <span><kbd>E</kbd><small>문·창 열기</small></span>
        <em></em>
        <span><kbd>ESC</kbd><small>일시 정지</small></span>
      </div>
      <div class="walkthrough-touch-controls" aria-label="모바일 3D 컨트롤">
        <button class="walkthrough-joystick" data-walkthrough-joystick type="button" aria-label="이동 조이스틱. 원하는 방향으로 밀어 이동">
          <span class="walkthrough-joystick-ring"><i data-joystick-knob></i></span>
          <small>이동</small>
        </button>
        <div class="walkthrough-look-guide" data-look-zone aria-hidden="true"><i></i><span>오른쪽 드래그<br><b>시야 이동</b></span></div>
      </div>
      <div class="walkthrough-door-prompt" aria-hidden="true"><span data-opening-prompt>문이나 창을 ${openingPromptCopy}</span><b>열기 · 닫기</b></div>
      <div class="sr-only" data-opening-status role="status" aria-live="polite"></div>
    </div>
    <div class="walkthrough-crosshair" aria-hidden="true"><i></i></div>
    <div class="walkthrough-room-toast" data-room-toast><span>NOW ENTERING</span><strong></strong></div>
    <div class="walkthrough-menu" data-walkthrough-menu>
      <span class="walkthrough-menu-kicker"><i></i> IMMERSIVE 3D WALKTHROUGH</span>
      <h2>당신의 공간 속으로<br><em>직접 들어가 보세요</em></h2>
      <p>도면으로는 알 수 없던 거리감과 가구의 실제 높이를<br>눈높이 시점에서 경험할 수 있습니다.</p>
      <div class="walkthrough-keys">
        <span><b class="key-cluster"><kbd>W</kbd><i><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></i></b><small>공간 이동</small></span>
        <span><b class="drag-gesture"><i></i></b><small>시선 이동</small></span>
        <span><b class="door-symbol"></b><small>문·창 클릭 · E 열기</small></span>
      </div>
      <button class="walkthrough-start" data-walkthrough-start type="button"><span>3D 둘러보기 시작</span><b>→</b></button>
      <button class="walkthrough-close-text" data-walkthrough-exit type="button">2D 편집으로 돌아가기</button>
    </div>`;
  const customFurniture = items.filter((item) => item.type === 'custom');
  if (customFurniture.length) {
    const furnitureSummary = document.createElement('p');
    furnitureSummary.className = 'sr-only';
    furnitureSummary.dataset.customFurnitureNames = 'true';
    furnitureSummary.textContent = `3D 커스텀 가구 이름표: ${customFurniture.map((item) => (
      typeof item.name === 'string' && item.name.trim() ? item.name : '커스텀 가구'
    )).join(', ')}`;
    overlay.append(furnitureSummary);
  }
  document.body.append(overlay);

  const stage = overlay.querySelector('[data-walkthrough-stage]');
  const menu = overlay.querySelector('[data-walkthrough-menu]');
  const status = overlay.querySelector('[data-walkthrough-status]');
  const openingStatus = overlay.querySelector('[data-opening-status]');
  const currentRoom = overlay.querySelector('[data-current-room]');
  let mapPlayer = overlay.querySelector('[data-map-player]');
  const roomToast = overlay.querySelector('[data-room-toast]');
  const openingPrompt = overlay.querySelector('[data-opening-prompt]');
  const joystick = overlay.querySelector('[data-walkthrough-joystick]');
  const joystickKnob = overlay.querySelector('[data-joystick-knob]');
  const ceilingButton = overlay.querySelector('[data-toggle-ceiling]');
  const wallButton = overlay.querySelector('[data-toggle-walls]');
  const focusButton = overlay.querySelector('[data-focus-selection]');
  const roomSelector = overlay.querySelector('[data-studio-room]');
  const focusedZone = focus?.kind === 'zone' && zones.find(zone => zone.id === focus.id);
  let focusedRoom = initialView?.roomId ?? (focusedZone ? spaceIdOf(focusedZone) : '');
  const sceneRooms = new Map();
  const syncRoomSelector = () => {
    const signature = JSON.stringify(zones.map(zone => [zone.id, spaceIdOf(zone), zone.name, zone.width, zone.depth]));
    if (roomSelector.dataset.signature !== signature) {
      roomSelector.dataset.signature = signature;
      sceneRooms.clear();
      for (const zone of zones) {
        const previous = sceneRooms.get(spaceIdOf(zone));
        if (!previous || zone.width * zone.depth > previous.width * previous.depth) sceneRooms.set(spaceIdOf(zone), zone);
      }
      roomSelector.replaceChildren(new Option('전체 공간', ''));
      for (const [id, zone] of sceneRooms) roomSelector.add(new Option(zone.name, id));
    }
    if (!sceneRooms.has(focusedRoom)) focusedRoom = '';
    roomSelector.value = focusedRoom;
    roomSelector.disabled = !zones.length;
    overlay.dataset.focusedRoom = focusedRoom;
  };
  syncRoomSelector();
  const moreButton = overlay.querySelector('[data-walkthrough-more]');
  const morePanel = overlay.querySelector('[data-walkthrough-more-panel]');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe6e9e7);
  const renderProfile = walkthroughRendererProfile(window.__roomStudioQaRenderProfile);
  const renderer = createWalkthroughRenderer(stage, overlay, renderProfile);
  renderer.domElement.dataset.walkthroughCanvas = 'true';
  renderer.domElement.setAttribute('role', 'application');
  renderer.domElement.setAttribute('aria-label', '3D 공간. 드래그하여 시야를 움직이고 문이나 창을 클릭하거나 E 키를 눌러 여닫습니다.');
  renderer.domElement.tabIndex = 0;
  stage.append(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(70, stage.clientWidth / stage.clientHeight, 0.05, 50);
  camera.rotation.order = 'YXZ';
  const center = { x: (layout.left + layout.right) / 2, y: (layout.top + layout.bottom) / 2 };
  let sceneStructures = structures.map((structure) => ({ ...structure }));
  let doors = sceneStructures.filter((structure) => structure.type === 'door');
  let userWalls = sceneStructures.filter((structure) => structure.type === 'wall');
  let interiorWalls = [
    ...getInteriorWallSegments(zones).flatMap((segment) => splitWallSegment(
      segment,
      doorsForAutomaticWallSegment(segment, doors, userWalls),
    ).spans),
    ...userWalls.flatMap((wall) => (
      splitWallSegment(structureSegment(wall), doors.filter((door) => door.wallId === wall.id)).spans
    )),
  ];
  let doorLeafSegments = getDoorLeafSegments(doors);
  let assetErrorVisible = false;
  const assets = createStudioAssets((state) => {
    assetState = state;
    overlay.dataset.assetState = state.errors.length ? 'error' : state.pending ? 'loading' : 'ready';
    studioPanel?.setAssets(state);
    if (state.errors.length) {
      assetErrorVisible = true;
      setStatusMessage(status, '에셋 로딩 실패 · 편집 패널에서 다시 불러오세요');
    } else if (!state.pending && assetErrorVisible) {
      assetErrorVisible = false;
      setStatusMessage(status, '에셋을 다시 불러왔습니다');
    }
    if (!state.pending) refreshAssetPresentation();
  });
  const worldRoot = new THREE.Group();
  scene.add(worldRoot);
  let openingControllers = buildScene(worldRoot, zones, items, sceneStructures, wallHeight, center, assets);
  let doorControllers = openingControllers.filter(({ kind }) => kind === 'door');
  const hasVisibleMaterial = material => (Array.isArray(material) ? material : [material]).some(
    entry => entry?.visible !== false && entry?.colorWrite !== false && entry?.opacity > 0,
  );
  overlay.dataset.doorControllerCount = String(doorControllers.length);
  overlay.dataset.visibleDoorMeshCount = String(doorControllers.reduce(
    (count, controller) => count + controller.meshes.filter(({ material }) => hasVisibleMaterial(material)).length,
    0,
  ));
  let visibleDoorFramePartCount = 0;
  scene.traverse((object) => {
    if (object.isMesh && object.userData.doorFramePart && hasVisibleMaterial(object.material)) visibleDoorFramePartCount += 1;
  });
  overlay.dataset.visibleDoorFramePartCount = String(visibleDoorFramePartCount);
  const furnitureLabels = [];
  const ceilingObjects = [];
  let wallPresentation = createWallPresentation(scene);
  scene.traverse((object) => {
    if (object.userData.type === 'furniture-label') furnitureLabels.push(object);
    if (object.userData.type === 'ceiling' || object.userData.type === 'ceiling-fixture' || object.isPointLight) ceilingObjects.push(object);
  });
  let selectedFocusTarget = focusTargetForSelection(focus, zones, items, sceneStructures, center, wallHeight);
  focusButton.disabled = !selectedFocusTarget;
  const labelWorldPosition = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  const rayPointer = new THREE.Vector2();
  scene.add(new THREE.HemisphereLight(0xf5f7f4, 0xb1aaa0, 1.8));
  scene.add(new THREE.AmbientLight(0xffffff, 0.3));
  const sun = new THREE.DirectionalLight(0xfff5e6, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0001;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 2;
  const updateDaylight = () => {
    const height = Math.max(wallHeight, ...zones.map(zone => zone.height ?? wallHeight)) / 100;
    const extent = Math.max(6, Math.hypot(layout.width, layout.depth) / 100);
    const shadowExtent = extent + height / 2;
    sun.position.set(-extent * 0.6, Math.max(6, height * 3), extent * 0.5);
    Object.assign(sun.shadow.camera, {
      left: -shadowExtent, right: shadowExtent, top: shadowExtent, bottom: -shadowExtent,
      near: 0.1, far: extent * 5 + height * 3,
    });
    sun.shadow.camera.updateProjectionMatrix();
  };
  updateDaylight();
  scene.add(sun, sun.target);

  const startView = findStartView(zones, items);
  const startZone = zones.find((zone) => pointInZone(startView.point, zone));
  const initialEyeHeightCm = Math.max(80, Math.min(DEFAULT_EYE_HEIGHT_CM, (startZone?.height ?? wallHeight) - 35));
  camera.position.set((startView.point.x - center.x) / 100, initialEyeHeightCm / 100, (startView.point.y - center.y) / 100);
  camera.lookAt(
    (startView.target.x - center.x) / 100,
    Math.min(1.18, initialEyeHeightCm / 100 - 0.1),
    (startView.target.y - center.y) / 100,
  );
  const walkPose = {
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
  };

  const keys = new Set();
  const velocity = new THREE.Vector3();
  const joystickState = { pointerId: null, x: 0, y: 0 };
  const resetJoystick = () => {
    joystickState.pointerId = null;
    joystickState.x = 0;
    joystickState.y = 0;
    joystick.classList.remove('is-active');
    joystickKnob.style.transform = 'translate(0px, 0px)';
  };
  const stopMovement = () => {
    keys.clear();
    velocity.set(0, 0, 0);
    resetJoystick();
  };
  const lookTarget = { yaw: camera.rotation.y, pitch: camera.rotation.x };
  let viewMode = 'walk';
  let ceilingsVisible = true;
  let presentationWalls = true;
  let overviewTarget = null;
  const overviewOrbitTarget = new THREE.Vector3();
  let overviewNavigated = false;
  let frameLoadedAssets = true;
  const overviewNavigation = createStudioNavigation({
    camera,
    target: overviewOrbitTarget,
    mode: () => viewMode,
    size: () => ({ width: stage.clientWidth, height: stage.clientHeight }),
    onChange: () => {
      overviewNavigated = true;
      overlay.dataset.cameraRevision = String(Number(overlay.dataset.cameraRevision ?? 0) + 1);
      if (focusedRoom) syncWallPresentation();
    },
  });
  let animationFrame = 0;
  let previousFrameTime = performance.now();
  let destroyed = false;
  let navigationActive = false;
  let draggingLook = false;
  let dragDistance = 0;
  let previousPointer = null;
  let pointerStart = null;
  let stepPhase = 0;
  let currentRoomId = null;
  let announcedOpeningId = null;
  let toastTimer = 0;
  let bumpTimer = 0;

  const syncViewToolState = () => {
    overlay.dataset.viewMode = viewMode;
    overlay.querySelectorAll('[data-view-mode]').forEach((button) => {
      const active = button.dataset.viewMode === viewMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    ceilingButton.setAttribute('aria-pressed', String(!ceilingsVisible));
    ceilingButton.textContent = ceilingsVisible ? '천장 숨기기' : '천장 보이기';
    wallButton.disabled = viewMode === 'walk';
    wallButton.setAttribute('aria-pressed', String(viewMode !== 'walk' && presentationWalls));
    wallButton.classList.toggle('is-active', viewMode !== 'walk' && presentationWalls);
  };
  const setCeilingsVisible = (visible) => {
    ceilingsVisible = Boolean(visible);
    ceilingObjects.forEach((object) => { object.visible = object.isPointLight ? viewMode === 'walk' : ceilingsVisible; });
    syncViewToolState();
  };
  const syncWallPresentation = () => {
    const active = wallPresentation.setMode(viewMode, presentationWalls,
      focusedRoom ? camera : null, focusedRoom ? overviewOrbitTarget : null);
    overlay.dataset.dollhouseCutaway = String(active);
    syncViewToolState();
  };
  const hideMenu = () => {
    const menuHadFocus = menu.contains(document.activeElement);
    menu.classList.add('is-hidden');
    menu.hidden = true;
    menu.inert = true;
    menu.setAttribute('aria-hidden', 'true');
    if (menuHadFocus) renderer.domElement.focus({ preventScroll: true });
  };
  const showMenu = () => {
    menu.hidden = false;
    menu.classList.remove('is-hidden');
    menu.inert = false;
    menu.setAttribute('aria-hidden', 'false');
    overlay.querySelector('[data-walkthrough-start]').focus({ preventScroll: true });
  };
  const setOverviewCamera = (mode, target = null) => {
    overviewTarget = target;
    const targetPoint = target ?? { x: 0, y: 0.65, z: 0, name: mode === 'top' ? '상공 보기' : '돌하우스 보기' };
    const meshes = overviewSpatialMeshes(scene);
    const points = !target && focusedRoom
      ? studioRoomPoints({ zones, items, structures: sceneStructures, wallHeight }, focusedRoom, center, meshes, presentationWalls && mode === 'top')
      : studioSpatialPoints(meshes);
    const bounds = new THREE.Box3().setFromPoints(points);
    if (bounds.isEmpty()) {
      bounds.set(
        new THREE.Vector3(-layout.width / 200, 0, -layout.depth / 200),
        new THREE.Vector3(layout.width / 200, wallHeight / 100, layout.depth / 200),
      );
    }
    fitOverviewCamera(camera, bounds, mode, target);
    overviewOrbitTarget.copy(target ? new THREE.Vector3(target.x, target.y, target.z) : bounds.getCenter(new THREE.Vector3()));
    if (!target) overviewOrbitTarget.copy(fitStudioCamera(camera, points, overviewOrbitTarget));
    overviewNavigated = false;
    frameLoadedAssets = true;
    currentRoom.textContent = sceneRooms.get(focusedRoom)?.name ?? targetPoint.name;
    syncWallPresentation();
  };
  const activateOverview = (mode, target = null) => {
    if (viewMode === 'walk') {
      walkPose.position.copy(camera.position);
      walkPose.quaternion.copy(camera.quaternion);
    }
    navigationActive = false;
    draggingLook = false;
    stopMovement();
    document.exitPointerLock?.();
    viewMode = mode;
    studioPanel?.setMode(mode);
    overlay.classList.add('is-active', 'is-overview');
    renderer.setSize(stage.clientWidth, stage.clientHeight, false);
    camera.aspect = stage.clientWidth / stage.clientHeight;
    setCeilingsVisible(false);
    syncWallPresentation();
    overviewNavigation.cancel();
    setOverviewCamera(mode, target);
    hideMenu();
    overlay.classList.remove('can-use-door');
    delete overlay.dataset.targetDoorId;
    delete overlay.dataset.targetWindowId;
    setStatusMessage(status, target?.name ? `${target.name} 바로 보기` : mode === 'top' ? '상공 시점' : '돌하우스 시점');
    previousFrameTime = performance.now();
    syncViewToolState();
  };

  const cameraPoint = (position) => ({ x: position.x * 100 + center.x, y: position.z * 100 + center.y });
  const canMoveTo = (position) => {
    const point = cameraPoint(position);
    return isWalkablePoint(point, zones, CAMERA_RADIUS_CM)
      && !isPointBlockedByFurniture(point, items, CAMERA_RADIUS_CM, camera.position.y * 100)
      && !isPointBlockedByInteriorWall(point, interiorWalls, CAMERA_RADIUS_CM)
      && !isPointBlockedByDoorLeaves(point, doorLeafSegments, CAMERA_RADIUS_CM);
  };
  const tryMove = (movement) => {
    let moved = false;
    const nextX = camera.position.clone();
    nextX.x += movement.x;
    if (canMoveTo(nextX)) { camera.position.x = nextX.x; moved = true; }
    const nextZ = camera.position.clone();
    nextZ.z += movement.z;
    if (canMoveTo(nextZ)) { camera.position.z = nextZ.z; moved = true; }
    if (!moved && movement.lengthSq() > 0.00001) {
      status.textContent = '가구 또는 벽이 가까워요';
      overlay.classList.add('is-bumped');
      clearTimeout(bumpTimer);
      bumpTimer = window.setTimeout(() => {
        overlay.classList.remove('is-bumped');
        if (navigationActive) setStatusMessage(status, '자유롭게 둘러보는 중');
      }, 650);
    }
    return moved;
  };
  const applyLookDelta = (deltaX, deltaY) => {
    lookTarget.yaw -= deltaX * 0.0028;
    lookTarget.pitch = Math.max(-1.05, Math.min(0.86, lookTarget.pitch - deltaY * 0.0028));
  };
  const openingAt = (clientX, clientY) => {
    if (!openingControllers.length) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    rayPointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(rayPointer, camera);
    return pickWalkthroughOpening(raycaster, scene);
  };
  const interactWithOpening = (clientX, clientY) => {
    const hit = openingAt(clientX, clientY);
    if (!hit || hit.structure.locked) return false;
    const isWindow = hit.kind === 'window';
    const isSliding = isWindow || hit.structure.doorType === 'sliding';
    const opening = hit.targetOpening > 5 ? 0 : isSliding ? 100 : 90;
    const updates = isSliding ? { openRatio: opening } : { openAngle: opening };
    try {
      if (editSession) {
        if (!editSession.preview({ type: 'update-structure', id: hit.structure.id, updates })) return false;
        editSession.commit();
      } else {
        onStructureChange?.(hit.structure.id, updates);
        hit.setOpening(opening);
      }
    } catch (error) {
      editSession?.cancel();
      setStatusMessage(status, `문·창 변경 실패 · ${error.message}`);
      return false;
    }
    const action = opening > 0 ? '열었습니다' : '닫았습니다';
    const label = isWindow ? '미닫이창을' : isSliding ? '미닫이문을' : '여닫이문을';
    setStatusMessage(status, `${label} ${action}`);
    if (isWindow) overlay.dataset.lastWindowAction = `${hit.structure.id}:${opening}`;
    else overlay.dataset.lastDoorAction = `${hit.structure.id}:${opening}`;
    return true;
  };
  const interactWithCenteredOpening = () => {
    const rect = renderer.domElement.getBoundingClientRect();
    return interactWithOpening(rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  const onKeyDown = (event) => {
    if (!overlay.isConnected) return;
    if (event.target instanceof Element && event.target.matches('input, select, textarea')) return;
    if (event.code === 'Escape' && (editSession?.pending || editDrag)) {
      event.preventDefault();
      editDrag = null;
      editPointers.clear();
      overviewNavigation.cancel();
      studioPanel.cancel();
      return;
    }
    if (event.code === 'KeyE' && navigationActive) {
      event.preventDefault();
      if (event.repeat) return;
      if (!interactWithCenteredOpening()) status.textContent = '가까운 문이나 창을 화면 중앙에 맞춰 주세요';
      return;
    }
    if (event.code === 'Escape' && overlay.classList.contains('is-active')) {
      pauseNavigation();
      return;
    }
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
      event.preventDefault();
      if (navigationActive) keys.add(event.code);
    }
  };
  const onKeyUp = (event) => keys.delete(event.code);
  const onResize = () => {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    // Panel/viewport transitions can briefly collapse the stage before layout settles.
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (viewMode !== 'walk' && !overviewNavigated && !editDrag) setOverviewCamera(viewMode, overviewTarget);
  };
  // Observe the actual scene viewport, not only the window or the supporting panel.
  const stageResizeObserver = new ResizeObserver(onResize);
  stageResizeObserver.observe(stage);
  const activateNavigation = () => {
    if (viewMode === 'walk') {
      walkPose.position.copy(camera.position);
      walkPose.quaternion.copy(camera.quaternion);
    }
    viewMode = 'walk';
    editDrag = null;
    overviewNavigation.cancel();
    studioPanel?.setMode('walk');
    overlay.classList.remove('is-overview');
    onResize();
    camera.up.set(0, 1, 0);
    camera.fov = 70;
    camera.far = 50;
    camera.position.copy(walkPose.position);
    camera.quaternion.copy(walkPose.quaternion);
    camera.updateProjectionMatrix();
    lookTarget.yaw = camera.rotation.y;
    lookTarget.pitch = camera.rotation.x;
    setCeilingsVisible(true);
    syncWallPresentation();
    navigationActive = true;
    hideMenu();
    overlay.classList.add('is-active');
    overlay.classList.remove('is-overview');
    setStatusMessage(status, '자유롭게 둘러보는 중');
    previousFrameTime = performance.now();
    syncViewToolState();
    renderer.domElement.focus({ preventScroll: true });
  };
  const pauseNavigation = () => {
    if (viewMode === 'walk') {
      walkPose.position.copy(camera.position);
      walkPose.quaternion.copy(camera.quaternion);
    }
    navigationActive = false;
    draggingLook = false;
    overviewNavigation.cancel();
    studioPanel?.setMode('walk');
    showMenu();
    overlay.classList.remove('is-active', 'is-overview', 'can-use-door');
    status.textContent = '일시 정지';
    stopMovement();
    document.exitPointerLock?.();
    menu.querySelector('[data-walkthrough-start]').focus({ preventScroll: true });
  };
  const selectionRing = new THREE.LineLoop(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x18201d, depthTest: false }),
  );
  selectionRing.frustumCulled = false;
  selectionRing.renderOrder = 5;
  selectionRing.visible = false;
  scene.add(selectionRing);
  const transformTools = document.createElement('div');
  transformTools.className = 'studio-transform-overlay';
  transformTools.hidden = true;
  transformTools.innerHTML = `
    <output class="studio-transform-readout" data-studio-transform-readout></output>
    <button type="button" data-studio-handle="rotate" aria-label="가구 회전 손잡이. 끌어서 회전하거나 Enter로 15도 회전" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg></button>
    <button type="button" data-studio-handle="resize" aria-label="가구 크기 손잡이. 끌어서 조절하거나 Enter로 가로 세로 10cm 늘리기" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m18 8v5h-5M3 3l7 7m11 11l-7-7"/></svg></button>`;
  stage.append(transformTools);
  const transformReadout = transformTools.querySelector('[data-studio-transform-readout]');
  const rotationHandle = transformTools.querySelector('[data-studio-handle="rotate"]');
  const resizeHandle = transformTools.querySelector('[data-studio-handle="resize"]');
  const itemPoint = (item, x, y) => {
    const angle = THREE.MathUtils.degToRad(item.rotation ?? 0);
    return {
      x: item.x + x * Math.cos(angle) - y * Math.sin(angle),
      y: item.y + x * Math.sin(angle) + y * Math.cos(angle),
    };
  };
  const updateTransformControls = () => {
    const item = studioPanel?.selection?.kind === 'item' ? studioPanel.current : null;
    const mode = studioPanel?.transformMode ?? 'move';
    const visible = Boolean(item && !item.locked && viewMode !== 'walk'
      && (mode !== 'move' || editDrag?.moved));
    if (transformTools.hidden === visible) transformTools.hidden = !visible;
    if (!visible) return;
    const width = stage.clientWidth, height = stage.clientHeight;
    const project = (point, elevation) => {
      const projected = new THREE.Vector3(
        (point.x - center.x) / 100, elevation / 100, (point.y - center.y) / 100,
      ).project(camera);
      return { x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2 };
    };
    const top = project(item, (item.elevation ?? 0) + item.height);
    const corner = project(itemPoint(item, item.width / 2, item.depth / 2), item.elevation ?? 0);
    const position = (node, point, offsetY = 0) => {
      const x = THREE.MathUtils.clamp(point.x, 22, width - 22);
      const y = THREE.MathUtils.clamp(point.y + offsetY, 22, height - 22);
      const value = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      if (node.style.transform !== value) node.style.transform = value;
    };
    if (rotationHandle.hidden !== (mode !== 'rotate')) rotationHandle.hidden = mode !== 'rotate';
    if (resizeHandle.hidden !== (mode !== 'resize')) resizeHandle.hidden = mode !== 'resize';
    position(rotationHandle, top, -44);
    position(resizeHandle, corner);
    const label = mode === 'rotate'
      ? `${Math.round(item.rotation ?? 0)}°`
      : `${Math.round(item.width)} × ${Math.round(item.depth)} cm`;
    if (transformReadout.textContent !== label) transformReadout.textContent = label;
    position(transformReadout, { x: THREE.MathUtils.clamp(top.x, 96, width - 96), y: top.y }, mode === 'rotate' ? -80 : -36);
  };
  const updateSelection = (selection = studioPanel?.selection ?? focus) => {
    focus = selection;
    selectedFocusTarget = focusTargetForSelection(selection, zones, items, sceneStructures, center, wallHeight);
    focusButton.disabled = !selectedFocusTarget;
    const item = selection?.kind === 'item' ? items.find(item => item.id === selection.id) : null;
    const zone = selection?.kind === 'zone' ? zones.find(zone => zone.id === selection.id) : null;
    const structure = selection?.kind === 'structure' ? sceneStructures.find(entry => entry.id === selection.id) : null;
    selectionRing.visible = Boolean(onEdit && (item || zone || structure) && viewMode !== 'walk');
    if (item || zone || structure) {
      const bounds = structure && structureBounds(structure);
      const outline = item
        ? [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => itemPoint(item, x * item.width / 2, y * item.depth / 2))
        : zone ? zonePoints(zone)
          : [{ x: bounds.left, y: bounds.top }, { x: bounds.right, y: bounds.top },
            { x: bounds.right, y: bounds.bottom }, { x: bounds.left, y: bounds.bottom }];
      const bottom = item?.elevation ?? structure?.sillHeight ?? 0;
      if (selectionRing.geometry.getAttribute('position')?.count !== outline.length) {
        selectionRing.geometry.dispose();
        selectionRing.geometry = new THREE.BufferGeometry();
      }
      selectionRing.geometry.setFromPoints(outline.map(point =>
        new THREE.Vector3((point.x - center.x) / 100, bottom / 100 + 0.01, (point.y - center.y) / 100)));
    }
    updateTransformControls();
  };
  const geometryKey = value => JSON.stringify({
    ...value,
    items: value.items.map(({x, y, rotation, elevation, ...item}) => item),
    structures: value.structures.map(({openAngle, openRatio, ...structure}) => structure),
  });
  let sceneKey = geometryKey({ zones, items, structures, wallHeight });
  const refreshLayout = (next, force = false) => {
    if (destroyed || !next) return;
    const nextKey = geometryKey({ zones: next.zones, items: next.items, structures: next.structures ?? [], wallHeight: next.wallHeight ?? wallHeight });
    const outlineChanged = JSON.stringify(zones.map(zonePoints)) !== JSON.stringify(next.zones.map(zonePoints));
    if (!outlineChanged && nextKey !== sceneKey) frameLoadedAssets = false;
    zones = structuredClone(next.zones);
    items = structuredClone(next.items);
    wallHeight = next.wallHeight ?? wallHeight;
    layout = getLayoutBounds(zones);
    syncRoomSelector();
    if (force || nextKey !== sceneKey) {
      sceneKey = nextKey;
      updateDaylight();
      wallPresentation.dispose();
      disposeStudioScene(worldRoot);
      assets.begin();
      worldRoot.clear();
      sceneStructures = structuredClone(next.structures ?? []);
      doors = sceneStructures.filter(structure => structure.type === 'door');
      userWalls = sceneStructures.filter(structure => structure.type === 'wall');
      interiorWalls = [
        ...getInteriorWallSegments(zones).flatMap(segment => splitWallSegment(segment, doorsForAutomaticWallSegment(segment, doors, userWalls)).spans),
        ...userWalls.flatMap(wall => splitWallSegment(structureSegment(wall), doors.filter(door => door.wallId === wall.id)).spans),
      ];
      doorLeafSegments = getDoorLeafSegments(doors);
      openingControllers = buildScene(worldRoot, zones, items, sceneStructures, wallHeight, center, assets);
      doorControllers = openingControllers.filter(({kind}) => kind === 'door');
      wallPresentation = createWallPresentation(scene);
      furnitureLabels.length = 0;
      ceilingObjects.length = 0;
      scene.traverse(object => {
        if (object.userData.type === 'furniture-label') furnitureLabels.push(object);
        if (['ceiling', 'ceiling-fixture'].includes(object.userData.type) || object.isPointLight) ceilingObjects.push(object);
      });
      setCeilingsVisible(ceilingsVisible);
      syncWallPresentation();
      overlay.querySelector('[data-minimap]').innerHTML = miniMapMarkup(zones, layout);
      mapPlayer = overlay.querySelector('[data-map-player]');
      assets.finish();
    } else {
      openingControllers.forEach(controller => {
        const current = next.structures?.find(structure => structure.id === controller.structure.id);
        if (current) controller.setOpening(controller.kind === 'window' || current.doorType === 'sliding' ? current.openRatio ?? 0 : current.openAngle ?? 0);
      });
      worldRoot.children.forEach(object => {
        if (!['furniture', 'furniture-shadow'].includes(object.userData.type)) return;
        const item = items.find(item => item.id === object.userData.id);
        object.position.x = (item.x - center.x) / 100;
        object.position.z = (item.y - center.y) / 100;
        object.rotation.y = -(item.rotation ?? 0) * Math.PI / 180;
        if (object.userData.type === 'furniture') {
          object.position.y = (item.elevation ?? 0) / 100;
        }
      });
    }
    overlay.dataset.doorControllerCount = String(doorControllers.length);
    overlay.dataset.windowControllerCount = String(openingControllers.filter(controller => controller.kind === 'window').length);
    overlay.dataset.visibleDoorMeshCount = String(doorControllers.reduce((count, controller) => count + controller.meshes.filter(mesh => hasVisibleMaterial(mesh.material)).length, 0));
    let frameParts = 0;
    worldRoot.traverse(object => { if (object.userData.doorFramePart && hasVisibleMaterial(object.material)) frameParts++; });
    overlay.dataset.visibleDoorFramePartCount = String(frameParts);
    if (outlineChanged) {
      const pose = viewMode === 'walk' ? camera.position : walkPose.position;
      if (!isWalkablePoint(cameraPoint(pose), zones, CAMERA_RADIUS_CM)) {
        const start = findStartView(zones, items);
        pose.x = (start.point.x - center.x) / 100;
        pose.z = (start.point.y - center.y) / 100;
        walkPose.position.copy(pose);
      }
      if (viewMode !== 'walk') setOverviewCamera(viewMode);
    }
    updateSelection();
    studioPanel?.sync();
    overlay.dataset.sceneRevision = String(Number(overlay.dataset.sceneRevision ?? 0) + 1);
  };
  refreshAssetPresentation = () => {
    if (destroyed) return;
    wallPresentation.dispose();
    wallPresentation = createWallPresentation(scene);
    syncWallPresentation();
    updateSelection();
    if (viewMode !== 'walk' && !editDrag && !overviewNavigated && frameLoadedAssets) setOverviewCamera(viewMode, overviewTarget);
  };
  const editPointers = new Set();
  let editDrag = null;
  let editTap = null;
  const setEditRay = (event) => {
    const rect = renderer.domElement.getBoundingClientRect();
    rayPointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    scene.updateMatrixWorld(true);
    raycaster.setFromCamera(rayPointer, camera);
  };
  const groundPoint = (event, elevation = 0) => {
    setEditRay(event);
    const point = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -elevation / 100), new THREE.Vector3());
    return point ? { x: point.x * 100 + center.x, y: point.z * 100 + center.y } : null;
  };
  const pickEditable = (event) => {
    setEditRay(event);
    for (const hit of raycaster.intersectObjects(worldRoot.children, true)) {
      let object = hit.object, invisible = false, furniture = null;
      for (let ancestor = object; ancestor; ancestor = ancestor.parent) {
        if (!ancestor.visible) invisible = true;
        if (ancestor.userData.type === 'furniture') furniture = ancestor;
      }
      if (invisible || ['furniture-shadow','furniture-label'].includes(object.userData.type)) continue;
      const hitMaterial = Array.isArray(object.material) ? object.material[hit.face.materialIndex] : object.material;
      if (hitMaterial.clippingPlanes?.some(plane => plane.distanceToPoint(hit.point) < 0)) continue;
      if (furniture) return { kind: 'item', id: furniture.userData.id };
      if (object.userData.openingController) return { kind: 'structure', id: object.userData.openingController.structure.id };
      if (object.userData.structureId) {
        return { kind: 'structure', id: object.userData.structureId };
      }
      if (object.userData.type === 'floor') return { kind: 'zone', id: object.userData.id, surface: 'floor' };
      if (object.userData.type === 'wall') {
        const runs = object.userData.wallRuns ?? [];
        const run = runs.find(run => {
          const frame = segmentFrame(run.segment);
          const along = (hit.point.x * 100 + center.x - frame.start.x) * frame.tangent.x
            + (hit.point.z * 100 + center.y - frame.start.y) * frame.tangent.y;
          return along >= -1 && along <= frame.length + 1;
        });
        if (run) {
          const reversedFace = run.segment.orientation === 'vertical' && segmentFrame(run.segment).normal.x < 0;
          const positive = hit.face.materialIndex === (reversedFace ? 5 : 4);
          const zone = (positive ? run.positive : run.negative) ?? run.positive ?? run.negative;
          if (zone) return { kind: 'zone', id: zone.id, surface: 'wall' };
        }
      }
    }
    return null;
  };
  const onTouchStart = (event) => {
    // Keep native flings from consuming the first toolbar tap after a camera drag.
    if (event.cancelable) event.preventDefault();
  };
  const onPointerDown = (event) => {
    if (viewMode !== 'walk' && [0, 1, 2].includes(event.button)) {
      editPointers.add(event.pointerId);
      renderer.domElement.setPointerCapture?.(event.pointerId);
      if (editPointers.size > 1) {
        const editDragging = Boolean(editDrag?.moved);
        editDrag = null;
        editTap = null;
        // Camera contacts must not discard an unrelated numeric/placement preview.
        if (editSession?.pending && editDragging) studioPanel?.cancel();
        overviewNavigation.down(event);
        return;
      }
      const selection = studioPanel && event.button === 0 && !event.shiftKey ? pickEditable(event) : null;
      editTap = null;
      if (studioPanel && event.button === 0 && !event.shiftKey) {
        if (['item', 'structure'].includes(selection?.kind)) studioPanel.select(selection);
        else editTap = { id: event.pointerId, selection, x: event.clientX, y: event.clientY };
      }
      const item = studioPanel?.current;
      const point = groundPoint(event);
      if (['item', 'structure'].includes(selection?.kind) && !item.locked && point) {
        editDrag = { id: event.pointerId, x: item.x, y: item.y, point, clientX: event.clientX, clientY: event.clientY, moved: false };
      }
      overviewNavigation.down(event, ['item', 'structure'].includes(selection?.kind));
      renderer.domElement.focus({ preventScroll: true });
      return;
    }
    if (!navigationActive || event.button !== 0) return;
    if (document.pointerLockElement === renderer.domElement) {
      pointerStart = { locked: true };
      dragDistance = 0;
      return;
    }
    const rect = renderer.domElement.getBoundingClientRect();
    const touchLikePointer = event.pointerType === 'touch' || event.pointerType === 'pen';
    draggingLook = !touchLikePointer || event.clientX >= rect.left + rect.width * 0.42;
    dragDistance = 0;
    previousPointer = { x: event.clientX, y: event.clientY };
    pointerStart = { x: event.clientX, y: event.clientY, pointerType: event.pointerType };
    renderer.domElement.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event) => {
    if (editTap?.id === event.pointerId
      && Math.hypot(event.clientX - editTap.x, event.clientY - editTap.y) >= 4) editTap = null;
    if (editDrag?.id === event.pointerId) {
      overviewNavigation.move(event);
      if (Math.hypot(event.clientX - editDrag.clientX, event.clientY - editDrag.clientY) < 4 && !editDrag.moved) return;
      const point = groundPoint(event, editDrag.item?.elevation ?? 0);
      if (point) {
        editDrag.moved = true;
        if (editDrag.mode === 'rotate') {
          studioPanel.transform({ rotation: rotationFromPointer(
            editDrag.item, editDrag.item.rotation ?? 0, editDrag.point, point, event.shiftKey ? 15 : 1,
          ) });
        } else if (editDrag.mode === 'resize') {
          const resized = resizeItemFromHandle(editDrag.item, 'se', {
            x: editDrag.corner.x + point.x - editDrag.point.x,
            y: editDrag.corner.y + point.y - editDrag.point.y,
          }, 20, 600);
          const { x, y, width, depth, shape } = resized;
          studioPanel.transform({ x, y, width, depth, shape });
        } else {
          studioPanel.move(snap(editDrag.x + point.x - editDrag.point.x, 1), snap(editDrag.y + point.y - editDrag.point.y, 1));
        }
      }
      return;
    }
    if (viewMode !== 'walk' && overviewNavigation.move(event)) return;
    if (document.pointerLockElement === renderer.domElement) {
      applyLookDelta(event.movementX, event.movementY);
      return;
    }
    if (!previousPointer) return;
    const deltaX = event.clientX - previousPointer.x;
    const deltaY = event.clientY - previousPointer.y;
    dragDistance += Math.abs(deltaX) + Math.abs(deltaY);
    previousPointer = { x: event.clientX, y: event.clientY };
    if (draggingLook) applyLookDelta(deltaX, deltaY);
  };
  const requestCanvasPointerLock = () => {
    if (!renderer.domElement.isConnected || renderer.domElement.ownerDocument !== document || !document.hasFocus()) {
      setStatusMessage(status, '드래그로 시야를 조작하세요');
      return;
    }
    try {
      const request = renderer.domElement.requestPointerLock?.();
      request?.catch?.(() => setStatusMessage(status, '드래그로 시야를 조작하세요'));
    } catch {
      setStatusMessage(status, '드래그로 시야를 조작하세요');
    }
  };
  const onPointerUp = (event) => {
    if (editPointers.has(event.pointerId)) {
      // A release can carry movement that was not dispatched as pointermove.
      if (event.type === 'pointerup') onPointerMove(event);
      editPointers.delete(event.pointerId);
      overviewNavigation.up(event);
      const drag = editDrag;
      editDrag = null;
      if (drag?.id === event.pointerId) {
        // Release leaves a visible draft; only the explicit Apply control writes history.
        if (event.type !== 'pointerup') studioPanel.cancel();
      }
      if (editTap?.id === event.pointerId) {
        const tap = editTap;
        editTap = null;
        // A surface becomes a selection only after a tap, never while starting camera navigation.
        if (event.type === 'pointerup' && (tap.selection || !editSession?.pending)) studioPanel.select(tap.selection);
      }
      return;
    }
    const pointerLocked = document.pointerLockElement === renderer.domElement;
    const wasTap = event.type === 'pointerup' && pointerStart && (pointerLocked || dragDistance < 8);
    const usedOpening = wasTap && (pointerLocked
      ? interactWithCenteredOpening()
      : interactWithOpening(event.clientX, event.clientY));
    if (wasTap && !usedOpening && !pointerLocked && pointerStart.pointerType === 'mouse') {
      requestCanvasPointerLock();
    }
    draggingLook = false;
    previousPointer = null;
    pointerStart = null;
  };

  const onOverviewWheel = (event) => {
    if (viewMode === 'walk') return;
    event.preventDefault();
    overviewNavigation.wheel(event);
  };
  const onOverviewContextMenu = (event) => {
    if (viewMode !== 'walk') event.preventDefault();
  };
  const onTransformDown = (event) => {
    const handle = event.target.closest('[data-studio-handle]');
    const item = studioPanel?.current;
    if (!handle || event.button !== 0 || !item || item.locked) return;
    event.preventDefault();
    if (editPointers.size) {
      onPointerDown(event);
      return;
    }
    const point = groundPoint(event, item.elevation ?? 0);
    if (!point) return;
    editPointers.add(event.pointerId);
    handle.setPointerCapture(event.pointerId);
    handle.focus({ preventScroll: true });
    editDrag = {
      id: event.pointerId, mode: handle.dataset.studioHandle, item: structuredClone(item),
      point, corner: itemPoint(item, item.width / 2, item.depth / 2),
      clientX: event.clientX, clientY: event.clientY, moved: false,
    };
    overviewNavigation.down(event, true);
  };
  const onTransformClick = (event) => {
    const handle = event.target.closest('[data-studio-handle]');
    const item = studioPanel?.current;
    if (event.detail !== 0 || !handle || !item || item.locked) return;
    if (handle.dataset.studioHandle === 'rotate') {
      studioPanel.transform({ rotation: ((item.rotation ?? 0) + 15) % 360 });
    } else {
      const { x, y, width, depth, shape } = resizeItemFromHandle(
        item, 'se', itemPoint(item, item.width / 2 + 10, item.depth / 2 + 10), 20, 600,
      );
      studioPanel.transform({ x, y, width, depth, shape });
    }
  };

  const updateJoystick = (clientX, clientY) => {
    const rect = joystick.getBoundingClientRect();
    const radius = rect.width * 0.31;
    let x = clientX - (rect.left + rect.width / 2);
    let y = clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(x, y);
    if (distance > radius) {
      x = x / distance * radius;
      y = y / distance * radius;
    }
    joystickState.x = x / radius;
    joystickState.y = y / radius;
    joystickKnob.style.transform = `translate(${x}px, ${y}px)`;
  };
  const onJoystickDown = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!navigationActive || joystickState.pointerId !== null) return;
    joystickState.pointerId = event.pointerId;
    joystick.classList.add('is-active');
    joystick.setPointerCapture?.(event.pointerId);
    updateJoystick(event.clientX, event.clientY);
  };
  const onJoystickMove = (event) => {
    if (event.pointerId !== joystickState.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    updateJoystick(event.clientX, event.clientY);
  };
  const onJoystickEnd = (event) => {
    if (joystickState.pointerId !== null && event.pointerId !== joystickState.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    resetJoystick();
    velocity.set(0, 0, 0);
  };
  const onPointerLockChange = () => {
    overlay.classList.toggle('has-pointer-lock', document.pointerLockElement === renderer.domElement);
  };
  const onFullscreenChange = () => {
    onResize();
    if (!document.fullscreenElement && navigationActive) pauseNavigation();
  };

  const announceRoom = (room) => {
    if (!room) return;
    if (currentRoom.textContent !== room.name) currentRoom.textContent = room.name;
    if (spaceIdOf(room) === currentRoomId) return;
    currentRoomId = spaceIdOf(room);
    roomToast.querySelector('strong').textContent = room.name;
    roomToast.classList.remove('is-visible');
    requestAnimationFrame(() => roomToast.classList.add('is-visible'));
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => roomToast.classList.remove('is-visible'), 1800);
  };

  const animate = (frameTime = performance.now()) => {
    if (destroyed) return;
    animationFrame = requestAnimationFrame(animate);
    const delta = Math.min((frameTime - previousFrameTime) / 1000, 0.05);
    previousFrameTime = frameTime;
    if (viewMode === 'walk') {
      camera.rotation.y += (lookTarget.yaw - camera.rotation.y) * Math.min(1, delta * 18);
      camera.rotation.x += (lookTarget.pitch - camera.rotation.x) * Math.min(1, delta * 18);
    }
    openingControllers.forEach((controller) => controller.tick(delta));
    doorLeafSegments = getDoorLeafSegments(doors);

    let walking = false;
    if (navigationActive) {
      const direction = camera.getWorldDirection(new THREE.Vector3());
      direction.y = 0;
      direction.normalize();
      const right = new THREE.Vector3().crossVectors(direction, camera.up).normalize();
      const desired = new THREE.Vector3();
      const forwardAmount = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0)
        - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - joystickState.y;
      const rightAmount = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0)
        - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) + joystickState.x;
      desired.addScaledVector(direction, forwardAmount);
      desired.addScaledVector(right, rightAmount);
      if (desired.lengthSq() > 1) desired.normalize();
      desired.multiplyScalar(MOVE_SPEED_MPS);
      velocity.lerp(desired, 1 - Math.exp(-delta * 11));
      if (velocity.lengthSq() > 0.002) {
        walking = tryMove(velocity.clone().multiplyScalar(delta));
        stepPhase += delta * 10.5;
      }
    } else {
      velocity.multiplyScalar(Math.max(0, 1 - delta * 12));
    }

    if (viewMode === 'walk') {
      const point = cameraPoint(camera.position);
      const room = zones.find((zone) => pointInZone(point, zone));
      const roomEyeHeightCm = Math.max(80, Math.min(DEFAULT_EYE_HEIGHT_CM, (room?.height ?? wallHeight) - 35));
      const bob = walking ? Math.sin(stepPhase) * 0.012 : 0;
      camera.position.y += (roomEyeHeightCm / 100 + bob - camera.position.y) * Math.min(1, delta * 14);
      announceRoom(room);
      if (!room) currentRoom.textContent = '공간 경계';
      const viewDirection = camera.getWorldDirection(new THREE.Vector3());
      const mapAngle = Math.atan2(viewDirection.x, -viewDirection.z) * 180 / Math.PI;
      mapPlayer.setAttribute('transform', `translate(${point.x} ${point.y}) rotate(${mapAngle})`);
      const canvasRect = renderer.domElement.getBoundingClientRect();
      const centeredOpening = openingAt(canvasRect.left + canvasRect.width / 2, canvasRect.top + canvasRect.height / 2);
      overlay.classList.toggle('can-use-door', Boolean(centeredOpening));
      if (centeredOpening) {
        const targetLabel = centeredOpening.kind === 'window' ? '창' : '문';
        const openingId = `${centeredOpening.kind}:${centeredOpening.structure.id}`;
        openingPrompt.textContent = `${targetLabel}을 ${openingPromptCopy}`;
        if (announcedOpeningId !== openingId) {
          announcedOpeningId = openingId;
          openingStatus.textContent = `${targetLabel}을 열거나 닫을 수 있습니다. ${coarsePointer ? '화면 중앙을 탭하세요.' : '클릭하거나 E 키를 누르세요.'}`;
        }
        if (centeredOpening.kind === 'window') {
          overlay.dataset.targetWindowId = centeredOpening.structure.id;
          delete overlay.dataset.targetDoorId;
        } else {
          overlay.dataset.targetDoorId = centeredOpening.structure.id;
          delete overlay.dataset.targetWindowId;
        }
      } else {
        openingPrompt.textContent = `문이나 창을 ${openingPromptCopy}`;
        if (announcedOpeningId !== null) {
          announcedOpeningId = null;
          openingStatus.textContent = '';
        }
        delete overlay.dataset.targetDoorId;
        delete overlay.dataset.targetWindowId;
      }
      furnitureLabels.forEach((label) => {
        const distance = camera.position.distanceTo(label.getWorldPosition(labelWorldPosition));
        const distanceOpacity = Math.max(0, Math.min(1, (distance - 0.7) / 0.9));
        label.material.opacity = centeredOpening ? Math.min(distanceOpacity, 0.2) : distanceOpacity;
        label.visible = label.material.opacity > 0.04;
      });
    } else {
      overlay.classList.remove('can-use-door');
      delete overlay.dataset.targetDoorId;
      delete overlay.dataset.targetWindowId;
      furnitureLabels.forEach((label) => { label.visible = false; });
    }
    selectionRing.visible = Boolean(onEdit && selectedFocusTarget && focus && ['item','zone','structure'].includes(focus.kind) && viewMode !== 'walk');
    updateTransformControls();
    renderer.render(scene, camera);
  };

  const saveSnapshot = () => {
    const wasSelected = selectionRing.visible;
    selectionRing.visible = false;
    renderer.render(scene, camera);
    renderer.domElement.toBlob((blob) => {
      if (!blob) {
        status.textContent = 'PNG 저장을 준비하지 못했습니다';
        return;
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `room-studio-3d-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.png`;
      anchor.click();
      URL.revokeObjectURL(url);
      overlay.dataset.lastSnapshot = 'png';
      setStatusMessage(status, '현재 3D 화면을 PNG로 저장했습니다');
    }, 'image/png');
    selectionRing.visible = wasSelected;
  };

  const cleanup = () => {
    if (destroyed) return;
    const view = {
      mode: viewMode,
      roomId: focusedRoom,
      selection: focus && { ...focus },
      panelOpen: studioPanel?.expanded,
      presentationWalls,
      target: overviewTarget && { ...overviewTarget },
      position: camera.position.toArray(),
      quaternion: camera.quaternion.toArray(),
      up: camera.up.toArray(),
      orbitTarget: overviewOrbitTarget.toArray(),
      walkPosition: walkPose.position.toArray(),
      walkQuaternion: walkPose.quaternion.toArray(),
      fov: camera.fov,
      zoom: camera.zoom,
      far: camera.far,
    };
    let snapshotError;
    try {
      if (onSnapshot && !editSession?.pending && !assetState.pending && !assetState.errors.length) {
        // Complete opening animation at its committed value before taking the scene-only image.
        openingControllers.forEach(controller => { controller.currentOpening = controller.targetOpening; controller.tick(0); });
        selectionRing.visible = false;
        renderer.render(scene, camera);
        const image = document.createElement('canvas');
        const scale = Math.min(1, 720 / Math.max(renderer.domElement.width, renderer.domElement.height));
        image.width = Math.max(1, Math.round(renderer.domElement.width * scale));
        image.height = Math.max(1, Math.round(renderer.domElement.height * scale));
        image.getContext('2d').drawImage(renderer.domElement, 0, 0, image.width, image.height);
        onSnapshot({
          layout: structuredClone(getLayout?.() ?? editSession?.layout ?? { zones, items, structures, wallHeight }),
          imageDataUrl: image.toDataURL('image/jpeg', 0.82),
        });
      }
    } catch (error) {
      // Consumer/canvas errors must not leak a WebGL context or leave the editor inert.
      snapshotError = error;
    }
    destroyed = true;
    cancelAnimationFrame(animationFrame);
    clearTimeout(toastTimer);
    clearTimeout(bumpTimer);
    window.removeEventListener('resize', onResize);
    compactToolsQuery.removeEventListener('change', syncToolLocation);
    stageResizeObserver.disconnect();
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    renderer.domElement.removeEventListener('touchstart', onTouchStart);
    renderer.domElement.removeEventListener('wheel', onOverviewWheel);
    renderer.domElement.removeEventListener('contextmenu', onOverviewContextMenu);
    overviewNavigation.cancel();
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointermove', onPointerMove);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    renderer.domElement.removeEventListener('pointercancel', onPointerUp);
    renderer.domElement.removeEventListener('lostpointercapture', onPointerUp);
    transformTools.removeEventListener('touchstart', onTouchStart);
    transformTools.removeEventListener('pointerdown', onTransformDown);
    transformTools.removeEventListener('pointermove', onPointerMove);
    transformTools.removeEventListener('pointerup', onPointerUp);
    transformTools.removeEventListener('pointercancel', onPointerUp);
    transformTools.removeEventListener('lostpointercapture', onPointerUp);
    transformTools.removeEventListener('click', onTransformClick);
    joystick.removeEventListener('pointerdown', onJoystickDown);
    joystick.removeEventListener('pointermove', onJoystickMove);
    joystick.removeEventListener('pointerup', onJoystickEnd);
    joystick.removeEventListener('pointercancel', onJoystickEnd);
    joystick.removeEventListener('lostpointercapture', onJoystickEnd);
    stopMovement();
    studioPanel?.dispose();
    wallPresentation.dispose();
    disposeStudioScene(scene);
    assets.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    document.exitPointerLock?.();
    if (document.fullscreenElement === overlay) document.exitFullscreen().catch(() => {});
    overlay.remove();
    if (activeCleanup === cleanup) activeCleanup = null;
    if (background) {
      background.inert = previousInert;
      if (previousHidden === null) background.removeAttribute('aria-hidden');
      else background.setAttribute('aria-hidden', previousHidden);
    }
    if (onClose) onClose(view);
    else previousFocus?.focus({ preventScroll: true });
    if (snapshotError) throw snapshotError;
  };
  activeCleanup = cleanup;
  cleanup.refresh = (next = getLayout?.()) => {
    if (editSession) editSession.refresh(next);
    else refreshLayout(next);
  };

  window.addEventListener('resize', onResize);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  renderer.domElement.addEventListener('touchstart', onTouchStart, { passive: false });
  renderer.domElement.addEventListener('wheel', onOverviewWheel, { passive: false });
  renderer.domElement.addEventListener('contextmenu', onOverviewContextMenu);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointercancel', onPointerUp);
  renderer.domElement.addEventListener('lostpointercapture', onPointerUp);
  transformTools.addEventListener('touchstart', onTouchStart, { passive: false });
  transformTools.addEventListener('pointerdown', onTransformDown);
  transformTools.addEventListener('pointermove', onPointerMove);
  transformTools.addEventListener('pointerup', onPointerUp);
  transformTools.addEventListener('pointercancel', onPointerUp);
  transformTools.addEventListener('lostpointercapture', onPointerUp);
  transformTools.addEventListener('click', onTransformClick);
  joystick.addEventListener('pointerdown', onJoystickDown);
  joystick.addEventListener('pointermove', onJoystickMove);
  joystick.addEventListener('pointerup', onJoystickEnd);
  joystick.addEventListener('pointercancel', onJoystickEnd);
  joystick.addEventListener('lostpointercapture', onJoystickEnd);
  const setMoreOpen = (open) => {
    morePanel.hidden = !open;
    moreButton.setAttribute('aria-expanded', String(open));
    moreButton.focus({ preventScroll: true });
    if (open) stopMovement();
  };
  const toolUtilities = overlay.querySelector('.workbench-utilities');
  const toolHeader = toolUtilities.parentElement;
  const compactToolsQuery = window.matchMedia('(max-width: 900px) and (max-height: 500px) and (orientation: portrait)');
  const syncToolLocation = () => {
    (compactToolsQuery.matches ? morePanel : toolHeader).append(toolUtilities);
    moreButton.textContent = compactToolsQuery.matches ? '방·보기' : '도구 더보기';
  };
  compactToolsQuery.addEventListener('change', syncToolLocation);
  syncToolLocation();
  moreButton.addEventListener('click', () => setMoreOpen(morePanel.hidden));
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      const scope = menu.hidden ? overlay : menu;
      const controls = [...scope.querySelectorAll('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
        .filter((node) => node.getClientRects().length && !node.closest('[inert]'));
      const current = controls.indexOf(document.activeElement);
      const next = event.shiftKey
        ? (current <= 0 ? controls.length - 1 : current - 1)
        : (current + 1) % controls.length;
      event.preventDefault();
      event.stopPropagation();
      controls[next]?.focus({ preventScroll: true });
      return;
    }
    if (morePanel.hidden) return;
    if (event.code === 'Escape') {
      event.preventDefault();
      setMoreOpen(false);
    }
    // Enter/Space activate tools without triggering editor or walk shortcuts.
    event.stopPropagation();
  });
  overlay.querySelectorAll('[data-view-mode]').forEach((button) => button.addEventListener('click', () => {
    if (!morePanel.hidden) setMoreOpen(false);
    if (button.dataset.viewMode === 'walk') activateNavigation();
    else activateOverview(button.dataset.viewMode);
  }));
  ceilingButton.addEventListener('click', () => setCeilingsVisible(!ceilingsVisible));
  wallButton.addEventListener('click', () => {
    presentationWalls = !presentationWalls;
    syncWallPresentation();
    if (viewMode !== 'walk') setOverviewCamera(viewMode, overviewTarget);
  });
  focusButton.addEventListener('click', () => {
    if (!selectedFocusTarget) return;
    const selected = studioPanel?.current;
    const room = focus?.kind === 'zone' ? selected
      : selected && zones.find(zone => pointInZone(selected, zone));
    if (room) {
      focusedRoom = spaceIdOf(room);
      syncRoomSelector();
      activateOverview('dollhouse');
    } else activateOverview('dollhouse', selectedFocusTarget);
  });
  roomSelector.addEventListener('change', () => {
    focusedRoom = roomSelector.value;
    const room = sceneRooms.get(focusedRoom);
    if (room && !editSession?.pending) studioPanel?.select({ kind: 'zone', id: room.id, surface: 'floor' });
    studioPanel?.setRoom(room?.id ?? null);
    syncRoomSelector();
    activateOverview(viewMode === 'top' ? 'top' : 'dollhouse');
  });
  overlay.querySelector('[data-save-snapshot]').addEventListener('click', saveSnapshot);
  overlay.querySelector('[data-walkthrough-start]').addEventListener('click', async () => {
    if (overlay.requestFullscreen && !document.fullscreenElement) {
      try {
        await overlay.requestFullscreen();
      } catch {
        // The fixed overlay already fills the browser when native fullscreen is unavailable.
      }
    }
    activateNavigation();
  });
  overlay.querySelectorAll('[data-walkthrough-exit]').forEach((button) => button.addEventListener('click', cleanup));
  if (onEdit) {
    const showEditError = error => setStatusMessage(status, `변경을 적용하지 못했습니다 · ${error.message}`);
    editSession = createStudioEditSession({ layout: { zones, items, structures, wallHeight }, getLayout, onEdit, onPreview: refreshLayout });
    studioPanel = createStudioPanel({ overlay, session: editSession, focus, furnitureTemplates, onSelection: updateSelection, onTransformMode: updateTransformControls, onResize, onUndo, onRedo, historyState, onError: showEditError });
    studioPanel.setRoom(sceneRooms.get(focusedRoom)?.id ?? null);
    studioPanel.onRetry(() => refreshLayout(editSession.layout, true));
    studioPanel.setAssets(assetState);
    studioPanel.setMode(initialMode);
    import('./studio3d.css').then(() => {
      if (destroyed) return;
      studioPanel.reveal();
      onResize();
      overlay.dataset.studioReady = 'true';
    }).catch(showEditError);
  }
  assets.finish();
  if (initialMode === 'dollhouse' || initialMode === 'top') {
    activateOverview(initialMode);
  } else {
    syncViewToolState();
  }
  if (initialView) {
    if (initialMode === 'walk') activateNavigation();
    presentationWalls = initialView.presentationWalls;
    overviewTarget = initialView.target;
    overviewOrbitTarget.fromArray(initialView.orbitTarget);
    camera.position.fromArray(initialView.position);
    camera.quaternion.fromArray(initialView.quaternion);
    camera.up.fromArray(initialView.up);
    camera.fov = initialView.fov;
    camera.zoom = initialView.zoom;
    camera.far = initialView.far;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    syncWallPresentation();
    walkPose.position.fromArray(initialView.walkPosition);
    walkPose.quaternion.fromArray(initialView.walkQuaternion);
    lookTarget.yaw = camera.rotation.y;
    lookTarget.pitch = camera.rotation.x;
    overviewNavigated = true;
    if (typeof initialView.panelOpen === 'boolean') studioPanel?.setExpanded(initialView.panelOpen);
    overlay.dataset.restoredView = 'true';
  }
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '3D 공간 미리보기');
  if (background) {
    background.inert = true;
    background.setAttribute('aria-hidden', 'true');
  }
  const initialControl = menu.hidden
    ? overlay.querySelector('[data-view-mode][aria-pressed="true"]')
    : overlay.querySelector('[data-walkthrough-start]');
  initialControl.focus({ preventScroll: true });
  overlay.dataset.walkthroughReady = 'true';
  requestAnimationFrame(() => overlay.classList.add('is-ready'));
  animate();
  return cleanup;
}
