# Architecture

## Runtime shape

Room Studio is a single-page Vite application built with vanilla JavaScript and CSS.

- `src/main.js`: 2D editor state, floor-plan backgrounds, dimensions, rendering, selection, gestures, history, and account UI.
- `src/geometry.js`: pure geometry, snapping, room union, openings, collision, and resize helpers.
- `src/layout-tools.js`: pure calibration, measurement formatting, and clipboard duplication helpers.
- `src/project-file.js`: bounded, versioned portable drawing serialization and parsing without cloud ownership metadata.
- `src/consultation.js`: shared schema-3 contract, consultation metadata, and independent A/B drawing snapshots.
- `src/local-draft.js`: atomic named local drafts and a separate recovery copy, with explicit storage failures.
- `src/consultation-ui.js`: responsive consultation forms and comparison markup.
- `src/plan-svg.js`: static SVG plans used by comparison and the standalone client report.
- `src/project-report.js`: branded client documents with option-specific notes, drawings, and warnings.
- `src/walkthrough3d.js`: lazily loaded Three.js first-person, dollhouse, and overhead renderer with scene snapshot controls.
- `src/cloud-store.js`: lazily loaded Supabase adapter.
- `supabase/functions/delete-account/`: authenticated server-side account deletion; the service-role key never enters the browser.
- `supabase/migrations/`: optional database schema, RLS, and transactional project persistence.

## Persistence boundaries

Local-only mode persists a named draft in browser `localStorage`. It remains the default and needs no cloud configuration. The `room-studio-layout-v2` value retains drawing fields at the root and adds local-only `draftMetadata` for project name, owner, cloud identity/base revision, and dirty status. `room-studio-recovery-v1` holds one explicit pre-replacement copy. Storage errors retain the old stored value and surface export/retry actions; malformed stored bytes are not silently deleted.

Portable and cloud schema 3 add optional consultation metadata. Root geometry belongs to the active A/B option; `consultation.inactiveGeometry` is the other drawing, never a nested document. B is created only by an explicit action. Customer requirements and business/customer names are shared, while labels, recommendations, and next steps remain attached to A/B keys. Readers continue to accept schemas 1 and 2. The complete two-option document remains subject to the 1 MiB limit.

Cloud mode authenticates through Supabase using PKCE. Each project has an owner and revision. The client saves through `save_project`, which performs owner verification, optimistic revision checking, a 1 MiB layout limit, per-account limits, and bounded version retention in one transaction. Imported images are converted to bounded JPEG data URLs before they enter the persisted layout. RLS restricts reads, while authenticated browser roles have no direct project-table write grants.

Project deletion follows the same RPC-only write boundary through `delete_project`; it checks `auth.uid()` and ownership before the project/version cascade. Account deletion is intentionally not a browser database operation: the authenticated Edge Function verifies the current user and invokes the Supabase Admin delete-user operation with a server-only credential.

Portable project files use a separate versioned envelope. Import normalizes through the existing local loader and becomes a new local draft, so it cannot silently overwrite the active cloud project.

Owner-bound drafts are hidden until the same authenticated user is restored. A dirty draft keeps its original base revision rather than adopting the current server revision. Conflict recovery either saves the captured draft as a new project or preserves it before loading the server copy; neither action requires a successful stale save. Auth and document generations reject late responses after a user or document switch. Signing out or switching users clears the prior owner's local draft and recovery copy.

## Rendering and data safety

Loaded drawing data is normalized before entering SVG or Three.js rendering. IDs, text, colors, dimensions, rotations, and structure relationships are treated as untrusted, including data loaded from the operator's database.
The production document applies a CSP baseline before loading application code. Because drawing data and Supabase sessions are origin-scoped, deployments must use a dedicated origin rather than a path shared with unrelated applications.

## Compatibility

Persisted schema changes require:

1. a backward-compatible loader or explicit migration;
2. regression tests for older snapshots;
3. a new Supabase migration when the database shape changes;
4. validation in both 2D and 3D views.
