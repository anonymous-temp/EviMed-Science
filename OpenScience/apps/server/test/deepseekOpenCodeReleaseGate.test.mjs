import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  resolveOpenCodeBinary,
  openCodeHistoryEvidence,
  releaseTelemetryEvidence,
  resolveArtifactProvenanceTool,
  runBoundedProcess,
  signDeepSeekReleaseReceipt,
  runDeepSeekOpenCodeReleaseGate,
  validateDeepSeekReleaseReceipt,
} from "../../../scripts/ops/deepseek-opencode-release-gate.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const testReceiptSigningSecret = "release-gate-test-signing-secret-with-at-least-32-bytes";

test("artifact provenance accepts equivalent explicit tool-name shapes", () => {
  for (const artifact of [
    { provenanceTool: "evimed_term_normalize" },
    { provenance_tool: "evimed_term_normalize" },
    { provenance: "evimed_term_normalize" },
    { provenance: { tool: "evimed_term_normalize" } },
    { provenance: { toolName: "evimed_term_normalize" } },
    { provenance: { name: "evimed_term_normalize" } },
  ]) {
    assert.equal(resolveArtifactProvenanceTool(artifact), "evimed_term_normalize");
  }
  assert.equal(resolveArtifactProvenanceTool({ provenance: { source: "local" } }), undefined);
});

test("release evidence requires completed structured tool history, not prompt strings", () => {
  const workspace = "/workspace/project";
  const promptOnly = [{
    info: { role: "user" },
    parts: [{
      type: "text",
      text: "evimed_term_normalize paracetamol provenance.tool write artifacts/term-normalization.json",
    }],
  }];
  assert.deepEqual(openCodeHistoryEvidence(promptOnly, workspace), {
    mcpToolCompleted: false,
    writeToolCompleted: false,
    structuredFinal: false,
    toolResults: 0,
    artifactPath: null,
    mcpResult: null,
  });

  const history = [
    { info: { role: "user" }, parts: [{ type: "text", text: "normalize this" }] },
    {
      info: { role: "assistant", time: { completed: 1 } },
      parts: [
        {
          type: "tool",
          tool: "evimed-research_evimed_term_normalize",
          state: {
            status: "completed",
            input: { term: "acetaminophen" },
            output: JSON.stringify({
              status: "success",
              data: { preferred: "paracetamol", provenance: { tool: "evimed_term_normalize" } },
            }),
          },
        },
        {
          type: "tool",
          tool: "write",
          state: {
            status: "completed",
            input: { filePath: "/workspace/project/artifacts/result.json" },
            output: "written",
          },
        },
        { type: "text", text: '{"release_gate":"passed","normalized":"paracetamol","artifact":"artifacts/result.json"}' },
      ],
    },
  ];
  assert.deepEqual(openCodeHistoryEvidence(history, workspace), {
    mcpToolCompleted: true,
    writeToolCompleted: true,
    structuredFinal: true,
    toolResults: 2,
    artifactPath: "artifacts/result.json",
    mcpResult: {
      status: "success",
      data: { preferred: "paracetamol", provenance: { tool: "evimed_term_normalize" } },
    },
  });

  const wrongInputHistory = structuredClone(history);
  wrongInputHistory[1].parts[0].state.input.term = "ibuprofen";
  assert.equal(openCodeHistoryEvidence(wrongInputHistory, workspace).mcpToolCompleted, false);
});

test("release telemetry fails closed when gateway or stream evidence is absent", () => {
  assert.deepEqual(releaseTelemetryEvidence({ mode: "fake", gateway: null, provider: null, events: [] }), {
    gatewayOnly: false,
    streaming: false,
    streamedEventCount: 0,
  });
  assert.deepEqual(releaseTelemetryEvidence({
    mode: "fake",
    gateway: { requests: 3, sseResponses: 3 },
    provider: { requests: 3, authorized: 3, finalChunks: 2 },
    events: [{ type: "text" }],
  }), {
    gatewayOnly: true,
    streaming: true,
    streamedEventCount: 1,
  });
});

