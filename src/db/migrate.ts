// Runs any pending SQL migrations in ./drizzle against SUPABASE_DATABASE_URL.
// Use this in real deployments (after `npm run db:generate` produces
// reviewed SQL files). Local docker-compose uses `drizzle-kit push`
// instead for fast iteration — see docker-compose.yml's `migrate` service.
import { env } from "../env.js";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

async function main() {
  const sql = postgres(env.SUPABASE_DATABASE_URL, { max: 1 });
  const db = drizzle(sql);

  console.log("Running migrations from ./drizzle ...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");

  await sql.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
