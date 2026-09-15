<h1 align="center">Room Studio</h1>

<p align="center">
  <a href="https://github.com/achieve0410/room-studio/actions/workflows/ci.yml"><img src="https://github.com/achieve0410/room-studio/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0 license"></a>
  <a href="https://achieve0410.github.io/room-studio/"><img src="https://img.shields.io/badge/demo-open-DA7956.svg" alt="Open live demo"></a>
</p>

<p align="center">
  <strong>Plan in 2D. Check the layout. Walk it in 3D — from desktop or mobile.</strong>
</p>
<p align="center">
  <a href="https://achieve0410.github.io/room-studio/"><strong>Open the live demo →</strong></a>
  ·
  <a href="#quick-start">Run locally</a>
  ·
  <a href="README.ko.md">한국어</a>
</p>
<p align="center"><sub>The public demo stores drawings only in this browser and does not enable login.</sub></p>

Room Studio is a mobile-friendly, browser-based 2D/3D room planner. It combines calibrated floor-plan tracing, orthogonal room shapes, furniture, walls, openings, exact dimensions, height checks, and first-person or overhead WebGL previews without requiring a desktop CAD application.

### Arrange a room

1. Enter the room's width and depth in centimeters, then choose **이 크기로 시작**.
2. Define rooms, living areas, and bathrooms in 2D. Move, resize, and combine space parts to establish the overall shape.
3. Open 3D editing to place furniture and doors, adjust their position, rotation, and size, then apply or cancel the preview. Choose **걸어보기** to walk through the result.

The 2D workspace defines spaces; furniture and opening symbols are read-only context. Furniture, doors, windows, and manual walls are edited in 3D. Client notes, A/B comparison and proposals are under **배치 비교 · 상담 · 제안서**. Use **파일** to move work between browsers; existing local work reopens automatically.

### Regional apartment references

The starter's **아파트 샘플 체험** opens a Daechi Raemian Palace reference layout. **샘플** also offers Apgujeong Hyundai 35-pyeong and Dogok Rexle 33A, with connected bedroom, bathroom and balcony openings and naturally open shared spaces. These are original approximations from published plans, not surveyed residences. See [sources, advertised areas and approximation boundaries](docs/REGIONAL_SAMPLES.md).

### Furnished Seoul examples

Choose a Seoul card in the starter, or **샘플 → 3D로 꾸며보기**, to open one of three
furnished styles. The catalog ships 12 original GLB furniture models, three furniture
palettes, and seven floor/wall finishes. Select, drag, rotate, replace, and furnish directly
in 3D; previews commit through the same drawing history and persistence as the 2D editor.
No per-customer AI generation is required. This release extends the existing Three.js
renderer, not Pascal's packages or hosted services.
See the [workflow](docs/SEOUL_ASSET_STUDIO.md) and [asset provenance](docs/asset-library.md).

> Room Studio is a planning and visualization aid, not a substitute for permit, architectural, structural, accessibility, building-services, or construction drawings. Real construction, permitting, and safety decisions require review by qualified architects, engineers, accessibility specialists, and other relevant professionals.

## Live demo

