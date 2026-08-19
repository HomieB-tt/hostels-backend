import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/index.js";

/**
 * IDOR protection for every /api/v1/hostels/:hostelId/* route.
 *
 * A CUSTODIAN or OWNER JWT being valid only proves who the user is — it
 * says nothing about which hostel they're allowed to touch. This checks
 * `staff_assignments` on every request and 404s (not 403 — we don't want
 * to confirm a hostel ID exists to someone with no assignment to it)
 * when there's no row linking the authed user to :hostelId.
 *
 * ADMIN bypasses the check by design.
 */
export default fp(async function propertyScopePlugin(app: FastifyInstance) {
  app.decorate(
    "requirePropertyScope",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { hostelId } = req.params as { hostelId?: string };

      if (!hostelId) {
        return reply.code(400).send({ error: "MISSING_HOSTEL_ID" });
      }

      if (req.authUser.role === "ADMIN") return;

      const [assignment] = await db
        .select({ id: schema.staffAssignments.id })
        .from(schema.staffAssignments)
        .where(
          and(
            eq(schema.staffAssignments.userId, req.authUser.id),
            eq(schema.staffAssignments.hostelId, hostelId),
          ),
        )
        .limit(1);

      if (!assignment) {
        // 404, not 403: don't leak whether the hostel exists to a
        // non-assigned user.
        return reply.code(404).send({ error: "NOT_FOUND" });
      }
    },
  );
});

declare module "fastify" {
  interface FastifyInstance {
    requirePropertyScope: (
      req: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}
