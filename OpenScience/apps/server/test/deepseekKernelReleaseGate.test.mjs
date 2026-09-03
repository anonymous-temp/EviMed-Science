import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { mcpToolName } from "@evimed/domain";
import {
  RELEASE_GATE_ARTIFACT,
  mcpBaseName,
  dshTranscriptEvidence,
  releaseTelemetryEvidence,
  runDeepSeekKernelReleaseGate,
  signDeepSeekReleaseReceipt,
  validateDeepSeekReleaseReceipt,
} from "../../../scripts/ops/deepseek-kernel-release-gate.mjs";

const testReceiptSigningSecret = "release-gate-test-signing-secret-with-at-least-32-bytes";
// The kernel version a receipt must name, read from the one place upstream pins
// are written — the same source the gate reads. A literal here would pass while
// certifying a version nobody ships.
const requiredDshVersion = JSON.parse(
  fs.readFileSync(new URL("../../../deps-version.json", import.meta.url), "utf8"),
).dsh.version;

function unsignedReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "dsrg_0123456789abcdef",
    mode: "production",
    productionEligible: true,
    createdAt: "2026-07-17T00:00:00.000Z",
    dshVersion: requiredDshVersion,
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
    ...overrides,
  };
}

function signed(overrides = {}) {
  return signDeepSeekReleaseReceipt(unsignedReceipt(overrides), { signingSecret: testReceiptSigningSecret });
}

// A receipt exists only if the chain was actually driven. These are the two
// ways the gate can be asked to produce one without driving anything, and both
// have to end with no file on disk: `--fake` (there is no fake chain — see the
// gate's own note on why emulating one would certify the mock), and a
// production call with nothing to authenticate or identify the receipt with.
test("the release gate refuses to mint a receipt it did not measure", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deepseek-release-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [label, options, code] of [
    ["fake", { mode: "fake" }, "deepseek_release_mode_invalid"],
    ["production without inputs", { mode: "production" }, "deepseek_release_input_missing"],
  ]) {
    const receiptPath = path.join(root, `${label.replace(/\s+/g, "-")}.json`);
    await assert.rejects(
      () => runDeepSeekKernelReleaseGate({
        ...options,
        keyFile: "",
        receiptId: "",
        receiptPath,
        sourceRevision: "test-source-revision",
        configRevision: "test-config-revision",
        receiptSigningSecret: testReceiptSigningSecret,
      }),
      (error) => {
        assert.equal(error.code, code, `${label} must name its refusal`);
        return true;
      },
    );
    await assert.rejects(() => stat(receiptPath), { code: "ENOENT" }, "a refused gate must leave no receipt behind");
  }
});

/* ------------------------------------------------- what a transcript proves */

/** @param {{ tool: string, status?: string, output?: string, input?: any }[]} calls */
function transcriptOf(calls, finalText) {
  return {
    messages: [
      ...calls.map((call) => ({
        role: "tool",
        parts: [{
          type: "tool",
          tool: call.tool,
          callId: `c-${call.tool}`,
          status: call.status ?? "completed",
          input: call.input ?? {},
          output: call.output ?? "",
          error: null,
        }],
      })),
      ...(finalText === undefined ? [] : [{ role: "assistant", parts: [{ type: "text", text: finalText }] }]),
    ],
  };
}

const normalizationOutput = JSON.stringify({
  status: "success",
  data: {
    input: "acetaminophen",
    preferred: "paracetamol",
    provenance: { tool: "term_normalize" },
  },
});
const goodCalls = [
  { tool: "mcp__evimed__term_normalize", output: normalizationOutput },
  { tool: "write", input: { file_path: RELEASE_GATE_ARTIFACT, content: "{}" } },
];
const goodFinal = JSON.stringify({ normalized: "paracetamol", artifact: RELEASE_GATE_ARTIFACT });

