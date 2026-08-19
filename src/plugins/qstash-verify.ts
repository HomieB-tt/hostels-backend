import fp from "fastify-plugin";
import { Receiver } from "@upstash/qstash";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { env } from "../env.js";

/**
 * Verifies that a request to /api/v1/jobs/* genuinely came from QStash,
 * not from someone who discovered the URL and is forging POSTs to release
 * bed holds / trigger SMS / clear pending payments early (spec §3).
 *
 * Requests with a missing, invalid, or unverifiable signature are
 * rejected with 401 and never reach the route handler — this hook runs
 * in `preHandler`, before any business logic.
 */
const receiver = new Receiver({
  currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
});

export default fp(async function qstashVerifyPlugin(app: FastifyInstance) {
  app.decorate(
    "verifyQStashSignature",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const signature = req.headers["upstash-signature"];

      if (!signature || typeof signature !== "string") {
        return reply.code(401).send({ error: "MISSING_QSTASH_SIGNATURE" });
      }

      // req.body must be the raw string for signature verification to be
      // valid — see server.ts, where the JSON body parser for /jobs/*
      // routes is configured to preserve rawBody.
      const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody;

      if (!rawBody) {
        req.log.error(
          "verifyQStashSignature called without rawBody captured",
        );
        return reply.code(401).send({ error: "UNVERIFIABLE_SIGNATURE" });
      }

      try {
        const isValid = await receiver.verify({
          signature,
          body: rawBody,
        });

        if (!isValid) {
          return reply.code(401).send({ error: "INVALID_QSTASH_SIGNATURE" });
        }
      } catch (err) {
        req.log.warn({ err }, "QStash signature verification threw");
        return reply.code(401).send({ error: "INVALID_QSTASH_SIGNATURE" });
      }
    },
  );
});

declare module "fastify" {
  interface FastifyInstance {
    verifyQStashSignature: (
      req: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}
