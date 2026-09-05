# hostel-platform-backend

Fastify + TypeScript backend for the Ugandan university hostel search,
booking, and management platform.

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

## Row Level Security (Supabase only — not local docker-compose)

`supabase/rls-lockdown.sql` enables RLS on every table and revokes all
`anon`/`authenticated` privileges, fully closing off Supabase's
auto-generated public REST API. Run it once, directly against your real
Supabase project (SQL Editor, or `psql "$SUPABASE_DATABASE_URL" -f
supabase/rls-lockdown.sql`) — **not** against local docker-compose
Postgres, which doesn't have `anon`/`authenticated` roles and will error.

This doesn't change how your Fastify backend behaves at all — it
connects via the service-role connection string, which bypasses RLS by
design. What it protects against is anyone holding your
`SUPABASE_ANON_KEY` (which ships inside a mobile app bundle, so treat it
as public) hitting Supabase's REST API directly and reading/writing your
tables outside your own authorization logic entirely.

If you ever want a client to read Supabase directly (e.g. a future
public hostel-search page bypassing the API for speed), that needs an
actual per-row policy added deliberately — the current setup is a
deny-all, on purpose, since 100% of traffic goes through the Fastify API
today.

## Running tests

```bash
docker compose run --rm migrate npm test
```

(Or `npm install && npm test` locally if you have Node 20+ and don't
want to go through Docker for this.)

## What's stubbed / not yet built

- SMS/WhatsApp/FCM sending, and the OTP flow for cash payments, are not
  built yet.
- Production deployment — still runs locally via docker-compose only; no
  deployment target chosen yet.

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
