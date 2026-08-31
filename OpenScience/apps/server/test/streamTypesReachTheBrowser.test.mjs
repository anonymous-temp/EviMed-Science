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
// the publisher declares nine types, the browser listens for seven, and three
// declared types have no publisher anywhere in the server.
//
// So this pins all three. It blocks nothing; it makes the next change to any
// of them a decision rather than an assumption.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RUN_STREAM_EVENT_TYPES } from "../src/runEventStream.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The browser's registered listeners, read from its own source. */
async function browserFrameTypes() {
  const source = await readFile(path.join(repoRoot, "apps/desktop/src/lib/runStream.ts"), "utf8");
  const block = /export const RUN_STREAM_FRAME_TYPES = \[([\s\S]*?)\]/.exec(source);
  assert.ok(block, "RUN_STREAM_FRAME_TYPES not found — this test cannot conclude anything");
  const types = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(types.length >= 5, `parsed only ${types.length} frame types; the parse, not the code, is wrong`);
  return types;
}

// Declared but unpublished. Each is a promise the stream makes and does not
// keep, and each has a different reason:
//
//   deliverable/update — the browser HAS the listener, the fold case and the
//     `deliverables` array, and server.mjs's own comment names "the second
//     deliverable came back with three fixes" as the motivating example. No
//     code sends one, so that panel is empty on every run.
//   approval/requested, question/requested — reserved for the F2 phase. The
//     runtime context already tells every run "Approval policy: ask … without
//     an available answerer, the request fails closed", so the kernel can ask;
//     there is simply no channel to the user yet.
const DECLARED_WITHOUT_PUBLISHER = ["approval/requested", "deliverable/update", "question/requested"];

test("the browser listens for everything except the reserved types", async () => {
  const browser = await browserFrameTypes();
  const extra = browser.filter((type) => !RUN_STREAM_EVENT_TYPES.includes(type));
  assert.deepEqual(extra, [], "the browser listens for types the publisher does not declare");

  const unheard = RUN_STREAM_EVENT_TYPES.filter((type) => !browser.includes(type)).sort();
  assert.deepEqual(
    unheard,
    ["approval/requested", "question/requested"],
    "a declared type the browser cannot hear must be one of the two reserved for F2; "
    + "publishing any other without registering its listener sends it into a void",
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
