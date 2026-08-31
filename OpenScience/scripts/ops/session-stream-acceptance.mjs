#!/usr/bin/env node
/**
 * F0 acceptance: the session page's stream, proven on one real run.
 *
 * The session layer was rewritten to consume `RunEvent` instead of a kernel's
 * own message-part shapes, so the browser would stop knowing which kernel it
 * was talking to. Its unit tests replay hand-written frames, which proves the
 * decoder and proves nothing about the publisher — and the publisher is the
 * half that changed when the kernel did.
 *
 * So this drives a real research question through a real DSH kernel and reads
 * the wire. Everything it checks is a property the page depends on and cannot
 * check for itself:
 *
 *   - both unions are closed and exhausted. `unknown` is not a failure by
 *     construction — it exists so an undecoded variant is counted and shown
 *     rather than dropped — but on a real run every `unknown` is an event the
 *     DSH pump could not decode, so they are reported BY rawType and count.
 *     A page that renders "unknown x214" is a page that renders nothing.
 *   - sequence numbers are strictly increasing, because resumption is by our
 *     own counter and a repeated seq silently truncates a reconnecting tab.
 *   - resumption works: the stream is cut mid-run and resumed with `?since=`,
 *     and the second connection must continue where the first stopped.
 *   - the stream carried something a reader could follow. A run that emits
 *     state transitions and no content produces a clean report and an empty
 *     page, and those look identical from here unless this is asserted.
 *
 * Frames are recorded to disk as they arrive, off the live wire, because a
 * hand-authored fixture once certified a shape the wire never produced.
 *
 *   OPEN_SCIENCE_E2E_BASE_URL=http://127.0.0.1:18788 \
 *   OPEN_SCIENCE_E2E_USERNAME=... OPEN_SCIENCE_E2E_PASSWORD_FILE=... \
 *   node scripts/ops/session-stream-acceptance.mjs
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { RUN_EVENT_TYPES } from "@evimed/domain";

import { RUN_STREAM_EVENT_TYPES } from "../../apps/server/src/runEventStream.mjs";

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function required(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw failure("session_stream_configuration_missing", `${name} is required.`);
  return value;
}

/** The password arrives as a path, never as a value, and is never printed. */
function secret(name) {
  const inline = String(process.env[name] ?? "").trim();
  if (inline) return inline;
  return readFileSync(required(`${name}_FILE`), "utf8").trim();
}

async function jsonFetch(url, options = {}, expected = null) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { throw failure("session_stream_response_invalid", `${url} returned invalid JSON.`); }
  }
  if (expected == null ? !response.ok : response.status !== expected) {
    const code = body?.code ?? body?.data?.code ?? "unexpected_status";
    throw failure("session_stream_request_failed", `${options.method ?? "GET"} ${new URL(url).pathname} -> ${response.status} (${code})`);
  }
  return { response, body };
}

/**
 * Reads an SSE connection until the run ends or `stopAfter` frames have
 * arrived, appending every frame to `frames`. Returns the last seq seen, which
 * is what a resume needs.
 */
