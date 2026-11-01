// The sandbox probe's reading of what a command through the runner reports.
//
// The sandbox row's `runnerCommand` (deploy/runtime-dsh/evimed-landlock-run.sh) makes the kernel record every command's enforcement as
// `full` without asking the host. The Landlock launcher says on stderr when the host's kernel enforces only part of the ruleset, and the
// kernel's own runner reports that as `partial`; the probe reads the same line, so a profile that requires `full` is still refused by a
// host that does not give it (hosted production requires `full`).
import assert from "node:assert/strict";
import test from "node:test";

import { probeSandbox } from "../index.mjs";

/** @param {{ enforcement?: string, stderr?: string, sandbox?: Record<string, unknown> }} outcome */
function shellThatReports({ enforcement = "full", stderr = "", sandbox = {} }) {
  return {
    resolve: (/** @type {any} */ request) => request,
    execute: async () => ({ result: async () => ({ exitCode: 0, stderr: { text: stderr, truncated: false }, sandbox: { mode: "workspace-write", denied: false, enforcement, ...sandbox } }) }),
  };
}
const ctxOf = (/** @type {any} */ shell) => ({ get: (/** @type {string} */ key) => (key === "shell" ? shell : undefined) });

const PARTIAL = "landlock-run: partial enforcement (older Landlock ABI)\n";

test("a full report with a quiet stderr satisfies a profile that requires full", async () => {
  const outcome = await probeSandbox(ctxOf(shellThatReports({})), "full");
  assert.deepEqual(outcome, { error: null, enforcement: "full" });
});

test("the launcher's partial-enforcement line turns an asserted full into partial, and a profile that requires full refuses it", async () => {
  const strict = await probeSandbox(ctxOf(shellThatReports({ stderr: PARTIAL })), "full");
  assert.equal(strict.enforcement, "partial");
  assert.match(String(strict.error), /sandbox enforcement is "partial", this profile requires "full"/);
  const lenient = await probeSandbox(ctxOf(shellThatReports({ stderr: PARTIAL })), "partial");
  assert.deepEqual(lenient, { error: null, enforcement: "partial" });
});

test("the kernel's own partial report is kept as it is, and only the launcher's exact line counts", async () => {
  assert.equal((await probeSandbox(ctxOf(shellThatReports({ enforcement: "partial" })), "partial")).enforcement, "partial");
  const chatter = await probeSandbox(ctxOf(shellThatReports({ stderr: "note: landlock-run: partial enforcement (older Landlock ABI) was seen once\n" })), "full");
  assert.deepEqual(chatter, { error: null, enforcement: "full" }, "a sentence that merely mentions the line is not the line");
});

test("a runner that could not launch is reported as that, whether the kernel marks the process or refuses the command", async () => {
  const marked = await probeSandbox(ctxOf(shellThatReports({ stderr: "evimed-landlock-run: the Landlock launcher was not found\n", sandbox: { runnerFailed: true } })), "full");
  assert.match(String(marked.error), /sandbox runner failed to launch/);
  // A foreground call whose runner failed closed is a thrown SANDBOX_UNAVAILABLE ("... Runner failure: evimed-landlock-run: ...").
  const refusing = { resolve: (/** @type {any} */ request) => request, execute: async () => { throw new Error('sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Runner failure: evimed-landlock-run: unsupported sandbox profile'); } };
  const refused = await probeSandbox(ctxOf(refusing), "full");
  assert.match(String(refused.error), /sandbox probe failed: .*Runner failure: evimed-landlock-run/);
  assert.equal(refused.enforcement, "none");
});
