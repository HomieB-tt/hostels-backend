# hostel-platform-backend

Fastify + TypeScript backend for the Ugandan university hostel search,
booking, and management platform. See `hostel-platform-backend-spec.md`
for the full spec this was built against.

## Quickstart (docker-compose)

```bash
cp .env.example .env
# fill in real Supabase / Pesapal / Africa's Talking / Twilio / FCM
# values in .env — the QStash values in .env.example already match the
# local qstash-dev container and don't need to change for local testing.

docker compose up --build
```

This starts, in order:
1. **postgres** — local Postgres 16 with `btree_gist` enabled (needed by
   the booking overlap exclusion constraint).
2. **qstash-dev** — Upstash's official local QStash dev server, so
   delayed jobs and signature verification work fully offline. Its four
   credentials are fixed/documented and already in `.env.example`.
3. **migrate** — runs `drizzle-kit push` against postgres, then
   `npm run db:seed`, which creates one OWNER, one CUSTODIAN, one
   STUDENT, one hostel/room/bed, and prints ready-to-use JWTs + a curl
   command. **Read this service's logs** (`docker compose logs migrate`)
   to get the token and bed ID you need for the next step.
4. **app** — the Fastify server, listening on `:8080`, only starts once
   `migrate` exits `0`.

## Manually exercising the booking → payment flow

1. Get the seeded `bedId` and `STUDENT` JWT from the `migrate` service
   logs (or re-run `docker compose run --rm migrate npm run db:seed` for
   a fresh set — note this seeds a *second* dataset each time, it isn't
   idempotent).

2. Hold a bed:
   ```bash
   curl -i -X POST http://localhost:8080/api/v1/bookings/hold \
     -H "Authorization: Bearer <STUDENT_JWT>" \
     -H "X-Client-Platform: mobile_app" \
     -H "Content-Type: application/json" \
     -d '{
       "bedId": "<BED_ID>",
       "semester": "2026-S1",
       "stayStart": "2026-09-01",
       "stayEnd": "2026-12-15",
       "totalAmount": "500000.00"
     }'
   ```
   Note the returned `bookingId` — that's the value Pesapal would know as
   `orderMerchantReference`.

3. **Auto-release job (no real payment):** wait 10 minutes, or trigger it
   immediately for testing — since `qstash dev` still signs requests with
   the same deterministic keys, you can call the job endpoint directly if
   you construct a valid `Upstash-Signature` header, but the easiest path
   for a manual smoke test is temporarily lowering `HOLD_MINUTES` in
   `src/modules/bookings/service.ts` or calling
   `releaseExpiredHold(bookingId)` directly from a REPL.

4. **Payment confirmation:** the `/api/v1/payments/ipn` handler always
   calls Pesapal's real `GetTransactionStatus` endpoint — it will never
   confirm a booking from a locally-forged IPN payload alone (see
   `src/tests/payments.ipn.test.ts`). To test confirmation end-to-end you
   need real Pesapal sandbox credentials in `.env` and to actually drive
   a sandbox mobile-money/card payment through Pesapal's checkout so a
   real `orderTrackingId` exists to verify.

## Running tests

```bash
docker compose run --rm migrate npm test
```

(Or `npm install && npm test` locally if you have Node 20+ and don't
want to go through Docker for this.)

## What's stubbed / not yet built

- `POST /api/v1/sync/checkins` — placeholder 501, offline batch check-in
  logic not yet implemented.
- No login/registration routes exist yet — `scripts/seed.ts` mints JWTs
  directly for local testing since token *issuance* wasn't in scope for
  the steps built so far.
- SMS/WhatsApp/FCM sending, OTP flow for cash payments, and the
  `staff_assignments`-based Fastify routes for `/hostels/:hostelId/*`
  beyond the `requirePropertyScope` middleware itself are not built yet.

## Project layout

```
src/
  env.ts              # fail-fast env validation (znv/zod)
  app.ts / server.ts  # Fastify bootstrap
  db/                 # Drizzle schema + client + migration runner
  plugins/            # auth, platform guard, property scope, QStash verify
  modules/
    bookings/         # hold (row-locked) + auto-release
    payments/         # Pesapal client + IPN handler
    jobs/             # QStash-signed background job endpoints
    sync/             # placeholder
  tests/
scripts/seed.ts        # dev-only: seed data + mint test JWTs
docker/postgres/init.sql
docker-compose.yml
Dockerfile
```
