// Semantic coverage judging: the half of "did this answer the question" that no
// pattern can decide.
//
// The deterministic gate in clinicalEvidenceQuality.mjs decides everything that
// is a matter of fact — does the cited line exist, does it carry a claim anchor,
// is it in the body rather than the reference list, did the search it names
// actually run, is the ledger an account of the brief's questions by number and
// by transcription. Two defects pass all of it, measured on the 30-package
// corpus and not supposed:
//
//   * answer-not-responsive — an entry registered "answered" cites a line that
//     exists, carries evidence and is in the body, and answers a different
//     population, endpoint or timing than the sub-question it stands against.
//   * gap-answered-in-verdict / false-gap — a registered gap whose answer is
//     handed to the reader anyway, worded so no shared span survives.
//
// Both are questions about meaning. This module asks a model, and then believes
// none of it on the model's word:
//
//   THE MODEL JUDGES. THE CODE VERIFIES. Every part of a verdict that can be
//   checked against the package is checked — the entry id must name a real
//   ledger entry, the status must match the kind, the line must be one the
//   model was actually shown, must exist, must carry prose, must be outside the
//   reference list and the limitations, and the quoted span must appear on that
//   line verbatim. A verdict that fails any of these is dropped, not softened.
//   The only unverifiable part left is the sentence of reasoning, and the notice
//   that carries it says so.
//
// It is fail-safe and non-blocking by construction. It produces NOTICES, never
// issues: a finished analysis package is never withheld because a judge was
// unavailable, timed out, returned garbage, or disagreed with the run. The
// run-side preflight therefore has nothing to mirror — the invariant it is held
// to is "whatever the gate REJECTS, preflight must already catch", and this
// rejects nothing.

/** @typedef {import("./clinicalEvidenceQuality.mjs").CoverageJudgeLine} CoverageJudgeLine */

const judgeKinds = Object.freeze({
  "answer-not-responsive": "answered",
  "gap-answered-in-verdict": "gap",
  "false-gap": "gap",
});

// One call per delivery, bounded on both sides. The response cap is what a
// reader can act on: a list of twenty semantic doubts is not a list.
const maxVerdicts = 8;
// Each verdict becomes one run-ledger quality notice, and that ledger truncates
// a notice at 300 characters (agentRuns maxQualityNoticeLength) and has a byte
// ceiling a burst of events has already hit once. These two budgets are set so
// a formatted verdict lands under 300 without being cut mid-quotation — a
// truncated quotation is the one part of the notice a reader would have to take
// on trust, which is the thing this whole module exists to avoid.
const maxWhyCharacters = 110;
const maxQuoteCharacters = 60;
// A quote short enough to appear on any line by accident verifies nothing.
const minQuoteContentCharacters = 6;
// How many balanced `{…}` spans of a rambling answer are worth trying. The
// answer, when it is there at all, is at the end, so the newest are kept.
const maxJsonCandidates = 32;

const judgeInstructions = [
  "You audit whether a finished clinical evidence report actually answers the questions its research brief asked.",
  "You are given the brief's numbered questions, the run's own coverage ledger (one entry per atomic sub-question, each declaring answered or gap), and numbered excerpts of the report.",
  "Report ONLY these three defects, and only when you are confident:",
  "1. answer-not-responsive — an entry whose status is \"answered\" cites report lines that discuss a different population, exposure, endpoint, timing or setting than that entry's own question. The prose is real and evidence-backed; it answers something else. Cite one of that entry's OWN declared lines.",
  "2. gap-answered-in-verdict — an entry whose status is \"gap\" (declared unanswerable) while the abstract, the conclusion or the practical-points section states an answer to that same sub-question anyway. Cite the line in that section.",
  "3. false-gap — an entry whose status is \"gap\" while a report line in the excerpt already gives that sub-question an evidence-backed answer. Cite that line.",
  "Do NOT report an entry merely because its answer is thin, hedged, low-certainty, or explicitly labelled a gap in the body — an honest statement that no direct evidence was found is correct behaviour, not a defect.",
  "Do NOT report wording, formatting, citation style, or anything you cannot point at a specific line for.",
  "Every verdict MUST carry: entryId (exactly as given), kind (one of the three above), reportLine (a line number that appears in the excerpts you were given — never a line you did not see), quote (a span copied CHARACTER FOR CHARACTER from that line, at least 6 characters), and why (one sentence in Simplified Chinese naming what the question asked and what that line gives instead).",
  "A verdict whose quote is not verbatim from the line it names, or whose line was not in the excerpts, is discarded by the caller. Do not paraphrase quotes.",
  `Report at most ${maxVerdicts} verdicts, most serious first. Reporting none is a normal and frequent answer.`,
  "Return JSON only: {\"verdicts\": [{\"entryId\": \"2.1\", \"kind\": \"answer-not-responsive\", \"reportLine\": 89, \"quote\": \"…\", \"why\": \"…\"}]}. An empty array means you found nothing.",
].join("\n");

