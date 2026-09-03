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
 * Four sections need more than the decoded stream `mux.open()` yields, and each
 * is recorded rather than described:
 *
 *   `mux`        the first RAW server frame on each logical stream. `open()`
 *                hands out `frame.value`, so the frames are taken one level
 *                below it, off the emitter the socket decodes onto.
 *   `streamIds`  which minted id carried which logical stream. Not guessable:
 *                `open()` mints privately, so each stream is started alone and
 *                the id is the listener that appeared.
 *   `errors`     three refusals, provoked on purpose against the live kernel —
 *                a malformed `session/page`, a follow on a session that does
 *                not exist, and an endpoint the Gateway does not export.
 *   `synthesized` NOT recorded, and carried forward from the previous fixture
 *                with its own provenance line intact. It is the one section a
 *                hand-written frame may live in; re-authoring it here would
 *                launder it into something that looks recorded.
 */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
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
 * @returns {Promise<{ ok: boolean, value?: any, error?: any, status: number, envelope?: any }>}
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
          // The envelope is kept whole, not just our decode of it: the wire
          // split is checked against `{type, rpcId, result}`, and a fixture
          // holding only `{ok, value}` records what this client made of the
          // answer rather than what the kernel sent.
          const envelope = JSON.parse(text);
          const result = envelope?.result ?? {};
          resolve({ ok: Boolean(result.ok), status, value: result.value, error: result.error, envelope });
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

/**
 * One prompt, doing two jobs, because one recording has to serve both.
 *
 * The file write is what puts a real `tool/call` and its paired `tool/result`
 * into the session stream — the decoder's main subject. The delegation is what
 * puts a child session's whole lifecycle onto the host `$events` stream, which
 * is where alpha.5 announces subagents (`api-session/added` carrying
 * `parentSessionId`) now that `subagent/descriptor` never reaches the parent.
 * Recording them separately would mean two fixtures that no run ever produced
 * together.
 */
