import { createWebApiApp } from "./server.mjs";

const app = createWebApiApp();
const address = await app.listen();
const host = typeof address === "object" && address ? address.address : app.config.host;
const port = typeof address === "object" && address ? address.port : app.config.port;

process.stdout.write(`EviMed Web API listening on http://${host}:${port}\n`);

const shutdown = async () => {
  await app.close().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
