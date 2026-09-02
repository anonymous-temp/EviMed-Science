#!/usr/bin/env node
/**
 * The signed receipt that says the model which actually answers can drive the
 * whole tool chain, and the reader that production readiness uses to check one.
 *
 * The minting half is not here. It drove the retired kernel — `opencode run`
 * against a fake provider, then `opencode export` for the session history —
 * reading that kernel's own message and part shapes throughout, and none of
 * that survives the kernel it read. What has to replace it is stated at
 * `runDeepSeekKernelReleaseGate`, which refuses by name rather than minting
 * anything: a receipt that certifies less than it claims is worse than no
 * receipt, because everything downstream trusts it exactly as much either way.
 *
 * The verification half — schema, signature, freshness, and the readiness
 * comparison that reads it — is unchanged apart from the field naming the
 * kernel, which moved from `opencodeVersion` to `dshVersion` together with the
 * signer, the validator and readiness, because a receipt is signed over its
 * whole body and a field renamed on one side alone verifies as tampering.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { certifiedDeepSeekModel, supportedDeepSeekModels } from "../../apps/server/src/modelGateway.mjs";

const scriptFile = fileURLToPath(import.meta.url);
// The kernel version a receipt attests, from the one place upstream pins are
// written. Read rather than repeated: a receipt naming a version nobody ships
// is a receipt that certifies a deployment that does not exist.
const REQUIRED_DSH_VERSION = JSON.parse(
  fs.readFileSync(new URL("../../deps-version.json", import.meta.url), "utf8"),
).dsh?.version ?? "";
// Whichever certified model this deployment configures. The gate then runs the
// real chain against THAT model and signs a receipt naming it, so the receipt
// attests what actually serves rather than what was hardcoded here.
const REQUIRED_MODEL = certifiedDeepSeekModel();
if (!REQUIRED_MODEL) {
  throw new Error(
    `OPEN_SCIENCE_DEEPSEEK_MODEL must name a certified model (${[...supportedDeepSeekModels].join(", ")}).`,
  );
}
const receiptCapabilities = [
  "providerBaseline",
  "providerStreaming",
  "providerToolLoop",
  "providerStructuredOutput",
  "gatewayOnly",
  "streaming",
  "toolResultIterations",
  "sessionHistory",
  "structuredFinal",
];
const RECEIPT_SIGNATURE_ALGORITHM = "HMAC-SHA256";
const RECEIPT_KEY_DOMAIN = "evimed/model-gateway/deepseek-release-receipt/key/v1";
const RECEIPT_MAC_DOMAIN = "evimed/model-gateway/deepseek-release-receipt/mac/v1";
const DEFAULT_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RECEIPT_FUTURE_MS = 5 * 60 * 1000;
class ReleaseGateError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`DeepSeek kernel release gate failed: ${code}`);
    /** @type {string} */
    this.code = code;
    /** Attached by the caller that knows why the gate failed.
     *  @type {any} */
    this.diagnostic = undefined;
  }
}

function failure(code) {
  return new ReleaseGateError(code);
}

export function readModelGatewaySigningSecretFile(file) {
  if (typeof file !== "string" || !file.trim()) throw failure("model_gateway_signing_secret_file_missing");
  const target = path.resolve(file);
  let handle;
  try {
    handle = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 8 * 1024) {
      throw failure("model_gateway_signing_secret_file_invalid");
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw failure("model_gateway_signing_secret_file_permissions");
    }
    const value = fs.readFileSync(handle, "utf8").replace(/\r?\n$/, "");
    return validatedReceiptSigningSecret(value);
  } catch (error) {
    if (error instanceof ReleaseGateError) throw error;
    if (error?.code === "ELOOP") throw failure("model_gateway_signing_secret_file_symlink");
    if (error?.code === "ENOENT") throw failure("model_gateway_signing_secret_file_missing");
    throw failure("model_gateway_signing_secret_file_invalid");
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
}