function judgeUrl(baseUrl, production = false) {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Coverage judge provider URL is invalid.");
  }
  if (production && (url.origin !== "https://api.deepseek.com" || url.pathname !== "/")) {
    throw new Error("Production coverage judging must use the official DeepSeek API origin.");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  return url;
}

/** @param {any} response @param {number} maximumBytes */
async function boundedJsonResponse(response, maximumBytes = 256 * 1024) {
  const declared = Number(response.headers?.get?.("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("Coverage judge response is too large.");
  const text = await response.text();
  if (text.length > maximumBytes) throw new Error("Coverage judge response is too large.");
  return JSON.parse(text);
}

/** Every balanced `{…}` span in the text, in the order each one closes.
 *
 *  This replaces a `/\{[\s\S]*\}/g` match that was greedy and therefore always
 *  a single span running from the first brace to the last, which made the
 *  reverse-and-retry loop below it dead code: prose containing a stray brace
 *  („先想一下 {population} 的问题…") and an answer containing two JSON objects
 *  both parsed as one malformed blob and were thrown away. Only "pure JSON" and
 *  "prose plus exactly one object" ever survived.
 *
 *  Quotes are honoured as JSON string delimiters once inside an object, so a
 *  brace inside a quotation — every `why` field is free Chinese text — cannot
 *  close it early. Outside an object the text is prose, not JSON, and its
 *  punctuation is ignored.
 *  @param {string} raw @returns {string[]} */
function balancedObjectSpans(raw) {
  /** @type {string[]} */
  const spans = [];
  /** @type {number[]} */
  const opens = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"" && opens.length > 0) inString = true;
    else if (char === "{") opens.push(index);
    else if (char === "}" && opens.length > 0) {
      spans.push(raw.slice(/** @type {number} */ (opens.pop()), index + 1));
      if (spans.length > maxJsonCandidates) spans.shift();
    }
  }
  return spans;
}

/** The verdict list, wherever the model put it. Same recovery as the specialist
 *  classifier: a reasoning model that runs its budget close still often carries
 *  the JSON in reasoning_content, and a judgement already paid for should not be
 *  thrown away over which field it arrived in.
 *  @param {any} content @returns {any[]|null} */
