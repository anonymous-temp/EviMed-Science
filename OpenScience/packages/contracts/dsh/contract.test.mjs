/**
 * The DSH pin's contract test.
 *
 * Hidden knowledge: what has to be true of an installed harness before its pin
 * may move. DSH states plainly that it makes no compatibility promises before
 * its first tagged release and will "rename or repackage freely"; eleven days
 * produced ten npm versions, and rc.8 changed a storage format with no
 * migration path.
 *
 * The response is not to hope. It is to name every contact point in
 * `seam-manifest.json` and assert each one against the version actually
 * installed, so an upgrade PR starts from "this seam moved" rather than from a
 * search. A failure here means the pin may not move yet; it does not mean the
 * design is wrong.
 *
 * Two kinds of assertion, and the second is the one that matters. Names are
 * cheap to check and easy to keep passing while the shapes underneath change —
 * the wire protocol carries no version field at all — so the golden frames
 * replayed through the port's conversion functions are the real check.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

import { SEAMS, toArgs, toSessionRef, toToolCall, toToolOutcome, toTurnEnd, toUsage } from "@evimed/harness-port";

import { wireSplitIssues } from "./wireSplit.mjs";

const require = createRequire(import.meta.url);
const depsVersions = JSON.parse(await readFile(new URL("../../../deps-version.json", import.meta.url), "utf8"));

/** @param {string} specifier @returns {any | null} */
function resolveInstalled(specifier) {
  try {
    return require(`${specifier}/package.json`);
  } catch {
    return null;
  }
}

