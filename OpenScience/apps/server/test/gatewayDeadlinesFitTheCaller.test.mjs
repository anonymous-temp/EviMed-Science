/**
 * A gateway behind the kernel's tool-call ceiling must answer before it.
 *
 * The GEO probe gateway's deadline was 360 s against a ceiling of 180 s. It
 * could therefore never deliver its own verdict: the kernel abandoned the call
 * first, and the run received an opaque abort at ~183 s. Three production
 * geo-content runs reported "all 10 probe rounds failed, so nothing was
 * measured" and none could say the channel had failed rather than the engines,
 * which is the difference between a measurement and a result.
 *
 * The rule is arithmetic, so it is checked rather than remembered. The walk
 * asserts it walked: a gateway added without a deadline, or a deadline written
 * above the ceiling, fails here.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";
import { MCP_TOOL_CALL_TIMEOUT_MS } from "../src/dshProfilePatch.mjs";

/**
 * The gateways an MCP tool calls, by the config key holding each deadline.
 * Every one of these is reached from `runtime/mcp/evimed-research` inside a
 * single tool call, so the kernel's ceiling applies to all of them.
 */
const MCP_FACING_DEADLINES = [
  "publicSourceGatewayTimeoutMs",
  "webSearchTimeoutMs",
  "geoProbeTimeoutMs",
];

test("every gateway an MCP tool calls answers inside the kernel's tool-call window", () => {
  const config = loadConfig({ dataDir: "/tmp/evimed-deadline-check" });
  assert.ok(MCP_FACING_DEADLINES.length >= 3, "the list must name the gateways, or this test walks nothing");
  for (const key of MCP_FACING_DEADLINES) {
    const value = config[key];
    assert.equal(typeof value, "number", `${key} is not a number, so nothing bounds that gateway`);
    assert.ok(value > 0, `${key} must be positive`);
    assert.ok(
      value < MCP_TOOL_CALL_TIMEOUT_MS,
      `${key} is ${value}ms against a ${MCP_TOOL_CALL_TIMEOUT_MS}ms ceiling: its own error can never reach the run`,
    );
  }
});

test("a deadline configured above the ceiling is clamped, not honoured", () => {
  // Honouring it would restore the silence: the operator would have set a
  // number that guarantees the gateway's verdict is never delivered.
  const config = loadConfig({ dataDir: "/tmp/evimed-deadline-check", geoProbeTimeoutMs: 600_000 });
  assert.ok(config.geoProbeTimeoutMs < MCP_TOOL_CALL_TIMEOUT_MS, `clamped to ${config.geoProbeTimeoutMs}`);
});

test("the ceiling in the profile the container reads is the one this rule uses", () => {
  // Two literals would drift, and the drift is invisible: the profile would say
  // one number, the check would agree with itself, and the gateway would be
  // over the real ceiling again.
  const config = loadConfig({ dataDir: "/tmp/evimed-deadline-check" });
  assert.equal(typeof MCP_TOOL_CALL_TIMEOUT_MS, "number");
  assert.ok(MCP_TOOL_CALL_TIMEOUT_MS > 0);
  assert.ok(config.geoProbeTimeoutMs <= MCP_TOOL_CALL_TIMEOUT_MS - 1_000);
});
