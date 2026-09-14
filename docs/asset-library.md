# Seoul furniture asset library

## Integration contract

`src/asset-library.js` is browser-free catalog metadata:

- `ROOM_ASSETS`, `ROOM_MATERIALS`: immutable descriptor arrays.
- `assetById(id)`, `materialById(id)`: descriptor or `null`, including unknown IDs.
- `assetForItem(item)`: explicit `assetId`, otherwise legacy type mapping; specialized kitchen/plumbing remain procedural (`null`).
- `roomAssetUrl(path, baseUrl)`: allowlisted pack-relative path under the Vite base (`import.meta.env.BASE_URL` by default). Never pass persisted URLs.

`src/asset-library-loader.js` uses Three's GLTFLoader:

```js
import { createRoomAssetLibrary } from '../src/asset-library-loader.js';

const library = createRoomAssetLibrary();
const { object, asset, release } = await library.acquire('seoul-sofa', {
  materialId: 'warm-oak',
});
scene.add(object);
// Scale in parent: width/100/asset.dimensions.width, etc.; place/rotate as usual.
release(); // Removes object and disposes its private materials, idempotently.
library.dispose(); // Releases all live instances and cached geometry/textures.
```

The library owns shared geometry/textures; callers must not dispose those through a generic scene traversal. Every acquired model node has `userData.roomAssetOwned = true`. Instances own cloned materials; mutations do not change another instance. Closing while a load is pending safely disposes the eventual result. Failures reject and do not poison the cache. `dispose()` is terminal; create one library per walkthrough. Models are editable indexed meshes, with no baked room or lighting. Meshes are batched by material slot (2-4 draw calls per model); `mesh.extras.components` retains original part names and consecutive triangle counts. Edit individual parts in the generator, or split those indexed ranges in another DCC pipeline.

Surface materials use the same owner:

```js
const surface = await library.acquireSurface('oak-natural', {
  repeat: [roomWidthMeters / 1.8, roomDepthMeters / 1.8],
});
floor.material = surface.material;
surface.release(); // Disposes private material + texture transforms, not shared images.
```

Use `materialById(id).tileSize` instead of a hardcoded repeat denominator. Each surface has independent texture transforms; shared decoded images are disposed/closed only when the library closes. If copying a returned material onto a caller-owned material, dispose that copy yourself but leave its maps to the library. No model/texture requests are made until acquisition. `loadGLTF` and `loadTexture` can be injected for deterministic transport/lifecycle tests; production defaults are Three's loaders.

Asset IDs: `seoul-sofa`, `seoul-bed`, `seoul-dining-table`, `seoul-dining-chair`, `seoul-desk`, `seoul-coffee-table`, `seoul-side-table`, `seoul-wardrobe`, `seoul-tv-console`, `seoul-plant`, `seoul-floor-lamp`, `seoul-rug`.

Metadata: `id`, `name`, `category`, `dimensions: {width, depth, height}` (meters), `modelPath`, `thumbnailPath`, `thumbnailWebpPath`, `materialSlots`, `primarySlot`, `legacyTypes`. Origin is bottom-center; +Y up, +Z front. Parent owns layout cm conversion and orientation. Full mesh height includes headboards/lamps; bed height is not just mattress height.

Persist `item.assetId`, `item.materialId`, `zone.floorMaterialId`, `zone.wallMaterialId` as IDs. Omitted appearance fields preserve legacy behavior.

Appearance IDs `warm-oak`, `walnut`, `soft-modern` are slot-aware palettes. They affect only wood/fabric/primary slots and preserve piping, hardware, foliage and linen. A plant's `primary` is its ceramic pot, never its leaves. Surface IDs: `oak-natural`, `walnut-smoked`, `oak-pale`, `tile-ivory`, `tile-slate`, `plaster-warm`, `plaster-chalk`.

`assetForItem` is an optional legacy lookup, not automatic migration. Existing kitchen sinks/islands, washbasins, toilets, laundry towers and clothes racks retain specialized procedural geometry, declared in `LEGACY_ASSET_COMPATIBILITY`. Unknown explicit asset IDs return `null`; loaders reject them. Do not derive a URL from an ID. The URL helper only accepts allowlisted paths and same-origin directory bases, including `/room-studio/`, `./`, and an empty relative base.

## Collection and size budget

Original contemporary apartment furniture, not reproductions of branded products. All dimensions below are width x depth x full height in meters. Bounding boxes are measured from actual vertices, not rotated proxy boxes. The bed height includes the headboard; do not apply the legacy 55cm mattress height to the whole model. A legacy depth-long sofa can swap width/depth and add 90 degrees while retaining its world footprint.