const DEFAULT_PROMPT = [
  "Create a file named recorded.txt containing exactly the word: recorded.",
  "Then delegate one short task to a subagent: reply with the single word OK.",
  "Then reply with only the word done.",
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

/**
 * Every raw server frame, keyed by the stream it arrived on.
 *
 * `DshMux` decodes each text frame and emits it under its `streamId`; `open()`
 * then hands the caller `frame.value` only. Wrapping the emitter is what makes
 * the envelope — `item` / `error` / `end`, and the stream id itself — visible
 * without a second socket implementation, which is the one thing this recorder
 * must not have.
 *
 * @param {DshMux} mux
 * @returns {Map<string, any[]>}
 */
function captureRawFrames(mux) {
  /** @type {Map<string, any[]>} */
  const byStream = new Map();
  const emit = mux.frames.emit.bind(mux.frames);
  mux.frames.emit = /** @type {any} */ ((event, ...rest) => {
    if (typeof event === "string" && event !== "mux:closed") {
      const seen = byStream.get(event);
      if (seen) seen.push(rest[0]);
      else byStream.set(event, [rest[0]]);
    }
    return emit(event, ...rest);
  });
  return byStream;
}

/**
 * Starts one logical stream and reports which id the mux minted for it.
 *
 * The id is private to `open()`, so it is read as the listener that appeared:
 * the generator registers `frames.on(streamId, …)` on its first resumption, and
 * one stream is started at a time so the difference names exactly one.
 *
 * @param {DshMux} mux @param {string} endpoint @param {Record<string,any>} args
 * @param {AbortSignal} signal @param {any[]} sink
 * @returns {Promise<{ task: Promise<void>, streamId: string }>}
 */
async function openTracked(mux, endpoint, args, signal, sink) {
  const before = new Set(mux.frames.eventNames().map(String));
  const task = drain(mux, endpoint, args, signal, sink);
  // One turn of the event loop: enough for the async generator to run to its
  // first suspension, which is where the listener is registered.
  await new Promise((resolve) => setImmediate(resolve));
  const added = mux.frames.eventNames().map(String).filter((name) => !before.has(name) && name !== "mux:closed");
  if (added.length !== 1) {
    throw new Error(`${endpoint}: expected exactly one new stream listener, saw ${JSON.stringify(added)}`);
  }
  return { task, streamId: added[0] };
}

/**
 * Provokes one refusal and returns the kernel's own words for it.
 *
 * Recorded rather than written down: three of the five error entries in the
 * fixture are what the decoder is checked against, and an error message someone
 * typed from memory is the same defect as a hand-authored frame.
 *
 * @param {DshMux} mux @param {Map<string, any[]>} raw @param {string} endpoint
 * @param {Record<string,any>} args @param {AbortSignal} signal
 * @returns {Promise<Record<string, any> | null>}
 */
async function provokeStreamError(mux, raw, endpoint, args, signal) {
  /** @type {any[]} */
  const sink = [];
  const { task, streamId } = await openTracked(mux, endpoint, args, signal, sink);
  await task;
  const frame = (raw.get(streamId) ?? []).find((item) => item?.type === "error");
  return frame?.error ?? null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || "http://127.0.0.1:45011";
  const cwd = args.cwd || "/work";
  const out = args.out || "/tmp/golden-frames.json";
  const prompt = args.prompt || DEFAULT_PROMPT;
  const settleMs = Number(args.settleMs || 240_000);
  const pin = args.pin || "";
  if (!pin) throw new Error("--pin is required: the fixture names the kernel it was taken from, and a fixture that cannot say which is not evidence.");
  // The one section that is not recorded travels forward from the fixture being
  // replaced, with its own provenance line. Re-authoring it here would turn a
  // section that says "NOT recorded" into one that looks recorded.
  const carryFrom = args.carryFrom || new URL("../../apps/server/test/fixtures/dsh/golden-frames.json", import.meta.url).pathname;
  const previous = JSON.parse(await readFile(carryFrom, "utf8"));
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
  const raw = captureRawFrames(mux);

  /** @type {any[]} */ const events = [];
  /** @type {any[]} */ const workspace = [];
  /** @type {any[]} */ const session = [];
  /** @type {Record<string, string>} */ const streamIds = {};
  /** @type {Promise<void>[]} */ const streams = [];

  // One at a time, because that is what makes the minted id attributable.
  const eventStream = await openTracked(mux, "$events", {}, signal, events);
  streamIds.events = eventStream.streamId;
  streams.push(eventStream.task);
  // No `request`. It took one through 0.1.2-alpha.3 and alpha.5's descriptor
  // refuses the whole call with `gateway/arguments-invalid: unexpected
  // "request"` — found by this recorder, on this stream, which is what the
  // fixture is for. The mock accepted the old spelling either way, so nothing
  // in the test suite could have found it.
  const workspaceStream = await openTracked(mux, "workspace/follow", {}, signal, workspace);
  streamIds.workspace = workspaceStream.streamId;
  streams.push(workspaceStream.task);

  /** @type {any[]} */ const unary = [];
  /** @param {string} method @param {Record<string,any>} payload */
  const call = async (method, payload) => {
    const result = await callRuntimeUnary(runtime, method, payload);
    unary.push({ kind: "unary", method, status: result.status, request: { args: payload }, response: result.envelope });
    if (!result.ok) throw new Error(`${method} failed: ${JSON.stringify(result.error)}`);
    return result.value;
  };

  const created = await call("session/create", { request: { cwd } });
  const sessionId = created?.sessionId;
  if (!sessionId) throw new Error(`session/create returned no sessionId: ${JSON.stringify(created)}`);
  const sessionStream = await openTracked(
    mux,
    "session/follow",
    { request: { address: { kind: "session", sessionId } } },
    signal,
    session,
  );
  streamIds.session = sessionStream.streamId;
  streams.push(sessionStream.task);

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

  /* --------------------------------------------------------- the refusals */
  // Provoked after the run, so a refusal cannot disturb the turn being recorded.
  const malformedPage = await callRuntimeUnary(runtime, "session/page", { request: {} });
  const notFound = await provokeStreamError(
    mux,
    raw,
    "session/follow",
    { request: { address: { kind: "session", sessionId: "nope" } } },
    signal,
  );
  const noSuchEndpoint = await provokeStreamError(mux, raw, "no/such-endpoint", {}, signal);
  /** @type {Record<string, any>[]} */
  const errors = [];
  const recordError = (line, wire) => {
    if (wire?.code) errors.push({ $recorded: line, ...wire });
  };
  recordError("verbatim: the live session/page refusal when `request` was sent without its required fields", malformedPage.error);
  recordError("verbatim: the live /api/remote.mux `error` frame for session/follow on a session that does not exist", notFound);
  recordError("verbatim: the live /api/remote.mux `error` frame for an endpoint the Gateway does not export", noSuchEndpoint);
  // Carried forward, and only the entries that say in their own body that they
  // were not observed. A previously-verbatim entry is not re-labelled: it either
  // came off this wire or it did not.
  for (const entry of Array.isArray(previous.errors) ? previous.errors : []) {
    if (!String(entry?.$recorded ?? "").startsWith("verbatim")) errors.push(entry);
  }
  if (errors.filter((entry) => String(entry.$recorded).startsWith("verbatim")).length !== 3) {
    throw new Error(`expected three provoked refusals, recorded ${JSON.stringify(errors.map((e) => e.code))}`);
  }

  controller.abort();
  mux.close();
  await Promise.allSettled(streams);

  // The first raw frame on each logical stream, which is what the decoder is
  // checked against. Taken from the capture rather than reconstructed from the
  // decoded values: the envelope is the part under test.
  const muxFrames = Object.values(streamIds)
    .map((streamId) => (raw.get(streamId) ?? [])[0])
    .filter(Boolean);

  const types = [...new Set(session.map((item) => item?.event?.type ?? item?.type).filter(Boolean))].sort();
  const today = new Date().toISOString().slice(0, 10);
  const document = {
    $comment: "Verbatim frames from one live run. Re-record with scripts/ops/record-dsh-golden-frames.mjs; never hand-author.",
    dsh: pin,
    $recorded: {
      procedure: `Booted @deepseek-ai/dsh@${pin} and recorded by scripts/ops/record-dsh-golden-frames.mjs against ${url}: authenticated with a control-plane-minted browser-session cookie, opened /api/remote.mux, subscribed $events + workspace/follow + session/follow, created a session, sent one session/prompt, and let a real turn run to ${settled ? "completion" : "the settle deadline"}, then paged its history. Prompt: ${JSON.stringify(prompt)}.`,
      unary: `verbatim request/response pairs from that run, POST /api/<endpoint> (${today})`,
      history: `verbatim \`records\` of the live session/page response for that run (${today})`,
      session: `verbatim \`session/follow\` stream items for that run, in arrival order (${today})`,
      events: `verbatim \`$events\` stream items for that run, in arrival order (${today})`,
      workspace: `verbatim \`workspace/follow\` stream items for that run (${today})`,
      mux: `verbatim: the first /api/remote.mux server frame on each of the run's three logical streams, stream ids as recorded (${today})`,
      errors: "each entry carries its own $recorded line; three were provoked against this kernel on this run, the rest are carried forward from the previous fixture unchanged",
      synthesized: previous.$recorded?.synthesized ?? "NOT recorded.",
      turnSettled: settled,
      eventTypesSeen: types,
    },
    muxPath: "/api/remote.mux",
    muxTransport: "websocket",
    streamIds,
    unary,
    history: Array.isArray(history?.records) ? history.records : history,
    session,
    events,
    workspace,
    mux: muxFrames,
    errors,
    synthesized: previous.synthesized,
  };
  await writeFile(out, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`wrote ${out}`);
  console.log(`  unary ${unary.length} | session ${session.length} | events ${events.length} | workspace ${workspace.length} | mux ${muxFrames.length} | errors ${errors.length}`);
  console.log(`  turn settled: ${settled}`);
  console.log(`  stream ids: ${JSON.stringify(streamIds)}`);
  console.log(`  session event types: ${types.join(", ") || "(none)"}`);
  if (!types.includes("subagent/descriptor")) {
    console.log("  NOTE: no subagent/descriptor frame. Against alpha.5 this is expected — see the header.");
  }
}

await main();
