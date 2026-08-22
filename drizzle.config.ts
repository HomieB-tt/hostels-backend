import { defineConfig } from "drizzle-kit";

// NOTE: deliberately does NOT import ./src/env.ts here. drizzle-kit loads
// this config through its own CJS require(), not the tsx/ESM loader the
// rest of the app uses — a side-effecting TS import that works fine via
// `tsx` breaks here because drizzle-kit resolves it as a literal
// ./src/env.js path that doesn't exist. Full env validation happens where
// it actually matters: at server boot (src/server.ts imports src/env.ts
// first, before anything else). This file only needs the raw connection
// string, read directly.
if (!process.env.SUPABASE_DATABASE_URL) {
  throw new Error(
    "SUPABASE_DATABASE_URL is not set — drizzle-kit needs it to connect.",
  );
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.SUPABASE_DATABASE_URL,
  },
  verbose: true,
  strict: true,
});
