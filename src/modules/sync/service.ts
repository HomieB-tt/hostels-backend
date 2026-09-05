import { and, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { writeAuditLog } from "../../utils/audit.js";

export type CheckinResultStatus =
  | "created"
  | "already_processed"
  | "booking_not_found"
  | "forbidden"
  | "invalid_booking_state";

export interface CheckinInput {
  id: string;
  bookingId: string;
  checkedInAt: string; // ISO 8601
}

export interface CheckinResult {
  id: string;
  status: CheckinResultStatus;
}

/**
 * Processes ONE check-in from an offline sync batch. Deliberately
 * independent of the other items in the batch — see processCheckinBatch.
 */
async function processCheckin(
  input: CheckinInput,
  custodianId: string,
  ipAddress: string,
): Promise<CheckinResult> {
  // Idempotency check FIRST — a replayed item must never re-run
  // authorization/state checks against data that may have changed since
  // the original (successful) attempt.
  const [existing] = await db
    .select({ id: schema.checkins.id })
    .from(schema.checkins)
    .where(eq(schema.checkins.id, input.id))
    .limit(1);

  if (existing) {
    return { id: input.id, status: "already_processed" };
  }

  const [booking] = await db
    .select({
      id: schema.bookings.id,
      status: schema.bookings.status,
      hostelId: schema.hostels.id,
    })
    .from(schema.bookings)
    .innerJoin(schema.beds, eq(schema.beds.id, schema.bookings.bedId))
    .innerJoin(schema.rooms, eq(schema.rooms.id, schema.beds.roomId))
    .innerJoin(schema.hostels, eq(schema.hostels.id, schema.rooms.hostelId))
    .where(eq(schema.bookings.id, input.bookingId))
    .limit(1);

  if (!booking) {
    return { id: input.id, status: "booking_not_found" };
  }

  // IDOR check — same principle as requirePropertyScope, applied per-item
  // since this endpoint has no :hostelId in its URL (a batch can span
  // any hostel the custodian is actually assigned to).
  const [assignment] = await db
    .select({ id: schema.staffAssignments.id })
    .from(schema.staffAssignments)
    .where(
      and(
        eq(schema.staffAssignments.userId, custodianId),
        eq(schema.staffAssignments.hostelId, booking.hostelId),
      ),
    )
    .limit(1);

  if (!assignment) {
    return { id: input.id, status: "forbidden" };
  }

  if (booking.status !== "CONFIRMED") {
    return { id: input.id, status: "invalid_booking_state" };
  }

  const [inserted] = await db
    .insert(schema.checkins)
    .values({
      id: input.id,
      bookingId: input.bookingId,
      custodianId,
      checkedInAt: new Date(input.checkedInAt),
    })
    .onConflictDoNothing()
    .returning({ id: schema.checkins.id });

  if (!inserted) {
    // Lost a race against a concurrent identical sync (e.g. two devices
    // syncing the same offline queue) — same outcome as already_processed
    // from the client's point of view.
    return { id: input.id, status: "already_processed" };
  }

  await writeAuditLog(db, {
    actorId: custodianId,
    ipAddress,
    action: "booking.checked_in",
    previousState: null,
    newState: { checkinId: input.id, bookingId: input.bookingId },
  });

  return { id: input.id, status: "created" };
}

/**
 * Processes a whole offline-sync batch, one item at a time. Deliberately
 * NOT a single all-or-nothing transaction — a sync batch will realistically
 * mix good and stale/bad records, and the client needs per-item feedback
 * to know what to retry vs. discard from its local queue. Failing the
 * entire batch over one bad record would be a worse offline-sync
 * experience than partial success with clear per-item results.
 */
export async function processCheckinBatch(
  inputs: CheckinInput[],
  custodianId: string,
  ipAddress: string,
): Promise<CheckinResult[]> {
  const results: CheckinResult[] = [];
  for (const input of inputs) {
    results.push(await processCheckin(input, custodianId, ipAddress));
  }
  return results;
}
