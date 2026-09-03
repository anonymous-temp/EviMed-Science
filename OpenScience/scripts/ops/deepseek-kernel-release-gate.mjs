#!/usr/bin/env node
/**
 * The signed receipt that says the model which actually answers can drive the
 * whole tool chain, and the reader that production readiness uses to check one.
 *
 * The minting half drives a real runtime container through a two-tool run and
 * reads what the session actually recorded; see `runDeepSeekKernelReleaseGate`
 * for what it needs and where it has to run. It replaces one that drove the
 * retired kernel as a bare binary — `opencode run` against a fake provider,
 * then `opencode export` — reading that kernel's own message and part shapes
 * throughout, none of which survives the kernel it read. Nothing in either
 * version certifies more than it measured: a receipt that claims more is worse
 * than no receipt, because everything downstream trusts it exactly as much
 * either way.
 *
 * The verification half — schema, signature, freshness, and the readiness
 * comparison that reads it — is unchanged apart from the field naming the
 * kernel, which moved from `opencodeVersion` to `dshVersion` together with the
 * signer, the validator and readiness, because a receipt is signed over its
 * whole body and a field renamed on one side alone verifies as tampering.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { certifiedDeepSeekModel, createModelGatewayHandler, supportedDeepSeekModels } from "../../apps/server/src/modelGateway.mjs";
import { runDeepSeekCompatibility } from "./deepseek-compatibility-preflight.mjs";

// The control plane's own modules — `config`, the runtime manager, the wire
// adapter — are loaded by the minting half only, at the point it runs, and not
// by importing this file.
//
// The reason is where each half runs. Verification is imported by
// `host-preflight.mjs` and by the server, and the host runs it out of a release
// directory that has no `node_modules` at all: those modules import workspace
// packages, so a static import here made `pnpm preflight:host` fail to load
// with `Cannot find package '@evimed/domain'` — a gate reporting a missing
// dependency instead of a missing receipt. Minting runs inside the web image,
// where they resolve. Keeping the import where the code runs is what lets one
// module serve both.

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

/* ----------------------------------------------------------- the chain */

/**
 * The self-check the receipt certifies, written once and read by both the
 * prompt and the evidence reader.
 *
 * Two tools, not one, and the second one writes a file. A single tool call
 * proves the model can be handed a tool; it does not prove the loop — that a
 * result came back, was read, and decided what happened next. The retired gate
 * required the same two things for the same reason, and `toolResultIterations`
 * in the receipt schema is that requirement written down.
 */
export const RELEASE_GATE_ARTIFACT = "artifacts/deepseek-release-gate.json";
/** How old an abandoned gate project must be before a later mint removes it.
 *  Comfortably longer than the gate's own ceiling, so the sweep can never
 *  reach a run that is still going. */
const STALE_GATE_PROJECT_MS = 2 * 60 * 60 * 1000;
const RELEASE_GATE_TERM = "acetaminophen";
const RELEASE_GATE_NORMALIZED = "paracetamol";
/** The two MCP tools that answer a normalization; either is acceptable
 *  evidence, and both are named because a run may reach for either. */
const normalizationTools = new Set(["term_normalize", "drug_term_normalize"]);

const RELEASE_GATE_PROMPT = [
  "This is a deployment self-check. Do it directly: no plan, no delegation, no other tools.",
  `Step 1: call mcp__evimed__term_normalize with {"term":"${RELEASE_GATE_TERM}","domain":"drug"} and read its result.`,
  `Step 2: write the file ${RELEASE_GATE_ARTIFACT} containing exactly this JSON object,`,
  "taking every value from step 1's input or result:",
  `{"normalized":"<the preferred term>","provenanceTool":"<the tool name the result's provenance names>","sourceTerm":"${RELEASE_GATE_TERM}"}`,
  "Do not rename or nest those three fields.",
  "Step 3: reply with exactly one JSON object and no other text, no code fence:",
  `{"normalized":"<the same preferred term>","artifact":"${RELEASE_GATE_ARTIFACT}"}`,
].join("\n");

/**
 * A tool's own name, with the MCP server prefix the model sees stripped off.
 *
 * `@evimed/domain` has `mcpToolBaseName`, and importing it here would put a
 * workspace package on the load path of a module the host preflight imports
 * out of a directory that has no `node_modules`. The convention is the MCP
 * one — `mcp__<server>__<tool>` — so it is applied here and tied back to the
 * domain by a test that asserts this function inverts `mcpToolName`, which runs
 * where the package does resolve.
 * @param {string} name
 * @returns {string}
 */
