# Running on Replit

This imported project retains its React/Vite frontend and Node/Express backend.

## Development

- Install dependencies with `pnpm install --frozen-lockfile`.
- Use the **Run** button to start the `Start application` workflow.
- The workflow runs `PORT=5000 pnpm run dev`; Express serves the frontend and API on `0.0.0.0:5000`.
- View the preview at a mobile width. The imported app intentionally displays its not-found screen on desktop-sized public pages; this behavior has not been changed.
- `.npmrc` disables automatic pnpm version downloads so the project uses the available pnpm installation.

## Service configuration

The existing Supabase connection is configured through Replit Secrets. A read-only test successfully accessed the public settings table.

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are configured through Replit Secrets. Do not put secret values in source files or chat.
- Use the project's existing Supabase instance and schema (`supabase-schema.sql`); do not replace or migrate its database as part of setup.
- `SESSION_SECRET` is already available.
- Dashboard authorization uses Supabase user roles or the `ADMIN_EMAILS` setting.
- The legacy OAuth integration warns when `OAUTH_SERVER_URL` is absent. Its login path also needs the corresponding configuration listed in `.env.example`.
- Email, AI, storage, and BIN lookup integrations need their own configuration only if those features are used. See `.env.example` for variable names.
- Restart the workflow after changing service configuration.

## Verification

- `pnpm run check`: TypeScript check.
- `pnpm run build`: frontend and production server build.
- `pnpm test`: automated tests.
- `/api/health`: basic server health; this does not verify external services.

Initial setup passed the type check and production build, and the mobile homepage was visually verified. After Supabase configuration, the live read-only connection test passed. Routing/auth regression checks passed, and an unauthenticated `/dashboard` visit was visually verified to show login. The signed-in dashboard and complete booking flow have not been verified.

The imported test suite has one failing cashback-copy assertion in `client/src/components/CashbackPopup.test.ts`. Run the live connection test with `RUN_SUPABASE_INTEGRATION_TESTS=1 pnpm exec vitest run server/supabase.credentials.test.ts`.

Routes: `/` is the main dashboard page, `/dashboard` remains an alias, `/login` serves login, and the public visitor homepage is available at `/home`. Successful login redirects to `/`; the dashboard's existing authentication guard redirects unauthenticated visitors to `/login`.
