/**
 * Name the studies that were made before a definition named them.
 *
 * Every study made before R10 is called 「新虚拟临研研究」 — the first thing the
 * module did was make a study and never say what it was about — and every one
 * the owner opened is still `active`. A study's next definition now names it
 * (`VcrStore.saveDefinition`); this is the one-off that does it for those that
 * will not get a next definition soon, from what they already hold: the question
 * on the row, else the population and intervention of the latest definition.
 *
 *   node scripts/vcr/rename-from-definition.mjs                   # report, for every study that is still unnamed
 *   node scripts/vcr/rename-from-definition.mjs --study <std_…>   # report, for one study
 *   node scripts/vcr/rename-from-definition.mjs --apply           # write the names (and the projects')
 *
 * Idempotent: a named study is not unnamed any more, so a second run plans nothing. A study that has nothing to be named from (no
 * question, no definition that states a population or intervention) is listed with `to: null` and left as it is. A project the
 * researcher renamed since is left alone.
 *
 * @module vcrNaming
 */

import { VCR_DRAFT_STUDY_NAME, VCR_LEGACY_DEFAULT_STUDY_NAME } from "@evimed/domain";

import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { vcrMonthDay, vcrStudyNameFrom } from "./vcrStore.mjs";

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});

/**
 * What the unnamed studies would be called, and nothing written.
 * @param {{ store: any, studyId?: string | null }} input
 * @returns {Promise<Array<{ studyId: string, userId: string, projectId: string, from: string, to: string | null }>>}
 */
export async function planStudyNames({ store, studyId = null }) {
  const rows = await store.rows(`SELECT id, user_id, project_id, name, question, created_at FROM ${VCR_SCHEMA}.studies
    WHERE deleted_at IS NULL AND status <> 'draft' AND name = ANY($1::text[]) AND ($2::text IS NULL OR id = $2)
    ORDER BY created_at, id`, [[VCR_DRAFT_STUDY_NAME, VCR_LEGACY_DEFAULT_STUDY_NAME], studyId]);
  /** @type {Map<string, Set<string>>} the names each account already has, grown as this plan hands names out */
  const taken = new Map();
  const namesOf = async (/** @type {string} */ userId) => {
    if (!taken.has(userId)) {
      const named = await store.rows(`SELECT name FROM ${VCR_SCHEMA}.studies WHERE user_id = $1 AND deleted_at IS NULL AND status <> 'draft'`, [userId]);
      taken.set(userId, new Set(named.map((/** @type {any} */ row) => String(row.name))));
    }
    return /** @type {Set<string>} */ (taken.get(userId));
  };
  const plan = [];
  for (const row of rows) {
    const definition = await store.latestDefinition(String(row.id));
    const pico = object(definition?.pico);
    const stated = [pico.population, pico.intervention].filter((value) => typeof value === "string" && value.trim()).join(" ");
    const proposed = vcrStudyNameFrom({ question: String(row.question ?? "") || stated });
    const names = await namesOf(String(row.user_id));
    let to = proposed;
    if (to && names.has(to)) {
      const dated = `${[...to].slice(0, 32).join("")} ${vcrMonthDay(row.created_at)}`;
      to = dated;
      for (let n = 2; names.has(to) && n < 50; n += 1) to = `${dated} ${n}`;
    }
    if (to) names.add(to);
    plan.push({ studyId: String(row.id), userId: String(row.user_id), projectId: String(row.project_id), from: String(row.name), to });
  }
  return plan;
}

/**
 * Write a plan: each study's name and, where it still carries the old one, its project's.
 * @param {{ store: any, renameProject: (user: { id: string }, projectId: string, name: string) => Promise<unknown>,
 *   currentProjectName: (userId: string, projectId: string) => Promise<string | null>,
 *   plan: ReadonlyArray<{ studyId: string, userId: string, projectId: string, from: string, to: string | null }> }} input
 * @returns {Promise<{ renamed: number, projectsRenamed: number, left: number }>}
 */
export async function applyStudyNames({ store, renameProject, currentProjectName, plan }) {
  let renamed = 0;
  let projectsRenamed = 0;
  let left = 0;
  for (const entry of plan) {
    if (!entry.to) { left += 1; continue; }
    await store.updateStudy(entry.studyId, { name: entry.to }, "rename-from-definition");
    renamed += 1;
    if ((await currentProjectName(entry.userId, entry.projectId)) === entry.from) {
      await renameProject({ id: entry.userId }, entry.projectId, [...entry.to].slice(0, 40).join(""));
      projectsRenamed += 1;
    }
  }
  return { renamed, projectsRenamed, left };
}
