import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  processPesapalIpn,
  WebhookAlreadyProcessedError,
  BookingNotFoundError,
  PaymentNotConfirmedError,
} from "./service.js";

// Pesapal v3 sends these three fields (as query params on a GET-style IPN,
// or in the JSON body depending on IPN registration — we accept both).
const ipnSchema = z.object({
  orderTrackingId: z.string().min(1),
  orderMerchantReference: z.string().min(1),
  orderNotificationType: z.string().optional(),
});

export default async function paymentRoutes(app: FastifyInstance) {
  app.post("/ipn", async (req, reply) => {
    const merged = { ...(req.query as object), ...(req.body as object) };
    const parsed = ipnSchema.safeParse(merged);

    if (!parsed.success) {
      // Still 200 back to Pesapal's retry logic would be wrong here since
      // this is a malformed call, not a legitimate unconfirmed payment —
      // reject outright.
      return reply.code(400).send({ error: "MALFORMED_IPN" });
    }

    // NOTE: parsed.data is NEVER used to decide payment success — it's
    // only used to know which orderTrackingId to independently verify
    // against Pesapal. See modules/payments/service.ts.
    try {
      const booking = await processPesapalIpn({
        orderTrackingId: parsed.data.orderTrackingId,
        orderMerchantReference: parsed.data.orderMerchantReference,
      });

      // Pesapal expects a 200 + this exact echo shape to consider the IPN
      // delivered; anything else and it will keep retrying.
      return reply.code(200).send({
        orderNotificationType: parsed.data.orderNotificationType ?? "IPNCHANGE",
        orderTrackingId: parsed.data.orderTrackingId,
        orderMerchantReference: parsed.data.orderMerchantReference,
        status: 200,
        bookingStatus: booking.status,
      });
    } catch (err) {
      if (err instanceof WebhookAlreadyProcessedError) {
        // Already handled — ack so Pesapal stops retrying, but this is
        // not a fresh confirmation.
        return reply.code(200).send({
          orderTrackingId: parsed.data.orderTrackingId,
          status: 200,
          note: "already_processed",
        });
      }
      if (err instanceof BookingNotFoundError) {
        return reply.code(404).send({ error: "BOOKING_NOT_FOUND" });
      }
      if (err instanceof PaymentNotConfirmedError) {
        // Deliberately NOT a 500 — this is an expected outcome (payment
        // pending/failed) and must never confirm the booking.
        return reply.code(202).send({
          error: "PAYMENT_NOT_CONFIRMED",
          message: err.message,
        });
      }
      throw err;
    }
  });
}
