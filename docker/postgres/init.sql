-- Runs automatically on first container init (empty data volume only).
-- btree_gist is required for the EXCLUDE USING gist constraint on
-- `bookings` below — gist has no native equality operator class for
-- uuid without it.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- NOTE: this only covers a FRESH container (empty volume). If your
-- postgres_data volume already exists (tables already created via
-- drizzle-kit push), this script does NOT re-run — apply
-- ../../sql/booking-overlap-constraint.sql manually instead. Kept here
-- too so a brand-new checkout gets it automatically without a separate
-- manual step. The `bookings` table must already exist for this to
-- succeed, so if drizzle-kit push runs AFTER this script on a fresh
-- container, the ALTER TABLE below will simply fail harmlessly — in that
-- case just run sql/booking-overlap-constraint.sql once after push.
DO $$ BEGIN
  ALTER TABLE bookings
    ADD CONSTRAINT bookings_no_overlapping_hold
    EXCLUDE USING gist (
      bed_id WITH =,
      stay_period WITH &&
    )
    WHERE (status IN ('PENDING_PAYMENT', 'CONFIRMED'));
EXCEPTION
  WHEN duplicate_object THEN null;
  WHEN undefined_table THEN null; -- bookings doesn't exist yet on fresh init
END $$;