Open the [public Room Studio demo](https://achieve0410.github.io/room-studio/). The demo has no Supabase configuration or login: drawings remain in that browser's `localStorage`, and clearing site data removes them. Do not enter a private or security-sensitive floor plan.

## Highlights

- Record the client brief, compare independent A/B layouts, and export a branded recommendation document without requiring cloud login.
- Compose L-shaped and other orthogonal spaces from multiple rectangular parts.
- Import a PNG or JPG floor plan, calibrate it from two known points, and control its opacity or movement lock.
- Add persistent distance dimensions and enter exact wall lengths in centimeters.
- Move, resize, align, and combine spaces in 2D; place and transform furniture in 3D.
- Duplicate, copy, paste, lock, and nudge selected objects in 1 cm keyboard increments.
- Edit room ceiling height and furniture elevation to validate vertical fit.
- Create and edit swing doors, two-panel bypass sliding doors, and sash windows in 3D, with read-only symbols in 2D.
- Switch between collision-aware first-person, dollhouse, and top-down 3D views; hide ceilings, focus the current selection, or save the current scene as PNG.
- Work with mouse and keyboard or mobile touch, pinch zoom, resize handles, and a virtual joystick.
- Keep drawings in local browser storage, or optionally sync user-owned projects through Supabase Auth and Postgres RLS.

## Client consultation workflow

1. Open a sample or import a drawing, expand **배치 비교 · 상담 · 제안서**, then choose **상담 정보** to enter the project, business, client, and requirements.
2. Edit A, choose **B안 만들기**, and switch to B to explore a different arrangement. Recommendations and next steps stay with each option.
3. Use **비교** for side-by-side desktop or stacked mobile plans. Use 3D's lowered-wall overview to explain furniture placement; first-person mode retains full-height walls and collisions.
4. Choose **제안서** for a self-contained HTML report with both options, measurements, opening symbols, and named warnings.

Project names and consultation notes survive reload and portable export/import. A/B switching clears the active drawing's undo history so undo cannot modify the other option. Replacing a draft preserves one local recovery copy. Storage failures expose export/retry actions; cloud conflicts allow a separate copy or a protected remote reload.

Portable schema 3 reads older schemas 1 and 2. Both options and their background images share a 1 MiB limit. Floor coverage is a clipped bounding-footprint estimate, not a circulation or installation clearance check.

## Requirements

- Node.js 22.12 or newer (below Node 25)
- npm
- A current Chromium, Firefox, or Safari browser with WebGL support

## Quick start

```bash
npm ci
npm run dev
```

The core editor works without any cloud configuration and stores the current drawing in `localStorage`.

## Validation

```bash
npm run check
npm run test:browser:mobile
npm run test:browser:simple
npm run test:browser:spaces
npm run test:browser:consultation
```

`npm run check` performs syntax checks, unit tests, and a production build. The browser audit launches a local Vite preview and exercises the supported mobile and desktop flows in Chrome.

## Optional Supabase sync

1. Create a Supabase project.
2. Apply every file in `supabase/migrations/` in filename order.
3. Deploy `supabase/functions/delete-account` to enable explicit account-data deletion.
4. Enable email sign-in and, if desired, Google OAuth.
5. Register every development or deployment origin in Supabase Auth redirect URLs.
6. Copy `.env.example` to `.env` and enter the public project values.

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_KEY
```

Only the Supabase publishable key belongs in browser configuration. Never place a `service_role` key or OAuth client secret in this repository or in Vite environment variables. See [Self-hosting](docs/SELF_HOSTING.md) for the complete deployment contract.

## Private Tailscale sharing

The included script builds on `tailscale serve` without resetting unrelated handlers. It auto-detects the current device's MagicDNS hostname and defaults to HTTPS `8443` forwarding to Vite preview on `127.0.0.1:4173`.

```bash
npm run build
./scripts/tailscale-private-serve.sh start
./scripts/tailscale-private-serve.sh status
```

Existing installations using those defaults continue to work. Other users can override the hostname and ports with environment variables. See [Tailscale deployment](docs/TAILSCALE.md).

## Architecture

Room Studio deliberately keeps its runtime small: Vite, vanilla JavaScript, Three.js, and an optional dynamically loaded Supabase adapter. See [Architecture](docs/ARCHITECTURE.md) for storage boundaries, rendering modules, and security invariants.

## Contributing and support

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- Use GitHub issues for reproducible bugs and scoped feature proposals.
- Do not disclose vulnerabilities in a public issue; follow [SECURITY.md](SECURITY.md).
- Planned work and explicit non-goals are listed in [ROADMAP.md](ROADMAP.md).

## Privacy

The local-only editor sends no drawing to the project database. A self-hosted operator who enables Supabase becomes responsible for the authentication and drawing data stored in that deployment. See [Privacy and operator responsibilities](docs/PRIVACY.md).

## License

Licensed under the [Apache License 2.0](LICENSE). Commercial use is allowed by the license; the maintainers do not currently operate Room Studio as a paid product.
