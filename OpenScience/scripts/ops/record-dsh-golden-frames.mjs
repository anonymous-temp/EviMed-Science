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
 * The default prompt delegates, and against a live 0.1.2-alpha.5 kernel that
 * was not enough: the child ran and `subagent/descriptor` still never reached
 * the parent session stream. The child was announced on the host `$events` stream instead
 * (`api-session/added` carrying `parentSessionId` and `origin: "subagent"`).
 * Whatever the answer is, it is not "use a prompt that delegates" — see the
 * debt register in packages/contracts/dsh/contract.test.mjs.
 *
 * NOT YET A DROP-IN REPLACEMENT for the committed fixture. The contract tests
 * also read `mux` (the first raw server frame on each logical stream),
 * `streamIds`, and `errors`, and this records none of them: `mux.open()` yields
 * decoded values, so capturing the raw frames means reaching one level below
 * it. Until that lands, this produces evidence, not a fixture — and installing
 * a fixture missing four sections would mean editing the tests that read them,
 * which is the shape of weakening a check to make it pass.
 */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { writeFile } from "node:fs/promises";
import process from "node:process";

import { DshMux } from "../../apps/server/src/dshMux.mjs";

/**
 * One unary call, in the envelope the control plane sends.
 *
 * Not imported from `dshEventPump`, which owns the production version: that
 * module reaches `runtimeManager` for unix-socket transport and shared
 * timeouts, and pulling four thousand lines of runtime lifecycle into a
 * recorder that dials a TCP port would make this script un-runnable inside the
 * image it records. The envelope is duplicated; the streams — the part the
 * fixture actually certifies — still arrive through the real `DshMux`.
 * @param {{ url: string, cookie?: string|null, authority?: string|null }} runtime
 * @param {string} method @param {Record<string, any>} payload
 * @returns {Promise<{ ok: boolean, value?: any, error?: any, status: number }>}
 */
async function callRuntimeUnary(runtime, method, payload) {
  const target = new URL(`${runtime.url}/api/${method}`);
  const body = Buffer.from(JSON.stringify({
    type: "client-request", rpcId: `rec-${method}`, method, payload: { args: payload ?? {} },
  }), "utf8");
  // `node:http`, not `fetch`. `Host` is a forbidden header name in undici, so
  // fetch drops it silently and the request arrives claiming the socket's own
  // address — which does not match `--trusted-host`, and the browser-session
  // cookie is keyed by the authority it was minted for, so the kernel answers
  // 401 and nothing says why. The production client uses `node:http` for the
  // same reason; this is not a place to differ from it.
  return await new Promise((resolve, reject) => {
    const request = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(body.byteLength),
        ...(runtime.cookie ? { cookie: runtime.cookie } : {}),
        ...(runtime.authority ? { host: runtime.authority } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          resolve({ ok: false, status, error: { code: `http_${status}`, message: text.slice(0, 400) } });
          return;
        }
        try {
          const result = JSON.parse(text)?.result ?? {};
          resolve({ ok: Boolean(result.ok), status, value: result.value, error: result.error });
        } catch (error) {
          reject(new Error(`${method} answered ${status} with a body that is not JSON: ${text.slice(0, 200)}`));
        }
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

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

  // `session/list`, because it is in the seam manifest's `wire.unary` and
  // `host/describe` is not — that name was invented here and the kernel
  // answered 404, which is the right answer to a route nobody publishes. The
  // reachability probe has to use a method the manifest actually lists, or it
  // proves the wrong thing when it fails.
  // `_request`, not `request`: the listing endpoints take an underscore-prefixed
  // empty descriptor, which is what `DshRuntimeAdapter` passes and what the
  // gateway names when it is missing.
  const reachable = await callRuntimeUnary(runtime, "session/list", { _request: {} });
  if (!reachable.ok) throw new Error(`session/list failed: ${JSON.stringify(reachable.error)}`);

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
    const result = await callRuntimeUnary(runtime, method, payload);
    unary.push({ kind: "unary", method, status: result.status, request: { args: payload }, response: result });
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

  // `throughSeq` is required by the descriptor, not optional as a first reading
  // of `DshRuntimeAdapter` suggests — without it the gateway refuses the whole
  // `request` field at the boundary. The highest sequence the session stream
  // actually delivered is the honest value: asking for a page beyond what was
  // observed would record a history this run never saw.
  const throughSeq = session.reduce((high, item) => Math.max(high, Number(item?.seq ?? item?.event?.seq ?? 0) || 0), 0);
  const history = await call("session/page", {
    request: { address: { kind: "session", sessionId }, throughSeq, maxMessages: 200 },
  });

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
