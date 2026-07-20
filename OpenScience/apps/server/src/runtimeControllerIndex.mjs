import { createRuntimeController } from "./runtimeControllerServer.mjs";

const controller = createRuntimeController();
const socketPath = await controller.listen();
process.stdout.write(`EviMed Runtime Controller listening on ${socketPath}\n`);

const shutdown = async () => {
  await controller.close().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