export function mcpBaseName(name) {
  return String(name ?? "").replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
}

/**
 * The payload inside a tool result, whatever envelope it arrived in.
 *
 * MCP puts the tool's own object under `structuredContent`; reading the
 * envelope as the payload is how twenty-six tools once looked like they had
 * returned nothing at all.
 * @param {unknown} output
 * @returns {Record<string, any> | null}
 */
function parsedToolPayload(output) {
  if (typeof output !== "string" || !output.trim()) return null;
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    return null;
  }
  if (value != null && typeof value === "object" && !Array.isArray(value) && value.structuredContent !== undefined) {
    value = value.structuredContent;
  }
  return value != null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** @param {unknown} text @returns {Record<string, any> | null} */
function parsedFinalAnswer(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  // Bounded by the outermost brace pair, which is deliberately lenient in one
  // direction and strict in the other: a code fence or a sentence around the
  // object is presentation and does not change what the model produced, while
  // the slice between the braces must parse whole — so "an object with a
  // trailing apology" passes and "prose that mentions the fields" does not.
  //
  // There was an unfencing regex here as well. It never decided anything: for
  // every fenced answer the brace bounds already selected the same slice, so
  // it read as a second protection while providing none.
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first < 0 || last < first) return null;
  try {
    const value = JSON.parse(trimmed.slice(first, last + 1));
    return value != null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * What one transcript proves about the chain.
 *
 * Pure, and exported, because this is the half of the gate a test can reach:
 * everything above it needs Docker, a runtime image and a paid model, and a
 * check nothing can exercise is a check nobody notices breaking.
 *
 * @param {{ messages?: readonly any[] }} transcript
 * @returns {{ normalizationCompleted: boolean, artifactWriteCompleted: boolean, structuredFinal: boolean, toolResults: number, normalization: Record<string, any> | null, finalAnswer: Record<string, any> | null }}
 */
export function dshTranscriptEvidence(transcript) {
  const messages = Array.isArray(transcript?.messages) ? transcript.messages : [];
  /** @type {Record<string, any>[]} */
  const toolParts = messages.flatMap((message) =>
    (Array.isArray(message?.parts) ? message.parts : []).filter((part) => part?.type === "tool"));
  const completed = toolParts.filter((part) => part.status === "completed");

  let normalization = null;
  for (const part of completed) {
    if (!normalizationTools.has(mcpBaseName(String(part.tool ?? "")))) continue;
    const payload = parsedToolPayload(part.output);
    const data = payload?.data;
    if (
      payload?.status === "success" &&
      data?.preferred === RELEASE_GATE_NORMALIZED &&
      normalizationTools.has(String(data?.provenance?.tool ?? "")) &&
      String(data?.input ?? "").trim().toLowerCase() === RELEASE_GATE_TERM
    ) normalization = data;
  }

  // Which tool wrote it is deliberately not asserted. The composition mounts
  // several that can — `tool-fs`, `tool-bash` — and pinning one would make the
  // gate fail on a run that did the work by a route the deployment also ships.
  // What is asserted is that a tool call completed naming this path, and (in
  // the caller) that the file is on disk with the right content.
  const artifactWriteCompleted = completed.some((part) =>
    JSON.stringify(part.input ?? {}).includes(RELEASE_GATE_ARTIFACT));

  let finalAnswer = null;
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      if (part?.type !== "text") continue;
      const value = parsedFinalAnswer(part.text);
      if (value?.normalized === RELEASE_GATE_NORMALIZED && value?.artifact === RELEASE_GATE_ARTIFACT) finalAnswer = value;
    }
  }

  return {
    normalizationCompleted: normalization !== null,
    artifactWriteCompleted,
    structuredFinal: finalAnswer !== null,
    toolResults: completed.length,
    normalization,
    finalAnswer,
  };
}

/**
 * What the gateway's own counters prove.
 *
 * `gatewayOnly` is a count and not an absence: nothing here can observe a
 * request the runtime made somewhere else, so the claim it can support is that
 * the model traffic this run needed did arrive at our gateway. The container's
 * network is `internal` and the kernel holds no provider key — that is what
 * makes bypass impossible; this is what makes the gateway's use observable.
 *
 * @param {{ gateway: { requests: number, sseResponses: number }, streamedEventCount: number }} input
 * @returns {{ gatewayOnly: boolean, streaming: boolean }}
 */
