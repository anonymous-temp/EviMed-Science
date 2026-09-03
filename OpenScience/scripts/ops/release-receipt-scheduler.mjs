#!/usr/bin/env node
/**
 * Keeps the DeepSeek release receipt fresh without anyone watching.
 *
 * The receipt is an HMAC-signed attestation that the model gateway ran a live
 * probe — it certifies the model that actually answers, not the one named in
 * source. That is why it expires in 24 hours, and the window is not the defect.
 * The defect is that nothing renewed it, so `/api/ready` went red every day and
 * stayed red, and an alarm that is always red is one everybody learns to skip.
 * The production stack has been failing readiness on
 * `deepseek_release_receipt_stale` for exactly this reason.
 *
 * Deliberately the same shape as `backup-scheduler.mjs`: `run` loops and mints,
 * `health` is what a container healthcheck calls, and a JSON state file records
 * the last attempt, the last success and the consecutive failures. A second
 * scheduling idiom would be a second thing to learn and a second thing to get
 * wrong.
 *
 * Minting is `deepseek-kernel-release-gate.mjs` — one command, already the
 * one an operator runs by hand — so this adds a cadence, not a second way to
 * produce receipts.
 *
 *   node scripts/ops/release-receipt-scheduler.mjs run
 *   node scripts/ops/release-receipt-scheduler.mjs health
 *   node scripts/ops/release-receipt-scheduler.mjs once
 */

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const gateScript = path.join(scriptDir, "deepseek-kernel-release-gate.mjs");
const outputLimit = 64 * 1024;
let activeChild = null;
let stopping = false;

/** @param {string} name @param {number} fallback @param {{ min?: number, max?: number }} bounds */
function integerEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

function loadConfig() {
  const stateFile = path.resolve(
    process.env.OPEN_SCIENCE_RECEIPT_STATE_FILE ?? "/var/lib/open-science/release-receipt-state.json",
  );
  return {
    stateFile,
    // Half the receipt's own 24h life. Renewing at the deadline means one slow
    // probe is an outage; renewing at half means a failure has a whole cycle to
    // retry in before anything downstream notices.
    intervalSeconds: integerEnv("OPEN_SCIENCE_RECEIPT_INTERVAL_SECONDS", 43_200, { min: 300, max: 86_400 }),
    retrySeconds: integerEnv("OPEN_SCIENCE_RECEIPT_RETRY_SECONDS", 900, { min: 30, max: 86_400 }),
    // The healthcheck must not go red the moment a renewal is due — only when
    // the receipt itself is close to unusable. One interval of slack, then the
    // remaining life of the receipt.
    healthGraceSeconds: integerEnv("OPEN_SCIENCE_RECEIPT_HEALTH_GRACE_SECONDS", 64_800, { min: 600, max: 604_800 }),
    maxFailures: integerEnv("OPEN_SCIENCE_RECEIPT_MAX_FAILURES", 3, { min: 1, max: 100 }),
  };
}