test("a transcript proves the chain only when both tools completed and the answer was structured", () => {
  const complete = dshTranscriptEvidence(transcriptOf(goodCalls, goodFinal));
  assert.deepEqual(
    {
      normalizationCompleted: complete.normalizationCompleted,
      artifactWriteCompleted: complete.artifactWriteCompleted,
      structuredFinal: complete.structuredFinal,
      toolResults: complete.toolResults,
    },
    { normalizationCompleted: true, artifactWriteCompleted: true, structuredFinal: true, toolResults: 2 },
  );

  // Each way the chain can fall short, one at a time. The point of listing them
  // is that every one of them used to be indistinguishable from success in a
  // gate that only asked whether the run finished.
  const pending = dshTranscriptEvidence(transcriptOf(
    [{ ...goodCalls[0], status: "pending" }, goodCalls[1]],
    goodFinal,
  ));
  assert.equal(pending.normalizationCompleted, false, "a call whose result never arrived is not evidence");
  assert.equal(pending.toolResults, 1);

  const wrongTerm = dshTranscriptEvidence(transcriptOf(
    [{ ...goodCalls[0], output: JSON.stringify({ status: "success", data: { input: "ibuprofen", preferred: "ibuprofen", provenance: { tool: "term_normalize" } } }) }, goodCalls[1]],
    goodFinal,
  ));
  assert.equal(wrongTerm.normalizationCompleted, false, "a normalization of some other term proves nothing about this one");

  const envelopeOnly = dshTranscriptEvidence(transcriptOf(
    [{ ...goodCalls[0], output: JSON.stringify({ structuredContent: JSON.parse(normalizationOutput) }) }, goodCalls[1]],
    goodFinal,
  ));
  assert.equal(envelopeOnly.normalizationCompleted, true, "the payload sits under structuredContent and must be read there");

  assert.equal(
    dshTranscriptEvidence(transcriptOf([goodCalls[0]], goodFinal)).artifactWriteCompleted,
    false,
    "an answer naming the artifact is not a tool call that wrote it",
  );
  assert.equal(
    dshTranscriptEvidence(transcriptOf(goodCalls, "I normalized it and wrote the file.")).structuredFinal,
    false,
    "prose is not a structured final answer",
  );
  assert.equal(
    dshTranscriptEvidence(transcriptOf(goodCalls, JSON.stringify({ normalized: "paracetamol", artifact: "other.json" }))).structuredFinal,
    false,
    "a final answer naming a different artifact is not this run's answer",
  );
  // Both directions of the leniency, so neither can be changed by accident:
  // presentation around the object does not disqualify it, and the object
  // itself must still parse.
  assert.equal(
    dshTranscriptEvidence(transcriptOf(goodCalls, `\`\`\`json\n${goodFinal}\n\`\`\``)).structuredFinal,
    true,
    "a fence is presentation, not a different answer",
  );
  assert.equal(
    dshTranscriptEvidence(transcriptOf(goodCalls, `Done. ${goodFinal} Let me know if you need more.`)).structuredFinal,
    true,
    "an object with a sentence around it is still the structured answer",
  );
  assert.equal(
    dshTranscriptEvidence(transcriptOf(goodCalls, `{normalized: paracetamol, artifact: ${RELEASE_GATE_ARTIFACT}}`)).structuredFinal,
    false,
    "text shaped like an object is not one",
  );
  assert.equal(dshTranscriptEvidence({}).toolResults, 0, "an empty transcript proves nothing and says so");
});

test("gateway telemetry is a count, and an unstreamed run is not certified", () => {
  assert.deepEqual(
    releaseTelemetryEvidence({ gateway: { requests: 3, sseResponses: 3 }, streamedEventCount: 5 }),
    { gatewayOnly: true, streaming: true },
  );
  assert.equal(
    releaseTelemetryEvidence({ gateway: { requests: 1, sseResponses: 3 }, streamedEventCount: 5 }).gatewayOnly,
    false,
    "one request cannot evidence a tool loop through the gateway",
  );
  assert.equal(
    releaseTelemetryEvidence({ gateway: { requests: 3, sseResponses: 0 }, streamedEventCount: 5 }).streaming,
    false,
    "a run answered without a single stream did not stream",
  );
  assert.equal(
    releaseTelemetryEvidence({ gateway: { requests: 3, sseResponses: 3 }, streamedEventCount: 0 }).streaming,
    false,
    "streamed responses with nothing in them are not evidence of a turn",
  );
});


