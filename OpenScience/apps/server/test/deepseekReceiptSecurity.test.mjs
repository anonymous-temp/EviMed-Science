import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import {
  deepSeekReleaseReceiptFreshness,
  signDeepSeekReleaseReceipt,
  validateDeepSeekReleaseReceipt,
} from "../../../scripts/ops/deepseek-kernel-release-gate.mjs";

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

test("a receipt announces that it needs renewing while it is still valid", () => {
  // The expiry was never the problem. A receipt attests what the model did when
  // it was probed, so it cannot be renewed by re-stamping `createdAt` — renewal
  // means running the gate again. What was missing is that the first and only
  // signal was readiness turning red at the moment the window had already
  // closed, with no lead time and no named remedy, and production then sat red
  // for eight days.
  const day = 24 * 60 * 60 * 1000;
  const at = (ageMs) => deepSeekReleaseReceiptFreshness({ createdAt: new Date(now - ageMs).toISOString() }, { nowMs: now, maxAgeMs: day });

  const fresh = at(0);
  assert.equal(fresh.renewalDue, false);
  assert.equal(fresh.expired, false);
  assert.equal(fresh.remainingMs, day);

  // Still valid, and already asking. This is the whole point: the warning has
  // to arrive while there is still time to act on it.
  const due = at(day - day / 3 + 1);
  assert.equal(due.renewalDue, true, "renewal must be announced before the window closes");
  assert.equal(due.expired, false, "and while the receipt still passes validation");
  assert.ok(
    validateDeepSeekReleaseReceipt(signedReceipt({ createdAt: new Date(now - (day - day / 3 + 1)).toISOString() }), {
      requireProduction: true,
      signingSecret,
      nowMs: now,
    }),
    "a receipt that is due for renewal is still a valid receipt",
  );

  // Negative controls. A receipt with most of its life left must not cry wolf —
  // a warning that is always on is the same as no warning.
  assert.equal(at(day / 2).renewalDue, false, "half a window left must not read as due");
  assert.equal(at(day - day / 3 - 1).renewalDue, false, "one millisecond before the threshold is not yet due");
  // And an expired receipt stays due: "past renewing" is not "no longer needs renewing".
  const expired = at(day + 1);
  assert.equal(expired.expired, true);
  assert.equal(expired.renewalDue, true);
  assert.ok(expired.remainingMs < 0);
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
