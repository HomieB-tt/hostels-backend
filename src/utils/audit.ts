import type { PgTransaction } from "drizzle-orm/pg-core";
import { db, schema } from "../db/index.js";

type Executor = typeof db | PgTransaction<any, any, any>;

export async function writeAuditLog(
  exec: Executor,
  entry: {
    actorId: string | null;
    ipAddress: string;
    action: string;
    previousState?: unknown;
    newState?: unknown;
  },
) {
  await exec.insert(schema.auditLogs).values({
    actorId: entry.actorId,
    ipAddress: entry.ipAddress,
    action: entry.action,
    previousState: entry.previousState ?? null,
    newState: entry.newState ?? null,
  });
}
