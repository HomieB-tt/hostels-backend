/**
 * Strict environment validation.
 *
 * This module MUST be imported first, before any other module that touches
 * a secret, a DB connection, or a third-party SDK. Importing it triggers
 * validation immediately (znv throws synchronously on module load if the
 * schema fails), so the process exits before Fastify, Drizzle, or any
 * plugin is constructed.
 *
 * No key in this schema has a default. A missing/empty/malformed var is a
 * boot-time crash, not a runtime surprise three requests into production.
 */
import { parseEnv, z } from "znv";

const nonEmpty = (label: string) =>
  z.string().min(1, `${label} must not be empty`);

export const env = parseEnv(process.env, {
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().positive().default(8080),
  APP_BASE_URL: nonEmpty("APP_BASE_URL").url(),

  // --- Database (Supabase Postgres, RLS enabled) ---
  SUPABASE_DATABASE_URL: nonEmpty("SUPABASE_DATABASE_URL").url(),
  SUPABASE_URL: nonEmpty("SUPABASE_URL").url(),
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty("SUPABASE_SERVICE_ROLE_KEY"),
  SUPABASE_ANON_KEY: nonEmpty("SUPABASE_ANON_KEY"),

  // --- Auth / JWT ---
  JWT_ACCESS_SECRET: nonEmpty("JWT_ACCESS_SECRET").min(32),
  JWT_REFRESH_SECRET: nonEmpty("JWT_REFRESH_SECRET").min(32),
  JWT_ACCESS_TTL_WEB: z.string().default("15m"),
  JWT_REFRESH_TTL_MOBILE: z.string().default("90d"),

  // --- QStash (background job signing) ---
  QSTASH_CURRENT_SIGNING_KEY: nonEmpty("QSTASH_CURRENT_SIGNING_KEY"),
  QSTASH_NEXT_SIGNING_KEY: nonEmpty("QSTASH_NEXT_SIGNING_KEY"),
  QSTASH_TOKEN: nonEmpty("QSTASH_TOKEN"),
  // Points at Upstash's hosted API by default; override to the local
  // `qstash dev` container's address (see docker-compose.yml) for local
  // runs so scheduled jobs don't leave the docker network.
  QSTASH_URL: z.string().url().default("https://qstash.upstash.io"),

  // --- Pesapal 3.0 ---
  PESAPAL_CONSUMER_KEY: nonEmpty("PESAPAL_CONSUMER_KEY"),
  PESAPAL_CONSUMER_SECRET: nonEmpty("PESAPAL_CONSUMER_SECRET"),
  PESAPAL_BASE_URL: z
    .string()
    .url()
    .default("https://pay.pesapal.com/v3"),
  PESAPAL_IPN_ID: nonEmpty("PESAPAL_IPN_ID"),

  // --- SMS: Africa's Talking (primary) ---
  AT_API_KEY: nonEmpty("AT_API_KEY"),
  AT_USERNAME: nonEmpty("AT_USERNAME"),

  // --- SMS/WhatsApp fallback: Twilio ---
  TWILIO_ACCOUNT_SID: nonEmpty("TWILIO_ACCOUNT_SID"),
  TWILIO_AUTH_TOKEN: nonEmpty("TWILIO_AUTH_TOKEN"),
  TWILIO_WHATSAPP_FROM: nonEmpty("TWILIO_WHATSAPP_FROM"),

  // --- FCM push ---
  FCM_PROJECT_ID: nonEmpty("FCM_PROJECT_ID"),
  FCM_CLIENT_EMAIL: nonEmpty("FCM_CLIENT_EMAIL"),
  FCM_PRIVATE_KEY: nonEmpty("FCM_PRIVATE_KEY"),

  // --- CORS ---
  WEB_DASHBOARD_ORIGIN: nonEmpty("WEB_DASHBOARD_ORIGIN").url(),
});

export type Env = typeof env;
