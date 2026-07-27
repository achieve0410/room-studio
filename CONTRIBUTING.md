# Contributing to Room Studio

Thank you for helping make browser-based room planning more accessible. Keep changes focused, testable, and compatible with existing saved drawings.

## Before you start

- Search existing issues before opening a duplicate.
- Use an issue to discuss large interaction, storage-schema, or architecture changes first.
- Never include real home floor plans, email addresses, credentials, Supabase secrets, or private Tailscale hostnames in issues, fixtures, screenshots, or commits.
- Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and report vulnerabilities through [SECURITY.md](SECURITY.md).

## Local setup

```bash
nvm use
npm ci
npm run dev
```

Supabase is optional. The editor must remain useful in local-only mode with no `.env` file.

## Change rules

- Preserve backward compatibility for `localStorage` and cloud drawing payloads unless a documented migration is included.
- Route cloud project writes through the revision-checked `save_project` RPC. Do not add direct client writes that bypass optimistic concurrency or RLS.
- Add a new timestamped Supabase migration instead of editing a migration that may already be deployed.
- Keep secrets server-side. Vite variables are public browser configuration.
- Reuse the existing vanilla JavaScript, CSS, and geometry patterns before adding a dependency.
- Keep mobile touch targets at least 44 CSS pixels and provide a keyboard-accessible equivalent for touch interactions.
- Do not silently change dimensions, collision rules, door behavior, or persisted schema semantics.

## Tests

Run the smallest relevant test while developing, then the full checks before opening a pull request.

```bash
npm run check
npm run test:browser:mobile
```

For visual changes, include before/after screenshots for a representative mobile viewport and desktop viewport. For 2D/3D behavior changes, verify both renderers and saved-state restoration.

## Pull requests

A pull request should:

1. Explain the user-facing problem and why the change is needed.
2. Stay scoped to one behavior or maintenance goal.
3. Link the relevant issue when one exists.
4. List the exact validation performed.
5. Call out storage, migration, privacy, security, accessibility, and mobile impact.
6. Avoid unrelated formatting or refactors.

By contributing, you agree that your contribution is licensed under Apache License 2.0, the same license as this repository.
