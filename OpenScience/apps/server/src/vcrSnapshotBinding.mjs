/**
 * Which data snapshot a computation read, and whether it is the one a real population names (2026-10-31).
 *
 * A real population is a definition (its rules) on one frozen snapshot, and each save is a new version with its own id. A cohort
 * result is filed under that population's id, so everything a page says of the population (its counts, its waterfall, its
 * progress) is only as true as the claim "this result was computed on this population's snapshot". Nothing used to hold that
 * claim: a conversation that named a population on snapshot A and the inputs of snapshots A, B and C got one result, filed under
 * the population, counting people of all three (an evaluation on PhysioNet 2012 read 6,557 where set A alone has 2,181).
 *
 * Hidden knowledge:
 *
 * - **The snapshot is read off the input ids, not off the request.** What the engine receives is `analysis_table` / `snapshot_file`
 *   entries whose id is `<snapshot id>:<shape or position>` (`snapshotInputId` in `vcrDataPlane.mjs`); an execution records
 *   exactly those. A request may name a snapshot (`{ kind: "snapshot", id }`) before the data plane resolves it, so both spellings
 *   are read. A derived table (`location` under `derived/`) is the control plane's own file and names no snapshot.
 * - **Unknown is not a mismatch.** An execution that recorded no snapshot input (a result with no execution, an old row) cannot
 *   be compared; the result stays where it is and the state says `unverified`. Only a snapshot that is positively another one
 *   (or one more than the population's) takes a result off the population.
 * - **Refuse at the queue, hide on the read.** `vcrCohortInputIssue` is the refusal a job is given before it is queued;
 *   `vcrCohortBinding` is the reading of a result that already exists, so a result computed before the refusal existed stops
 *   being counted under a population it does not belong to, and stays in the record as the history it is.
 *
 * @module vcrSnapshotBinding
 */

import { canonicalScenarioJson } from "@evimed/domain";

/** The one code both refusals carry: the computation and the population it is filed under disagree. */
export const VCR_COHORT_BINDING_CODE = "vcr_cohort_binding_mismatch";

/** @param {unknown} value @returns {Record<string, any>} */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value @returns {any[]} */
const list = (value) => (Array.isArray(value) ? value : []);

/** The snapshot an input id names: everything before the last colon. @param {unknown} id */
function snapshotOfInputId(id) {
  const text = typeof id === "string" ? id : "";
  const cut = text.lastIndexOf(":");
  return cut > 0 ? text.slice(0, cut) : null;
}

/**
 * The snapshots a list of inputs reads, sorted and without repeats.
 * @param {unknown} inputs requested (`{ kind: "snapshot", id }`) or resolved (`analysis_table` / `snapshot_file`) entries
 * @returns {string[]}
 */
export function vcrSnapshotIdsOf(inputs) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const raw of list(inputs)) {
    const entry = object(raw);
    if (entry.kind === "snapshot" && typeof entry.id === "string" && entry.id) ids.add(entry.id);
    else if (["analysis_table", "snapshot_file"].includes(entry.kind) && !String(entry.location ?? "").startsWith("derived/")) {
      const snapshotId = snapshotOfInputId(entry.id);
      if (snapshotId) ids.add(snapshotId);
    }
  }
  return [...ids].sort();
}

/**
 * Whether an existing computation read this population's snapshot.
 * `not_required`: not a real population (a scenario, a literature table and a synthetic one have no snapshot); `unbound`: a real
 * population that names no snapshot; `unverified`: the inputs name none; `matches`: only the population's own; `other_snapshot`:
 * any other, alone or beside it.
 * @param {Record<string, any> | null | undefined} population @param {unknown} inputs
 * @returns {{ state: "not_required" | "unbound" | "unverified" | "matches" | "other_snapshot", snapshotIds: string[] }}
 */
export function vcrCohortBinding(population, inputs) {
  if (!population || population.kind !== "real") return { state: "not_required", snapshotIds: [] };
  const snapshotIds = vcrSnapshotIdsOf(inputs);
  if (!population.snapshotId) return { state: "unbound", snapshotIds };
  if (!snapshotIds.length) return { state: "unverified", snapshotIds };
  return { state: snapshotIds.every((id) => id === population.snapshotId) ? "matches" : "other_snapshot", snapshotIds };
}

/**
 * The refusal a cohort job is given when it is not about the population it will be filed under, or `null`. Said with the way out:
 * a recomputation on another snapshot, or under other rules, is a new population version, and the old version keeps its result.
 * @param {Record<string, any>} population
 * @param {unknown} inputs requested or resolved, whichever the caller holds
 * @param {Record<string, any>} [scenario] the rules the job will apply
 * @returns {{ code: string, message: string } | null}
 */
export function vcrCohortInputIssue(population, inputs, scenario = {}) {
  if (population?.kind !== "real") return null;
  const label = `人群 v${Number(population.version) || 1}`;
  if (!population.snapshotId) {
    return { code: VCR_COHORT_BINDING_CODE,
      message: `${label}没有绑定数据快照，队列不知道该在哪份数据上算：先用 vcr_write what="population" 写一个 kind real 的新版本，带上 snapshotId，再用它算队列。` };
  }
  const others = vcrSnapshotIdsOf(inputs).filter((id) => id !== population.snapshotId);
  if (others.length) {
    return { code: VCR_COHORT_BINDING_CODE,
      message: `${label}绑定的是数据快照 ${population.snapshotId}，这次计算还读了 ${others.slice(0, 3).join("、")}${others.length > 3 ? " 等" : ""}：队列只能在人群自己的快照上算。`
        + "要在另一份快照上算，先写一个带那份 snapshotId 的新人群版本再算；旧版本和它的结果原样保留。" };
  }
  const defined = object(population.definition).rules;
  const asked = object(scenario).rules;
  if (Array.isArray(defined) && defined.length && Array.isArray(asked) && asked.length && canonicalScenarioJson(defined) !== canonicalScenarioJson(asked)) {
    return { code: VCR_COHORT_BINDING_CODE,
      message: `这次的入选规则和${label}保存的规则不一样：结果会记在这个人群名下，却不是它的定义算出来的。`
        + "改规则就写一个新的人群版本，再用新版本算；不传 scenario，队列按人群自己的规则算。" };
  }
  return null;
}

/**
 * Populations as a reader may take them: a real population whose result was computed on another snapshot has no result of its own,
 * so every page, count and progress line that follows `resultId` reads none. The result stays in the record, and the population says
 * which one it left out (`resultOtherSnapshot`) so a page can say so instead of drawing nothing.
 * @param {readonly Record<string, any>[]} populations
 * @param {readonly Record<string, any>[]} results every result the caller holds, superseded ones included
 * @param {{ get: (id: string) => { inputs?: unknown } | undefined } | null} executions by execution id
 * @returns {Record<string, any>[]}
 */
export function vcrPopulationsWithOwnResults(populations, results, executions) {
  return populations.map((population) => {
    if (population.kind !== "real" || !population.resultId) return population;
    const result = results.find((row) => row.id === population.resultId);
    const execution = result?.executionId ? executions?.get(result.executionId) : undefined;
    const binding = vcrCohortBinding(population, execution?.inputs);
    return binding.state === "other_snapshot"
      ? { ...population, resultId: null, resultOtherSnapshot: { resultId: String(population.resultId), snapshotIds: binding.snapshotIds } }
      : population;
  });
}
