import { loadConfig } from "../../apps/server/src/config.mjs";
import { ControlPlaneDatabase } from "../../apps/server/src/controlPlaneDatabase.mjs";
import { UsageLedger } from "../../apps/server/src/usageLedger.mjs";
import { createPaperGoldCalibration } from "../../apps/server/src/paperGoldCalibration.mjs";
const [userId, cycleId, track] = process.argv.slice(2);
if (!userId || !/^[a-z0-9_-]{1,100}$/.test(cycleId ?? "")) throw new Error("Usage: node evals/paper-gold/prepare_calibration.mjs operator-user-id cycle-id [meta|pharmacovigilance|mr]");
const config = loadConfig();
if (!config.operatorUsers.includes(userId)) throw new Error("Calibration requires a configured operator identity.");
const database = new ControlPlaneDatabase(config);
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  const result = await createPaperGoldCalibration({ config, usageLedger: new UsageLedger(database) }).prepare({ userId, cycleId, track: track ?? null, signal: controller.signal });
  process.stdout.write(`${JSON.stringify({ cycleId, definitionHash: result.definitionHash, caseIds: result.caseIds, unavailable: result.unavailable })}\n`);
} finally { await database.close(); }