export function releaseTelemetryEvidence({ gateway, streamedEventCount }) {
  const gatewayOnly = Number.isSafeInteger(gateway?.requests) && gateway.requests >= 2;
  const streaming = Number.isSafeInteger(gateway?.sseResponses) &&
    gateway.sseResponses >= 2 &&
    Number.isSafeInteger(streamedEventCount) &&
    streamedEventCount > 0;
  return { gatewayOnly, streaming };
}

/**
 * The model gateway of this process, counting what passes through it.
 *
 * The handler is the server's own — a second implementation would certify a
 * gateway nobody deploys — wrapped only to count requests and the responses
 * that came back as a stream.
 * @param {Record<string, any>} config
 * @param {import("../../apps/server/src/runtimeManager.mjs").RuntimeManager} manager
 */
async function startCountingGateway(config, manager) {
  const handler = createModelGatewayHandler(config, manager);
  const state = { requests: 0, sseResponses: 0 };
  const server = http.createServer((req, res) => {
    state.requests += 1;
    const writeHead = res.writeHead.bind(res);
    res.writeHead = /** @type {any} */ ((statusCode, statusMessage, headers) => {
      const supplied = typeof statusMessage === "object" ? statusMessage : headers;
      const contentType = supplied?.["content-type"] ?? supplied?.["Content-Type"] ?? res.getHeader("content-type");
      if (String(contentType ?? "").includes("text/event-stream")) state.sseResponses += 1;
      return typeof statusMessage === "string"
        ? writeHead(statusCode, statusMessage, headers)
        : writeHead(statusCode, statusMessage);
    });
    void handler(req, res);
  });
  // Every interface: the runtime container reaches this by the deployment's own
  // service name, not by loopback, because it is a different container.
  server.listen(0, "0.0.0.0");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return {
    port: /** @type {import("node:net").AddressInfo} */ (server.address()).port,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** @param {string} value @param {string} fallback */
function safeRevision(value, fallback) {
  const normalized = String(value ?? fallback).trim();
  if (!normalized || normalized.length > 256 || /[\r\n\0]/.test(normalized)) throw failure("deepseek_release_revision_invalid");
  return normalized;
}

/** @param {string} receiptPath @param {Record<string, any>} receipt */
async function writeReceipt(receiptPath, receipt) {
  if (typeof receiptPath !== "string" || !receiptPath.trim()) throw failure("deepseek_release_receipt_path_missing");
  const target = path.resolve(receiptPath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  // 0600 written before the content, because the reader refuses a receipt any
  // group or other can read and a chmod after the write leaves a window.
  const handle = await fsp.open(target, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await fsp.chmod(target, 0o600);
}

/**
 * Runs the chain against a real runtime container and returns what it observed.
 *
 * @param {{ config?: Record<string, any>, timeoutMs: number }} input
 */
async function runDshChain({ config: supplied, timeoutMs }) {
  const [{ loadConfig }, { DshRuntimeAdapter }, { RuntimeManager }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/dshRuntimeAdapter.mjs"),
    import("../../apps/server/src/runtimeManager.mjs"),
  ]);
  const config = supplied ?? loadConfig();
  if (String(config.runtimeMode ?? "") !== "kernel") throw failure("deepseek_release_runtime_mode_invalid");
  if (String(config.runtimeSandboxMode ?? "") !== "docker") throw failure("deepseek_release_runtime_sandbox_invalid");
  const dataDir = String(config.dataDir ?? "");
  if (!dataDir) throw failure("deepseek_release_data_dir_missing");

  // A project of its own, under the layout the store uses, deleted at the end.
  // Reusing a user's project would run the gate's prompt inside their workspace
  // and leave its artifact there.
  const userId = "release-gate";
  const projectId = `gate-${randomBytes(6).toString("hex")}`;
  const userRoot = path.join(dataDir, "users", userId);
  const rootDir = path.join(userRoot, "projects", projectId);
  const workspaceDir = path.join(rootDir, "workspace");
  const project = {
    id: projectId,
    name: projectId,
    tenantId: userId,
    userId,
    userRoot,
    rootDir,
    baseDir: workspaceDir,
    workspaceDir,
    runtimeDir: path.join(rootDir, "runtime"),
    metaDir: path.join(rootDir, "meta"),
    activeWorkspace: "",
  };

  /** @type {import("../../apps/server/src/runtimeManager.mjs").RuntimeManager | null} */
  let manager = null;
  /** @type {{ port: number, state: { requests: number, sseResponses: number }, close: () => Promise<unknown> } | null} */
  let gateway = null;
  try {
    // Anything a previous mint left behind, before this one adds to it. The
    // `finally` below removes this run's project, but a killed process skips
    // it, and what is left is not small: the kernel installs its profile with
    // pnpm, so an abandoned project holds a whole node_modules tree.
    //
    // By age, and this is the whole point of the rule. The first version swept
    // every project under this user, and the receipt scheduler runs the gate
    // unattended — so a scheduled mint and a manual one deleted each other's
    // workspace mid-run, and what came back was `file_not_found` from the
    // controller. Nothing younger than the ceiling can belong to a finished
    // run, and nothing older can belong to a live one.
    const staleBefore = Date.now() - STALE_GATE_PROJECT_MS;
    const projectsRoot = path.join(userRoot, "projects");
    for (const stale of await fsp.readdir(projectsRoot).catch(() => [])) {
      const staleDir = path.join(projectsRoot, stale);
      const stat = await fsp.stat(staleDir).catch(() => null);
      if (!stat || stat.mtimeMs >= staleBefore) continue;
      await fsp.rm(staleDir, { recursive: true, force: true }).catch(() => {});
    }
    await Promise.all([workspaceDir, project.runtimeDir, project.metaDir]
      .map((dir) => fsp.mkdir(dir, { recursive: true, mode: 0o700 })));

    manager = new RuntimeManager(config);
    gateway = await startCountingGateway(config, manager);
    // The path is the deployment's; the authority is THIS process's. Taking the
    // hostname from `modelGatewayInternalUrl` would name the web container —
    // which is not where the gate runs, so the runtime would dial a port
    // nothing listens on and the run would fail as "no gateway traffic", which
    // names the symptom of a wrong address rather than the address.
    //
    // `os.hostname()` inside a container is its id, and Docker's embedded DNS
    // resolves it for every container on the same user-defined network — the
    // runtime network this launch plan attaches to. The override exists for a
    // deployment whose DNS does not.
    const deployed = new URL(String(config.modelGatewayInternalUrl ?? ""));
    const gatewayHost = String(process.env.OPEN_SCIENCE_RELEASE_GATE_GATEWAY_HOST ?? "").trim() || os.hostname();
    config.modelGatewayInternalUrl = `http://${gatewayHost}:${gateway.port}${deployed.pathname.replace(/\/$/, "")}`;

    const runtime = await manager.start(project);
    const transport = {
      // The gate makes unary calls only. `stream` is required by the transport
      // contract and refuses rather than being left undefined: an adapter path
      // that reached for a stream here would be a defect, and a refusal names
      // it where `undefined is not a function` would not.
      stream: () => { throw failure("deepseek_release_stream_unsupported"); },
      /** @param {string} method @param {Record<string, unknown>} payload @param {{ signal?: AbortSignal }} [options] */
      call: async (method, payload, options = {}) => ({
        ok: true,
        // `callKernel` already maps a wire error to a named control-plane error
        // and throws it. Catching it here to re-wrap would map it twice and
        // rename it on the way.
        value: await /** @type {any} */ (manager).callKernel(runtime, project, method, payload, options.signal),
      }),
    };
    const adapter = new DshRuntimeAdapter(transport);

    const session = await /** @type {any} */ (manager).createRuntimeSession(project);
    const sessionId = session.id;
    if (!sessionId) throw failure("deepseek_release_session_missing");
    await /** @type {any} */ (manager).dispatchPrompt(project, sessionId, { text: RELEASE_GATE_PROMPT });

    // The turn is over when the transcript says so. Polling the transcript is
    // what the control plane's own monitor does, and it is the only signal that
    // distinguishes "still working" from "died in its first minute".
    const deadline = Date.now() + timeoutMs;
    let transcript = await adapter.transcript({ sessionId });
    while (!transcript.turnEnd && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      transcript = await adapter.transcript({ sessionId });
    }
    if (!transcript.turnEnd) throw failure("deepseek_release_turn_unfinished");

    const evidence = dshTranscriptEvidence(transcript);
    if (!evidence.normalizationCompleted) {
      const error = failure("deepseek_release_mcp_tool_missing");
      error.diagnostic = JSON.stringify(transcriptStructure(transcript));
      throw error;
    }
    if (!evidence.artifactWriteCompleted) {
      const error = failure("deepseek_release_artifact_tool_missing");
      error.diagnostic = JSON.stringify(transcriptStructure(transcript));
      throw error;
    }
    if (evidence.toolResults < 2) throw failure("deepseek_release_tool_result_iterations_missing");
    if (!evidence.structuredFinal) throw failure("deepseek_release_structured_final_missing");

    // The file itself, host-side. The transcript says a tool reported writing
    // it; this is the deployment's own mount answering whether it exists — the
    // one claim in the chain that does not depend on the model's account of
    // what it did.
    const artifactFile = path.join(workspaceDir, RELEASE_GATE_ARTIFACT);
    let artifact;
    try {
      artifact = JSON.parse(await fsp.readFile(artifactFile, "utf8"));
    } catch {
      throw failure("deepseek_release_artifact_missing");
    }
    if (
      artifact?.normalized !== RELEASE_GATE_NORMALIZED ||
      !normalizationTools.has(String(artifact?.provenanceTool ?? "")) ||
      String(artifact?.sourceTerm ?? "").trim().toLowerCase() !== RELEASE_GATE_TERM
    ) {
      const error = failure("deepseek_release_artifact_invalid");
      error.diagnostic = JSON.stringify({
        keys: artifact && typeof artifact === "object" ? Object.keys(artifact).sort() : [],
      });
      throw error;
    }

    const { gatewayOnly, streaming } = releaseTelemetryEvidence({
      gateway: gateway.state,
      streamedEventCount: evidence.toolResults + (transcript.messages?.length ?? 0),
    });
    // Nothing at all is a different fault from too little, and conflating them
    // reports a wrong address as a security finding. A run that produced a
    // transcript without touching this gateway reached a model somewhere else —
    // in practice, an address the container could not resolve.
    if (gateway.state.requests === 0) {
      const error = failure("deepseek_release_gateway_unreachable");
      error.diagnostic = JSON.stringify({ gatewayUrl: config.modelGatewayInternalUrl });
      throw error;
    }
    if (!gatewayOnly) throw failure("deepseek_release_gateway_bypass_detected");
    if (!streaming) {
      const error = failure("deepseek_release_streaming_evidence_missing");
      error.diagnostic = JSON.stringify(gateway.state);
      throw error;
    }

    return {
      evidence: {
        gatewayOnly,
        streaming,
        toolResultIterations: evidence.toolResults,
        sessionHistory: true,
        structuredFinal: evidence.structuredFinal,
      },
    };
  } finally {
    await manager?.stop(project).catch(() => {});
    await manager?.closeAll().catch(() => {});
    await gateway?.close().catch(() => {});
    await fsp.rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * What the transcript looked like when it did not carry what the gate needed.
 *
 * Attached to the failure rather than printed: it names tools and paths, so it
 * travels only when `OPEN_SCIENCE_RELEASE_GATE_DIAGNOSTICS` is on.
 * @param {{ messages?: readonly any[] }} transcript
 */
function transcriptStructure(transcript) {
  const messages = Array.isArray(transcript?.messages) ? transcript.messages : [];
  return {
    messages: messages.length,
    rows: messages.slice(0, 60).map((message) => ({
      role: message?.role ?? null,
      parts: (Array.isArray(message?.parts) ? message.parts : []).map((part) => ({
        type: part?.type ?? null,
        tool: part?.tool ?? null,
        status: part?.status ?? null,
        outputBytes: typeof part?.output === "string" ? part.output.length : 0,
      })),
    })),
  };
}

/**
 * Mints a signed receipt by driving the kernel through the whole tool chain.
 *
 * What this must prove, and why each half exists. The provider half asks the
 * DeepSeek API directly whether the configured model still does the four
 * things a run depends on. The kernel half asks whether *this deployment* can
 * turn that model into finished work: the runtime image, the `evimed-universal`
 * composition, the research MCP, the file tools, and the gateway between them.
 * Either half alone certifies a system nobody runs.
 *
 * It drives the real thing rather than a copy. `RuntimeManager.start` launches
 * the container — same launch plan, same profile patch, same browser-session
 * cookie, same unix transport — and `callKernel` makes the calls, so a wire
 * change breaks this gate in the same place it breaks production instead of
 * leaving a gate that passes against a protocol the product no longer speaks.
 *
 * The one thing it does not borrow is the model gateway: this process starts
 * its own, on the handler the server mounts, because `gatewayOnly` and
 * `streaming` are counts and a count needs a counter. The runtime reaches it by
 * the same service name production uses, so what is certified is the path
 * production takes.
 *
 * Where it runs. Inside the web image, on the deployment's own network — the
 * `receipt` compose profile is exactly that container. It cannot run from a
 * bare checkout: the composition, the MCP and the capability trees live at
 * `/opt/evimed` inside the runtime image, and a kernel that cannot find them
 * boots, serves, answers its health probe and satisfies nothing.
 *
 * Ordering. The gate needs `config.releaseManifest` to name the image it is
 * about to run, so it comes AFTER `release:manifest`, not before. The retired
 * gate ran first because it drove a bare binary that no manifest described.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function runDeepSeekKernelReleaseGate({
  mode = "production",
  config: suppliedConfig,
  keyFile = process.env.OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE,
  modelGatewaySigningSecretFile = process.env.OPEN_SCIENCE_MODEL_GATEWAY_SIGNING_SECRET_FILE,
  receiptPath = process.env.OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_FILE,
  receiptId = process.env.OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_ID,
  sourceRevision = process.env.OPEN_SCIENCE_SOURCE_REVISION,
  configRevision = process.env.OPEN_SCIENCE_DEEPSEEK_CONFIG_REVISION,
  receiptSigningSecret,
  timeoutMs = 900_000,
} = {}) {
  // `fake` is refused rather than emulated. The retired gate's fake mode drove
  // a REAL kernel binary against a scripted provider; the equivalent here would
  // still need the runtime image and Docker, so it would not buy the one thing
  // a fake is for — running where the real thing cannot. What it would buy is a
  // second definition of "passed", and the mock kernel in this repository
  // answers one tool call and a fixed sentence, so a gate that accepted it
  // would certify the mock.
  if (mode !== "production") throw failure("deepseek_release_mode_invalid");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 30 * 60_000) {
    throw failure("deepseek_release_timeout_invalid");
  }
  if (!keyFile || !receiptId) throw failure("deepseek_release_input_missing");
  const signingSecret = receiptSigningSecret ?? readModelGatewaySigningSecretFile(modelGatewaySigningSecretFile);

  // Asked of the provider first, and separately: a model that cannot stream or
  // hold a tool loop fails here in seconds with a name, instead of fifteen
  // minutes later as "the run produced no tool results".
  const providerCapabilities = await runDeepSeekCompatibility({
    keyFile,
    baseUrl: process.env.OPEN_SCIENCE_DEEPSEEK_BASE_URL || undefined,
    model: REQUIRED_MODEL,
  });

  const chain = await runDshChain({ config: suppliedConfig, timeoutMs });
  const unsignedReceipt = {
    schemaVersion: 1,
    id: receiptId,
    mode: "production",
    productionEligible: true,
    createdAt: new Date().toISOString(),
    dshVersion: REQUIRED_DSH_VERSION,
    model: REQUIRED_MODEL,
    sourceRevision: safeRevision(sourceRevision, ""),
    configRevision: safeRevision(configRevision, ""),
    capabilities: {
      providerBaseline: providerCapabilities.ok === true,
      providerStreaming: providerCapabilities.ok === true,
      providerToolLoop: providerCapabilities.ok === true,
      providerStructuredOutput: providerCapabilities.ok === true,
      ...chain.evidence,
    },
  };
  const receipt = signDeepSeekReleaseReceipt(unsignedReceipt, { signingSecret });
  // Verified with the same reader production uses, before it is written. A
  // receipt that only fails when readiness reads it fails on the wrong machine
  // at the wrong time.
  validateDeepSeekReleaseReceipt(receipt, { requireProduction: true, signingSecret, receiptId });
  await writeReceipt(receiptPath, receipt);
  return receipt;
}

async function main() {
  try {
    // `--fake` is still read, and still refused by name. Silently ignoring a
    // flag an operator typed would mint a production receipt for someone who
    // asked for a rehearsal.
    const mode = process.argv.includes("--fake") ? "fake" : "production";
    const receipt = await runDeepSeekKernelReleaseGate({
      mode,
      keyFile: process.env.OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE,
      modelGatewaySigningSecretFile: process.env.OPEN_SCIENCE_MODEL_GATEWAY_SIGNING_SECRET_FILE,
      receiptPath: process.env.OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_FILE,
      receiptId: process.env.OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_ID,
      ...(process.env.OPEN_SCIENCE_RELEASE_GATE_TIMEOUT_MS
        ? { timeoutMs: Number(process.env.OPEN_SCIENCE_RELEASE_GATE_TIMEOUT_MS) }
        : {}),
    });
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
