// The registry cutoff of the pinned kernel is computed from the closure, never typed.
//
// 2026-10-14: the rule written beside the pin was "the CLI's publish instant plus one hour". For 0.2.0-rc.2 it gave
// ETARGET: a subpackage (`dsh-client-ui-settings-account`) was re-published an hour and twenty minutes after the CLI, so
// the cutoff fenced out a member of the very closure it exists to fence. The cutoff is a property of the closure.
//
// The fixture is a recording of the registry's publish times for the 278 `@deepseek-ai/dsh*` packages the pin resolved
// to (`node scripts/ops/kernel-install.mjs cutoff --record <file>`), so the computation is replayed here without a
// network, and the committed cutoff is held equal to what the recording computes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CUTOFF_MARGIN_MS, closureFromLock, computePublishedBefore, cutoffFor, cutoffVerdict, kernelInstallArgs, publishTime, withPublishedBefore,
} from "../kernel-install.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const pinsText = readFileSync(path.join(repoRoot, "deps-version.json"), "utf8");
const pins = JSON.parse(pinsText);
const recordingFile = path.join(here, "fixtures", `kernel-closure-times-${pins.dsh.version}.json`);
/** @returns {any} */
const recording = () => JSON.parse(readFileSync(recordingFile, "utf8"));

test("the committed cutoff is the one the recorded closure computes, and every member is inside it", () => {
  // No recording for the pin is the failure: moving the pin means recording the closure it resolved to.
  const fixture = recording();
  assert.equal(fixture.root.version, pins.dsh.version, "the recording is of another version than the pin");
  const computed = cutoffFor(fixture.members);
  assert.equal(computed.publishedBefore, fixture.expected.publishedBefore, "the recording and its own expectation disagree");
  assert.deepEqual(cutoffVerdict(pins, computed.publishedBefore), { ok: true, recorded: pins.dsh.publishedBefore, computed: computed.publishedBefore });
  const cutoff = Date.parse(pins.dsh.publishedBefore);
  for (const member of fixture.members) assert.ok(Date.parse(member.time) <= cutoff, `${member.name}@${member.version} was published after the cutoff`);
  assert.equal(Date.parse(computed.latest.time) + CUTOFF_MARGIN_MS, cutoff, "the cutoff is the latest member plus the margin and nothing else");
  // The pin and its closure agree on what the closure is.
  assert.ok(fixture.members.every((member) => member.version === pins.dsh.version), "a kernel package resolved to a version that is not the pin");
});

test("the rule this replaced, the CLI's instant plus an hour, fences a member out", () => {
  // The finding the computation exists for, kept as a failing example of the old rule rather than as a story.
  const fixture = recording();
  const oldRule = Date.parse(fixture.root.time) + 3_600_000;
  const straggler = fixture.members.find((member) => Date.parse(member.time) > oldRule);
  if (pins.dsh.version === "0.2.0-rc.2") assert.equal(straggler?.name, "@deepseek-ai/dsh-client-ui-settings-account");
  // For another pin the property still reads: the computed cutoff is never earlier than the old rule's when a straggler exists.
  if (straggler) assert.ok(Date.parse(cutoffFor(fixture.members).publishedBefore) > oldRule);
});

test("a cutoff is refused where the resolution is not credible", () => {
  const members = recording().members;
  assert.throws(() => cutoffFor(members.slice(0, 10)), /fence nothing/);
  assert.throws(() => cutoffFor([]), /fence nothing/);
  assert.throws(() => cutoffFor([...members.slice(0, 60), { name: "@deepseek-ai/dsh-x", version: "1.0.0", time: "not a time" }]), /no publish time/);
  // An explicit floor is for tests of the arithmetic only.
  assert.equal(cutoffFor([{ name: "a", version: "1", time: "2026-01-01T00:00:00.000Z" }, { name: "b", version: "1", time: "2026-01-01T00:10:00.000Z" }], { minimumMembers: 2 }).publishedBefore, "2026-01-01T00:11:00.000Z");
});

