/**
 * The definition cards of a trial, written once and read by every patient's clause-level calls (`match_judge` selection `definitions: true`;
 * built, off until measured).
 *
 * The pure part — the prompt, the reading of the answer, the lines a clause-level call carries — is `@evimed/domain`'s
 * `vcrClauseDefinitions.mjs`. This is the part with a model call and a table: one call per trial text, cached by the text's hash, the prompt
 * version and the model, so a job of thousands of pairs (and the batches of one job, and a rerun) read the same words.
 *
 * Hidden knowledge:
 *
 * - **A failed card is a pair judged without one, never a failed pair.** The call's failure, an unreadable answer or a store that cannot be
 *   written return no cards and say why; nothing is cached for it, so the next pair of the trial tries again.
 * - **A registry trial's card is shared; a protocol's is its study's.** The words of a registry record are public, and its cards are the same
 *   whoever asks. A study's own protocol is the study's, and so are the cards written for it (they go with the study).
 * - **The first words stay.** Two jobs writing a trial's cards at once keep the first row; the second reads it, so the pairs judged under
 *   one prompt version never read two sets of cards.
 * - **Passages are optional.** A deployment that retrieves a guideline passage for a clause passes it in (`passages`); the card then names it.
 *   With none the card is the model's knowledge, and says so.
 *
 * @module vcrClauseDefinitions
 */

import { VCR_DEFINITION_PROMPT_VERSION, definitionMessages, parseDefinitionsAnswer } from "@evimed/domain";

import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { VcrStoreBase } from "./vcrStoreBase.mjs";

/** The most clauses one card call carries: a longer list is cut at this many (the rest are read without a card). */
const CLAUSES_MAX = 60;

export class VcrClauseDefinitionStore extends VcrStoreBase {
  /** @param {{ studyId: string | null, targetHash: string, promptVersion: string, model: string }} key */
  async get({ studyId, targetHash, promptVersion, model }) {
    const row = await this.one(
      `SELECT definitions FROM ${VCR_SCHEMA}.clause_definitions WHERE COALESCE(study_id, '') = $1 AND target_hash = $2 AND prompt_version = $3 AND model = $4`,
      [studyId ?? "", targetHash, promptVersion, model]);
    return row ? (Array.isArray(row.definitions) ? row.definitions : []) : null;
  }

  /** The first row of a key stays: a second writer reads it. @param {{ studyId: string | null, targetHash: string, promptVersion: string, model: string, definitions: any[], usage?: Record<string, any> | null }} entry */
  async save({ studyId, targetHash, promptVersion, model, definitions, usage = null }) {
    await this.query(
      `INSERT INTO ${VCR_SCHEMA}.clause_definitions (study_id, target_hash, prompt_version, model, definitions, usage) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
       ON CONFLICT (COALESCE(study_id, ''), target_hash, prompt_version, model) DO NOTHING`,
      [studyId, targetHash, promptVersion, model, JSON.stringify(definitions), usage ? JSON.stringify(usage) : null]);
    return this.get({ studyId, targetHash, promptVersion, model });
  }
}

/** What the cards did, for the operator's metric family. */
export function createClauseDefinitionCounters() {
  return { written: 0, fromCache: 0, failed: 0, clausesCarded: 0 };
}

/**
 * @param {{ store: Pick<VcrClauseDefinitionStore, "get" | "save">, judge: { model: string, call: (input: any) => Promise<any> },
 *   passages?: ((input: { target: any, clauses: any[] }) => Promise<Record<string, { source?: string, text: string } | null>>) | null,
 *   counters?: ReturnType<typeof createClauseDefinitionCounters>, report?: (code: string) => void }} deps
 */
export function createClauseDefinitions({ store, judge, passages = null, counters = createClauseDefinitionCounters(), report = () => {} }) {
  /** One writer at a time for one key within this process. @type {Map<string, Promise<any>>} */
  const open = new Map();

  /** @param {{ study: any, jobId: string, target: any, targetKind: string }} input */
  async function write({ study, jobId, target, targetKind }) {
    const studyId = targetKind === "protocol_version" ? String(study.id) : null;
    const key = { studyId, targetHash: String(target.hash), promptVersion: VCR_DEFINITION_PROMPT_VERSION, model: judge.model };
    const held = await store.get(key);
    if (held) { counters.fromCache += 1; return { definitions: held, calls: [], cached: true }; }
    const clauses = (Array.isArray(target.clauses) ? target.clauses : []).slice(0, CLAUSES_MAX);
    if (!clauses.length) return { definitions: [], calls: [], cached: false };
    const found = passages ? await passages({ target, clauses }).catch(() => ({})) : {};
    const messages = definitionMessages({ title: target.title, summary: target.summary, conditions: target.conditions ?? [], interventions: target.interventions ?? [], clauses, passages: found ?? {} });
    // Thinking off: a card is background, written from what the model knows, and one call per trial is not the place to reason at length.
    const answered = await judge.call({ study, jobId, messages, thinking: "off" });
    const parsed = parseDefinitionsAnswer(answered.content, clauses);
    // A reading with no card in it is not kept: the next pair of the trial asks again.
    if (!parsed.definitions.length) return { definitions: [], calls: [answered], cached: false, unreadable: true };
    const kept = await store.save({ ...key, definitions: parsed.definitions, usage: answered.usage }).catch(() => parsed.definitions);
    counters.written += 1;
    counters.clausesCarded += parsed.definitions.length;
    return { definitions: kept ?? parsed.definitions, calls: [answered], cached: false };
  }

  return {
    version: VCR_DEFINITION_PROMPT_VERSION,
    /**
     * The cards of one trial for a clause-level call. Never throws: a failure is no cards and a code.
     * @param {{ study: any, jobId: string, target: any, targetKind: string }} input
     * @returns {Promise<{ definitions: any[], calls: any[], cached: boolean, failed?: string, unreadable?: boolean }>}
     */
    async forTarget(input) {
      const id = `${input.targetKind}\u0000${input.target.hash}`;
      let pending = open.get(id);
      const created = !pending;
      if (!pending) {
        pending = write(input).finally(() => { open.delete(id); });
        open.set(id, pending);
      }
      try {
        const done = await pending;
        // The calls are the first caller's to account for: a pair that only waited for the card is not billed for it twice.
        return created ? done : { ...done, calls: [] };
      } catch (error) {
        const code = String(/** @type {any} */ (error)?.code ?? "vcr_definitions_failed");
        counters.failed += 1;
        report(code);
        return { definitions: [], calls: [], cached: false, failed: code };
      }
    },
  };
}
