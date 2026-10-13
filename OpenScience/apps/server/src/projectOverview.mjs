/**
 * What the memory page's 项目 tab says about one project above its list of
 * memories (2026-10-12, owner's choice A: the account-level views are kept
 * per project and never get a page of their own).
 *
 * Three readings of one project, none of them a counter of use:
 *
 *  - **the card** — the slots the project's facts were written under
 *    (`projectCard.mjs` in the domain: field, goal, subject, material, stage and
 *    constraints for any kind of work; the clinical elements and the extras of
 *    other kinds of work only when they were stated), taken off the memories in
 *    force, by key and by nothing else;
 *  - **what was done in it** — how many conversations each capability answered,
 *    as the researcher's own, in the capability's product name;
 *  - **the works** — the files its runs delivered, one per deliverable, by month.
 *
 * Hidden knowledge: the second and third are read from the run ledger of the
 * project, as `/api/account/usage/runs` reads it for the month, and they leave
 * out the same things it does — a run a machine started (an autopilot episode,
 * a continuation, a source being read), a capability that is the platform's
 * own, a run the researcher deleted. A run that failed delivered nothing and
 * answered nothing, so it is neither counted nor listed. A file is a work when
 * its capability's contract declares it a deliverable and a reader reads it
 * (a report, a document, a draft); the notes a run keeps on its own revisions,
 * scratch and what a plan abandoned are not (`runArtifacts.mjs`).
 *
 * Nothing here says a state of the back office: no 「已交付」, no attempt count,
 * no verdict. The run's status is what decides whether it is listed at all.
 *
 * @module projectOverview
 */

import {
  PROJECT_CARD_EXTENSION_LABELS_ZH,
  PROJECT_CARD_EXTENSION_ROWS_MAX,
  PROJECT_CARD_SLOTS,
  PROJECT_CARD_SLOT_LABELS_ZH,
  artifactPresentation,
  capabilityTitle,
  deliverableIdOfPath,
  projectCardExtensionOfKey,
  projectCardSlotOfKey,
} from "@evimed/domain";
import { isResearcherRun } from "./agentRuns.mjs";
import { dayOf, timeZoneOrDefault } from "./memoryTimeline.mjs";
import { OPEN_DOMAIN_ANSWER_AGENT_ID } from "./specialistRouting.mjs";

/** The newest works a read lists. */
export const PROJECT_WORKS_LIMIT = 60;
/** The longest a slot's text is on the card, in characters. */
const SLOT_TEXT_LIMIT = 200;

/** The file roles a reader opens as a work. A matrix, a table of data and a figure belong to the report they came with. */
const WORK_ROLES = new Set(["report", "document", "draft"]);

/** @param {unknown} value @param {number} max */
function excerpt(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The card: for each slot, the newest memory in force written under its key in this project.
 *
 * The named slots come in their reading order (the general ones, then the clinical elements); the extras of other kinds of
 * work (`project.ext.<name>`) follow, oldest first and no more than the card shows. A slot nobody stated is not in the answer —
 * there is no row for a gap, and a project with nothing stated has an empty card.
 *
 * A fact and a decision are both read — a researcher who decided on a design has decided the design — and where both exist
 * the later one is the card's. A sensitive record is never on a card, as it is never recalled.
 *
 * Every named slot carries its label. An extra has one only for the names the instructions suggest; any other is shown as the
 * sentence its memory states (`label` is null), because an English key cannot be turned into the researcher's word for it.
 *
 * @param {readonly any[]} records the memories of one project
 * @returns {{ slot: string, label: string | null, recordId: string, text: string, updatedAt: string | null }[]}
 */
export function projectCard(records) {
  /** @type {Map<string, any>} */
  const held = new Map();
  for (const record of records ?? []) {
    if (record?.scope !== "project" || record.status !== "active" || record.sensitive === true) continue;
    if (record.kind !== "project_fact" && record.kind !== "decision") continue;
    const extension = projectCardExtensionOfKey(record.key);
    const slot = projectCardSlotOfKey(record.key) ?? (extension ? `ext.${extension}` : null);
    if (!slot || !String(record.value ?? record.summary ?? "").trim()) continue;
    const current = held.get(slot);
    if (!current || String(record.updatedAt ?? "") > String(current.updatedAt ?? "")) held.set(slot, record);
  }
  /** @param {string} slot @param {string | null} label @param {string} text */
  const row = (slot, label, text) => {
    const record = held.get(slot);
    return { slot, label, recordId: String(record.id), text: excerpt(text, SLOT_TEXT_LIMIT), updatedAt: record.updatedAt ?? record.createdAt ?? null };
  };
  const named = PROJECT_CARD_SLOTS.filter((slot) => held.has(slot)).map((slot) => {
    const record = held.get(slot);
    return row(slot, PROJECT_CARD_SLOT_LABELS_ZH[slot], record.value || record.summary);
  });
  const extras = [...held.keys()].filter((slot) => slot.startsWith("ext."))
    .sort((left, right) => String(held.get(left).updatedAt ?? "").localeCompare(String(held.get(right).updatedAt ?? "")) || left.localeCompare(right, "en"))
    .slice(0, PROJECT_CARD_EXTENSION_ROWS_MAX)
    .map((slot) => {
      const record = held.get(slot);
      const label = /** @type {Record<string, string>} */ (PROJECT_CARD_EXTENSION_LABELS_ZH)[slot.slice("ext.".length)] ?? null;
      return row(slot, label, label ? record.value || record.summary : record.summary || record.value);
    });
  return [...named, ...extras];
}

/** What a capability is called to the researcher; null for an id this build has no name for (an id is not a name). @param {unknown} id */
export function capabilityName(id) {
  const agent = String(id ?? "").trim();
  if (agent === OPEN_DOMAIN_ANSWER_AGENT_ID) return "普通问答";
  return capabilityTitle(agent);
}

/**
 * The runs that are the researcher's work in this project: their own turns, finished, of a capability they can name.
 * @param {readonly any[]} runs @param {(agentId: string) => boolean} isInternal
 */
function ownRuns(runs, isInternal) {
  return (runs ?? []).filter((run) => {
    if (!run?.id || run.deleted === true || run.status !== "succeeded" || !isResearcherRun(run)) return false;
    const agent = String(run.effectiveAgentId ?? run.agentId ?? "");
    return Boolean(agent) && !isInternal(agent) && capabilityName(agent) !== null;
  });
}

/**
 * How many of the researcher's conversations each capability answered, the most used first.
 * @param {readonly any[]} runs @param {(agentId: string) => boolean} [isInternal]
 * @returns {{ id: string, title: string, count: number }[]}
 */
export function capabilityUse(runs, isInternal = () => false) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const run of ownRuns(runs, isInternal)) {
    const agent = String(run.effectiveAgentId ?? run.agentId);
    counts.set(agent, (counts.get(agent) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, title: /** @type {string} */ (capabilityName(id)), count }))
    .sort((left, right) => right.count - left.count || left.title.localeCompare(right.title, "zh-Hans-CN"));
}