async function readStream(base, runId, headers, frames, { since = 0, stopAfter = null, connection = 1 } = {}) {
  const url = `${base}/api/runs/${encodeURIComponent(runId)}/events${since ? `?since=${since}` : ""}`;
  const response = await fetch(url, { headers: { ...headers, Accept: "text/event-stream" } });
  if (!response.ok || !response.body) {
    throw failure("session_stream_subscribe_failed", `GET ${new URL(url).pathname} -> ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let lastSeq = since;
  let seen = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; anything after the last one
      // is a partial frame and must stay in the buffer.
      const parts = buffered.split("\n\n");
      buffered = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.trim()) continue;
        const frame = { connection };
        for (const line of part.split("\n")) {
          if (line.startsWith("id:")) frame.id = Number(line.slice(3).trim());
          else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
          else if (line.startsWith("data:")) frame.data = line.slice(5).trim();
        }
        if (!frame.event) continue;
        try { frame.parsed = JSON.parse(frame.data ?? "null"); } catch { frame.parsed = null; }
        frames.push(frame);
        seen += 1;
        if (Number.isFinite(frame.id)) lastSeq = frame.id;
        const state = frame.event === "run/state" ? frame.parsed?.state : null;
        if (state && state !== "running" && state !== "queued") return { lastSeq, terminal: state };
        if (stopAfter != null && seen >= stopAfter) return { lastSeq, terminal: null };
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { lastSeq, terminal: null };
}

async function main() {
  // A recording is the same evidence as the wire it came off, so the checks can
  // be sharpened against runs already paid for.
  const replayAt = process.argv.indexOf("--replay");
  if (replayAt >= 0) {
    const file = process.argv[replayAt + 1];
    if (!file) throw failure("session_stream_replay_missing", "--replay needs a recording path.");
    const frames = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const firstConnection = frames.filter((frame) => frame.connection === 1 && Number.isFinite(frame.id));
    const last = frames.filter((frame) => frame.event === "run/state").at(-1);
    console.log(`replaying ${frames.length} frame(s) from ${file}`);
    analyse(frames, {
      cutAt: firstConnection.at(-1)?.id ?? 0,
      terminal: last?.parsed?.state ?? null,
      recording: file,
    });
    return;
  }

  const base = new URL(required("OPEN_SCIENCE_E2E_BASE_URL")).origin;
  const outDir = process.env.OPEN_SCIENCE_E2E_RECORD_DIR
    ?? path.join(process.cwd(), "evals", "session-stream", "recordings");

  const login = await jsonFetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: required("OPEN_SCIENCE_E2E_USERNAME"), password: secret("OPEN_SCIENCE_E2E_PASSWORD") }),
  });
  const auth = {
    Cookie: login.response.headers.get("set-cookie")?.split(";")[0] ?? "",
    "X-Open-Science-CSRF": login.body?.data?.csrfToken ?? "",
  };
  if (!auth.Cookie || !auth["X-Open-Science-CSRF"]) throw failure("session_stream_auth_invalid", "Login returned no session credentials.");

  const marker = randomBytes(6).toString("hex");
  const projectId = `f0-${marker}`;
  await jsonFetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ id: projectId, name: `F0 session-stream acceptance ${marker}` }),
  });
  const scoped = { ...auth, "X-Open-Science-Project": projectId };

  await jsonFetch(`${base}/api/commands/start_runtime`, {
    method: "POST", headers: { "Content-Type": "application/json", ...scoped }, body: "{}",
  });

  // One shape whatever kernel is running — this route is what replaced the
  // browser POSTing straight through to OpenCode.
  const session = await jsonFetch(`${base}/api/runtime/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json", ...scoped }, body: "{}",
  });
  const sessionId = session.body?.data?.id;
  if (!sessionId) throw failure("session_stream_session_invalid", "The control plane returned no session id.");
  if (/^web_mock_/.test(sessionId)) throw failure("session_stream_runtime_not_real", "A mock session id cannot accept this run.");

  await jsonFetch(`${base}/api/research-sessions/${encodeURIComponent(sessionId)}`, {
    method: "PUT", headers: { "Content-Type": "application/json", ...scoped },
    body: JSON.stringify({ mode: "open-domain" }),
  });

  const question = process.env.OPEN_SCIENCE_E2E_QUESTION
    ?? "二甲双胍用于非糖尿病的肥胖成人减重，目前的证据强度如何？请说明主要证据来源与不确定之处。";
  const dispatched = await jsonFetch(`${base}/api/agent-runs/dispatch`, {
    method: "POST", headers: { "Content-Type": "application/json", ...scoped },
    body: JSON.stringify({ sessionId, dispatchId: `f0-${marker}`, text: question }),
  }, 202);
  const runId = dispatched.body?.data?.id;
  if (!runId) throw failure("session_stream_dispatch_invalid", "Dispatch returned no run id.");
  console.log(`run ${runId} dispatched on session ${sessionId}`);

  const frames = [];
  // Cut the first connection deliberately, so resumption is exercised by this
  // acceptance rather than assumed. A tab that reloads mid-run does exactly
  // this, and it is the path no unit test covers.
  const first = await readStream(base, runId, scoped, frames, { stopAfter: 40, connection: 1 });
  const cutAt = first.lastSeq;
  console.log(`first connection: ${frames.length} frame(s), last seq ${cutAt}${first.terminal ? ` (already ${first.terminal})` : ""}`);

  let terminal = first.terminal;
  if (!terminal) {
    const second = await readStream(base, runId, scoped, frames, { since: cutAt, connection: 2 });
    terminal = second.terminal;
    console.log(`resumed at since=${cutAt}: ${frames.filter((f) => f.connection === 2).length} more frame(s), last seq ${second.lastSeq}`);
  }

  mkdirSync(outDir, { recursive: true });
  const recording = path.join(outDir, `${new Date().toISOString().slice(0, 10)}-${marker}.jsonl`);
  writeFileSync(recording, `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`, "utf8");
  analyse(frames, { cutAt, terminal, recording });
}

/**
 * Everything the page depends on, checked against frames. Split out so a
 * recording can be re-checked as the checks grow, without spending another
 * live run to learn what a stricter rule would have said.
 * @param {any[]} frames
 */
