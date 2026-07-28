# Changelog

All notable user-facing changes are documented in this file. Room Studio follows [Semantic Versioning](https://semver.org/) for tagged releases.

## [Unreleased]

### Added

- PPT-style 2D selection frames, 44px resize and continuous rotation handles, exact angle input, and live position/size/angle feedback.
- A shared selection boundary that makes mobile and desktop group movement easier to understand.

### Changed

- 3D navigation prompts now match touch or keyboard/mouse input, respect device safe areas, and fade nearby custom-furniture labels when they would obscure an opening interaction.

## [1.0.0] - 2026-07-27

### Added

- Mobile-friendly 2D editing for compound orthogonal rooms, furniture, walls, swing and sliding doors, and sliding windows.
- First-person WebGL walkthrough with collision handling, interactive openings, a minimap, and desktop or touch controls.
- Local browser persistence with optional Supabase authentication, per-user projects, revision checks, and row-level security.
- Geometry and cloud-store unit tests plus a 103-assertion desktop and mobile browser audit.
- Apache-2.0 licensing and public contribution, conduct, security, privacy, architecture, and self-hosting documentation.
- Reusable GitHub issue, pull request, CI, dependency update, code ownership, and manual Pages deployment configuration.
- Portable Tailscale settings with automatic MagicDNS host detection and environment overrides.

[1.0.0]: https://github.com/achieve0410/room-studio/releases/tag/v1.0.0
