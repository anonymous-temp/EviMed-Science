/**
 * What the frontier feed knows about a 「虚拟临研」 study's subject (flywheel plan §5.6, F24, 2026-10-06): trial events become
 * precedent candidates, and new results or a source change on a card's sources label the card 「有新证据」 and ask for a new version.
 *
 * The consumer is one tick of the module's own worker (`frontierEvents` loop of `vcrWorker.mjs`), a bounded number of studies each,
 * the study looked at longest ago first. It reads `entityVocabulary.frontierItemsMatching` for a study's entity keys and for the
 * identifiers its assumption cards stand on, and `sourceChanges` for those same identifiers. It makes no model call and no number.
 *
 * Hidden knowledge:
 *
 * - **A trial event is decided by the feed item's own fields, never by reading its prose.** `registration` is an item that names a
 *   registry number and carries the feed's own flag 「注册，未发表结果」; `results` is one that names a registry number and is either a
 *   randomized-trial report (the feed's evidence type) or a registry update (its flag 「数据已更新」); `label_change` is a regulator's
 *   decision (the feed's lane and evidence type). Anything else is not a trial event and raises nothing.
 * - **A candidate is a pointer, not a precedent.** It carries the feed item and the registry or DOI identifier it names, in a table
 *   of its own. A precedent is a registry record the study fetched and extracted through the evidence write, every number checked in
 *   code against the preserved text; nothing here writes one. A candidate whose registry number the account's library already holds
 *   is not raised: the library has it.
 * - **A card is labelled when its own sources have news, by identifier.** The card's keys are the registry numbers, DOIs and PMIDs
 *   of the precedents its evidence items were extracted from. A results item newer than the card version that shares one, or a
 *   recorded retraction, correction or new version of one, is a signal; an entity shared with the study is not (that is a candidate's
 *   business). A signal is unique per card version, identifier and cause, so the same news never raises twice.
 * - **The new version is the programme's, and the code never types the number.** Once a card is labelled the consumer asks the
 *   orchestrator for a run (`requestEvidenceRefresh`): an `evidence` run dispatched by the same rules as every programme run — the
 *   study active, the run slot free, the allowance and the bounded budget `dispatchRun` asks — that reads the new sources, extracts
 *   with quote and locator, and hands the engine the pooling. When any of those says no the label and the inbox notice stand and
 *   nothing else happens.
 * - **A frozen analysis plan is never touched.** The run's versions are written beside the one the plan froze with
 *   (`assumptions.after_freeze`, `vcrGateway.mjs`), skipped by every reader of the study's current card, so no recomputation starts
 *   and the seal's hash does not move. The page shows them as 「冻结后新增」 next to the frozen version. A study whose plan has not
 *   frozen takes the version as any edit of a card is taken (the existing `assumption_changed` propagation).
 * - **Off is invisible.** `OPEN_SCIENCE_VCR_FRONTIER_EVENTS_ENABLED` off, the module composes no consumer: no loop, no table read.
 *
 * @module vcrFrontierEvents
 */

import { createHash } from "node:crypto";

import { SOURCE_CHANGE_LABELS_ZH } from "@evimed/domain";
import { identifierKeys, overlap } from "@evimed/domain/entity-keys";

import { sourceIdentifiersOf } from "./sourceChanges.mjs";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { vcrId } from "./vcrStoreBase.mjs";

/** The trial events a feed item can be, in the words the candidate table keeps. */
export const VCR_TRIAL_EVENTS = Object.freeze(["registration", "results", "label_change"]);

/** The causes a card can be labelled for. */
export const VCR_SIGNAL_CAUSES = Object.freeze(["new_results", "source_retracted", "source_corrected", "source_new_version"]);

