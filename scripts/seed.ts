// Dev-only convenience script — NOT for production. Seeds a minimal
// dataset (one owner, one custodian, one student, one hostel/room/bed)
// and prints ready-to-use JWTs + curl commands so you can exercise
// /bookings/hold and /payments/ipn end-to-end without building a
// login flow first (auth issuance wasn't in scope for steps 1-4).
import { env } from "../src/env.js";
import { db, schema } from "../src/db/index.js";
import jwt from "jsonwebtoken";

function mint(sub: string, role: string) {
  return jwt.sign({ sub, role }, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    expiresIn: "12h",
  });
}

async function main() {
  const [owner] = await db
    .insert(schema.users)
    .values({
      phone: "+256700000001",
      name: "Test Owner",
      passwordHash: "dev-seed-not-a-real-hash",
      role: "OWNER",
    })
    .returning();

  const [custodian] = await db
    .insert(schema.users)
    .values({
      phone: "+256700000002",
      name: "Test Custodian",
      passwordHash: "dev-seed-not-a-real-hash",
      role: "CUSTODIAN",
    })
    .returning();

  const [student] = await db
    .insert(schema.users)
    .values({
      phone: "+256700000003",
      name: "Test Student",
      passwordHash: "dev-seed-not-a-real-hash",
      role: "STUDENT",
    })
    .returning();

  const [hostel] = await db
    .insert(schema.hostels)
    .values({
      ownerId: owner!.id,
      name: "Test Hostel",
      address: "Wandegeya, Kampala",
      university: "Makerere University",
    })
    .returning();

  await db.insert(schema.staffAssignments).values([
    { userId: owner!.id, hostelId: hostel!.id, roleAtProperty: "OWNER" },
    { userId: custodian!.id, hostelId: hostel!.id, roleAtProperty: "CUSTODIAN" },
  ]);

  const [room] = await db
    .insert(schema.rooms)
    .values({
      hostelId: hostel!.id,
      roomNumber: "A1",
      roomType: "double",
      pricePerBedPerSemester: "500000",
    })
    .returning();

  const [bed] = await db
    .insert(schema.beds)
    .values({ roomId: room!.id, bedLabel: "A", status: "AVAILABLE" })
    .returning();

  const studentToken = mint(student!.id, "STUDENT");
  const custodianToken = mint(custodian!.id, "CUSTODIAN");
  const ownerToken = mint(owner!.id, "OWNER");

  console.log("\n=== Seed complete ===\n");
  console.log("hostelId:", hostel!.id);
  console.log("bedId:   ", bed!.id);

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
