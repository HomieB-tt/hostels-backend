import { and, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { isUniqueViolation, isForeignKeyViolation } from "../../utils/pg-errors.js";
import { omitUndefined } from "../../utils/object.js";

export class HostelNotFoundError extends Error {
  constructor() {
    super("Hostel not found.");
    this.name = "HostelNotFoundError";
  }
}

export class RoomNotFoundError extends Error {
  constructor() {
    super("Room not found in this hostel.");
    this.name = "RoomNotFoundError";
  }
}

export class BedNotFoundError extends Error {
  constructor() {
    super("Bed not found in this room.");
    this.name = "BedNotFoundError";
  }
}

export class RoomNumberConflictError extends Error {
  constructor() {
    super("A room with this number already exists in this hostel.");
    this.name = "RoomNumberConflictError";
  }
}

export class BedLabelConflictError extends Error {
  constructor() {
    super("A bed with this label already exists in this room.");
    this.name = "BedLabelConflictError";
  }
}

export class InvalidBedStatusTransitionError extends Error {
  constructor(currentStatus: string) {
    super(
      `Cannot change status of a bed that is currently ${currentStatus} — resolve the active booking first.`,
    );
    this.name = "InvalidBedStatusTransitionError";
  }
}

export class HasBookingHistoryError extends Error {
  constructor() {
    super("Cannot delete — this room or bed has booking history.");
    this.name = "HasBookingHistoryError";
  }
}

export interface CreateHostelInput {
  name: string;
  address: string;
  university?: string | undefined;
  latitude?: string | undefined;
  longitude?: string | undefined;
}

/**
 * Creates a hostel AND assigns the creating owner as staff on it, in one
 * transaction. Without the staff_assignments row, requirePropertyScope
 * would immediately lock the owner out of managing the hostel they just
 * created — this mirrors what scripts/seed.ts has always done manually.
 */
export async function createHostel(ownerId: string, input: CreateHostelInput) {
  return db.transaction(async (tx) => {
    const [hostel] = await tx
      .insert(schema.hostels)
      .values({ ownerId, ...omitUndefined(input) })
      .returning();

    await tx.insert(schema.staffAssignments).values({
      userId: ownerId,
      hostelId: hostel!.id,
      roleAtProperty: "OWNER",
    });

    return hostel!;
  });
}

export interface UpdateHostelInput {
  name?: string | undefined;
  address?: string | undefined;
  university?: string | undefined;
  latitude?: string | undefined;
  longitude?: string | undefined;
}

export async function updateHostel(hostelId: string, input: UpdateHostelInput) {
  const [updated] = await db
    .update(schema.hostels)
    .set(omitUndefined(input))
    .where(eq(schema.hostels.id, hostelId))
    .returning();

  if (!updated) throw new HostelNotFoundError();
  return updated;
}

export interface CreateRoomInput {
  roomNumber: string;
  roomType: string;
  pricePerBedPerSemester: string;
}

export async function createRoom(hostelId: string, input: CreateRoomInput) {
  try {
    const [room] = await db
      .insert(schema.rooms)
      .values({ hostelId, ...input })
      .returning();
    return room!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new RoomNumberConflictError();
    throw err;
  }
}

export interface UpdateRoomInput {
  roomNumber?: string | undefined;
  roomType?: string | undefined;
  pricePerBedPerSemester?: string | undefined;
}

export async function updateRoom(
  hostelId: string,
  roomId: string,
  input: UpdateRoomInput,
) {
  try {
    const [updated] = await db
      .update(schema.rooms)
      .set(omitUndefined(input))
      .where(and(eq(schema.rooms.id, roomId), eq(schema.rooms.hostelId, hostelId)))
      .returning();

    if (!updated) throw new RoomNotFoundError();
    return updated;
  } catch (err) {
    if (isUniqueViolation(err)) throw new RoomNumberConflictError();
    throw err;
  }
}

export async function deleteRoom(hostelId: string, roomId: string) {
  try {
    const [deleted] = await db
      .delete(schema.rooms)
      .where(and(eq(schema.rooms.id, roomId), eq(schema.rooms.hostelId, hostelId)))
      .returning({ id: schema.rooms.id });

    if (!deleted) throw new RoomNotFoundError();
  } catch (err) {
    // bookings -> beds has onDelete: "restrict", so a room whose beds
    // have any booking history (even long-expired) can't cascade-delete
    // through beds -> rooms. Converted to a clean 409 rather than a raw
    // foreign-key-violation 500 — same principle flagged missing for the
    // booking-overlap EXCLUDE constraint elsewhere.
    if (isForeignKeyViolation(err)) throw new HasBookingHistoryError();
    throw err;
  }
}

export interface CreateBedInput {
  bedLabel: string;
}

export async function createBed(
  hostelId: string,
  roomId: string,
  input: CreateBedInput,
) {
  const [room] = await db
    .select({ id: schema.rooms.id })
    .from(schema.rooms)
    .where(and(eq(schema.rooms.id, roomId), eq(schema.rooms.hostelId, hostelId)))
    .limit(1);

  if (!room) throw new RoomNotFoundError();

  try {
    const [bed] = await db
      .insert(schema.beds)
      .values({ roomId, bedLabel: input.bedLabel, status: "AVAILABLE" })
      .returning();
    return bed!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new BedLabelConflictError();
    throw err;
  }
}

/**
 * The ONLY bed-status transition this endpoint allows is toggling between
 * AVAILABLE and MAINTENANCE. HELD/OCCUPIED are exclusively controlled by
 * the booking/payment flow (createBookingHold, processPesapalIpn,
 * releaseExpiredHold) — letting a management endpoint set those directly
 * would let a custodian silently corrupt an in-flight booking's
 * invariants. Uses the same SELECT ... FOR UPDATE pattern as
 * createBookingHold, to avoid racing a concurrent hold attempt.
 */
export async function setBedStatus(
  hostelId: string,
  roomId: string,
  bedId: string,
  targetStatus: "AVAILABLE" | "MAINTENANCE",
) {
  return db.transaction(async (tx) => {
    const [bed] = await tx
      .select({ id: schema.beds.id, status: schema.beds.status })
      .from(schema.beds)
      .innerJoin(schema.rooms, eq(schema.rooms.id, schema.beds.roomId))
      .where(
        and(
          eq(schema.beds.id, bedId),
          eq(schema.rooms.id, roomId),
          eq(schema.rooms.hostelId, hostelId),
        ),
      )
      .for("update")
      .limit(1);

    if (!bed) throw new BedNotFoundError();

    if (bed.status === "HELD" || bed.status === "OCCUPIED") {
      throw new InvalidBedStatusTransitionError(bed.status);
    }

    const [updated] = await tx
      .update(schema.beds)
      .set({ status: targetStatus })
      .where(eq(schema.beds.id, bedId))
      .returning();

    return updated!;
  });
}

export async function deleteBed(hostelId: string, roomId: string, bedId: string) {
  const [room] = await db
    .select({ id: schema.rooms.id })
    .from(schema.rooms)
    .where(and(eq(schema.rooms.id, roomId), eq(schema.rooms.hostelId, hostelId)))
    .limit(1);

  if (!room) throw new RoomNotFoundError();

  try {
    const [deleted] = await db
      .delete(schema.beds)
      .where(and(eq(schema.beds.id, bedId), eq(schema.beds.roomId, roomId)))
      .returning({ id: schema.beds.id });

    if (!deleted) throw new BedNotFoundError();
  } catch (err) {
    if (isForeignKeyViolation(err)) throw new HasBookingHistoryError();
    throw err;
  }
}
