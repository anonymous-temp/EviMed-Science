#!/usr/bin/env node
/**
 * Turn a staged handbook proposal into a branch, a commit and a pull-request
 * body — and refuse it if it touched anything but the section it owns.
 *
 * Hidden knowledge: the platform arm of the learning loop edits capability
 * handbooks that ship in the runtime image, and it does that through an
 * ordinary pull request rather than through the control plane. The reason is
 * not process hygiene. A control plane able to rewrite its own capabilities is
 * a control plane able to change what it is measured against, and the paired
 * evaluation it would then pass is worth nothing. So the loop stages a
 * proposal, this script opens a pull request, and a person merges it.
 *
 * The refusal is the load-bearing part. `onlyExperienceSectionChanged` compares
 * the two documents and rejects a proposal that moved a byte outside the
 * maintained section — the contract paragraphs and the "must" sentences live
 * above it — or that walked a counter backwards. That is what makes an
 * automated diff against a shipped handbook safe to look at rather than
 * something a reviewer has to read line by line every night.
 *
 * The four copies stay in step because the SKILL.md body has exactly two
 * authored homes (`capabilities/<id>/SKILL.md` and `capability-skills/<id>/SKILL.md`,
 * held byte-identical by `skillTreesAreOneTree`), and the two generated trees
 * are rebuilt by their own commands. This script writes both authored copies
 * and tells you the two commands; it does not run them, because a generator
 * that runs inside a proposal generator hides which of the two produced a diff.
 *
 * Usage:
 *   node scripts/dev/open-method-pr.mjs --staging=<dir> [--dry-run] [--branch=<name>]
 *
 * The staging directory is `skillopt_sleep`'s own output shape:
 *   manifest.json      { capability, baselineDigest, night }
 *   proposed_SKILL.md  the whole proposed body
 *   report.json        { baseline_score, candidate_score, accepted, gate_action, edits, rejected_edits }
 *   evidence.jsonl     one event per line
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { onlyExperienceSectionChanged, parseExperienceSection } from "@evimed/domain";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const USAGE = `Usage: node scripts/dev/open-method-pr.mjs --staging=<dir> [--dry-run] [--branch=<name>]

  --staging=<dir>  a skillopt-sleep staging directory (manifest.json, proposed_SKILL.md, report.json, evidence.jsonl)
  --branch=<name>  branch to create; defaults to learn/<capability>-<night>
  --dry-run        print the verdict and the pull-request body, write nothing
`;

/** @param {string[]} argv @returns {Record<string, string | boolean>} */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (const entry of argv) {
    if (!entry.startsWith("--")) continue;
    const [name, value] = entry.slice(2).split("=");
    args[name] = value === undefined ? true : value;
  }
  return args;
}

/** @param {string} file @returns {any} */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Everything code can decide about a staged proposal.
 *
 * Exported so the test can drive it without a git repository: the git part is
 * mechanical, this part is the rule.
 * @param {{current: string, proposed: string, report: any}} input
 * @returns {{ok: boolean, issues: string[], added: string[], changed: string[]}}
 */
export function reviewProposal(input) {
  /** @type {string[]} */
  const issues = [];
  const verdict = onlyExperienceSectionChanged(input.current, input.proposed);
  issues.push(...verdict.issues);

  const before = parseExperienceSection(input.current);
  const after = parseExperienceSection(input.proposed);
  const beforeIds = new Set(before.bullets.map((bullet) => bullet.id));
  const added = after.bullets.filter((bullet) => !beforeIds.has(bullet.id)).map((bullet) => bullet.id);
  const changed = after.bullets
    .filter((bullet) => {
      const previous = before.bullets.find((entry) => entry.id === bullet.id);
      return previous && (previous.content !== bullet.content || previous.helpful !== bullet.helpful || previous.harmful !== bullet.harmful);
    })
    .map((bullet) => bullet.id);

  // The gate's own verdict is part of the proposal, not something this script
  // re-decides — but a proposal that did not pass its gate has no business
  // becoming a pull request, and `accepted: false` staged anyway is a bug in
  // whatever staged it.
  if (input.report?.accepted === false) {
    issues.push(`the staged report says accepted=false (gate_action ${JSON.stringify(input.report.gate_action ?? "unknown")})`);
  }
  if (!added.length && !changed.length) {
    issues.push("the proposal changes no note; there is nothing to review");
  }
  return { ok: issues.length === 0, issues, added, changed };
}

/**
 * The pull-request body.
 *
 * Every number a reviewer needs is in it, and the evidence file is attached
 * rather than summarised: a proposal that says "improved" without the trials
 * behind it is asking to be trusted.
 * @param {{capability: string, manifest: any, report: any, added: string[], changed: string[], evidence: string[]}} input
 * @returns {string}
 */
