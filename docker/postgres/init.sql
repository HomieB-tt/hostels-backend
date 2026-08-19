-- Runs automatically on first container init (empty data volume only).
-- btree_gist is required for the EXCLUDE USING gist (bed_id WITH =, ...)
-- constraint on `bookings` in src/db/schema.ts — gist has no native
-- equality operator class for uuid without it.
CREATE EXTENSION IF NOT EXISTS btree_gist;
