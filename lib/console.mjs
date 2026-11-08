// The adlc console, started in this process against this service. The console
// is CommonAgent/adlc-console; this file only wires its own exports together:
// the service's key is handed to it in memory, so nobody copies a key and no
// key file is read.

import { createRequire } from "node:module";
import { createConsoleServer } from "adlc-console/lib/server.mjs";
import { createKeyStore } from "adlc-console/lib/keys.mjs";
import { openBrowser } from "adlc-console/lib/open.mjs";

const consolePkg = createRequire(import.meta.url)("adlc-console/package.json");

/** The console's page for the lifecycle: which stages are used and who holds each role. */
export const LIFECYCLE_PAGE = "#/lifecycle";

/**
 * Starts the console on 127.0.0.1 against `service` (this service's address),
 * holding `key` in memory. Returns { url, close }.
 */
export async function startConsole({ service, key, port = 0 }) {
  const keys = createKeyStore({ service, key });
  const app = createConsoleServer({ service, keys, version: consolePkg.version });
  const url = await app.listen(port);
  return { url, close: () => app.close() };
}

export { openBrowser };
