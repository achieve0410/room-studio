import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, TextureLoader } from 'three';
import { assetById, materialById, roomAssetUrl } from './asset-library.js';

function resourcesOf(object) {
  const geometry = new Set();
  const material = new Set();
  const texture = new Set();
  object.traverse((node) => {
    if (node.geometry) geometry.add(node.geometry);
    for (const entry of [node.material].flat().filter(Boolean)) {
      material.add(entry);
      Object.values(entry).filter((value) => value?.isTexture).forEach((value) => texture.add(value));
    }
  });
  return { geometry, material, texture };
}

function disposeResources(resources) {
  resources.geometry.forEach((entry) => entry.dispose());
  resources.material.forEach((entry) => entry.dispose());
  const images = new Set();
  resources.texture.forEach((entry) => { images.add(entry.source?.data); entry.dispose(); });
  images.forEach((image) => image?.close?.());
}

/** One owner per scene; templates share geometry/textures, never instance materials. */
export function createRoomAssetLibrary({
  baseUrl,
  loadGLTF = (url) => new GLTFLoader().loadAsync(url),
  loadTexture = (url) => new TextureLoader().loadAsync(url),
} = {}) {
  const cache = new Map();
  const textureCache = new Map();
  const releases = new Set();
  const masters = new Set();
  const surfaceMasters = new Set();
  let disposed = false;
  const assertLive = () => { if (disposed) throw new Error('Room asset library is disposed'); };

  const template = (asset) => {
    if (!cache.has(asset.id)) {
      const pending = Promise.resolve().then(() => loadGLTF(roomAssetUrl(asset.modelPath, baseUrl)))
        .then(({ scene }) => {
          if (disposed) {
            disposeResources(resourcesOf(scene));
            throw new Error('Room asset library was disposed during loading');
          }
          masters.add(scene);
          return scene;
        }).catch((error) => { cache.delete(asset.id); throw error; });
      cache.set(asset.id, pending);
    }
    return cache.get(asset.id);
  };

  const surfaceTexture = (path, color) => {
    if (!textureCache.has(path)) {
      textureCache.set(path, Promise.resolve().then(() => loadTexture(roomAssetUrl(path, baseUrl))).then((texture) => {
        if (disposed) {
          texture.dispose();
          texture.source?.data?.close?.();
          throw new Error('Room asset library was disposed during loading');
        }
        if (color) texture.colorSpace = SRGBColorSpace;
        texture.wrapS = texture.wrapT = RepeatWrapping;
        surfaceMasters.add(texture);
        return texture;
      }).catch((error) => { textureCache.delete(path); throw error; }));
    }
    return textureCache.get(path);
  };

  return {
    async acquire(assetId, { materialId = 'warm-oak' } = {}) {
      assertLive();
      const asset = assetById(assetId);
      if (!asset) throw new Error(`Unknown room asset: ${assetId}`);
      const palette = materialById(materialId);
      if (palette?.kind !== 'palette') throw new Error(`Unknown furniture palette: ${materialId}`);
      const original = await template(asset);
      assertLive();
      const object = original.clone(true);
      const materials = new Map();
      object.traverse((node) => {
        node.userData = { ...node.userData, roomAssetOwned: true, assetId };
        if (!node.isMesh) return;
        node.castShadow = node.receiveShadow = true;
        const clone = (entry) => {
          if (!materials.has(entry)) {
            const copy = entry.clone();
            const slot = entry.userData.slot ?? entry.name;
            if (palette.slots[slot]) copy.color.set(palette.slots[slot]);
            materials.set(entry, copy);
          }
          return materials.get(entry);
        };
        node.material = Array.isArray(node.material) ? node.material.map(clone) : clone(node.material);
      });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        object.removeFromParent();
        materials.forEach((entry) => entry.dispose());
        releases.delete(release);
      };
      releases.add(release);
      return { object, asset, release };
    },

    async acquireSurface(materialId, { repeat = [1, 1] } = {}) {
      assertLive();
      const surface = materialById(materialId);
      if (surface?.kind !== 'surface') throw new Error(`Unknown surface material: ${materialId}`);
      const sources = await Promise.all([
        surfaceTexture(surface.texturePath, true),
        surfaceTexture(surface.normalPath, false),
        surfaceTexture(surface.roughnessPath, false),
      ]);
      assertLive();
      const textures = sources.map((source) => {
        const texture = source.clone();
        texture.repeat.set(...repeat);
        texture.needsUpdate = true;
        return texture;
      });
      const material = new MeshStandardMaterial({
        color: surface.color, roughness: surface.roughness,
        map: textures[0], normalMap: textures[1], roughnessMap: textures[2],
      });
      material.normalScale.setScalar(0.28);
      material.userData.roomAssetOwned = true;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        material.dispose();
        textures.forEach((texture) => texture.dispose());
        releases.delete(release);
      };
      releases.add(release);
      return { material, surface, release };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      [...releases].forEach((release) => release());
      const resources = { geometry: new Set(), material: new Set(), texture: new Set() };
      masters.forEach((object) => {
        const owned = resourcesOf(object);
        for (const kind of Object.keys(resources)) owned[kind].forEach((entry) => resources[kind].add(entry));
      });
      surfaceMasters.forEach((texture) => resources.texture.add(texture));
      disposeResources(resources);
      surfaceMasters.clear();
      masters.clear();
      cache.clear();
      textureCache.clear();
    },
  };
}
