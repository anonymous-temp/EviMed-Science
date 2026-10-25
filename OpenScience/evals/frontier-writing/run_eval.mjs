#!/usr/bin/env node
/**
 * The frontier feed's writing by genre as an eval (ct-write, 2026-10-24; principle 6): real published items, three or four of
 * each genre (`cases.json`), written with the prompts that ship — the edit (genre, card summary, 推荐理由), the 导读 and the
 * 「AI 要点」 — through the platform's own `FrontierEditor` on deepseek-flash, and measured in code against what production wrote
 * before (`before`). Nothing here is judged by a model.
 *
 *   node evals/frontier-writing/run_eval.mjs --key-file <path> [--only <case-id>] [--genre <genre>] [--sample-kind <kind>] [--limit N]
 *       [--concurrency 4] [--max-cny 3] [--skip-edit] [--out <file>]
 *   node evals/frontier-writing/run_eval.mjs --rescore <run.json> [--out <file>]   (measure a run again, no model call)
 *
 * What is measured (`metricsOf`), per case and per genre, before and after:
 * - numbers: every number of a written text found in the source (`checkNumbers` over the title and the text — not the source's
 *   name or a date line);
 * - verbatim: a quotation is a run of the source's own words (`quotationForm` substring);
 * - formula openings: a 推荐理由 that opens with one of `FORMULA_OPENINGS` (a closed list, a metric only);
 * - absence sentences: phrases of `ABSENCE_PHRASES` (a closed list, a metric only) — a sentence about what the source does not say;
 * - length against the source: a 导读's characters against what its source supports (`frontierLeadLimit`);
 * - field coverage: the 要点 fields written of those the genre has, and why each dropped part was dropped;
 * - genre: the edit's genre, code's decision, and whether it is one the case accepts;
 * - style (c2-style, `style_metrics.mjs`): sentence architecture and the lieflat tells of the 导读 and of all prose, the title's
 *   features (hooks, a site's name, named subject, result verb) and whether a Chinese source's title was kept, absolute numbers and
 *   harms given → used, exemplar leakage, and the edit's sub-scores per genre (raw and on the scale).
 * The swapped-order pairwise judge of two runs is `judge.mjs`; move coverage of the 导读 is `moves_report.mjs` (a notice metric).
 * Tokens and a cost at the reference price (`deepseek-flash`) are counted and the run stops at `--max-cny`. The key is read from
 * the file inside this process and never printed; nothing is metered (no usage ledger) and nothing is written but the result file.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FRONTIER_GENRES, FRONTIER_LANES, FRONTIER_SOURCE_TYPE_LABELS_ZH, frontierGenreDecision, frontierGenreFallback } from "../../packages/domain/index.mjs";
import { FRONTIER_BRIEF_FIELDS, FRONTIER_BRIEF_VERSION, frontierBriefWanted, frontierWriteBrief, quotationForm } from "../../apps/server/src/frontierBrief.mjs";
import { FRONTIER_EDITOR_VERSION, FRONTIER_REASON_VERSION, FrontierEditor, isChineseTitle, readerNumberSource } from "../../apps/server/src/frontierEditor.mjs";
import { FRONTIER_LEAD_VERSION, buildLeadInput, frontierLeadLimit, frontierWriteLead } from "../../apps/server/src/frontierLead.mjs";
import { checkNumbers } from "../../apps/server/src/frontierNumbers.mjs";
import { callModelForControlPlane } from "../../apps/server/src/modelGateway.mjs";
import { RESULT_GENRES, adviceAdded, givenUsed, leakage, proseStyle, scoreDistribution, styleRates, titleFeatures, titleHook } from "./style_metrics.mjs";

/** The style cards' exemplars (none before the cards exist), for the leakage count. */
const EXEMPLARS = await import("../../apps/server/src/frontierStyle.mjs").then((module) => module.frontierStyleExemplarTexts(), () => []);

/** Openings of a 推荐理由 that say nothing (measured on production 2026-10-24: ~70% of reasons). A metric, never a check. */
export const FORMULA_OPENINGS = Object.freeze(["可了解", "可帮助", "可据此", "有助于", "帮助", "可为", "可供", "为临床", "提示", "了解"]);
/** Sentences about what a source does not say (「原文仅…未列出…」). A metric, never a check. */
export const ABSENCE_PHRASES = Object.freeze(["未提及", "未披露", "未说明", "未给出", "未列出", "未报告", "未公布", "尚不清楚", "原文仅", "材料中没有",
  "没有提供", "未提供", "未明确", "仍需验证", "有待观察", "有待进一步", "未涉及", "未包含", "未写明"]);
