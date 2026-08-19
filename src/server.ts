// This import MUST be the very first thing that happens. znv validates
// synchronously on import and throws if anything is missing/malformed —
// so if this line doesn't throw, the rest of the process (DB pool, JWT
// secrets, QStash receiver, Pesapal client) can trust `process.env` fully.
import { env } from "./env.js";

import { buildApp } from "./app.js";

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    app.log.info(`hostel-platform-backend listening on :${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal boot error:", err);
  process.exit(1);
});