export function pullRequestBody(input) {
  const report = input.report ?? {};
  const lines = [
    `Learned notes for \`${input.capability}\`, staged by the consolidation loop on ${input.manifest?.night ?? "an unrecorded night"}.`,
    "",
    "## What changed",
    "",
    `- new notes: ${input.added.length ? input.added.join(", ") : "none"}`,
    `- updated notes: ${input.changed.length ? input.changed.join(", ") : "none"}`,
    "- nothing outside the maintained section was touched (checked, not asserted)",
    "",
    "## The gate",
    "",
    `- baseline ${report.baseline_score ?? "?"} → candidate ${report.candidate_score ?? "?"}`,
    `- decision: ${report.gate_action ?? "?"} (accepted: ${report.accepted ?? "?"})`,
    `- edits applied: ${(report.edits ?? []).length}, rejected: ${(report.rejected_edits ?? []).length}`,
    `- held-out trials: ${(report.gate_trials ?? []).length}`,
    "",
    "## What a reviewer should check",
    "",
    "1. Does each new note say something a run could act on, or is it a restatement of the contract?",
    "2. Is any note a medical fact? A note is about method; medicine belongs in the safety rules.",
    "3. Do the counters make the case? A note with more harm than help should not be here.",
    "",
    "## Evidence",
    "",
    "```",
    ...input.evidence.slice(0, 40),
    "```",
    "",
    "Rollback is the revert of this commit; the runtime image picks the change up on its next build.",
  ];
  return lines.join("\n");
}

/** @param {string[]} argv */
export function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.staging) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 2;
  }
  const staging = path.resolve(String(args.staging));
  const manifest = readJson(path.join(staging, "manifest.json"));
  const capability = String(manifest.capability ?? "");
  if (!/^[a-z][a-z0-9-]*$/.test(capability)) {
    process.stderr.write(`The staged manifest names no usable capability: ${JSON.stringify(manifest.capability)}\n`);
    return 1;
  }
  const authored = [
    path.join(root, "capabilities", capability, "SKILL.md"),
    path.join(root, "capability-skills", capability, "SKILL.md"),
  ];
  for (const file of authored) {
    if (!fs.existsSync(file)) {
      process.stderr.write(`${path.relative(root, file)} does not exist; ${capability} is not a shipped capability.\n`);
      return 1;
    }
  }
  const current = fs.readFileSync(authored[0], "utf8");
  const proposed = fs.readFileSync(path.join(staging, "proposed_SKILL.md"), "utf8");
  const report = fs.existsSync(path.join(staging, "report.json")) ? readJson(path.join(staging, "report.json")) : {};
  const evidence = fs.existsSync(path.join(staging, "evidence.jsonl"))
    ? fs.readFileSync(path.join(staging, "evidence.jsonl"), "utf8").split("\n").filter(Boolean)
    : [];

  const review = reviewProposal({ current, proposed, report });
  if (!review.ok) {
    process.stderr.write(`Refused. A staged proposal must change only its own section:\n${review.issues.map((issue) => `  - ${issue}`).join("\n")}\n`);
    return 1;
  }

  const body = pullRequestBody({ capability, manifest, report, added: review.added, changed: review.changed, evidence });
  const branch = String(args.branch ?? `learn/${capability}-${manifest.night ?? "proposal"}`);
  if (args["dry-run"]) {
    process.stdout.write(`Would open ${branch} with:\n\n${body}\n`);
    return 0;
  }

  const run = (/** @type {string[]} */ command) => {
    const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr?.trim()}`);
    return result.stdout;
  };
  run(["git", "checkout", "-b", branch]);
  for (const file of authored) fs.writeFileSync(file, proposed, { mode: 0o644 });
  run(["git", "add", ...authored.map((file) => path.relative(root, file))]);
  run(["git", "commit", "-m", `docs(${capability}): learned notes from ${manifest.night ?? "the consolidation loop"}`, "-m", body]);
  const bodyFile = path.join(staging, "pull-request.md");
  fs.writeFileSync(bodyFile, `${body}\n`);
  process.stdout.write([
    `Branch ${branch} holds the proposal.`,
    `Pull-request body: ${bodyFile}`,
    "",
    "Regenerate the two derived trees before opening the pull request:",
    "  node scripts/build/generate-capability-manifests.mjs",
    "  pnpm --filter @evimed/dsh-socket prepack",
    "",
  ].join("\n"));
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main(process.argv.slice(2)));
}