/** The reference price of deepseek-flash, CNY per million tokens (`@evimed/domain` metering). */
const PRICE = Object.freeze({ cacheHit: 0.04, cacheMiss: 2, output: 8 });

const here = dirname(fileURLToPath(import.meta.url));

/** @param {string | null | undefined} text */
const chars = (text) => [...String(text ?? "")].length;
/** @param {string | null | undefined} text */
const absences = (text) => ABSENCE_PHRASES.filter((phrase) => String(text ?? "").includes(phrase));
/** @param {string | null | undefined} text */
const formulaOpening = (text) => FORMULA_OPENINGS.find((phrase) => String(text ?? "").startsWith(phrase)) ?? null;

/**
 * What one case's texts measure, against its source.
 * @param {{ lead?: string | null, reason?: string | null, summary?: string | null, brief?: any, title?: string | null }} written
 * @param {{ source: string, limit: number, genre: string, titleRaw?: string, chinese?: boolean }} context
 */
export function metricsOf(written, { source, limit, genre, titleRaw = "", chinese = false }) {
  const numbers = checkNumbers({ lead: written.lead ?? "", reason: written.reason ?? "", summary: written.summary ?? "",
    brief: briefText(written.brief) }, source);
  const shape = FRONTIER_BRIEF_FIELDS[/** @type {keyof typeof FRONTIER_BRIEF_FIELDS} */ (genre)] ?? null;
  const fields = shape ? shape.points.length + (shape.quote ? 1 : 0) : 0;
  const present = written.brief ? (written.brief.points?.length ?? 0) + (written.brief.quote ? 1 : 0) : 0;
  return {
    leadChars: chars(written.lead), leadLimit: limit, leadOverLimit: chars(written.lead) > limit,
    summaryChars: chars(written.summary), reasonChars: chars(written.reason),
    reasonFormula: formulaOpening(written.reason), reasonEmpty: !written.reason,
    absences: [...absences(written.lead), ...absences(written.reason), ...absences(written.summary), ...absences(briefText(written.brief))],
    numbersChecked: numbers.checked, numbersMissing: numbers.missing.map((entry) => `${entry.field}:${entry.raw}`),
    briefFields: fields, briefPresent: present, briefCoverage: fields ? Math.round((present / fields) * 100) / 100 : null,
    quoteVerbatim: written.brief?.quote ? quotationForm(source).includes(quotationForm(written.brief.quote.text)) : null,
    leadStyle: proseStyle(written.lead ?? ""),
    proseStyle: proseStyle([written.lead, written.summary, written.reason, briefText(written.brief)].filter(Boolean).join("\n")),
    title: written.title ? { ...titleFeatures(written.title), chinese, kept: chinese ? written.title === titleRaw : null,
      numbersMissing: checkNumbers({ title: written.title }, `${titleRaw}\n${source}`).missing.map((entry) => entry.raw) } : null,
    givenUsed: RESULT_GENRES.includes(genre) ? givenUsed(source, [written.lead ?? "", briefText(written.brief)].join("\n")) : null,
    leakage: leakage([written.title, written.lead, written.summary, written.reason, briefText(written.brief)].filter(Boolean).join("\n"), `${titleRaw}\n${source}`, EXEMPLARS),
    advice: adviceAdded([written.lead, written.summary, briefText(written.brief)].filter(Boolean).join("\n"), source),
  };
}

