import { eq, and, isNull, gt } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { hashPassword, verifyPassword } from "./password.js";
import { ROLE_PLATFORM_LOCK } from "../../plugins/auth.js";
import type { ClientPlatform, UserRole } from "../../plugins/auth.js";
import { writeAuditLog } from "../../utils/audit.js";

export class PlatformRoleMismatchError extends Error {
  constructor(role: UserRole, requiredPlatform: ClientPlatform) {
    super(`${role} accounts may only be used via ${requiredPlatform}.`);
    this.name = "PlatformRoleMismatchError";
  }
}

export class PhoneAlreadyRegisteredError extends Error {
  constructor() {
    super("An account with this phone number already exists.");
    this.name = "PhoneAlreadyRegisteredError";
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid phone number or password.");
    this.name = "InvalidCredentialsError";
  }
}

export class InvalidInviteError extends Error {
  constructor() {
    super("This invite link is invalid, expired, or already used.");
    this.name = "InvalidInviteError";
  }
}

function assertPlatformAllowed(role: UserRole, platform: ClientPlatform) {
  const lockedTo = ROLE_PLATFORM_LOCK[role];
  if (lockedTo !== null && lockedTo !== platform) {
    throw new PlatformRoleMismatchError(role, lockedTo);
  }
}

/**
 * Open self-registration — STUDENT and OWNER only. CUSTODIAN deliberately
 * has no path here; see registerCustodianViaInvite below. Registering as
 * OWNER does not create a hostel — that's a separate action once hostel
 * management endpoints exist.
 */
export async function registerUser(params: {
  phone: string;
  name: string;
  password: string;
  role: "STUDENT" | "OWNER";
  platform: ClientPlatform;
}) {
  assertPlatformAllowed(params.role, params.platform);

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.phone, params.phone))
    .limit(1);

  if (existing) throw new PhoneAlreadyRegisteredError();

  const passwordHash = await hashPassword(params.password);

  try {
    const [user] = await db
      .insert(schema.users)
      .values({
        phone: params.phone,
        name: params.name,
        passwordHash,
        role: params.role,
      })
      .returning();

    return user!;
  } catch (err) {
    // Safety net for the narrow race window between the existence check
    // above and this insert: two simultaneous registrations with the
    // same phone could both pass that check. The DB's own unique
    // constraint is the real guarantee — this just turns a raw Postgres
    // 23505 into the same clean error the pre-check normally produces,
    // instead of an unhandled 500.
    if (isUniqueViolation(err)) throw new PhoneAlreadyRegisteredError();
    throw err;
  }
}

/** Detects a Postgres unique-violation error (code 23505) from the
 * `postgres` driver without importing its error class directly — avoids
 * a hard dependency on postgres.js's internal error shape beyond the
 * one field that matters. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

export async function loginUser(params: {
  phone: string;
  password: string;
  platform: ClientPlatform;
}) {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.phone, params.phone))
    .limit(1);

  // Same error for "no such user" and "wrong password" — don't leak
  // which phone numbers are registered.
  if (!user) throw new InvalidCredentialsError();

  const ok = await verifyPassword(params.password, user.passwordHash);
  if (!ok) throw new InvalidCredentialsError();

  assertPlatformAllowed(user.role, params.platform);

  return user;
}

/**
 * OWNER-only: generates a time-limited, single-use invite token for
 * onboarding a CUSTODIAN to a specific hostel. Caller must already be
 * verified as an OWNER with property scope over hostelId (enforced at
 * the route layer via requirePropertyScope, not here).
 */
export async function createHostelInvite(params: {
  hostelId: string;
  createdByUserId: string;
}) {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const [invite] = await db
    .insert(schema.hostelInvites)
    .values({
      hostelId: params.hostelId,
      token,
      role: "CUSTODIAN",
      createdByUserId: params.createdByUserId,
      expiresAt,
    })
    .returning();

  return invite!;
}

/**
 * Consumes an invite token to create a CUSTODIAN account tied to the
 * invite's hostel. Single-use: the invite is marked used inside the same
 * transaction that creates the user, so a token can't be raced into
 * creating two accounts.
 */
export async function registerCustodianViaInvite(params: {
  inviteToken: string;
  phone: string;
  name: string;
  password: string;
  platform: ClientPlatform;
}) {
  assertPlatformAllowed("CUSTODIAN", params.platform);

  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(schema.hostelInvites)
      .where(
        and(
          eq(schema.hostelInvites.token, params.inviteToken),
          isNull(schema.hostelInvites.usedAt),
          gt(schema.hostelInvites.expiresAt, new Date()),
        ),
      )
      .for("update");

    if (!invite) throw new InvalidInviteError();

    const [existingUser] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.phone, params.phone))
      .limit(1);

    if (existingUser) throw new PhoneAlreadyRegisteredError();

    const passwordHash = await hashPassword(params.password);

    let user: typeof schema.users.$inferSelect;
    try {
      const [inserted] = await tx
        .insert(schema.users)
        .values({
          phone: params.phone,
          name: params.name,
          passwordHash,
          role: "CUSTODIAN",
        })
        .returning();
      user = inserted!;
    } catch (err) {
      if (isUniqueViolation(err)) throw new PhoneAlreadyRegisteredError();
      throw err;
    }

    await tx.insert(schema.staffAssignments).values({
      userId: user.id,
      hostelId: invite.hostelId,
      roleAtProperty: "CUSTODIAN",
    });

    await tx
      .update(schema.hostelInvites)
      .set({ usedAt: new Date(), usedByUserId: user.id })
      .where(eq(schema.hostelInvites.id, invite.id));

    await writeAuditLog(tx, {
      actorId: invite.createdByUserId,
      ipAddress: "internal:invite_flow",
      action: "custodian.onboarded_via_invite",
      previousState: { inviteId: invite.id },
      newState: { userId: user.id, hostelId: invite.hostelId },
    });

    return user;
  });
}
