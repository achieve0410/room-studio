import * as THREE from 'three';

/** Visible mesh envelopes, rather than empty corners of the aggregate room box. */
export function studioSpatialPoints(meshes) {
  const points = [];
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    const materials = [mesh.material].flat();
    const planes = materials.flatMap((material) => material.clippingPlanes ?? []);
    if (planes.length && materials.every((material) => material.clippingPlanes?.length)) {
      for (const plane of planes) {
        if (plane.normal.y === -1 && plane.normal.x === 0 && plane.normal.z === 0) {
          box.max.y = Math.min(box.max.y, plane.constant);
        }
      }
    }
    if (box.isEmpty()) continue;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) points.push(new THREE.Vector3(x, y, z));
      }
    }
  }
  return points;
}

/** Solve camera-plane translation and distance together, keeping every visible point in frame. */
export function fitStudioCamera(camera, points, center) {
  if (!points.length) return center.clone();
  const inverse = camera.quaternion.clone().invert();
  const local = points.map((point) => point.clone().sub(center).applyQuaternion(inverse));
  const vertical = (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / camera.zoom) * 0.9;
  const horizontal = vertical * camera.aspect;
  const horizontalHigh = Math.max(...local.map((point) => point.x + horizontal * point.z));
  const horizontalLow = Math.min(...local.map((point) => point.x - horizontal * point.z));
  const verticalHigh = Math.max(...local.map((point) => point.y + vertical * point.z));
  const verticalLow = Math.min(...local.map((point) => point.y - vertical * point.z));
  const distance = Math.max(
    (horizontalHigh - horizontalLow) / (2 * horizontal),
    (verticalHigh - verticalLow) / (2 * vertical),
    ...local.map((point) => point.z + camera.near * 2),
  );
  const balancedOffset = (axis, slope, high, low) => {
    let minimum = high - slope * distance;
    let maximum = low + slope * distance;
    for (let iteration = 0; iteration < 40; iteration++) {
      const offset = (minimum + maximum) / 2;
      const projected = local.map((point) => (point[axis] - offset) / (distance - point.z));
      if (Math.min(...projected) + Math.max(...projected) > 0) minimum = offset;
      else maximum = offset;
    }
    return (minimum + maximum) / 2;
  };
  const target = new THREE.Vector3(
    balancedOffset('x', horizontal, horizontalHigh, horizontalLow),
    balancedOffset('y', vertical, verticalHigh, verticalLow),
    0,
  )
    .applyQuaternion(camera.quaternion)
    .add(center);
  camera.position.copy(new THREE.Vector3(0, 0, distance).applyQuaternion(camera.quaternion).add(target));
  camera.far = Math.max(100, ...local.map((point) => (distance - point.z) * 1.1));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return target;
}

/** Overview gestures own only camera state; a furniture gesture can reserve the first pointer. */
export function createStudioNavigation({ camera, size, target, mode, onChange }) {
  const pointers = new Map();
  let gesture = null;
  const center = (points) =>
    points.reduce(
      (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
      { x: 0, y: 0 },
    );
  const separation = (points) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  const seed = (pan = false) => {
    const points = [...pointers.values()];
    if (!points.length) {
      gesture = null;
      return;
    }
    gesture = {
      center: center(points),
      separation: points.length > 1 ? separation(points) : 0,
      position: camera.position.clone(),
      target: target.clone(),
      quaternion: camera.quaternion.clone(),
      distance: camera.position.distanceTo(target),
      pan: pan || mode() === 'top',
      spherical: new THREE.Spherical().setFromVector3(camera.position.clone().sub(target)),
    };
  };
  const moveCamera = (position, nextTarget) => {
    target.copy(nextTarget);
    camera.position.copy(position);
    camera.lookAt(target);
    camera.far = Math.max(camera.far, camera.position.distanceTo(target) * 2);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    onChange();
  };
  return {
    down(event, editing = false) {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (editing && pointers.size === 1) {
        gesture = null;
        return;
      }
      seed(event.shiftKey || event.button === 1 || event.button === 2);
    },
    move(event) {
      if (!pointers.has(event.pointerId)) return false;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!gesture) return false;
      const points = [...pointers.values()];
      const current = center(points);
      const dx = current.x - gesture.center.x;
      const dy = current.y - gesture.center.y;
      if (points.length > 1 || gesture.pan) {
        const scale =
          (2 * gesture.distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / size().height;
        const nextTarget = gesture.target
          .clone()
          .add(new THREE.Vector3(-dx * scale, dy * scale, 0).applyQuaternion(gesture.quaternion));
        const factor = points.length > 1 ? gesture.separation / Math.max(1, separation(points)) : 1;
        const distance = THREE.MathUtils.clamp(gesture.distance * factor, 0.3, 200);
        const offset = gesture.position.clone().sub(gesture.target).setLength(distance);
        moveCamera(nextTarget.clone().add(offset), nextTarget);
      } else {
        const spherical = gesture.spherical.clone();
        spherical.theta -= dx * 0.006;
        spherical.phi = THREE.MathUtils.clamp(spherical.phi - dy * 0.006, 0.08, Math.PI / 2 - 0.08);
        moveCamera(new THREE.Vector3().setFromSpherical(spherical).add(gesture.target), gesture.target);
      }
      return true;
    },
    up(event) {
      pointers.delete(event.pointerId);
      seed();
    },
    wheel(event) {
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size().height : 1);
      const offset = camera.position.clone().sub(target);
      offset.setLength(THREE.MathUtils.clamp(offset.length() * Math.exp(delta * 0.001), 0.3, 200));
      moveCamera(target.clone().add(offset), target);
    },
    cancel() {
      pointers.clear();
      gesture = null;
    },
  };
}
