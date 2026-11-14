import { memoryHistoryLine } from '@evimed/domain';
import { hardTokens, tokenPresent, sourceHasToken } from './nativeMemoryHardTokens.mjs';
import { contentHash, lineFingerprint, normalisedStatement } from './nativeMemoryOverlay.mjs';
import { callModelForControlPlane } from "./modelGateway.mjs";
import { recordRejectionJudge, recordRejectionLines } from "./nativeMemoryMetrics.mjs";

/**
 * Shared removal authority (P24, 2026-11-10). Every engine write surface is held against the account's
 * removals across memory categories, within its native namespace. Hard tokens use the raw-history fence's
 * comparator. All later restatements require the existing semantic judge and a source-bound assertion receipt. Only original
 * user messages dated after each removal can authorize the new write; replaying or promoting old text
 * cannot renew its date. Relearning never lifts the old conversation's removal.
 *
 * The judge is bounded per account/day and fails open for semantic candidates. Literal removal and hard
 * token conflict checks remain code. `nearRemoved` remains a shortlist helper for finding existing duplicates;
 * the write rule does not use lexical similarity to decide which token-free wording may be a restatement.
 * @module nativeMemoryRejections
 */

/** The fewest compact characters a removed line must have to forbid every line that contains it. */
export const MIN_CONTAINED = 8;
/** The share of character pairs two statements hold in common (Dice) from which a model is asked. Low on purpose: the model decides. */
export const SIMILAR = 0.3;
/** The most lines one call carries, and the most removed lines offered for one of them. */
const MAX_CANDIDATES = 8;
const MAX_REMOVED_PER_CANDIDATE = 3;
const MAX_SAID = 6;

