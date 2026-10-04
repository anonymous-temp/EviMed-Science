/**
 * Whether the skills and capabilities a deployment carries can really be used
 * on it: each package's record (`@evimed/domain/skill-packages`, generated from
 * the trees) read against what this deployment's runtime image installs and
 * what it offers a runtime.
 *
 * Hidden knowledge: "installed" says a package is on disk; it never says the
 * software, weights or data its method needs are. A skill whose script exits
 * for want of `gseapy`, a method whose instructions say "check RDKit" on an
 * image without it, and a tool the deployment withholds are all installed and
 * not runnable, and the product has to say so without hiding the package or
 * refusing the request that names it (owner ruling 2026-10-04). So this module
 * decides nothing about whether anything may run: it gathers the facts the
 * domain's `skillDependencyReasons` reads, hands over the reasons, and the
 * availability ladder (`projectAvailability`) turns them into the one label.
 *
 * Three kinds of absence are kept apart because they mean different things to a
 * reader: a dependency the package REQUIRES that the image lacks limits the
 * package; one the package only touches on a guarded path (an import inside a
 * `try`, a code fence in its instructions) is a note beside an installed one;
 * and a fact that could not be read at all is unverified, never "present". What
 * the researcher supplies at the moment of use (their data, their machine) is
 * never an absence.
 *
 * Personal skills are projected from the record that travelled with them
 * (`payload.package`), not from the tree: a skill imported from a repository at
 * a commit is checked against the same image recipe as a shipped one.
 *
 * @module skillSupplyService
 */

import {
  normalizeSkillPackageRecord,
  projectAvailability,
  publicSkillPackage,
  renderPackageHelp,
  skillDependencyReasons,
} from "@evimed/domain";
import { IMAGE_RECIPE, SKILL_PACKAGES } from "@evimed/domain/skill-packages";
import { EVIMED_AGENT_TOOL_IDS } from "./agentRegistry.mjs";
import { declinedTools } from "./deploymentComposition.mjs";

/** The origins a runtime's native skill catalogue lists (the skill roots the image mounts), in the order a name is looked up. */
const CATALOGUE_ORIGINS = Object.freeze(["core", "curated", "office", "community", "evimed"]);

/** Dependency kinds the runtime image supplies, the ones whose absence a capability's own label should say. */
const SOFTWARE_KINDS = Object.freeze(["python-package", "r-package", "system-tool"]);

/**
 * @typedef {import("@evimed/domain").SkillPackageRecord} SkillPackageRecord
 * @typedef {import("@evimed/domain").AvailabilityEntry} AvailabilityEntry
 * @typedef {{ code: string, detail: string, source: "image-recipe" | "deployment-composition" | "package-record", optional: boolean, facts?: Record<string, unknown> }} SupplyReason
 */

export class SkillSupply {
  /**
   * @param {{ config: Record<string, any>, packages?: ReadonlyMap<string, SkillPackageRecord>, image?: typeof IMAGE_RECIPE | null }} dependencies
   */
  constructor({ config, packages = SKILL_PACKAGES, image = IMAGE_RECIPE }) {
    this.config = config;
    this.packages = packages;
    this.image = image;
  }

  /**
   * What a package's dependencies are read against for this account. A tool the
   * deployment's composition does not name is unknown, not offered; a deployment
   * mounts no model weights, so a package that wants some says they are missing
   * rather than reading as unchecked.
   * @param {{ id?: string } | null} user
   */
  facts(user) {
    const declined = declinedTools(this.config, user ?? { id: "deployment" });
    return {
      image: this.image,
      tools: (/** @type {string} */ tool) => (EVIMED_AGENT_TOOL_IDS.has(tool)
        ? { offered: !declined.has(tool), ...(declined.has(tool) ? { why: declined.get(tool)?.why } : {}) }
        : null),
      deployment: /** @type {ReadonlySet<string>} */ (new Set()),
    };
  }

  /**
   * Every reason a package's dependencies are not all in place, split by what
   * they mean.
   * @param {SkillPackageRecord} record @param {{ id?: string } | null} user
   * @returns {{ limits: SupplyReason[], notes: SupplyReason[] }}
   */
  reasons(record, user) {
    const all = /** @type {SupplyReason[]} */ (skillDependencyReasons(record, this.facts(user)));
    return { limits: all.filter((reason) => !reason.optional), notes: all.filter((reason) => reason.optional && reason.code !== "dependency-unchecked") };
  }

