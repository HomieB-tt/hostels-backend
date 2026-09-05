import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import { env } from "./env.js";

import authPlugin from "./plugins/auth.js";
import propertyScopePlugin from "./plugins/property-scope.js";
import qstashVerifyPlugin from "./plugins/qstash-verify.js";

import bookingRoutes from "./modules/bookings/routes.js";
import paymentRoutes from "./modules/payments/routes.js";
import syncRoutes from "./modules/sync/routes.js";
import jobRoutes from "./modules/jobs/routes.js";
import authRoutes from "./modules/auth/routes.js";
import hostelRoutes from "./modules/hostels/routes.js";
import hostelManagementRoutes from "./modules/hostels/management.routes.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    trustProxy: true,
  });

  // --- Capture raw body on every request (needed for QStash signature
  // verification, which must hash the exact bytes received) while still
  // handing Fastify a parsed JSON object as usual. ---
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      (req as typeof req & { rawBody: string }).rawBody = body as string;
      try {
        const json = body.length ? JSON.parse(body as string) : {};
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // --- Security headers ---
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } },
  });

  // --- CORS: explicit allow-list, never '*' with credentials ---
  await app.register(cors, {
    origin: [env.WEB_DASHBOARD_ORIGIN],
    credentials: true,
  });

  // --- Global rate limiting (per-route limits layered on top where noted,
  // e.g. OTP endpoints) ---
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  await app.register(cookie, {
    secret: env.JWT_REFRESH_SECRET, // signs the refresh cookie
    parseOptions: {},
  });

  await app.register(authPlugin);
  await app.register(propertyScopePlugin);
  await app.register(qstashVerifyPlugin);

  await app.register(bookingRoutes, { prefix: "/api/v1/bookings" });
  await app.register(paymentRoutes, { prefix: "/api/v1/payments" });
  await app.register(syncRoutes, { prefix: "/api/v1/sync" });
  await app.register(jobRoutes, { prefix: "/api/v1/jobs" });
  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(hostelRoutes, { prefix: "/api/v1/hostels" });
  await app.register(hostelManagementRoutes, { prefix: "/api/v1/hostels" });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
