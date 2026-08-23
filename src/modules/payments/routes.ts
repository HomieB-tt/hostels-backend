import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  processPesapalIpn,
  WebhookAlreadyProcessedError,
  BookingNotFoundError,
  PaymentNotConfirmedError,
} from "./service.js";

// Pesapal v3 sends these three fields, but casing is inconsistent across
// delivery modes in practice — query-param callbacks observed in the wild
// use PascalCase (OrderTrackingId, OrderMerchantReference,
// OrderNotificationType), while some docs/examples show camelCase. Accept
// either rather than trusting one casing and silently 400ing the other.
const rawIpnSchema = z.object({
  orderTrackingId: z.string().min(1).optional(),
                              OrderTrackingId: z.string().min(1).optional(),
                              orderMerchantReference: z.string().min(1).optional(),
                              OrderMerchantReference: z.string().min(1).optional(),
                              orderNotificationType: z.string().optional(),
                              OrderNotificationType: z.string().optional(),
});

function normalizeIpnPayload(raw: z.infer<typeof rawIpnSchema>) {
  const orderTrackingId = raw.orderTrackingId ?? raw.OrderTrackingId;
  const orderMerchantReference =
  raw.orderMerchantReference ?? raw.OrderMerchantReference;
  const orderNotificationType =
  raw.orderNotificationType ?? raw.OrderNotificationType;

  if (!orderTrackingId || !orderMerchantReference) return null;

  return { orderTrackingId, orderMerchantReference, orderNotificationType };
}

export default async function paymentRoutes(app: FastifyInstance) {
  app.post("/ipn", async (req, reply) => {
    const merged = { ...(req.query as object), ...(req.body as object) };
    const rawParsed = rawIpnSchema.safeParse(merged);

    if (!rawParsed.success) {
      return reply.code(400).send({ error: "MALFORMED_IPN" });
    }

    const parsed = normalizeIpnPayload(rawParsed.data);

    if (!parsed) {
      return reply.code(400).send({ error: "MALFORMED_IPN" });
    }

    // NOTE: `parsed` is NEVER used to decide payment success — it's only
    // used to know which orderTrackingId to independently verify against
    // Pesapal. See modules/payments/service.ts.
    try {
      const booking = await processPesapalIpn({
        orderTrackingId: parsed.orderTrackingId,
        orderMerchantReference: parsed.orderMerchantReference,
      });

      // Pesapal expects a 200 + this exact echo shape to consider the IPN
      // delivered; anything else and it will keep retrying.
      return reply.code(200).send({
        orderNotificationType: parsed.orderNotificationType ?? "IPNCHANGE",
        orderTrackingId: parsed.orderTrackingId,
        orderMerchantReference: parsed.orderMerchantReference,
        status: 200,
        bookingStatus: booking.status,
      });
    } catch (err) {
      if (err instanceof WebhookAlreadyProcessedError) {
        // Already handled — ack so Pesapal stops retrying, but this is
        // not a fresh confirmation.
        return reply.code(200).send({
          orderTrackingId: parsed.orderTrackingId,
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
