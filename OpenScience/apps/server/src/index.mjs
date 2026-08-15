import { createWebApiApp } from "./server.mjs";

const app = createWebApiApp();
const address = await app.listen();
const host = typeof address === "object" && address ? address.address : app.config.host;
const port = typeof address === "object" && address ? address.port : app.config.port;

process.stdout.write(`EviMed Web API listening on http://${host}:${port}\n`);

const shutdown = async () => {
  // Exiting 0 after a failed close told the orchestrator this was a clean
  // stop, while unflushed runs, unstopped containers, and an open pool said
  // otherwise. Say which it was.
  let code = 0;
  await app.close().catch((error) => {
    code = 1;
    process.stderr.write(`shutdown did not complete cleanly: ${error?.message ?? error}\n`);
  });
  process.exit(code);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