test("a lock file's kernel members are read from every nesting, once each", () => {
  const lock = {
    packages: {
      "": { name: "scratch" },
      "node_modules/@deepseek-ai/dsh": { version: "0.2.0-rc.2" },
      "node_modules/@deepseek-ai/dsh-agent": { version: "0.2.0-rc.2" },
      "node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session": { version: "0.2.0-rc.2" },
      "node_modules/@deepseek-ai/cordis": { version: "4.0.4" },
      "node_modules/js-yaml": { version: "4.3.2" },
      "node_modules/other/node_modules/@deepseek-ai/dsh-agent": { version: "0.2.0-rc.2" },
    },
  };
  assert.deepEqual(closureFromLock(lock), [
    { name: "@deepseek-ai/dsh", version: "0.2.0-rc.2" },
    { name: "@deepseek-ai/dsh-agent", version: "0.2.0-rc.2" },
    { name: "@deepseek-ai/dsh-session", version: "0.2.0-rc.2" },
  ]);
  assert.deepEqual(closureFromLock({}), []);
});

test("the whole computation, replayed against the recorded registry, lands on the recorded cutoff", async () => {
  const fixture = recording();
  const times = new Map(fixture.members.map((member) => [member.name, { [member.version]: member.time }]));
  const requested = [];
  const fetchImpl = async (url) => {
    const name = decodeURIComponent(String(url).replace(`${fixture.registry}/`, ""));
    requested.push(name);
    const time = times.get(name);
    return time ? new Response(JSON.stringify({ name, time }), { status: 200 }) : new Response("{}", { status: 404 });
  };
  /** @type {string[][]} */
  const npmCalls = [];
  const npm = (args) => {
    npmCalls.push(args);
    // npm's own resolution is replaced by the recording's member list, written where `--package-lock-only` writes it.
    const dir = args[args.indexOf("--prefix") + 1];
    mkdirSync(dir, { recursive: true });
    const packages = Object.fromEntries(fixture.members.map((member) => [`node_modules/${member.name}`, { version: member.version }]));
    writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ packages }));
  };
  const computed = await computePublishedBefore({ version: fixture.root.version, registry: fixture.registry, fetchImpl, npm, concurrency: 4 });
  assert.equal(computed.publishedBefore, fixture.expected.publishedBefore);
  assert.equal(computed.members, fixture.members.length);
  assert.equal(npmCalls.length, 1);
  // Nothing is laid down, no script runs, and the resolution is bounded by a window past the CLI, not by the answer it is looking for.
  assert.ok(npmCalls[0].includes("--package-lock-only") && npmCalls[0].includes("--ignore-scripts"));
  assert.ok(npmCalls[0].includes(`--before=${computed.window}`));
  assert.ok(Date.parse(computed.window) > Date.parse(fixture.expected.latest.time));
  assert.equal(requested.filter((name) => name === "@deepseek-ai/dsh").length, 2, "the root once for its own time and once as a member");
  // A registry document without the version's time is a failure, not a missing member.
  await assert.rejects(publishTime(fixture.registry, "@deepseek-ai/dsh", "9.9.9", async () => new Response(JSON.stringify({ time: {} }))), /no publish time/);
  await assert.rejects(publishTime(fixture.registry, "@deepseek-ai/dsh", "1.0.0", async () => new Response("", { status: 503 })), /503/);
});

test("writing the cutoff changes that one value and no other byte", () => {
  const updated = withPublishedBefore(pinsText, "2026-12-31T23:59:59.999Z");
  assert.equal(JSON.parse(updated).dsh.publishedBefore, "2026-12-31T23:59:59.999Z");
  const before = pinsText.split("\n"), after = updated.split("\n");
  assert.equal(after.length, before.length);
  assert.deepEqual(after.map((line, index) => [line, before[index]]).filter(([a, b]) => a !== b).length, 1);
  assert.throws(() => withPublishedBefore(pinsText, "tomorrow"), /not an instant/);
  assert.throws(() => withPublishedBefore('{"dsh":{}}', "2026-12-31T23:59:59.999Z"), /exactly one/);
  assert.throws(() => withPublishedBefore('{"a":{"publishedBefore":"x"},"b":{"publishedBefore":"y"}}', "2026-12-31T23:59:59.999Z"), /exactly one/);
});

test("the install arguments carry the committed cutoff, and the scripts only when a kernel is to be run", () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "kernel-install-test-"));
  try {
    const audit = kernelInstallArgs(pins, scratch);
    assert.ok(audit.includes("--ignore-scripts"));
    assert.ok(audit.includes(`--before=${pins.dsh.publishedBefore}`));
    assert.ok(audit.includes(`${pins.dsh.npmPackage}@${pins.dsh.version}`));
    const running = kernelInstallArgs(pins, scratch, { scripts: true });
    assert.ok(!running.includes("--ignore-scripts"));
    assert.ok(running.includes(`--before=${pins.dsh.publishedBefore}`));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