test("the pin is defined once, and every derived copy equals it", async () => {
  assert.equal(SEAMS.dsh, depsVersions.dsh.version, "seam-manifest.dsh drifted from deps-version.json");
  assert.equal(SEAMS.cordis, depsVersions.dsh.cordis, "seam-manifest.cordis drifted from deps-version.json");

  const port = JSON.parse(await readFile(new URL("../../harness-port/package.json", import.meta.url), "utf8"));
  assert.equal(port.peerDependencies["@deepseek-ai/cordis"], depsVersions.dsh.cordis, "the port's peer range drifted");

  const dockerfile = await readFile(new URL("../../../deploy/runtime-dsh/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, new RegExp(`ARG DSH_VERSION=${depsVersions.dsh.version.replace(/\./g, "\\.")}\\b`), "the image ARG drifted");
  assert.match(dockerfile, new RegExp(`ARG DSH_CORDIS_VERSION=${depsVersions.dsh.cordis.replace(/\./g, "\\.")}\\b`));
});

test("an upgrade may not skip the peer range, so a mismatched bundle refuses to load", async () => {
  // The community precedent this follows: a downstream plugin that declares its
  // harness range refuses to load when the host moves past it, which is a loud
  // failure at start instead of a silent one at the first renamed seam.
  const socket = JSON.parse(await readFile(new URL("../../socket/package.json", import.meta.url), "utf8"));
  assert.equal(socket.peerDependencies["@deepseek-ai/cordis"], depsVersions.dsh.cordis);
  assert.ok(socket.dsh?.bundle?.patch, "the bundle must declare its patch file or the host will not apply it");
});

test("every package the manifest names is classified, and none is a private subpath", () => {
  const roles = new Set(["peer", "dependency", "config-row", "types-only", "re-exported"]);
  for (const [name, role] of Object.entries(SEAMS.packages)) {
    assert.ok(roles.has(role), `${name} has an unknown role "${role}"`);
    assert.ok(name.startsWith("@deepseek-ai/"), `${name} is not a harness package`);
    assert.ok(!name.includes("/src/"), `${name} reaches into a private subpath`);
    assert.ok(!name.includes("experimental"), `${name} is unreleased and carries no stability promise`);
    assert.ok(!name.includes("test-support"), `${name} declares lower compatibility expectations`);
  }
});

test("the installed harness matches the pin, when one is installed", { skip: !resolveInstalled("@deepseek-ai/cordis") }, () => {
  // A checkout without a harness installed still runs every other assertion in
  // this file; only this one needs the real thing.
  const cordis = resolveInstalled("@deepseek-ai/cordis");
  assert.equal(cordis.version, depsVersions.dsh.cordis);
});

test("the port's conversions still produce the port's shapes, replayed from golden frames", async () => {
  const golden = JSON.parse(await readFile(new URL("../../../apps/server/test/fixtures/dsh/golden-frames.json", import.meta.url), "utf8"));
  assert.equal(golden.dsh, SEAMS.dsh, "the golden frames were recorded against a different version than the pin");

  // Method names surviving an upgrade proves nothing about frame shapes: the
  // protocol has no version field, and its own documentation says client and
  // host ship together. Replaying the frames is the only check that does.
  const turnEnd = golden.history.find((entry) => entry.event.type === "turn/end");
  assert.deepEqual(toTurnEnd(turnEnd.event), { kind: "completed" });

  // The expectations below are read off the recording, never the other way
  // round. This block used to expect a literature search — `{query: "metformin
  // lactic acidosis"}` — because the 0.1.1 frames were partly hand-authored.
  // The 0.1.2 frames were captured from a live kernel driving one real turn,
  // and that turn wrote a file. Editing the fixture to say "search" again is
  // the exact move that once certified a shape the kernel never emits, so the
  // test comes to the recording.
  const call = golden.history.find((entry) => entry.event.type === "tool/call");
  assert.equal(call.event.data.name, "write");
  assert.deepEqual(toArgs(call.event.data.arguments), {
    file_path: "/tmp/dsh-probe/home-rec/work/recorded.txt",
    content: "recorded",
  });

  // Both assistant messages, because the property worth pinning is the cache
  // split, and one message alone cannot show it. Step 1 read nothing from
  // cache; step 2 read 8064 tokens from it. If `cacheReadTokens` is ever again
  // not the name the converter reads, the second line goes to zero — which is
  // how the counters were silently wrong before: the totals looked right and
  // only the split was missing.
  const assistants = golden.history.filter((entry) => entry.event.type === "assistant/message");
  assert.equal(assistants.length, 2, "the recorded turn had two assistant messages");
  assert.deepEqual(toUsage(assistants[0].event.data.usage), { input: 8052, output: 73, cacheHit: 0, cacheMiss: 0 });
  assert.deepEqual(toUsage(assistants[1].event.data.usage), { input: 105, output: 2, cacheHit: 8064, cacheMiss: 0 });

  // Replayed from the recorded `tool/result`, not from a hand-made envelope.
  // The live kernel nests the payload one level below where the old fixture put
  // it: the block under `message.content[]` is what the converter is handed.
  const result = golden.history.find((entry) => entry.event.type === "tool/result");
  const outcome = toToolOutcome(result.event.data.message.content[0]);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.text, "<path>/tmp/dsh-probe/home-rec/work/recorded.txt</path>\n<type>file</type>\n<content>\nCreated file\n</content>");
  assert.equal(outcome.error, null);

  // The last two take in-process DSH objects rather than wire frames — a
  // `Session` and a `ToolExecution` never cross the wire — so there is no frame
  // to replay them from and they are constructed here. They are labelled as
  // such so nobody reads them as recorded evidence.
  const ref = toSessionRef({ id: "s-1", header: { cwd: "/workspace", origin: "subagent", parentSession: "s-0" } });
  assert.equal(ref.subagent, true);

  const exec = toToolCall({ callId: "c", name: "bash", arguments: "{}", signal: AbortSignal.timeout(10), agent: { id: "a", session: { id: "s", header: { cwd: "/w" } } } });
  assert.equal(exec.cwd, "/w");
});

/**
 * Session-event types the run transcript is built out of. Every one of them has
 * to be in the manifest's vocabulary, and every one of them ought to be
 * exercised by a live recording.
 */
const SESSION_EVENTS_THE_TRANSCRIPT_IS_BUILT_FROM = Object.freeze([
  "turn/end",
  "tool/call",
  "tool/result",
  "assistant/message",
  "user/message",
  "subagent/descriptor",
]);

/**
 * THE ONE DECLARED PLACE for a type the golden recording does not exercise.
 *
 * This list is a debt register, not a permission slip. The assertion below
 * compares it for exact equality against the real gap, in both directions: a
 * type that falls out of the recording fails because it is not listed here, and
 * a listed type that a re-recording covers fails because the entry went stale.
 * Emptying this array is the goal state.
 *
 * The alternative considered and rejected: hand-authoring a
 * `subagent/descriptor` frame into the recorded sections. A fabricated fixture
 * has already cost this codebase once — it certified a shape the kernel never
 * emits and defeated the audit it existed to be — so a declared hole is
 * strictly better than an undeclared lie.
 */
const NOT_EXERCISED_BY_THE_RECORDING = Object.freeze([
  Object.freeze({
    type: "subagent/descriptor",
    why: "the 2026-09-01 re-recording drove one short single-agent turn and never spawned a subagent, so no live frame carries this type.",
    costs: "the run tree the UI draws is built from these descriptors (dshRuntimeAdapter maps them to subagents[] and to subagent/started), and no recorded frame proves the port still decodes the shape the kernel sends.",
    coveredOnlyBy: "golden-frames.json `synthesized`, which declares of itself that it was not recorded, plus a unit test in apps/server/test/dshEventPump.test.mjs written against that same synthetic shape. Neither is wire certification.",
    clearedBy: "a re-recording whose prompt delegates to a subagent; then delete this entry, or the assertion below fails on a stale exception.",
  }),
]);

test("the event vocabulary the manifest lists is the one the frames use", async (t) => {
  const golden = JSON.parse(await readFile(new URL("../../../apps/server/test/fixtures/dsh/golden-frames.json", import.meta.url), "utf8"));
  const known = new Set(SEAMS.sessionEventTypes);

  // Only the sections the fixture claims came off a live kernel. `synthesized`
  // is excluded on purpose: it says of itself that it was not recorded, and
  // counting it here would turn a declared gap into invisible green — which is
  // the whole reason the fixture separates the two.
  assert.ok(golden.history.length > 0 && golden.session.length > 0, "the recording's live sections are empty, so nothing below walked anything");
  const exercised = new Set();
  for (const entry of golden.history) exercised.add(entry.event.type);
  for (const item of golden.session) {
    if (item.type === "event") exercised.add(item.event.type);
    for (const record of item.records ?? []) exercised.add(record.event?.type);
  }

  for (const type of SESSION_EVENTS_THE_TRANSCRIPT_IS_BUILT_FROM) {
    assert.ok(known.has(type), `${type} fell out of the manifest`);
  }

  // Declared versus exercised, with the gap named rather than assumed away.
  const gap = SESSION_EVENTS_THE_TRANSCRIPT_IS_BUILT_FROM.filter((type) => !exercised.has(type));
  assert.deepEqual(
    gap,
    NOT_EXERCISED_BY_THE_RECORDING.map((entry) => entry.type),
    "the set of types no live frame exercises changed; update NOT_EXERCISED_BY_THE_RECORDING (adding an entry is taking on debt, removing one is paying it off)",
  );

  for (const entry of NOT_EXERCISED_BY_THE_RECORDING) {
    // The declared hole must still have *some* coverage, and that coverage must
    // still be honest about not being a recording. If `synthesized` ever stops
    // declaring itself, or stops carrying the shape, this type has nothing at
    // all behind it and the test says so.
    assert.match(golden.synthesized.$recorded, /NOT recorded/i, "the synthesized section stopped declaring that it is not a recording");
    const inSynthesized = [
      ...golden.synthesized.history,
      ...golden.synthesized.session,
    ].some((item) => (item.event?.type ?? item.type) === entry.type);
    assert.ok(inSynthesized, `${entry.type} is neither recorded nor declared under synthesized — it now has no coverage at all`);
    t.diagnostic(`known-uncovered by the golden recording: ${entry.type} — ${entry.why} Cost: ${entry.costs} Cleared by: ${entry.clearedBy}`);
  }

  for (const kind of ["completed", "aborted", "blocked", "error", "max-tokens", "interrupted"]) {
    assert.ok(SEAMS.turnEndKinds.includes(kind), `turn-end kind ${kind} fell out of the manifest`);
  }
});

test("the wire split is well-formed, and the recorded calls agree with it", async () => {
  // The invariants themselves live in `./wireSplit.mjs` and nowhere else. They
  // used to be written out twice — here and in the port's own suite — and both
  // copies asserted "the harness publishes 52 unary methods; the split must
  // account for all of them". 0.1.2 deleted ApiProxy, so that count lost its
  // subject; the port's copy retired it on 2026-09-01 and this one stayed red
  // restating it. Sharing the implementation is what stops a third divergence:
  // see the module header for what replaced the count and why 50 was not it.
  assert.deepEqual(wireSplitIssues(SEAMS), [], "the wire split moved");

  // This package's own share of the check, which the port's suite cannot make:
  // the split describes what the control plane may call, so the recorded calls
  // from the pinned kernel have to fall inside it and carry the argument names
  // the manifest declares. A method name surviving a rename proves nothing; a
  // recorded request does.
  const golden = JSON.parse(await readFile(new URL("../../../apps/server/test/fixtures/dsh/golden-frames.json", import.meta.url), "utf8"));
  assert.ok(golden.unary.length > 0, "the recording captured no unary call at all");
  for (const call of golden.unary) {
    assert.ok(SEAMS.wire.unary.includes(call.method), `${call.method} was called for real but is not in the allowed half`);
    assert.deepEqual(Object.keys(call.request.args), SEAMS.wire.unaryArgs[call.method], `${call.method}'s recorded descriptor names different arguments than the manifest`);
    assert.equal(call.response.type, SEAMS.wire.serverEnvelope.type);
    assert.deepEqual(Object.keys(call.response.result).sort(), ["ok", ...(call.response.result.ok ? ["value"] : ["error"])].sort());
  }
  assert.equal(golden.muxPath, SEAMS.wire.mux, "the recording opened a different mux path than the manifest names");
  assert.equal(golden.muxTransport, SEAMS.wire.downlinkTransport);
});

test("the pnpm the runtime image installs is the one the DSH pin decides", async () => {
  // `dsh plugin` shells out to pnpm, and which pnpm is a DSH requirement rather
  // than a workspace preference: pnpm 9 cannot add into the workspace root that
  // DSH writes for a profile. Keeping the value beside the DSH pin is what stops
  // the two from being reasoned about separately again.
  const pins = JSON.parse(await readFile(new URL("../../../deps-version.json", import.meta.url), "utf8"));
  const dockerfile = await readFile(new URL("../../../deploy/runtime-dsh/Dockerfile", import.meta.url), "utf8");
  const compose = await readFile(new URL("../../../deploy/web/docker-compose.yml", import.meta.url), "utf8");
  assert.match(pins.dsh.pnpm, /^\d+\.\d+\.\d+$/);
  assert.equal(dockerfile.match(/^ARG PNPM_VERSION=(\S+)/m)?.[1], pins.dsh.pnpm);
  assert.equal(compose.match(/PNPM_VERSION: \$\{OPEN_SCIENCE_PNPM_VERSION:-(\S+?)\}/)?.[1], pins.dsh.pnpm);
});
