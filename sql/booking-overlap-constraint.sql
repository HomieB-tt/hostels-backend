-- =============================================================================
-- Booking overlap-prevention EXCLUDE constraint.
--
-- WHY THIS FILE EXISTS: schema.ts used to "define" this constraint as a
-- raw `sql` template assigned in the table's extraConfig callback. That
-- is not a real Drizzle constraint builder (Drizzle has NO native
-- support for Postgres EXCLUDE constraints — open feature request
-- drizzle-team/drizzle-orm#3388) — drizzle-kit silently dropped it.
-- Confirmed by inspecting the actual generated DDL: no EXCLUDE
-- constraint was ever present. This file is the real fix.
--
-- WHAT IT DOES: prevents two PENDING_PAYMENT/CONFIRMED bookings from
-- ever overlapping on the same bed, enforced by Postgres itself — a
-- backstop below the SELECT ... FOR UPDATE row lock in
-- createBookingHold, for the case where that application-level lock
-- ever has a bug. Requires the btree_gist extension (already enabled
-- locally via docker/postgres/init.sql; for Supabase, run
-- `CREATE EXTENSION IF NOT EXISTS btree_gist;` first — same step you
-- already did for the RLS setup).
--
-- RUN THIS ONCE against EVERY database that has (or will have) a
-- `bookings` table — local Postgres AND the real Supabase project.
-- Not managed by `drizzle-kit push`; it will never appear there.
-- =============================================================================

DO $$ BEGIN
  ALTER TABLE bookings
    ADD CONSTRAINT bookings_no_overlapping_hold
    EXCLUDE USING gist (
      bed_id WITH =,
      stay_period WITH &&
    )
    WHERE (status IN ('PENDING_PAYMENT', 'CONFIRMED'));
EXCEPTION
  WHEN duplicate_object THEN null; -- already applied — safe to re-run
END $$;

-- Verify:
--   SELECT conname FROM pg_constraint WHERE conname = 'bookings_no_overlapping_hold';
-- should return exactly one row.
