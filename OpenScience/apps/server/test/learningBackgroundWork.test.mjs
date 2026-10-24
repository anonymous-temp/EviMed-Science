// The platform's own work is never a lesson, never the researcher's words and
// never the researcher's usage (audit 2026-09-26, L-G3, L-G9, and the
// platform-tag sweep of M-2).
//
// On 2026-09-26 both methods production had learnt came from the acceptance
// account's own traffic — probes and audits sharing the owner's account — and
// the loop could not tell them from the owner's research. The dispatch route
// already took `automated: true`; this holds every harness in the repository
// to saying it, and gives a driver that cannot change each body a header.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { carriesPlatformContext } from "@evimed/domain";

import { learningRefusal, learningTriggersFor } from "../src/learningTriggers.mjs";
import { AUTOMATED_REQUEST_HEADER, accountOpenUsage, automatedRequest } from "../src/server.mjs";

const openScience = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("a harness marks its dispatches with a header as well as in the body, and an automated run is never a lesson", () => {
  assert.equal(AUTOMATED_REQUEST_HEADER, "x-evimed-automated");
  for (const value of ["1", "true", "TRUE", " true "]) assert.equal(automatedRequest({ headers: { "x-evimed-automated": value } }), true, value);
  assert.equal(automatedRequest({ headers: { "x-evimed-automated": ["1", "0"] } }), true);
  for (const value of ["0", "false", "", undefined, "yes"]) assert.equal(automatedRequest({ headers: { "x-evimed-automated": value } }), false, String(value));
  assert.equal(automatedRequest({}), false);

  // The researcher corrected it: a lesson (what a clean delivery teaches is read when the run is settled, `learningEvidence.mjs`).
  const run = { id: "run_1", status: "succeeded", artifacts: ["deliverables/d1/report.md"], transcript: { completeness: "complete" },
    effectiveAgentId: "meta-analysis", sessionId: "s1", corrections: 1 };
  assert.ok(learningTriggersFor({ run, runs: [run] }).length > 0, "the researcher's run is a lesson");
  assert.equal(learningRefusal({ run, runs: [run] }), null);
  const probed = { ...run, automated: true };
  assert.deepEqual(learningTriggersFor({ run: probed, runs: [probed] }), [], "the same run dispatched by a harness is not");
  assert.equal(learningRefusal({ run: probed, runs: [probed] }), "not_researcher_work", "and a refusal that says why, for the counter");
});

/** Every file under a tree, skipping dependencies and generated output. @param {string} directory @returns {AsyncGenerator<string>} */
async function* files(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (["node_modules", "__pycache__", ".venv", "dist", "reports", "runs"].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.(?:mjs|js|py|sh)$/.test(entry.name)) yield full;
  }
}

