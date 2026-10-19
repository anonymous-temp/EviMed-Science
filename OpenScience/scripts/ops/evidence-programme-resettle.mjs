#!/usr/bin/env node
/**
 * Find, and with `--apply` reopen, the evidence programme's episodes whose card the zone refused (`card_refused`), so the next
 * sweep builds and saves their card again.
 *
 *   node scripts/ops/evidence-programme-resettle.mjs                                   # report every card_refused episode
 *   node scripts/ops/evidence-programme-resettle.mjs --episode <id> [--episode <id>]   # report the named ones
 *   node scripts/ops/evidence-programme-resettle.mjs --episode <id> ... --apply        # reopen the named ones
 *   node scripts/ops/evidence-programme-resettle.mjs --all-refused --apply             # reopen every one
 *
 * Why it exists: `card_refused` is final by design (`evidenceProgramme.mjs`): the same episode builds the same card, so asking the
 * zone again only repeats the refusal. When the refusal was the builder's fault and a release fixed it (R19.2 follow-up,
 * 2026-10-19: four episodes of 64 to 78 claims over the 60 a card carries), the recorded outcome is what keeps the fixed builder
 * from ever seeing them. This removes that one outcome from its decision, and nothing else: the episode, its result, its
 * agenda and every other outcome stay as they are. The control plane's sweep (`EvidenceProgrammeWorker`) then settles the
 * episode like any open one — a card, a revision of the agenda's card, or a new outcome recorded with its reason.
 *
 * The sweep reads the last `PROGRAMME_SETTLE_DAYS` decisions; an episode in an older decision is reported `outside_sweep_window`
 * and left alone even with `--apply`, because reopening it would change nothing.
 *
 * Idempotent: an episode whose outcome is not `card_refused` (already reopened, or settled since) is reported and left alone, so a
 * second run changes nothing. Run it after the release that fixes the refusal, never before — on the old builder the next
 * sweep records the same refusal again. The output is one JSON object of ids, days, outcomes and the zone's reason.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";

import { ControlPlaneDatabase } from "../../apps/server/src/controlPlaneDatabase.mjs";
import { PROGRAMME_DECISION_KIND } from "../../apps/server/src/evidenceProgramme.mjs";
import { PROGRAMME_SETTLE_DAYS } from "../../apps/server/src/evidenceProgrammeData.mjs";
import { EVIDENCE_PROJECT_ID } from "../../apps/server/src/internalProjects.mjs";
import { migrateProductStore } from "../../apps/server/src/productPersistence.mjs";
import { ProductDocuments } from "../../apps/server/src/productStore.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EPISODE_ID = /^episode-[A-Za-z0-9_-]{1,100}$/;
/** How many decisions are looked through for a refused episode: the programme keeps one a day. */
const DECISIONS_READ = 100;

/** @param {string[]} argv */
export function parseArguments(argv) {
  /** @type {{ apply: boolean, all: boolean, episodeIds: string[] }} */
  const options = { apply: false, all: false, episodeIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--all-refused") options.all = true;
    else if (argument === "--episode") {
      const value = argv[index + 1];
      if (!value || !EPISODE_ID.test(value)) throw new Error("--episode needs an episode id");
      options.episodeIds.push(value);
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  if (options.all && options.episodeIds.length) throw new Error("--all-refused and --episode are exclusive");
  if (options.apply && !options.all && !options.episodeIds.length) throw new Error("--apply needs --episode <id> or --all-refused");
  return options;
}

/**
 * Report, and with `apply` reopen, the programme's `card_refused` episodes: the named ones, or every one when `episodeIds` is empty.
 * @param {{ documents: ProductDocuments, episodeIds?: string[], apply?: boolean }} input
 */
export async function resettleRefusedCards({ documents, episodeIds = [], apply = false }) {
  const page = await documents.list(PLATFORM_PUBLISHER_USER_ID, PROGRAMME_DECISION_KIND, { projectId: EVIDENCE_PROJECT_ID, limit: DECISIONS_READ });
  // The order the sweep reads them in (newest first), so "inside the window" means exactly what the sweep will look at.
  const window = new Set(page.items.slice(0, PROGRAMME_SETTLE_DAYS).map((/** @type {any} */ decision) => decision.id));
  const wanted = new Set(episodeIds);
  /** @type {{ episodeId: string, decisionId: string | null, day: string | null, outcome: string | null, reason: string | null, action: string }[]} */
  const episodes = [];
  for (const decision of page.items) {
    /** @type {string[]} */
    const reopen = [];
    for (const [episodeId, recorded] of Object.entries(decision.payload.outcomes ?? {})) {
      if (wanted.size ? !wanted.has(episodeId) : recorded?.outcome !== "card_refused") continue;
      wanted.delete(episodeId);
      const entry = { episodeId, decisionId: decision.id, day: decision.payload.day ?? null, outcome: recorded?.outcome ?? null, reason: recorded?.reason ?? null, action: "" };
      if (recorded?.outcome !== "card_refused") entry.action = "not_refused";
      else if (!window.has(decision.id)) entry.action = "outside_sweep_window";
      else { entry.action = apply ? "reopened" : "would_reopen"; reopen.push(episodeId); }
      episodes.push(entry);
    }
    if (apply && reopen.length) await reopenOutcomes(documents, decision.id, reopen);
  }
  for (const episodeId of wanted) episodes.push({ episodeId, decisionId: null, day: null, outcome: null, reason: null, action: "not_found" });
  return { applied: apply, sweepWindow: PROGRAMME_SETTLE_DAYS, episodes };
}

/**
 * Remove the named `card_refused` outcomes from one decision, re-read on a revision conflict (the programme writes the same
 * document when it settles another episode of the day).
 * @param {ProductDocuments} documents @param {string} decisionId @param {string[]} episodeIds
 */
async function reopenOutcomes(documents, decisionId, episodeIds) {
  for (let attempt = 0; ; attempt += 1) {
    const current = await documents.get(PLATFORM_PUBLISHER_USER_ID, PROGRAMME_DECISION_KIND, decisionId);
    if (!current) return;
    const outcomes = { ...current.payload.outcomes };
    let changed = false;
    for (const episodeId of episodeIds) {
      if (outcomes[episodeId]?.outcome !== "card_refused") continue;
      delete outcomes[episodeId];
      changed = true;
    }
    if (!changed) return;
    try {
      await documents.put(PLATFORM_PUBLISHER_USER_ID, PROGRAMME_DECISION_KIND, decisionId, { ...current.payload, outcomes },
        { expectedRevision: current.revision, projectId: EVIDENCE_PROJECT_ID });
      return;
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== "product_revision_conflict" || attempt >= 5) throw error;
    }
  }
}

/** The control-plane database, from the same sources the server reads it from. */
function databaseUrl() {
  const direct = process.env.OPEN_SCIENCE_DATABASE_URL;
  const file = process.env.OPEN_SCIENCE_DATABASE_URL_FILE
    ?? process.env.OPEN_SCIENCE_DATABASE_URL_HOST_FILE
    ?? path.join(repoRoot, "deploy/web/secrets/database-url.txt");
  if (direct && fs.existsSync(file)) throw new Error("Database URL has conflicting direct and file sources.");
  if (direct) return direct;
  const stat = fs.statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Database URL file must be an owner-only regular file.");
  return fs.readFileSync(file, "utf8").trim();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const database = new ControlPlaneDatabase({ databaseUrl: databaseUrl(), databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    await migrateProductStore(database);
    const result = await resettleRefusedCards({ documents: new ProductDocuments(database), episodeIds: options.episodeIds, apply: options.apply });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`evidence_programme_resettle_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
