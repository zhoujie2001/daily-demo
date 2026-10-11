# PR #110 temporary Preview snapshot verification

This verification code is temporary and must be removed before merging PR #110.
It reuses `getDispatchSnapshot` from this PR; it is not a second implementation of
the FK query and does not run dispatch, queue, sheet, or message operations.

## Scope

- Vercel project: `daily-demo` / `prj_AmQbJLMoimeuOM9uLQzjznKcxvXv`.
- Environment: Preview only; branch `fix/dispatch-anchor-consistency` only.
- Supabase project: `cusjrnfczwrbmgkihwls`.
- Reads: day `2026-10-11`, scopes `ad` and `ad_game`, using the existing composite
  FK embedding, one GET per scope, at the start of that historical day.
- Output: presence/count/ordering/date-scope checks, runtime commit and region.
  No full state, assignees, request contexts, or credentials are returned.
- Other environments, projects and branches return 404 before database access.

## Temporary read access (no production service-role key)

The probe uses an existing **publishable** API key and a separate random 256-bit
token. Because the available integration cannot issue a custom-role JWT without
handling the production signing secret, the token is enforced by temporary RLS
SELECT policies for the `anon` Data API role on exactly two tables:

- `public.bess_dispatch_daily_state`
- `public.bess_dispatch_assignments`

Before enabling these policies, verify FORCE RLS is enabled, the only existing
policies are service-role policies, anon has no SELECT/write grants on the tables,
and anon cannot execute any BESS RPC. Abort if this baseline differs.

The temporary policies require **all** of:

1. A matching SHA-256 digest of the separate `x-pr110-read-token` header.
2. Request method GET.
3. The approved day and either approved scope.
4. Server time earlier than a fixed one-hour deadline.

Grant SELECT only. Do not grant INSERT, UPDATE, DELETE, TRUNCATE, sequence access,
role membership, or RPC EXECUTE. Do not change the original service-role policies
or any authenticated-role privileges. Requests with only the public API key must
not return rows. The hash is not a bearer credential; only the token is secret.

The probe adds this header only to fixed-origin GETs and rejects redirects. Its
four `PR110_SNAPSHOT_*` variables are scoped to the approved Preview branch.
`SUPABASE_SERVICE_ROLE_KEY` is never used or copied into Preview.

## Verification and cleanup

1. Check the exact Preview deployment's project, branch and commit.
2. Enable the guarded temporary SELECT policies and verify privileges.
3. Check that missing and wrong read tokens return no rows (GET only).
4. POST `{}` to `/api/dispatch/snapshot-probe` with `x-pr110-probe-token`.
5. Require PASS for both scopes, nonempty ledgers, correct day/scope and order.
6. Remove the two named temporary policies and revoke only the temporary SELECT
   grants. Never use DROP OWNED, broad REVOKE, or any business-data mutation.
7. Check ACLs/RLS/policies match the original baseline and old token returns no
   rows. Check the pre/post hashes of the approved business records.
8. Disable/revoke the branch variables and remove this temporary probe route,
   module, tests and guide before any PR merge. Keep the read-only verification
   report outside the runtime code.

The public key by itself is not a read-only capability; database RLS plus the
temporary token/deadline is what constrains the capability. Never substitute the
production service-role key. Local tests are not a Preview Runtime PASS.
