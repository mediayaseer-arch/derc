# Dashboard Login Verification

- Verified on: 2026-08-20
- Preview route: `/login` redirected to `/dashboard` after submitting the populated credentials.
- Authenticated dashboard content loaded successfully, including the Diriyah Live Panel, visitor counters, filters, and visitor list.
- This confirms the HTTP-only cookie round-trip and `/api/auth/me` dashboard gate work in the running preview.
- The auth endpoints now return `Cache-Control: no-store`; client auth requests use same-origin credentials and `cache: no-store`.
