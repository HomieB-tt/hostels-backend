import { env } from "../env.js"; // MUST be first: throws on boot if invalid
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

const queryClient = postgres(env.SUPABASE_DATABASE_URL, {
  // Supabase pooler: keep connections modest, RLS is enforced per-row on
  // the DB side regardless, but the service-role key used here bypasses
  // RLS — so every query in this codebase must do its own scope check.
  max: 10,
});

export const db = drizzle(queryClient, { schema });
export { schema };
