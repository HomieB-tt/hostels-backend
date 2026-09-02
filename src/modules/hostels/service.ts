import { and, eq, ilike, or, sql, desc, isNull, isNotNull } from "drizzle-orm";
import { db, schema } from "../../db/index.js";

export interface HostelSearchParams {
  q?: string | undefined;
  university?: string | undefined;
  page: number;
  limit: number;
}

/** Shared aggregate select shape — used by both search and "saved
 * hostels", so the two lists render identically instead of two
 * hand-copied versions of the same query quietly drifting apart. */
const hostelSummaryColumns = {
  id: schema.hostels.id,
  name: schema.hostels.name,
  address: schema.hostels.address,
  university: schema.hostels.university,
  latitude: schema.hostels.latitude,
  longitude: schema.hostels.longitude,
  availableBedsCount: sql<number>`count(*) filter (where ${schema.beds.status} = 'AVAILABLE')::int`,
  minPricePerBedPerSemester: sql<string | null>`min(${schema.rooms.pricePerBedPerSemester})`,
};

/**
 * Public search/listing. Deliberately selects only public-safe columns —
 * ownerId is never returned here, since there's no reason a prospective
 * student browsing hostels needs to see internal user IDs.
 */
export async function searchHostels(params: HostelSearchParams) {
  const conditions = [];

  if (params.university) {
    conditions.push(eq(schema.hostels.university, params.university));
  }
  if (params.q) {
    conditions.push(
      or(
        ilike(schema.hostels.name, `%${params.q}%`),
        ilike(schema.hostels.address, `%${params.q}%`),
      ),
    );
  }

  const whereClause = conditions.length ? and(...conditions) : undefined;
  const offset = (params.page - 1) * params.limit;

  const [rows, totalRows] = await Promise.all([
    db
      .select(hostelSummaryColumns)
      .from(schema.hostels)
      .leftJoin(schema.rooms, eq(schema.rooms.hostelId, schema.hostels.id))
      .leftJoin(schema.beds, eq(schema.beds.roomId, schema.rooms.id))
      .where(whereClause)
      .groupBy(schema.hostels.id)
      .orderBy(schema.hostels.name)
      .limit(params.limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.hostels)
      .where(whereClause),
  ]);

  // Avoids nested destructuring off a possibly-undefined array element
  // (const [{ total }] = totalRows would try to destructure a property
  // off a value TypeScript types as {total:number}|undefined under
  // noUncheckedIndexedAccess) — optional chaining + fallback is the safe
  // form.
  const total = totalRows[0]?.total ?? 0;

  return { hostels: rows, page: params.page, limit: params.limit, total };
}

/**
 * Hostel detail — rooms nested with their beds and current status. Bed
 * status alone (AVAILABLE/HELD/OCCUPIED/MAINTENANCE) is shown; nothing
 * about WHO holds/occupies a bed is ever exposed here — that would mean
 * joining into bookings/users, which a public endpoint has no business
 * doing.
 */
export async function getHostelDetail(hostelId: string) {
  const [hostel] = await db
    .select({
      id: schema.hostels.id,
      name: schema.hostels.name,
      address: schema.hostels.address,
      university: schema.hostels.university,
      latitude: schema.hostels.latitude,
      longitude: schema.hostels.longitude,
    })
    .from(schema.hostels)
    .where(eq(schema.hostels.id, hostelId))
    .limit(1);

  if (!hostel) return null;

  const roomRows = await db
    .select({
      roomId: schema.rooms.id,
      roomNumber: schema.rooms.roomNumber,
      roomType: schema.rooms.roomType,
      pricePerBedPerSemester: schema.rooms.pricePerBedPerSemester,
      bedId: schema.beds.id,
      bedLabel: schema.beds.bedLabel,
      bedStatus: schema.beds.status,
    })
    .from(schema.rooms)
    .leftJoin(schema.beds, eq(schema.beds.roomId, schema.rooms.id))
    .where(eq(schema.rooms.hostelId, hostelId))
    .orderBy(schema.rooms.roomNumber, schema.beds.bedLabel);

  const roomsById = new Map<
    string,
    {
      id: string;
      roomNumber: string;
      roomType: string;
      pricePerBedPerSemester: string;
      beds: { id: string; bedLabel: string; status: string }[];
    }
  >();

  for (const row of roomRows) {
    if (!roomsById.has(row.roomId)) {
      roomsById.set(row.roomId, {
        id: row.roomId,
        roomNumber: row.roomNumber,
        roomType: row.roomType,
        pricePerBedPerSemester: row.pricePerBedPerSemester,
        beds: [],
      });
    }
    if (row.bedId) {
      roomsById.get(row.roomId)!.beds.push({
        id: row.bedId,
        bedLabel: row.bedLabel!,
        status: row.bedStatus!,
      });
    }
  }

  return { ...hostel, rooms: Array.from(roomsById.values()) };
}

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