export function parseJudgeVerdicts(content) {
  if (typeof content !== "string") return null;
  const raw = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!raw) return null;
  const fromObject = (value) => (value && typeof value === "object" && Array.isArray(value.verdicts) ? value.verdicts : null);
  try {
    return fromObject(JSON.parse(raw));
  } catch { /* fall through to the balanced-object scan */ }
  // Last first: a model that thinks out loud writes its answer at the end, and
  // an outer object closes after the inner ones it contains.
  for (const span of balancedObjectSpans(raw).reverse()) {
    try {
      const verdicts = fromObject(JSON.parse(span));
      if (verdicts) return verdicts;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Whitespace is not content: the report writes 「12 导联心电图」 with a space and
 *  a model copying it back may not. Comparing raw made verbatim quotes fail on
 *  spacing alone.
 *  @param {any} value */
function collapse(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

/** @param {any} value */
function contentOnly(value) {
  return String(value ?? "").replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, "");
}

/**
 * Everything the model said, checked against the package it said it about.
 *
 * This is the whole safety argument of the feature. Nothing below trusts a
 * field; each one is looked up in the same data the excerpt was built from.
 *
 * @param {any} rawVerdicts
 * @param {NonNullable<ReturnType<typeof import("./clinicalEvidenceQuality.mjs").coverageJudgeContext>>} context
 * @returns {{ kept: { entryId: string, kind: string, line: number, section: string, quote: string, why: string, question: string }[], discarded: Record<string, number>, omitted: number }}
 */
export function verifiedCoverageVerdicts(rawVerdicts, context) {
  /** @type {Record<string, number>} */
  const discarded = {};
  // Verdicts that passed every check and were still left out for want of room.
  // Three packages in the 30-package corpus came back with exactly 8 kept
  // verdicts — the cap — so at least those three were cut, and a list that is
  // silently the first 8 of an unknown number reads as the whole of it.
  let omitted = 0;
  const drop = (reason) => { discarded[reason] = (discarded[reason] ?? 0) + 1; return null; };
  const byId = new Map(context.entries.map((entry) => [entry.id, entry]));
  const kept = [];
  const seen = new Set();
  for (const verdict of Array.isArray(rawVerdicts) ? rawVerdicts.slice(0, maxVerdicts * 4) : []) {
    if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) {
      drop("malformed");
      continue;
    }
    const entryId = typeof verdict.entryId === "string" ? verdict.entryId.trim() : "";
    const kind = typeof verdict.kind === "string" ? verdict.kind.trim() : "";
    const entry = byId.get(entryId);
    // An id the ledger does not contain is an invention, whatever it says next.
    if (!entry) { drop("unknown_entry"); continue; }
    if (!Object.hasOwn(judgeKinds, kind)) { drop("unknown_kind"); continue; }
    // The kind names a status. A model calling an "answered" entry a false gap
    // is not describing this package.
    if (judgeKinds[kind] !== entry.status) { drop("status_mismatch"); continue; }
    const line = Number(verdict.reportLine);
    if (!Number.isInteger(line) || line < 1 || line > context.totalLines) { drop("line_out_of_range"); continue; }
    // The excerpt is the answer sheet. A line outside it was never shown, so a
    // verdict about it is about something the model imagined.
    if (!context.excerptLines.has(line)) { drop("line_not_shown"); continue; }
    if (!context.hasSubstance(line)) { drop("line_empty"); continue; }
    // Neither the reference list nor the limitations answers a question, so
    // neither can be where an answer was wrongly given or wrongly withheld.
    if (context.inExcludedSection(line)) { drop("line_excluded_section"); continue; }
    if (kind === "answer-not-responsive" && !entry.declaredParagraph.includes(line)) {
      // The charge is that THIS entry's own citation does not answer it, so the
      // line must belong to the block the entry cited. A line elsewhere in the
      // report is a different charge, and an unfalsifiable one.
      drop("line_not_declared_by_entry");
      continue;
    }
    if (kind === "gap-answered-in-verdict" && !context.verdictLines.has(line)) {
      drop("line_not_in_verdict_section");
      continue;
    }
    if (kind === "false-gap" && !context.isAnchored(line)) {
      // "The report already answers this" means an answer bonded to evidence.
      // A paragraph with no claim anchor is prose, and prose is not the answer
      // the ledger was supposed to have registered.
      drop("line_not_anchored");
      continue;
    }
    const quote = typeof verdict.quote === "string" ? verdict.quote.trim().slice(0, maxQuoteCharacters) : "";
    if (contentOnly(quote).length < minQuoteContentCharacters) { drop("quote_too_short"); continue; }
    if (!collapse(context.lineText(line)).includes(collapse(quote))) { drop("quote_not_verbatim"); continue; }
    // Both gap charges say the report handed the reader an answer the ledger
    // registered as unanswerable. A quoted span that itself says the search came
    // back empty says the opposite, so the charge is refuted by its own evidence
    // — and this is not a rare miss: 12 of 109 live verdicts were the model
    // reporting a run for writing 「未检索到……」 in its conclusion, which is the
    // sentence the ledger exists to encourage. Flagging it would teach runs to
    // stop writing it. A line whose absence is about a document already in hand
    // (未载 / 未述及) is not this: there the silence IS the answer, and those
    // four verdicts survive.
    if (kind !== "answer-not-responsive" && context.statesRetrievalGap(quote)) {
      drop("quote_states_retrieval_gap");
      continue;
    }
    const why = typeof verdict.why === "string" ? verdict.why.replace(/\s+/g, " ").trim().slice(0, maxWhyCharacters) : "";
    if (!why) { drop("no_reason"); continue; }
    const key = `${entryId} ${kind} ${line}`;
    if (seen.has(key)) { drop("duplicate"); continue; }
    seen.add(key);
    if (kept.length >= maxVerdicts) {
      // Verified, then not shown. Counting it costs nothing — everything above
      // is a lookup against data already in memory — and it is the difference
      // between "these are the doubts" and "these are eight of the doubts".
      omitted += 1;
      continue;
    }
    kept.push({
      entryId,
      kind,
      line,
      section: context.verdictLines.get(line) ?? "",
      quote,
      why,
      question: entry.question,
    });
  }
  return { kept, discarded, omitted };
}

const kindHeading = Object.freeze({
  "answer-not-responsive": "登记为 answered，但所引正文答的不是这一问",
  "gap-answered-in-verdict": "登记为 gap，读者取走答案的一节里却给出了答案",
  "false-gap": "登记为 gap，正文里其实已有挂着证据的答案",
});

/** The notices a delivery carries: one preamble saying what was verified and
 *  what was not, then one line per surviving verdict.
 *
 *  They are separate strings because the run ledger stores one notice per
 *  entry and truncates each at 300 characters; a single joined block would be
 *  cut after the first item.
 *  @param {ReturnType<typeof verifiedCoverageVerdicts>["kept"]} kept
 *  @param {number} omitted how many equally verified verdicts the cap cut
 *  @returns {string[]} */
export function coverageJudgeNotices(kept, omitted = 0) {
  if (!kept.length) return [];
  const cut = Number.isSafeInteger(omitted) && omitted > 0 ? omitted : 0;
  return [
    `语义覆盖判定（不阻断交付）：本次交付有 ${kept.length + cut} 处「答非所问 / 缺口与结论不一致」的疑点。`
    + (cut > 0 ? `每次交付最多列 ${maxVerdicts} 处，以下为模型排在最前的 ${kept.length} 处，另有 ${cut} 处同样通过核对但未列出。` : "")
    + "条目编号、登记状态、行号与引文均已由代码逐条核对："
    + "该行确实存在、有正文、不在参考文献或局限性一节、引文逐字取自该行。"
    + "每条末尾的理由由模型给出，未经核对，请自行判读。",
    ...kept.map((verdict) => (
      `台账条目 ${verdict.entryId}（「${verdict.question.slice(0, 36)}」）${kindHeading[verdict.kind]}：`
      + `报告第 ${verdict.line} 行${verdict.section ? `（${verdict.section}）` : ""}`
      + `「${verdict.quote}」——${verdict.why}`
    )),
  ];
}

export class CoverageJudge {
  /** @param {Record<string, any>} config */
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.enabled = config?.coverageJudgeEnabled === true;
    this.timeoutMs = Math.max(1_000, Math.min(300_000, Number(config?.coverageJudgeTimeoutMs ?? 120_000)));
    /** @type {string|null} */
    this.lastFailure = null;
  }

  get available() {
    return this.enabled && this.config?.deepseekProviderEnabled === true && Boolean(this.config?.deepseekApiKey);
  }

  /** A judgement that did not happen, as distinct from one that found nothing.
   *  Both leave the package untouched, but only this one means the check was
   *  not performed — and a package delivered as though it had been is the one
   *  outcome worse than not judging at all.
   *  @param {string} reason */
  declined(reason) {
    this.lastFailure = reason;
    process.stderr.write(`coverage judge produced no verdict: ${reason}\n`);
    return { notices: [coverageJudgeDegradedNotice(reason)], judged: false, verdicts: [] };
  }

  /**
   * One model call, then verification.
   * @param {ReturnType<typeof import("./clinicalEvidenceQuality.mjs").coverageJudgeContext>} context
   * @returns {Promise<{ notices: string[], judged: boolean, verdicts: any[] }>}
   */
  async judge(context) {
    // Not applicable is not a failure: no brief questions, no ledger, no report
    // means the deterministic half already said so in its own notice.
    if (!context) return { notices: [], judged: false, verdicts: [] };
    // Not configured is a deployment choice, not a runtime fault, and a notice
    // on every delivery of a deployment that never turned this on is noise.
    if (!this.available) return { notices: [], judged: false, verdicts: [] };
    this.lastFailure = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(judgeUrl(this.config.deepseekBaseUrl, this.config.production), {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.config.deepseekApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.deepseekModel,
          stream: false,
          temperature: 0,
          // A reasoning model spends its budget thinking before it writes, and
          // this task is heavier than routing: the classifier's 8k was set for
          // a two-field answer. Eight verdicts with verbatim quotes need room
          // after the reasoning, not instead of it.
          //
          // 16k was not enough, measured rather than argued: over 29 live
          // judgements the median completion was 13,487 tokens and six of them
          // (RQ-10, 15, 18, 22, 23, 25) spent the whole 16k reasoning and
          // returned an empty content — a fifth of deliveries silently
          // unjudged, the same failure the specialist classifier had at 8k.
          max_tokens: 32_000,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: judgeInstructions },
            { role: "user", content: JSON.stringify(coverageJudgePayload(context)) },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) return this.declined(`http_${response.status}`);
      const body = await boundedJsonResponse(response);
      const message = body?.choices?.[0]?.message;
      const verdicts = parseJudgeVerdicts(message?.content) ?? parseJudgeVerdicts(message?.reasoning_content);
      if (!verdicts) return this.declined(message?.content?.trim() ? "unparseable" : "empty_content");
      const { kept, discarded, omitted } = verifiedCoverageVerdicts(verdicts, context);
      const dropped = Object.values(discarded).reduce((total, count) => total + count, 0);
      if (dropped > 0) {
        process.stderr.write(
          `coverage judge discarded ${dropped} unverifiable verdict(s): ${JSON.stringify(discarded)}\n`,
        );
      }
      // Verdicts that all failed verification are not a judgement of "nothing
      // wrong" — nothing survived to say either way, and a delivery must not
      // read as checked when it was not.
      if (!kept.length && verdicts.length > 0 && dropped >= verdicts.length) {
        this.lastFailure = "all_verdicts_unverifiable";
        return { notices: [coverageJudgeDegradedNotice("all_verdicts_unverifiable")], judged: false, verdicts: [] };
      }
      return { notices: coverageJudgeNotices(kept, omitted), judged: true, verdicts: kept };
    } catch (error) {
      return this.declined(error?.name === "AbortError" ? "timeout" : `error_${error?.code ?? "unknown"}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** What the model is shown, and the only thing it is shown.
 *
 *  Trimming policy, in one place so it can be argued with:
 *    * the brief's numbered questions — the exam paper, a few hundred
 *      characters each;
 *    * the ledger's entries reduced to id / question / status / declared lines
 *      — no search logs, no claim ids, none of what the deterministic rules
 *      already checked;
 *    * report lines: the three sections a reader takes an answer away from,
 *      plus the paragraphs the ledger's own entries point at. Capped at 16k
 *      characters by coverageJudgeContext, verdict sections first.
 *
 *  A 30 kB report goes in at roughly 8–12 kB, and the excerpt doubles as the
 *  set of lines a verdict is allowed to name.
 *  @param {NonNullable<ReturnType<typeof import("./clinicalEvidenceQuality.mjs").coverageJudgeContext>>} context */
export function coverageJudgePayload(context) {
  return {
    briefQuestions: context.briefQuestions.map((question) => ({
      number: question.number,
      text: String(question.text).slice(0, 1_200),
    })),
    ledgerEntries: context.entries.map((entry) => ({
      entryId: entry.id,
      question: entry.question.slice(0, 600),
      status: entry.status,
      declaredReportLines: entry.declaredLines,
    })),
    reportExcerpt: context.excerpt.map((line) => ({
      line: line.line,
      section: line.section,
      text: line.text.slice(0, 1_000),
    })),
    excerptIsPartial: context.truncated,
  };
}

/** @param {string} reason */
export function coverageJudgeDegradedNotice(reason) {
  return "本次交付未做语义覆盖判定（「所引正文是否真的在回答这一问」这一层）："
    + `判定模型不可用或未返回可核验的结论（${reason}）。`
    + "逐问登记、行号锚点、缺口检索这些确定性检查照常执行并已通过；"
    + "语义这一层本次没有检查过，不因此扣留交付。";
}
