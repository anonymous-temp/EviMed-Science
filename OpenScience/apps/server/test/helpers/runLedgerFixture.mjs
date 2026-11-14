import { AgentRunStore as ProductionAgentRunStore, freezeLedgerRowsForTest } from "../../src/agentRuns.mjs";
import { createWebApiApp as createProductionWebApiApp } from "../../src/server.mjs";

// This environment variable belongs exclusively to fixtures, never to config or deployment.
export const ledgerRotationTestEnabled = process.env.OPEN_SCIENCE_TEST_LEDGER_ROTATION === "1";
const segmentBytes = 64 * 1024;
freezeLedgerRowsForTest();

export class AgentRunStore extends ProductionAgentRunStore {
  /** @param {ConstructorParameters<typeof ProductionAgentRunStore>[0]} sessions
   * @param {ConstructorParameters<typeof ProductionAgentRunStore>[1]} [options] */
  constructor(sessions, options = {}) {
    super(sessions, {
      ...options,
      ...(ledgerRotationTestEnabled ? {
        ledgerRotationEnabled: options.ledgerRotationEnabled ?? true,
        maxBytes: options.maxBytes ?? segmentBytes,
      } : {}),
    });
  }
}

/** @param {Parameters<typeof createProductionWebApiApp>[0]} [overrides]
 * @param {Parameters<typeof createProductionWebApiApp>[1]} [factories] */
export function createWebApiApp(overrides = {}, factories = undefined) {
  const app = createProductionWebApiApp({
    ...(ledgerRotationTestEnabled ? { agentRunLedgerRotationEnabled: true } : {}),
    ...overrides,
  }, factories);
  if (ledgerRotationTestEnabled) app.agentRuns.maxBytes = segmentBytes;
  return app;
}
