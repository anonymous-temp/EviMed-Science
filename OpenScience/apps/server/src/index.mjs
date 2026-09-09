import net from "node:net";
import { createWebApiApp } from "./server.mjs";

// Happy Eyeballs gives each address family 250 ms by default, and that is a
// choice between two working stacks, not a fallback budget. Several official
// upstreams publish AAAA records that black-hole from here (NOAA's SWPC is one:
// eight IPv6 addresses, none reachable, a working IPv4 path behind them), and
// the IPv4 attempt does not finish inside 250 ms on a cross-Pacific route. The
// connection then fails with ETIMEDOUT and the runtime is told the source
// returned an error -- which reads as "the source is down" about a source that
// is up. Raising the per-attempt budget costs nothing when the first family
// connects, because the first successful socket still wins immediately.
net.setDefaultAutoSelectFamilyAttemptTimeout(
  Math.max(net.getDefaultAutoSelectFamilyAttemptTimeout(), 1_000),
);

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
