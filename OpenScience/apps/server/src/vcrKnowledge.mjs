/**
 * 「虚拟临床研究」's knowledge side: the disease packs a study works from and the
 * account's library of population definitions (plan 2026-09-28 §3.3, §5.1).
 *
 * Hidden knowledge:
 *
 * - **A pack is definitions, and a study binds exactly one.** The curated packs
 *   are files in `@evimed/domain`, validated when the module loads; an AI draft
 *   is a row, written through the same validator at its floor (`draft`) and
 *   marked 「AI 草拟」 wherever it is shown. Nothing in the programme waits for
 *   curation: a study with no pack for its disease drafts one and goes on, and
 *   a reviewed draft is promoted by the study's lead or an operator — the same
 *   row, status `curated`, with who reviewed it. A draft never silently becomes
 *   curated and a curated pack is never rewritten by a draft: a study that
 *   already works from a curated pack refuses a draft by name.
 * - **Which disease a study is about is the model's judgment, not a keyword
 *   rule.** The run reads the catalogue (`vcr_read` `pack`), picks, and binds or
 *   drafts; the only deterministic part is the catalogue search (a case-folded
 *   containment test over the names a pack lists) and the validation.
 * - **The library is the account's, read through the study's owner.** A
 *   definition is saved from a study into the account's library, reused in
 *   another of that account's studies, versioned (a change is the next version,
 *   earlier ones stay) and counted by the studies that used it. A runtime or a
 *   member acts on the library of the study's owner, which is the account the
 *   study's data belongs to. Another account's definition answers 404, exactly
 *   like one that does not exist.
 * - **Reuse changes nothing it cannot explain.** A definition's rules read
 *   columns; the study's dataset may name them differently. A column the target
 *   lacks is renamed only when the pack's data mappings make it unambiguous
 *   (`vcrSuggestColumnRemap`) or when the caller names the rename; every rename
 *   is reported and every column left unmatched is listed, because a guessed
 *   rename would silently change who is in the cohort.
 * - **A curated pack can become the platform's (flywheel F26, 2026-10-06).** After the study's lead has marked a draft curated, the
 *   lead may ask for the pack to be a platform pack: the code re-checks it (the same structure and licence validation the draft
 *   passed, and the source-change ledger for every source a work identifier names — a retraction, withdrawal, correction or
 *   expression of concern fails the entries that cite it, by name) and a pack that passes is copied as an immutable version owned by
 *   the platform publisher, attributed to its author by the name they allow, with the date and the version it came from. One that
 *   fails stays the account's, the failing entries named. Pack entries carry no quotation and no locator (a pack is definitions in the
 *   pack's own words, sources by link), so there is nothing of that kind to find again; the check is what the contract has. Every
 *   account reads a live platform pack beside the shipped ones, but an account's own pack of the same disease wins for that account;
 *   the author may take their name off, which retires the version for new studies and leaves it to the studies that pinned it. A source
 *   that changes after promotion labels the pack 「来源有变更」 and rewrites nothing. Off unless `OPEN_SCIENCE_VCR_PLATFORM_PACKS_ENABLED`.
 * - **Comparing two versions is the engine's.** Both versions are applied to the
 *   same registered dataset by `cohort.build` with a `compare` block; counts and
 *   the standardized difference of each baseline covariate are what the engine
 *   reports and what the page shows, never computed here. The finished job is a
 *   result of kind `definition_comparison`, kept out of the study's own results
 *   (`VCR_COMPARISON_RESULT_KIND`).
 *
 * @module vcrKnowledge
 */

import {
  DISPLAY_TIME_ZONE, agendaLocalDate, VCR_PACK_SCHEMA, VCR_PACK_SECTIONS, validateKnowledgePack, validateNamedRules, vcrPackConceptColumns, vcrPackEntrySources,
  vcrPackMatchesName, vcrPackSummary, vcrRemapRowRuleColumns, vcrRequirementVariables, vcrRowRuleColumns, vcrSuggestColumnRemap, VCR_SHIPPED_PACKS,
} from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { sourceIdentifiersOf } from "./sourceChanges.mjs";
import { VCR_COMPARISON_RESULT_KIND } from "./vcrPersistence.mjs";
import { vcrKnowledgeId } from "./vcrKnowledgeStore.mjs";

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);
const ID = /^[A-Za-z0-9_.:@-]{1,160}$/;
const SHIPPED_ID = /^[a-z][a-z0-9_]{0,63}$/;
const STORED_ID = /^pkg_[a-f0-9]{22}$/;

/** What a library definition's body may carry: the cohort job's own keys, never the table or a number. */
const DEFINITION_BODY_KEYS = Object.freeze(["rules", "timeZero", "exit", "idColumn"]);
/** Limits of a library entry. */
export const VCR_LIBRARY_LIMITS = Object.freeze({ name: 120, text: 2_000, versionsListed: 100, covariates: 100, packRefs: 100 });

/** The sections a runtime read may narrow a pack to (`filter.kind`). */
export const VCR_PACK_READ_SECTIONS = VCR_PACK_SECTIONS;

/** A refusal that carries issues, for the routes and the writer. */
class PackIssues extends HttpError {
  /** @param {readonly { code: string, field: string, detail: string }[]} issues */
  constructor(issues) {
    super(422, "vcr_pack_invalid", "这份知识包不符合规定的结构，没有保存。");
    this.issues = issues;
  }
}

/**
 * One pack as a page and a tool read it, apart from its sections: where it lives, who stands behind it and what it holds.
 * @param {string} origin `shipped` or `stored` @param {Record<string, any>} pack @param {Record<string, any> | null} [row]
 */
export function presentPackSummary(origin, pack, row = null) {
  const summary = vcrPackSummary(pack);
  return {
    origin, id: origin === "stored" ? String(row?.id ?? "") : summary.id, diseaseKey: summary.disease.key,
    name: summary.disease.name, nameZh: summary.disease.nameZh, aliases: summary.disease.aliases, aliasesZh: summary.disease.aliasesZh,
    version: summary.version, status: summary.status, updated: summary.updated, counts: summary.counts,
    sources: summary.sources.map((source) => ({ ...source, ...sourceUse(pack, source.id) })),
    // A platform pack names its author through `platform.author`, by the name they allow; the account that reviewed it is not shown.
    ...(row?.reviewedBy && !row?.platform ? { reviewedBy: row.reviewedBy, reviewedAt: row.reviewedAt } : {}),
    ...(row?.platform ? { platform: publicPlatform(row.platform) } : {}),
  };
}