test("the gate's own prefix stripping inverts the domain's tool naming", () => {
  // The gate cannot import `@evimed/domain`: the host preflight loads this
  // module out of a release directory with no `node_modules`. So the naming
  // convention is applied locally and tied back to its definition here, where
  // the package does resolve — a rename upstream fails this test rather than
  // silently making the gate stop recognising its own tool.
  for (const base of ["term_normalize", "drug_term_normalize", "literature_search"]) {
    assert.equal(mcpBaseName(mcpToolName(base)), base);
  }
  assert.equal(mcpBaseName("write"), "write", "a tool with no MCP prefix keeps its name");
  assert.equal(mcpBaseName(""), "");
});

test("the module a host preflight imports does not pull in the control plane", async () => {
  // The minting half needs the runtime manager; the verification half is
  // imported by `host-preflight.mjs` on a host that has no `node_modules`. A
  // static import of either one turns `pnpm preflight:host` into a module
  // resolution error, which reads as a missing dependency rather than a missing
  // receipt — and that is exactly how it failed.
  const source = await readFile(
    new URL("../../../scripts/ops/deepseek-kernel-release-gate.mjs", import.meta.url),
    "utf8",
  );
  const staticImports = [...source.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1]);
  assert.ok(staticImports.length > 0, "the scan found no imports at all, so it proves nothing");
  for (const specifier of staticImports) {
    assert.ok(
      !specifier.startsWith("@evimed/") && !/runtimeManager|dshRuntimeAdapter|\/config\.mjs/.test(specifier),
      `${specifier} must be imported where the minting half runs, not at module load`,
    );
  }
});

test("production receipt validation requires every capability and matching release identity", () => {
  const base = signed();
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

// The gate used to fail closed by probing the kernel binary and refusing any
// version but the pinned one. There is no binary to probe; the same binding now
// lives in the receipt, which names the kernel and the model it certified and is
// signed over both. A receipt for a deployment this host does not ship is not a
// receipt.
test("a receipt is refused unless it names the kernel version and model this deployment ships", () => {
  assert.throws(
    () => validateDeepSeekReleaseReceipt(signed({ dshVersion: "0.0.1-not-shipped" }), {
      requireProduction: true,
      signingSecret: testReceiptSigningSecret,
      nowMs: Date.parse("2026-07-17T00:00:00.000Z"),
    }),
    (error) => error?.code === "deepseek_release_receipt_invalid",
    "a receipt naming another kernel version certifies a deployment that does not exist",
  );
  assert.throws(
    () => validateDeepSeekReleaseReceipt(signed({ model: "deepseek-v4-flash" }), {
      requireProduction: true,
      signingSecret: testReceiptSigningSecret,
      nowMs: Date.parse("2026-07-17T00:00:00.000Z"),
    }),
    (error) => error?.code === "deepseek_release_receipt_invalid",
    "certifying a supported model is not certifying the model that answers here",
  );
});

// The minted receipt used to be searched for prompts, keys and probe names.
// Nothing mints one now, so the guarantee moved to the reader: the schema is
// exact, so a receipt cannot carry a field that was never certified — which is
// stronger than searching a string for words that look like secrets.
test("a receipt carries exactly the certified fields and nothing else", () => {
  for (const smuggled of ["prompt", "apiKey", "token", "message"]) {
    const receipt = { ...signed(), [smuggled]: "leaked" };
    assert.throws(
      () => validateDeepSeekReleaseReceipt(receipt, {
        requireProduction: true,
        signingSecret: testReceiptSigningSecret,
        nowMs: Date.parse(receipt.createdAt),
      }),
      (error) => error?.code === "deepseek_release_receipt_invalid",
      `a receipt must not be readable with an uncertified \`${smuggled}\` field`,
    );
  }
});
