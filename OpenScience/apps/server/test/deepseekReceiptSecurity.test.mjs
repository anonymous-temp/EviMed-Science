import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import {
  signDeepSeekReleaseReceipt,
  validateDeepSeekReleaseReceipt,
} from "../../../scripts/ops/deepseek-opencode-release-gate.mjs";

const signingSecret = "receipt-signing-secret-with-at-least-32-private-bytes";
const now = Date.parse("2026-07-17T01:00:00.000Z");

function unsignedReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "dsrg_0123456789abcdef",
    mode: "production",
    productionEligible: true,
    createdAt: new Date(now).toISOString(),
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
    ...overrides,
  };
}

function signedReceipt(overrides = {}, secret = signingSecret) {
  return signDeepSeekReleaseReceipt(unsignedReceipt(overrides), { signingSecret: secret });
}

test("release receipts require a valid domain-separated HMAC", () => {
  const receipt = signedReceipt();
  assert.equal(receipt.signatureAlgorithm, "HMAC-SHA256");
  assert.match(receipt.keyId, /^mgw_[a-f0-9]{16}$/);
  assert.match(receipt.signature, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(validateDeepSeekReleaseReceipt(receipt, {
    requireProduction: true,
    signingSecret,
    nowMs: now,
    maxAgeMs: 24 * 60 * 60 * 1000,
  }), receipt);
  assert.throws(
    () => validateDeepSeekReleaseReceipt({ ...receipt, sourceRevision: "tampered" }, {
      requireProduction: true,
      signingSecret,
      nowMs: now,
    }),
    (error) => error?.code === "deepseek_release_receipt_signature_invalid",
  );
  assert.throws(
    () => validateDeepSeekReleaseReceipt(receipt, {
      requireProduction: true,
      signingSecret: `${signingSecret}-wrong`,
      nowMs: now,
    }),
    (error) => error?.code === "deepseek_release_receipt_signature_invalid",
  );
});

test("release receipts reject stale and future timestamps", () => {
  const stale = signedReceipt({ createdAt: new Date(now - 24 * 60 * 60 * 1000 - 1).toISOString() });
  assert.throws(
    () => validateDeepSeekReleaseReceipt(stale, { requireProduction: true, signingSecret, nowMs: now }),
    (error) => error?.code === "deepseek_release_receipt_stale",
  );
  const future = signedReceipt({ createdAt: new Date(now + 5 * 60 * 1000 + 1).toISOString() });
  assert.throws(
    () => validateDeepSeekReleaseReceipt(future, { requireProduction: true, signingSecret, nowMs: now }),
    (error) => error?.code === "deepseek_release_receipt_future",
  );
});

test("fake or unsigned receipts never satisfy production validation", () => {
  const unsigned = unsignedReceipt();
  assert.throws(
    () => validateDeepSeekReleaseReceipt(unsigned, { requireProduction: true, signingSecret, nowMs: now }),
    (error) => error?.code === "deepseek_release_receipt_invalid",
  );
  const fake = signDeepSeekReleaseReceipt(unsignedReceipt({ mode: "fake", productionEligible: false }), { signingSecret });
  assert.throws(
    () => validateDeepSeekReleaseReceipt(fake, { requireProduction: true, signingSecret, nowMs: now }),
    (error) => error?.code === "deepseek_release_receipt_fake",
  );
});

test("production server readiness verifies the signed and fresh release receipt", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deepseek-server-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiptFile = path.join(root, "receipt.json");
  const signingSecret = "server-readiness-receipt-secret-with-at-least-32-bytes";
  const receipt = signedReceipt({ createdAt: new Date().toISOString() }, signingSecret);
  await writeFile(receiptFile, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await chmod(receiptFile, 0o600);
  const app = createWebApiApp({
    dataDir: path.join(root, "data"),
    port: 0,
    production: true,
    devAuth: true,
    runtimeMode: "opencode",
    runtimeSandboxMode: "docker",
    runtimeNetworkMode: "open-science-runtime-internal",
    runtimeInternalNetworkName: "open-science-runtime-internal",
    runtimeRequireImageLocal: false,
    deepseekProviderEnabled: true,
    deepseekApiKey: "test-provider-key",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-v4-pro",
    modelGatewaySigningSecret: signingSecret,
    deepseekReleaseReceiptFile: receiptFile,
    deepseekReleaseReceiptId: receipt.id,
    sourceRevision: receipt.sourceRevision,
    deepseekConfigRevision: receipt.configRevision,
  });
  const address = await app.listen(0, "127.0.0.1");
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;

  let response = await fetch(`${base}/api/ready`);
  let readiness = (await response.json()).data;
  assert.equal(readiness.checks.modelGateway.ok, true);

  await writeFile(receiptFile, `${JSON.stringify({ ...receipt, sourceRevision: "tampered" })}\n`, { mode: 0o600 });
  response = await fetch(`${base}/api/ready`);
  readiness = (await response.json()).data;
  assert.equal(readiness.checks.modelGateway.ok, false);
  assert.equal(readiness.checks.modelGateway.code, "deepseek_release_receipt_signature_invalid");
});
