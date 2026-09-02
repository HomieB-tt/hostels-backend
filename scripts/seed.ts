// Dev-only convenience script — NOT for production. Idempotently ensures
// one owner, one custodian, and one student exist (safe to run repeatedly
// against a persisted local Postgres volume — reuses the same three users
// instead of failing on the phone-uniqueness constraint), then always
// creates a FRESH room + bed so you get a clean AVAILABLE bed to test
// with every run, regardless of what state earlier test bookings left
// the previous bed in. Prints ready-to-use JWTs + a curl command so you
// can exercise /bookings/hold end-to-end without a login flow (auth
// issuance wasn't in scope for steps 1-4).
import { env } from "../src/env.js";
import { db, schema } from "../src/db/index.js";
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";

function mint(sub: string, role: string) {
  return jwt.sign({ sub, role }, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    expiresIn: "12h",
  });
}

async function ensureUser(phone: string, name: string, role: "OWNER" | "CUSTODIAN" | "STUDENT") {
  const [existing] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.phone, phone))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(schema.users)
    .values({ phone, name, passwordHash: "dev-seed-not-a-real-hash", role })
    .returning();

  return created!;
}

async function main() {
  const owner = await ensureUser("+256700000001", "Test Owner", "OWNER");
  const custodian = await ensureUser("+256700000002", "Test Custodian", "CUSTODIAN");
  const student = await ensureUser("+256700000003", "Test Student", "STUDENT");

  let [hostel] = await db
    .select()
    .from(schema.hostels)
    .where(eq(schema.hostels.ownerId, owner.id))
    .limit(1);

  if (!hostel) {
    [hostel] = await db
      .insert(schema.hostels)
      .values({
        ownerId: owner.id,
        name: "Test Hostel",
        address: "Wandegeya, Kampala",
        university: "Makerere University",
      })
      .returning();

    await db.insert(schema.staffAssignments).values([
      { userId: owner.id, hostelId: hostel!.id, roleAtProperty: "OWNER" },
      { userId: custodian.id, hostelId: hostel!.id, roleAtProperty: "CUSTODIAN" },
    ]);
  }

  // Always a NEW room+bed, so re-running this script always hands you a
  // clean AVAILABLE bed — unaffected by whatever HELD/PENDING_PAYMENT
  // bookings earlier test runs left behind on previous beds.
  const runSuffix = Date.now().toString(36);

  const [room] = await db
    .insert(schema.rooms)
    .values({
      hostelId: hostel!.id,
      roomNumber: `A-${runSuffix}`,
      roomType: "double",
      pricePerBedPerSemester: "500000",
    })
    .returning();

  const [bed] = await db
    .insert(schema.beds)
    .values({ roomId: room!.id, bedLabel: "A", status: "AVAILABLE" })
    .returning();

  const studentToken = mint(student.id, "STUDENT");
  const custodianToken = mint(custodian.id, "CUSTODIAN");
  const ownerToken = mint(owner.id, "OWNER");

  console.log("\n=== Seed complete (idempotent — reused existing users/hostel if present) ===\n");
  console.log("hostelId:", hostel!.id);
  console.log("bedId:   ", bed!.id, "(freshly created, AVAILABLE)");

  console.log("\n=== JWTs (HS256, 12h) ===");
  console.log("STUDENT  :", studentToken);
  console.log("CUSTODIAN:", custodianToken);
  console.log("OWNER    :", ownerToken);

  console.log("\n=== Try it ===");
  console.log(`
curl -i -X POST http://localhost:${env.PORT}/api/v1/bookings/hold \\
  -H "Authorization: Bearer ${studentToken}" \\
  -H "X-Client-Platform: mobile_app" \\
  -H "Content-Type: application/json" \\
  -d '{
    "bedId": "${bed!.id}",
    "semester": "2026-S1",
    "stayStart": "2026-09-01",
    "stayEnd": "2026-12-15",
    "totalAmount": "500000.00"
  }'
`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
