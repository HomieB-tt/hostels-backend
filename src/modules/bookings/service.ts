import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { writeAuditLog } from "../../utils/audit.js";
import { scheduleAutoReleaseHold } from "../jobs/qstash-client.js";

export class BedUnavailableError extends Error {
  constructor() {
    super("Bed is not available for the requested period.");
    this.name = "BedUnavailableError";
  }
}

const HOLD_MINUTES = 10;

export interface CreateHoldInput {
  bedId: string;
  studentId: string;
  semester: string;
  stayStart: string; // ISO date
  stayEnd: string; // ISO date
  totalAmount: string; // numeric as string to avoid float rounding
  ipAddress: string;
  jobsBaseUrl: string; // e.g. https://api.example.com/api/v1/jobs
}

/**
 * Creates a PENDING_PAYMENT booking hold.
 *
 * Concurrency: wrapped in a single DB transaction that takes
 * `SELECT ... FOR UPDATE` on the target bed row first. Two simultaneous
 * hold requests for the same bed serialize on that lock — the second
 * transaction blocks until the first commits (or rolls back), then
 * re-reads the now-updated bed status and rejects if it's no longer
 * AVAILABLE. The exclusion constraint on `bookings` (bed_id, stay_period)
 * in the schema is the backstop in case this code path is ever bypassed.
 */
export async function createBookingHold(input: CreateHoldInput) {
  const result = await db.transaction(async (tx) => {
    const [bed] = await tx
      .select({ id: schema.beds.id, status: schema.beds.status })
      .from(schema.beds)
      .where(eq(schema.beds.id, input.bedId))
      .for("update");

    if (!bed || bed.status !== "AVAILABLE") {
      throw new BedUnavailableError();
    }

    const holdExpiresAt = new Date(Date.now() + HOLD_MINUTES * 60_000);
    const stayPeriod = `[${input.stayStart},${input.stayEnd})`;

    const [booking] = await tx
      .insert(schema.bookings)
      .values({
        bedId: input.bedId,
        studentId: input.studentId,
        status: "PENDING_PAYMENT",
        semester: input.semester,
        stayPeriod: sql`${stayPeriod}::daterange`,
        totalAmount: input.totalAmount,
        amountPaid: "0",
        dueBalance: input.totalAmount,
        holdExpiresAt,
      })
      .returning();

    await tx
      .update(schema.beds)
      .set({ status: "HELD" })
      .where(eq(schema.beds.id, input.bedId));

    await writeAuditLog(tx, {
      actorId: input.studentId,
      ipAddress: input.ipAddress,
      action: "booking.hold_created",
      previousState: { bedStatus: "AVAILABLE" },
      newState: { bookingId: booking!.id, bedStatus: "HELD", holdExpiresAt },
    });

    return booking!;
  });

  // Scheduled *after* the transaction commits. If QStash scheduling fails
  // here, the hold still exists correctly in the DB rather than being a
  // half-committed booking dependent on an external HTTP call succeeding.
  await scheduleAutoReleaseHold({
    bookingId: result.id,
    destinationUrl: `${input.jobsBaseUrl}/auto-release-hold`,
  });

  return result;
}

/**
 * Idempotent release, called by the QStash auto-release job. No-ops if
 * the booking has already moved past PENDING_PAYMENT — e.g. it was
 * already confirmed by a Pesapal IPN, or already released by a previous,
 * retried delivery of the same job.
 */
export async function releaseExpiredHold(bookingId: string) {
  return db.transaction(async (tx) => {
    const [booking] = await tx
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId))
      .for("update");

    if (!booking) return { released: false, reason: "NOT_FOUND" as const };
    if (booking.status !== "PENDING_PAYMENT") {
      return { released: false, reason: "ALREADY_RESOLVED" as const };
    }

    await tx
      .update(schema.bookings)
      .set({ status: "EXPIRED" })
      .where(eq(schema.bookings.id, bookingId));

    await tx
      .update(schema.beds)
      .set({ status: "AVAILABLE" })
      .where(and(eq(schema.beds.id, booking.bedId), eq(schema.beds.status, "HELD")));

    await writeAuditLog(tx, {
      actorId: null,
      ipAddress: "internal:qstash",
      action: "booking.hold_auto_released",
      previousState: { status: "PENDING_PAYMENT" },
      newState: { status: "EXPIRED" },
    });

    return { released: true as const };
  });
}
