import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  doorsForAutomaticWallSegment,
  getExteriorWallSegments,
  getDoorLeafSegments,
  getInteriorWallSegments,
  getLayoutBounds,
  isPointBlockedByFurniture,
  isPointBlockedByDoorLeaves,
  isPointBlockedByInteriorWall,
  isWalkablePoint,
  pointInZone,
  splitWallSegment,
  spaceIdOf,
  structureSegment,
} from './geometry.js';

const DEFAULT_EYE_HEIGHT_CM = 165;
const CAMERA_RADIUS_CM = 18;
const MOVE_SPEED_MPS = 2.25;
const WALL_THICKNESS_M = 0.06;
const DOOR_HEIGHT_M = 2.05;
let activeCleanup = null;

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
    context.fillStyle = zone.type === '욕실' ? '#b9c8c8' : '#d3d0c7';
    context.fillRect(0, 0, 512, 512);
    context.strokeStyle = 'rgba(255,255,255,.72)';
    context.lineWidth = 5;
    for (let position = 0; position <= 512; position += 128) {
      context.beginPath(); context.moveTo(position, 0); context.lineTo(position, 512); context.stroke();
      context.beginPath(); context.moveTo(0, position); context.lineTo(512, position); context.stroke();
    }
  } else {
    context.fillStyle = zone.type === '거실' ? '#ad855f' : '#b99670';
    context.fillRect(0, 0, 512, 512);
    for (let row = 0; row < 8; row += 1) {
      for (let column = -1; column < 5; column += 1) {
        const x = column * 128 + (row % 2) * 64;
        const y = row * 64;
        const shade = (row * 17 + column * 23 + 80) % 28;
        context.fillStyle = `rgba(255,245,225,${0.025 + shade / 800})`;
        context.fillRect(x + 2, y + 2, 124, 60);
        context.strokeStyle = 'rgba(74,45,24,.22)';
        context.lineWidth = 2;
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
  texture.repeat.set(Math.max(1, zone.width / 320), Math.max(1, zone.depth / 320));
  texture.anisotropy = 8;
  return texture;
}

function buildWallPiece(scene, orientation, start, end, fixed, height, centerHeight, wallMaterial, trimMaterial, thickness = WALL_THICKNESS_M) {
  const length = Math.max(0, end - start) / 100;
  if (length <= 0.01 || height <= 0.01) return;
  const horizontal = orientation === 'horizontal';
  const geometry = new THREE.BoxGeometry(
    horizontal ? length : thickness,
    height,
    horizontal ? thickness : length,
  );
  const wall = new THREE.Mesh(geometry, wallMaterial);
  wall.position.set(
    horizontal ? (start + end) / 200 : fixed / 100,
    centerHeight,
    horizontal ? fixed / 100 : (start + end) / 200,
  );
  wall.castShadow = true;
  wall.receiveShadow = true;
  wall.userData = { type: 'wall' };
  scene.add(wall);

  if (centerHeight === height / 2 && height > 1) {
    const baseboard = new THREE.Mesh(new THREE.BoxGeometry(
      horizontal ? length : thickness + 0.035,
      0.09,
      horizontal ? thickness + 0.035 : length,
    ), trimMaterial);
    baseboard.position.set(wall.position.x, 0.045, wall.position.z);
    baseboard.receiveShadow = true;
    scene.add(baseboard);
  }
}

function buildDoorLeaf(scene, door, center, doorMaterial, frameMaterial) {
  const width = door.width / 100;
  const height = door.height / 100;
  const group = new THREE.Group();
  const meshes = [];
  group.position.set((door.x - center.x) / 100, 0, (door.y - center.y) / 100);
  group.rotation.y = door.orientation === 'vertical' ? -Math.PI / 2 : 0;
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
  group.rotation.y = windowStructure.orientation === 'vertical' ? -Math.PI / 2 : 0;
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

function buildScene(scene, zones, items, structures, wallHeight, center) {
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
      new THREE.PlaneGeometry(zone.width / 100, zone.depth / 100),
      new THREE.MeshStandardMaterial({ map: createFloorTexture(zone), roughness: 0.8, metalness: 0.01 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(world.x, 0, world.z);
    floor.receiveShadow = true;
    floor.userData = { type: 'floor', id: zone.id, name: zone.name };
    scene.add(floor);

    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(zone.width / 100, zone.depth / 100), ceilingMaterial);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(world.x, zoneHeightMeters, world.z);
    ceiling.receiveShadow = true;
    scene.add(ceiling);

    const fixture = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.035, 32), lightMaterial);
    fixture.position.set(world.x, zoneHeightMeters - 0.025, world.z);
    fixture.rotation.x = Math.PI;
    scene.add(fixture);

    const light = new THREE.PointLight(0xffdfb0, 2.1, Math.max(zone.width, zone.depth) / 38, 2);
    light.position.set(world.x, zoneHeightMeters - 0.22, world.z);
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
  const buildWallSegment = (segment, wallOpenings, heightMeters = wallHeightMeters, thickness = WALL_THICKNESS_M) => {
    const horizontal = segment.orientation === 'horizontal';
    const fixed = (horizontal ? segment.y : segment.x) - (horizontal ? center.y : center.x);
    const axisCenter = horizontal ? center.x : center.y;
    const layout = splitWallSegment(segment, wallOpenings);
    layout.spans.forEach((span) => {
      const start = (horizontal ? span.x1 : span.y1) - axisCenter;
      const end = (horizontal ? span.x2 : span.y2) - axisCenter;
      buildWallPiece(scene, segment.orientation, start, end, fixed, heightMeters, heightMeters / 2, wallMaterial, trimMaterial, thickness);
    });
    layout.openings.forEach((opening) => {
      const openingStart = opening.start - axisCenter;
      const openingEnd = opening.end - axisCenter;
      const openingBottom = opening.doors.length
        ? Math.min(...opening.doors.map((entry) => entry.type === 'window' ? entry.sillHeight / 100 : 0))
        : 0;
      const openingTop = Math.min(heightMeters, opening.doors.length
        ? Math.max(...opening.doors.map((entry) => entry.type === 'window' ? (entry.sillHeight + entry.height) / 100 : entry.height / 100))
        : DOOR_HEIGHT_M);
      if (openingBottom > 0) {
        buildWallPiece(scene, segment.orientation, openingStart, openingEnd, fixed, openingBottom, openingBottom / 2, wallMaterial, trimMaterial, thickness);
      }
      const lintelHeight = Math.max(0, heightMeters - openingTop);
      buildWallPiece(scene, segment.orientation, openingStart, openingEnd, fixed, lintelHeight, openingTop + lintelHeight / 2, wallMaterial, trimMaterial, thickness);
      const trimDepth = thickness + 0.035;
      [openingStart, openingEnd].forEach((doorEdge) => {
        const jamb = new THREE.Mesh(new THREE.BoxGeometry(
          horizontal ? 0.055 : trimDepth,
          openingTop - openingBottom,
          horizontal ? trimDepth : 0.055,
        ), trimMaterial);
        jamb.position.set(horizontal ? doorEdge / 100 : fixed / 100, openingBottom + (openingTop - openingBottom) / 2, horizontal ? fixed / 100 : doorEdge / 100);
        scene.add(jamb);
      });
    });
  };

  getExteriorWallSegments(zones).forEach((segment) => buildWallSegment(segment, automaticWallOpenings(segment)));
  getInteriorWallSegments(zones).forEach((segment) => buildWallSegment(segment, automaticWallOpenings(segment)));
  userWalls.forEach((wall) => {
    buildWallSegment(
      structureSegment(wall),
      openings.filter((opening) => opening.wallId === wall.id),
      wall.height / 100,
      Math.max(0.02, wall.thickness / 100),
    );
  });
  const doorControllers = doors.map((door) => buildDoorLeaf(scene, door, center, doorMaterial, trimMaterial));
  const windowControllers = windows.map((windowStructure) => buildWindowSash(scene, windowStructure, center, trimMaterial));

  items.forEach((item) => {
    const group = createFurnitureGroup(item);
    const world = toWorld(item.x, item.y);
    group.position.x = world.x;
    group.position.z = world.z;
    scene.add(group);

    if (item.type !== 'rug') {
      const shadow = new THREE.Mesh(
        new THREE.CircleGeometry(Math.max(item.width, item.depth) / 190, 32),
        new THREE.MeshBasicMaterial({ color: 0x30281e, transparent: true, opacity: 0.08, depthWrite: false }),
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.scale.z = Math.max(0.45, item.depth / item.width);
      shadow.position.set(world.x, 0.006, world.z);
      scene.add(shadow);
    }
  });
  return [...doorControllers, ...windowControllers];
}

function findStartView(zones, items) {
  const preferred = zones.find((zone) => zone.type === '거실') ?? zones[0];
  const orderedZones = preferred ? [preferred, ...zones.filter((zone) => zone.id !== preferred.id)] : zones;

  for (const zone of orderedZones) {
    const candidates = [
      [0.78, 0.2], [0.22, 0.2], [0.78, 0.78], [0.22, 0.78], [0.5, 0.5],
    ].map(([x, y]) => ({ x: zone.x + zone.width * x, y: zone.y + zone.depth * y }));
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
    } : { x: zone.x + zone.width / 2, y: zone.y + zone.depth / 2 };
    return { point, target };
  }

  const bounds = getLayoutBounds(zones);
  const point = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.depth / 2 };
  return { point, target: point };
}

function miniMapMarkup(zones, layout) {
  return `
    <div class="walkthrough-map-title"><span>LIVE PLAN</span><b><i>▲</i> 보는 방향</b></div>
    <svg viewBox="${layout.left - 20} ${layout.top - 20} ${layout.width + 40} ${layout.depth + 40}" aria-label="현재 위치 미니맵">
      ${zones.map((zone) => `<rect x="${zone.x}" y="${zone.y}" width="${zone.width}" height="${zone.depth}"></rect>`).join('')}
      <text class="walkthrough-map-north" x="${layout.left + layout.width / 2}" y="${layout.top + 6}">N</text>
      <g data-map-player>
        <path class="walkthrough-view-cone" d="M 0 -8 L -42 -76 Q 0 -92 42 -76 Z"></path>
        <circle class="walkthrough-player-halo" r="25"></circle>
        <path class="walkthrough-heading-arrow" d="M 0 -43 L -11 -16 L 0 -22 L 11 -16 Z"></path>
        <circle class="walkthrough-player-dot" r="13"></circle>
      </g>
    </svg>`;
}

export function openWalkthrough({ zones, items, structures = [], wallHeight = 240, onDoorChange = null, onStructureChange = onDoorChange }) {
  activeCleanup?.();

  const layout = getLayoutBounds(zones);
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const openingPromptCopy = coarsePointer ? '탭하여' : '클릭 또는 E로';
  const overlay = document.createElement('section');
  overlay.className = 'walkthrough-overlay';
  overlay.dataset.walkthrough = 'true';
  overlay.innerHTML = `
    <div class="walkthrough-stage" data-walkthrough-stage></div>
    <div class="walkthrough-vignette"></div>
    <div class="walkthrough-curtain"></div>
    <div class="walkthrough-hud">
      <div class="walkthrough-location"><span>NOW EXPLORING</span><strong data-current-room>불러오는 중</strong><small>직접 걸으며 배치를 확인하세요</small></div>
      <div class="walkthrough-status" data-walkthrough-status role="status" aria-live="polite"><i></i> 둘러보기 준비</div>
      <button class="walkthrough-exit" data-walkthrough-exit type="button" aria-label="3D 둘러보기 닫기"><span>나가기</span>×</button>
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
  const mapPlayer = overlay.querySelector('[data-map-player]');
  const roomToast = overlay.querySelector('[data-room-toast]');
  const openingPrompt = overlay.querySelector('[data-opening-prompt]');
  const joystick = overlay.querySelector('[data-walkthrough-joystick]');
  const joystickKnob = overlay.querySelector('[data-joystick-knob]');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcbd2d1);
  scene.fog = new THREE.FogExp2(0xcbd2d1, 0.025);
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(stage.clientWidth, stage.clientHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.domElement.dataset.walkthroughCanvas = 'true';
  renderer.domElement.setAttribute('role', 'application');
  renderer.domElement.setAttribute('aria-label', '3D 공간. 드래그하여 시야를 움직이고 문이나 창을 클릭하거나 E 키를 눌러 여닫습니다.');
  renderer.domElement.tabIndex = 0;
  stage.append(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(70, stage.clientWidth / stage.clientHeight, 0.05, 50);
  camera.rotation.order = 'YXZ';
  const center = { x: (layout.left + layout.right) / 2, y: (layout.top + layout.bottom) / 2 };
  const sceneStructures = structures.map((structure) => ({ ...structure }));
  const doors = sceneStructures.filter((structure) => structure.type === 'door');
  const userWalls = sceneStructures.filter((structure) => structure.type === 'wall');
  const interiorWalls = [
    ...getInteriorWallSegments(zones).flatMap((segment) => splitWallSegment(
      segment,
      doorsForAutomaticWallSegment(segment, doors, userWalls),
    ).spans),
    ...userWalls.flatMap((wall) => (
      splitWallSegment(structureSegment(wall), doors.filter((door) => door.wallId === wall.id)).spans
    )),
  ];
  let doorLeafSegments = getDoorLeafSegments(doors);
  const openingControllers = buildScene(scene, zones, items, sceneStructures, wallHeight, center);
  const furnitureLabels = [];
  scene.traverse((object) => {
    if (object.userData.type === 'furniture-label') furnitureLabels.push(object);
  });
  const labelWorldPosition = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  const rayPointer = new THREE.Vector2();
  scene.add(new THREE.HemisphereLight(0xe7f0f4, 0x5f574c, 1.2));
  scene.add(new THREE.AmbientLight(0xfffbf2, 0.3));
  const sun = new THREE.DirectionalLight(0xfff1d7, 0.85);
  sun.position.set(-4, 7, 3);
  scene.add(sun);

  const startView = findStartView(zones, items);
  const startZone = zones.find((zone) => pointInZone(startView.point, zone));
  const initialEyeHeightCm = Math.max(80, Math.min(DEFAULT_EYE_HEIGHT_CM, (startZone?.height ?? wallHeight) - 35));
  camera.position.set((startView.point.x - center.x) / 100, initialEyeHeightCm / 100, (startView.point.y - center.y) / 100);
  camera.lookAt(
    (startView.target.x - center.x) / 100,
    Math.min(1.18, initialEyeHeightCm / 100 - 0.1),
    (startView.target.y - center.y) / 100,
  );

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
        if (navigationActive) status.innerHTML = '<i></i> 자유롭게 둘러보는 중';
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
    const intersection = raycaster.intersectObjects(scene.children, true)
      .find((entry) => entry.distance <= 4);
    return intersection?.object.userData.openingController ?? null;
  };
  const interactWithOpening = (clientX, clientY) => {
    const hit = openingAt(clientX, clientY);
    if (!hit) return false;
    const isWindow = hit.kind === 'window';
    const isSliding = isWindow || hit.structure.doorType === 'sliding';
    const opening = hit.targetOpening > 5 ? 0 : isSliding ? 100 : 90;
    hit.setOpening(opening);
    onStructureChange?.(hit.structure.id, isSliding ? { openRatio: opening } : { openAngle: opening });
    const action = opening > 0 ? '열었습니다' : '닫았습니다';
    const label = isWindow ? '미닫이창을' : isSliding ? '미닫이문을' : '여닫이문을';
    status.innerHTML = `<i></i> ${label} ${action}`;
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
    if (event.code === 'KeyE' && navigationActive) {
      event.preventDefault();
      if (event.repeat) return;
      if (!interactWithCenteredOpening()) status.textContent = '가까운 문이나 창을 화면 중앙에 맞춰 주세요';
      return;
    }
    if (event.code === 'Escape' && navigationActive) {
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
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const activateNavigation = () => {
    navigationActive = true;
    menu.classList.add('is-hidden');
    menu.inert = true;
    menu.setAttribute('aria-hidden', 'true');
    overlay.classList.add('is-active');
    status.innerHTML = '<i></i> 자유롭게 둘러보는 중';
    previousFrameTime = performance.now();
    renderer.domElement.focus({ preventScroll: true });
  };
  const pauseNavigation = () => {
    if (!navigationActive) return;
    navigationActive = false;
    draggingLook = false;
    menu.classList.remove('is-hidden');
    menu.inert = false;
    menu.setAttribute('aria-hidden', 'false');
    overlay.classList.remove('is-active');
    status.textContent = '일시 정지';
    stopMovement();
    document.exitPointerLock?.();
    menu.querySelector('[data-walkthrough-start]').focus({ preventScroll: true });
  };
  const onPointerDown = (event) => {
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
  const onPointerUp = (event) => {
    const pointerLocked = document.pointerLockElement === renderer.domElement;
    const wasTap = event.type === 'pointerup' && pointerStart && (pointerLocked || dragDistance < 8);
    const usedOpening = wasTap && (pointerLocked
      ? interactWithCenteredOpening()
      : interactWithOpening(event.clientX, event.clientY));
    if (wasTap && !usedOpening && !pointerLocked && pointerStart.pointerType === 'mouse') {
      renderer.domElement.requestPointerLock?.();
    }
    draggingLook = false;
    previousPointer = null;
    pointerStart = null;
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
    if (!room || spaceIdOf(room) === currentRoomId) return;
    currentRoomId = spaceIdOf(room);
    currentRoom.textContent = room.name;
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
    camera.rotation.y += (lookTarget.yaw - camera.rotation.y) * Math.min(1, delta * 18);
    camera.rotation.x += (lookTarget.pitch - camera.rotation.x) * Math.min(1, delta * 18);
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
    renderer.render(scene, camera);
  };

  const cleanup = () => {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(animationFrame);
    clearTimeout(toastTimer);
    clearTimeout(bumpTimer);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointermove', onPointerMove);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    renderer.domElement.removeEventListener('pointercancel', onPointerUp);
    renderer.domElement.removeEventListener('lostpointercapture', onPointerUp);
    joystick.removeEventListener('pointerdown', onJoystickDown);
    joystick.removeEventListener('pointermove', onJoystickMove);
    joystick.removeEventListener('pointerup', onJoystickEnd);
    joystick.removeEventListener('pointercancel', onJoystickEnd);
    joystick.removeEventListener('lostpointercapture', onJoystickEnd);
    stopMovement();
    scene.traverse((object) => {
      object.geometry?.dispose?.();
      if (Array.isArray(object.material)) object.material.forEach((entry) => entry.dispose());
      else object.material?.dispose?.();
      object.material?.map?.dispose?.();
    });
    renderer.dispose();
    document.exitPointerLock?.();
    if (document.fullscreenElement === overlay) document.exitFullscreen().catch(() => {});
    overlay.remove();
    if (activeCleanup === cleanup) activeCleanup = null;
  };
  activeCleanup = cleanup;

  window.addEventListener('resize', onResize);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointercancel', onPointerUp);
  renderer.domElement.addEventListener('lostpointercapture', onPointerUp);
  joystick.addEventListener('pointerdown', onJoystickDown);
  joystick.addEventListener('pointermove', onJoystickMove);
  joystick.addEventListener('pointerup', onJoystickEnd);
  joystick.addEventListener('pointercancel', onJoystickEnd);
  joystick.addEventListener('lostpointercapture', onJoystickEnd);
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
  overlay.dataset.walkthroughReady = 'true';
  requestAnimationFrame(() => overlay.classList.add('is-ready'));
  animate();
  return cleanup;
}
