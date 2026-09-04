// Which stream types exist, which are published, and which the browser can
// hear — three sets that are supposed to be one.
//
// EventSource delivers a named event only to a listener registered for that
// exact name. A frame type the browser has not registered is not mishandled;
// it never arrives, and the page shows nothing while the wire is busy. That is
// indistinguishable, from the user's side, from a run that is doing nothing.
//
// The F0 acceptance on 2026-08-31 read a real run's wire and found the three
// sets disagree in a way that is currently harmless and will not stay that way:
// the publisher declared nine types, the browser listened for seven, and three
// declared types had no publisher anywhere in the server.
//
// F1 closed two of those three gaps and this test is what records which:
//   - `deliverable/update` now has a publisher (`agentRuns.mjs` — the run's own
//     plan index on the monitor cycle, plus the receipt's entries on both
//     finish paths), so it is no longer on the unpublished list;
//   - `approval/requested` and `question/requested` now have browser listeners
//     and a panel, so `unheard` is empty — but still no publisher, because
//     nothing forwards the kernel's `waterfall` frames (`dshEventPump` calls
//     `watchHost` without an `onEvent`, and there is no route that accepts a
//     reply). That half is not written; it is not faked either.
//
// So this pins all three sets. It blocks nothing; it makes the next change to
// any of them a decision rather than an assumption.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RUN_STREAM_EVENT_TYPES } from "../src/runEventStream.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The browser's registered listeners, read from its own source. */
async function browserFrameTypes() {
  const source = await readFile(path.join(repoRoot, "apps/web/src/lib/runStream.ts"), "utf8");
  const block = /export const RUN_STREAM_FRAME_TYPES = \[([\s\S]*?)\]/.exec(source);
  assert.ok(block, "RUN_STREAM_FRAME_TYPES not found — this test cannot conclude anything");
  const types = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(types.length >= 5, `parsed only ${types.length} frame types; the parse, not the code, is wrong`);
  return types;
}

// Declared but unpublished. One remains, and it is one half of a pair:
//
//   approval/requested, question/requested — the browser now registers both and
//     renders the request (`components/run/RunInteractionPrompt.tsx`), because
//     a hosted deployment runs `approval: never` (auto-refuse) while a LOCAL
//     profile runs `approval: ask` — so the kernel really can ask. What is
//     still missing is the server half: `DshRuntimeAdapter.watchHost` surfaces
//     the kernel's `waterfall` frames to its caller, `dshEventPump` passes no
//     `onEvent`, and no route accepts the `$events/result` reply. Until that
//     lands the card says so in the page rather than offering a button that
//     cannot work.
//
// `deliverable/update` left this list in F1: `agentRuns.mjs` publishes one per
// planned deliverable whenever the run's own plan index moves, and one carrying
// the receipt entry on each finish path, before the terminal `run/state` that
// makes a watching tab close its stream.
const DECLARED_WITHOUT_PUBLISHER = ["approval/requested", "question/requested"];

test("every declared type has a listener, so none of them is published into a void", async () => {
  const browser = await browserFrameTypes();
  const extra = browser.filter((type) => !RUN_STREAM_EVENT_TYPES.includes(type));
  assert.deepEqual(extra, [], "the browser listens for types the publisher does not declare");

  const unheard = RUN_STREAM_EVENT_TYPES.filter((type) => !browser.includes(type)).sort();
  assert.deepEqual(
    unheard,
    [],
    "a declared type the browser cannot hear never arrives and shows nothing while the wire is busy; "
    + "register its listener before publishing it",
  );
});

test("a type with no publisher is named, not assumed to work", async () => {
  const sources = await Promise.all(
    ["runEventStream.mjs", "server.mjs", "agentRuns.mjs", "dshEventPump.mjs", "runtimeManager.mjs"]
      .map(async (name) => [name, await readFile(path.join(repoRoot, "apps/server/src", name), "utf8")]),
  );
  const declaration = /export const RUN_STREAM_EVENT_TYPES = Object\.freeze\(\[[\s\S]*?\]\)/;

  const unpublished = [];
  for (const type of RUN_STREAM_EVENT_TYPES) {
    // A publisher passes the type as a literal argument, whether directly or
    // through the projection callback. Searching outside the declaration is
    // what separates "listed" from "sent".
    const published = sources.some(([, body]) => body.replace(declaration, "").includes(`"${type}"`));
    if (!published) unpublished.push(type);
  }
  assert.deepEqual(
    unpublished.sort(),
    DECLARED_WITHOUT_PUBLISHER,
    "the set of declared-but-never-sent stream types changed; if you wired a publisher, "
    + "check the browser registers a listener for it first",
  );
});

// The scan above proves a type has *a* literal somewhere. That is the right
// check for "nothing sends this", and the wrong one for "this is actually
// wired": a type named in a comment would satisfy it. So the one publisher F1
// added is asserted where it is called, not merely where it is spelled.
test("the deliverable publisher is called, not just mentioned", async () => {
  const source = await readFile(path.join(repoRoot, "apps/server/src/agentRuns.mjs"), "utf8");
  assert.match(
    source,
    /this\.onRunProjection\(project, run, "deliverable\/update", frame\)/,
    "deliverable/update must be handed to the same forwarder evidence and budget use",
  );
  // Three call sites, and each is a different moment the browser needs: the
  // monitor cycle (a verdict during a repair), and both finish paths (the
  // receipt, ahead of the terminal state that closes the client's stream).
  const calls = [...source.matchAll(/this\.publishDeliverables\(/g)].length;
  assert.ok(calls >= 3, `publishDeliverables is called ${calls} times; the live path, the durable path and the monitor each need one`);
});

// Routing attribution, checked where it is actually written. The regex net
// catching a request after the model declined to answer looks identical, in the
// ledger, to the net catching one after the model said "no specialist fits" —
// and only the first means the model never got a vote.
test("the regex net says when it caught a request the model never judged", async () => {
  const source = await readFile(path.join(repoRoot, "apps/server/src/server.mjs"), "utf8");
  assert.match(
    source,
    /routedSpecialist = net && classifierTrace\.failure/,
    "a net match after a classifier failure must be distinguishable from one after a clean verdict",
  );
  assert.match(source, /\$\{net\.reason\}\(classifier:\$\{classifierTrace\.failure\}\)/);
  // And the answer-line fallback keeps its own attribution.
  assert.match(source, /`unrouted:open-domain\(classifier:\$\{classifierTrace\.failure\}\)`/);
});