/**
 * A platform pack's record as a reader gets it: the author's name as they allow it, never their account.
 * @param {Record<string, any>} platform
 */
function publicPlatform(platform) {
  return { version: platform.version, author: platform.author, zoneId: platform.zoneId, state: platform.state, sourceChanged: platform.sourceChanged };
}

/** What a source change of this kind does to a pack's promotion: the kinds that say a source no longer stands as it was read. */
const PROMOTION_BLOCKING_KINDS = Object.freeze(["retraction", "withdrawal", "correction", "concern"]);
/** What labels a platform pack 「来源有变更」: those, and a new version of the source. */
const WATCH_KINDS = Object.freeze([...PROMOTION_BLOCKING_KINDS, "new_version"]);

/**
 * The sources of a pack that a work identifier names, with what the source-change ledger holds of each: a retraction, correction or
 * the like. A page with no work identifier (a guideline site) cannot be looked up and is counted as such, not as clean.
 * @param {Record<string, any>} pack @param {{ getMany: (identifiers: unknown[]) => Promise<Map<string, any>> }} sourceChanges @param {readonly string[]} kinds
 * @returns {Promise<{ lookedUp: number, unreadable: number, changed: Array<{ sourceId: string, identifier: string, kind: string }> }>}
 */
async function sourceChangesOf(pack, sourceChanges, kinds) {
  let lookedUp = 0;
  let unreadable = 0;
  /** @type {Array<{ sourceId: string, identifier: string, kind: string }>} */
  const changed = [];
  for (const source of list(pack.sources)) {
    const identifiers = sourceIdentifiersOf({ url: source?.url });
    if (!identifiers.length) { unreadable += 1; continue; }
    lookedUp += 1;
    const facts = await sourceChanges.getMany(identifiers);
    for (const identifier of identifiers) {
      for (const change of list(facts.get(identifier)?.changes)) {
        if (kinds.includes(String(change?.kind))) changed.push({ sourceId: String(source.id), identifier, kind: String(change.kind) });
      }
    }
  }
  return { lookedUp, unreadable, changed };
}

/**
 * The entry a validation issue's path names, as `{ section, id }`; the path itself when it names none.
 * @param {Record<string, any>} pack @param {string} field
 */
function entryOfField(pack, field) {
  const found = /^(terms|phenotypes|endpoints|criteria|mappings|background)\[(\d+)\]/.exec(String(field));
  if (!found) return { section: null, id: String(field) };
  return { section: found[1], id: String(list(pack[found[1]])[Number(found[2])]?.id ?? field) };
}

/** @param {Record<string, any>} pack @param {string} id */
function sourceUse(pack, id) {
  const [resolved] = vcrPackEntrySources(pack, { sources: [id] });
  return resolved ? { licenceName: resolved.licenceName, use: resolved.use, accessed: resolved.accessed } : {};
}

/**
 * A pack in full: its summary and every section. An entry names its sources by id
 * and the pack's source table (each with its licence's name and kind of use) is
 * given once, so a section is its own content and not a copy of the citations.
 * @param {string} origin `shipped` or `stored` @param {Record<string, any>} pack @param {Record<string, any> | null} [row]
 */
export function presentPack(origin, pack, row = null) {
  const sections = Object.fromEntries(VCR_PACK_SECTIONS.map((section) => [section, list(pack[section])]));
  return { ...presentPackSummary(origin, pack, row), disease: pack.disease, sections };
}

/**
 * A pack's sections as an index, the way a run first reads one: each entry's id
 * and what names it, so the run asks for the section it needs (`filter.kind`)
 * and reads that whole.
 * @param {Record<string, any>} pack
 */
function packIndex(pack) {
  /** @param {Record<string, any>} entry */
  const name = (entry) => entry.labelZh ?? entry.label ?? entry.textZh ?? entry.text ?? entry.concept ?? "";
  return Object.fromEntries(VCR_PACK_SECTIONS.map((section) => [section, list(pack[section]).map((entry) => ({
    id: entry.id, name: String(name(entry)).slice(0, 80),
    ...(entry.kind ? { kind: entry.kind } : {}), ...(entry.type ? { type: entry.type } : {}), ...(entry.criterionType ? { criterionType: entry.criterionType } : {}),
    ...(section === "mappings" ? { concept: entry.concept } : {}),
  }))]));
}

/**
 * The sources a set of entries cites, from the pack's table.
 * @param {Record<string, any>} pack @param {readonly Record<string, any>[]} entries
 */
function citedSources(pack, entries) {
  const ids = new Set(entries.flatMap((entry) => list(entry.sources).map(String)));
  return vcrPackEntrySources(pack, { sources: [...ids] });
}

/**
 * The rule-bearing body of a population definition, and nothing else: the
 * cohort job's rules and the columns it names for time zero, exit and identity.
 * @param {Record<string, any>} definition @returns {Record<string, any>}
 */
export function definitionBodyOf(definition) {
  /** @type {Record<string, any>} */
  const body = {};
  for (const key of DEFINITION_BODY_KEYS) if (definition?.[key] !== undefined) body[key] = definition[key];
  return body;
}

/**
 * What the library holds of one version, as a page and a tool read it.
 * @param {Record<string, any>} version
 */
function presentVersion(version) {
  return { version: version.version, text: version.text, rules: list(version.body?.rules), timeZero: version.body?.timeZero ?? null,
    exit: version.body?.exit ?? null, idColumn: version.body?.idColumn ?? null, packRefs: version.packRefs, createdAt: version.createdAt };
}

