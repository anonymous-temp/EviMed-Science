/**
 * The availability projection: for each public capability and each tool the
 * catalogue names, one of source-planned, installed, executable, limited,
 * unavailable or unverified, with the reason and the record it came from.
 *
 * Hidden knowledge: this module decides nothing about a state itself. It
 * gathers the facts the ladder (`projectAvailability`, in the domain) needs —
 * what this deployment's composition offers (`deploymentComposition`), what the
 * engines say about themselves (`availabilityEngineProbe`), which data sources
 * the account can reach (`connectorCredentials`), whether a method has been
 * measured (`vcrMethodValidation`) and what finished operations did here (the
 * collector's records) — and hands them over. A fact it cannot read is left
 * out, never replaced by a guess: an engine that was not asked is not "ready",
 * and a record store that cannot be read makes every label `unverified`.
 *
 * It is a LABEL (owner ruling 2026-10-04). Nothing here is on the dispatch
 * path: no route consults it before sending a prompt, no button is disabled by
 * it, and a failure to compute it leaves the catalogue exactly as it was.
 *
 * Two audiences, one function. The ordinary projection is for an account and
 * honours that account's audience for the opt-in modules and the data sources
 * it holds a credential for; the operator's export is the deployment's own view
 * (every audience open) and is the only place a run's reference is shown.
 *
 * @module availabilityService
 */

import {
  AVAILABILITY_RECORD_VERSION,
  CAPABILITY_DISPLAY,
  CONNECTOR_CREDENTIALS,
  connectorDeploymentSource,
  countAvailabilityStates,
  projectAvailability,
} from "@evimed/domain";
import { EVIMED_AGENT_TOOL_IDS } from "./agentRegistry.mjs";
import { ENGINE_TOOL_ADAPTER_KEYS, declinedTools, deploymentIdentity, moduleOfCapability, moduleState } from "./deploymentComposition.mjs";

/** The export document's own version: bumped when a field a reader depends on changes shape. */
export const AVAILABILITY_EXPORT_VERSION = 1;

/** How many limits one entry carries beside the one that decided it. */
const MAX_ALSO = 6;

/** @param {string} kind @param {string} id @param {string} version @returns {string} */
const recordKey = (kind, id, version) => `${kind}\u0000${id}\u0000${version}`;

/**
 * The exact version an extension coordinate names, as a reader would write it: an
 * npm package's version, or the first twelve characters of a source commit.
 * @param {any} coordinate @returns {string | null}
 */
export function coordinateVersion(coordinate) {
  if (coordinate?.kind === "npm" && typeof coordinate.version === "string") return coordinate.version;
  if (coordinate?.kind === "github" && typeof coordinate.commit === "string") return coordinate.commit.slice(0, 12);
  return null;
}

/**
 * Whether the deployment itself holds a credential for a data source: the same
 * two places `ConnectorCredentialStore.deploymentConfigured` reads.
 * @param {Record<string, any>} config @param {string} connector @returns {boolean}
 */
