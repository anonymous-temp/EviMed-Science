#!/usr/bin/env node
/**
 * Write the last month of 「前沿动态」 again the way each genre is written (ct-write, 2026-10-24): every published item's genre, and —
 * for the items whose reader is read (精选, safety alerts, items within `FRONTIER_READER_MARGIN` of the selection line) — its 导读, its
 * 「AI 要点」 and its 推荐理由 with the prompts that ship.
 *
 *   node scripts/ops/frontier-rewrite.mjs                   report: what each step would do, by genre, and what asking would cost
 *   node scripts/ops/frontier-rewrite.mjs --apply           do it, within the module's day budget
 *   options: --days N (1–30, default 30), --since ISO (instead of --days: where a stopped run resumes),
 *            --steps genre,lead,brief,reason,facts,faith (default all six, in that order), --concurrency N (1–8, default 4), --limit N
 *
 * The steps:
 * - `genre`: an item with no stored genre takes code's answer (`frontierGenreFallback`) where code is sure of it or its fields say
 *   it (a journal's paper, a registry's trial, a safety feed's notice …); where code fell back on the channel alone
 *   (`FRONTIER_REWRITE_UNSURE`: news, commentary, industry, policy) the model names it, `FRONTIER_GENRE_BATCH` items to a call, and
 *   `frontierGenreDecision` stores the answer. No call is needed for most items.
 * - `lead`: a reader-worthy item whose 导读 an older prompt wrote (`lead_version`) is written again from its settled reader text, by its
 *   genre and, where it has 要点, held shorter (`frontierWriteLead`). An answer the checks refused keeps the 导读 there was.
 * - `brief`: a reader-worthy item whose 要点 are missing or older (`brief_version`, `brief_basis`) gets them (`frontierWriteBrief`).
 * - `reason`: a reader-worthy item whose 推荐理由 an older prompt wrote (`reason_version`) gets one through its genre's lens without
 *   being edited again (`FrontierEditor#writeReason`) — an edit would score and select it again. A refused answer keeps the old one.
 * - `facts` (c3-faith): a reader-worthy item of a study genre (paper, preprint, trial, conference) whose study facts were not made from
 *   its settled reader text gets them (`frontierEnsureStudyFacts`: each field anchored to a quotation code found, or an empty record).
 * - `faith` (c3-faith): a reader-worthy study item whose 导读 or 要点 was written after its last check, or never checked by these
 *   instructions, or whose check could not be made, is read against its study facts (made now when missing) the way the pipeline reads
 *   a new one (`frontierFaithCheckLead` / `frontierFaithCheckBrief`): a mismatch goes back to the writer once, a sentence or point that
 *   still mismatches is left out, and a text with nothing left is cleared (the reader shows the card's summary). The record is
 *   `editor_diagnostics.faith`, never a note on the page. An item whose text has an empty facts record is not asked about again.
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

import { FRONTIER_GENRES, agendaLocalDate, frontierGenreDecision, frontierGenreFallback, frontierSourceDisplayName, isFrontierGenre }
  from "@evimed/domain";
import { FRONTIER_BRIEF_VERSION, frontierBriefWanted, frontierWriteBrief } from "../../apps/server/src/frontierBrief.mjs";
import { FRONTIER_FAITH_VERSION, FRONTIER_STUDY_FACTS_VERSION, faithDiagnostic, faithSource, frontierEnsureStudyFacts, frontierFaithCheckBrief,
  frontierFaithCheckLead, frontierStudyFactsWanted, frontierWriteFaith } from "../../apps/server/src/frontierFaithStep.mjs";
import { FRONTIER_GENRE_BATCH, FRONTIER_REASON_VERSION } from "../../apps/server/src/frontierEditor.mjs";
import { FRONTIER_LEAD_VERSION, frontierWriteLead } from "../../apps/server/src/frontierLead.mjs";
import { bumpFrontierVersion } from "../../apps/server/src/frontierPersistence.mjs";
import { FRONTIER_READER_MARGIN, frontierReaderText } from "../../apps/server/src/frontierPipeline.mjs";

const DAY_MS = 24 * 3_600_000;
const REWRITE_LOCK = "evimed-frontier-rewrite";
export const FRONTIER_REWRITE_STEPS = Object.freeze(["genre", "lead", "brief", "reason", "facts", "faith"]);
/** Genres code reached from the channel alone: the model names these (the rest are code's answer, from what the fields say). */
export const FRONTIER_REWRITE_UNSURE = Object.freeze(["news", "commentary", "industry", "policy"]);
/**
 * What one call measured on the frontier-writing eval (2026-10-24, deepseek-flash, 48 real items: 159 calls, 343 k prompt tokens from
 * the provider's cache, 103 k not, 42 k output): per call, the cached prefix, the rest of the prompt and the output. A genre call
 * carries `FRONTIER_GENRE_BATCH` items.
 */