test("release gate runs the bundled OpenCode 1.17.13 through the full fake gateway tool chain", { timeout: 30_000 }, async (t) => {
  const opencodeBin = resolveOpenCodeBinary({ repoRoot });
  await access(opencodeBin);
  const root = await mkdtemp(path.join(tmpdir(), "deepseek-release-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiptPath = path.join(root, "receipt.json");
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("evimed-deepseek-gate-")));
  let chainEvidence = null;

  const receipt = await runDeepSeekOpenCodeReleaseGate({
    mode: "fake",
    opencodeBin,
    receiptPath,
    sourceRevision: "test-source-revision",
    configRevision: "test-config-revision",
    timeoutMs: 20_000,
    receiptSigningSecret: testReceiptSigningSecret,
    verifyChainEvidence: (evidence) => {
      chainEvidence = evidence;
    },
  });

  assert.equal(receipt.opencodeVersion, "1.17.13");
  assert.equal(receipt.model, "deepseek-v4-pro");
  assert.equal(receipt.mode, "fake");
  assert.equal(receipt.productionEligible, false);
  assert.equal(receipt.capabilities.gatewayOnly, true);
  assert.equal(receipt.capabilities.streaming, true);
  assert.equal(receipt.capabilities.toolResultIterations >= 2, true);
  assert.equal(receipt.capabilities.sessionHistory, true);
  assert.equal(receipt.capabilities.structuredFinal, true);
  assert.equal(receipt.capabilities.providerBaseline, true);
  assert.equal(chainEvidence.mcp.toolName.includes("evimed_term_normalize"), true);
  assert.equal(chainEvidence.mcp.result.status, "success");
  assert.equal(chainEvidence.mcp.result.data.preferred, "paracetamol");
  assert.equal(chainEvidence.mcp.result.data.provenance.tool, "evimed_term_normalize");
  assert.equal(chainEvidence.artifact.path, "artifacts/term-normalization.json");
  assert.deepEqual(JSON.parse(chainEvidence.artifact.content), {
    normalized: "paracetamol",
    provenanceTool: "evimed_term_normalize",
    sourceTerm: "acetaminophen",
  });
  assert.equal(chainEvidence.history.mcpToolCompleted, true);
  assert.equal(chainEvidence.history.writeToolCompleted, true);
  assert.equal(chainEvidence.telemetry.gatewayRequests >= 3, true);
  assert.equal(chainEvidence.telemetry.gatewaySseResponses >= 3, true);
  assert.equal(chainEvidence.telemetry.providerRequests, chainEvidence.telemetry.gatewayRequests);
  assert.equal(chainEvidence.telemetry.providerAuthorized, chainEvidence.telemetry.providerRequests);
  assert.equal(chainEvidence.telemetry.openCodeStreamedEvents > 0, true);
  assert.equal(chainEvidence.telemetry.completedToolCalls, 2);
  const persisted = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.deepEqual(persisted, receipt);
  assert.equal((await stat(receiptPath)).mode & 0o077, 0);
  assert.doesNotMatch(JSON.stringify(receipt), /prompt|message|apiKey|token|fake-provider-key|compatibility_probe/i);
  assert.throws(
    () => validateDeepSeekReleaseReceipt(receipt, {
      requireProduction: true,
      signingSecret: testReceiptSigningSecret,
    }),
    (error) => error?.code === "deepseek_release_receipt_fake",
  );
  const after = (await readdir(tmpdir())).filter((name) => name.startsWith("evimed-deepseek-gate-") && !before.has(name));
  assert.deepEqual(after, []);
});

test("release gate fails closed when OpenCode is missing or not exactly 1.17.13", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deepseek-release-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => runDeepSeekOpenCodeReleaseGate({
      mode: "fake",
      opencodeBin: path.join(root, "missing-opencode"),
      receiptPath: path.join(root, "missing.json"),
    }),
    (error) => error?.code === "opencode_binary_missing",
  );
  await assert.rejects(
    () => runDeepSeekOpenCodeReleaseGate({
      mode: "fake",
      opencodeBin: "/bin/echo",
      receiptPath: path.join(root, "wrong.json"),
    }),
    (error) => error?.code === "opencode_version_mismatch",
  );
});

test("production receipt validation requires every capability and matching release identity", () => {
  const unsigned = {
    schemaVersion: 1,
    id: "dsrg_0123456789abcdef",
    mode: "production",
    productionEligible: true,
    createdAt: "2026-07-17T00:00:00.000Z",
    opencodeVersion: "1.17.13",
    model: "deepseek-v4-pro",
    sourceRevision: "source-1",
    configRevision: "config-1",
    capabilities: {
      providerBaseline: true,
      providerStreaming: true,
      providerToolLoop: true,
      providerStructuredOutput: true,
      gatewayOnly: true,
      streaming: true,
      toolResultIterations: 2,
      sessionHistory: true,
      structuredFinal: true,
    },
  };
  const base = signDeepSeekReleaseReceipt(unsigned, { signingSecret: testReceiptSigningSecret });
  assert.deepEqual(validateDeepSeekReleaseReceipt(base, {
    requireProduction: true,
    signingSecret: testReceiptSigningSecret,
    nowMs: Date.parse(base.createdAt),
    receiptId: base.id,
    sourceRevision: "source-1",
    configRevision: "config-1",
  }), base);
  assert.throws(
    () => validateDeepSeekReleaseReceipt({ ...base, capabilities: { ...base.capabilities, gatewayOnly: false } }, {
      requireProduction: true,
      signingSecret: testReceiptSigningSecret,
      nowMs: Date.parse(base.createdAt),
    }),
    (error) => error?.code === "deepseek_release_receipt_signature_invalid",
  );
  assert.throws(
    () => validateDeepSeekReleaseReceipt(base, {
      requireProduction: true,
      signingSecret: testReceiptSigningSecret,
      nowMs: Date.parse(base.createdAt),
      receiptId: "dsrg_other",
    }),
    (error) => error?.code === "deepseek_release_receipt_mismatch",
  );
});

test("bounded release-gate processes escalate to KILL when a child ignores TERM", { timeout: 10_000 }, async (t) => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "deepseek-stubborn-child-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pidFile = path.join(root, "pid.txt");
  const childFile = path.join(root, "child.mjs");
  await writeFile(childFile, `
import fs from "node:fs";
fs.writeFileSync(process.argv[2], String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`, "utf8");
  const startedAt = Date.now();
  await assert.rejects(
    () => runBoundedProcess(process.execPath, [childFile, pidFile], {
      cwd: root,
      env: process.env,
      // Full-suite startup can be CPU-bound; leave enough time for the fixture
      // to install its SIGTERM handler before exercising forced termination.
      timeoutMs: 1_000,
      terminateGraceMs: 50,
      finalCloseWaitMs: 500,
    }),
    (error) => error?.code === "opencode_timeout",
  );
  assert.equal(Date.now() - startedAt < 2_000, true);
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), (error) => error?.code === "ESRCH");
});