/** A statement with no spacing, punctuation or symbols: what two renderings of one wording share. @param {unknown} text */
export function compact(text) {
  return String(text ?? "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** @param {string} text */
function pairs(text) {
  const characters = [...text];
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (let index = 0; index + 1 < characters.length; index += 1) {
    const pair = `${characters[index]}${characters[index + 1]}`;
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/**
 * The share of character pairs two statements hold in common, 0 to 1 (Sørensen–Dice over the multiset of adjacent pairs), on their
 * compact forms. A cheap prefilter, not a verdict.
 * @param {string} left @param {string} right
 */
export function similarity(left, right) {
  const a = compact(left);
  const b = compact(right);
  if ([...a].length < 4 || [...b].length < 4) return 0;
  const first = pairs(a);
  const second = pairs(b);
  let shared = 0;
  for (const [pair, count] of first) shared += Math.min(count, second.get(pair) ?? 0);
  const total = [...a].length - 1 + [...b].length - 1;
  return total ? (2 * shared) / total : 0;
}

/**
 * Whether a written line contains a removed line's words: that line with something around it.
 * @param {string} written @param {string} removed the removed line's normalised text
 */
export function containsRemoved(written, removed) {
  const writtenHistory = memoryHistoryLine(written);
  const removedHistory = memoryHistoryLine(removed);
  if (!writtenHistory && !removedHistory) {
    const ordinaryNeedle = compact(removed);
    return [...ordinaryNeedle].length >= MIN_CONTAINED && compact(written).includes(ordinaryNeedle);
  }
  // Wrapping a short forgotten value in a dated history line cannot defeat exact removal.
  // Keep ordinary fingerprints unchanged: history and current still have distinct record/origin identities.
  const plainWritten = normalisedStatement(writtenHistory?.value ?? written);
  const plainRemoved = normalisedStatement(removedHistory?.value ?? removed);
  if ((writtenHistory || removedHistory) && plainRemoved && plainWritten === plainRemoved) return true;
  const needle = compact(plainRemoved);
  return [...needle].length >= MIN_CONTAINED && compact(plainWritten).includes(needle);
}

/**
 * Which removed lines a written line is near enough to be put to the model for, best first.
 * @param {string} written @param {readonly { fingerprint: string, text: string | null }[]} removed
 */
export function nearRemoved(written, removed) {
  return removed
    .filter((line) => line.text)
    .map((line) => ({ line, score: similarity(written, /** @type {string} */ (line.text)) }))
    .filter((entry) => entry.score >= SIMILAR)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_REMOVED_PER_CANDIDATE)
    .map((entry) => entry.line);
}

const INSTRUCTIONS = [
  "A research platform keeps short notes about one person. The person asked it to forget some of them (`removed`).",
  "`candidates` are lines the platform holds, written just now or earlier. For each candidate that says the same thing as one of its own `options` — the same fact, preference or instruction in other words, or the removed one with something added that does not change it — say which.",
  "A candidate that is only about the same subject, or says something more specific that the removed line did not, is not the same.",
  "`said` is what the person themselves wrote in the conversation the lines came from. Only a new affirmative statement by that person which itself states the candidate fact is `stated`. Questions, forget requests, pasted or quoted earlier conversations, assistant restatements, and offers to add a fact back are NEVER assertions, even if they contain every word or identifier. Do not infer an answer from a question. For each stated index also return an `assertions` witness with candidate index, zero-based source index in said, and an exact quote of the affirmative statement. If no such statement exists, stated and assertions must be empty.",
  "Return JSON only: {\"same\":[{\"candidate\":<index>,\"removed\":<index>}],\"stated\":[<candidate index>],\"assertions\":[{\"candidate\":<index>,\"source\":<said index>,\"quote\":<exact affirmative statement>}]}. List only the pairs that are the same; use only the indexes given.",
].join(" ");

/**
 * The one request of a judgement. @param {string} model @param {{ candidates: { text: string, options: number[] }[], removed: string[], said: string[] }} input
 */
export function judgeRequestBody(model, { candidates, removed, said }) {
  return {
    model, thinking: { type: "disabled" }, temperature: 0, max_tokens: 600, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: JSON.stringify({
        candidates: candidates.map((candidate, index) => ({ candidate: index, text: candidate.text, options: candidate.options })),
        removed: removed.map((text, index) => ({ removed: index, text })),
        said,
      }) },
    ],
  };
}

/**
 * What the model said, as far as it stands: pairs that were offered and indexes that exist. Everything else is dropped, not softened.
 * @param {unknown} content @param {{ options: number[] }[]} candidates @param {number} removedCount
 * @returns {{ same: Map<number, number>, stated: Set<number> } | null} null when it was not the one shape
 */
export function parseJudgement(content, candidates, removedCount) {
  let value;
  try { value = JSON.parse(String(content ?? "")); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.same)) return null;
  /** @type {Map<number, number>} */
  const same = new Map();
  for (const pair of value.same) {
    const candidate = pair?.candidate;
    const removed = pair?.removed;
    if (!Number.isInteger(candidate) || !Number.isInteger(removed)) continue;
    if (candidate < 0 || candidate >= candidates.length || removed < 0 || removed >= removedCount) continue;
    // A pair the code did not offer is not a pair: the model is judging near lines, not searching the list.
    if (!candidates[candidate].options.includes(removed) || same.has(candidate)) continue;
    same.set(candidate, removed);
  }
  const stated = new Set(Array.isArray(value.stated) ? value.stated.filter((/** @type {unknown} */ index) => Number.isInteger(index) && /** @type {number} */ (index) >= 0 && /** @type {number} */ (index) < candidates.length) : []);
  return { same, stated };
}

/**
 * The judge the worker asks: one call for a commit's near lines.
 * @param {{ config: any, usageLedger?: any, fetchImpl?: typeof fetch, now?: () => Date, callModel?: typeof callModelForControlPlane }} dependencies
 */
