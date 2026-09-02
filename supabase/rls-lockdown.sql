-- =============================================================================
-- Row Level Security lockdown for the hostel-platform Supabase project.
--
-- RUN THIS AGAINST YOUR REAL SUPABASE PROJECT ONLY (SQL Editor, or psql
-- against SUPABASE_DATABASE_URL) — NOT against local docker-compose
-- Postgres. Local Postgres has no `anon`/`authenticated` roles (those are
-- created by Supabase's platform setup), so this script will error with
-- "role does not exist" if run there. It's intentionally excluded from
-- the Drizzle-managed migrations in ./drizzle for that reason.
--
-- Architecture context: this backend does NOT use Supabase Auth — it
-- issues its own JWTs and connects to Postgres via the service_role
-- connection string (SUPABASE_DATABASE_URL). service_role has BYPASSRLS,
-- so none of what follows affects your Fastify backend's own queries at
-- all — they keep working exactly as before. What this DOES do: it shuts
-- the door on Supabase's auto-generated public REST API (PostgREST),
-- which otherwise exposes every table in this schema to anyone holding
-- your SUPABASE_ANON_KEY — a key that ships inside your mobile app
-- bundle and can't be treated as secret.
--
-- Net effect after running this: `anon` and `authenticated` can do
-- NOTHING against any of these tables — not SELECT, not INSERT, nothing.
-- Zero policies + RLS enabled = deny-all for any role without BYPASSRLS.
-- That matches "100% of traffic goes through the Fastify API" — there is
-- deliberately no per-row policy logic here, because there is no
-- legitimate direct-to-Supabase client in this architecture at all.
-- =============================================================================

BEGIN;

-- --- Enable + force RLS on every table -------------------------------------
-- FORCE means even the table owner is subject to RLS (defense in depth —
-- doesn't affect service_role, which bypasses RLS regardless of FORCE,
-- but protects against ever connecting with a lesser-privileged owner
-- role by accident).

ALTER TABLE public.users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users               FORCE  ROW LEVEL SECURITY;

ALTER TABLE public.hostels             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hostels             FORCE  ROW LEVEL SECURITY;

ALTER TABLE public.rooms               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rooms               FORCE  ROW LEVEL SECURITY;

ALTER TABLE public.beds                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.beds                FORCE  ROW LEVEL SECURITY;

ALTER TABLE public.bookings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings            FORCE  ROW LEVEL SECURITY;

ALTER TABLE public.staff_assignments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_assignments   FORCE  ROW LEVEL SECURITY;

ALTER TABLE public.audit_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs          FORCE  ROW LEVEL SECURITY;

ALTER TABLE public.processed_webhooks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processed_webhooks  FORCE  ROW LEVEL SECURITY;

-- --- Explicitly revoke default grants ---------------------------------------
-- Supabase projects typically grant broad default privileges to `anon`
-- and `authenticated` on the public schema. RLS with no policies already
-- blocks row access for these roles, but revoking the underlying table
-- privileges too means there's nothing to fall back on even if a policy
-- is ever added carelessly later, or RLS is accidentally disabled on one
-- table during a future migration.

REVOKE ALL ON public.users              FROM anon, authenticated;
REVOKE ALL ON public.hostels            FROM anon, authenticated;
REVOKE ALL ON public.rooms              FROM anon, authenticated;
REVOKE ALL ON public.beds               FROM anon, authenticated;
REVOKE ALL ON public.bookings           FROM anon, authenticated;
REVOKE ALL ON public.staff_assignments  FROM anon, authenticated;
REVOKE ALL ON public.audit_logs         FROM anon, authenticated;
REVOKE ALL ON public.processed_webhooks FROM anon, authenticated;

-- Also lock down any tables added later in this schema by default, so
-- this protection doesn't silently stop applying the next time someone
-- runs `drizzle-kit push` and adds a table.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;

COMMIT;

-- --- Verify -------------------------------------------------------------
-- Run this after COMMIT to confirm every table shows rowsecurity = true
-- and forcerowsecurity = true:
--
--   SELECT schemaname, tablename, rowsecurity, forcerowsecurity
--   FROM pg_tables
--   WHERE schemaname = 'public';
--
-- And confirm zero policies exist (expected — that's the point):
--
--   SELECT schemaname, tablename, policyname FROM pg_policies
--   WHERE schemaname = 'public';
