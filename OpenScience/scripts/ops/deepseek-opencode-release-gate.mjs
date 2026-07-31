#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createModelGatewayHandler } from "../../apps/server/src/modelGateway.mjs";
import {
  RuntimeManager,
  syncRuntimeEviMedMcp,
  syncRuntimeModelProvider,
} from "../../apps/server/src/runtimeManager.mjs";
import { runDeepSeekCompatibility } from "./deepseek-compatibility-preflight.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptFile), "../..");
const REQUIRED_OPENCODE_VERSION = "1.17.13";
const REQUIRED_MODEL = "deepseek-v4-pro";
const MAX_PROCESS_OUTPUT = 4 * 1024 * 1024;
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
const normalizationTools = new Set(["evimed_term_normalize", "evimed_drug_term_normalize"]);

export function resolveArtifactProvenanceTool(artifactData) {
  const provenance = artifactData?.provenance;
  return artifactData?.provenanceTool
    ?? artifactData?.provenance_tool
    ?? (typeof provenance === "string" ? provenance : null)
    ?? provenance?.tool
    ?? provenance?.toolName
    ?? provenance?.name;
}

class ReleaseGateError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`DeepSeek OpenCode release gate failed: ${code}`);
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

/** @param {Record<string, any>} options */
export function resolveOpenCodeBinary({ repoRoot = defaultRepoRoot, opencodeBin = process.env.OPEN_SCIENCE_OPENCODE_BIN } = {}) {
  if (opencodeBin) return path.resolve(opencodeBin);
  const target = process.platform === "darwin"
    ? process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
    : process.platform === "linux"
      ? process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
      : process.platform === "win32"
        ? "x86_64-pc-windows-msvc.exe"
        : "";
  if (!target) throw failure("opencode_binary_missing");
  return path.join(repoRoot, "apps/desktop/src-tauri/binaries", `opencode-${target}`);
}

function verifyOpenCodeBinary(bin) {
  let stat;
  try {
    stat = fs.lstatSync(bin);
  } catch {
    throw failure("opencode_binary_missing");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw failure("opencode_binary_invalid");
  if (process.platform !== "win32" && (stat.mode & 0o111) === 0) throw failure("opencode_binary_not_executable");
  const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  if (result.error) throw failure("opencode_version_unavailable");
  if (result.status !== 0 || result.stdout.trim() !== REQUIRED_OPENCODE_VERSION) {
    throw failure("opencode_version_mismatch");
  }
  return result.stdout.trim();
}

function completionChunk({ id, delta, finishReason = null }) {
  return {
    id,
    object: "chat.completion.chunk",
    created: 1_752_710_000,
    model: REQUIRED_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function writeSse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
}

async function readRequestBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw failure("fake_provider_request_too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw failure("fake_provider_request_invalid");
  }
}

function writeToolName(body) {
  const names = (body.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean);
  if (names.includes("write")) return "write";
  throw failure("opencode_write_tool_missing");
}

function evimedNormalizeToolName(body) {
  const names = (body.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean);
  const name = names.find((candidate) => candidate.toLowerCase().includes("evimed_term_normalize"));
  if (!name) throw failure("opencode_evimed_mcp_tool_missing");
  return { name, names };
}

function fakeArtifactArguments(workspaceDir) {
  return JSON.stringify({
    filePath: path.join(workspaceDir, "artifacts", "term-normalization.json"),
    content: `${JSON.stringify({
      normalized: "paracetamol",
      provenanceTool: "evimed_term_normalize",
      sourceTerm: "acetaminophen",
    }, null, 2)}\n`,
  });
}

function toolMessageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => typeof part?.text === "string" ? part.text : JSON.stringify(part)).join("\n");
  }
  return JSON.stringify(message?.content ?? "");
}

function parseToolResult(message) {
  const text = toolMessageText(message);
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch { /* handled below */ }
    }
  }
  throw failure("opencode_evimed_mcp_result_invalid");
}

