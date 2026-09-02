import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
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

// The minting half drove the retired kernel through the whole tool chain and
// read its own message and part shapes for the evidence. Nothing on the DSH
// wire replaces it yet, so the gate refuses instead of signing. This is the
// property the two OpenCode chain tests existed for, in the only form left: a
// receipt exists only if the chain was actually driven, and a gate that cannot
// drive it produces nothing at all rather than something weaker.
test("the release gate refuses to mint a receipt for a chain it cannot drive", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deepseek-release-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("evimed-deepseek-gate-")));

  for (const mode of ["fake", "production"]) {
    const receiptPath = path.join(root, `${mode}.json`);
    await assert.rejects(
      () => runDeepSeekKernelReleaseGate({
        mode,
        receiptPath,
        sourceRevision: "test-source-revision",
        configRevision: "test-config-revision",
        receiptSigningSecret: testReceiptSigningSecret,
      }),
      (error) => {
        assert.equal(error.code, "deepseek_release_chain_unavailable");
        return true;
      },
      `the ${mode} gate must name its refusal rather than certifying an undriven chain`,
    );
    await assert.rejects(() => stat(receiptPath), { code: "ENOENT" }, "a refused gate must leave no receipt behind");
  }

  const after = (await readdir(tmpdir())).filter((name) => name.startsWith("evimed-deepseek-gate-") && !before.has(name));
  assert.deepEqual(after, [], "refusing must happen before any workspace is created");
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
