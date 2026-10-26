#!/usr/bin/env node
/**
 * Write the last month of 「前沿动态」 again the way each genre is written (ct-write, 2026-10-24): every published item's genre, and —
 * for the items whose reader is read (精选, safety alerts, items within `FRONTIER_READER_MARGIN` of the selection line) — its 导读, its
 * 「AI 要点」 and its 推荐理由 with the prompts that ship.
 *
 *   node scripts/ops/frontier-rewrite.mjs                   report: what each step would do, by genre, and what asking would cost
 *   node scripts/ops/frontier-rewrite.mjs --apply           do it, within the module's day budget
 *   options: --days N (1–30, default 30), --since ISO (instead of --days: where a stopped run resumes),
 *            --steps genre,title,score,lead,brief,reason,facts,faith (default genre,title,lead,brief,reason,facts,faith; `score` only by
 *            name, and first of the steps it shares a run with), --min-old-total N (score: skip items under this old total, default 50),
 *            --concurrency N (1–8, default 4), --limit N
 *
 * The steps:
 * - `genre`: an item with no stored genre takes code's answer (`frontierGenreFallback`) where code is sure of it or its fields say
 *   it (a journal's paper, a registry's trial, a safety feed's notice …); where code fell back on the channel alone
 *   (`FRONTIER_REWRITE_UNSURE`: news, commentary, industry, policy) the model names it, `FRONTIER_GENRE_BATCH` items to a call, and
 *   `frontierGenreDecision` stores the answer. No call is needed for most items.
 * - `title` (c4-title, 2026-10-26): a published item whose title an older rule wrote (`editor_diagnostics.titleVersion` is not
 *   `FRONTIER_TITLE_VERSION`) and that has a Chinese title is asked for its title again (`FrontierEditor#writeTitle`: no prefix label,
 *   no site or media name, no hook, at most 40 characters, from the source's own facts and numbers). A Chinese source's own title that
 *   already follows the rule stays the source's; an answer a check refused (a mark of `【】|｜丨!！?？`, a number the source does not
 *   state, a link) keeps the title there was. The version is written whatever the answer was, so the item is not asked again; a call
 *   that failed writes nothing. The write is a compare-and-set on the title read when the step began (an item the pipeline re-edited
 *   meanwhile is skipped and counted `raced`), with the search words, an `item_changes` row, and one content-version bump per 50 items.
 * - `score` (c3-select, 2026-10-25): a published, verified item whose parts an older scoring wrote (`editor_diagnostics.scoreVersion`
 *   is not `FRONTIER_SCORE_VERSION`) and whose old total reached `--min-old-total` is scored again from its source text by the
 *   standalone score call (`FrontierEditor#scoreItem`: about ¥0.0012 an item, the rubric and the 「可能改变实践」 proposal of the edit),
 *   under the same ceilings as a new item's (`frontierFinalScore`). It writes the parts, the total, the proposal and the version, and
 *   never touches `selected`: selection is sticky, and the day's labels are admitted afterwards from what the day has selected. A failed
 *   or unreadable answer keeps the score there was. After a release that moved the line, run it over the days the genre floors read
 *   (30) before anything else: `--steps score,reason,lead,brief --days 7 --apply` for a week.
 * - `lead`: a reader-worthy item whose 导读 an older prompt wrote (`lead_version`) is written again from its settled reader text, by its
 *   genre and, where it has 要点, held shorter (`frontierWriteLead`). An answer the checks refused keeps the 导读 there was.
 * - `brief`: a reader-worthy item whose 要点 are missing or older (`brief_version`, `brief_basis`) gets them (`frontierWriteBrief`).
 * - `reason`: a reader-worthy item whose 推荐理由 an older prompt wrote (`reason_version`) gets one through its genre's lens without
 *   being edited again (`FrontierEditor#writeReason`) — an edit would score and select it again. A refused answer keeps the old one.
 * - `facts` (c3-faith): a reader-worthy item of a study genre (paper, preprint, trial, conference) whose study facts were not made from
 *   its settled reader text gets them (`frontierEnsureStudyFacts`: each field anchored to a quotation code found, or an empty record).
 * - `faith` (c3-faith): a reader-worthy study item whose 导读, 要点 or card summary was written after its last check, or never checked
 *   by these instructions, or whose check could not be made, is read against its study facts (made now when missing) the way the
 *   pipeline reads a new one (`frontierFaithCheckLead` / `frontierFaithCheckBrief` / `frontierFaithCheckSummary`): a mismatch in a
 *   导读 or 要点 goes back to the writer once, a sentence or point that still mismatches is left out, and a text with nothing left is
 *   cleared (the reader shows the card's summary; a card with no summary shows its title); a card summary is only trimmed. The record
 *   is `editor_diagnostics.faith`, never a note on the page. An item whose text has an empty facts record is not asked about again.
 *
 * Hidden knowledge:
 *
 * - The report asks nothing and writes nothing. Its cost is an estimate from the calls' measured size (`REWRITE_CALL_TOKENS`, the
 *   frontier-writing eval of 2026-10-24) at the reference price list's `deepseek-flash` row.
 * - Metered like every frontier call: purpose `frontier`, the operator's internal project, the module's day budget beside the feed's
 *   own work. When the budget is no longer `ok` the run stops with `stopped: "budget"` and `resumeFrom`; `--since <resumeFrom>` asks
 *   nothing twice. Items are taken oldest first.
 * - Idempotent: every write records the version that wrote it, and a second run over the same days finds nothing to do. The pipeline
 *   writes the same fields for new items; this command only gets the month already published there sooner.
 * - One run at a time (a session advisory lock). It needs the configuration the server runs with — the database, the DeepSeek key,
 *   the operator account — and the module switched on. It prints counts and codes, never a key.
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { FRONTIER_GENRES, FRONTIER_SOURCE_TYPE_LABELS_ZH, agendaLocalDate, frontierGenreDecision, frontierGenreFallback, frontierPracticeAdmit, frontierPracticeReason, frontierSourceDisplayName,
  isFrontierGenre }
  from "@evimed/domain";
import { FRONTIER_BRIEF_VERSION, frontierBriefWanted, frontierWriteBrief } from "../../apps/server/src/frontierBrief.mjs";
import { FRONTIER_FAITH_VERSION, FRONTIER_STUDY_FACTS_VERSION, faithDiagnostic, faithSource, frontierEnsureStudyFacts, frontierFaithCheckBrief,
  frontierFaithCheckLead, frontierFaithCheckSummary, frontierStudyFactsWanted, frontierWriteFaith } from "../../apps/server/src/frontierFaithStep.mjs";
import { FRONTIER_GENRE_BATCH, FRONTIER_REASON_VERSION } from "../../apps/server/src/frontierEditor.mjs";
import { FRONTIER_LEAD_VERSION, frontierWriteLead } from "../../apps/server/src/frontierLead.mjs";
import { FRONTIER_SOURCE_STREAM_COLUMNS } from "../../apps/server/src/frontierSourceColumns.mjs";
import { bumpFrontierVersion } from "../../apps/server/src/frontierPersistence.mjs";
import { FRONTIER_SCORE_VERSION, FRONTIER_TITLE_VERSION, isChineseTitle } from "../../apps/server/src/frontierEditor.mjs";
import { FRONTIER_READER_MARGIN, frontierDayWindow, frontierFinalScore, frontierLexemeText, frontierPracticeCandidates, frontierReaderText }
  from "../../apps/server/src/frontierPipeline.mjs";
import { tsvectorLiteral } from "../../apps/server/src/kbChunker.mjs";

const DAY_MS = 24 * 3_600_000;
const REWRITE_LOCK = "evimed-frontier-rewrite";
/** Items the title step writes between two content-version bumps. */
const TITLE_BATCH = 50;
export const FRONTIER_REWRITE_STEPS = Object.freeze(["genre", "title", "score", "lead", "brief", "reason", "facts", "faith"]);
/**
 * What a run does without `--steps`: the five writing steps (genre, title, lead, brief, reason) and the two c3-faith steps that check what they wrote. `score` is asked
 * for by name - it is the one step that moves which items are selected and reader-worthy, so a run that rewrites prose never re-scores
 * by accident (c3-select S9).
 */
