#!/usr/bin/env node
/**
 * Probe V-1: can the hosted control plane append a prompt to a running session?
 *
 * The plan recorded this as unknown and gated the evaluation corpus's
 * "late correction" difficulty variant on it. Reading the pinned kernel answers
 * the kernel half — `dsh-api-session-controller`'s `prompt` sends
 * `mode: "steer"` to `agent.steer` and anything else to `agent.followup`, both
 * while the agent is running — but the question is about the *hosted plane*,
 * which has its own admission rules on top. Only a live run settles that, and
 * this is the smallest live run that does.
 *
 * What it does, and why in this order:
 *
 *  1. Log in, take a project, open one research session.
 *  2. Dispatch one prompt and confirm it is running.
 *  3. Dispatch a second prompt **on the same session** while the first is still
 *     running. This is the whole probe. Whatever happens — accepted, refused by
 *     name, or accepted and silently dropped — is the answer, and each is a
 *     different design consequence, so the script reports which rather than
 *     asserting one.
 *  4. Wait for both to settle and report how the second one was delivered:
 *     after the first (queued) or inside it (steered).
 *
 * Costs two short model calls on the cheap tier. It creates nothing durable
 * beyond two runs in the ledger of whichever project it is pointed at, and it
 * never deletes anything: a probe that cleans up after itself can erase the
 * evidence it exists to produce.
 *
 * Usage:
 *   OPEN_SCIENCE_PROBE_PASSWORD_FILE=<file> node scripts/ops/probe-session-append.mjs [--base=<url>] [--insecure]
 */
import { readFile } from "node:fs/promises";

/** @param {string[]} argv @returns {Record<string, string | boolean>} */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (const entry of argv) {
    if (!entry.startsWith("--")) continue;
    const [name, value] = entry.slice(2).split("=");
    args[name] = value === undefined ? true : value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const base = String(args.base ?? process.env.OPEN_SCIENCE_PROBE_BASE_URL ?? "https://82.156.128.153");
const username = String(process.env.OPEN_SCIENCE_PROBE_USERNAME ?? "cdss-access");
if (args.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

/** @type {Record<string, string>} */
let auth = {};

/** @param {string} path @param {any} [init] */
async function api(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...auth, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 400) }; }
  return { status: response.status, body, response };
}

/** @param {string} label @param {any} value */
const say = (label, value) => process.stdout.write(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}\n`);

async function main() {
  const passwordFile = String(process.env.OPEN_SCIENCE_PROBE_PASSWORD_FILE ?? "");
  if (!passwordFile) throw new Error("OPEN_SCIENCE_PROBE_PASSWORD_FILE is required; the probe never takes a password on the command line");
  const password = (await readFile(passwordFile, "utf8")).trim();

  const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
  auth = {
    Cookie: login.response.headers.get("set-cookie")?.split(";")[0] ?? "",
    "X-Open-Science-CSRF": String(login.body?.data?.csrfToken ?? ""),
  };
  say("login", "ok");

  const projects = await api("/api/projects");
  const projectId = projects.body?.data?.[0]?.id ?? "default";
  auth["X-Open-Science-Project"] = projectId;
  say("project", projectId);

  // A session is bound at an id the client chooses, not created by POST: the
  // browser opens a conversation before the server has heard of it.
  const sessionId = `ses_probe_v1_${Date.now().toString(36)}`;
  const session = await api(`/api/research-sessions/${sessionId}`, {
    method: "PUT",
    body: JSON.stringify({ mode: "open-domain" }),
  });
  if (session.status !== 200) throw new Error(`session bind failed: ${session.status} ${JSON.stringify(session.body).slice(0, 300)}`);
  say("session", sessionId);

  const stamp = Date.now().toString(36);
  // Deliberately a question with a little work in it, so the turn is still
  // running when the second prompt arrives; deliberately not a long one,
  // because the probe is about admission, not about the answer.
  const first = await api("/api/agent-runs/dispatch", {
    method: "POST",
    body: JSON.stringify({ sessionId, dispatchId: `probe-v1-a-${stamp}`, text: "用三句话说明阿司匹林的抗血小板作用机制。" }),
  });
  say("first dispatch", { status: first.status, runId: first.body?.data?.id, runStatus: first.body?.data?.status });
  if (first.status !== 202) throw new Error(`first dispatch refused: ${JSON.stringify(first.body).slice(0, 300)}`);

  // The probe. No wait: the point is to arrive while the first turn is live.
  const second = await api("/api/agent-runs/dispatch", {
    method: "POST",
    body: JSON.stringify({ sessionId, dispatchId: `probe-v1-b-${stamp}`, text: "补充一句：请同时说明它与氯吡格雷的机制差别。" }),
  });
  say("second dispatch (while first is running)", {
    status: second.status,
    code: second.body?.code ?? second.body?.error ?? null,
    message: typeof second.body?.message === "string" ? second.body.message.slice(0, 200) : null,
    runId: second.body?.data?.id ?? null,
  });

  const verdict = second.status === 202
    ? "ACCEPTED — the hosted plane admits a prompt on a running session"
    : `REFUSED — ${second.status} ${second.body?.code ?? ""}`.trim();
  say("V-1 verdict", verdict);

  // Settle, and report the order the two turns actually landed in.
  const runIds = [first.body?.data?.id, second.body?.data?.id].filter(Boolean);
  const deadline = Date.now() + Number(process.env.OPEN_SCIENCE_PROBE_TIMEOUT_MS ?? 900_000);
  /** @type {any[]} */
  let settled = [];
  while (Date.now() < deadline) {
    const listed = await api("/api/agent-runs");
    settled = (listed.body?.data ?? []).filter((run) => runIds.includes(run.id));
    if (settled.length === runIds.length && settled.every((run) => run.status !== "running" && run.status !== "queued")) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  for (const run of settled.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
    say("run", { id: run.id, status: run.status, createdAt: run.createdAt, finishedAt: run.finishedAt ?? null, attempts: run.attempts ?? null });
  }
  say("sessionId for follow-up reading", sessionId);
  return 0;
}

main().then((code) => { process.exitCode = code; }, (error) => {
  process.stderr.write(`probe failed: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