async function startFakeProvider(workspaceDir) {
  const state = {
    requests: 0,
    authorized: 0,
    toolResultsObserved: 0,
    finalChunks: 0,
    advertisedTools: [],
    mcpToolName: null,
    mcpToolResult: null,
    writeToolResultObserved: false,
  };
  const server = http.createServer((req, res) => {
    void (async () => {
      const body = await readRequestBody(req);
      state.requests += 1;
      if (req.headers.authorization === "Bearer fake-deepseek-provider-key") state.authorized += 1;
      const completed = (body.messages ?? []).filter((message) => message?.role === "tool").length;
      state.toolResultsObserved = Math.max(state.toolResultsObserved, completed);
      if (completed === 0) {
        const discovered = evimedNormalizeToolName(body);
        state.advertisedTools = discovered.names;
        state.mcpToolName = discovered.name;
        writeSse(res, [completionChunk({
          id: "fake-mcp-tool",
          delta: {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "release-gate-mcp-call",
              type: "function",
              function: {
                name: discovered.name,
                arguments: JSON.stringify({ term: "acetaminophen", domain: "drug" }),
              },
            }],
          },
          finishReason: "tool_calls",
        })]);
        return;
      }
      if (completed === 1) {
        const message = (body.messages ?? []).filter((item) => item?.role === "tool").at(-1);
        const result = parseToolResult(message);
        if (
          result?.status !== "success" ||
          result?.data?.preferred !== "paracetamol" ||
          result?.data?.provenance?.tool !== "evimed_term_normalize"
        ) throw failure("opencode_evimed_mcp_result_invalid");
        state.mcpToolResult = result;
        const name = writeToolName(body);
        writeSse(res, [completionChunk({
          id: "fake-write-tool",
          delta: {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "release-gate-write-call",
              type: "function",
              function: { name, arguments: fakeArtifactArguments(workspaceDir) },
            }],
          },
          finishReason: "tool_calls",
        })]);
        return;
      }
      state.writeToolResultObserved = true;
      const first = completionChunk({
        id: "fake-final",
        delta: { role: "assistant", content: "{\"release_gate\":\"passed\",\"normalized\":\"paracetamol\"," },
      });
      const second = completionChunk({
        id: "fake-final",
        delta: { content: "\"artifact\":\"artifacts/term-normalization.json\"}" },
        finishReason: "stop",
      });
      state.finalChunks = 2;
      writeSse(res, [first, second]);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fake_provider_error" } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return {
    baseUrl: `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** @param {Record<string, any>} config @param {any} manager */
async function startGateway(config, manager) {
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
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return {
    baseUrl: `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function runBoundedProcess(bin, args, {
  cwd,
  env,
  timeoutMs,
  terminateGraceMs = 500,
  finalCloseWaitMs = 2_000,
}) {
  const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let closed = false;
  let terminationReason = null;
  let terminationGraceTimer;
  let finalCloseTimer;
  let resolveTerminationDeadline;
  const terminationDeadline = new Promise((resolve) => {
    resolveTerminationDeadline = resolve;
  });
  const kill = (signal) => {
    if (closed || child.exitCode != null || child.signalCode != null) return;
    try {
      child.kill(signal);
    } catch {
      // The bounded close check below remains authoritative.
    }
  };
  const beginTermination = (reason) => {
    if (terminationReason) return;
    terminationReason = reason;
    kill("SIGTERM");
    terminationGraceTimer = setTimeout(() => {
      kill("SIGKILL");
      finalCloseTimer = setTimeout(() => resolveTerminationDeadline({ deadlineExceeded: true }), finalCloseWaitMs);
      finalCloseTimer.unref?.();
    }, terminateGraceMs);
    terminationGraceTimer.unref?.();
  };
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_PROCESS_OUTPUT) beginTermination("output_too_large");
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_PROCESS_OUTPUT) beginTermination("output_too_large");
    else stderr.push(chunk);
  });
  const closeResult = new Promise((resolve) => {
    child.once("error", (error) => {
      if (child.pid == null) {
        closed = true;
        resolve({ error, code: null, signal: null });
      }
    });
    child.once("close", (code, signal) => {
      closed = true;
      resolve({ error: null, code, signal });
    });
  });
  const timer = setTimeout(() => beginTermination("timeout"), timeoutMs);
  timer.unref?.();
  let result;
  try {
    result = await Promise.race([closeResult, terminationDeadline]);
  } finally {
    clearTimeout(timer);
    clearTimeout(terminationGraceTimer);
    clearTimeout(finalCloseTimer);
    if (!closed) {
      kill("SIGKILL");
      await Promise.race([
        closeResult,
        new Promise((resolve) => {
          const cleanupTimer = setTimeout(resolve, finalCloseWaitMs);
          cleanupTimer.unref?.();
        }),
      ]);
    }
  }
  const stderrText = Buffer.concat(stderr).toString("utf8");
  if (result?.deadlineExceeded || !closed) throw failure("opencode_kill_unconfirmed");
  if (terminationReason === "output_too_large") throw failure("opencode_output_too_large");
  if (terminationReason === "timeout") {
    const error = failure("opencode_timeout");
    error.diagnostic = "bounded_opencode_process_timeout";
    throw error;
  }
  if (result.error) throw failure("opencode_spawn_failed");
  if (result.signal || result.code !== 0) {
    const error = failure(result.signal ? "opencode_timeout" : "opencode_chain_failed");
    const stdoutText = Buffer.concat(stdout).toString("utf8");
    const eventShape = stdoutText.split(/\r?\n/).map((line) => {
      try {
        const event = JSON.parse(line);
        let responseCode = null;
        try {
          const response = JSON.parse(event?.error?.data?.responseBody ?? "");
          responseCode = typeof response?.error?.code === "string" ? response.error.code : null;
        } catch { /* redacted shape only */ }
        return {
          type: typeof event?.type === "string" ? event.type : null,
          code: typeof event?.code === "string" ? event.code : typeof event?.error?.code === "string" ? event.error.code : null,
          name: typeof event?.error?.name === "string" ? event.error.name : null,
          status: Number.isSafeInteger(event?.error?.status) ? event.error.status : null,
          errorKeys: event?.error && typeof event.error === "object" ? Object.keys(event.error).sort() : [],
          dataKeys: event?.error?.data && typeof event.error.data === "object" ? Object.keys(event.error.data).sort() : [],
          statusCode: Number.isSafeInteger(event?.error?.data?.statusCode) ? event.error.data.statusCode : null,
          responseCode,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
    error.diagnostic = JSON.stringify(eventShape).slice(0, 1024);
    throw error;
  }
  return { stdout: Buffer.concat(stdout).toString("utf8"), stderr: stderrText };
}

function parseJsonLines(text) {
  const values = [];
  for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    try {
      values.push(JSON.parse(line));
    } catch {
      throw failure("opencode_event_stream_invalid");
    }
  }
  if (!values.length) throw failure("opencode_event_stream_empty");
  return values;
}

function findSessionId(values) {
  const queue = [...values];
  while (queue.length) {
    const value = queue.shift();
    if (value == null || typeof value !== "object") continue;
    for (const [key, item] of Object.entries(value)) {
      if (["sessionID", "sessionId", "session_id"].includes(key) && typeof item === "string" && item) return item;
      if (item && typeof item === "object") queue.push(item);
    }
  }
  throw failure("opencode_session_id_missing");
}

function normalizedArtifactPath(value, workspaceDir) {
  if (typeof value !== "string" || !value.trim()) return null;
  const canonical = (target) => {
    try { return fs.realpathSync.native(target); } catch { return path.resolve(target); }
  };
  const workspace = canonical(workspaceDir);
  const absolute = path.isAbsolute(value) ? canonical(value) : path.resolve(workspace, value);
  const relative = path.relative(workspace, absolute).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) return null;
  return relative;
}

function completedAssistantParts(history) {
  const messages = Array.isArray(history)
    ? history
    : Array.isArray(history?.messages)
      ? history.messages
      : Array.isArray(history?.data)
        ? history.data
        : [];
  return messages.flatMap((message) => {
    const role = message?.info?.role ?? message?.role;
    const completed = message?.info?.time?.completed ?? message?.completed;
    return role === "assistant" && completed && Array.isArray(message.parts) ? message.parts : [];
  });
}

function historyStructure(history) {
  const messages = Array.isArray(history)
    ? history
    : Array.isArray(history?.messages)
      ? history.messages
      : Array.isArray(history?.data)
        ? history.data
        : [];
  const rows = messages.map((message) => ({
    role: message?.info?.role ?? message?.role ?? null,
    completed: Boolean(message?.info?.time?.completed ?? message?.completed),
    parts: Array.isArray(message?.parts) ? message.parts.map((part) => ({
      type: part?.type ?? null,
      tool: part?.tool ?? null,
      status: part?.state?.status ?? null,
      inputKeys: part?.state?.input && typeof part.state.input === "object"
        ? Object.keys(part.state.input).sort()
        : [],
      hasOutput: typeof part?.state?.output === "string",
    })) : [],
  }));
  return {
    topLevel: history && typeof history === "object" ? Object.keys(history).sort() : [],
    rows,
  };
}

export function openCodeHistoryEvidence(history, workspaceDir) {
  const parts = completedAssistantParts(history);
  let mcpResult = null;
  let artifactPath = null;
  for (const part of parts) {
    if (part?.type !== "tool" || part?.state?.status !== "completed") continue;
    if (typeof part.tool === "string" && part.tool.toLowerCase().includes("term_normalize")) {
      try {
        const parsed = parseToolResult({ content: part.state.output });
        if (
          parsed?.status === "success" &&
          parsed?.data?.preferred === "paracetamol" &&
          normalizationTools.has(parsed?.data?.provenance?.tool) &&
          part?.state?.input?.term === "acetaminophen"
        ) mcpResult = parsed;
      } catch { /* invalid tool output is not evidence */ }
    }
    if (["write", "edit"].includes(part?.tool)) {
      artifactPath = normalizedArtifactPath(
        part?.state?.input?.filePath ?? part?.state?.input?.path,
        workspaceDir,
      ) ?? artifactPath;
    }
  }
  let structuredFinal = false;
  for (const part of parts) {
    if (part?.type !== "text" || typeof part.text !== "string") continue;
    try {
      const trimmed = part.text.trim();
      const unfenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
      const firstBrace = unfenced.indexOf("{");
      const lastBrace = unfenced.lastIndexOf("}");
      const value = JSON.parse(firstBrace >= 0 && lastBrace >= firstBrace ? unfenced.slice(firstBrace, lastBrace + 1) : unfenced);
      const normalized = value?.normalized ?? value?.preferred;
      if (
        normalized === "paracetamol" &&
        normalizedArtifactPath(value?.artifact, workspaceDir) === artifactPath
      ) structuredFinal = true;
    } catch { /* final text must be a JSON object */ }
  }
  const mcpToolCompleted = mcpResult !== null;
  const writeToolCompleted = artifactPath !== null;
  return {
    mcpToolCompleted,
    writeToolCompleted,
    structuredFinal,
    toolResults: Number(mcpToolCompleted) + Number(writeToolCompleted),
    artifactPath,
    mcpResult,
  };
}

function openCodeStreamEventCount(events) {
  return events.filter((event) => {
    if (!event || typeof event !== "object") return false;
    if (["text", "tool_use", "step_start", "step_finish"].includes(event.type)) return true;
    return [event.part?.type, event.properties?.part?.type].some((type) => ["text", "tool"].includes(type));
  }).length;
}

export function releaseTelemetryEvidence({ mode, gateway, provider, events }) {
  const streamedEventCount = openCodeStreamEventCount(Array.isArray(events) ? events : []);
  const gatewayOnly = Number.isSafeInteger(gateway?.requests) && gateway.requests >= 3 && (
    mode === "production" ||
    (
      Number.isSafeInteger(provider?.requests) &&
      provider.requests === gateway.requests &&
      provider.authorized === provider.requests
    )
  );
  const streaming = Number.isSafeInteger(gateway?.sseResponses) &&
    gateway.sseResponses >= 3 &&
    streamedEventCount > 0 &&
    (mode === "production" || provider?.finalChunks >= 2);
  return { gatewayOnly, streaming, streamedEventCount };
}

function safeRevision(value, fallback) {
  const normalized = String(value ?? fallback).trim();
  if (!normalized || normalized.length > 256 || /[\r\n\0]/.test(normalized)) throw failure("deepseek_release_revision_invalid");
  return normalized;
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
      "schemaVersion", "id", "mode", "productionEligible", "createdAt", "opencodeVersion",
      "model", "sourceRevision", "configRevision", "capabilities", "signatureAlgorithm", "keyId", "signature",
    ]) ||
    receipt.schemaVersion !== 1 ||
    !/^dsrg_[a-f0-9]{16,64}$/.test(receipt.id) ||
    !["fake", "production"].includes(receipt.mode) ||
    typeof receipt.productionEligible !== "boolean" ||
    !Number.isFinite(Date.parse(receipt.createdAt)) ||
    receipt.opencodeVersion !== REQUIRED_OPENCODE_VERSION ||
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

