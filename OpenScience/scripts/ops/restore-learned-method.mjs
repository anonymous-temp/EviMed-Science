#!/usr/bin/env node
/**
 * Find, and with `--apply` restore, a learned method that a project deletion
 * took with it (audit 2026-09-26, L-G1): `pre-submission-freeze-check`
 * disappeared on 2026-09-23 with every one of its revisions, because methods
 * were filed under the project they were learnt in and the project's rows
 * cascade. Methods are the account's since 2026-09-27; this puts back the one
 * that was lost before that.
 *
 *   node scripts/ops/restore-learned-method.mjs --user <id> --name <method-name>                 # report only
 *   node scripts/ops/restore-learned-method.mjs --user <id> --name <method-name> --apply
 *     [--data-dir <dir>]        the control plane's data directory (default $OPEN_SCIENCE_DATA_DIR, then /data)
 *     [--archive <dir>]         one archived result directory to read instead of searching
 *     [--source-project <id>]   the project it was learnt in, recorded as provenance
 *
 * Where it reads from: the learning loop's result archive — every accepted
 * distillation, kept under the account's learning project
 * (`<data>/users/<user>/projects/evimed-learning/.openscience/learning-results/<dispatch>/`,
 * `learningRuntime.mjs`), which a project deletion never touched. The newest
 * archived `SKILL.md` whose name matches is the one restored, with the display
 * line, the dependencies and the safety flag its `method-candidate.json`
 * carried. The two `.evimedcap` packages exported on 2026-09-21 hold it too,
 * encrypted; an operator who has decrypted one can point `--archive` at the
 * directory holding its `SKILL.md`.
 *
 * What it writes: one method, through the method ledger's own
 * `createCandidate` — validated like any learnt method, at account level, with
 * provenance saying it was restored and from where. Its counters start at zero:
 * what was measured about it went with its revisions.
 *
 * Idempotent: a method of that name already in the library is reported and
 * left alone, so a second run changes nothing. The output is one JSON object —
 * names, paths relative to the data directory and sizes, never the method's
 * text.
 */
import fs from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSkillFrontmatter, workspaceLayout } from "@evimed/domain";

import { ControlPlaneDatabase } from "../../apps/server/src/controlPlaneDatabase.mjs";
import { LEARNING_PROJECT_ID } from "../../apps/server/src/internalProjects.mjs";
import { LearningService, learnedMethodId } from "../../apps/server/src/learningService.mjs";
import { migrateProductStore } from "../../apps/server/src/productPersistence.mjs";
import { ProductDocuments } from "../../apps/server/src/productStore.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The archive's own directory name, under the learning project's metadata. */
const RESULT_ARCHIVE_DIR = "learning-results";

/** How deep under one archived result a `SKILL.md` is looked for. */
const MAX_DEPTH = 4;

/** @param {string[]} argv */
export function parseArguments(argv) {
  /** @type {{ apply: boolean, userId: string | null, name: string | null, dataDir: string | null, archive: string | null, sourceProjectId: string | null }} */
  const options = { apply: false, userId: null, name: null, dataDir: null, archive: null, sourceProjectId: null };
  /** @type {Record<string, "userId" | "name" | "dataDir" | "archive" | "sourceProjectId">} */
  const valued = { "--user": "userId", "--name": "name", "--data-dir": "dataDir", "--archive": "archive", "--source-project": "sourceProjectId" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") { options.apply = true; continue; }
    const key = valued[argument];
    if (!key) throw new Error(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
    options[key] = value;
    index += 1;
  }
  if (!options.userId) throw new Error("--user is required");
  if (!options.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.name)) throw new Error("--name must be a method name (kebab-case)");
  return options;
}

/** Every `SKILL.md` under one directory, bounded in depth, never through a link.
 * @param {string} directory @param {number} [depth] @returns {Promise<string[]>} */
async function skillFiles(directory, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  /** @type {string[]} */
  const found = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await skillFiles(full, depth + 1));
    else if (entry.isFile() && entry.name === "SKILL.md") found.push(full);
  }
  return found;
}

/**
 * The newest archived method of this name: its SKILL.md, parsed, and the
 * candidate beside it. Null when no archive holds one.
 * @param {{ dataDir: string, userId: string, name: string, archive?: string | null }} input
 */