/** @param {string} event @param {Record<string, unknown>} fields @param {boolean} [toStderr] */
function log(event, fields, toStderr = false) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`;
  if (toStderr) process.stderr.write(line);
  else process.stdout.write(line);
}

/** Never let a provider error carry a key or a URL into the state file or a log. */
function operationalError(value) {
  return String(value ?? "")
    .replace(/[A-Za-z0-9_-]{20,}/g, "<redacted>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .slice(0, 400);
}

/**
 * The gate's own error code, kept out of the redactor.
 *
 * The codes are a closed vocabulary of snake_case names and every one of them
 * is longer than twenty characters, so the sanitiser above — which exists to
 * stop a provider key reaching a log — ate the single field that says what went
 * wrong. Eight consecutive failures were recorded as
 * `{"ok":false,"code":"<redacted>"}`, which is a log line that costs a reader
 * everything and protects nothing: it is a name from a list in this repository.
 *
 * Extracted before sanitising, and only when it matches the shape a code has.
 * @param {string} text @returns {string | null}
 */
function gateErrorCode(text) {
  const match = String(text ?? "").match(/"code"\s*:\s*"([a-z][a-z0-9_]{2,80})"/);
  return match ? match[1] : null;
}

/** @param {string} file */
async function readState(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {string} file @param {Record<string, unknown>} value */
async function writeState(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, file);
}

/** @param {string[]} args @returns {Promise<string>} */
function runGate(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gateScript, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { if (out.length < outputLimit) out += chunk; });
    child.stderr.on("data", (chunk) => { if (err.length < outputLimit) err += chunk; });
    child.on("error", (error) => { activeChild = null; reject(error); });
    child.on("close", (code) => {
      activeChild = null;
      if (code === 0) resolve(out);
      else reject(new Error(`release gate exited ${code}: ${err.trim().slice(0, 400) || out.trim().slice(0, 400)}`));
    });
  });
}

async function mintOnce(config) {
  const previous = await readState(config.stateFile);
  const attemptAt = new Date().toISOString();
  try {
    await runGate([]);
    const state = {
      schemaVersion: 1,
      status: "healthy",
      lastAttemptAt: attemptAt,
      lastSuccessAt: new Date().toISOString(),
      successfulMints: (Number.isSafeInteger(previous?.successfulMints) ? previous.successfulMints : 0) + 1,
      consecutiveFailures: 0,
    };
    await writeState(config.stateFile, state);
    log("receipt.minted", { successfulMints: state.successfulMints });
    return state;
  } catch (error) {
    const state = {
      schemaVersion: 1,
      status: "failed",
      lastAttemptAt: attemptAt,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      successfulMints: Number.isSafeInteger(previous?.successfulMints) ? previous.successfulMints : 0,
      consecutiveFailures: (Number.isSafeInteger(previous?.consecutiveFailures) ? previous.consecutiveFailures : 0) + 1,
      error: operationalError(error instanceof Error ? error.message : error),
      // Beside the sanitised text, never inside it.
      ...(gateErrorCode(error instanceof Error ? error.message : String(error ?? ""))
        ? { code: gateErrorCode(error instanceof Error ? error.message : String(error ?? "")) }
        : {}),
    };
    await writeState(config.stateFile, state);
    log("receipt.failed", { consecutiveFailures: state.consecutiveFailures, error: state.error }, true);
    return state;
  }
}

/**
 * Health is about the receipt's remaining life, not about the last attempt.
 *
 * A failed renewal with twenty hours of receipt left is a warning; the same
 * failure with one hour left is an outage. Reporting both as "failed" is how a
 * red light stops meaning anything.
 */
async function health() {
  const config = loadConfig();
  const state = await readState(config.stateFile);
  if (!state?.lastSuccessAt) {
    log("receipt.health", { status: "unknown", reason: "no receipt has been minted from this state file" }, true);
    process.exit(1);
  }
  const ageSeconds = (Date.now() - Date.parse(String(state.lastSuccessAt))) / 1000;
  const fresh = Number.isFinite(ageSeconds) && ageSeconds < config.healthGraceSeconds;
  log("receipt.health", {
    status: fresh ? "healthy" : "stale",
    ageSeconds: Math.round(ageSeconds),
    graceSeconds: config.healthGraceSeconds,
    consecutiveFailures: state.consecutiveFailures ?? 0,
  }, !fresh);
  process.exit(fresh ? 0 : 1);
}

async function run() {
  const config = loadConfig();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      stopping = true;
      activeChild?.kill(signal);
    });
  }
  log("receipt.scheduler.start", { intervalSeconds: config.intervalSeconds, stateFile: config.stateFile });
  while (!stopping) {
    const state = await mintOnce(config);
    if (stopping) break;
    const failures = Number(state.consecutiveFailures ?? 0);
    if (failures >= config.maxFailures) {
      log("receipt.scheduler.giving_up", { consecutiveFailures: failures }, true);
      process.exit(1);
    }
    const waitSeconds = state.status === "healthy" ? config.intervalSeconds : config.retrySeconds;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, waitSeconds * 1000);
      if (typeof timer.unref === "function") timer.unref();
      const poll = setInterval(() => { if (stopping) { clearInterval(poll); clearTimeout(timer); resolve(undefined); } }, 500);
      if (typeof poll.unref === "function") poll.unref();
    });
  }
  log("receipt.scheduler.stopped", {});
}

const command = process.argv[2] ?? "run";
if (command === "health") await health();
else if (command === "once") await mintOnce(loadConfig());
else if (command === "run") await run();
else {
  process.stderr.write("Usage: release-receipt-scheduler.mjs run|once|health\n");
  process.exit(2);
}
