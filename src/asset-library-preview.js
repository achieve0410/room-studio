// Build/QA surface only; not imported by the planner runtime.
import * as T from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ROOM_ASSETS } from './asset-library.js';
import { createRoomAssetLibrary } from './asset-library-loader.js';

export function createAssetPreview(container) {
  const renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFShadowMap;
  container.append(renderer.domElement);
  const scene = new T.Scene();
  scene.background = new T.Color('#f2efe9');
  const pmrem = new T.PMREMGenerator(renderer);
  const environmentScene = new RoomEnvironment();
  const environment = pmrem.fromScene(environmentScene, 0.04);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.55;
  environmentScene.dispose();
  pmrem.dispose();
  scene.add(new T.HemisphereLight('#fff5e4', '#a2a7b0', 1.6));
  const light = new T.DirectionalLight('#fff2dc', 3.4);
  light.position.set(-3.5, 7, 4.5);
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  light.shadow.camera.left = light.shadow.camera.bottom = -8;
  light.shadow.camera.right = light.shadow.camera.top = 8;
  light.shadow.camera.far = 30;
  light.shadow.normalBias = 0.015;
  light.shadow.bias = -0.00015;
  light.shadow.radius = 3;
  scene.add(light);
  const floor = new T.Mesh(new T.PlaneGeometry(200, 200), new T.MeshStandardMaterial({ color: '#e9e5dc', roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.002;
  floor.receiveShadow = true;
  scene.add(floor);
  const collection = new T.Group();
  scene.add(collection);
  const camera = new T.OrthographicCamera(-3, 3, 3, -3, 0.01, 100);
  const library = createRoomAssetLibrary();
  let handles = [];

  const frame = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Asset preview frame timeout')), 15000);
    requestAnimationFrame(() => { renderer.render(scene, camera); clearTimeout(timer); resolve(); });
  });

  return {
    async show({ ids = [], surfaceIds = [], materialId = 'warm-oak', angle = 'front', width = 1440, height = 900 }) {
      handles.forEach((handle) => handle.release());
      handles = await Promise.all(ids.map((id) => library.acquire(id, { materialId })));
      handles.push(...await Promise.all(surfaceIds.map(async (id) => {
        const handle = await library.acquireSurface(id);
        const geometry = new T.BoxGeometry(1.8, 0.045, 1.8);
        const object = new T.Mesh(geometry, handle.material);
        object.position.y = 0.0225;
        object.receiveShadow = true;
        return {
          object, asset: { id, dimensions: { width: 1.8, height: 0.045, depth: 1.8 } },
          release() { object.removeFromParent(); geometry.dispose(); handle.release(); },
        };
      })));
      const total = handles.reduce((sum, handle) => sum + handle.asset.dimensions.width + 0.38, -0.38);
      let x = -total / 2;
      const entries = [];
      for (const handle of handles) {
        const box = new T.Box3().setFromObject(handle.object);
        const textures = new Set();
        handle.object.traverse((node) => {
          for (const material of [node.material].flat().filter(Boolean)) Object.values(material).filter((value) => value?.isTexture).forEach((texture) => textures.add(texture));
        });
        entries.push({ id: handle.asset.id, min: box.min.toArray(), max: box.max.toArray(), dimensions: box.getSize(new T.Vector3()).toArray(), textures: [...textures].map((texture) => ({ width: texture.image?.width, height: texture.image?.height, complete: Boolean(texture.image?.width) })) });
        handle.object.position.x = x + handle.asset.dimensions.width / 2;
        collection.add(handle.object);
        x += handle.asset.dimensions.width + 0.38;
      }
      const box = new T.Box3().setFromObject(collection);
      const center = box.getCenter(new T.Vector3());
      const direction = new T.Vector3(...({ front: [0.75, 0.7, 1.1], rear: [-0.85, 0.55, -1.15], top: [0.03, 1.7, 0.38] }[angle]));
      camera.position.copy(center).add(direction.normalize().multiplyScalar(15));
      camera.lookAt(center);
      camera.updateMatrixWorld(true);
      const viewBounds = new T.Box3();
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) viewBounds.expandByPoint(new T.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse));
      const aspect = width / height;
      const span = Math.max(viewBounds.max.y - viewBounds.min.y, (viewBounds.max.x - viewBounds.min.x) / aspect) * 0.62;
      camera.left = -span * aspect; camera.right = span * aspect; camera.bottom = -span; camera.top = span;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      await renderer.compileAsync(scene, camera);
      await frame();
      return { entries, renderer: { ...renderer.info.render }, textureCount: renderer.info.memory.textures, materialId, angle, size: [width, height] };
    },
    png() { return renderer.domElement.toDataURL('image/png').split(',')[1]; },
    webp() { return renderer.domElement.toDataURL('image/webp', 0.9).split(',')[1]; },
    catalog: ROOM_ASSETS,
    dispose() {
      handles.forEach((handle) => handle.release());
      library.dispose();
      floor.geometry.dispose(); floor.material.dispose();
      light.shadow.dispose(); environment.dispose();
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    },
  };
}