export function createRejectionJudge({ config, usageLedger = null, fetchImpl = globalThis.fetch, now = () => new Date(), callModel = callModelForControlPlane }) {
  const model = String(config.memoryExtractionModel || config.deepseekModel || "");
  const timeoutMs = Math.max(1_000, Math.min(120_000, Number(config.memoryExtractionTimeoutMs ?? 30_000)));
  const dailyCalls = Math.max(0, Math.trunc(Number(config.nativeMemoryRejectionJudgeDailyCalls ?? 40)));
  /** @type {Map<string, { day: string, calls: number }>} */
  const spent = new Map();
  const enabled = config.nativeMemoryRejectionJudgeEnabled !== false;

  return {
    /** Whether a judgement can be asked at all here: the lever, a model, and a provider. */
    get available() { return enabled && Boolean(model) && Boolean(config.deepseekProviderEnabled !== false && config.deepseekApiKey); },

    /**
     * @param {{ userId: string, projectId?: string | null, runId?: string | null, originMessages?: boolean, candidates: { text: string, removed: { fingerprint: string, text: string }[] }[], said?: readonly string[] }} request
     * @returns {Promise<{ same: Map<number, string>, stated: Set<number>, witnesses?: Map<number, number> }>} for each candidate index judged the same, the fingerprint of the removed line it repeats; and the candidates the person said themselves. Empty whenever the judge could not be asked or did not answer in the one shape: the lines are kept.
     */
    async same({ userId, projectId = null, runId = null, candidates, said = [], originMessages = false }) {
      const nothing = { same: /** @type {Map<number, string>} */ (new Map()), stated: /** @type {Set<number>} */ (new Set()) };
      const shown = originMessages ? candidates : candidates.slice(0, MAX_CANDIDATES);
      if (!shown.length) return nothing;
      if (!this.available) { recordRejectionJudge("unavailable"); recordRejectionLines("judge_failed", shown.length); if(originMessages) throw Object.assign(new Error('memory_history_privacy_unavailable'), { code: 'memory_history_privacy_unavailable' }); return nothing; }
      const day = now().toISOString().slice(0, 10);
      const held = spent.get(userId);
      const calls = held && held.day === day ? held.calls : 0;
      if (!originMessages && calls >= dailyCalls) { recordRejectionJudge("over_budget"); recordRejectionLines("judge_failed", shown.length); return nothing; }
      // Background checks are counted before the call, including failed calls.
      // Explicit privacy work cannot depend on the allowance for optional extraction checks.
      // It still uses the same authenticated provider, deadline and strict response validation.
      if (!originMessages) spent.set(userId, { day, calls: calls + 1 });
      // The removed lines the call is shown, once each, and each candidate's own shortlist as indexes into them.
      /** @type {string[]} */
      const removedTexts = [];
      /** @type {string[]} */
      const removedPrints = [];
      const offered = shown.map((candidate) => ({
        text: candidate.text.slice(0, originMessages ? 2_000_000 : 300),
        options: candidate.removed.map((line) => {
          let index = removedPrints.indexOf(line.fingerprint);
          if (index < 0) { removedPrints.push(line.fingerprint); removedTexts.push(line.text.slice(0, originMessages ? 2_000_000 : 300)); index = removedPrints.length - 1; }
          return index;
        }),
      }));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        recordRejectionJudge("asked");
        const body = await callModel({ config, usageLedger, fetchImpl }, {
          userId, projectId: projectId || "default", runId, purpose: "memory-extraction", signal: controller.signal,
          body: judgeRequestBody(model, { candidates: offered, removed: removedTexts, said: said.slice(0, MAX_SAID).map((text) => String(text).slice(0, 300)) }),
        });
        const judged = parseJudgement(body?.choices?.[0]?.message?.content, offered, removedTexts.length);
        if (!judged) { recordRejectionJudge("failed"); recordRejectionLines("judge_failed", shown.length); if(originMessages) throw Object.assign(new Error('memory_history_privacy_unavailable'), { code: 'memory_history_privacy_unavailable' }); return nothing; }
        const witnesses = JSON.parse(String(body?.choices?.[0]?.message?.content ?? '{}')).assertions;
        /** @type {Set<number>} */
        const stated = new Set();
        /** @type {Map<number, number>} */
        const witnessesByCandidate = new Map();
        for (const witness of Array.isArray(witnesses) ? witnesses : []) {
          if (!judged.stated.has(witness?.candidate) || !Number.isInteger(witness.source)) continue;
          const human = said.slice(0, MAX_SAID)[witness.source];
          if (typeof human !== 'string' || typeof witness.quote !== 'string' || !witness.quote.trim()
            || !human.slice(0, 300).includes(witness.quote)) continue;
          stated.add(witness.candidate);
          witnessesByCandidate.set(witness.candidate, witness.source);
        }
        const result = { same: /** @type {Map<number, string>} */ (new Map()), stated, witnesses: witnessesByCandidate };
        for (const [candidate, removed] of judged.same) result.same.set(candidate, removedPrints[removed]);
        recordRejectionLines("judged_same", result.same.size);
        recordRejectionLines("judged_kept", shown.length - result.same.size);
        return result;
      } catch {
        recordRejectionJudge("failed");
        recordRejectionLines("judge_failed", shown.length);
        if(originMessages) throw Object.assign(new Error('memory_history_privacy_unavailable'), { code: 'memory_history_privacy_unavailable' });
        return nothing;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export { MAX_CANDIDATES as REJECTION_JUDGE_MAX_CANDIDATES };

/** Text on every write surface, including headings, compared without Markdown decoration.
 * @param {string} text */
export function removalText(text) {
  return String(text).trim().replace(/^(?:#{1,6}|[-*+]|\d+[.)])\s+/, '');
}

/** Strip only memory presentation syntax before comparing the fact. Event dates inside the
 * statement remain hard tokens; a template's trailing as-of date and bold field label do not.
 * @param {string} text */
export function removalStatement(text) {
  return normalisedStatement(removalText(text).replace(/^\*\*[^*\n]+[:：]\*\*\s*/, ''));
}

/** Shared by write review and history readers; dates and exact source bytes are part of consent.
 * @param {string|null} namespaceId @param {{fingerprint:string,rejectedAt?:string|null}} removed
 * @param {string} text @param {{role:string,text:string,created_at?:string|null}} source */
export function removalAssertionKey(namespaceId, removed, text, source) {
  return contentHash(JSON.stringify(['removal-assertion-v1', namespaceId, removed.fingerprint,
    removed.rejectedAt, removalStatement(text), source.role, source.text, source.created_at ?? null]));
}

/** Legacy receipt address, bound to the entire removal authority of its time: any later removal, even an
 * unrelated one, made it unreadable, so a kept line came and went with other forgets. Read only for
 * receipts written before `lineDecisionKey`.
 * @param {string} uri @param {string} text @param {{fingerprint:string,rejectedAt?:string|null}[]} removals */
export function retainedRemovalKey(uri, text, removals) {
  return contentHash(JSON.stringify(['retained-removal-v1', uri, lineFingerprint(text),
    removals.map(row => [row.fingerprint, row.rejectedAt]).sort()]));
}

/** Where a person's decision about one line of one file is kept: retained through their removal of other
 * lines, or written by their own page edit. The receipt lists the removal fingerprints it was made under
 * (`covered`); each later removal is judged on its own, so an unrelated forget neither hides the line nor
 * lifts a fence that concerns the line.
 * @param {'retained'|'edit'} kind @param {string} uri @param {string} text */
export function lineDecisionKey(kind, uri, text) {
  return contentHash(JSON.stringify(['line-decision-v2', kind, uri, lineFingerprint(text)]));
}

/** The removal fingerprints a line-decision receipt covers, or null when it is not that kind of receipt.
 * @param {unknown} receipt @param {'retainedAfterRemoval'|'explicitEdit'} flag @returns {string[]|null} */
export function decisionCovers(receipt, flag) {
  if (!receipt || typeof receipt !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (receipt);
  if (row[flag] !== true || !Array.isArray(row.covered)) return null;
  return row.covered.filter(value => typeof value === 'string');
}

/** All newly written lines, including titles/headings. @param {string} after @param {string} [before] */
export function removalLines(after, before = '') {
  const prior = new Set(String(before).split('\n').map(removalText).map(lineFingerprint));
  return [...new Set(String(after).split('\n').map(removalText).filter(Boolean))].filter(line => !prior.has(lineFingerprint(line)));
}

/** One write-side removal rule for extraction, consolidation, corrections and synthetic writes.
 * Hard tokens identify conflicts with the history fence's normalization. Human reauthorization is semantic.
 * Only a person's own source message strictly AFTER each removal may authorize its content. Rejections
 * remain in place: a new statement authorizes that write, never a replay of the old conversation.
 * @param {{userId:string, overlay:any, projectId?:string|null, namespaceId?:string|null, judge?:any, ignoreTokenWhitespace?:boolean,
 * candidates:{text:string,sources?:{role:string,text:string,created_at?:string|null}[]}[]}} input
 * @returns {Promise<Map<string,{rejected:string,via:'contained'|'judged'}>>} */
export async function removalRefusals({ userId, overlay, projectId = null, namespaceId = null, judge = null, candidates, ignoreTokenWhitespace = false }) {
  const removed = await overlay.removals(userId, namespaceId);
  const refused = new Map();
  for (const entry of removed) {
    const text = entry.text ? removalStatement(entry.text) : '';
    const tokens = hardTokens(text);
    const pending = [];
    for (const candidate of candidates) {
      const print = lineFingerprint(candidate.text);
      if (refused.has(print)) continue;
      const sources = (candidate.sources ?? []).filter(source => source.role === 'user'
        && Date.parse(source.created_at ?? '') > Date.parse(entry.rejectedAt ?? '')
        && tokens.every(token => sourceHasToken(token, source, { ignoreWhitespace: ignoreTokenWhitespace })));
      /** @param {{role:string,text:string,created_at?:string|null}} source */
      const receiptKey = source => removalAssertionKey(namespaceId, entry, candidate.text, source);
      let authorized = false;
      for (const source of sources) if ((await overlay.instructionCheck?.(userId, receiptKey(source)))?.removalAssertion === true) authorized = true;
      if (authorized) continue;
      // A later message from the person that is, as a whole, this very statement is the person saying it again in a new
      // conversation: it is its own witness and needs no model. Containment, a question or a quotation is not equality and
      // still needs a witnessed assertion; an assistant message or an older message never qualifies (filtered above).
      // All three must be the same statement: the removed fact, the line being written and the person's whole message.
      const said = lineFingerprint(removalStatement(candidate.text));
      const restated = text && lineFingerprint(text) === said
        ? sources.find(source => lineFingerprint(removalStatement(source.text)) === said) : undefined;
      if (restated) {
        await overlay.recordInstructionCheck?.(userId, receiptKey(restated), { removalAssertion: true });
        await overlay.recordInstructionCheck?.(userId, removalAssertionKey(namespaceId, entry, text, restated), { removalAssertion: true });
        continue;
      }
      const hardMatch = tokens.length > 0 && tokens.every(token => tokenPresent(token, removalStatement(candidate.text), { ignoreWhitespace: ignoreTokenWhitespace }));
      if (tokens.length && !hardMatch) continue;
      const literal = hardMatch || print === entry.fingerprint || Boolean(text && containsRemoved(removalStatement(candidate.text), text));
      // Matching words or identifiers establish a conflict, never consent to relearn.
      // Even exact containment in a later user message may be a question or an old quote.
      if (literal && (!sources.length || !judge)) { refused.set(print, { rejected: entry.fingerprint, via: 'contained' }); continue; }
      if (text) pending.push({ candidate, sources, literal, receiptKey });
    }
    // Batch only candidates sharing the very same source set; another line's message is never authority.
    const groups = new Map();
    for (const item of pending) {
      const key = JSON.stringify(item.sources);
      const group = groups.get(key) ?? [];
      group.push(item); groups.set(key, group);
    }
    for (const group of groups.values()) for (let start = 0; start < group.length; start += MAX_CANDIDATES) {
      const batch = group.slice(start, start + MAX_CANDIDATES);
      if (!judge) { recordRejectionLines('judge_failed', batch.length); continue; }
      const answer = await judge.same({ userId, projectId, candidates: batch.map(({ candidate }) => ({ text: candidate.text, removed: [entry] })),
        said: batch[0].sources.map(source => source.text) }).catch(() => ({ same: new Map(), stated: new Set() }));
      for (let index = 0; index < batch.length; index++) {
        const item = batch[index];
        const witness = answer.witnesses?.get(index);
        const asserted = answer.stated.has(index) && Number.isInteger(witness) && Boolean(item.sources[witness]);
        if (asserted) {
          await overlay.recordInstructionCheck?.(userId, item.receiptKey(item.sources[witness]), { removalAssertion: true });
          // A history excerpt has the person's wording, not the extractor's candidate. Bind the
          // same witnessed assertion to the removed fact so both readers share this authority.
          if (answer.same.has(index) || item.literal) await overlay.recordInstructionCheck?.(userId,
            removalAssertionKey(namespaceId, entry, text, item.sources[witness]), { removalAssertion: true });
        }
        if ((item.literal || answer.same.has(index)) && !asserted) {
          refused.set(lineFingerprint(item.candidate.text), { rejected: entry.fingerprint, via: item.literal ? 'contained' : 'judged' });
        }
      }
    }
  }
  return refused;
}

/** A generated replacement name is a new write too. Keep it opaque and apply the same removal rule,
 * including when a generated identifier happens to equal another value the person removed.
 * @param {{userId:string,overlay:any,uri:string,namespaceId?:string|null,projectId?:string|null,judge?:any}} input */
export async function neutralMemoryUri({ userId, overlay, uri, namespaceId = null, projectId = null, judge = null }) {
  for (let attempt = 0; ; attempt++) {
    const name = contentHash(`${uri}:${attempt}`).slice(0, 24);
    const blocked = await removalRefusals({ userId, overlay, namespaceId, projectId, judge, candidates: [{ text: name }] });
    if (!blocked.has(lineFingerprint(name))) return `${uri.slice(0, uri.lastIndexOf('/'))}/${name}.md`;
  }
}
