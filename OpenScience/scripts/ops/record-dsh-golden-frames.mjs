#!/usr/bin/env node
/**
 * Records the golden wire fixture from a live kernel.
 *
 * Why this exists as a script rather than a procedure someone follows. The
 * fixture it writes is the only evidence that our decoders still understand
 * what the kernel sends, and it is worth exactly as much as its provenance:
 * a hand-authored frame once certified the wrong shape and defeated an audit.
 * The recording had been done by hand each time, which meant the next person
 * had to reconstruct it from a prose `procedure` field — and a procedure
 * nobody can re-run is how a fixture drifts from the wire it claims.
 *
 * It records through the control plane's own client (`DshMux`,
 * `callRuntimeUnary`, the browser-session cookie), not a second
 * implementation. That matters: what the fixture must prove is that *our*
 * client sees what it expects, so a recorder with its own socket code would be
 * certifying the wrong thing.
 *
 * Usage, from a machine that can reach a running kernel:
 *   node scripts/ops/record-dsh-golden-frames.mjs \
 *     --url http://127.0.0.1:45011 --cwd /work --out /tmp/golden-frames.json \
 *     --prompt "…"
 *
 * The prompt matters. A single-agent turn leaves `subagent/descriptor`
 * unrecorded, and that type is what the run tree in the UI is built from — the
 * previous recording left exactly that hole. The default prompt delegates.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import process from "node:process";

import { DshMux, callRuntimeUnary } from "../../apps/server/src/dshMux.mjs";

/** @param {string[]} argv @returns {Record<string,string>} */
function parseArgs(argv) {
  /** @type {Record<string,string>} */
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq > 0) out[token.slice(2, eq)] = token.slice(eq + 1);
    else { out[token.slice(2)] = argv[index + 1] ?? ""; index += 1; }
  }
  return out;
}

const DEFAULT_PROMPT = [
  "Delegate one short task to a subagent and then summarise its answer in one sentence.",
  "The task: reply with the single word OK.",
].join(" ");

/**
 * Collects every item a stream yields until the run settles.
 * @param {DshMux} mux @param {string} endpoint @param {Record<string,any>} args
 * @param {AbortSignal} signal @param {any[]} sink
 */
async function drain(mux, endpoint, args, signal, sink) {
  try {
    for await (const value of mux.open(endpoint, args, { signal })) sink.push(value);
  } catch (error) {
    // A cancelled stream is how this recorder ends; anything else is worth
    // seeing rather than swallowing, because an empty stream and a stream that
    // failed on frame one look identical in the fixture.
    if (!signal.aborted) sink.push({ $streamError: String(/** @type {any} */ (error)?.message ?? error) });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || "http://127.0.0.1:45011";
  const cwd = args.cwd || "/work";
  const out = args.out || "/tmp/golden-frames.json";
  const prompt = args.prompt || DEFAULT_PROMPT;
  const settleMs = Number(args.settleMs || 240_000);
  const runtime = { url, cookie: args.cookie || null, authority: args.authority || null, socketPath: null };

  const controller = new AbortController();
  const { signal } = controller;

  const version = await callRuntimeUnary(runtime, "host/describe", {}, { signal });
  if (!version.ok) throw new Error(`host/describe failed: ${JSON.stringify(version.error)}`);

  const mux = new DshMux(runtime);
  await mux.connect({ signal });

  /** @type {any[]} */ const events = [];
  /** @type {any[]} */ const workspace = [];
  /** @type {any[]} */ const session = [];
  const streams = [
    drain(mux, "$events", {}, signal, events),
    drain(mux, "workspace/follow", { request: { cwd } }, signal, workspace),
  ];

  /** @type {any[]} */ const unary = [];
  /** @param {string} method @param {Record<string,any>} payload */
  const call = async (method, payload) => {
    const result = await callRuntimeUnary(runtime, method, payload, { signal });
    unary.push({ kind: "unary", method, status: result.ok ? 200 : 500, request: { args: payload }, response: result });
    if (!result.ok) throw new Error(`${method} failed: ${JSON.stringify(result.error)}`);
    return result.value;
  };

  const created = await call("session/create", { request: { cwd } });
  const sessionId = created?.sessionId;
  if (!sessionId) throw new Error(`session/create returned no sessionId: ${JSON.stringify(created)}`);
  streams.push(drain(mux, "session/follow", { request: { address: { kind: "session", sessionId } } }, signal, session));

  await call("session/prompt", {
    request: { requestId: randomUUID(), sessionId, mode: "queue", content: [{ type: "text", text: prompt }] },
  });

  // The turn is done when the session stream says so. Polling history would
  // race the stream and record a shorter turn than the one that ran.
  const deadline = Date.now() + settleMs;
  const ended = () => session.some((item) => item?.event?.type === "turn/end" || item?.type === "turn/end");
  while (!ended() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1000));
  const settled = ended();

  const history = await call("session/page", { request: { address: { kind: "session", sessionId }, maxMessages: 200 } });

  controller.abort();
  mux.close();
  await Promise.allSettled(streams);

  const types = [...new Set(session.map((item) => item?.event?.type ?? item?.type).filter(Boolean))].sort();
  const document = {
    $comment: "Verbatim frames from one live run. Re-record with scripts/ops/record-dsh-golden-frames.mjs; never hand-author.",
    dsh: args.pin || "",
    $recorded: {
      procedure: `Recorded by scripts/ops/record-dsh-golden-frames.mjs against ${url}: host/describe, /api/remote.mux, subscribed $events + workspace/follow + session/follow, session/create, one session/prompt, and let a real turn run to ${settled ? "completion" : "the settle deadline"}. Prompt: ${JSON.stringify(prompt)}.`,
      turnSettled: settled,
      eventTypesSeen: types,
    },
    muxPath: "/api/remote.mux",
    muxTransport: "websocket",
    unary,
    history: Array.isArray(history?.records) ? history.records : history,
    session,
    events,
    workspace,
  };
  await writeFile(out, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`wrote ${out}`);
  console.log(`  unary ${unary.length} | session ${session.length} | events ${events.length} | workspace ${workspace.length}`);
  console.log(`  turn settled: ${settled}`);
  console.log(`  session event types: ${types.join(", ") || "(none)"}`);
  if (!types.includes("subagent/descriptor")) {
    console.log("  WARNING: no subagent/descriptor frame — the run tree stays unproven. Use a prompt that delegates.");
    process.exitCode = 2;
  }
}

await main();