export const REWRITE_CALL_TOKENS = Object.freeze({
  genre: { cached: 900, prompt: 1_400, output: 150 },
  lead: { cached: 1_000, prompt: 2_600, output: 260 },
  brief: { cached: 1_000, prompt: 2_800, output: 520 },
  reason: { cached: 700, prompt: 1_900, output: 120 },
  // c3-faith's eval (2026-10-25) measured CNY 0.0031 a facts call and 0.0011–0.0017 a check, with the provider's cache warm on repeated
  // items; these sizes assume the text itself is not cached, so the report errs high. A `faith` call is one text checked.
  facts: { cached: 900, prompt: 2_600, output: 290 },
  faith: { cached: 800, prompt: 600, output: 150 },
});

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { apply: false, days: 30, since: /** @type {Date | null} */ (null), steps: [...FRONTIER_REWRITE_STEPS], concurrency: 4, limit: 100_000 };
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
    else if (argument === "--steps") {
      const steps = String(argv[++index] ?? "").split(",").map((step) => step.trim()).filter(Boolean);
      if (!steps.length || steps.some((step) => !FRONTIER_REWRITE_STEPS.includes(step))) throw new Error(`--steps takes ${FRONTIER_REWRITE_STEPS.join(",")}`);
      options.steps = FRONTIER_REWRITE_STEPS.filter((step) => steps.includes(step));
    } else if (argument === "--since") {
      const since = new Date(String(argv[++index] ?? ""));
      if (!Number.isFinite(since.getTime())) throw new Error("--since must be an ISO time");
      options.since = since;
    } else throw new Error(`unknown argument ${argument}; the options are --apply, --days N, --since ISO, --steps a,b, --concurrency N, --limit N`);
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
  i.safety_alert, i.lane, i.genre, i.genre_basis, i.selected, i.score_total, i.published_at, i.visible_at, i.primary_source_id,
  s.name AS source_name, s.owner_entity AS source_owner`;

/**
 * Report, and with `apply` make, the steps over the published items of `[since, until)`, oldest first.
 * @param {{ database: any, editor?: any, budget?: (() => Promise<{ state: string }>) | null, threshold: number, since: Date, until?: Date,
 *   steps?: string[], apply?: boolean, limit?: number, concurrency?: number, timeZone?: string, onProgress?: (line: string) => void }} input
 */
export async function frontierRewrite({ database, editor = null, budget = null, threshold, since, until = new Date(), steps = [...FRONTIER_REWRITE_STEPS],
  apply = false, limit = 100_000, concurrency = 4, timeZone = "Asia/Shanghai", onProgress = () => {} }) {
  const worthy = threshold - FRONTIER_READER_MARGIN;
  /** @type {Record<string, any>} */
  const summary = { applied: apply, since: since.toISOString(), until: until.toISOString(), steps, versions: { lead: FRONTIER_LEAD_VERSION,
    brief: FRONTIER_BRIEF_VERSION, reason: FRONTIER_REASON_VERSION, facts: FRONTIER_STUDY_FACTS_VERSION, faith: FRONTIER_FAITH_VERSION },
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
  const sourceName = (/** @type {any} */ row) => frontierSourceDisplayName({ id: row.primary_source_id, name: row.source_name ?? row.primary_source_id, ownerEntity: row.source_owner });
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
    const rows = (await owing(`(i.brief_version IS DISTINCT FROM $5 OR i.brief_basis IS NULL
      OR i.brief_basis NOT LIKE (t.reader_tidy->>'sha') || ':%')`, FRONTIER_BRIEF_VERSION)).filter((row) => frontierBriefWanted(genreOf(row)));
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
        AND (i.selected OR i.safety_alert OR i.score_total >= $3) AND ${owed}
      ORDER BY i.visible_at, i.id LIMIT $4`, [since, until, worthy, limit, ...(version === null ? [] : [version])])).rows
    .filter((row) => frontierStudyFactsWanted(genreOf(row)));
  /** What the facts call reads. @param {any} row @param {{ text: string, source: any }} reader */
  const factsInput = (row, reader) => ({ sourceName: sourceName(row), date: day(row), titleRaw: row.title_raw, text: reader.text, kind: reader.source });
  /** A coded error out of a step's work (counted as failed by `each`). @param {string} code */
  const coded = (code) => Object.assign(new Error(code), { code });

  const factsOwed = "(i.study_facts IS NULL OR i.study_facts->>'basis' IS DISTINCT FROM t.reader_tidy->>'sha')";
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
    const rows = await studyOwing(`(${owedText("lead")} OR ${owedText("brief")})
        AND NOT coalesce(i.study_facts->>'basis' = t.reader_tidy->>'sha' AND (i.study_facts->>'empty')::boolean, false)`,
    FRONTIER_FAITH_VERSION, `, ${owedText("lead")} AS lead_owed, ${owedText("brief")} AS brief_owed, ${factsOwed} AS facts_owed`);
    /** @type {Record<string, number>} */
    const outcomes = {};
    summary.faith = { items: rows.length, byGenre: genres(rows), texts: 0, outcomes, changed: 0, facts: 0, noFacts: 0 };
    calls.faith = rows.reduce((total, row) => total + (row.lead_owed ? 1 : 0) + (row.brief_owed ? 1 : 0), 0);
    // Facts the faith step makes itself (in a report with the facts step, that step has counted them).
    if (!steps.includes("facts")) calls.facts = rows.filter((row) => row.facts_owed).length;
    if (apply) await each(rows, async (row) => {
      const texts = await textsOf(row);
      const reader = frontierReaderText(texts);
      const sha = texts?.reader_tidy?.sha;
      if (!reader || !sha) return;
      const input = factsInput(row, reader);
      const ensured = await frontierEnsureStudyFacts(editor, { stored: row.study_facts, sha, input });
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
      let { lead_zh: lead, brief } = row;
      const tally = (/** @type {"lead" | "brief"} */ kind, /** @type {any} */ result) => {
        diagnostic[kind] = faithDiagnostic(result);
        outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
        summary.faith.texts += 1;
        if (result.error) throw coded(result.error);
      };
      let failure = null;
      try {
        if (row.lead_owed) {
          const run = await frontierFaithCheckLead(editor, { facts: ensured.view, lead, previous: null, source,
            input: { ...writing, briefed: frontierBriefWanted(genre) } });
          lead = run.lead;
          tally("lead", run.result);
        }
        if (row.brief_owed) {
          const run = await frontierFaithCheckBrief(editor, { facts: ensured.view, brief, previous: null, source, input: writing });
          brief = run.brief;
          tally("brief", run.result);
        }
      } catch (error) {
        // The outcome of what was checked is still kept (an unchecked text is asked about again next run); the item counts as failed.
        failure = error;
      }
      const changed = lead !== row.lead_zh || JSON.stringify(brief) !== JSON.stringify(row.brief);
      await database.transaction(async (/** @type {any} */ client) => {
        if (lead !== row.lead_zh) await client.query("UPDATE evimed_frontier.items SET lead_zh = $2 WHERE id = $1", [row.id, lead]);
        if (JSON.stringify(brief) !== JSON.stringify(row.brief)) {
          await client.query("UPDATE evimed_frontier.items SET brief = $2::jsonb WHERE id = $1", [row.id, brief ? JSON.stringify(brief) : null]);
        }
        await frontierWriteFaith(client, row.id, { facts, diagnostic }, new Date());
        if (changed) await bumpFrontierVersion(client);
      });
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
          since, until, steps: options.steps, apply: options.apply, limit: options.limit, concurrency: options.concurrency,
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