function deploymentHolds(config, connector) {
  const source = connectorDeploymentSource(connector);
  if (!source) return false;
  const value = "configValue" in source ? config[source.configValue] : config.publicSourceCredentials?.[source.configKey];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * An entry as an ordinary reader may be given it: the state and its words, the
 * reason, and the counts and times of the record — never a run, a dispatch or a
 * project of any account.
 * @param {import("@evimed/domain").AvailabilityEntry} entry
 */
export function publicAvailability(entry) {
  return {
    kind: entry.kind,
    id: entry.id,
    version: entry.version,
    state: entry.state,
    label: entry.label,
    text: entry.text,
    reason: { code: entry.reason.code, ...(entry.reason.detail ? { detail: entry.reason.detail } : {}), source: entry.reason.source },
    also: entry.also.map((reason) => ({ code: reason.code, ...(reason.detail ? { detail: reason.detail } : {}), source: reason.source })),
    operations: entry.operations,
  };
}

export class AvailabilityService {
  /**
   * @param {{
   *   config: Record<string, any>,
   *   registry: Promise<any> | any,
   *   store?: import("./availabilityStore.mjs").AvailabilityStore | null,
   *   engineProbe?: import("./availabilityEngineProbe.mjs").EngineHealthProbe | null,
   *   connectorStatus?: ((userId: string) => Promise<any[]>) | null,
   *   methodValidation?: (() => Promise<{ status: string, reason?: string } | null>) | null,
   *   extensionViews?: ((user: any) => Promise<any[]>) | null,
   *   now?: () => Date,
   * }} dependencies
   */
  constructor({ config, registry, store = null, engineProbe = null, connectorStatus = null, methodValidation = null, extensionViews = null, now = () => new Date() }) {
    this.config = config;
    this.registry = registry;
    this.store = store;
    this.engineProbe = engineProbe;
    this.connectorStatus = connectorStatus;
    this.methodValidation = methodValidation;
    this.extensionViews = extensionViews;
    this.now = now;
  }

  /** Whether the collector is composed on this deployment (the toggle, and a database to keep records in). */
  get collecting() {
    return Boolean(this.store) && this.config.availabilityEnabled !== false;
  }

  /**
   * The evidence the ladder reads about the collector and the records: the
   * collector's state as the ladder names it, and every record by subject.
   * @returns {Promise<{ state: "ready" | "pending" | "off" | "unreadable", records: Map<string, import("@evimed/domain").OperationRecord>,
   *   backlog: number, failed: number, swept: boolean, unreadable: number, updatedAt: string | null }>}
   */
  async evidence() {
    const none = { records: new Map(), backlog: 0, failed: 0, swept: false, unreadable: 0, updatedAt: null };
    if (!this.collecting || !this.store) return { state: "off", ...none };
    try {
      const [listed, collector] = await Promise.all([this.store.list(), this.store.collectorState()]);
      return {
        state: collector.swept && collector.backlog === 0 ? "ready" : "pending",
        records: new Map(listed.records.map((record) => [recordKey(record.kind, record.id, record.version), record])),
        backlog: collector.backlog, failed: collector.failed, swept: collector.swept, unreadable: listed.unreadable, updatedAt: listed.updatedAt,
      };
    } catch {
      return { state: "unreadable", ...none };
    }
  }

  /**
   * The facts the capability and tool ladders share, gathered once per call.
   * @param {{ id?: string } | null} user the account the labels are for; null is the deployment's own view, every module audience open
   * @param {{ freshEngines?: boolean }} [options]
   */
  async gatherFacts(user, { freshEngines = false } = {}) {
    const config = user ? this.config : { ...this.config, frontierAudience: "all", geoAudience: "all", vcrAudience: "all" };
    const subject = user ?? { id: "deployment" };
    const evidence = await this.evidence();
    const engines = freshEngines && this.engineProbe ? await this.engineProbe.refresh().catch(() => new Map()) : this.engineProbe?.snapshot() ?? new Map();
    // Where a data source's credential comes from: the deployment's own view when no account is asked about, the
    // account's (its own key, or the deployment's) when one is. An account whose sources cannot be read has no
    // limit claimed for it — unknown stays unknown.
    /** @type {Map<string, string> | null} */
    let connectors = null;
    if (!user) {
      connectors = new Map(CONNECTOR_CREDENTIALS.map((spec) => [spec.id, deploymentHolds(config, spec.id) ? "deployment" : "none"]));
    } else if (user.id && this.connectorStatus) {
      try { connectors = new Map((await this.connectorStatus(user.id)).map((row) => [String(row.id), String(row.source)])); } catch { connectors = null; }
    }
    /** @type {{ status: string, reason?: string } | null} */
    let validation = null;
    if (this.config.vcrEnabled && this.methodValidation) {
      try { validation = await this.methodValidation(); } catch { validation = null; }
    }
    return { config, subject, evidence, engines, connectors, validation, declined: declinedTools(config, subject) };
  }

  /**
   * What an engine's health says, as a limit: only a positive answer that it is
   * not ready, or no answer at all, is a limit. An engine that was never asked
   * is left unknown, not ready.
   * @param {string} tool @param {Map<string, import("./availabilityEngineProbe.mjs").EngineHealth>} engines
   * @returns {import("@evimed/domain").AvailabilityReason | null}
   */
  #engineLimit(tool, engines) {
    const health = engines.get(tool);
    if (!health || health.state === "ready") return null;
    return { code: "engine-not-ready", detail: tool, source: "engine-health", facts: { engineState: health.state, checkedAt: health.checkedAt, ...health.facts } };
  }

  /**
   * The reasons a capability is not simply available here, strongest first.
   * @param {any} manifest @param {Awaited<ReturnType<AvailabilityService["gatherFacts"]>>} facts
   * @returns {import("@evimed/domain").AvailabilityReason[]}
   */
  #capabilityReasons(manifest, facts) {
    /** @type {import("@evimed/domain").AvailabilityReason[]} */
    const reasons = [];
    const module = moduleOfCapability(manifest.id);
    const moduleStatus = module ? moduleState(facts.config, facts.subject, module) : "on";
    if (module && moduleStatus !== "on") {
      reasons.push({ code: moduleStatus === "off" ? "module-off" : "module-not-open", detail: module, source: "deployment-composition" });
    }
    const declared = [...new Set([...(manifest.requiredTools ?? []), ...(manifest.optionalTools ?? [])])];
    // The engines a capability is built on: its managed-job tools. Losing all of them leaves nothing to run.
    const engineTools = declared.filter((tool) => ENGINE_TOOL_ADAPTER_KEYS[tool]);
    const missingEngines = engineTools.filter((tool) => facts.declined.has(tool));
    if (engineTools.length && missingEngines.length === engineTools.length) {
      const why = facts.declined.get(missingEngines[0])?.why ?? "unknown";
      reasons.push({ code: why === "engine-not-configured" ? "engine-not-configured" : "required-tool-not-offered", detail: missingEngines[0], source: "deployment-composition", facts: { why } });
    }
    for (const tool of declared) {
      const declined = facts.declined.get(tool);
      if (!declined || (declined.module && declined.module === module && moduleStatus !== "on")) continue;
      if (engineTools.length && missingEngines.length === engineTools.length && engineTools.includes(tool)) continue;
      reasons.push({ code: "optional-tool-not-offered", detail: tool, source: "deployment-composition", facts: { why: declined.why } });
    }
    for (const tool of engineTools.filter((name) => !facts.declined.has(name))) {
      const limit = this.#engineLimit(tool, facts.engines);
      if (limit) reasons.push(limit);
    }
    for (const spec of CONNECTOR_CREDENTIALS) {
      if (!spec.capabilities.includes(manifest.id) || spec.keyless) continue;
      // Where the account has its own credential, or the deployment holds one, the source is not missing.
      if (facts.connectors?.get(spec.id) === "none") reasons.push({ code: "data-source-not-configured", detail: spec.id, source: "connector-registry" });
    }
    if (module === "vcr" && facts.validation?.status === "unmeasured") {
      reasons.push({ code: "method-unmeasured", detail: facts.validation.reason ?? "unmeasured", source: "method-validation" });
    }
    return reasons;
  }

  /**
   * Every public capability, deployed or only planned.
   * @param {{ id?: string } | null} user @param {{ freshEngines?: boolean }} [options]
   * @returns {Promise<import("@evimed/domain").AvailabilityEntry[]>}
   */
  async capabilities(user, options = {}) {
    const registry = await this.registry;
    const facts = await this.gatherFacts(user, options);
    const deployed = registry?.list?.() ?? [];
    const runtime = { mode: String(this.config.runtimeMode ?? "kernel") };
    const collector = { state: facts.evidence.state };
    const entries = deployed.map((/** @type {any} */ manifest) => projectAvailability({
      subject: { kind: "capability", id: manifest.id, version: manifest.version },
      reasons: this.#capabilityReasons(manifest, facts).slice(0, MAX_ALSO + 1),
      operations: facts.evidence.records.get(recordKey("capability", manifest.id, String(manifest.version))) ?? null,
      collector, runtime,
    }));
    // What the source names and this deployment's registry does not carry. A capability only the source knows is
    // never offered by the catalogue (it is not in /api/agents); this is where the product says so out loud.
    const have = new Set(deployed.map((/** @type {any} */ manifest) => manifest.id));
    for (const id of Object.keys(CAPABILITY_DISPLAY)) {
      if (have.has(id)) continue;
      entries.push(projectAvailability({ subject: { kind: "capability", id }, reasons: [{ code: "not-in-this-deployment", source: "source-catalogue" }], collector, runtime }));
    }
    return entries.sort((left, right) => left.id.localeCompare(right.id, "en"));
  }

  /**
   * Every tool the catalogue names (the research tools a manifest may declare).
   * @param {{ id?: string } | null} user @param {{ freshEngines?: boolean }} [options]
   * @returns {Promise<import("@evimed/domain").AvailabilityEntry[]>}
   */
  async tools(user, options = {}) {
    const facts = await this.gatherFacts(user, options);
    const runtime = { mode: String(this.config.runtimeMode ?? "kernel") };
    const collector = { state: facts.evidence.state };
    return [...EVIMED_AGENT_TOOL_IDS].map((tool) => {
      /** @type {import("@evimed/domain").AvailabilityReason[]} */
      const reasons = [];
      const declined = facts.declined.get(tool);
      if (declined) {
        const code = declined.why === "module-off" ? "module-off" : declined.why === "module-not-open" ? "module-not-open"
          : declined.why === "engine-not-configured" ? "engine-not-configured" : "tool-not-offered";
        reasons.push({ code, detail: declined.module ?? tool, source: "deployment-composition", facts: { why: declined.why, tool } });
      } else if (ENGINE_TOOL_ADAPTER_KEYS[tool]) {
        const limit = this.#engineLimit(tool, facts.engines);
        if (limit) reasons.push(limit);
      }
      return projectAvailability({ subject: { kind: "tool", id: tool }, reasons, operations: facts.evidence.records.get(recordKey("tool", tool, "")) ?? null, collector, runtime });
    });
  }

  /**
   * The states of this account's own extension installations. An installation is
   * the account's, so only the account's are read; the label names the exact
   * version (the catalogue coordinate) and the lifecycle fact that decided it.
   * Qualification labels ride beside the state and never decide it.
   * @param {{ id: string }} user @returns {Promise<import("@evimed/domain").AvailabilityEntry[]>}
   */
  async extensions(user) {
    if (!this.extensionViews) return [];
    let views = [];
    try { views = await this.extensionViews(user); } catch { return []; }
    const facts = await this.evidence();
    const runtime = { mode: String(this.config.runtimeMode ?? "kernel") };
    // Use of an extension is not collected yet, so a prepared one can be installed but never shown as run: the
    // honest label for "we do not look" is unverified, not installed.
    const collector = { state: facts.state === "ready" || facts.state === "pending" ? "off" : facts.state };
    return views.map((view) => {
      /** @type {import("@evimed/domain").AvailabilityReason[]} */
      const reasons = [];
      const source = "extension-installation";
      const facts_ = { evidenceState: view.evidenceState ?? null, policyState: view.policyState ?? null };
      if (view.phase === "removed") reasons.push({ code: "removed", source, facts: facts_ });
      else if (view.phase === "unsupported") reasons.push({ code: "unsupported", detail: String(view.executionClass ?? "local-only"), source, facts: facts_ });
      else if (view.phase === "failed") reasons.push({ code: "preparation-failed", detail: String(view.preparation?.refusalCode ?? "extension_contract_invalid"), source, facts: facts_ });
      else if (view.phase === "preparing" || view.phase === "saved") reasons.push({ code: "installing", source, facts: facts_ });
      return projectAvailability({
        subject: { kind: "extension", id: String(view.catalogueId ?? view.id), version: coordinateVersion(view.coordinate) },
        reasons, operations: facts.records.get(recordKey("extension", String(view.catalogueId ?? view.id), String(view.integrity ?? ""))) ?? null, collector, runtime,
      });
    });
  }

  /**
   * What `GET /api/availability` answers an account with.
   * @param {{ id: string }} user
   */
  async forAccount(user) {
    const [capabilities, tools, extensions, evidence] = await Promise.all([this.capabilities(user), this.tools(user), this.extensions(user), this.evidence()]);
    return {
      generatedAt: this.now().toISOString(),
      collector: { state: evidence.state },
      capabilities: capabilities.map(publicAvailability),
      tools: tools.map(publicAvailability),
      extensions: extensions.map(publicAvailability),
    };
  }

  /**
   * The states of the catalogue's capabilities by id, for `GET /api/agents`.
   * @param {{ id: string }} user @returns {Promise<Map<string, ReturnType<typeof publicAvailability>>>}
   */
  async capabilityStates(user) {
    return new Map((await this.capabilities(user)).map((entry) => [entry.id, publicAvailability(entry)]));
  }

  /**
   * The operator's export: the deployment's own view and every record in full,
   * with the references (run, dispatch, session, project, result versions, skill
   * versions) the release audit cites. Engines are asked afresh.
   */
  async export() {
    const [capabilities, tools, evidence] = await Promise.all([
      this.capabilities(null, { freshEngines: true }), this.tools(null, { freshEngines: true }), this.evidence(),
    ]);
    const engines = this.engineProbe ? Object.fromEntries([...this.engineProbe.snapshot()].map(([tool, health]) => [tool, health])) : {};
    return {
      schemaVersion: AVAILABILITY_EXPORT_VERSION,
      recordVersion: AVAILABILITY_RECORD_VERSION,
      kind: "evimed-availability-export",
      generatedAt: this.now().toISOString(),
      deployment: deploymentIdentity(this.config),
      collector: { state: evidence.state, backlog: evidence.backlog, failedJobs: evidence.failed, sweptOnce: evidence.swept, unreadableRecords: evidence.unreadable, updatedAt: evidence.updatedAt },
      counts: { capability: countAvailabilityStates(capabilities), tool: countAvailabilityStates(tools) },
      engines,
      states: [...capabilities, ...tools].map((entry) => ({ ...publicAvailability(entry), reason: entry.reason, also: entry.also })),
      records: [...evidence.records.values()],
    };
  }

  /**
   * The counts the operators' scrape exposes: subjects by state and kind, the
   * operations folded so far, and how far the collector has got. Never an id of
   * an account's work.
   */
  async metrics() {
    const [capabilities, tools, evidence] = await Promise.all([this.capabilities(null), this.tools(null), this.evidence()]);
    /** @type {Record<string, { success: number, failure: number, notMounted: number }>} */
    const operations = {};
    for (const record of evidence.records.values()) {
      const row = operations[record.kind] ?? { success: 0, failure: 0, notMounted: 0 };
      row.success += record.successes;
      row.failure += record.failures;
      row.notMounted += record.notMounted;
      operations[record.kind] = row;
    }
    return {
      states: { capability: countAvailabilityStates(capabilities), tool: countAvailabilityStates(tools) },
      operations,
      collector: { state: evidence.state, backlog: evidence.backlog, failedJobs: evidence.failed, records: evidence.records.size, unreadable: evidence.unreadable },
    };
  }
}