function exactReceiptKeys(value, expected) {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function validatedReceiptSigningSecret(secret) {
  if (
    typeof secret !== "string" ||
    secret !== secret.trim() ||
    /[\r\n\0]/.test(secret) ||
    Buffer.byteLength(secret, "utf8") < 32
  ) throw failure("deepseek_release_receipt_signing_secret_invalid");
  return secret;
}

function derivedReceiptKey(secret) {
  return createHmac("sha256", validatedReceiptSigningSecret(secret)).update(RECEIPT_KEY_DOMAIN).digest();
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function unsignedReceiptFields(receipt) {
  const { signatureAlgorithm: _algorithm, keyId: _keyId, signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

/** @param {Record<string, any>} receipt @param {Record<string, any>} options */
export function signDeepSeekReleaseReceipt(receipt, { signingSecret } = {}) {
  if (receipt == null || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw failure("deepseek_release_receipt_invalid");
  }
  const key = derivedReceiptKey(signingSecret);
  const unsigned = unsignedReceiptFields(receipt);
  const signature = createHmac("sha256", key)
    .update(RECEIPT_MAC_DOMAIN)
    .update("\0")
    .update(canonicalJson(unsigned))
    .digest("base64url");
  const keyId = `mgw_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  return {
    ...unsigned,
    signatureAlgorithm: RECEIPT_SIGNATURE_ALGORITHM,
    keyId,
    signature,
  };
}

/** @param {Record<string, any>} receipt @param {Record<string, any>} options */
export function validateDeepSeekReleaseReceipt(receipt, {
  requireProduction = false,
  signingSecret,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_RECEIPT_MAX_AGE_MS,
  receiptId,
  sourceRevision,
  configRevision,
} = {}) {
  if (
    receipt == null || typeof receipt !== "object" || Array.isArray(receipt) ||
    !exactReceiptKeys(receipt, [
      "schemaVersion", "id", "mode", "productionEligible", "createdAt", "dshVersion",
      "model", "sourceRevision", "configRevision", "capabilities", "signatureAlgorithm", "keyId", "signature",
    ]) ||
    receipt.schemaVersion !== 1 ||
    !/^dsrg_[a-f0-9]{16,64}$/.test(receipt.id) ||
    !["fake", "production"].includes(receipt.mode) ||
    typeof receipt.productionEligible !== "boolean" ||
    !Number.isFinite(Date.parse(receipt.createdAt)) ||
    receipt.dshVersion !== REQUIRED_DSH_VERSION ||
    receipt.model !== REQUIRED_MODEL ||
    typeof receipt.sourceRevision !== "string" || !receipt.sourceRevision ||
    typeof receipt.configRevision !== "string" || !receipt.configRevision ||
    receipt.signatureAlgorithm !== RECEIPT_SIGNATURE_ALGORITHM ||
    !/^mgw_[a-f0-9]{16}$/.test(receipt.keyId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(receipt.signature) ||
    receipt.capabilities == null || typeof receipt.capabilities !== "object" || Array.isArray(receipt.capabilities) ||
    !exactReceiptKeys(receipt.capabilities, receiptCapabilities)
  ) throw failure("deepseek_release_receipt_invalid");
  const expected = signDeepSeekReleaseReceipt(unsignedReceiptFields(receipt), { signingSecret });
  const actualMac = Buffer.from(receipt.signature);
  const expectedMac = Buffer.from(expected.signature);
  if (
    receipt.keyId !== expected.keyId ||
    actualMac.length !== expectedMac.length ||
    !timingSafeEqual(actualMac, expectedMac)
  ) throw failure("deepseek_release_receipt_signature_invalid");
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 60_000 || maxAgeMs > 7 * 24 * 60 * 60 * 1000) {
    throw failure("deepseek_release_receipt_freshness_invalid");
  }
  const createdAtMs = Date.parse(receipt.createdAt);
  if (createdAtMs > nowMs + MAX_RECEIPT_FUTURE_MS) throw failure("deepseek_release_receipt_future");
  if (createdAtMs < nowMs - maxAgeMs) throw failure("deepseek_release_receipt_stale");
  if (requireProduction && (receipt.mode !== "production" || receipt.productionEligible !== true)) {
    throw failure("deepseek_release_receipt_fake");
  }
  if (receiptId != null && receipt.id !== receiptId) throw failure("deepseek_release_receipt_mismatch");
  if (sourceRevision != null && receipt.sourceRevision !== sourceRevision) throw failure("deepseek_release_receipt_mismatch");
  if (configRevision != null && receipt.configRevision !== configRevision) throw failure("deepseek_release_receipt_mismatch");
  const capabilities = receipt.capabilities;
  if (
    capabilities.providerBaseline !== true ||
    capabilities.providerStreaming !== true ||
    capabilities.providerToolLoop !== true ||
    capabilities.providerStructuredOutput !== true ||
    capabilities.gatewayOnly !== true ||
    capabilities.streaming !== true ||
    !Number.isSafeInteger(capabilities.toolResultIterations) || capabilities.toolResultIterations < 2 ||
    capabilities.sessionHistory !== true ||
    capabilities.structuredFinal !== true
  ) throw failure("deepseek_release_receipt_capability_missing");
  return receipt;
}

/**
 * Share of the window that must still remain before renewal is called for.
 * A third leaves eight hours of the default day — enough for someone to notice
 * and act during one working period, rather than at the moment it breaks.
 */
const RECEIPT_RENEWAL_FRACTION = 1 / 3;

/** The command that produces a new receipt. Named in the warning, because
 *  "the receipt is stale" is only actionable together with how to renew it. */
export const DEEPSEEK_RECEIPT_RENEWAL_COMMAND = "pnpm preflight:deepseek:release";

/**
 * How much of a receipt's life is left, without deciding anything about it.
 *
 * A receipt attests what the model did when it was probed, so it cannot be
 * renewed by re-stamping a fresh `createdAt` — renewal means running the gate
 * again. What was missing was not the expiry but the lead time: the window is
 * a day, nothing renewed it, and the only signal was readiness turning red at
 * the moment it had already expired. Production sat red for eight days.
 *
 * Reported on every readiness poll so a monitor can alert while the receipt is
 * still valid, and surfaced by the host preflight so a deploy that would be
 * fine today but broken tomorrow says so.
 *
 * @param {Record<string, any>} receipt
 * @param {{ nowMs?: number, maxAgeMs?: number, renewAtFraction?: number }} [options]
 * @returns {{ ageMs: number, remainingMs: number, renewalDue: boolean, expired: boolean }}
 */
export function deepSeekReleaseReceiptFreshness(receipt, { nowMs = NaN, maxAgeMs = NaN, renewAtFraction = RECEIPT_RENEWAL_FRACTION } = {}) {
  const createdAtMs = Date.parse(receipt?.createdAt);
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || Number.isNaN(createdAtMs)) {
    throw failure("deepseek_release_receipt_freshness_invalid");
  }
  const ageMs = nowMs - createdAtMs;
  const remainingMs = maxAgeMs - ageMs;
  return {
    ageMs,
    remainingMs,
    // Strictly "past the renewal point and not yet expired" would hide the
    // fact that an expired receipt also needs renewing; due stays true once
    // it is due.
    renewalDue: remainingMs <= maxAgeMs * renewAtFraction,
    expired: remainingMs <= 0,
  };
}

/** @param {string} file @param {Record<string, any>} options */
export function readDeepSeekReleaseReceiptFile(file, options = {}) {
  if (typeof file !== "string" || !file.trim()) throw failure("deepseek_release_receipt_path_missing");
  const target = path.resolve(file);
  let handle;
  try {
    handle = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024) throw failure("deepseek_release_receipt_file_invalid");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw failure("deepseek_release_receipt_permissions");
    let receipt;
    try {
      receipt = JSON.parse(fs.readFileSync(handle, "utf8"));
    } catch {
      throw failure("deepseek_release_receipt_invalid");
    }
    return validateDeepSeekReleaseReceipt(receipt, options);
  } catch (error) {
    if (error instanceof ReleaseGateError) throw error;
    if (error?.code === "ELOOP") throw failure("deepseek_release_receipt_path_invalid");
    if (error?.code === "ENOENT") throw failure("deepseek_release_receipt_missing");
    throw failure("deepseek_release_receipt_file_invalid");
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
}

/**
 * Mints a signed receipt by driving the kernel through the whole tool chain.
 *
 * Not implemented for this kernel, and it refuses rather than pretending. What
 * the retired implementation did — spawn the kernel binary, point it at a fake
 * provider behind the real model gateway, make it call the EviMed research MCP
 * and a file-writing tool, then read its exported session history for completed
 * tool results and a structured final answer — has no host-side equivalent
 * here: the `evimed-universal` preset and the research MCP are baked into the
 * runtime image at `/opt/evimed`, and the generated profile patch names those
 * paths, so a kernel started from a bare binary has no tool chain to drive.
 *
 * What a replacement needs, so the next attempt starts from the requirement
 * rather than from this comment:
 *   - the runtime image (`deploy/runtime-dsh`), started the way
 *     `buildRuntimeLaunchPlan` starts it, with the model gateway of this
 *     process reachable from inside it;
 *   - the 0.1.2 wire to drive it: `session/create` with `agentPreset`,
 *     `session/prompt`, and `session/page` through `projections.asOfSeq` for
 *     the history — the same calls `RuntimeManager` already makes;
 *   - the evidence read from session events (`tool/call`, `tool/result`,
 *     `assistant/message`) rather than from the retired kernel's message parts.
 *
 * Until then production readiness has no receipt and says so, which is the
 * intended failure: it is visible, it is named, and it does not certify
 * anything that was not measured.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<never>}
 */
export async function runDeepSeekKernelReleaseGate(options = {}) {
  void options;
  throw failure("deepseek_release_chain_unavailable");
}

async function main() {
  try {
    const mode = process.argv.includes("--fake") ? "fake" : "production";
    // `Promise<never>` is the truth today: the gate refuses, so this reporting is
    // unreachable. It stays because it is the shape a minting gate has to return
    // to, and the cast here is what lets the signature keep saying "cannot
    // succeed" instead of being widened to hide that.
    const receipt = /** @type {Record<string, any>} */ (await runDeepSeekKernelReleaseGate({
      mode,
      keyFile: process.env.OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE,
      modelGatewaySigningSecretFile: process.env.OPEN_SCIENCE_MODEL_GATEWAY_SIGNING_SECRET_FILE,
      receiptPath: process.env.OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_FILE,
      receiptId: process.env.OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_ID,
    }));
    process.stdout.write(`${JSON.stringify({ ok: true, receiptId: receipt.id, mode: receipt.mode })}\n`);
  } catch (error) {
    const code = error instanceof ReleaseGateError || typeof error?.code === "string"
      ? error.code
      : "deepseek_release_gate_internal_error";
    const diagnostic = process.env.OPEN_SCIENCE_RELEASE_GATE_DIAGNOSTICS === "true" && typeof error?.diagnostic === "string"
      ? error.diagnostic.slice(0, 8 * 1024)
      : undefined;
    process.stderr.write(`${JSON.stringify({ ok: false, code, ...(diagnostic ? { diagnostic } : {}) })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) await main();
