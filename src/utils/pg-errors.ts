/**
 * Detects known Postgres error codes from the `postgres` driver without
 * importing its internal error class — only the one field that matters.
 * Centralized here so every module that inserts/deletes against a
 * constrained table catches the SAME set of codes the SAME way, instead
 * of each one growing its own copy (auth/service.ts used to have a local
 * isUniqueViolation — this replaces it).
 */
function getPgErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  return getPgErrorCode(err) === "23505";
}

export function isForeignKeyViolation(err: unknown): boolean {
  return getPgErrorCode(err) === "23503";
}

/** Exclusion constraint violation — e.g. the booking overlap constraint
 * in sql/booking-overlap-constraint.sql. Not yet wired up at the
 * booking-hold call site (flagged in review, still open) — available
 * here for when that's addressed. */
export function isExclusionViolation(err: unknown): boolean {
  return getPgErrorCode(err) === "23P01";
}
