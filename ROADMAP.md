# Roadmap

Room Studio is developed as an open-source planning and visualization tool. Roadmap items describe direction, not delivery commitments.

## Completed foundations

- Versioned portable drawing export/import that excludes account and revision metadata.
- Explicit local/cloud project deletion plus deployable account-data deletion.
- Persistent professional-review boundaries in the product and bilingual documentation.
- Owner-checked RPC-only cloud writes, stale-session save guards, and safer 3D status rendering.

## Near term

- Publish a reproducible first public release and demo screenshots.
- Add full account export, including project lists and optionally paginated version history.
- Add explicit cloud-conflict actions: reload remote, keep a local copy, or save as a new project.
- Add configured Supabase integration tests for cross-user access, cascaded deletion, and auth transitions.
- Handle unavailable or quota-exhausted browser storage with visible recovery guidance.
- Improve keyboard and screen-reader coverage for 2D selection and 3D controls.
- Document deployment recipes beyond Tailscale.

## Later

- Reusable presentation and brand templates for client-facing plans and exports.
- Permissioned project sharing, comments, and a deliberately scoped collaboration MVP.
- Synchronized 2D/3D presentation views and higher-quality render/video export.
- Contrast-aware palette suggestions and automated UI-state contrast checks.
- More architectural fixtures and configurable furniture primitives.
- More precise rotated-object collision checks and indexed validation for large layouts.
- Localization infrastructure beyond the current English and Korean documentation.
- Performance profiling for large plans and lower-powered mobile devices.

## Non-goals

- Producing permit, structural, or construction drawings.
- Replacing professional CAD or BIM tools.
- Automatically inferring that every room connection contains a door.
- Making cloud login mandatory for the core editor.