/** A brief's words, for the number and absence counts. @param {any} brief */
function briefText(brief) {
  if (!brief) return "";
  return [...(brief.points ?? []).flatMap((point) => [point.text ?? "", ...(point.items ?? [])]), brief.quote?.zh ?? ""].join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      "key-file": { type: "string", default: resolve(here, "../../../.evimed-local/secrets/deepseek.api-key") },
      only: { type: "string" },
      genre: { type: "string" },
      "sample-kind": { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string", default: "4" },
      "max-cny": { type: "string", default: "3" },
      "skip-edit": { type: "boolean", default: false },
      out: { type: "string" },
      rescore: { type: "string" },
    },
  });
  // Measure a result file again with this file's metrics (no model call): the texts are in it, the sources in cases.json.
  if (values.rescore) {
    const run = JSON.parse(await readFile(values.rescore, "utf8"));
    const { cases } = JSON.parse(await readFile(join(here, "cases.json"), "utf8"));
    const byId = new Map(cases.map((/** @type {any} */ entry) => [entry.id, entry]));
    for (const row of run.results) {
      const entry = byId.get(row.id);
      if (!entry || !row.after) continue;
      const item = entry.item;
      const chinese = isChineseTitle(item.titleRaw);
      const input = { sourceName: item.sourceName, titleRaw: item.titleRaw, titleZh: row.after.title ?? item.titleZh ?? null, text: entry.text, kind: entry.textSource, post: item.platform === "x" };
      const source = readerNumberSource(buildLeadInput(input));
      const limit = frontierLeadLimit(entry.text);
      row.metrics = { before: metricsOf({ ...entry.before, title: item.titleZh ?? (chinese ? item.titleRaw : null) }, { source, limit, genre: entry.expectGenre, titleRaw: item.titleRaw, chinese }),
        after: metricsOf(row.after, { source, limit, genre: row.after.genre, titleRaw: item.titleRaw, chinese }) };
    }
    run.summary = summarize(run.results);
    const out = values.out ?? values.rescore;
    await writeFile(out, `${JSON.stringify(run, null, 1)}\n`);
    process.stdout.write(`${JSON.stringify({ out, summary: run.summary.all }, null, 1)}\n`);
    return;
  }
  const apiKey = (await readFile(values["key-file"], "utf8")).trim();
  if (!apiKey) throw new Error("The DeepSeek key file is empty.");
  const maxCny = Number(values["max-cny"]) || 3;
  const usage = { calls: 0, cacheHit: 0, cacheMiss: 0, output: 0, cny: 0 };
  /** The gateway's own call, counting what each answer says it used. @type {typeof callModelForControlPlane} */
  const callModel = async (context, call) => {
    if (usage.cny >= maxCny) throw Object.assign(new Error("The eval's spending limit is reached."), { code: "usage_budget_exceeded" });
    const body = await callModelForControlPlane(context, call);
    const used = body?.usage ?? {};
    const hit = Number(used.prompt_cache_hit_tokens ?? 0);
    const miss = Number(used.prompt_cache_miss_tokens ?? Math.max(0, Number(used.prompt_tokens ?? 0) - hit));
    const output = Number(used.completion_tokens ?? 0);
    usage.calls += 1; usage.cacheHit += hit; usage.cacheMiss += miss; usage.output += output;
    usage.cny = (usage.cacheHit * PRICE.cacheHit + usage.cacheMiss * PRICE.cacheMiss + usage.output * PRICE.output) / 1_000_000;
    return body;
  };
  const editor = new FrontierEditor({ deepseekProviderEnabled: true, deepseekApiKey: apiKey, deepseekBaseUrl: "https://api.deepseek.com",
    frontierModel: "deepseek-flash" }, { owner: { userId: "eval", projectId: "eval" }, callModel });
  const { cases } = JSON.parse(await readFile(join(here, "cases.json"), "utf8"));
  const wanted = cases.filter((/** @type {any} */ entry) => (!values.only || entry.id === values.only) && (!values.genre || entry.expectGenre === values.genre)
    && (!values["sample-kind"] || entry.sampleKind === values["sample-kind"]))
    .slice(0, values.limit ? Number(values.limit) : undefined);
  /** @type {any[]} */
  const results = [];
  const queue = [...wanted];
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      try { results.push(await runCase(editor, entry, values["skip-edit"])); }
      catch (error) { results.push({ id: entry.id, error: /** @type {any} */ (error)?.code ?? String(error) }); }
      process.stderr.write(`frontier-writing: ${results.length}/${wanted.length} ¥${usage.cny.toFixed(3)}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, Number(values.concurrency) || 4)) }, worker));
  results.sort((a, b) => wanted.findIndex((entry) => entry.id === a.id) - wanted.findIndex((entry) => entry.id === b.id));
  const summary = summarize(results);
  const out = values.out ?? join(here, "results", `run-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify({ at: new Date().toISOString(), model: "deepseek-flash",
    versions: { editor: FRONTIER_EDITOR_VERSION, lead: FRONTIER_LEAD_VERSION, brief: FRONTIER_BRIEF_VERSION, reason: FRONTIER_REASON_VERSION },
    usage: { ...usage, cny: Math.round(usage.cny * 1000) / 1000 }, summary, results }, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify({ out, usage: { ...usage, cny: Math.round(usage.cny * 1000) / 1000 }, summary }, null, 1)}\n`);
}

/**
 * One case: the edit (genre, summary, reason), then the 导读 and the 要点 with code's genre decision, and their measures before
 * and after.
 * @param {FrontierEditor} editor @param {any} entry @param {boolean} skipEdit
 */
async function runCase(editor, entry, skipEdit) {
  const item = entry.item;
  const row = { platform: item.platform, channel: item.channel, source_type: item.sourceType, evidence_type: item.evidenceType,
    flags: item.flags ?? [], lane: item.lane, safety_alert: item.lane === "safety" && item.sourceType === "regulator" };
  const fallback = frontierGenreFallback(row);
  const kind = entry.textSource;
  let edited = null;
  if (!skipEdit) {
    edited = await editor.edit({
      titleRaw: item.titleRaw, sourceName: item.sourceName, isChinese: isChineseTitle(item.titleRaw),
      // As the pipeline shows it: the source's kind beside its name (「媒体」「期刊」「监管」).
      sourceTypeLabel: /** @type {Record<string, string>} */ (FRONTIER_SOURCE_TYPE_LABELS_ZH)[item.sourceType] ?? undefined,
      allowedLanes: FRONTIER_LANES.filter((lane) => lane !== "mixed"), journal: item.journal ?? null, publicationTypes: item.publicationTypes ?? [],
      // A record with no text is edited from its entry's summary, as the pipeline does (c2-gaps G2, `textSource` summary).
      abstract: kind === "abstract" ? entry.text : null, summary: kind === "summary" ? entry.text : null,
      bodyExcerpt: kind === "abstract" || kind === "summary" ? null : entry.text.slice(0, 12_000),
      glossary: [], genreFixed: ["safety", "social", "trial", "preprint", "roundup"].includes(fallback) ? fallback : null,
      defaults: { lane: item.lane, specialties: [] },
    }, { singleAttempt: false });
  }
  const decided = frontierGenreDecision(row, edited?.output?.genre ?? null);
  const genre = decided.genre;
  const input = { sourceName: item.sourceName, titleRaw: item.titleRaw, titleZh: edited?.output?.titleZh ?? item.titleZh ?? null, text: entry.text,
    kind, post: item.platform === "x" };
  const [lead, brief] = await Promise.all([frontierWriteLead(editor, { ...input, genre, briefed: frontierBriefWanted(genre) }), frontierWriteBrief(editor, { ...input, genre })]);
  const source = readerNumberSource(buildLeadInput(input));
  const limit = frontierLeadLimit(entry.text);
  const chinese = isChineseTitle(item.titleRaw);
  const after = { genre, genreBasis: decided.basis, modelGenre: edited?.output?.genre ?? null, title: edited?.output?.titleZh ?? null,
    scores: edited?.output?.scores ?? null, scoresRaw: edited?.output?.scoresRaw ?? null,
    summary: edited?.output?.summaryZh ?? null, reason: edited?.output?.reasonZh ?? null, lead: lead.lead, brief: brief.brief,
    editVerification: edited?.verification ?? null, leadVerification: lead.verification, briefDropped: brief.dropped, briefError: brief.error };
  return {
    id: entry.id, expectGenre: entry.expectGenre, genreAccepted: entry.acceptGenres.includes(genre), textChars: entry.textChars, textSource: kind,
    before: entry.before, after,
    metrics: { before: metricsOf({ ...entry.before, title: item.titleZh ?? (chinese ? item.titleRaw : null) }, { source, limit, genre: entry.expectGenre, titleRaw: item.titleRaw, chinese }),
      after: metricsOf(after, { source, limit, genre, titleRaw: item.titleRaw, chinese }) },
  };
}

/** Counts per genre and over all, before and after. @param {any[]} results */
export function summarize(results) {
  /** @param {any[]} rows @param {"before" | "after"} side */
  const tally = (rows, side) => {
    const metrics = rows.filter((row) => row.metrics).map((row) => row.metrics[side]);
    const n = metrics.length || 1;
    const count = (/** @type {(m: any) => boolean} */ test) => metrics.filter(test).length;
    return {
      cases: metrics.length,
      reasonFormula: count((m) => Boolean(m.reasonFormula)), reasonEmpty: count((m) => m.reasonEmpty),
      withAbsences: count((m) => m.absences.length > 0), absencePhrases: metrics.reduce((sum, m) => sum + m.absences.length, 0),
      numbersMissing: metrics.reduce((sum, m) => sum + m.numbersMissing.length, 0),
      leadOverLimit: count((m) => m.leadOverLimit), leadCharsMean: Math.round(metrics.reduce((sum, m) => sum + m.leadChars, 0) / n),
      briefCoverageMean: side === "after" ? Math.round((metrics.reduce((sum, m) => sum + (m.briefCoverage ?? 0), 0) / n) * 100) / 100 : null,
      quotesVerbatim: side === "after" ? `${count((m) => m.quoteVerbatim === true)}/${count((m) => m.quoteVerbatim !== null)}` : null,
      leadStyle: styleRates(metrics.map((m) => m.leadStyle).filter(Boolean)),
      proseStyle: styleRates(metrics.map((m) => m.proseStyle).filter(Boolean)),
      titles: titleSummary(metrics.map((m) => m.title).filter(Boolean)),
      absoluteGivenUsed: `${count((m) => m.givenUsed?.absoluteGiven && m.givenUsed.absoluteUsed)}/${count((m) => m.givenUsed?.absoluteGiven)}`,
      harmGivenUsed: `${count((m) => m.givenUsed?.harmGiven && m.givenUsed.harmUsed)}/${count((m) => m.givenUsed?.harmGiven)}`,
      leakageCases: count((m) => (m.leakage?.length ?? 0) > 0),
      adviceAdded: count((m) => (m.advice?.length ?? 0) > 0),
    };
  };
  /** @type {Record<string, any>} */
  const byGenre = {};
  for (const genre of FRONTIER_GENRES) {
    const rows = results.filter((row) => row.expectGenre === genre);
    if (rows.length) byGenre[genre] = { before: tally(rows, "before"), after: tally(rows, "after"), genreAccepted: rows.filter((row) => row.genreAccepted).length };
  }
  const dropped = /** @type {Record<string, number>} */ ({});
  for (const row of results) for (const part of row.after?.briefDropped ?? []) dropped[part.reason] = (dropped[part.reason] ?? 0) + 1;
  const thin = results.filter((row) => row.textSource === "summary");
  return { thinRecords: thin.length ? { after: tally(thin, "after") } : null, all: { before: tally(results, "before"), after: tally(results, "after"),
    scores: scoreDistribution(results.filter((row) => row.after).map((row) => ({ genre: row.after.genre, scores: row.after.scores }))),
    scoresRaw: scoreDistribution(results.filter((row) => row.after).map((row) => ({ genre: row.after.genre, scores: row.after.scoresRaw }))),
    genreAccepted: `${results.filter((row) => row.genreAccepted).length}/${results.length}`, errors: results.filter((row) => row.error).length, briefDropped: dropped },
  byGenre };
}

/**
 * Titles by where they come from: a Chinese source's (kept or rewritten) and a translated one; the share with a hook (question,
 * exclamation, hype word, a site's name), naming the subject, with a result verb, and numbers not in the source.
 * @param {any[]} titles
 */
export function titleSummary(titles) {
  /** @param {any[]} list */
  const part = (list) => ({ n: list.length, hook: list.filter(titleHook).length, question: list.filter((t) => t.question).length,
    exclamation: list.filter((t) => t.exclamation).length, hype: list.filter((t) => t.hype).length, siteSuffix: list.filter((t) => t.siteSuffix).length,
    columnTag: list.filter((t) => t.columnTag).length, named: list.filter((t) => t.named).length, resultVerb: list.filter((t) => t.resultVerb).length,
    numbersMissing: list.reduce((sum, t) => sum + t.numbersMissing.length, 0),
    meanChars: list.length ? Math.round(list.reduce((sum, t) => sum + t.chars, 0) / list.length) : 0 });
  const zh = titles.filter((t) => t.chinese);
  return { chinese: { ...part(zh), kept: zh.filter((t) => t.kept).length }, translated: part(titles.filter((t) => !t.chinese)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
