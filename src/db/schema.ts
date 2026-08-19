import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  integer,
  numeric,
  jsonb,
  customType,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

/**
 * Postgres `daterange` — Drizzle has no first-class type for it, so we
 * define it as a custom type. Used for booking stay periods; overlap
 * checks use the `&&` operator directly in SQL (see modules/bookings).
 */
const daterange = customType<{ data: string; driverData: string }>({
  dataType() {
    return "daterange";
  },
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRoleEnum = pgEnum("user_role", [
  "STUDENT",
  "CUSTODIAN",
  "OWNER",
  "ADMIN",
]);

export const bedStatusEnum = pgEnum("bed_status", [
  "AVAILABLE",
  "HELD",
  "OCCUPIED",
  "MAINTENANCE",
]);

export const bookingStatusEnum = pgEnum("booking_status", [
  "PENDING_PAYMENT",
  "CONFIRMED",
  "CANCELLED",
  "EXPIRED",
]);

export const staffRoleEnum = pgEnum("staff_role", ["OWNER", "CUSTODIAN"]);

// ---------------------------------------------------------------------------
// 1. users
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: varchar("phone", { length: 13 }).notNull().unique(), // +256XXXXXXXXX
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull().default("STUDENT"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    phoneFormatCheck: sql`CHECK (${t.phone} ~ '^\\+256[0-9]{9}$')`,
  }),
);

// ---------------------------------------------------------------------------
// 2. hostels
// ---------------------------------------------------------------------------

export const hostels = pgTable("hostels", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  address: text("address").notNull(),
  university: text("university"), // e.g. "Makerere University"
  latitude: numeric("latitude", { precision: 9, scale: 6 }),
  longitude: numeric("longitude", { precision: 9, scale: 6 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// 3. rooms
// ---------------------------------------------------------------------------

export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostelId: uuid("hostel_id")
      .notNull()
      .references(() => hostels.id, { onDelete: "cascade" }),
    roomNumber: text("room_number").notNull(),
    roomType: text("room_type").notNull(), // e.g. "double", "self-contained"
    pricePerBedPerSemester: numeric("price_per_bed_per_semester", {
      precision: 12,
      scale: 2,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    hostelRoomUnique: uniqueIndex("rooms_hostel_room_number_uq").on(
      t.hostelId,
      t.roomNumber,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 4. beds
// ---------------------------------------------------------------------------

export const beds = pgTable(
  "beds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    bedLabel: text("bed_label").notNull(), // e.g. "A", "B"
    status: bedStatusEnum("status").notNull().default("AVAILABLE"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    roomBedUnique: uniqueIndex("beds_room_label_uq").on(
      t.roomId,
      t.bedLabel,
    ),
    statusIdx: index("beds_status_idx").on(t.status),
  }),
);

// ---------------------------------------------------------------------------
// 5. bookings
// ---------------------------------------------------------------------------

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bedId: uuid("bed_id")
      .notNull()
      .references(() => beds.id, { onDelete: "restrict" }),
    studentId: uuid("student_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: bookingStatusEnum("status").notNull().default("PENDING_PAYMENT"),
    semester: text("semester").notNull(), // e.g. "2026-S1"
    stayPeriod: daterange("stay_period").notNull(),
    totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull(),
    amountPaid: numeric("amount_paid", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    dueBalance: numeric("due_balance", { precision: 12, scale: 2 }).notNull(),
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bedStatusIdx: index("bookings_bed_status_idx").on(t.bedId, t.status),
    studentIdx: index("bookings_student_idx").on(t.studentId),
    // Prevent overlapping CONFIRMED/PENDING bookings for the same bed at the
    // DB level (belt-and-suspenders on top of the SELECT ... FOR UPDATE lock
    // used at hold time). Requires the btree_gist extension in migrations.
    noOverlap: sql`EXCLUDE USING gist (${t.bedId} WITH =, ${t.stayPeriod} WITH &&) WHERE (status IN ('PENDING_PAYMENT', 'CONFIRMED'))`,
  }),
);

// ---------------------------------------------------------------------------
// 6. staff_assignments  (IDOR scope: who may act on which hostel)
// ---------------------------------------------------------------------------

export const staffAssignments = pgTable(
  "staff_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    hostelId: uuid("hostel_id")
      .notNull()
      .references(() => hostels.id, { onDelete: "cascade" }),
    roleAtProperty: staffRoleEnum("role_at_property").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userHostelUnique: uniqueIndex("staff_assignments_user_hostel_uq").on(
      t.userId,
      t.hostelId,
    ),
    hostelIdx: index("staff_assignments_hostel_idx").on(t.hostelId),
  }),
);

// ---------------------------------------------------------------------------
// 7. audit_logs (immutable — application layer must never UPDATE/DELETE)
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ipAddress: text("ip_address").notNull(),
    action: text("action").notNull(), // e.g. "booking.confirm", "bed.release"
    previousState: jsonb("previous_state"),
    newState: jsonb("new_state"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    actorIdx: index("audit_logs_actor_idx").on(t.actorId),
    createdAtIdx: index("audit_logs_created_at_idx").on(t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Supporting table: processed webhooks (Pesapal IPN idempotency, §3)
// Not one of the 7 base entities, but required by the idempotency rule.
// ---------------------------------------------------------------------------

export const processedWebhooks = pgTable("processed_webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  transactionId: text("transaction_id").notNull().unique(),
  source: text("source").notNull().default("pesapal_ipn"),
  processedAt: timestamp("processed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  hostelsOwned: many(hostels),
  bookings: many(bookings),
  staffAssignments: many(staffAssignments),
}));

export const hostelsRelations = relations(hostels, ({ one, many }) => ({
  owner: one(users, { fields: [hostels.ownerId], references: [users.id] }),
  rooms: many(rooms),
  staffAssignments: many(staffAssignments),
}));

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  hostel: one(hostels, { fields: [rooms.hostelId], references: [hostels.id] }),
  beds: many(beds),
}));

export const bedsRelations = relations(beds, ({ one, many }) => ({
  room: one(rooms, { fields: [beds.roomId], references: [rooms.id] }),
  bookings: many(bookings),
}));

export const bookingsRelations = relations(bookings, ({ one }) => ({
  bed: one(beds, { fields: [bookings.bedId], references: [beds.id] }),
  student: one(users, {
    fields: [bookings.studentId],
    references: [users.id],
  }),
}));

export const staffAssignmentsRelations = relations(
  staffAssignments,
  ({ one }) => ({
    user: one(users, {
      fields: [staffAssignments.userId],
      references: [users.id],
    }),
    hostel: one(hostels, {
      fields: [staffAssignments.hostelId],
      references: [hostels.id],
    }),
  }),
);