| Stable ID | Dimensions (m) | GLB bytes | Triangles | Slots |
| --- | --- | ---: | ---: | ---: |
| seoul-sofa | 2.20 x 0.94 x 0.84 | 293,552 | 11,308 | 4 |
| seoul-bed | 1.60 x 2.15 x 1.04 | 436,460 | 17,668 | 4 |
| seoul-dining-table | 1.65 x 0.90 x 0.75 | 99,684 | 1,640 | 2 |
| seoul-dining-chair | 0.52 x 0.55 x 0.79 | 82,964 | 2,420 | 3 |
| seoul-desk | 1.25 x 0.62 x 0.76 | 81,208 | 2,376 | 3 |
| seoul-coffee-table | 1.12 x 0.66 x 0.36 | 227,904 | 4,028 | 2 |
| seoul-side-table | 0.46 x 0.46 x 0.48 | 42,264 | 1,536 | 2 |
| seoul-wardrobe | 1.50 x 0.60 x 2.10 | 111,428 | 4,328 | 3 |
| seoul-tv-console | 1.80 x 0.42 x 0.48 | 398,700 | 16,884 | 4 |
| seoul-plant | 0.68 x 0.68 x 1.15 | 196,432 | 6,976 | 4 |
| seoul-floor-lamp | 0.48 x 0.48 x 1.50 | 102,756 | 3,312 | 4 |
| seoul-rug | 2.10 x 1.50 x 0.018 | 193,700 | 6,660 | 3 |

Totals: **2,267,052 model bytes**, **594,015 shared texture bytes**, **79,136 triangles**. Fifteen 256x256 RGB PNGs supply sRGB base color plus linear tangent-space normal and roughness maps for furniture wood, woven fabric, plank oak, stone tile and plaster. The twelve 512x512 PNG thumbnails are retained; browsers use smaller WebP companions at the same resolution. Textures are shared via relative paths, not duplicated in GLBs. The machine-readable `manifest.json` records precise sizes, hashes, draw calls, dimensions and slots.

## Rebuild and provenance

```sh
npm ci --ignore-scripts
node scripts/build-room-assets.mjs          # Deterministic GLBs, PBR PNGs, manifest, provenance, licenses
node scripts/build-room-assets.mjs --render # Also real-browser thumbnails and validation screenshots
node --test tests/asset-library.test.js tests/asset-library-loader.test.js tests/asset-library-files.test.js
node scripts/build-room-assets-render.mjs   # Validate existing shipped pack without regenerating it
npm run build -- --base=./
```

The pack renderer uses installed Chrome on macOS; set `CHROME_BIN` elsewhere. It uses dynamically assigned ports, isolated browser profiles, exact load/frame events with bounded timeouts, and the repository's existing CDP helper. It adds no runtime dependency. The editor's separate browser regression suite uses dev-only `playwright-core`.

Authoring source: `scripts/build-room-assets-geometry.mjs` (bowed upholstery, piping, draped quilt, bentwood chair, trestle joinery, turned profiles, tambour slats, botanical leaves, pleated shade, rug binding/fringe). `scripts/build-room-assets.mjs` creates analytic periodic textures, serializes standard glTF 2.0 and records SHA-256 provenance. No external assets, reference-image pixels, AI images, network downloads, or vendor replicas are used. The original pack is Apache-2.0, with the full license in the pack; the Three.js MIT license is included separately. `PROVENANCE.json` records source and output hashes and dependency use. Redistribution and modification follow those licenses.

Geometry, textures and metadata reproduce byte-for-byte from source on the pinned dependency tree. Tests rebuild geometry and compare shipped vertex buffers. Thumbnails are actual GLB renders, not image substitutes for models. Their exact pixels can vary by Chrome/GPU version. Resolve `thumbnailWebpPath` through `roomAssetUrl` for browser cards; `thumbnailPath` retains the PNG original. Use an accessible name and lazy loading in cards. Do not regenerate checked-in outputs by hand.

## Validation evidence

The first contract run was RED because the catalog module did not exist. Coverage includes bounds/indices/finite coordinates, slots, output/source hashes, PNG originals and smaller full-resolution WebP companions, unknown IDs/base paths, concurrent cache deduplication, independent palette materials, exact disposal ownership, failure retry, and late-load disposal. Source/test files are checked with `node --check` and the Node test runner.

Real Chrome 153 rendered **38 views**: four furniture groups x three palettes x front/rear/top, plus wood/mineral surface swatches. All twelve GLBs and all fifteen textures decoded from same-origin `/room-studio/` URLs; exact loaded bounds and bottom-center origins passed. Front/rear/top screenshots were inspected, and quilt/chair intersections found during inspection were fixed in the authored geometry. Screenshots and `render-report.json` remain under `.omx/artifacts/seoul-assets/`, not repository docs.

The relative-base Vite build passed and production GLB/texture copies were byte-equal to source assets. The build reports a >600kB walkthrough JavaScript chunk warning. LSP returned no errors for responding files; three refresh requests timed out, and Three addon declaration hints remain in this JavaScript project. Syntax checks and executable tests cover every authored module. This pack's audit is separate from the parent-owned editor/3D interaction and deployment gates.
