import { Client } from "@upstash/qstash";
import { env } from "../../env.js";

const qstash = new Client({ token: env.QSTASH_TOKEN, baseUrl: env.QSTASH_URL });

/**
 * Schedules the auto-release-hold job to fire 10 minutes from now against
 * our own /api/v1/jobs/auto-release-hold endpoint. QStash signs the
 * outbound request with QSTASH_CURRENT_SIGNING_KEY, which our
 * verifyQStashSignature preHandler checks on arrival — closing the loop
 * described in the spec (§3).
 */
export async function scheduleAutoReleaseHold(params: {
  bookingId: string;
  destinationUrl: string;
}) {
  await qstash.publishJSON({
    url: params.destinationUrl,
    body: { bookingId: params.bookingId },
    delay: "10m",
    retries: 3,
  });
}
