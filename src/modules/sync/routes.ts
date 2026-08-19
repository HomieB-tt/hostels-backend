import type { FastifyInstance } from "fastify";

/**
 * PLACEHOLDER — not part of Step 3 (booking hold + Pesapal/QStash).
 * app.ts already registers this prefix, so a stub keeps the build green.
 * The real `/sync/checkins` endpoint (idempotent batch check-in accepting
 * client-generated UUID arrays for offline custodian syncs, per spec §4)
 * still needs its own pass — flag if you want that built out next.
 */
export default async function syncRoutes(app: FastifyInstance) {
  app.post("/checkins", { preHandler: [app.authenticate] }, async (_req, reply) => {
    return reply.code(501).send({ error: "NOT_IMPLEMENTED" });
  });
}
