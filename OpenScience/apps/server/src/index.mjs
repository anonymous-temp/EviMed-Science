import { createWebApiApp } from "./server.mjs";
import { preferIpv4Egress } from "./webReadNetwork.mjs";

// Several official upstreams publish AAAA records that black-hole from here
// (NOAA's SWPC: eight IPv6 addresses, none reachable), the container has no
// IPv6 route, and Node's per-family race abandoned IPv4 handshakes that took
// longer than 250 ms — most of the Pacific. Before anything connects.
preferIpv4Egress();

// The last line of defence for a background promise nobody awaited. Node
// makes an unhandled rejection fatal, and on 2026-09-09 one from a scheduler
// timer took the whole control plane down with the runs it was monitoring.
// Every timer now reports its own failure, so this should never fire; when
// it does, the process stays up and the line says where to look. Only the
// error's name and code are written: a message can carry a URL or a token.
process.on("unhandledRejection", (reason) => {
  const error = /** @type {any} */ (reason);
  const frame = typeof error?.stack === "string" ? error.stack.split("\n").find((line) => line.trimStart().startsWith("at ")) ?? "" : "";
  process.stderr.write(`unhandled rejection kept off the process: ${error?.name ?? typeof reason} ${typeof error?.code === "string" ? error.code : ""}${frame ? ` ${frame.trim()}` : ""}\n`);
});

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