export const FRONTIER_REWRITE_DEFAULT_STEPS = Object.freeze(["genre", "title", "lead", "brief", "reason", "facts", "faith"]);
/** Items under this old total are not asked about by `score`: 54% of a week sits under 50 on the old scale and none of them reaches a floor. */
export const FRONTIER_REWRITE_SCORE_MIN_OLD_TOTAL = 50;
/** Genres code reached from the channel alone: the model names these (the rest are code's answer, from what the fields say). */
export const FRONTIER_REWRITE_UNSURE = Object.freeze(["news", "commentary", "industry", "policy"]);
/**
 * What one call measured on the frontier-writing eval (2026-10-24, deepseek-flash, 48 real items: 159 calls, 343 k prompt tokens from
 * the provider's cache, 103 k not, 42 k output): per call, the cached prefix, the rest of the prompt and the output. A genre call
 * carries `FRONTIER_GENRE_BATCH` items.
 */
export const REWRITE_CALL_TOKENS = Object.freeze({
  genre: { cached: 900, prompt: 1_400, output: 150 },
  // c4-title's live check (2026-10-26), replaced below by the measured figure.
  title: { cached: 1_300, prompt: 800, output: 40 },
  lead: { cached: 1_000, prompt: 2_600, output: 260 },
  brief: { cached: 1_000, prompt: 2_800, output: 520 },
  reason: { cached: 700, prompt: 1_900, output: 120 },
  // c3-faith's eval (2026-10-25) measured CNY 0.0031 a facts call and 0.0011–0.0017 a check, with the provider's cache warm on repeated
  // items; these sizes assume the text itself is not cached, so the report errs high. A `faith` call is one text checked.
  facts: { cached: 900, prompt: 2_600, output: 290 },
  faith: { cached: 800, prompt: 600, output: 150 },
  // c3-select, the gold set's 124 standalone score calls on 2026-10-25: 158 k prompt tokens from the cache, 55 k not, 4 k output.
  score: { cached: 1_275, prompt: 443, output: 34 },
});

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { apply: false, days: 30, since: /** @type {Date | null} */ (null), steps: [...FRONTIER_REWRITE_DEFAULT_STEPS], concurrency: 4, limit: 100_000,
    minOldTotal: FRONTIER_REWRITE_SCORE_MIN_OLD_TOTAL };
  const number = (/** @type {string} */ name, /** @type {string | undefined} */ value, /** @type {number} */ min, /** @type {number} */ max) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return parsed;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--days") options.days = number("--days", argv[++index], 1, 30);
    else if (argument === "--concurrency") options.concurrency = number("--concurrency", argv[++index], 1, 8);
    else if (argument === "--limit") options.limit = number("--limit", argv[++index], 1, 1_000_000);
    else if (argument === "--min-old-total") options.minOldTotal = number("--min-old-total", argv[++index], 0, 100);
    else if (argument === "--steps") {
      const steps = String(argv[++index] ?? "").split(",").map((step) => step.trim()).filter(Boolean);
      if (!steps.length || steps.some((step) => !FRONTIER_REWRITE_STEPS.includes(step))) throw new Error(`--steps takes ${FRONTIER_REWRITE_STEPS.join(",")}`);
      options.steps = FRONTIER_REWRITE_STEPS.filter((step) => steps.includes(step));
    } else if (argument === "--since") {
      const since = new Date(String(argv[++index] ?? ""));
      if (!Number.isFinite(since.getTime())) throw new Error("--since must be an ISO time");
      options.since = since;
    } else throw new Error(`unknown argument ${argument}; the options are --apply, --days N, --since ISO, --steps a,b, --min-old-total N, --concurrency N, --limit N`);
  }
  return options;
}