test("every harness in the repository that dispatches a run says it is automated", async () => {
  // Probes, acceptance scripts, smoke checks and evaluation drivers: the
  // platform checking itself. A dispatch without the mark is a run the
  // learning loop takes for the researcher's own work.
  let scanned = 0;
  /** @type {string[]} */
  const dispatching = [];
  /** @type {string[]} */
  const unmarked = [];
  const marked = /automated["']?\s*[:=]\s*(?:true|True)|x-evimed-automated/;
  // One harness dispatches as a person on purpose: the general-task baseline measures the attended conversation — the
  // question a person is asked, the file card, a preference remembered into the next conversation (its case G22) — which an
  // automated run by definition does not have. It may, because it can reach nothing but the control plane it starts itself
  // on the loopback with throwaway accounts; that is asserted below, so the exception cannot outlive the reason for it.
  const attendedByDesign = new Map([["evals/general-tasks/runner/cell.mjs", "evals/general-tasks/runner/run.mjs"]]);
  for (const [, starter] of attendedByDesign) {
    const text = await readFile(path.join(openScience, starter), "utf8");
    assert.match(text, /const base = `http:\/\/127\.0\.0\.1:\$\{args\.port\}`/, `${starter} must only ever address the control plane it starts`);
    assert.doesNotMatch(text, /--base\b|OPEN_SCIENCE_PUBLIC_URL|https:\/\//, `${starter} gained a way to address a deployment: its dispatches must then be marked automated`);
  }
  // The memory-policy runner speaks as a person on purpose — memory learns only from attended turns — and against a live
  // deployment, so its exception is narrower: it registers its own throwaway account, refuses any other name, and deletes it.
  const throwawayByDesign = new Set(["evals/memory-policy/run.py"]);
  for (const runner of throwawayByDesign) {
    const text = await readFile(path.join(openScience, runner), "utf8");
    assert.match(text, /THROWAWAY_ACCOUNT = re\.compile\(r"mempol-\[0-9a-f\]\{8\}"\)/, `${runner} must name the throwaway accounts it may speak as`);
    assert.match(text, /if args\.account and not THROWAWAY_ACCOUNT\.fullmatch\(args\.account\):\s*\n\s*parser\.error\(/, `${runner} must refuse an account that is not its own throwaway`);
    assert.match(text, /username = args\.account or "mempol-" \+ secrets\.token_hex\(4\)/, `${runner} must register its own throwaway account by default`);
    assert.match(text, /\/api\/account", \{"confirm": user_id, "password": password\}, "DELETE"/, `${runner} must delete the account it made`);
  }
  for (const tree of ["scripts", "evals"]) {
    for await (const file of files(path.join(openScience, tree))) {
      scanned += 1;
      // A harness's own tests talk to a fake server; they dispatch nothing.
      if (/(?:^|\/)test_[^/]*\.py$|\.test\.m?js$|\/tests?\//.test(file)) continue;
      const text = await readFile(file, "utf8");
      const relative = path.relative(openScience, file);
      for (const match of text.matchAll(/agent-runs\/dispatch/g)) {
        if (/\/\/|^\s*\*|^\s*#/.test(text.slice(text.lastIndexOf("\n", match.index) + 1, match.index))) continue;
        // The call's own statement: from the route to the end of its body.
        const call = text.slice(match.index, match.index + 700);
        const statementEnd = call.search(/\n\s*\n|\}\s*,\s*\d{3}\s*\)|;\s*\n|\n\s*(?:const|let|if|return|run_id|dispatched)\b/);
        const statement = statementEnd > 0 ? call.slice(0, statementEnd) : call;
        dispatching.push(`${relative}@${match.index}`);
        if (marked.test(statement)) continue;
        if (attendedByDesign.has(relative) || throwawayByDesign.has(relative)) continue;
        // A helper that posts whatever payload it is handed is marked by its
        // callers: every `.dispatch({...})` in the file must carry the mark.
        const helperCalls = [...text.matchAll(/\.dispatch\(\{[^}]*\}/g)].map((found) => found[0]);
        if (!/\{\s*\.\.\.|JSON\.stringify\(\{/.test(statement) && helperCalls.length > 0 && helperCalls.every((found) => marked.test(found))) continue;
        unmarked.push(`${relative}@${match.index}`);
      }
    }
  }
  // A walk that found nothing proves nothing.
  assert.ok(scanned >= 100, `scanned only ${scanned} files; the walk is wrong, not the tree`);
  assert.ok(dispatching.length >= 8, `found only ${dispatching.length} dispatches; the parse is wrong`);
  assert.deepEqual(unmarked, [], "each of these dispatches a run without marking it automated");
});

test("a learning step's brief reaches its session inside a platform tag, never as words anyone typed", async () => {
  const source = await readFile(path.join(openScience, "apps/server/src/learningRuntime.mjs"), "utf8");
  const call = source.slice(source.indexOf("runtimeManager.dispatchPrompt(scoped"), source.indexOf("runtimeManager.dispatchPrompt(scoped") + 1200);
  // The template as written in the source, its `\n` escapes resolved.
  const template = (/text: `([^`]*)`/.exec(call)?.[1] ?? "").replaceAll("\\n", "\n");
  assert.match(template, /^<evimed-learning-step>\n\$\{repairText \|\| question\}\n<\/evimed-learning-step>/);
  const text = template.replace("${repairText || question}", "Distil at most one reusable method.").replace("${marker}", "");
  assert.equal(carriesPlatformContext(text), true, "the tag is one the memory reader recognises as machine text");
});

test("the platform's own background calls are not counted among the researcher's open calls", () => {
  // 2026-09-21: 118 learning calls never settled, and the settings page said
  // 「另有 118 次调用未回报用量」 to the researcher (audit 2026-09-26, L-G9).
  // Money was never read from these fields; the count was shown.
  const month = { reservedCalls: 2, uncertainCalls: 120, reservedCost: 0.4, uncertainCost: 185.27, actualCost: 80 };
  const learning = { reservedCalls: 1, uncertainCalls: 118, reservedCost: 0.1, uncertainCost: 184.77, actualCost: 71.72 };
  assert.deepEqual(accountOpenUsage(month, learning), { reservedCalls: 1, uncertainCalls: 2, reservedCost: 0.3, uncertainCost: 0.5 });
  assert.deepEqual(accountOpenUsage(month, null), { reservedCalls: 2, uncertainCalls: 120, reservedCost: 0.4, uncertainCost: 185.27 });
  assert.deepEqual(accountOpenUsage({ uncertainCalls: 1 }, { uncertainCalls: 3 }).uncertainCalls, 0, "never below zero");
});
