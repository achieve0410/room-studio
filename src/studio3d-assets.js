import * as THREE from 'three';
import { createRoomAssetLibrary } from './asset-library-loader.js';
import { materialById } from './asset-library.js';

/** Model/texture ownership stays in the catalog loader, not the renderer's mesh disposer. */
export function createStudioAssets(onChange, library = createRoomAssetLibrary()) {
  let generation = 0;
  let pending = 0;
  let errors = [];
  let disposed = false;
  const releases = new Set();
  const notify = () => {
    if (!disposed) onChange({ pending, errors: [...errors] });
  };
  const load = (label, promise, attach) => {
    const version = generation;
    pending++;
    notify();
    promise
      .then((handle) => {
        if (disposed || version !== generation) {
          handle.release();
          return;
        }
        releases.add(handle.release);
        attach(handle);
      })
      .catch((error) => {
        if (!disposed && version === generation) errors.push(`${label}: ${error.message}`);
      })
      .finally(() => {
        if (!disposed && version === generation) {
          pending--;
          notify();
        }
      });
  };
  return {
    begin() {
      generation++;
      [...releases].forEach((release) => release());
      releases.clear();
      pending = 0;
      errors = [];
    },
    furniture(item) {
      const group = new THREE.Group();
      const size = [item.width / 100, item.height / 100, item.depth / 100];
      const placeholder = new THREE.Mesh(
        new THREE.BoxGeometry(...size),
        new THREE.MeshBasicMaterial({ color: 0xad4b32, wireframe: true }),
      );
      placeholder.position.y = size[1] / 2;
      group.add(placeholder);
      group.userData = { type: 'furniture', id: item.id, name: item.name, assetState: 'loading' };
      load(
        item.name ?? item.assetId,
        library.acquire(item.assetId, { materialId: item.materialId ?? 'warm-oak' }),
        ({ object, asset }) => {
          placeholder.removeFromParent();
          placeholder.geometry.dispose();
          placeholder.material.dispose();
          object.scale.set(
            item.width / 100 / asset.dimensions.width,
            item.height / 100 / asset.dimensions.height,
            item.depth / 100 / asset.dimensions.depth,
          );
          group.add(object);
          group.userData.assetState = 'ready';
        },
      );
      group.position.y = (item.elevation ?? 0) / 100;
      group.rotation.y = (-(item.rotation ?? 0) * Math.PI) / 180;
      return group;
    },
    surface(target, id, width, height, label) {
      const entry = materialById(id);
      const tile = entry?.tileSize ?? [1, 1];
      target.userData.studioSurface = true;
      load(
        label,
        library.acquireSurface(id, { repeat: [width / tile[0], height / tile[1]] }),
        ({ material }) => {
          target.copy(material);
          target.userData = { studioSurface: true };
          target.needsUpdate = true;
        },
      );
    },
    finish() {
      notify();
    },
    dispose() {
      disposed = true;
      generation++;
      library.dispose();
      releases.clear();
    },
  };
}

export function disposeStudioScene(root) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  root.traverse((object) => {
    if (object.userData.roomAssetOwned) return;
    if (object.geometry) geometries.add(object.geometry);
    for (const entry of [object.material].flat().filter(Boolean)) {
      materials.add(entry);
      if (!entry.userData.studioSurface) {
        Object.values(entry)
          .filter((value) => value?.isTexture)
          .forEach((texture) => textures.add(texture));
      }
    }
    object.shadow?.dispose();
  });
  geometries.forEach((entry) => entry.dispose());
  materials.forEach((entry) => entry.dispose());
  textures.forEach((entry) => entry.dispose());
}