/**
 * The operators' series (`/api/ops/metrics`): `open_science_availability_enabled 0`
 * when the module is not composed, and otherwise how many subjects stand in each
 * state, how many operations the records hold, and how far the collector has
 * got. Labels are closed sets only — a kind, a state, an outcome — so the series
 * count is bounded whatever the deployment runs, and no id of any account's work
 * is ever a label.
 *
 * @param {boolean} composed
 * @param {Awaited<ReturnType<AvailabilityService["metrics"]>> | null} snapshot
 * @returns {{ name: string, help: string, type: string, series: { value: number, labels?: Record<string, string> }[] }[]}
 */
export function availabilityMetricFamilies(composed, snapshot) {
  const families = [{
    name: "open_science_availability_enabled",
    help: "Whether the capability availability module is composed (0 when it is not).",
    type: "gauge", series: [{ value: composed ? 1 : 0 }],
  }];
  if (!composed || !snapshot) return families;
  families.push({
    name: "open_science_availability_subjects",
    help: "Capabilities and tools by availability state: source-planned, installed, executable, limited, unavailable, unverified.",
    type: "gauge",
    series: Object.entries(snapshot.states).flatMap(([kind, counts]) => Object.entries(counts).map(([state, value]) => ({ value, labels: { kind, state } }))),
  }, {
    name: "open_science_availability_operations_total",
    help: "Finished operations folded into the availability records, by kind of subject and how they ended.",
    type: "counter",
    series: Object.entries(snapshot.operations).flatMap(([kind, row]) => [
      { value: row.success, labels: { kind, outcome: "success" } },
      { value: row.failure, labels: { kind, outcome: "failure" } },
      { value: row.notMounted, labels: { kind, outcome: "not_mounted" } },
    ]),
  }, {
    name: "open_science_availability_collector_backlog",
    help: "Collection jobs queued or running: finished runs not yet folded into the records.",
    type: "gauge", series: [{ value: snapshot.collector.backlog }],
  }, {
    name: "open_science_availability_collector_failed_jobs",
    help: "Collection jobs that gave up. Re-armed by the sweep; a number that stays above zero is a run the collector cannot read.",
    type: "gauge", series: [{ value: snapshot.collector.failedJobs }],
  }, {
    name: "open_science_availability_records",
    help: "Operation records held, and how many stored rows could not be read back as records.",
    type: "gauge",
    series: [{ value: snapshot.collector.records, labels: { readable: "yes" } }, { value: snapshot.collector.unreadable, labels: { readable: "no" } }],
  }, {
    name: "open_science_availability_collector_state",
    help: "The collector's state as the labels read it: ready, pending (records still forming), off, or unreadable.",
    type: "gauge",
    series: ["ready", "pending", "off", "unreadable"].map((state) => ({ value: snapshot.collector.state === state ? 1 : 0, labels: { state } })),
  });
  return families;
}