/** Idempotent — saving an already-saved hostel is a no-op, not an error,
 * since a double-tap on a "save" button shouldn't surface a failure.
 * roomId is explicitly NULL here — this is the "save the whole hostel"
 * path, distinct from saveRoom below. */
export async function saveHostel(studentId: string, hostelId: string) {
  const [hostel] = await db
    .select({ id: schema.hostels.id })
    .from(schema.hostels)
    .where(eq(schema.hostels.id, hostelId))
    .limit(1);

  if (!hostel) throw new HostelNotFoundError();

  await db
    .insert(schema.savedItems)
    .values({ studentId, hostelId, roomId: null })
    .onConflictDoNothing();
}

export async function unsaveHostel(studentId: string, hostelId: string) {
  await db
    .delete(schema.savedItems)
    .where(
      and(
        eq(schema.savedItems.studentId, studentId),
        eq(schema.savedItems.hostelId, hostelId),
        isNull(schema.savedItems.roomId),
      ),
    );
}

/** Save a specific ROOM, not the whole hostel. Validates the room
 * actually belongs to hostelId (not just that the room exists) — catches
 * a caller passing a real roomId but a mismatched hostelId in the URL. */
export async function saveRoom(studentId: string, hostelId: string, roomId: string) {
  const [room] = await db
    .select({ id: schema.rooms.id })
    .from(schema.rooms)
    .where(and(eq(schema.rooms.id, roomId), eq(schema.rooms.hostelId, hostelId)))
    .limit(1);

  if (!room) throw new RoomNotFoundError();

  await db
    .insert(schema.savedItems)
    .values({ studentId, hostelId, roomId })
    .onConflictDoNothing();
}

export async function unsaveRoom(studentId: string, roomId: string) {
  await db
    .delete(schema.savedItems)
    .where(and(eq(schema.savedItems.studentId, studentId), eq(schema.savedItems.roomId, roomId)));
}

/**
 * Unified "Saved" list — hostel-level and room-level saves both surface
 * here, each tagged with `type`. Run as two separate queries rather than
 * one UNION: a hostel-level save aggregates availability across ALL of
 * that hostel's rooms, while a room-level save reports just that one
 * room — different aggregation scopes that don't collapse cleanly into a
 * single grouped query. Merged and paginated in application code, which
 * is fine at the scale one student's saved list actually reaches (this
 * would need revisiting if "saved items" ever became a bulk/analytics
 * feature, but it isn't one).
 */
export async function listSavedItems(
  studentId: string,
  params: { page: number; limit: number },
) {
  const [hostelLevel, roomLevel] = await Promise.all([
    db
      .select({
        itemId: schema.savedItems.id,
        type: sql<"HOSTEL">`'HOSTEL'`,
        savedAt: schema.savedItems.createdAt,
        ...hostelSummaryColumns,
      })
      .from(schema.savedItems)
      .innerJoin(schema.hostels, eq(schema.hostels.id, schema.savedItems.hostelId))
      .leftJoin(schema.rooms, eq(schema.rooms.hostelId, schema.hostels.id))
      .leftJoin(schema.beds, eq(schema.beds.roomId, schema.rooms.id))
      .where(and(eq(schema.savedItems.studentId, studentId), isNull(schema.savedItems.roomId)))
      .groupBy(schema.savedItems.id, schema.hostels.id),

    db
      .select({
        itemId: schema.savedItems.id,
        type: sql<"ROOM">`'ROOM'`,
        savedAt: schema.savedItems.createdAt,
        hostelId: schema.hostels.id,
        hostelName: schema.hostels.name,
        roomId: schema.rooms.id,
        roomNumber: schema.rooms.roomNumber,
        roomType: schema.rooms.roomType,
        pricePerBedPerSemester: schema.rooms.pricePerBedPerSemester,
        availableBedsCount: sql<number>`count(*) filter (where ${schema.beds.status} = 'AVAILABLE')::int`,
      })
      .from(schema.savedItems)
      .innerJoin(schema.rooms, eq(schema.rooms.id, schema.savedItems.roomId))
      .innerJoin(schema.hostels, eq(schema.hostels.id, schema.rooms.hostelId))
      .leftJoin(schema.beds, eq(schema.beds.roomId, schema.rooms.id))
      .where(and(eq(schema.savedItems.studentId, studentId), isNotNull(schema.savedItems.roomId)))
      .groupBy(schema.savedItems.id, schema.hostels.id, schema.rooms.id),
  ]);

  const merged = [...hostelLevel, ...roomLevel].sort(
    (a, b) => b.savedAt.getTime() - a.savedAt.getTime(),
  );

  const offset = (params.page - 1) * params.limit;
  const page = merged.slice(offset, offset + params.limit);

  return { items: page, page: params.page, limit: params.limit, total: merged.length };
}