/** What one scan of one study may read and write at most; each bound protects the database and the person reading the page. */
export const VCR_FRONTIER_EVENT_LIMITS = Object.freeze({
  /** Feed items one study's scan reads. */
  itemsPerStudy: 20,
  /** Assumption cards one scan looks at. */
  cardsPerStudy: 40,
  /** Identifiers kept for one card, and for one study's query (the feed's own cap on keys is 64). */
  keysPerCard: 12, keysPerStudy: 60,
  /** Cards a notice names, and items a brief names. */
  noticeCards: 3, briefItems: 8,
  /** Candidates a list answers. */
  candidatesListed: 100,
});

const CAUSE_OF_CHANGE = Object.freeze(/** @type {Record<string, string>} */ ({
  retraction: "source_retracted", withdrawal: "source_retracted", correction: "source_corrected", concern: "source_corrected", new_version: "source_new_version",
}));

/** @param {unknown} value @returns {any[]} */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} value */
const iso = (value) => (value ? new Date(/** @type {any} */ (value)).toISOString() : null);
/** @param {string} value */
const sha = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Which registry a registration number belongs to, by the form the registry writes it in; null for a number no registry the module
 * reads uses.
 * @param {unknown} value @returns {{ registry: "clinicaltrials.gov" | "chictr" | "ctis", registryId: string } | null}
 */
export function registryOfId(value) {
  const id = String(value ?? "").trim();
  if (/^NCT\d{8}$/i.test(id)) return { registry: "clinicaltrials.gov", registryId: id.toUpperCase() };
  if (/^ChiCTR[A-Za-z0-9-]{3,56}$/i.test(id)) return { registry: "chictr", registryId: id };
  if (/^\d{4}-\d{6}-\d{2}-\d{2}$/.test(id)) return { registry: "ctis", registryId: id };
  return null;
}

/**
 * The trial event a feed item is, from its own fields; null when it is none.
 * @param {{ registryIds?: readonly string[], flags?: readonly string[], evidenceType?: string | null, lane?: string | null, sourceType?: string | null }} item
 * @returns {"registration" | "results" | "label_change" | null}
 */
export function trialEventOf(item) {
  const flags = list(item?.flags).map(String);
  const registered = list(item?.registryIds).length > 0;
  if (item?.lane === "regulatory" && item?.evidenceType === "regulatory-decision") return "label_change";
  if (registered && flags.includes("registry-unpublished")) return "registration";
  if (registered && (item?.evidenceType === "rct" || flags.includes("data-updated"))) return "results";
  return null;
}

/**
 * The brief the evidence run is sent with: which cards have news, what the news is and what to do with it. Text, not control flow —
 * the run is the same `vcr-evidence` capability, told which parameters to read again.
 * @param {{ study: any, cards: ReadonlyArray<{ key: string, name: string, version: number, parameter: string | null }>,
 *   news: ReadonlyArray<{ title: string, identifier: string, cause: string, itemId: string | null }>, afterFreeze: boolean }} input
 */
export function evidenceRefreshBrief({ study, cards, news, afterFreeze }) {
  const labelOf = (/** @type {string} */ cause) => ({ new_results: "新的结果", source_retracted: "来源已撤稿", source_corrected: "来源已更正", source_new_version: "来源有新版本" })[cause] ?? cause;
  const lines = [
    `研究「${String(study?.name ?? "")}」的假设卡有了新证据，请把新证据读进来，为这些卡写新的版本。`,
    "",
    "要更新的假设卡：",
    ...cards.map((card) => `- ${card.key}（${card.name}${card.parameter ? `，参数 ${card.parameter}` : ""}，当前 v${card.version}）`),
    "",
    "新证据：",
    ...news.slice(0, VCR_FRONTIER_EVENT_LIMITS.briefItems).map((entry) => `- ${labelOf(entry.cause)}：${entry.title || entry.identifier}（${entry.identifier}${entry.itemId ? `；前沿条目 ${entry.itemId}` : ""}）`),
    "",
    "做法：先用 mcp__evimed__vcr_read 读 assumptions 和 evidence，再用 mcp__evimed__trial_registry_record 或 open_access_full_text 读新来源的原文——"
      + "读原文，不要引用前沿条目，也不要引用证据卡。把原文里的数用 vcr_write evidence_item 补进来，引文和位置逐字照写；"
      + "再交 evidence_pool 合并，最后用 vcr_write assumption（fromPooling）写新版本。数字只来自原文或引擎，你不写数。"
      + "来源已撤稿或更正的，先核对旧引文是否还在原文里，不在就不要沿用。",
  ];
  if (afterFreeze) lines.push("这项研究的分析计划已经冻结：新版本由平台放在冻结的版本旁边，计划本身不动，你照常写。");
  return lines.join("\n");
}

