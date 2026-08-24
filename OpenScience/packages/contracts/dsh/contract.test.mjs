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

  const call = golden.history.find((entry) => entry.event.type === "tool/call");
  assert.deepEqual(toArgs(call.event.data.arguments), { query: "metformin lactic acidosis" });

  const assistant = golden.history.find((entry) => entry.event.type === "assistant/message");
  assert.deepEqual(toUsage(assistant.event.data.usage), { input: 1000, output: 42, cacheHit: 900, cacheMiss: 100 });

  const outcome = toToolOutcome({ content: [{ type: "text", text: "12 results" }] });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.text, "12 results");

  const ref = toSessionRef({ id: "s-1", header: { cwd: "/workspace", origin: "subagent", parentSession: "s-0" } });
  assert.equal(ref.subagent, true);

  const exec = toToolCall({ callId: "c", name: "bash", arguments: "{}", signal: AbortSignal.timeout(10), agent: { id: "a", session: { id: "s", header: { cwd: "/w" } } } });
  assert.equal(exec.cwd, "/w");
});

test("the event vocabulary the manifest lists is the one the frames use", async () => {
  const golden = JSON.parse(await readFile(new URL("../../../apps/server/test/fixtures/dsh/golden-frames.json", import.meta.url), "utf8"));
  const known = new Set(SEAMS.sessionEventTypes);
  const seen = new Set(golden.history.map((entry) => entry.event.type));
  for (const type of ["turn/end", "tool/call", "tool/result", "assistant/message", "user/message", "subagent/descriptor"]) {
    assert.ok(known.has(type), `${type} fell out of the manifest`);
    assert.ok(seen.has(type), `${type} is no longer exercised by the golden frames`);
  }
  for (const kind of ["completed", "aborted", "blocked", "error", "max-tokens", "interrupted"]) {
    assert.ok(SEAMS.turnEndKinds.includes(kind), `turn-end kind ${kind} fell out of the manifest`);
  }
});

test("the wire split covers every published method exactly once", () => {
  const all = [...SEAMS.wire.unary, ...SEAMS.wire.denied];
  assert.equal(new Set(all).size, all.length, "a method is listed twice");
  assert.equal(all.length, 52, "the harness publishes 52 unary methods; the split must account for all of them");
  for (const method of SEAMS.wire.unary) {
    assert.ok(!/^(settings|credentials|workspace|goal|llm)\./.test(method), `${method} must not be reachable from the control plane`);
  }
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