async function writeReceipt(receiptPath, receipt) {
  if (typeof receiptPath !== "string" || !receiptPath.trim()) throw failure("deepseek_release_receipt_path_missing");
  const target = path.resolve(receiptPath);
  const existing = await fsp.lstat(target).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw failure("deepseek_release_receipt_path_invalid");
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const staging = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(staging, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fsp.rename(staging, target);
    await fsp.chmod(target, 0o600);
  } finally {
    await fsp.rm(staging, { force: true }).catch(() => {});
  }
}

/** @param {Record<string, any>} options */
async function runOpenCodeChain({
  mode,
  repoRoot,
  opencodeBin,
  keyFile,
  modelGatewaySigningSecretFile,
  receiptSigningSecret,
  timeoutMs,
}) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "evimed-deepseek-gate-"));
  await fsp.chmod(tempRoot, 0o700);
  const workspaceDir = path.join(tempRoot, "workspace");
  const runtimeDir = path.join(tempRoot, "runtime");
  const metaDir = path.join(tempRoot, "meta");
  const homeDir = path.join(tempRoot, "home");
  const xdgConfigDir = path.join(runtimeDir, "xdg-config");
  const xdgDataDir = path.join(runtimeDir, "xdg-data");
  const xdgCacheDir = path.join(runtimeDir, "xdg-cache");
  const xdgStateDir = path.join(runtimeDir, "xdg-state");
  await Promise.all([workspaceDir, runtimeDir, metaDir, homeDir, xdgConfigDir, xdgDataDir, xdgCacheDir, xdgStateDir]
    .map((dir) => fsp.mkdir(dir, { recursive: true, mode: 0o700 })));
  let fakeProvider = null;
  let gateway = null;
  let manager = null;
  try {
    const providerCapabilities = mode === "production"
      ? await runDeepSeekCompatibility({ keyFile, baseUrl: "https://api.deepseek.com", model: REQUIRED_MODEL })
      : { ok: true };
    fakeProvider = mode === "fake" ? await startFakeProvider(workspaceDir) : null;
    const deepseekApiKey = mode === "fake"
      ? "fake-deepseek-provider-key"
      : (await import("./deepseek-compatibility-preflight.mjs")).readDeepSeekKeyFile(keyFile);
    const signingSecret = mode === "production"
      ? readModelGatewaySigningSecretFile(modelGatewaySigningSecretFile)
      : receiptSigningSecret ?? randomBytes(48).toString("base64url");
    const runtimeConfig = {
      deepseekProviderEnabled: true,
      deepseekModel: REQUIRED_MODEL,
      deepseekApiKey,
      deepseekBaseUrl: fakeProvider?.baseUrl ?? "https://api.deepseek.com",
      production: mode === "production",
      modelGatewaySigningSecret: signingSecret,
      modelGatewaySigningSecretError: null,
      modelGatewayTimeoutMs: Math.min(timeoutMs, 120_000),
      modelGatewayMaxBodyBytes: 2 * 1024 * 1024,
      evimedMcpSourceDir: path.join(repoRoot, "runtime", "mcp", "evimed-research"),
      evimedAdapterUrls: {},
      evimedWorkloadSigningSecret: "",
    };
    manager = new RuntimeManager(runtimeConfig);
    gateway = await startGateway(runtimeConfig, manager);
    runtimeConfig.modelGatewayInternalUrl = `${gateway.baseUrl}/internal/model/v1`;
    const project = {
      id: "release-gate",
      userId: "operator",
      rootDir: tempRoot,
      workspaceDir,
      runtimeDir,
      metaDir,
    };
    const plan = { sandboxMode: "host", xdgConfigDir, proxyWorkspaceDir: workspaceDir };
    await syncRuntimeEviMedMcp(runtimeConfig, project, plan);
    const model = await syncRuntimeModelProvider(runtimeConfig, project, plan);
    const activeRuntime = {
      modelGatewayToken: model.token,
      modelGatewayTokenJti: model.payload.jti,
      close: async () => {},
    };
    manager.activateModelGatewayRuntime(project, activeRuntime);
    const env = {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: xdgConfigDir,
      XDG_DATA_HOME: xdgDataDir,
      XDG_CACHE_HOME: xdgCacheDir,
      XDG_STATE_HOME: xdgStateDir,
      NO_COLOR: "1",
    };
    let run;
    try {
      run = await runBoundedProcess(opencodeBin, [
        "run", "--pure", "--format", "json", "--auto", "--model", `deepseek/${REQUIRED_MODEL}`,
        "--dir", workspaceDir,
        "Normalize acetaminophen in the drug domain with the available EviMed medical tool. Write exactly artifacts/deepseek-release-gate.json with exactly these JSON fields, taking every value from the tool input or result: {\"normalized\":\"paracetamol\",\"provenanceTool\":\"evimed_term_normalize\",\"sourceTerm\":\"acetaminophen\"}. Do not rename or nest those fields. Then return exactly one unfenced JSON object with this schema and no other text: {\"normalized\":\"paracetamol\",\"artifact\":\"artifacts/deepseek-release-gate.json\"}.",
      ], { cwd: workspaceDir, env, timeoutMs });
    } catch (error) {
      if (mode === "fake" && error && typeof error === "object") {
        error.diagnostic = JSON.stringify({
          requests: fakeProvider?.state.requests,
          toolResultsObserved: fakeProvider?.state.toolResultsObserved,
          mcpToolName: fakeProvider?.state.mcpToolName,
          advertisedToolCount: fakeProvider?.state.advertisedTools.length,
          mcpToolResult: fakeProvider?.state.mcpToolResult?.status ?? null,
          writeToolResultObserved: fakeProvider?.state.writeToolResultObserved,
        });
      }
      throw error;
    }
    const events = parseJsonLines(run.stdout);
    const sessionId = findSessionId(events);
    const exported = await runBoundedProcess(opencodeBin, ["export", sessionId], { cwd: workspaceDir, env, timeoutMs });
    let history;
    try {
      history = JSON.parse(exported.stdout);
    } catch {
      throw failure("opencode_session_history_invalid");
    }
    const evidence = openCodeHistoryEvidence(history, workspaceDir);
    const artifactRelativePath = evidence.artifactPath;
    if (!artifactRelativePath) {
      const error = failure("opencode_session_tool_history_missing");
      error.diagnostic = JSON.stringify(historyStructure(history));
      throw error;
    }
    const artifactPath = path.join(workspaceDir, artifactRelativePath);
    const artifactContent = await fsp.readFile(artifactPath, "utf8").catch(() => null);
    let artifactData;
    try { artifactData = JSON.parse(artifactContent); } catch { throw failure("opencode_tool_execution_missing"); }
    const normalized = artifactData?.normalized ?? artifactData?.preferred;
    const provenanceTool = resolveArtifactProvenanceTool(artifactData);
    const sourceTerm = artifactData?.sourceTerm ?? artifactData?.input?.term ?? artifactData?.input;
    if (
      normalized !== "paracetamol" ||
      !normalizationTools.has(provenanceTool) ||
      (sourceTerm != null && sourceTerm !== "acetaminophen")
    ) {
      const error = failure("opencode_tool_execution_missing");
      error.diagnostic = JSON.stringify({
        keys: artifactData && typeof artifactData === "object" ? Object.keys(artifactData).sort() : [],
        normalized: normalized ?? null,
        provenanceTool: provenanceTool ?? null,
        sourceTerm: sourceTerm ?? null,
      });
      throw error;
    }
    const fakeState = fakeProvider?.state;
    const toolIterations = evidence.toolResults;
    const structuredFinal = evidence.structuredFinal;
    if (toolIterations < 2) throw failure("opencode_tool_result_iterations_missing");
    if (!evidence.mcpToolCompleted || !evidence.writeToolCompleted) {
      throw failure("opencode_session_tool_history_missing");
    }
    if (!structuredFinal) throw failure("opencode_structured_final_missing");
    const { gatewayOnly, streaming, streamedEventCount } = releaseTelemetryEvidence({
      mode,
      gateway: gateway.state,
      provider: fakeState,
      events,
    });
    if (!gatewayOnly) {
      throw failure("opencode_gateway_bypass_detected");
    }
    if (!streaming) {
      const error = failure("opencode_streaming_evidence_missing");
      error.diagnostic = JSON.stringify({
        gateway: gateway.state,
        providerFinalChunks: fakeState?.finalChunks ?? null,
        eventTypes: events.map((event) => event?.type ?? null),
        streamedEventCount,
      });
      throw error;
    }
    return {
      providerCapabilities,
      evidence: {
        gatewayOnly,
        streaming,
        toolResultIterations: toolIterations,
        sessionHistory: true,
        structuredFinal,
      },
      receiptSigningSecret: signingSecret,
      integrationEvidence: {
        mcp: {
          toolName: fakeState?.mcpToolName ?? "evimed_term_normalize",
          advertisedTools: fakeState?.advertisedTools ?? [],
          result: evidence.mcpResult,
        },
        artifact: {
          path: artifactRelativePath,
          content: artifactContent,
        },
        history: {
          mcpToolCompleted: evidence.mcpToolCompleted,
          writeToolCompleted: evidence.writeToolCompleted,
          structuredFinal,
        },
        telemetry: {
          gatewayRequests: gateway.state.requests,
          gatewaySseResponses: gateway.state.sseResponses,
          providerRequests: fakeState?.requests ?? null,
          providerAuthorized: fakeState?.authorized ?? null,
          openCodeStreamedEvents: streamedEventCount,
          completedToolCalls: toolIterations,
        },
      },
    };
  } finally {
    await manager?.closeAll().catch(() => {});
    await gateway?.close().catch(() => {});
    await fakeProvider?.close().catch(() => {});
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

/** @param {Record<string, any>} options */
export async function runDeepSeekOpenCodeReleaseGate({
  mode = "production",
  repoRoot = defaultRepoRoot,
  opencodeBin = resolveOpenCodeBinary({ repoRoot }),
  keyFile,
  modelGatewaySigningSecretFile,
  receiptPath,
  receiptId,
  sourceRevision = process.env.OPEN_SCIENCE_SOURCE_REVISION,
  configRevision = process.env.OPEN_SCIENCE_DEEPSEEK_CONFIG_REVISION,
  receiptSigningSecret,
  verifyChainEvidence,
  timeoutMs = 180_000,
} = {}) {
  if (!["fake", "production"].includes(mode)) throw failure("deepseek_release_mode_invalid");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 10 * 60_000) {
    throw failure("deepseek_release_timeout_invalid");
  }
  const opencodeVersion = verifyOpenCodeBinary(path.resolve(opencodeBin));
  if (mode === "production" && (!keyFile || !receiptId)) throw failure("deepseek_release_input_missing");
  const chain = await runOpenCodeChain({
    mode,
    repoRoot,
    opencodeBin: path.resolve(opencodeBin),
    keyFile,
    modelGatewaySigningSecretFile,
    receiptSigningSecret,
    timeoutMs,
    sourceRevision,
    configRevision,
  });
  if (verifyChainEvidence) await verifyChainEvidence(chain.integrationEvidence);
  const capabilities = {
    providerBaseline: chain.providerCapabilities.ok === true,
    providerStreaming: chain.providerCapabilities.ok === true,
    providerToolLoop: chain.providerCapabilities.ok === true,
    providerStructuredOutput: chain.providerCapabilities.ok === true,
    ...chain.evidence,
  };
  const unsignedReceipt = {
    schemaVersion: 1,
    id: mode === "production" ? receiptId : `dsrg_${randomBytes(12).toString("hex")}`,
    mode,
    productionEligible: mode === "production",
    createdAt: new Date().toISOString(),
    opencodeVersion,
    model: REQUIRED_MODEL,
    sourceRevision: safeRevision(sourceRevision, mode === "fake" ? "fake-source" : ""),
    configRevision: safeRevision(configRevision, mode === "fake" ? "fake-config" : ""),
    capabilities,
  };
  const receipt = signDeepSeekReleaseReceipt(unsignedReceipt, { signingSecret: chain.receiptSigningSecret });
  validateDeepSeekReleaseReceipt(receipt, {
    requireProduction: mode === "production",
    signingSecret: chain.receiptSigningSecret,
  });
  await writeReceipt(receiptPath, receipt);
  return receipt;
}

async function main() {
  try {
    const mode = process.argv.includes("--fake") ? "fake" : "production";
    const receipt = await runDeepSeekOpenCodeReleaseGate({
      mode,
      opencodeBin: resolveOpenCodeBinary(),
      keyFile: process.env.OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE,
      modelGatewaySigningSecretFile: process.env.OPEN_SCIENCE_MODEL_GATEWAY_SIGNING_SECRET_FILE,
      receiptPath: process.env.OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_FILE,
      receiptId: process.env.OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_ID,
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