  /**
   * The software a capability's scripts need that the image lacks: only the
   * kinds the image supplies, so a missing platform tool is still the
   * availability service's own reason and is not stated twice.
   * @param {string} capabilityId @param {{ id?: string } | null} user @returns {SupplyReason[]}
   */
  softwareReasons(capabilityId, user) {
    const record = this.packages.get(`capability/${capabilityId}`);
    if (!record) return [];
    const software = { ...record, dependencies: record.dependencies.filter((dependency) => SOFTWARE_KINDS.includes(dependency.kind)) };
    return this.reasons(/** @type {SkillPackageRecord} */ (software), user).limits;
  }

  /**
   * The label of one skill package.
   * @param {SkillPackageRecord} record @param {{ id?: string } | null} user @param {{ mode: string }} [runtime]
   * @param {{ limits: SupplyReason[], notes: SupplyReason[] }} [found] the record's reasons, when the caller already read them
   * @returns {AvailabilityEntry}
   */
  project(record, user, runtime = { mode: String(this.config.runtimeMode ?? "kernel") }, found = this.reasons(record, user)) {
    return projectAvailability({
      subject: { kind: "skill", id: record.id, version: record.version },
      reasons: found.limits,
      // A skill's use is not collected, so the collector's state says nothing about it: a package carried with
      // nothing missing is installed, however the collector stands.
      collector: { state: "ready" }, runtime,
    });
  }

  /**
   * A projected skill as an ordinary reader may be given it: the label and its
   * words, the package's own facts with the unknowns named, and the optional
   * software it only touches on a guarded path.
   * @param {SkillPackageRecord} record @param {{ id?: string } | null} user @param {{ mode: string }} [runtime]
   */
  view(record, user, runtime) {
    const found = this.reasons(record, user);
    const entry = this.project(record, user, runtime, found);
    return {
      kind: entry.kind, id: entry.id, version: entry.version, state: entry.state, label: entry.label, text: entry.text,
      reason: { code: entry.reason.code, ...(entry.reason.detail ? { detail: entry.reason.detail } : {}), source: entry.reason.source },
      also: found.limits.filter((reason) => reason.code !== entry.reason.code || reason.detail !== entry.reason.detail)
        .map((reason) => ({ code: reason.code, detail: reason.detail, source: reason.source })),
      notes: found.notes.map((reason) => ({ code: reason.code, detail: reason.detail })),
      package: publicSkillPackage(record),
    };
  }

  /**
   * Every shipped skill that is not a capability (those are the availability
   * service's own subjects) and not an extension (its own lifecycle).
   * @param {{ id?: string } | null} user @param {{ mode: string }} [runtime]
   */
  skills(user, runtime) {
    return [...this.packages.values()].filter((record) => !["capability", "extension"].includes(record.origin)).map((record) => this.project(record, user, runtime));
  }

  /** @param {string} id the package id (`origin/name`) @returns {SkillPackageRecord | null} */
  record(id) {
    return this.packages.get(id) ?? null;
  }

  /** The package facts a reader may be given, or null for a subject with no record. @param {string} id @returns {ReturnType<typeof publicSkillPackage>} */
  publicPackage(id) {
    return publicSkillPackage(this.record(id));
  }

  /**
   * The record a native catalogue item stands for, by the deployment roots it
   * is mounted from. A name more than one origin carries resolves in the order
   * the roots are searched; a name no shipped package carries is unknown, and
   * unknown is not "fine".
   * @param {string} name @returns {SkillPackageRecord | null}
   */
  catalogued(name) {
    const found = [...this.packages.values()].filter((record) => record.name === name && CATALOGUE_ORIGINS.includes(record.origin));
    found.sort((left, right) => CATALOGUE_ORIGINS.indexOf(left.origin) - CATALOGUE_ORIGINS.indexOf(right.origin));
    return found[0] ?? null;
  }

  /**
   * How to run a package's operations, written from the operation schemas the record carries (the flags a script reads,
   * which are required, their defaults and bounds, what it writes and its limits), bounded. Empty where the package
   * declares no operation: nothing is described that no schema states.
   * @param {SkillPackageRecord | null} record @returns {string}
   */
  help(record) {
    return record?.operations.length ? renderPackageHelp(record.operations, { locale: "zh" }) : "";
  }

  /**
   * The label of a personal skill revision, from the record that travelled with
   * it. A revision saved before records travelled has none, and says so rather
   * than reading as checked.
   * @param {{ package?: unknown, digest?: string }} payload @param {{ id?: string } | null} user
   */
  personal(payload, user) {
    const record = normalizeSkillPackageRecord(payload?.package);
    return record ? this.view(record, user) : null;
  }
}
