# Self-hosting

## Local-only deployment

Room Studio is a static Vite application. Without Supabase variables, each browser stores its current drawing locally.

```bash
npm ci
npm run build
npm run preview
```

Serve the contents of `dist/` from any static HTTPS host. Configure SPA fallback to `index.html` if the host requires it.

## Optional Supabase deployment

1. Create a separate Supabase project for the deployment.
2. Apply every migration in `supabase/migrations/` in filename order.
3. Enable the desired authentication providers.
4. Add the exact deployment origins and local development origin to the Auth redirect allowlist.
5. Set the two public build variables before `npm run build`:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_KEY
```

Vite embeds these values into the public browser bundle. A publishable key is designed for that use; a `service_role` key or OAuth client secret is not.

## Operator responsibilities

A deployment operator owns:

- Supabase billing, backup, retention, and recovery;
- authentication provider configuration and redirect allowlists;
- user support and account or drawing deletion procedures;
- a privacy notice appropriate to the deployment;
- dependency and security updates;
- HTTPS, headers, logs, monitoring, and incident response.

Review [SECURITY.md](../SECURITY.md) and [Privacy](PRIVACY.md) before opening a login-enabled deployment to other users.