export class VcrKnowledge {
  /**
   * @param {{ store: import("./vcrKnowledgeStore.mjs").VcrKnowledgeStore, studyStore: any, dataStore?: any, jobs?: any,
   *   shipped?: ReadonlyMap<string, Record<string, any>> | Record<string, Record<string, any>>, now?: () => Date,
   *   platform?: Record<string, any> }} options
   */
  constructor({ store, studyStore, dataStore = null, jobs = null, shipped = VCR_SHIPPED_PACKS, now = () => new Date(), platform = {} }) {
    if (!store || !studyStore) throw new TypeError("The knowledge package needs its store and the study store.");
    /**
     * Platform packs (flywheel F26): `enabled` is the switch; `publisherId` owns the copies; `sourceChanges` is the ledger the
     * re-check reads; `entityVocabulary` names a pack's disease in entity keys; `officialZoneForKeys` finds the official zone of
     * the same disease; `people` resolves an account's display name.
     * @type {{ enabled: boolean, publisherId: string, sourceChanges: any, entityVocabulary: any, officialZoneForKeys: ((keys: string[]) => Promise<string | null>) | null,
     *   people: ((ids: string[]) => Promise<Map<string, string>>) | null }}
     */
    this.platform = { enabled: false, publisherId: "", sourceChanges: null, entityVocabulary: null, officialZoneForKeys: null, people: null, ...platform };
    this.store = store;
    this.studyStore = studyStore;
    this.dataStore = dataStore;
    this.jobs = jobs;
    this.now = now;
    this.shipped = shipped instanceof Map ? shipped : new Map(Object.entries(shipped));
    this.counters = { packsDrafted: 0, packsBound: 0, packsPromoted: 0, definitionsSaved: 0, definitionsReused: 0, comparisons: 0,
      platformPassed: 0, platformFailed: 0, platformWithdrawn: 0, platformSourcesChanged: 0 };
  }

  /** The jobs queue is composed after this package; read at request time. @param {{ jobs?: any, dataStore?: any }} packages */
  attach(packages) {
    if (packages?.jobs) this.jobs = packages.jobs;
    if (packages?.dataStore) this.dataStore = packages.dataStore;
    return this;
  }

  // --- packs ------------------------------------------------------------------------

  /**
   * Every pack the account can use: the shipped ones, then its own that are
   * curated or still bound to one of its studies.
   * @param {string} userId @param {string} [query]
   */
  async listPacks(userId, query = "") {
    const shipped = [...this.shipped.values()].filter((pack) => vcrPackMatchesName(pack, query)).map((pack) => presentPackSummary("shipped", pack));
    const stored = (await this.store.listPacks(userId, { platformPacks: this.platform.enabled })).filter((row) => vcrPackMatchesName(row.body, query)).map((row) => presentPackSummary("stored", row.body, row));
    return { packs: [...shipped, ...stored] };
  }

  /**
   * One pack by id: a shipped pack's id (`nsclc`), the account's own row (`pkg_…`) or, with platform packs on, a platform version.
   * @param {string} userId @param {string} id @param {{ forBinding?: boolean }} [options] @returns {Promise<{ origin: "shipped" | "stored", pack: Record<string, any>, row: Record<string, any> | null }>}
   */
  async resolvePack(userId, id, { forBinding = false } = {}) {
    if (SHIPPED_ID.test(id) && this.shipped.has(id)) return { origin: "shipped", pack: /** @type {Record<string, any>} */ (this.shipped.get(id)), row: null };
    // Off, no platform row is read: the account's own pack is the only stored one there is.
    const row = !STORED_ID.test(id) ? null : this.platform.enabled
      ? await this.store.getReadablePack(userId, id, { platformPacks: true, forBinding }) : await this.store.getPack(userId, id);
    if (!row) throw new HttpError(404, "vcr_pack_not_found", "Knowledge pack not found.");
    return { origin: "stored", pack: row.body, row };
  }

  /** `GET /api/vcr/packs/:id`. @param {string} userId @param {string} id */
  async getPack(userId, id) {
    const { origin, pack, row } = await this.resolvePack(userId, id);
    return presentPack(origin, pack, row);
  }

