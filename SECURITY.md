# Security policy

## Supported version

Security fixes are applied to the current `main` branch. Until tagged releases and a formal support window exist, older snapshots are not maintained separately.

## Reporting a vulnerability

Do not open a public issue containing vulnerability details, credentials, private floor plans, or personal data.

Use GitHub's **Security → Advisories → Report a vulnerability** flow for the repository. If private vulnerability reporting is not available yet, open a public issue that only asks the maintainer to establish a private contact channel; do not include exploit or incident details.

Include, when possible:

- affected commit or version;
- browser and deployment mode;
- local-only or Supabase-backed mode;
- reproduction steps and impact;
- whether credentials or user data may be exposed;
- a suggested remediation, if known.

The maintainer will acknowledge a complete report as capacity allows, coordinate a fix privately, and publish an advisory when affected users need to take action.

## Deployment security invariants

- `VITE_*` values are public browser configuration.
- Supabase `service_role` keys and OAuth client secrets must never enter the repository or browser bundle.
- Authentication redirects use PKCE and must return to an explicitly allowlisted deployment base URL.
- Production deployments must use a dedicated HTTPS origin and enforce CSP, framing, MIME-sniffing, referrer, permissions, and transport-security headers.
- Database writes reject malformed, unsupported, or oversized layouts, cap project creation per account, and bound retained project versions.
- Cloud project writes must use RLS and the revision-checked `save_project` RPC.
- Tailscale sharing must remain tailnet-only; the helper binds only to `127.0.0.1` or `localhost`, rejects symlinked runtime metadata, and does not enable Funnel.
- Operators are responsible for OAuth redirect allowlists, database backups, account lifecycle, and their own privacy notices.