/**
 * The works of the project's runs, newest first and grouped by the month they were delivered in, in the researcher's zone.
 *
 * One work per deliverable — the file a reader opens first (`artifactPresentation`'s rank) — so a package of a report, a
 * matrix and a summary is one line, named by the conversation it came out of.
 *
 * @param {readonly any[]} runs
 * @param {{ describe?: (run: any) => { artifactKinds?: Record<string, string>, artifactRoles?: Record<string, string> },
 *   isInternal?: (agentId: string) => boolean, timeZone?: string | null, limit?: number }} [options]
 * @returns {{ month: string, items: { runId: string, title: string, path: string, name: string, at: string }[] }[]}
 */
export function projectWorks(runs, { describe = () => ({}), isInternal = () => false, timeZone = null, limit = PROJECT_WORKS_LIMIT } = {}) {
  const zone = timeZoneOrDefault(timeZone);
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  /** @type {{ runId: string, title: string, path: string, name: string, at: string }[]} */
  const works = [];
  for (const run of ownRuns(runs, isInternal)) {
    const at = [run.finishedAt, run.startedAt, run.createdAt].find((value) => typeof value === "string" && Number.isFinite(Date.parse(value)));
    if (!at) continue;
    const { artifactKinds = {}, artifactRoles = {} } = describe(run) ?? {};
    const paths = [...new Set([...(run.artifacts ?? []), ...(run.unverifiedArtifacts ?? [])].filter((path) => typeof path === "string" && path))];
    /** @type {Map<string, { path: string, rank: number, name: string }>} */
    const best = new Map();
    for (const path of paths) {
      if (artifactKinds[path] !== "deliverable") continue;
      const shown = artifactPresentation(path, artifactRoles[path] ?? null);
      if (!WORK_ROLES.has(shown.role)) continue;
      const group = deliverableIdOfPath(path) ?? "";
      const held = best.get(group);
      if (!held || shown.rank < held.rank || (shown.rank === held.rank && path.localeCompare(held.path, "en") < 0)) {
        best.set(group, { path, rank: shown.rank, name: shown.name });
      }
    }
    const title = excerpt(run.title || run.question || capabilityName(run.effectiveAgentId ?? run.agentId), 120);
    for (const work of [...best.values()].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
      works.push({ runId: String(run.id), title, path: work.path, name: work.name, at: new Date(at).toISOString() });
    }
  }
  works.sort((left, right) => right.at.localeCompare(left.at) || left.path.localeCompare(right.path, "en"));
  /** @type {Map<string, { runId: string, title: string, path: string, name: string, at: string }[]>} */
  const months = new Map();
  for (const work of works.slice(0, Math.max(1, limit))) {
    const month = dayOf(work.at, format).slice(0, 7);
    months.set(month, [...(months.get(month) ?? []), work]);
  }
  return [...months.entries()].map(([month, items]) => ({ month, items }));
}