  /**
   * The pack a study works from, resolved, or null.
   * @param {any} study
   */
  async studyPack(study) {
    const binding = await this.store.studyBinding(study.id);
    if (!binding) return null;
    try {
      return { binding, ...await this.resolvePack(study.userId, binding.packId) };
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Bind a study to a pack the account can use. Replaces what it was bound to.
   * @param {any} study @param {string} packId @param {string} actor
   */
  async bindPack(study, packId, actor) {
    // A retired platform version is not offered to a new binding, even to an account that pinned it for another study.
    const { origin, pack, row } = await this.resolvePack(study.userId, packId, { forBinding: true });
    const binding = await this.store.bindStudy({
      studyId: study.id, userId: study.userId, origin, packId: origin === "stored" ? String(row?.id) : String(pack.id),
      packVersion: Number(pack.version ?? 1), actor,
    });
    this.counters.packsBound += 1;
    return { binding, pack: presentPackSummary(origin, pack, row) };
  }

  /**
   * Write an AI draft for the study and bind the study to it. The document is
   * checked at the floor (`draft`) and refused whole, with every issue, when it
   * does not meet it; a study that works from a curated pack is not given a
   * draft.
   * @param {any} study @param {Record<string, any>} document the draft's head and sections
   * @param {string} actor
   * @returns {Promise<{ ok: true, id: string, pack: Record<string, any> } | { ok: false, issues: readonly { code: string, field: string, detail: string }[] }>}
   */
  async draftPack(study, document, actor) {
    const bound = await this.studyPack(study);
    if (bound && bound.pack.status === "curated") {
      return { ok: false, issues: [{ code: "pack_curated_in_use", field: "", detail: `这个研究已经按整理过的知识包「${bound.pack.disease?.nameZh ?? bound.pack.disease?.name ?? bound.pack.id}」工作，不再起草新的；要补充内容请改用定义与条件的写入。` }] };
    }
    const draftId = String(object(document.disease).key ?? "");
    const pack = { ...document, schema: VCR_PACK_SCHEMA, id: draftId, version: 1, status: "ai-draft", updated: agendaLocalDate(DISPLAY_TIME_ZONE, this.now()) };
    const issues = validateKnowledgePack(pack, { level: "draft" });
    if (issues.length) return { ok: false, issues };
    const row = await this.store.savePack({ userId: study.userId, studyId: study.id, diseaseKey: draftId, status: "ai-draft", body: pack, actor });
    await this.store.bindStudy({ studyId: study.id, userId: study.userId, origin: "stored", packId: String(row?.id), packVersion: Number(row?.version), actor });
    this.counters.packsDrafted += 1;
    return { ok: true, id: String(row?.id), pack: presentPackSummary("stored", row?.body ?? pack, row) };
  }

  /**
   * Promote the study's draft: reviewed, so curated. Held to the same floor
   * again, so what was written to the row since cannot have drifted below it.
   * @param {any} study @param {string} reviewer
   */
  async promotePack(study, reviewer) {
    const bound = await this.studyPack(study);
    if (!bound || bound.binding.origin !== "stored" || !bound.row) {
      throw new HttpError(404, "vcr_pack_not_found", "This study has no draft pack to promote.");
    }
    if (bound.row.status !== "ai-draft") throw new HttpError(409, "vcr_pack_invalid", "This pack is already curated.");
    const issues = validateKnowledgePack({ ...bound.pack, status: "ai-draft" }, { level: "draft" });
    if (issues.length) throw new PackIssues(issues);
    const promoted = await this.store.promotePack({ userId: study.userId, id: bound.row.id, reviewer });
    if (!promoted) throw new HttpError(409, "vcr_pack_invalid", "This pack is already curated.");
    this.counters.packsPromoted += 1;
    return presentPackSummary("stored", promoted.body, promoted);
  }

  // --- platform packs (flywheel F26) ---------------------------------------------------

  /**
   * The re-check of a pack: the validation it passed as a draft, held again, and the source-change ledger read for every source a
   * work identifier names. Pure over its inputs: the verdict is code, and the failing entries and sources are named.
   * @param {Record<string, any>} pack
   * @returns {Promise<{ passed: boolean, failing: Array<{ section: string | null, id: string, code: string, detail: string }>,
   *   checked: { entries: number, sources: number, lookedUp: number, unreadable: number, quotes: number } }>}
   */
  async recheckPack(pack) {
    const ledger = this.platform.sourceChanges;
    if (!ledger?.getMany) throw new HttpError(503, "vcr_unavailable", "The source-change ledger is not available, so a pack cannot be re-checked.");
    /** @type {Array<{ section: string | null, id: string, code: string, detail: string }>} */
    const failing = [];
    for (const issue of validateKnowledgePack({ ...pack, status: "curated" }, { level: "draft" })) {
      failing.push({ ...entryOfField(pack, issue.field), code: issue.code, detail: issue.detail });
    }
    const looked = await sourceChangesOf(pack, ledger, PROMOTION_BLOCKING_KINDS);
    for (const change of looked.changed) {
      const source = list(pack.sources).find((entry) => String(entry?.id) === change.sourceId);
      const label = `${source?.title ?? change.sourceId}（${change.identifier}）已有「${change.kind}」记录`;
      const citing = VCR_PACK_SECTIONS.flatMap((section) => list(pack[section]).filter((entry) => list(entry.sources).map(String).includes(change.sourceId))
        .map((entry) => ({ section, id: String(entry.id) })));
      if (!citing.length) failing.push({ section: "sources", id: change.sourceId, code: "source_changed", detail: label });
      for (const entry of citing) failing.push({ ...entry, code: "source_changed", detail: label });
    }
    return {
      passed: failing.length === 0, failing,
      checked: { entries: VCR_PACK_SECTIONS.reduce((total, section) => total + list(pack[section]).length, 0), sources: list(pack.sources).length,
        lookedUp: looked.lookedUp, unreadable: looked.unreadable, quotes: 0 },
    };
  }

  /**
   * `POST /api/vcr/studies/:id/pack/platform`: the study's lead asks for the pack the study works from to become a platform pack. The
   * pack has to be one of the account's own, already marked curated; it is re-checked and, when it passes, copied. A failing pack is
   * the account's still, and the answer names what failed. The same pack version asked for twice is the platform copy that exists.
   * @param {any} study @param {string} requestedBy
   */
  async requestPlatformPromotion(study, requestedBy) {
    if (!this.platform.enabled) throw new HttpError(404, "vcr_platform_packs_not_enabled", "Platform knowledge packs are not enabled.");
    const bound = await this.studyPack(study);
    if (!bound || bound.binding.origin !== "stored" || !bound.row || bound.row.userId !== study.userId) {
      throw new HttpError(404, "vcr_pack_not_found", "This study works from no pack of this account to promote.");
    }
    if (bound.row.status !== "curated") throw new HttpError(409, "vcr_pack_not_curated", "Only a pack the study's lead has marked curated can become a platform pack.");
    const existing = await this.store.livePlatformCopyOf(study.userId, bound.row.id, bound.row.version);
    if (existing) {
      const copy = await this.store.getReadablePack(study.userId, String(existing.pack_id), { platformPacks: true });
      return { state: "passed", existing: true, failing: [], checked: null, platformPack: copy ? presentPackSummary("stored", copy.body, copy) : null };
    }
    const result = await this.recheckPack(bound.pack);
    const promotionId = vcrKnowledgeId("promotion");
    if (!result.passed) {
      this.counters.platformFailed += 1;
      await this.store.recordPromotion({ id: promotionId, userId: study.userId, packId: bound.row.id, packVersion: bound.row.version, requestedBy,
        state: "failed", failing: result.failing, checked: result.checked });
      return { state: "failed", existing: false, failing: result.failing, checked: result.checked, platformPack: null };
    }
    const disease = object(bound.pack.disease);
    const names = [disease.name, disease.nameZh, ...list(disease.aliases), ...list(disease.aliasesZh)].filter((name) => typeof name === "string" && name.trim());
    const tagged = await this.platform.entityVocabulary?.tag?.({ texts: names }).catch(() => null);
    const entityKeys = list(tagged).map(String).filter((key) => key.startsWith("disease:"));
    const zoneId = entityKeys.length && this.platform.officialZoneForKeys ? await this.platform.officialZoneForKeys(entityKeys).catch(() => null) : null;
    const author = (await this.platform.people?.([study.userId]))?.get(study.userId) ?? "";
    const copy = await this.store.promoteToPlatform({ publisherId: this.platform.publisherId, source: /** @type {any} */ (bound.row), authorName: author, entityKeys, zoneId,
      recheck: { passedAt: this.now().toISOString(), checked: result.checked }, actor: requestedBy });
    await this.store.recordPromotion({ id: promotionId, userId: study.userId, packId: bound.row.id, packVersion: bound.row.version, requestedBy,
      state: "passed", failing: [], checked: result.checked, platformPackId: String(copy.id) });
    this.counters.platformPassed += 1;
    return { state: "passed", existing: false, failing: [], checked: result.checked, platformPack: presentPackSummary("stored", copy.body, copy) };
  }

  /**
   * `DELETE /api/vcr/packs/:id/platform`: the author takes their name off a platform pack. It is retired for new studies; the
   * studies that pinned the version keep it. Only the account the pack was copied from may do it.
   * @param {string} userId @param {string} platformPackId
   */
  async withdrawPlatformPack(userId, platformPackId) {
    if (!this.platform.enabled) throw new HttpError(404, "vcr_platform_packs_not_enabled", "Platform knowledge packs are not enabled.");
    const retired = await this.store.retirePlatformPack({ userId, platformPackId, reason: "author_withdrew" });
    if (!retired) throw new HttpError(404, "vcr_pack_not_found", "Knowledge pack not found.");
    this.counters.platformWithdrawn += 1;
    return { id: platformPackId, state: "retired", retiredAt: retired.retiredAt };
  }

  /**
   * The live platform packs whose disease shares an entity key with `keys`, as the summary a zone page links: a zone asks with
   * the keys of what it is about.
   * @param {readonly string[]} keys
   */
  async packsForEntityKeys(keys) {
    if (!this.platform.enabled) return [];
    return (await this.store.platformPacksForKeys(keys)).map((row) => ({ ...presentPackSummary("stored", row.body, row), id: row.id }));
  }

  /**
   * The source watch: a bounded batch of live platform packs, oldest looked at first, each labelled 「来源有变更」 when the
   * source-change ledger now holds a change to one of its sources, and unlabelled when it no longer says so. Never rewrites a pack.
   * @param {{ limit?: number }} [options]
   */
  async watchPlatformPackSources({ limit = 20 } = {}) {
    const ledger = this.platform.sourceChanges;
    if (!this.platform.enabled || !ledger?.getMany) return { checked: 0, changed: 0 };
    let changed = 0;
    const packs = await this.store.platformPacksToCheck(limit);
    for (const pack of packs) {
      const looked = await sourceChangesOf(pack.body, ledger, WATCH_KINDS);
      await this.store.markSourceChanges({ platformPackId: pack.id, changes: looked.changed, watchedAt: this.now().toISOString() });
      if (looked.changed.length) { changed += 1; this.counters.platformSourcesChanged += 1; }
    }
    return { checked: packs.length, changed };
  }

  /**
   * What the study page shows: the pack it works from (summary, not sections),
   * the definitions it used and the comparisons it ran.
   * @param {any} study @param {{ canPromote?: boolean }} [options]
   */
  async studyKnowledge(study, { canPromote = false } = {}) {
    const [bound, definitions, comparisons] = await Promise.all([
      this.studyPack(study), this.store.definitionsUsedBy(study.id, study.userId), this.store.comparisonResults(study.id),
    ]);
    const pack = bound ? presentPackSummary(bound.binding.origin, bound.pack, bound.row) : null;
    // The platform pack side (flywheel F26): a curated pack of the account may be offered to the platform, and what the last re-check said.
    const own = Boolean(bound?.row && !bound.row.platform && bound.row.userId === study.userId);
    const latest = this.platform.enabled && own && bound?.row ? await this.store.latestPromotion(study.userId, bound.row.id) : null;
    const live = this.platform.enabled && own && bound?.row ? await this.store.livePlatformCopyOf(study.userId, bound.row.id, bound.row.version) : null;
    const platform = this.platform.enabled && own
      ? { canRequest: Boolean(canPromote && bound?.row?.status === "curated" && !live), requested: Boolean(live),
        recheck: latest && latest.packVersion === bound?.row?.version ? { state: latest.state, failing: latest.failing, checked: latest.checked, at: latest.createdAt } : null }
      : null;
    return {
      pack: pack ? { ...pack, boundAt: bound?.binding.boundAt ?? null, canPromote: Boolean(canPromote && bound?.row && bound.row.status === "ai-draft"),
        ...(platform ? { platformRequest: platform } : {}) } : null,
      definitions: definitions.map((entry) => ({ ...entry, packRefs: entry.packRefs })),
      comparisons: comparisons.map(presentComparison).filter(Boolean),
    };
  }

  /**
   * What a run reads for `pack`: the study's pack (all of it, or one section),
   * or — when there is none, or a search word is given — the catalogue of packs
   * to choose from. Also the dataset mapping, when the study has a field map.
   * @param {any} study @param {{ query?: string, kind?: string }} filter
   */
  async runtimeReadPack(study, filter = {}) {
    const query = String(filter.query ?? "").trim();
    const bound = query ? null : await this.studyPack(study);
    if (!bound) {
      const catalogue = await this.listPacks(study.userId, query);
      return { bound: null, packs: catalogue.packs.map(({ sources: _sources, ...rest }) => rest),
        note: "没有绑定知识包：从 packs 里选一份用 vcr_write what=pack data={use:<id>} 绑定，或为这个病种起草一份。" };
    }
    const section = filter.kind ? String(filter.kind) : null;
    if (section && !VCR_PACK_SECTIONS.includes(/** @type {any} */ (section))) {
      throw new HttpError(400, "vcr_read_filter_invalid", `filter.kind for a pack is one of: ${VCR_PACK_SECTIONS.join(", ")}.`);
    }
    const summary = presentPackSummary(bound.binding.origin, bound.pack, bound.row);
    const mapping = await this.packMapping(study, bound.pack);
    const head = {
      bound: { origin: summary.origin, id: summary.id, status: summary.status, version: summary.version, name: summary.name, nameZh: summary.nameZh, counts: summary.counts },
      disease: bound.pack.disease, mapping,
    };
    // No section named: the index. A section named: that section whole, with the sources its entries cite.
    if (!section) return { ...head, sections: packIndex(bound.pack), note: "按 filter.kind 取一节读全：endpoints、criteria、phenotypes、terms、mappings 或 background。" };
    return { ...head, sections: { [section]: list(bound.pack[section]) }, sources: citedSources(bound.pack, list(bound.pack[section])) };
  }

  /**
   * Which dataset column realises each concept the pack maps, from the field
   * maps of the study's registered sources. `null` when the study has no
   * registered source or the data store is not composed.
   * @param {any} study @param {Record<string, any>} pack
   */
  async packMapping(study, pack) {
    if (!this.dataStore?.listSourcesForStudy || !list(pack?.mappings).length) return null;
    const sources = await this.dataStore.listSourcesForStudy(study.id).catch(() => []);
    const entries = sources.flatMap((/** @type {any} */ source) => list(source.fieldMap?.columns).map((/** @type {any} */ column) => ({
      table: String(column.table ?? ""), column: String(column.column ?? ""), concept: String(column.concept ?? ""),
    })));
    if (!entries.length) return null;
    return vcrPackConceptColumns(pack, entries);
  }

  /**
   * For the matching run: the pack's concept for each variable the protocol's
   * criteria name (label, type, unit, the codes a dataset writes), the variables
   * the pack does not know, and — when the study has a registered field map —
   * the dataset columns that realise the concepts the criteria use.
   * @param {any} study @param {{ pack: Record<string, any>, binding: Record<string, any>, row: Record<string, any> | null }} bound
   * @param {readonly Record<string, any>[]} criteria
   */
  async matchingGuide(study, bound, criteria) {
    const pack = bound.pack;
    const used = new Set(criteria.flatMap((criterion) => [...vcrRequirementVariables(criterion.requirement), ...vcrRequirementVariables(criterion.applicability)]));
    const known = new Map(list(pack.mappings).map((mapping) => [String(mapping.concept), mapping]));
    const dataset = await this.packMapping(study, pack);
    return {
      pack: { origin: bound.binding.origin, id: bound.binding.origin === "stored" ? String(bound.row?.id) : String(pack.id), status: String(pack.status ?? "ai-draft") },
      concepts: [...used].filter((variable) => known.has(variable)).map((variable) => {
        const mapping = /** @type {Record<string, any>} */ (known.get(variable));
        return { concept: variable, label: mapping.label ?? null, labelZh: mapping.labelZh ?? null, type: mapping.type, unit: mapping.unit ?? null, codes: list(mapping.codes) };
      }),
      outsidePack: [...used].filter((variable) => !known.has(variable)),
      dataset: dataset ? {
        realised: dataset.realised.filter((entry) => used.has(entry.concept)), missing: dataset.missing.filter((concept) => used.has(concept)), unknown: dataset.unknown,
      } : null,
    };
  }

  /**
   * The runtime's pack write: bind a study to a pack (`{ use }`) or draft one
   * (`{ disease, … }`).
   * @param {any} study @param {Record<string, any>} row @param {string} actor
   * @returns {Promise<{ ok: true, id: string, bound?: Record<string, any>, pack?: Record<string, any> } | { ok: false, issues: readonly { code: string, field: string, detail: string }[] }>}
   */
  async writePack(study, row, actor) {
    if (row.use !== undefined) {
      const extra = Object.keys(row).filter((key) => key !== "use");
      if (extra.length) return { ok: false, issues: [{ code: "pack_shape_invalid", field: extra[0], detail: "A binding is { use: <pack id> } and nothing else." }] };
      if (typeof row.use !== "string" || !ID.test(row.use)) return { ok: false, issues: [{ code: "pack_shape_invalid", field: "use", detail: "use is a pack id from the catalogue." }] };
      try {
        const done = await this.bindPack(study, row.use, actor);
        return { ok: true, id: done.binding?.packId ?? row.use, bound: done.pack };
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return { ok: false, issues: [{ code: "pack_unknown", field: "use", detail: "No such pack in the catalogue (read what=pack to list it)." }] };
        throw error;
      }
    }
    for (const key of ["schema", "id", "version", "status", "updated"]) {
      if (row[key] !== undefined) return { ok: false, issues: [{ code: "pack_shape_invalid", field: key, detail: `${key} is set by the platform; a draft does not carry it.` }] };
    }
    const done = await this.draftPack(study, row, actor);
    return done.ok ? { ok: true, id: done.id, bound: done.pack } : done;
  }

  // --- the library ------------------------------------------------------------------

  /**
   * `GET /api/vcr/definitions`: the account's library.
   * @param {string} userId @param {string} [query]
   */
  async listLibrary(userId, query = "") {
    const wanted = String(query ?? "").trim().toLowerCase();
    const all = await this.store.listDefinitions(userId);
    const definitions = all.filter((entry) => !wanted || entry.name.toLowerCase().includes(wanted) || String(entry.latest?.text ?? "").toLowerCase().includes(wanted));
    return { definitions: definitions.map((entry) => ({
      id: entry.id, name: entry.name, versions: entry.versions, uses: entry.uses, updatedAt: entry.updatedAt,
      latest: entry.latest ? presentVersion(entry.latest) : null,
    })) };
  }

  /** `GET /api/vcr/definitions/:id`. @param {string} userId @param {string} id */
  async getLibraryDefinition(userId, id) {
    const found = ID.test(id) ? await this.store.getDefinition(userId, id) : null;
    if (!found) throw new HttpError(404, "vcr_definition_not_found", "Definition not found.");
    return { id: found.id, name: found.name, createdAt: found.createdAt, updatedAt: found.updatedAt, uses: found.studyCount,
      versions: found.versions.slice(0, VCR_LIBRARY_LIMITS.versionsListed).map(presentVersion),
      studies: found.uses.map((use) => ({ version: use.version, studyId: use.studyId, studyName: use.studyName, at: use.at })) };
  }

  /**
   * Save one of the study's population definitions into the account's library:
   * a new definition, or the next version of one of its own. The pack entries
   * it rests on are what the study's pack maps to the columns its rules read,
   * plus any the caller names that exist in the pack.
   * @param {any} study @param {{ populationId: string, name?: string, text?: string, definitionId?: string | null,
   *   packEntries?: Array<{ section: string, id: string }> }} input @param {string} actor
   */
  async saveFromStudy(study, input, actor) {
    const populations = await this.studyStore.populations(study.id, 100);
    const population = populations.find((/** @type {any} */ row) => row.id === input.populationId);
    if (!population) throw new HttpError(404, "vcr_object_unknown", "This study has no such population.");
    if (population.kind !== "real") throw new HttpError(400, "vcr_definition_invalid", "Only a population defined by rules on real data can be saved to the library.");
    const body = definitionBodyOf(object(population.definition));
    const problems = validateNamedRules(body.rules, { path: "rules" });
    if (problems.length) throw new HttpError(400, "vcr_definition_invalid", `这个人群的条件不符合规则语法：${problems[0].field}（${problems[0].detail}）。`);
    const name = String(input.name ?? population.name ?? "").trim().slice(0, VCR_LIBRARY_LIMITS.name);
    const text = String(input.text ?? "").trim().slice(0, VCR_LIBRARY_LIMITS.text);
    if (!input.definitionId && !name) throw new HttpError(400, "vcr_definition_invalid", "A new library entry needs a name.");
    if (!text) throw new HttpError(400, "vcr_definition_invalid", "A library entry carries the plain-language description of who is in.");
    const packRefs = await this.packRefsFor(study, body, input.packEntries ?? []);
    const saved = await this.store.saveDefinitionVersion({
      userId: study.userId, definitionId: input.definitionId ?? null, name, text, body, packRefs, studyId: study.id, populationId: population.id, actor,
    });
    if (!saved) throw new HttpError(404, "vcr_definition_not_found", "Definition not found.");
    this.counters.definitionsSaved += 1;
    return { definitionId: saved.definition.id, name: saved.definition.name, version: saved.version.version, packRefs };
  }

  /**
   * The pack entries a definition rests on: each mapping of the study's pack
   * whose concept or field names the rules' columns match, and the entries the
   * caller names (checked to exist). Whole-string, case-insensitive.
   * @param {any} study @param {Record<string, any>} body @param {Array<{ section: string, id: string }>} named
   */
  async packRefsFor(study, body, named) {
    const bound = await this.studyPack(study);
    if (!bound) return [];
    const pack = bound.pack;
    const norm = (/** @type {unknown} */ value) => String(value ?? "").trim().toLowerCase();
    const columns = new Set(list(body.rules).flatMap((/** @type {any} */ step) => vcrRowRuleColumns(step?.rule)).map(norm));
    const packId = bound.binding.origin === "stored" ? String(bound.row?.id) : String(pack.id);
    /** @type {Array<Record<string, any>>} */
    const refs = [];
    for (const mapping of list(pack.mappings)) {
      const names = [mapping.concept, ...list(mapping.fieldNames)].map(norm);
      const hit = names.find((name) => columns.has(name));
      if (hit) refs.push({ pack: packId, version: Number(pack.version ?? 1), section: "mappings", id: String(mapping.id), concept: String(mapping.concept) });
    }
    for (const entry of named.slice(0, VCR_LIBRARY_LIMITS.packRefs)) {
      const section = String(object(entry).section ?? "");
      const id = String(object(entry).id ?? "");
      if (!VCR_PACK_SECTIONS.includes(/** @type {any} */ (section)) || !list(pack[section]).some((each) => object(each).id === id)) {
        throw new HttpError(400, "vcr_definition_invalid", `The pack has no ${section} entry ${JSON.stringify(id)}.`);
      }
      if (!refs.some((ref) => ref.section === section && ref.id === id)) refs.push({ pack: packId, version: Number(pack.version ?? 1), section, id });
    }
    return refs;
  }

  /**
   * The columns of the study's latest snapshot's subject table, or `null` when
   * the study has none. What a reused definition's rules are held against.
   * @param {any} study @param {string | null} [snapshotId]
   * @returns {Promise<{ snapshotId: string, header: string[] } | null>}
   */
  async subjectHeader(study, snapshotId = null) {
    if (!this.dataStore?.listSnapshots || !this.dataStore?.listAnalysisTables) return null;
    const snapshots = await this.dataStore.listSnapshots({ studyId: study.id });
    const snapshot = snapshotId ? snapshots.find((/** @type {any} */ row) => row.id === snapshotId) : snapshots[0];
    if (!snapshot) return null;
    const tables = await this.dataStore.listAnalysisTables({ snapshotId: snapshot.id, studyId: study.id });
    const subject = tables.find((/** @type {any} */ table) => table.shape === "subject");
    if (!subject) return null;
    return { snapshotId: String(snapshot.id), header: list(subject.columns).map(String) };
  }

  /**
   * Use a version of a library definition in a study: the population the study
   * defines from it, with the renames made and the columns left unmatched
   * reported. A use is recorded for the study (once per version).
   * @param {any} study @param {{ definitionId: string, version?: number | null, name?: string, columnMap?: Record<string, string> | null,
   *   snapshotId?: string | null }} input @param {string} actor
   */
  async useInStudy(study, input, actor) {
    const found = ID.test(String(input.definitionId)) ? await this.store.getDefinition(study.userId, input.definitionId) : null;
    if (!found) throw new HttpError(404, "vcr_definition_not_found", "Definition not found.");
    const wanted = input.version == null ? found.versions[0]?.version : Number(input.version);
    const version = found.versions.find((entry) => entry.version === wanted);
    if (!version) throw new HttpError(404, "vcr_definition_not_found", "Definition version not found.");
    const rules = list(version.body?.rules);
    const columns = [...new Set(rules.flatMap((/** @type {any} */ step) => vcrRowRuleColumns(step?.rule)))];
    const target = await this.subjectHeader(study, input.snapshotId ?? null);
    /** @type {Record<string, string>} */
    const chosen = {};
    for (const [from, to] of Object.entries(object(input.columnMap))) {
      if (typeof to === "string" && columns.includes(from) && /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/.test(to)) chosen[from] = to;
    }
    /** @type {Array<{ from: string, to: string, concept?: string, by: "caller" | "pack" }>} */
    const renamed = Object.entries(chosen).map(([from, to]) => ({ from, to, by: /** @type {const} */ ("caller") }));
    /** @type {string[]} */
    let unmatched = [];
    if (target) {
      const pending = columns.filter((column) => !(column in chosen));
      const bound = await this.studyPack(study);
      const { suggested, unmatched: rest } = vcrSuggestColumnRemap(bound?.pack ?? null, pending, target.header);
      for (const entry of suggested) { chosen[entry.from] = entry.to; renamed.push({ ...entry, by: "pack" }); }
      unmatched = rest.filter((column) => !(column in chosen));
    }
    const body = { ...version.body, rules: rules.map((/** @type {any} */ step) => ({ ...step, rule: vcrRemapRowRuleColumns(step.rule, chosen) })) };
    for (const key of ["timeZero", "exit"]) {
      const column = object(version.body?.[key]).column;
      if (typeof column === "string" && chosen[column]) body[key] = { ...object(version.body[key]), column: chosen[column] };
    }
    // Columns the target lacks are not refused here: the definition is saved, and the answer lists them.
    const problems = validateNamedRules(body.rules, { path: "rules" });
    if (problems.length) throw new HttpError(400, "vcr_definition_invalid", `这条定义的条件不符合规则语法：${problems[0].field}（${problems[0].detail}）。`);
    const population = await this.studyStore.savePopulation({
      studyId: study.id, userId: study.userId, name: String(input.name ?? found.name).slice(0, VCR_LIBRARY_LIMITS.name), kind: "real", definition: body,
      snapshotId: target?.snapshotId ?? null, reviewState: "ai_set", profile: {}, quality: {}, waterfall: [],
    });
    await this.store.recordDefinitionUse({ userId: study.userId, definitionId: found.id, version: version.version, studyId: study.id, populationId: population.id, actor });
    this.counters.definitionsReused += 1;
    return { populationId: population.id, definitionId: found.id, version: version.version, renamed, unmatched };
  }

  /**
   * Queue the engine's comparison of two versions of a definition on one
   * registered dataset: `cohort.build` with the second version as `compare`.
   * @param {any} study @param {{ id: string }} user @param {{ definitionId: string, versionA: number, versionB: number,
   *   snapshotId?: string | null, covariates?: string[] | null }} input
   */
  async compareVersions(study, user, input) {
    if (!this.jobs?.enqueue) throw new HttpError(503, "vcr_unavailable", "The job queue is not available on this deployment yet.");
    const found = ID.test(String(input.definitionId)) ? await this.store.getDefinition(study.userId, input.definitionId) : null;
    if (!found) throw new HttpError(404, "vcr_definition_not_found", "Definition not found.");
    const [a, b] = [input.versionA, input.versionB].map((wanted) => found.versions.find((entry) => entry.version === Number(wanted)));
    if (!a || !b) throw new HttpError(404, "vcr_definition_not_found", "Definition version not found.");
    if (a.version === b.version) throw new HttpError(400, "vcr_definition_invalid", "Compare two different versions.");
    const target = await this.subjectHeader(study, input.snapshotId ?? null);
    if (!target) throw new HttpError(400, "vcr_definition_invalid", "The study has no registered dataset with a subject table to apply the two versions to.");
    const skipped = new Set(["USUBJID"]);
    const asked = input.covariates == null ? null : list(input.covariates).map(String);
    if (asked && asked.some((column) => !target.header.includes(column))) {
      throw new HttpError(400, "vcr_definition_invalid", "A covariate is not a column of the dataset's subject table.");
    }
    const covariates = (asked ?? target.header.filter((column) => !skipped.has(column))).filter((column) => /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/.test(column))
      .slice(0, VCR_LIBRARY_LIMITS.covariates);
    if (!covariates.length) throw new HttpError(400, "vcr_definition_invalid", "The dataset's subject table has no covariate column to compare on.");
    const subjectId = `defcmp:${found.id}:${a.version}:${b.version}:${target.snapshotId}`;
    const scenario = {
      ...a.body, compare: { rules: list(b.body?.rules), covariates },
    };
    const { job, created } = await this.jobs.enqueue({
      studyId: study.id, userId: String(user.id), kind: "build_cohort", scenario, inputs: [{ kind: "snapshot", id: target.snapshotId }],
      detail: { resultKind: VCR_COMPARISON_RESULT_KIND, subjectId, definitionId: found.id, versionA: a.version, versionB: b.version },
    });
    this.counters.comparisons += 1;
    return { job, created, subjectId };
  }

  // --- the runtime's read of the library ------------------------------------------------

  /**
   * What a run reads for `library`: the account's definitions with their latest
   * version's rules and text, and what this study has used.
   * @param {any} study @param {{ query?: string, limit?: number }} filter
   */
  async runtimeReadLibrary(study, filter = {}) {
    const library = await this.listLibrary(study.userId, String(filter.query ?? ""));
    const limit = Math.min(50, Math.max(1, Number(filter.limit ?? 20)));
    return {
      definitions: library.definitions.slice(0, limit), more: library.definitions.length > limit,
      used: (await this.store.definitionsUsedBy(study.id, study.userId)).map((entry) => ({
        definitionId: entry.definitionId, version: entry.version, name: entry.name, populationId: entry.populationId,
      })),
    };
  }
}

/**
 * A finished comparison as a page reads it: which versions, on which dataset,
 * the sizes and the standardized difference of each covariate — all of it
 * the engine's, none computed here.
 * @param {{ id: string, subjectId: string | null, version: number, diagnostics: Record<string, any>, createdAt: string | null }} result
 */
export function presentComparison(result) {
  const parts = String(result.subjectId ?? "").split(":");
  const comparison = object(result.diagnostics?.comparison);
  if (parts[0] !== "defcmp" || !Object.keys(comparison).length) return null;
  return {
    id: result.id, definitionId: parts[1], versionA: Number(parts[2]), versionB: Number(parts[3]), snapshotId: parts[4] ?? null,
    createdAt: result.createdAt,
    cohortSizeA: comparison.cohortSizeA ?? null, cohortSizeB: comparison.cohortSizeB ?? null, overlap: object(comparison.overlap),
    waterfallA: list(comparison.waterfallA), waterfallB: list(comparison.waterfallB),
    covariates: list(comparison.covariates).map((entry) => object(entry)),
    floor: comparison.standardizedDifferenceFloor ?? null, binaryConvention: comparison.binaryConvention ?? null,
  };
}
