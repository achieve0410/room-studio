# Architecture

## Runtime shape

Room Studio is a single-page Vite application built with vanilla JavaScript and CSS.

- `src/main.js`: 2D editor state, rendering, selection, gestures, history, and account UI.
- `src/geometry.js`: pure geometry, snapping, room union, openings, collision, and resize helpers.
- `src/walkthrough3d.js`: lazily loaded Three.js first-person renderer and 3D interactions.
- `src/cloud-store.js`: lazily loaded Supabase adapter.
- `supabase/migrations/`: optional database schema, RLS, and transactional project persistence.

## Persistence boundaries

Local-only mode persists the drawing in browser `localStorage`. It remains the default and must work without network access or cloud configuration.

Cloud mode authenticates through Supabase. Each project has an owner and revision. The client saves through `save_project`, which performs owner verification, optimistic revision checking, and optional immutable version insertion in one transaction. Direct browser writes must not bypass this boundary.

## Rendering and data safety

Loaded drawing data is normalized before entering SVG or Three.js rendering. IDs, text, colors, dimensions, rotations, and structure relationships are treated as untrusted, including data loaded from the operator's database.

## Compatibility

Persisted schema changes require:

1. a backward-compatible loader or explicit migration;
2. regression tests for older snapshots;
3. a new Supabase migration when the database shape changes;
4. validation in both 2D and 3D views.