/**
 * What asking would cost, from the calls each step would make, at a price row in CNY per million tokens.
 * @param {Record<string, number>} calls step → calls @param {{ cacheHit: number, cacheMiss: number, output: number }} price
 */
export function estimateRewriteCost(calls, price) {
  let cny = 0;
  for (const [step, count] of Object.entries(calls)) {
    const size = REWRITE_CALL_TOKENS[/** @type {keyof typeof REWRITE_CALL_TOKENS} */ (step)];
    if (!size) continue;
    cny += count * (size.cached * price.cacheHit + size.prompt * price.cacheMiss + size.output * price.output) / 1_000_000;
  }
  return { calls, cny: Math.round(cny * 100) / 100 };
}

/** The genre an item has now: the stored one, else code's. @param {any} row */
const genreOf = (row) => (isFrontierGenre(row.genre) ? row.genre : frontierGenreFallback(row));

const ITEM_FIELDS = `i.id, i.public_id, i.title_raw, i.title_zh, i.summary_zh, i.platform, i.channel, i.source_type, i.evidence_type, i.flags,
  i.safety_alert, i.lane, i.genre, i.genre_basis, i.selected, i.score_total, i.evidence_basis, i.published_at, i.visible_at, i.primary_source_id,
  s.authority AS src_authority, s.name AS source_name, s.owner_entity AS source_owner, ${FRONTIER_SOURCE_STREAM_COLUMNS}`;

/**
 * Report, and with `apply` make, the steps over the published items of `[since, until)`, oldest first.
 * @param {{ database: any, editor?: any, budget?: (() => Promise<{ state: string }>) | null, threshold: number, since: Date, until?: Date,
 *   steps?: string[], apply?: boolean, limit?: number, concurrency?: number, timeZone?: string, minOldTotal?: number,
 *   onProgress?: (line: string) => void }} input
 */
