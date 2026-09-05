import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { processCheckinBatch } from "./service.js";

const checkinItemSchema = z.object({
  id: z.string().uuid(),
  bookingId: z.string().uuid(),
  checkedInAt: z.string().datetime(),
});

const checkinBatchSchema = z.object({
  // Capped at 100 — a batch is a client's offline queue since its last
  // sync, not an unbounded bulk-import mechanism.
  checkins: z.array(checkinItemSchema).min(1).max(100),
});

export default async function syncRoutes(app: FastifyInstance) {
  // CUSTODIAN-only, matching the spec's "offline custodian syncs"
  // language precisely. staff_assignments already supports OWNER too if
  // that scope ever needs broadening later.
  app.post(
    "/checkins",
    { preHandler: [app.authenticate, app.requireRole("CUSTODIAN")] },
    async (req, reply) => {
      const parsed = checkinBatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "INVALID_BODY", details: parsed.error.flatten() });
      }

      const results = await processCheckinBatch(
        parsed.data.checkins,
        req.authUser.id,
        req.ip,
      );

      return reply.code(200).send({ results });
    },
  );
}