/**
 * @param {{ store: any, entityVocabulary?: { frontierItemsMatching?: (query: any) => Promise<any[]> } | null,
 *   sourceChanges?: { getMany?: (identifiers: unknown[]) => Promise<Map<string, any>> } | null,
 *   orchestrator?: () => any, notifier?: () => any,
 *   levers?: { studiesPerTick?: number, windowDays?: number }, now?: () => Date, report?: (code: string) => void }} dependencies
 *   `orchestrator` and `notifier` are read when needed: they are composed after the module.
 */
export function createVcrFrontierEvents({ store, entityVocabulary = null, sourceChanges = null, orchestrator = () => null, notifier = () => null,
  levers = {}, now = () => new Date(), report = () => {} }) {
  if (!store) throw new TypeError("The frontier events consumer needs the VCR store.");
  const studiesPerTick = Number.isSafeInteger(levers.studiesPerTick) && /** @type {number} */ (levers.studiesPerTick) > 0 ? /** @type {number} */ (levers.studiesPerTick) : 10;
  const windowDays = Number.isSafeInteger(levers.windowDays) && /** @type {number} */ (levers.windowDays) > 0 ? /** @type {number} */ (levers.windowDays) : 30;
  const counters = { studies: 0, items: 0, candidates: 0, candidatesKnown: 0, labels: 0, refreshes: 0, versions: 0, versionsAfterFreeze: 0, failures: 0 };

  /**
   * The identifier keys each in-use card of a study stands on: the registry numbers, DOIs and PMIDs of the precedents its evidence
   * items were extracted from. A card with no evidence behind it (an expert setting) stands on nothing and is not watched.
   * @param {any} study @param {readonly any[]} cards
   */
  async function cardKeys(study, cards) {
    const ids = [...new Set(cards.flatMap((card) => list(card.evidenceIds).map(String)))];
    if (!ids.length) return new Map();
    const rows = await store.rows(`SELECT e.id, p.registry_id, p.sources FROM ${VCR_SCHEMA}.evidence_items e
      JOIN ${VCR_SCHEMA}.precedents p ON p.id = e.precedent_id WHERE e.study_id = $1 AND e.id = ANY($2::text[])`, [study.id, ids]);
    const keysOfEvidence = new Map(rows.map((/** @type {any} */ row) => [String(row.id), [
      ...sourceIdentifiersOf({ registryId: row.registry_id }), ...list(row.sources).flatMap((/** @type {any} */ source) => sourceIdentifiersOf(source)),
    ]]));
    return new Map(cards.map((card) => [card.key, [...new Set(list(card.evidenceIds).flatMap((id) => keysOfEvidence.get(String(id)) ?? []))]
      .slice(0, VCR_FRONTIER_EVENT_LIMITS.keysPerCard)]));
  }

  /** The parameter an assumption card is about, read off the evidence it stands on. @param {any} study @param {any} card */
  async function parameterOf(study, card) {
    const id = list(card.evidenceIds).map(String)[0];
    if (!id) return null;
    const row = await store.one(`SELECT parameter FROM ${VCR_SCHEMA}.evidence_items WHERE study_id = $1 AND id = $2`, [study.id, id]);
    return row?.parameter ? String(row.parameter) : null;
  }

  /**
   * Raise a candidate for a trial event of the feed, unless the account's library already holds its registry record.
   * @param {any} study @param {any} item @param {"registration" | "results" | "label_change"} event
   * @returns {Promise<"raised" | "known" | "seen">}
   */
  async function raiseCandidate(study, item, event) {
    const registered = list(item.registryIds).map((id) => registryOfId(id)).find(Boolean) ?? null;
    if (registered) {
      const held = await store.one(`SELECT 1 FROM ${VCR_SCHEMA}.precedents WHERE user_id = $1 AND registry = $2 AND registry_id = $3`,
        [study.userId, registered.registry, registered.registryId]);
      if (held) return "known";
    }
    const inserted = await store.one(`INSERT INTO ${VCR_SCHEMA}.precedent_candidates
      (id, user_id, frontier_item_id, event, registry, registry_id, doi, pmid, title, study_ids)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ARRAY[$10::text])
      ON CONFLICT (user_id, frontier_item_id) DO UPDATE SET study_ids = CASE WHEN $10::text = ANY(precedent_candidates.study_ids)
        THEN precedent_candidates.study_ids ELSE array_append(precedent_candidates.study_ids, $10::text) END
      RETURNING (xmax = 0) AS created`,
    [vcrId("candidate"), study.userId, String(item.id), event, registered?.registry ?? null, registered?.registryId ?? null,
      item.doi ?? null, item.pmid ?? null, String(item.titleZh ?? item.titleRaw ?? "").slice(0, 300), study.id]);
    return inserted?.created ? "raised" : "seen";
  }

  /**
   * Scan one study. Never throws past the caller: a study that failed is counted and looked at again next tick.
   * @param {any} study
   */
  async function scanStudy(study) {
    const cards = (await store.assumptions(study.id)).filter((/** @type {any} */ card) => list(card.evidenceIds).length).slice(0, VCR_FRONTIER_EVENT_LIMITS.cardsPerStudy);
    const keysByCard = await cardKeys(study, cards);
    const allKeys = [...new Set([...keysByCard.values()].flat())].slice(0, VCR_FRONTIER_EVENT_LIMITS.keysPerStudy);
    const since = new Date(now().getTime() - windowDays * 86_400_000);
    const matches = entityVocabulary?.frontierItemsMatching
      ? await entityVocabulary.frontierItemsMatching({ entityKeys: study.entityKeys ?? [], identifierKeys: allKeys, since, limit: VCR_FRONTIER_EVENT_LIMITS.itemsPerStudy })
      : [];
    counters.items += matches.length;

    // 1. Trial events become candidates in the account's library.
    for (const item of matches) {
      const event = trialEventOf(item);
      if (!event) continue;
      const outcome = await raiseCandidate(study, item, event);
      if (outcome === "raised") counters.candidates += 1;
      else if (outcome === "known") counters.candidatesKnown += 1;
    }

    // 2. News about a card's own sources, by identifier: a new results item, or a change the source-change ledger holds.
    /** @type {Array<{ key: string, version: number, cause: string, identifier: string, itemId: string | null, title: string }>} */
    const news = [];
    for (const card of cards) {
      const keys = keysByCard.get(card.key) ?? [];
      if (!keys.length) continue;
      for (const item of matches) {
        if (trialEventOf(item) !== "results") continue;
        const own = identifierKeys({ doi: item.doi, pmid: item.pmid, registryIds: item.registryIds });
        const shared = overlap(keys, own).identifierKeys;
        // Only what appeared after the version was written is news about it: the item a cited study entered the feed as is not.
        if (!shared.length || !(Date.parse(String(item.timelineAt)) > Date.parse(String(card.createdAt)))) continue;
        news.push({ key: card.key, version: card.version, cause: "new_results", identifier: shared[0], itemId: String(item.id),
          title: String(item.titleZh ?? item.titleRaw ?? "").slice(0, 200) });
      }
      const facts = sourceChanges?.getMany ? await sourceChanges.getMany(keys) : new Map();
      for (const key of keys) {
        for (const change of list(facts.get(key)?.changes)) {
          const cause = CAUSE_OF_CHANGE[String(change?.kind)];
          if (cause) news.push({ key: card.key, version: card.version, cause, identifier: key, itemId: null,
            title: `${(/** @type {Record<string, string>} */ (SOURCE_CHANGE_LABELS_ZH))[String(change.kind)] ?? String(change.kind)}：${key}` });
        }
      }
    }
    /** @type {typeof news} */
    const fresh = [];
    for (const entry of news) {
      const inserted = await store.one(`INSERT INTO ${VCR_SCHEMA}.evidence_signals
        (id, study_id, user_id, assumption_key, assumption_version, cause, frontier_item_id, identifier, title)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (study_id, assumption_key, assumption_version, identifier, cause) DO NOTHING
        RETURNING id`, [vcrId("signal"), study.id, study.userId, entry.key, entry.version, entry.cause, entry.itemId, entry.identifier, entry.title]);
      if (inserted) fresh.push(entry);
    }
    counters.labels += fresh.length;

    // 3. A version a signal's card has since been given closes the signal; the page keeps saying whether it came after the freeze.
    const open = await store.rows(`SELECT id, assumption_key, assumption_version FROM ${VCR_SCHEMA}.evidence_signals WHERE study_id = $1 AND state = 'open'`, [study.id]);
    for (const signal of open) {
      const later = await store.one(`SELECT version, after_freeze FROM ${VCR_SCHEMA}.assumptions WHERE study_id = $1 AND key = $2 AND version > $3
        ORDER BY version DESC LIMIT 1`, [study.id, signal.assumption_key, Number(signal.assumption_version)]);
      if (!later) continue;
      await store.query(`UPDATE ${VCR_SCHEMA}.evidence_signals SET state = 'versioned', version_after = $2, after_freeze = $3 WHERE id = $1 AND state = 'open'`,
        [signal.id, Number(later.version), later.after_freeze === true]);
      counters.versions += 1;
      if (later.after_freeze === true) counters.versionsAfterFreeze += 1;
    }

    // 4. The notice and the request for a new version, for what this scan newly found. The notice stands whether or not the run can start.
    if (fresh.length) {
      const frozen = Boolean((await store.studyById(study.id))?.outcomeSeal?.planFrozenAt);
      const names = [...new Set(fresh.map((entry) => cards.find((card) => card.key === entry.key)?.name ?? entry.key))];
      const batchKey = sha(fresh.map((entry) => `${entry.key}@${entry.version}:${entry.identifier}:${entry.cause}`).sort().join("|")).slice(0, 24);
      const asked = await orchestrator()?.requestEvidenceRefresh?.(study.id, {
        token: batchKey, keys: [...new Set(fresh.map((entry) => entry.key))],
        items: fresh.map((entry) => ({ identifier: entry.identifier, itemId: entry.itemId, cause: entry.cause })),
        brief: evidenceRefreshBrief({
          study, afterFreeze: frozen, news: fresh,
          cards: await Promise.all([...new Set(fresh.map((entry) => entry.key))].map(async (key) => {
            const card = cards.find((entry) => entry.key === key);
            return { key, name: String(card?.name ?? key), version: Number(card?.version ?? 1), parameter: card ? await parameterOf(study, card) : null };
          })),
        }),
      }).catch((/** @type {any} */ error) => { report(`vcr frontier events: ${String(error?.code ?? "refresh_failed")}`); return null; });
      if (asked?.requested) counters.refreshes += 1;
      await notifier()?.newEvidence?.(study, { batchKey, cards: names.slice(0, VCR_FRONTIER_EVENT_LIMITS.noticeCards), afterFreeze: frozen, refreshing: Boolean(asked?.requested) })
        ?.catch?.(() => null);
    }
    await store.query(`INSERT INTO ${VCR_SCHEMA}.frontier_scans (study_id, scanned_at) VALUES ($1, $2)
      ON CONFLICT (study_id) DO UPDATE SET scanned_at = EXCLUDED.scanned_at`, [study.id, now().toISOString()]);
  }

  return {
    counters,

    /**
     * One tick: the studies looked at longest ago, up to the lever's bound. A paused study is read and labelled like any other — its page
     * should say what is new — and asks the programme for nothing (`requestEvidenceRefresh` answers `study_not_active`); an archived or
     * deleted one is not read. A study with no entity key and no card with evidence has nothing to read.
     */
    async tick() {
      const studies = await store.rows(`SELECT s.id FROM ${VCR_SCHEMA}.studies s LEFT JOIN ${VCR_SCHEMA}.frontier_scans f ON f.study_id = s.id
        WHERE s.deleted_at IS NULL AND s.status IN ('active', 'paused') ORDER BY f.scanned_at NULLS FIRST, s.created_at LIMIT $1`, [studiesPerTick]);
      let failed = 0;
      for (const row of studies) {
        const study = await store.studyById(String(row.id));
        if (!study) continue;
        counters.studies += 1;
        try { await scanStudy(study); }
        catch (error) { failed += 1; counters.failures += 1; report(`vcr frontier events: ${String(/** @type {any} */ (error)?.code ?? "scan_failed")}`); }
      }
      return { studies: studies.length, failed, candidates: counters.candidates, labels: counters.labels, refreshes: counters.refreshes, versions: counters.versions };
    },

    /**
     * What a study's page says about new evidence: per card key, the open signals, and the versions a signal closed with whether they
     * came after the freeze.
     * @param {string} studyId
     */
    async signalsFor(studyId) {
      const rows = await store.rows(`SELECT * FROM ${VCR_SCHEMA}.evidence_signals WHERE study_id = $1 ORDER BY noticed_at DESC, id LIMIT 200`, [studyId]);
      /** @type {Map<string, { open: any[], afterFreeze: number | null, versioned: number | null }>} */
      const byKey = new Map();
      for (const row of rows) {
        const entry = byKey.get(String(row.assumption_key)) ?? { open: [], afterFreeze: null, versioned: null };
        if (row.state === "open") entry.open.push({ id: String(row.id), cause: String(row.cause), identifier: String(row.identifier), itemId: row.frontier_item_id ?? null,
          title: String(row.title ?? ""), at: iso(row.noticed_at) });
        else {
          entry.versioned = Math.max(entry.versioned ?? 0, Number(row.version_after ?? 0)) || null;
          if (row.after_freeze === true) entry.afterFreeze = Math.max(entry.afterFreeze ?? 0, Number(row.version_after ?? 0)) || null;
        }
        byKey.set(String(row.assumption_key), entry);
      }
      return byKey;
    },

    /**
     * The account's candidates, newest first, minus the ones the library now holds: a candidate whose registry record became a
     * precedent through the evidence write is a precedent, not a candidate.
     * @param {string} userId @param {{ studyId?: string | null }} [options]
     */
    async candidatesFor(userId, { studyId = null } = {}) {
      const rows = await store.rows(`SELECT c.* FROM ${VCR_SCHEMA}.precedent_candidates c
        WHERE c.user_id = $1 AND c.state = 'candidate' AND ($2::text IS NULL OR $2 = ANY(c.study_ids))
          AND NOT EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.precedents p WHERE p.user_id = c.user_id AND c.registry_id IS NOT NULL
            AND p.registry = c.registry AND p.registry_id = c.registry_id)
        ORDER BY c.noticed_at DESC, c.id LIMIT ${VCR_FRONTIER_EVENT_LIMITS.candidatesListed}`, [userId, studyId]);
      return rows.map((/** @type {any} */ row) => ({
        id: String(row.id), candidate: true, event: String(row.event), frontierItemId: String(row.frontier_item_id),
        registry: row.registry ?? null, registryId: row.registry_id ?? null, doi: row.doi ?? null, pmid: row.pmid ?? null,
        title: String(row.title), studyIds: list(row.study_ids).map(String), noticedAt: iso(row.noticed_at),
      }));
    },
  };
}