export async function frontierRewrite({ database, editor = null, budget = null, threshold, since, until = new Date(), steps = [...FRONTIER_REWRITE_DEFAULT_STEPS],
  apply = false, limit = 100_000, concurrency = 4, timeZone = "Asia/Shanghai", minOldTotal = FRONTIER_REWRITE_SCORE_MIN_OLD_TOTAL, onProgress = () => {} }) {
  const worthy = threshold - FRONTIER_READER_MARGIN;
  /** @type {Record<string, any>} */
  const summary = { applied: apply, since: since.toISOString(), until: until.toISOString(), steps, versions: { lead: FRONTIER_LEAD_VERSION,
    brief: FRONTIER_BRIEF_VERSION, reason: FRONTIER_REASON_VERSION, title: FRONTIER_TITLE_VERSION, facts: FRONTIER_STUDY_FACTS_VERSION, faith: FRONTIER_FAITH_VERSION },
    stopped: null, resumeFrom: null, failed: 0 };
  /** @type {Record<string, number>} */
  const calls = {};
  let stopped = false;
  /** Whether the budget still allows asking; a run that stops says where it would resume. @param {any} row */
  const allowed = async (row) => {
    if (stopped) return false;
    const state = budget ? (await budget()).state : "ok";
    if (state === "ok") return true;
    stopped = true;
    summary.stopped = "budget";
    summary.resumeFrom = row?.visible_at ? new Date(row.visible_at).toISOString() : null;
    return false;
  };
  /** Runs `work` over rows, `concurrency` at a time, in order of the rows. @param {any[]} rows @param {(row: any) => Promise<void>} work */
  const each = async (rows, work) => {
    const queue = [...rows];
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        if (!(await allowed(row))) return;
        try { await work(row); } catch { summary.failed += 1; }
      }
    }));
  };
  const sourceName = (/** @type {any} */ row) => frontierSourceDisplayName({ id: row.primary_source_id, name: row.source_name ?? row.primary_source_id, ownerEntity: row.source_owner, access: row.source_access, journal: row.item_journal });
  const day = (/** @type {any} */ row) => (row.published_at ? agendaLocalDate(timeZone, new Date(row.published_at)) : null);
  const textsOf = async (/** @type {any} */ row) => (await database.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id = $1", [row.id])).rows[0] ?? null;

  if (steps.includes("genre")) {
    const rows = (await database.query(`SELECT ${ITEM_FIELDS}, left(coalesce(t.abstract_raw, t.body_text, t.body_excerpt, ''), 400) AS opening
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id LEFT JOIN evimed_frontier.item_texts t ON t.item_id = i.id
      WHERE i.state = 'published' AND i.genre IS NULL AND i.visible_at >= $1 AND i.visible_at < $2 ORDER BY i.visible_at, i.id LIMIT $3`, [since, until, limit])).rows;
    const sure = rows.filter((row) => !FRONTIER_REWRITE_UNSURE.includes(frontierGenreFallback(row)));
    const unsure = rows.filter((row) => FRONTIER_REWRITE_UNSURE.includes(frontierGenreFallback(row)));
    /** @type {Record<string, number>} */
    const byGenre = {};
    for (const row of sure) byGenre[frontierGenreFallback(row)] = (byGenre[frontierGenreFallback(row)] ?? 0) + 1;
    summary.genre = { items: rows.length, byCode: sure.length, toAsk: unsure.length, codeGenres: byGenre, written: 0, model: 0 };
    calls.genre = Math.ceil(unsure.length / FRONTIER_GENRE_BATCH);
    if (apply) {
      for (const row of sure) {
        const decided = frontierGenreDecision(row, null);
        await database.query("UPDATE evimed_frontier.items SET genre = $2, genre_basis = $3 WHERE id = $1 AND genre IS NULL", [row.id, decided.genre, decided.basis]);
        summary.genre.written += 1;
      }
      const batches = [];
      for (let at = 0; at < unsure.length; at += FRONTIER_GENRE_BATCH) batches.push(unsure.slice(at, at + FRONTIER_GENRE_BATCH));
      await each(batches.map((batch) => ({ batch, visible_at: batch[0].visible_at })), async ({ batch }) => {
        const answers = await editor.classifyGenres(batch.map((/** @type {any} */ row) => ({ sourceName: sourceName(row), title: row.title_zh || row.title_raw, excerpt: row.opening })));
        for (const [index, row] of batch.entries()) {
          const decided = frontierGenreDecision(row, answers[index] ?? null);
          await database.query("UPDATE evimed_frontier.items SET genre = $2, genre_basis = $3 WHERE id = $1 AND genre IS NULL", [row.id, decided.genre, decided.basis]);
          summary.genre.written += 1;
          if (decided.basis === "model") summary.genre.model += 1;
        }
      });
    }
  }

  if (steps.includes("title")) {
    // Every published item with a Chinese title that the current title rule has not written; an item with none yet waits for its edit.
    const rows = (await database.query(`SELECT ${ITEM_FIELDS}, i.entities, i.tags
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE i.state = 'published' AND i.visible_at >= $1 AND i.visible_at < $2 AND i.title_zh IS NOT NULL
        AND i.editor_diagnostics->>'titleVersion' IS DISTINCT FROM $4
      ORDER BY i.visible_at, i.id LIMIT $3`, [since, until, limit, FRONTIER_TITLE_VERSION])).rows;
    const chinese = rows.filter((row) => isChineseTitle(row.title_raw)).length;
    summary.title = { items: rows.length, byLanguage: { zh: chinese, other: rows.length - chinese }, titleVersion: FRONTIER_TITLE_VERSION, written: 0, kept: 0, refused: 0, raced: 0 };
    calls.title = rows.length;
    if (apply) {
      // One content-version bump per batch of items, so a long run shows its titles as it goes and does not bump once an item.
      for (let at = 0; at < rows.length; at += TITLE_BATCH) {
        let changed = 0;
        await each(rows.slice(at, at + TITLE_BATCH), async (row) => {
          const texts = await textsOf(row);
          const reader = frontierReaderText(texts);
          // A failed call throws (counted failed, the version not written, asked again next run); a refusal is an answer of null.
          const answer = await editor.writeTitle({ sourceName: sourceName(row), titleRaw: row.title_raw, isChinese: isChineseTitle(row.title_raw), genre: genreOf(row),
            summaryZh: row.summary_zh, text: reader?.text ?? null, titleZh: row.title_zh });
          const next = answer?.titleZh ?? null;
          const result = await database.transaction(async (/** @type {any} */ client) => {
            // Nothing written over a title the pipeline wrote while this one was asked: the answer is to the title it read.
            const current = (await client.query("SELECT title_zh, state FROM evimed_frontier.items WHERE id = $1 FOR UPDATE", [row.id])).rows[0];
            if (!current || current.state !== "published" || current.title_zh !== row.title_zh) return null;
            const moved = next !== null && next !== current.title_zh;
            await client.query(`UPDATE evimed_frontier.items SET editor_diagnostics = coalesce(editor_diagnostics, '{}'::jsonb) || jsonb_build_object('titleVersion', $2::text) WHERE id = $1`,
              [row.id, FRONTIER_TITLE_VERSION]);
            if (moved) {
              await client.query("UPDATE evimed_frontier.items SET title_zh = $2, lexemes = $3::tsvector WHERE id = $1",
                [row.id, next, tsvectorLiteral(frontierLexemeText({ ...row, title_zh: next }))]);
              await client.query("INSERT INTO evimed_frontier.item_changes (item_id, op, reason) VALUES ($1, 'upsert', 'title')", [row.id]);
            }
            return { moved };
          });
          if (!result) { summary.title.raced += 1; return; }
          if (result.moved) { summary.title.written += 1; changed += 1; }
          else if (answer) summary.title.kept += 1;
          else summary.title.refused += 1;
        });
        if (changed) await database.transaction((/** @type {any} */ client) => bumpFrontierVersion(client));
      }
    }
  }

  if (steps.includes("score")) {
    const rows = (await database.query(`SELECT ${ITEM_FIELDS}, i.editor_diagnostics, i.study_facts, i.date_precision, i.timeline_at, t.abstract_raw, t.body_excerpt, t.body_text,
        t.reader_summary, t.journal, t.publication_types
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id LEFT JOIN evimed_frontier.item_texts t ON t.item_id = i.id
      WHERE i.state = 'published' AND i.visible_at >= $1 AND i.visible_at < $2 AND NOT i.safety_alert AND i.verification IN ('passed', 'repaired')
        AND i.score_total >= $4 AND i.editor_diagnostics->>'scoreVersion' IS DISTINCT FROM $5
      ORDER BY i.visible_at, i.id LIMIT $3`, [since, until, limit, minOldTotal, FRONTIER_SCORE_VERSION])).rows;
    summary.score = { items: rows.length, minOldTotal, scoreVersion: FRONTIER_SCORE_VERSION, written: 0, kept: 0, capped: 0, practiceProposed: 0, labelled: 0,
      moved: { up: 0, down: 0, same: 0 } };
    calls.score = rows.length;
    /** @type {Set<string>} */
    const days = new Set();
    if (apply) await each(rows, async (row) => {
      // What code decided about the evidence type stays said as decided; the model's own guess is not handed back to it.
      const fixed = ["pubmed-types", "registry"].includes(row.evidence_basis) && row.evidence_type ? { type: row.evidence_type, basis: row.evidence_basis } : null;
      const body = row.body_excerpt ?? (typeof row.body_text === "string" && row.body_text.trim() ? row.body_text.slice(0, 12_000) : null);
      const answer = await editor.scoreItem({
        titleRaw: row.title_raw, sourceName: sourceName(row), sourceTypeLabel: FRONTIER_SOURCE_TYPE_LABELS_ZH[row.source_type] ?? null,
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null, datePrecision: row.date_precision, isChinese: isChineseTitle(row.title_raw),
        allowedLanes: [], evidenceFixed: fixed, abstract: row.abstract_raw ?? null, summary: row.abstract_raw ? null : row.reader_summary ?? null,
        bodyExcerpt: body, journal: row.journal ?? null, publicationTypes: row.publication_types ?? [],
      }, { genre: genreOf(row) });
      // An unreadable answer keeps the score there was (principle 19); a budget that ended the run is not a failure of the item.
      if (!answer.scores) {
        if (answer.error === "usage_budget_exceeded") return;
        summary.score.kept += 1;
        return;
      }
      const source = { id: row.primary_source_id, authority: row.src_authority, source_type: row.source_type };
      const final = frontierFinalScore({ scores: answer.scores, source, itemSourceId: row.primary_source_id, evidenceType: row.evidence_type,
        evidenceFixed: ["pubmed-types", "registry"].includes(row.evidence_basis), genre: genreOf(row), studyFacts: row.study_facts });
      const total = final.parts.authority + final.parts.impact + final.parts.novelty + final.parts.relevance;
      const reason = answer.practice ? frontierPracticeReason(answer.practice.reasonZh) : null;
      await database.transaction(async (/** @type {any} */ client) => {
        await client.query(`UPDATE evimed_frontier.items SET score_authority = $2, score_impact = $3, score_novelty = $4, score_relevance = $5, score_total = $6,
            practice_changing = CASE WHEN $7::text IS NULL THEN false ELSE practice_changing END, practice_zh = $7::text,
            editor_diagnostics = coalesce(editor_diagnostics, '{}'::jsonb) - 'capped' || $8::jsonb, rescored_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE id = $1`, [row.id, final.parts.authority, final.parts.impact, final.parts.novelty, final.parts.relevance, total, reason,
          JSON.stringify({ scoreVersion: FRONTIER_SCORE_VERSION, scoresRaw: answer.scoresRaw, ...(final.reasons.length ? { capped: final.reasons } : {}) })]);
        await client.query("INSERT INTO evimed_frontier.item_changes (item_id, op, reason) VALUES ($1, 'upsert', 'rescored')", [row.id]);
        await bumpFrontierVersion(client);
      });
      summary.score.written += 1;
      if (final.reasons.length) summary.score.capped += 1;
      if (reason) summary.score.practiceProposed += 1;
      const old = Number(row.score_total);
      summary.score.moved[total > old ? "up" : total < old ? "down" : "same"] += 1;
      if (row.timeline_at) days.add(frontierDayWindow(new Date(row.timeline_at), timeZone).day);
    });
    // The label is admitted per day, from what the day has selected (the pipeline does the same at the end of a round): the best
    // scored proposals up to the day's cap, an admitted one staying.
    if (apply) for (const dayKey of [...days].sort()) {
      const { start, end } = frontierDayWindow(new Date(`${dayKey}T12:00:00Z`), timeZone);
      const dayRows = (await database.query(`SELECT i.id, i.genre, i.platform, i.channel, i.source_type, i.evidence_type, i.flags, i.safety_alert, i.lane, i.selected,
          i.score_total, i.practice_changing, i.practice_zh, s.authority AS source_authority, s.source_type AS source_source_type
        FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id AND s.enabled
        WHERE i.state = 'published' AND i.timeline_at >= $1 AND i.timeline_at < $2`, [start, end])).rows;
      const candidates = frontierPracticeCandidates(dayRows);
      for (const id of frontierPracticeAdmit(candidates, { selectedCount: candidates.length }).admit) {
        await database.transaction(async (/** @type {any} */ client) => {
          const updated = await client.query(`UPDATE evimed_frontier.items SET practice_changing = true, updated_at = clock_timestamp()
            WHERE id = $1 AND state = 'published' AND NOT practice_changing AND practice_zh IS NOT NULL`, [id]);
          if (!updated.rowCount) return;
          await client.query("INSERT INTO evimed_frontier.item_changes (item_id, op, reason) VALUES ($1, 'upsert', 'practice')", [id]);
          await bumpFrontierVersion(client);
          summary.score.labelled += 1;
        });
      }
    }
  }

  /** The reader-worthy items one step still owes, oldest first: `owed` a predicate over `i` and `t` with the version as `$5`. @param {string} owed @param {string} version */
  const owing = async (owed, version) => (await database.query(`SELECT ${ITEM_FIELDS}, i.lead_zh, i.reason_zh FROM evimed_frontier.items i
      JOIN evimed_frontier.sources s ON s.id = i.primary_source_id JOIN evimed_frontier.item_texts t ON t.item_id = i.id
      WHERE i.state = 'published' AND i.visible_at >= $1 AND i.visible_at < $2 AND t.reader_tidy IS NOT NULL
        AND (i.selected OR i.safety_alert OR i.score_total >= $3) AND ${owed}
      ORDER BY i.visible_at, i.id LIMIT $4`, [since, until, worthy, limit, version])).rows;
  /** Per-genre counts of rows. @param {any[]} rows */
  const genres = (rows) => Object.fromEntries(FRONTIER_GENRES.map((genre) => [genre, rows.filter((row) => genreOf(row) === genre).length]).filter(([, n]) => n));

  if (steps.includes("lead")) {
    const rows = await owing("i.lead_version IS DISTINCT FROM $5", FRONTIER_LEAD_VERSION);
    summary.lead = { items: rows.length, byGenre: genres(rows), written: 0, emptied: 0, kept: 0 };
    calls.lead = rows.length;
    if (apply) await each(rows, async (row) => {
      const texts = await textsOf(row);
      const reader = frontierReaderText(texts);
      if (!reader || !texts?.reader_tidy?.sha) return;
      const genre = genreOf(row);
      const result = await frontierWriteLead(editor, { sourceName: sourceName(row), date: day(row), titleRaw: row.title_raw, titleZh: row.title_zh,
        text: reader.text, kind: reader.source, post: row.platform === "x", genre, briefed: frontierBriefWanted(genre) });
      if (result.error && result.verification !== "dropped") throw Object.assign(new Error(result.error), { code: result.error });
      const answered = result.verification === "passed" || result.verification === "repaired";
      // A refused answer keeps the 导读 there was; an empty one says the source supports none.
      await database.transaction(async (/** @type {any} */ client) => {
        await client.query(`UPDATE evimed_frontier.items SET lead_zh = CASE WHEN $5::boolean THEN $2 ELSE lead_zh END, lead_basis = $3, lead_at = clock_timestamp(),
          lead_version = $4 WHERE id = $1`, [row.id, result.lead, texts.reader_tidy.sha, FRONTIER_LEAD_VERSION, answered]);
        await bumpFrontierVersion(client);
      });
      if (!answered) summary.lead.kept += 1;
      else if (result.lead) summary.lead.written += 1;
      else summary.lead.emptied += 1;
    });
  }

  if (steps.includes("brief")) {
    // No 要点 from the reports of a paper (c3-primary), as the pipeline: the 导读 alone says whose reports it rests on.
    const rows = (await owing(`(i.brief_version IS DISTINCT FROM $5 OR i.brief_basis IS NULL
      OR i.brief_basis NOT LIKE (t.reader_tidy->>'sha') || ':%') AND t.reader_tidy->>'source' <> 'reports'`, FRONTIER_BRIEF_VERSION)).filter((row) => frontierBriefWanted(genreOf(row)));
    summary.brief = { items: rows.length, byGenre: genres(rows), written: 0, empty: 0 };
    calls.brief = rows.length;
    if (apply) await each(rows, async (row) => {
      const texts = await textsOf(row);
      const reader = frontierReaderText(texts);
      if (!reader || !texts?.reader_tidy?.sha) return;
      const genre = genreOf(row);
      const result = await frontierWriteBrief(editor, { genre, sourceName: sourceName(row), date: day(row), titleRaw: row.title_raw, titleZh: row.title_zh,
        text: reader.text, kind: reader.source, post: row.platform === "x" });
      if (result.error) throw Object.assign(new Error(result.error), { code: result.error });
      await database.transaction(async (/** @type {any} */ client) => {
        await client.query(`UPDATE evimed_frontier.items SET brief = $2::jsonb, brief_basis = $3, brief_at = clock_timestamp(), brief_version = $4 WHERE id = $1`,
          [row.id, result.brief ? JSON.stringify(result.brief) : null, `${texts.reader_tidy.sha}:${genre}`, FRONTIER_BRIEF_VERSION]);
        if (result.brief) await bumpFrontierVersion(client);
      });
      if (result.brief) summary.brief.written += 1;
      else summary.brief.empty += 1;
    });
  }

  if (steps.includes("reason")) {
    const rows = await owing("i.reason_version IS DISTINCT FROM $5 AND i.editor_version IS NOT NULL", FRONTIER_REASON_VERSION);
    summary.reason = { items: rows.length, byGenre: genres(rows), written: 0, emptied: 0, kept: 0 };
    calls.reason = rows.length;
    if (apply) await each(rows, async (row) => {
      const texts = await textsOf(row);
      const reader = frontierReaderText(texts);
      if (!reader) return;
      const result = await editor.writeReason({ genre: genreOf(row), sourceName: sourceName(row), titleRaw: row.title_raw, titleZh: row.title_zh,
        summaryZh: row.summary_zh, text: reader.text });
      if (result.error && result.verification !== "dropped") throw Object.assign(new Error(result.error), { code: result.error });
      const answered = result.verification === "passed" || result.verification === "repaired";
      await database.transaction(async (/** @type {any} */ client) => {
        await client.query("UPDATE evimed_frontier.items SET reason_zh = CASE WHEN $4::boolean THEN $2 ELSE reason_zh END, reason_version = $3 WHERE id = $1",
          [row.id, result.reason, FRONTIER_REASON_VERSION, answered]);
        await bumpFrontierVersion(client);
      });
      if (!answered) summary.reason.kept += 1;
      else if (result.reason) summary.reason.written += 1;
      else summary.reason.emptied += 1;
    });
  }
  /**
   * The reader-worthy items of a study genre one of the c3-faith steps still owes, oldest first: `owed` a predicate over `i` and `t`
   * with the version, when given, as `$5`; `extra` more columns. @param {string} owed @param {string | null} version @param {string} [extra]
   */
  const studyOwing = async (owed, version = null, extra = "") => (await database.query(`SELECT ${ITEM_FIELDS}, i.lead_zh, i.brief, i.study_facts${extra}
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id JOIN evimed_frontier.item_texts t ON t.item_id = i.id
      WHERE i.state = 'published' AND i.visible_at >= $1 AND i.visible_at < $2 AND t.reader_tidy IS NOT NULL
        AND t.reader_tidy->>'source' <> 'reports' AND (i.selected OR i.safety_alert OR i.score_total >= $3) AND ${owed}
      ORDER BY i.visible_at, i.id LIMIT $4`, [since, until, worthy, limit, ...(version === null ? [] : [version])])).rows
    .filter((row) => frontierStudyFactsWanted(genreOf(row)));
  /** What the facts call reads. @param {any} row @param {{ text: string, source: any }} reader */
  const factsInput = (row, reader) => ({ sourceName: sourceName(row), date: day(row), titleRaw: row.title_raw, text: reader.text, kind: reader.source });
  /** A coded error out of a step's work (counted as failed by `each`). @param {string} code */
  const coded = (code) => Object.assign(new Error(code), { code });

  // The version is a hash of the instructions (letters, digits, dots and dashes): written into the predicate, which both steps share.
  if (!/^[a-z0-9.-]+$/.test(FRONTIER_STUDY_FACTS_VERSION)) throw new Error("the study facts version is not a plain word");
  const factsOwed = `(i.study_facts IS NULL OR i.study_facts->>'basis' IS DISTINCT FROM t.reader_tidy->>'sha'
    OR i.study_facts_version IS DISTINCT FROM '${FRONTIER_STUDY_FACTS_VERSION}')`;
  if (steps.includes("facts")) {
    const rows = await studyOwing(factsOwed);
    summary.facts = { items: rows.length, byGenre: genres(rows), written: 0, empty: 0 };
    calls.facts = rows.length;
    if (apply) await each(rows, async (row) => {
      const texts = await textsOf(row);
      const reader = frontierReaderText(texts);
      const sha = texts?.reader_tidy?.sha;
      if (!reader || !sha) return;
      const ensured = await frontierEnsureStudyFacts(editor, { stored: row.study_facts, sha, input: factsInput(row, reader) });
      if (ensured.error) throw coded(ensured.error);
      if (!ensured.fresh) return;
      await frontierWriteFaith(database, row.id, { facts: ensured.record, diagnostic: null }, new Date());
      if (ensured.record.empty) summary.facts.empty += 1;
      else summary.facts.written += 1;
    });
  }

  if (steps.includes("faith")) {
    // A text is owed a check when it was never checked by these instructions, its check could not be made, or it was written after it.
    const owedText = (/** @type {"lead" | "brief"} */ kind) => `(i.${kind === "lead" ? "lead_zh" : "brief"} IS NOT NULL
      AND (i.editor_diagnostics->'faith'->'${kind}'->>'version' IS DISTINCT FROM $5 OR i.editor_diagnostics->'faith'->'${kind}'->>'outcome' = 'unchecked'
        OR coalesce((i.editor_diagnostics->'faith'->'${kind}'->>'at')::timestamptz < i.${kind}_at, true)))`;
    // A card summary has no write time of its own: its record names the text it was made on (`md5(summary_zh)`).
    const owedSummary = `(coalesce(i.summary_zh, '') <> '' AND (i.editor_diagnostics->'faith'->'summary'->>'version' IS DISTINCT FROM $5
      OR i.editor_diagnostics->'faith'->'summary'->>'outcome' = 'unchecked' OR i.editor_diagnostics->'faith'->'summary'->>'basis' IS DISTINCT FROM md5(i.summary_zh)))`;
    const rows = await studyOwing(`(${owedText("lead")} OR ${owedText("brief")} OR ${owedSummary})
        AND NOT coalesce(i.study_facts->>'basis' = t.reader_tidy->>'sha' AND (i.study_facts->>'empty')::boolean, false)`,
    FRONTIER_FAITH_VERSION, `, i.entities, i.tags, ${owedText("lead")} AS lead_owed, ${owedText("brief")} AS brief_owed, ${owedSummary} AS summary_owed,
      ${factsOwed} AS facts_owed`);
    /** @type {Record<string, number>} */
    const outcomes = {};
    summary.faith = { items: rows.length, byGenre: genres(rows), texts: 0, outcomes, changed: 0, facts: 0, noFacts: 0, raced: 0 };
    calls.faith = rows.reduce((total, row) => total + (row.lead_owed ? 1 : 0) + (row.brief_owed ? 1 : 0) + (row.summary_owed ? 1 : 0), 0);
    // Facts the faith step makes itself (in a report with the facts step, that step has counted them).
    if (!steps.includes("facts")) calls.facts = rows.filter((row) => row.facts_owed).length;
    if (apply) await each(rows, async (row) => {
      const texts = await textsOf(row);
      const reader = frontierReaderText(texts);
      const sha = texts?.reader_tidy?.sha;
      if (!reader || !sha) return;
      // The texts as they are now: the step's list was read when it began, and the pipeline may have written since.
      const now = (await database.query("SELECT lead_zh, brief, summary_zh, study_facts FROM evimed_frontier.items WHERE id = $1", [row.id])).rows[0];
      if (!now) return;
      const input = factsInput(row, reader);
      const ensured = await frontierEnsureStudyFacts(editor, { stored: now.study_facts, sha, input });
      if (ensured.error) throw coded(ensured.error);
      const facts = ensured.fresh ? ensured.record : null;
      if (facts) summary.faith.facts += 1;
      if (!ensured.view) {
        // No facts the source states: nothing to read a text against, and the empty record keeps the item from being asked again.
        if (facts) await frontierWriteFaith(database, row.id, { facts, diagnostic: null }, new Date());
        summary.faith.noFacts += 1;
        return;
      }
      const genre = genreOf(row);
      const writing = { sourceName: input.sourceName, date: input.date, titleRaw: row.title_raw, titleZh: row.title_zh, text: reader.text,
        kind: reader.source, post: row.platform === "x", genre };
      const source = faithSource(input);
      /** @type {Record<string, any>} */
      const diagnostic = {};
      const checked = { lead: now.lead_zh, brief: now.brief, card: now.summary_zh };
      let { lead, brief, card } = checked;
      const tally = (/** @type {"lead" | "brief" | "summary"} */ kind, /** @type {any} */ result, record = faithDiagnostic(result)) => {
        diagnostic[kind] = record;
        outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
        summary.faith.texts += 1;
        if (result.error) throw coded(result.error);
      };
      let failure = null;
      try {
        if (row.lead_owed && lead) {
          const run = await frontierFaithCheckLead(editor, { facts: ensured.view, lead, previous: null, source,
            input: { ...writing, briefed: frontierBriefWanted(genre) } });
          lead = run.lead;
          tally("lead", run.result);
        }
        if (row.brief_owed && brief) {
          const run = await frontierFaithCheckBrief(editor, { facts: ensured.view, brief, previous: null, source, input: writing });
          brief = run.brief;
          tally("brief", run.result);
        }
        if (row.summary_owed && card) {
          const run = await frontierFaithCheckSummary(editor, { facts: ensured.view, summary: card, source });
          card = run.summary;
          tally("summary", run.result, run.diagnostic);
        }
      } catch (error) {
        // The outcome of what was checked is still kept (an unchecked text is asked about again next run); the item counts as failed.
        failure = error;
      }
      const changed = lead !== checked.lead || JSON.stringify(brief) !== JSON.stringify(checked.brief) || card !== checked.card;
      const written = await database.transaction(async (/** @type {any} */ client) => {
        // Nothing written over a text the pipeline wrote while this one was read: the check is of the text it read.
        const current = (await client.query("SELECT lead_zh, brief, summary_zh FROM evimed_frontier.items WHERE id = $1 FOR UPDATE", [row.id])).rows[0];
        if (!current || current.lead_zh !== checked.lead || JSON.stringify(current.brief) !== JSON.stringify(checked.brief) || current.summary_zh !== checked.card) return false;
        if (card !== checked.card) {
          await client.query("UPDATE evimed_frontier.items SET summary_zh = $2, lexemes = $3::tsvector WHERE id = $1",
            [row.id, card, tsvectorLiteral(frontierLexemeText({ ...row, summary_zh: card }))]);
          await client.query("INSERT INTO evimed_frontier.item_changes (item_id, op, reason) VALUES ($1, 'upsert', 'faith')", [row.id]);
        }
        if (lead !== checked.lead) await client.query("UPDATE evimed_frontier.items SET lead_zh = $2 WHERE id = $1", [row.id, lead]);
        if (JSON.stringify(brief) !== JSON.stringify(checked.brief)) {
          await client.query("UPDATE evimed_frontier.items SET brief = $2::jsonb WHERE id = $1", [row.id, brief ? JSON.stringify(brief) : null]);
        }
        await frontierWriteFaith(client, row.id, { facts, diagnostic }, new Date());
        if (changed) await bumpFrontierVersion(client);
        return true;
      });
      if (!written) { summary.faith.raced += 1; return; }
      if (changed) summary.faith.changed += 1;
      if (failure) throw failure;
    });
  }

  summary.calls = calls;
  onProgress(`frontier-rewrite: done${summary.stopped ? ` (stopped: ${summary.stopped})` : ""}`);
  return summary;
}

