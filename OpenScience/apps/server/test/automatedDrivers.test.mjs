// A driver that starts runs against a deployment says they are the platform checking itself (`automated`), or says in this file why
// it cannot. The account the drivers sign in as is also the account its owner works in, so what a run is flagged is the only thing
// that keeps acceptance traffic from teaching the platform: on 2026-09-26 the two methods production had learnt came from the
// acceptance account's own briefs, and by 2026-10-23 all seventy method documents did (audit 2026-10-23, B 6.2, F break 3).
//
// `learningBackgroundWork.test.mjs` holds every `agent-runs/dispatch` call to the mark. This holds the other ways a script starts a
// run to it as well: a prompt typed into the kernel's own composer (`session/prompt`, which the server cannot flag), a study step run
// through the module's own routes (managed research, which teaches whatever the flag says — owner decision 2026-09-29), and any
// driver that signs in as the acceptance account. Each of those that cannot carry the mark is named below with the reason, so a new
// driver that starts runs and is neither marked nor named fails here instead of teaching from the owner's account.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const openScience = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The ways a script starts a run. */
const STARTS = [
  { name: "the dispatch route", pattern: /agent-runs\/dispatch/ },
  { name: "a native prompt", pattern: /session\/prompt/ },
  { name: "a study step through the module's own routes", pattern: /\$\{root\}\/run\b|\/api\/vcr\/studies\/[^\s`'"]*\/run\b/ },
  { name: "the acceptance account", pattern: /OPEN_SCIENCE_ACCEPTANCE_USERNAME/ },
];

/** What a marked driver says: `automated: true` in the body, or the header the server reads as the same. */
const MARKED = /automated["']?\s*[:=]\s*(?:true|True)|x-evimed-automated/;

/**
 * The drivers that start runs and cannot carry the mark, and why. A name here must still start runs by the way the reason says, or the
 * entry is stale and this fails: the table cannot outlive the thing it excuses.
 */
const CANNOT_BE_MARKED = new Map([
  ["scripts/ops/result-revision-acceptance.mjs", { starts: "a native prompt", why: "It types into the kernel's own composer through a browser, and the control plane learns of a native turn from the kernel's event stream, where no request header exists to read: its runs enter the ledger as ordinary researcher turns of the account it signs in as. Run it on a throwaway account." }],
  ["scripts/ops/record-dsh-golden-frames.mjs", { starts: "a native prompt", why: "It boots a kernel of its own on the loopback and records the wire; there is no control plane, no ledger and no account." }],
  ["scripts/ops/vcr-serving-acceptance.mjs", { starts: "the acceptance account", why: "It runs study steps through the 虚拟临床研究 module, whose runs are managed research: they teach whatever `automated` says (`isResearcherOwnedWork`, owner decision 2026-09-29). Run it on a throwaway account." }],
  ["scripts/vcr/live-acceptance.mjs", { starts: "a study step through the module's own routes", why: "The same: a study's steps are managed research, flagged or not. It takes a cookie of an account the owner names and never a password." }],
  ["evals/general-tasks/runner/cell.mjs", { starts: "the dispatch route", why: "It measures the attended conversation on throwaway accounts of a control plane it starts itself on the loopback (asserted in `learningBackgroundWork.test.mjs`)." }],
  ["evals/memory-policy/run.py", { starts: "the dispatch route", why: "Memory learns only from attended turns, so it speaks as a person, as a throwaway account it registers and deletes (asserted in `learningBackgroundWork.test.mjs`)." }],
]);

/** Every driver-like file under a tree, skipping dependencies, results and a harness's own tests. @param {string} directory @returns {AsyncGenerator<string>} */
async function* files(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (["node_modules", "__pycache__", ".venv", "dist", "reports", "runs", "results", "fixtures", "test", "tests"].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.(?:mjs|js|py|sh)$/.test(entry.name) && !/(?:^test_|\.test\.)/.test(entry.name)) yield full;
  }
}

test("every script that starts a run is marked automated, or named here with the reason it cannot be", async () => {
  /** @type {Map<string, string[]>} */
  const starters = new Map();
  let scanned = 0;
  for (const tree of ["scripts", "evals"]) {
    for await (const file of files(path.join(openScience, tree))) {
      scanned += 1;
      const text = await readFile(file, "utf8");
      const relative = path.relative(openScience, file);
      const found = STARTS.filter((start) => start.pattern.test(text)).map((start) => start.name);
      if (found.length) starters.set(relative, found);
    }
  }
  assert.ok(scanned >= 150, `scanned only ${scanned} files; the walk is wrong, not the tree`);
  assert.ok(starters.size >= 8, `found only ${starters.size} scripts that start runs; the parse is wrong`);
  /** @type {string[]} */
  const unmarked = [];
  for (const [relative] of starters) {
    const text = await readFile(path.join(openScience, relative), "utf8");
    if (MARKED.test(text) || CANNOT_BE_MARKED.has(relative)) continue;
    unmarked.push(relative);
  }
  assert.deepEqual(unmarked, [], "each of these starts runs without the mark `automated: true` (or the x-evimed-automated header): acceptance traffic on the owner's account would teach the platform. Mark it, or name it in CANNOT_BE_MARKED with the reason.");
  for (const [relative, entry] of CANNOT_BE_MARKED) {
    assert.ok(starters.get(relative)?.includes(entry.starts), `${relative} no longer starts runs by ${entry.starts}: the exception is stale`);
    assert.ok(entry.why.length >= 60, `${relative}: an exception states its reason`);
  }
});

test("the marked drivers carry it on the call that starts the run, not only somewhere in the file", async () => {
  // A file that mentions the header in a comment or in one helper and dispatches through another is not marked. The dispatch route's
  // own statements are held by `learningBackgroundWork.test.mjs`; the drivers below build their request through a helper, so the
  // helper's header is read here: it must be the one the server honours.
  for (const driver of ["scripts/ops/evolution-acceptance.mjs", "scripts/ops/evolution-upload-acceptance.mjs", "scripts/ops/evolution-natural-tool-acceptance.mjs", "scripts/ops/evolution-boundary-acceptance.mjs"]) {
    const text = await readFile(path.join(openScience, driver), "utf8");
    assert.match(text, /["']x-evimed-automated["']\s*:\s*["']1["']/, `${driver} sends the header the server reads as automated`);
  }
  const server = await readFile(path.join(openScience, "apps/server/src/server.mjs"), "utf8");
  assert.match(server, /export const AUTOMATED_REQUEST_HEADER = "x-evimed-automated";/);
  assert.match(server, /const automated = body\.automated === true \|\| automatedRequest\(req\);/);
});
