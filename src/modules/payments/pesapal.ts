import { env } from "../../env.js";

interface PesapalTokenResponse {
  token: string;
  expiryDate: string;
  error: unknown;
  status: string;
}

interface PesapalVerifyResponse {
  payment_method: string;
  amount: number;
  created_date: string;
  confirmation_code: string;
  payment_status_description: "Completed" | "Failed" | "Invalid" | "Pending";
  description: string;
  message: string;
  payment_account: string;
  call_back_url: string;
  status_code: number; // 1 = Completed
  merchant_reference: string;
  payment_status_code: string;
  currency: string;
  error: unknown;
  status: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5_000) {
    return cachedToken.token;
  }

  const res = await fetch(`${env.PESAPAL_BASE_URL}/api/Auth/RequestToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      consumer_key: env.PESAPAL_CONSUMER_KEY,
      consumer_secret: env.PESAPAL_CONSUMER_SECRET,
    }),
  });

  if (!res.ok) {
    throw new Error(`Pesapal auth failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as PesapalTokenResponse;
  if (!data.token) {
    // Surface Pesapal's actual error payload (e.g. the code/message under
    // `data.error`) instead of a bare "missing token" — this is almost
    // always a wrong/mismatched PESAPAL_CONSUMER_KEY/SECRET pair, and the
    // response body says exactly why.
    throw new Error(
      `Pesapal auth response missing token — response body: ${JSON.stringify(data)}`,
    );
  }

  // Pesapal tokens are short-lived (~5 min); cache conservatively.
  cachedToken = { token: data.token, expiresAt: Date.now() + 4 * 60_000 };
  return data.token;
}

/**
 * The ONLY source of truth for whether a payment succeeded. Never trust
 * the IPN payload's fields directly — always make this server-to-server
 * call and gate booking confirmation on its result (spec §3).
 */
export async function verifyTransactionStatus(
  orderTrackingId: string,
): Promise<PesapalVerifyResponse> {
  const token = await getAccessToken();

  const res = await fetch(
    `${env.PESAPAL_BASE_URL}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(
      orderTrackingId,
    )}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    },
  );

  if (!res.ok) {
    throw new Error(
      `Pesapal verify failed: ${res.status} ${await res.text()}`,
    );
  }

  return (await res.json()) as PesapalVerifyResponse;
}

export function isConfirmedPayment(v: PesapalVerifyResponse): boolean {
  // status_code 1 == COMPLETED per Pesapal v3 docs. Checking the
  // description too guards against relying on a single loosely-typed field.
  return v.status_code === 1 && v.payment_status_description === "Completed";
}