/** @param {unknown} error */
function codeOf(error) {
  const code = /** @type {any} */ (error)?.code;
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,80}$/.test(code) ? code : "frontier_rewrite_failed";
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { REFERENCE_PRICE_LIST }, { FrontierEditor }, { FrontierPipeline, frontierSelectThreshold }, { UsageLedger },
    { ensureFrontierProject }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("@evimed/domain"),
    import("../../apps/server/src/frontierEditor.mjs"),
    import("../../apps/server/src/frontierPipeline.mjs"),
    import("../../apps/server/src/usageLedger.mjs"),
    import("../../apps/server/src/frontierWorker.mjs"),
  ]);
  const config = loadConfig();
  const report = (/** @type {Record<string, unknown>} */ value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (!config.frontierEnabled) { report({ ok: false, reason: "OPEN_SCIENCE_FRONTIER_ENABLED is false; there is no feed to write" }); process.exitCode = 1; return; }
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    if (!database) { report({ ok: false, reason: "no control-plane database" }); process.exitCode = 1; return; }
    const usageLedger = new UsageLedger(database);
    const editor = new FrontierEditor(config, { usageLedger });
    if (options.apply) editor.owner = await ensureFrontierProject({ store, config });
    if (options.apply && !editor.available) {
      report({ ok: false, reason: "the frontier editor is not configured (DeepSeek key or operator account); nothing can be asked" });
      process.exitCode = 1;
      return;
    }
    const pipeline = new FrontierPipeline({ database, editor, plugin: { text: async () => ({ status: "pending" }) }, embedder: null, config });
    const until = new Date();
    const since = options.since ?? new Date(until.getTime() - options.days * DAY_MS);
    await database.withClient(async (/** @type {any} */ lock) => {
      const acquired = await lock.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [REWRITE_LOCK]);
      if (!acquired.rows[0]?.acquired) { report({ ok: false, reason: "another rewrite of the frontier feed is running" }); process.exitCode = 1; return; }
      try {
        const started = Date.now();
        const summary = await frontierRewrite({ database, editor, budget: () => pipeline.budget(new Date()), threshold: frontierSelectThreshold(config),
          since, until, steps: options.steps, apply: options.apply, limit: options.limit, concurrency: options.concurrency, minOldTotal: options.minOldTotal,
          timeZone: String(config.frontierTimeZone || "Asia/Shanghai"), onProgress: (line) => process.stderr.write(`${line}\n`) });
        const estimate = options.apply ? null : estimateRewriteCost(summary.calls, REFERENCE_PRICE_LIST.model["deepseek-flash"]);
        report({ ok: summary.failed === 0 && summary.stopped === null, ...summary, ...(estimate ? { estimate } : {}),
          budget: await pipeline.budget(new Date()).catch((/** @type {unknown} */ error) => ({ error: codeOf(error) })), ms: Date.now() - started });
        if (summary.failed || summary.stopped) process.exitCode = 1;
      } finally {
        await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [REWRITE_LOCK]);
      }
    });
  } finally {
    await store.close?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${codeOf(error)}: ${/** @type {any} */ (error)?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