function analyse(frames, { cutAt, terminal, recording }) {

  const problems = [];

  // A stream nobody read reports a clean stream.
  if (frames.length < 5) problems.push(`only ${frames.length} frame(s) arrived; there is nothing here to have checked`);

  const envelopeTypes = new Map();
  for (const frame of frames) envelopeTypes.set(frame.event, (envelopeTypes.get(frame.event) ?? 0) + 1);
  for (const [type, count] of envelopeTypes) {
    if (!RUN_STREAM_EVENT_TYPES.includes(type)) {
      problems.push(`the stream published ${count}x "${type}", which is not in RUN_STREAM_EVENT_TYPES — the browser drops it`);
    }
  }

  const innerTypes = new Map();
  const undecoded = new Map();
  const offUnion = new Map();
  for (const frame of frames) {
    if (frame.event !== "run/event") continue;
    // The pump publishes `{ event }`, so the RunEvent rides one level down.
    const type = frame.parsed?.event?.type ?? "(absent)";
    innerTypes.set(type, (innerTypes.get(type) ?? 0) + 1);
    if (type === "unknown") {
      const raw = String(frame.parsed?.event?.rawType ?? "(no rawType)");
      undecoded.set(raw, (undecoded.get(raw) ?? 0) + 1);
    } else if (!RUN_EVENT_TYPES.includes(type)) {
      offUnion.set(type, (offUnion.get(type) ?? 0) + 1);
    }
  }
  for (const [type, count] of offUnion) {
    problems.push(`run/event carried type "${type}" ${count}x, absent from RUN_EVENT_TYPES`);
  }

  // seq must be strictly increasing per connection; a repeat truncates a
  // resuming tab at the wrong place.
  for (const connection of [1, 2]) {
    const seqs = frames.filter((frame) => frame.connection === connection && Number.isFinite(frame.id)).map((frame) => frame.id);
    for (let index = 1; index < seqs.length; index += 1) {
      if (seqs[index] <= seqs[index - 1]) {
        problems.push(`connection ${connection}: seq went ${seqs[index - 1]} -> ${seqs[index]}, not strictly increasing`);
        break;
      }
    }
  }

  const resumed = frames.filter((frame) => frame.connection === 2 && Number.isFinite(frame.id));
  if (resumed.length) {
    const replayed = resumed.filter((frame) => frame.id <= cutAt && frame.event !== "run/state");
    if (replayed.length) problems.push(`resuming at since=${cutAt} replayed ${replayed.length} frame(s) the first connection already had`);
    if (resumed.some((frame) => frame.event === "stream/gap")) {
      problems.push(`resuming at since=${cutAt} reported stream/gap — the buffer had already dropped frames the page needed`);
    }
  }

  // Content, not just lifecycle. A page fed only state transitions renders an
  // empty shell, and the run still "succeeded".
  const assistantText = frames.filter((frame) => frame.event === "run/event"
    && (frame.parsed?.event?.type === "message/assistant" || frame.parsed?.event?.type === "assistant/delta"));
  const toolCalls = frames.filter((frame) => frame.event === "run/event" && frame.parsed?.event?.type === "tool/call");
  if (!assistantText.length) problems.push("no assistant text or delta reached the stream; the session page would render an empty conversation");
  if (!toolCalls.length) problems.push("no tool/call reached the stream; the tool cards the session view exists to show would never appear");

  console.log(`\nterminal state: ${terminal ?? "(never reached)"}`);
  console.log(`frames recorded: ${frames.length} -> ${recording}`);
  console.log("\nenvelope types:");
  for (const [type, count] of [...envelopeTypes].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(4)}  ${type}`);
  console.log("\nrun/event types:");
  for (const [type, count] of [...innerTypes].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(4)}  ${type}`);
  if (undecoded.size) {
    console.log("\nundecoded by the DSH pump (each renders as a blank card):");
    for (const [raw, count] of [...undecoded].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(4)}  ${raw}`);
  }
  const unseen = RUN_EVENT_TYPES.filter((type) => type !== "unknown" && !innerTypes.has(type));
  if (unseen.length) console.log(`\nnot exercised by this run (not a failure, a coverage fact): ${unseen.join(", ")}`);

  if (terminal !== "succeeded") problems.push(`the run ended as ${terminal ?? "no terminal state"}, so the stream was never carried to completion`);

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nF0 acceptance passed: a real run on the DSH kernel, both unions exhausted, resumption clean, content present.");
}

main().catch((error) => {
  console.error(`${error.code ?? "session_stream_failed"}: ${error.message}`);
  process.exitCode = 1;
});