export async function findArchivedMethod({ dataDir, userId, name, archive = null }) {
  const root = archive
    ? [path.resolve(archive)]
    : await (async () => {
      const results = path.join(dataDir, "users", userId, "projects", LEARNING_PROJECT_ID, ".openscience", RESULT_ARCHIVE_DIR);
      const entries = await readdir(results, { withFileTypes: true }).catch(() => []);
      return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(results, entry.name));
    })();
  /** @type {{ file: string, mtimeMs: number, frontmatter: any, body: string, candidate: any, receipt: boolean }[]} */
  const matches = [];
  for (const directory of root) {
    for (const file of await skillFiles(directory)) {
      const text = await readFile(file, "utf8").catch(() => "");
      const parsed = parseSkillFrontmatter(text);
      if (parsed.issues.length || parsed.frontmatter?.name !== name) continue;
      const candidateText = await readFile(path.join(path.dirname(file), "method-candidate.json"), "utf8").catch(() => "");
      let candidate = null;
      try { candidate = candidateText ? JSON.parse(candidateText) : null; } catch { candidate = null; }
      const receipt = await stat(path.join(directory, workspaceLayout.receiptFile)).then((info) => info.isFile(), () => false);
      matches.push({ file, mtimeMs: (await stat(file)).mtimeMs, frontmatter: parsed.frontmatter, body: parsed.body, candidate, receipt });
    }
  }
  // An archive with its receipt is a complete one (`archiveLatestResult`
  // writes the receipt last); newest first among those.
  matches.sort((left, right) => Number(right.receipt) - Number(left.receipt) || right.mtimeMs - left.mtimeMs);
  return matches[0] ?? null;
}

/** The run a method was learnt from, as its candidate or its frontmatter names it. @param {any} found */
function sourceRunOf(found) {
  const fromEvidence = Array.isArray(found?.candidate?.evidence) ? found.candidate.evidence.find((entry) => typeof entry?.runId === "string")?.runId : null;
  if (fromEvidence) return fromEvidence;
  const derived = /(?:^|[\s,])run:([A-Za-z0-9_-]+)/.exec(String(found?.frontmatter?.metadata?.derived_from ?? ""));
  return derived ? derived[1] : null;
}

/**
 * @param {{ learning: any, dataDir: string, userId: string, name: string, archive?: string | null, sourceProjectId?: string | null, apply: boolean }} input
 */
export async function restoreLearnedMethod({ learning, dataDir, userId, name, archive = null, sourceProjectId = null, apply }) {
  const methodId = learnedMethodId(name);
  const present = await learning.getMethod(userId, methodId).then((document) => document, () => null);
  if (present) return { applied: false, methodId, state: "present", revision: present.revision };
  const found = await findArchivedMethod({ dataDir, userId, name, archive });
  if (!found) return { applied: false, methodId, state: "not_archived" };
  const relative = path.relative(dataDir, found.file);
  const report = {
    applied: apply, methodId, state: apply ? "restored" : "restorable",
    archive: relative.startsWith("..") ? found.file : relative,
    complete: found.receipt,
    sourceRunId: sourceRunOf(found),
    bodyBytes: Buffer.byteLength(found.body, "utf8"),
    title: typeof found.candidate?.display?.title === "string" ? found.candidate.display.title : null,
  };
  if (!apply) return report;
  const created = await learning.createCandidate(userId, {
    projectId: sourceProjectId,
    frontmatter: found.frontmatter,
    body: found.body,
    ...(found.candidate?.files && typeof found.candidate.files === "object" ? { files: found.candidate.files } : {}),
    dependencies: Array.isArray(found.candidate?.dependencies) ? found.candidate.dependencies : [],
    provenance: {
      origin: "inferred",
      ...(report.sourceRunId ? { runId: report.sourceRunId } : {}),
      restoredFrom: report.archive,
      restoredAt: new Date().toISOString(),
      ...(found.candidate?.risk?.touchesSafety ? { safetyRelated: true } : {}),
    },
    ...(found.candidate?.display ? { display: found.candidate.display } : {}),
    ...(typeof found.candidate?.display?.steps === "string" ? { steps: found.candidate.display.steps } : {}),
  });
  return { ...report, revision: created.revision, status: created.payload.status };
}

/** The control-plane database, from the same sources the server reads it from. */
function databaseUrl() {
  const direct = process.env.OPEN_SCIENCE_DATABASE_URL;
  const file = process.env.OPEN_SCIENCE_DATABASE_URL_FILE
    ?? process.env.OPEN_SCIENCE_DATABASE_URL_HOST_FILE
    ?? path.join(repoRoot, "deploy/web/secrets/database-url.txt");
  if (direct && fs.existsSync(file)) throw new Error("Database URL has conflicting direct and file sources.");
  if (direct) return direct;
  const info = fs.statSync(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error("Database URL file must be an owner-only regular file.");
  return fs.readFileSync(file, "utf8").trim();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const dataDir = path.resolve(options.dataDir ?? process.env.OPEN_SCIENCE_DATA_DIR ?? "/data");
  const database = new ControlPlaneDatabase({ databaseUrl: databaseUrl(), databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    await migrateProductStore(database);
    const learning = new LearningService({ documents: new ProductDocuments(database) });
    const result = await restoreLearnedMethod({ learning, dataDir, userId: options.userId ?? "", name: options.name ?? "",
      archive: options.archive, sourceProjectId: options.sourceProjectId, apply: options.apply });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`restore_learned_method_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
