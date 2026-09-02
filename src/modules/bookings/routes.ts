import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createBookingHold, listStudentBookings, BedUnavailableError } from "./service.js";
import { env } from "../../env.js";

const holdBodySchema = z.object({
  bedId: z.string().uuid(),
  semester: z.string().min(1),
  stayStart: z.string().date(),
  stayEnd: z.string().date(),
  totalAmount: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a decimal amount"),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export default async function bookingRoutes(app: FastifyInstance) {
  // "My bookings" — STUDENT-only, scoped to the authenticated user via
  // req.authUser.id. There's no hostelId in this URL, so
  // requirePropertyScope doesn't apply here — a student's own booking
  // list is scoped by ownership, not by property staff assignment.
  app.get(
    "/mine",
    { preHandler: [app.authenticate, app.requireRole("STUDENT")] },
    async (req, reply) => {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_QUERY" });
      }

      const bookings = await listStudentBookings(req.authUser.id, parsed.data);
      return reply.send({ bookings, page: parsed.data.page, limit: parsed.data.limit });
    },
  );

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
          jobsBaseUrl: `${env.APP_BASE_URL}/api/v1/jobs`,
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
