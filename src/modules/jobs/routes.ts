import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { releaseExpiredHold } from "../bookings/service.js";

const autoReleaseBodySchema = z.object({
  bookingId: z.string().uuid(),
});

export default async function jobRoutes(app: FastifyInstance) {
  app.post(
    "/auto-release-hold",
    // verifyQStashSignature runs in preHandler, before this handler body
    // ever executes. A missing/invalid signature short-circuits with 401
    // and releaseExpiredHold is never called.
    { preHandler: [app.verifyQStashSignature] },
    async (req, reply) => {
      const parsed = autoReleaseBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "MALFORMED_JOB_PAYLOAD" });
      }

      const result = await releaseExpiredHold(parsed.data.bookingId);
      return reply.code(200).send(result);
    },
  );
}
