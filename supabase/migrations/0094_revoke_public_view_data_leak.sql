-- Supabase's Security Advisor flags public.profile_identity_overview and
-- public.member_reading_summary as CRITICAL "Security Definer View" issues.
-- Both views were GRANTed SELECT to `authenticated` with no per-user WHERE
-- clause; a plain Postgres view runs with the privileges of its owner, not
-- the querying role, so it bypasses RLS on the underlying profiles /
-- user_identities / reading_plans / reading_logs tables entirely — any
-- session holding a genuine Supabase `authenticated` JWT (dev/localhost
-- Google login) could SELECT every member's name, email, org placement,
-- identity provider info, and reading activity, not just their own.
--
-- Only supabase/functions/nlc-data/index.ts reads these views, and it does
-- so with the service-role key, which already bypasses RLS by design and
-- does not need (or use) the `authenticated` grant. Revoking it removes the
-- data leak with no functional impact.
REVOKE SELECT ON public.profile_identity_overview FROM authenticated;
REVOKE SELECT ON public.member_reading_summary FROM authenticated;
