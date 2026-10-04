// The real data-semantics gateway and service over a ledger double, as a process a Python test can talk to.
//
// `dataset_semantics` is a Python tool whose answers are the Node service's. Testing it against a scripted
// gateway would only prove the tool agrees with a test's idea of the service; this serves the service
// itself, so the tool, the gateway, the service and the domain contract are exercised as one — the same
// arrangement `test_vcr_platform.py` makes for the domain's vocabularies, one layer further out.
//
//   node dataSemanticsGatewayServer.mjs [--enabled false]
//
// Prints `PORT=<n>` once listening, serves `/internal/semantics/v1/*` for the token `runtime-token-for-tests`
// (user `owner`, project `p1`), and `GET /__ledger` for what the ledger holds. Exits when stdin closes.
import { createServer } from "node:http";

import { createDataSemanticsGateway } from "../../src/dataSemanticsGateway.mjs";
import { DataSemanticsService } from "../../src/dataSemanticsService.mjs";
import { ProductDocumentsDouble } from "./productDocumentsDouble.mjs";

const enabled = process.argv.includes("--enabled") ? process.argv[process.argv.indexOf("--enabled") + 1] !== "false" : true;
const documents = new ProductDocumentsDouble();
let tick = 0;
const service = new DataSemanticsService({ documents, now: () => new Date(Date.UTC(2026, 9, 4, 8, 0, tick++)).toISOString() });
const handler = createDataSemanticsGateway({
  config: { dataSemanticsEnabled: enabled },
  runtimeManager: { assertActiveModelGatewayToken: (token) => { if (token !== "runtime-token-for-tests") throw new Error("no"); return { userId: "owner", projectId: "p1" }; } },
  store: { userById: async (id) => ({ id }), requireProject: async (_user, id) => ({ id }) },
  service,
});
const server = createServer((req, res) => {
  if (req.url === "/__ledger") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ rows: [...documents.rows.values()], revisions: Object.fromEntries([...documents.revisions].map(([key, list]) => [key.split("\u0000")[2], list.length])) }));
    return;
  }
  void handler(req, res);
});
server.listen(0, "127.0.0.1", () => process.stdout.write(`PORT=${server.address().port}\n`));
process.stdin.resume();
process.stdin.on("end", () => server.close(() => process.exit(0)));
