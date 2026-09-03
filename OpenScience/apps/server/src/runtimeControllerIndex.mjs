import net from "node:net";
import { createRuntimeController } from "./runtimeControllerServer.mjs";

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

const controller = createRuntimeController();
const socketPath = await controller.listen();
process.stdout.write(`EviMed Runtime Controller listening on ${socketPath}\n`);

const shutdown = async () => {
  await controller.close().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
