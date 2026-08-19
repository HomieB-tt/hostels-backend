import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createBookingHold, BedUnavailableError } from "./service.js";

const holdBodySchema = z.object({
  bedId: z.string().uuid(),
  semester: z.string().min(1),
  stayStart: z.string().date(),
  stayEnd: z.string().date(),
  totalAmount: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a decimal amount"),
});

export default async function bookingRoutes(app: FastifyInstance) {
  app.post(
    "/hold",
    {
      preHandler: [app.authenticate, app.requireRole("STUDENT")],
    },
    async (req, reply) => {
      const parsed = holdBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "VALIDATION_ERROR",
          details: parsed.error.flatten(),
        });
      }

      if (parsed.data.stayEnd <= parsed.data.stayStart) {
        return reply.code(400).send({
          error: "VALIDATION_ERROR",
          message: "stayEnd must be after stayStart",
        });
      }

      try {
        const booking = await createBookingHold({
          bedId: parsed.data.bedId,
          studentId: req.authUser.id,
          semester: parsed.data.semester,
          stayStart: parsed.data.stayStart,
          stayEnd: parsed.data.stayEnd,
          totalAmount: parsed.data.totalAmount,
          ipAddress: req.ip,
          jobsBaseUrl: `${req.protocol}://${req.hostname}/api/v1/jobs`,
        });

        return reply.code(201).send({
          bookingId: booking.id,
          status: booking.status,
          holdExpiresAt: booking.holdExpiresAt,
          totalAmount: booking.totalAmount,
        });
      } catch (err) {
        if (err instanceof BedUnavailableError) {
          return reply.code(409).send({ error: "BED_UNAVAILABLE" });
        }
        throw err;
      }
    },
  );
}
