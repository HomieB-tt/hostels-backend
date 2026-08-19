import { eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { writeAuditLog } from "../../utils/audit.js";
import { verifyTransactionStatus, isConfirmedPayment } from "./pesapal.js";

export class WebhookAlreadyProcessedError extends Error {
  constructor() {
    super("This transaction has already been processed.");
    this.name = "WebhookAlreadyProcessedError";
  }
}

export class BookingNotFoundError extends Error {
  constructor() {
    super("No booking matches this merchant reference.");
    this.name = "BookingNotFoundError";
  }
}

export class PaymentNotConfirmedError extends Error {
  constructor(reason: string) {
    super(`Pesapal did not confirm this payment: ${reason}`);
    this.name = "PaymentNotConfirmedError";
  }
}

/**
 * Handles a Pesapal IPN. The `orderTrackingId`/`orderMerchantReference` in
 * the notification are only ever used to look up *which* transaction to
 * verify — never to decide payment succeeded. That decision comes
 * exclusively from `verifyTransactionStatus`, a direct server-to-server
 * call to Pesapal (spec §3). A forged IPN with a fabricated "success"
 * field has zero effect: this function never reads any success/status
 * field out of the inbound payload at all.
 */
export async function processPesapalIpn(params: {
  orderTrackingId: string;
  orderMerchantReference: string; // == our bookings.id
}) {
  // Idempotency: reject replays/duplicate retries before doing any work.
  const [existing] = await db
    .select({ id: schema.processedWebhooks.id })
    .from(schema.processedWebhooks)
    .where(eq(schema.processedWebhooks.transactionId, params.orderTrackingId))
    .limit(1);

  if (existing) {
    throw new WebhookAlreadyProcessedError();
  }

  // The independent, authoritative check — payload fields play no role.
  const verification = await verifyTransactionStatus(params.orderTrackingId);

  if (!isConfirmedPayment(verification)) {
    throw new PaymentNotConfirmedError(verification.payment_status_description);
  }

  return db.transaction(async (tx) => {
    const [booking] = await tx
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, params.orderMerchantReference))
      .for("update");

    if (!booking) {
      throw new BookingNotFoundError();
    }

    // Already confirmed by a prior (differently-tracking-ID'd) callback —
    // treat as a no-op success rather than double-booking side effects.
    if (booking.status === "CONFIRMED") {
      await tx
        .insert(schema.processedWebhooks)
        .values({ transactionId: params.orderTrackingId, source: "pesapal_ipn" })
        .onConflictDoNothing();
      return booking;
    }

    if (booking.status !== "PENDING_PAYMENT") {
      throw new PaymentNotConfirmedError(
        `booking is in terminal state ${booking.status}, not payable`,
      );
    }

    const [updated] = await tx
      .update(schema.bookings)
      .set({
        status: "CONFIRMED",
        amountPaid: String(verification.amount),
        dueBalance: "0",
        confirmedAt: new Date(),
      })
      .where(eq(schema.bookings.id, booking.id))
      .returning();

    await tx
      .update(schema.beds)
      .set({ status: "OCCUPIED" })
      .where(eq(schema.beds.id, booking.bedId));

    await tx.insert(schema.processedWebhooks).values({
      transactionId: params.orderTrackingId,
      source: "pesapal_ipn",
    });

    await writeAuditLog(tx, {
      actorId: null,
      ipAddress: "external:pesapal_ipn",
      action: "booking.confirmed_via_pesapal",
      previousState: { status: "PENDING_PAYMENT" },
      newState: {
        status: "CONFIRMED",
        orderTrackingId: params.orderTrackingId,
      },
    });

    return updated!;
  });
}
