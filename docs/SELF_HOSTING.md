# Self-hosting

## Local-only deployment

Room Studio is a static Vite application. Without Supabase variables, each browser stores its current drawing locally.
Browser storage and Supabase sessions are scoped to the full origin, not to a URL path. Deploy Room Studio on a dedicated HTTPS origin that does not host unrelated applications. A GitHub Pages deployment should use a dedicated custom domain or a dedicated Pages account rather than a shared `OWNER.github.io` origin.

```bash
npm ci
npm run build
npm run preview
```

Serve the contents of `dist/` from any static HTTPS host. Configure SPA fallback to `index.html` if the host requires it.
The CSP meta tag in `index.html` is a portable baseline. The production host should also send `Content-Security-Policy` with `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and HSTS. Header-based CSP is authoritative and can enforce directives, such as `frame-ancestors`, that browsers ignore in a meta tag.
GitHub.com Pages does not provide per-site custom response headers. Use a header-capable host or a trusted edge proxy in front of Pages before treating that deployment as production-ready.

## Optional Supabase deployment

1. Create a separate Supabase project for the deployment.
2. Apply every migration in `supabase/migrations/` in filename order.
3. Enable only the required authentication providers. Before allowing public signup, configure Supabase rate limits and CAPTCHA or restrict account creation to an allowlist.
4. Add each exact deployment callback URL, including any base path, and the local development callback to the Auth redirect allowlist.
5. Set the two public build variables before `npm run build`:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_KEY
```

Vite embeds these values into the public browser bundle. A publishable key is designed for that use; a `service_role` key or OAuth client secret is not.
The client uses PKCE for magic-link and OAuth redirects. The callback returns to Vite's configured base path, so the deployed base path and Supabase redirect allowlist must agree.

Database migrations reject malformed, unsupported, or larger-than-1 MiB layout snapshots, limit each account to 100 projects, and retain the latest 100 manual versions per project. These are defense-in-depth abuse limits, not a substitute for monitoring, authentication controls, or provider billing limits.

## Operator responsibilities

A deployment operator owns:

- Supabase billing, backup, retention, and recovery;
- authentication provider configuration and redirect allowlists;
- user support and account or drawing deletion procedures;
- a privacy notice appropriate to the deployment;
- dependency and security updates;
- HTTPS, headers, logs, monitoring, and incident response.

Review [SECURITY.md](../SECURITY.md) and [Privacy](PRIVACY.md) before opening a login-enabled deployment to other users.
