import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { HttpError } from "./security.mjs";
import { migrateProductStore, productId, productInteger } from "./productPersistence.mjs";
import { ProductDocuments, ProductJobs } from "./productStore.mjs";

export const PLUGIN_ID = "dsh-cite";

/**
 * What each installed bundle lets a project configure.
 *
 * Kept in code, unlike the installed set itself: a settings schema is a
 * deterministic contract the control plane validates and the runtime reads
 * through named environment variables, so it is code the same way the tool
 * names are. What is data is *which* bundles are installed — that is a
 * recorded compatibility result, and it lives in
 * `runtime/skills/community/plugin-support.json`.
 *
 * A bundle with no entry here takes no settings at all. That is deliberate:
 * "unknown plugin, therefore anything goes" is how an open settings bag gets
 * written into a runtime environment.
 *
 * A field's default is its ceiling — the most permissive value, which is what
 * an unconfigured project has always been given.
 */
const PLUGIN_SETTINGS_SCHEMAS = Object.freeze({
  "dsh-cite": Object.freeze({ timeoutMs: Object.freeze({ min: 2000, max: 15000, deploymentCapped: true }) }),
});

/**
 * The installed set as recorded on 2026-09-06, kept here only as the fallback
 * for a control plane that cannot see the record.
 *
 * `deploy/web/Dockerfile` copies `runtime/skills/{core,external,curated-scientific,office,evimed}`
 * into the web image and not `community/`, so in a released container the
 * record is simply absent. Reading it at import the way `config.mjs` reads
 * `deps-version.json` would turn that absence into an ENOENT during module
 * load — the exact failure that file's Dockerfile comment records. So the
 * record is the source in a checkout, this is the source in the image, and
 * `pluginService.test.mjs` asserts the two derive the identical registry, the
 * same way every derived copy of the kernel pin is asserted equal to it.
 */
export const PLUGIN_SUPPORT_SNAPSHOT = Object.freeze({
  communityToolBundles: [Object.freeze({
    name: "dsh-cite",
    version: "0.3.2",
    status: "installed",
    // The tools the card lists. Omitting them here did not fail anything: the
    // record carries them in a checkout, so dev and every test saw the list,
    // and only a released image — where the record is absent — served an empty
    // one. Every field `pluginRegistryFrom` reads has to be in both copies.
    tools: Object.freeze(["cite_lookup", "cite_format", "cite_bibtex", "cite_check", "cite_health"]),
  })],
});

/** A plugin id addresses a per-project document and is written into a runtime
 *  profile; it is a closed vocabulary, not free text. */
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * The plugin ids the delivery path can actually carry.
 *
 * Discovery is derived from data; delivery is not. Three modules outside this
 * one still address exactly one plugin document per project by the default id:
 * `pluginApplyWorker.mjs`, which reads `projectPluginId(job.projectId)` and
 * would therefore apply dsh-cite's document for a second plugin's job;
 * `accountExport.mjs`, whose `row.id !== projectPluginId(row.projectId)` check
 * would refuse the whole archive; and `runtimeManager.mjs`, which carries one
 * `pluginConfig` per launch plan and whose `probePlugin` verifies dsh-cite's
 * version and tool list by name.
 *
 * So the record decides *whether* a bundle is registered and what its version
 * and tools are; this set decides how many of those the delivery path can
 * honour. Registering a bundle the apply path cannot carry would put a plugin
 * in front of the user whose saved configuration is never applied — or worse,
 * applied to another plugin's document — and nothing in the browser could show
 * that. Landing a second bundle is: teach those three modules, then add its id
 * here. Everything between the route and the storage already carries the id.
 */
export const APPLY_PATH_PLUGIN_IDS = Object.freeze(new Set([PLUGIN_ID]));

/**
 * The registry every route, gate and projection is addressed by.
 *
 * Derived from the recorded bundle support rather than from a list of ids in
 * code: `status` there is the outcome of booting the bundle against the pinned
 * kernel, and an id in code cannot be wrong about that in only one direction.
 * Anything the record does not mark `installed` is not registered, so an
 * `incompatible` or `rejected` bundle can never be configured by name.
 *
 * @param {any} support the parsed `plugin-support.json` document
 * @param {ReadonlySet<string>} applied the ids the delivery path can carry
 * @returns {Map<string, any>}
 */
export function pluginRegistryFrom(support, applied = APPLY_PATH_PLUGIN_IDS) {
  const bundles = Array.isArray(support?.communityToolBundles) ? support.communityToolBundles : [];
  /** @type {[string, any][]} */
  const entries = [];
  for (const declared of bundles) {
    if (declared?.status !== "installed") continue;
    const id = String(declared.name ?? "");
    if (!PLUGIN_ID_PATTERN.test(id)) throw new Error(`plugin support records an unusable plugin id: ${JSON.stringify(id)}`);
    const version = String(declared.version ?? "");
    if (!PLUGIN_VERSION_PATTERN.test(version)) throw new Error(`plugin support records no usable version for ${id}: ${JSON.stringify(version)}`);
    // Refused loudly rather than skipped quietly: the record and the apply path
    // disagreeing is a mistake someone has to see, and `recordedPluginRegistry`
    // turns it into a stderr line plus the last registry known to be deliverable.
    if (!applied.has(id)) throw new Error(`plugin support records ${id} as installed, but the apply path carries only ${[...applied].join(", ")}; teach pluginApplyWorker.mjs, accountExport.mjs and runtimeManager.mjs first`);
    // Earlier builds whose stored configurations must stay readable after an
    // upgrade. Absent today; without it, moving a version would make every
    // saved revision of that plugin unreadable at once.
    const previous = (Array.isArray(declared.previousVersions) ? declared.previousVersions : []).map(String);
    entries.push([id, Object.freeze({
      id,
      version,
      supportedBinaryVersions: Object.freeze([version, ...previous]),
      settings: PLUGIN_SETTINGS_SCHEMAS[id] ?? Object.freeze({}),
      tools: Object.freeze((Array.isArray(declared.tools) ? declared.tools : []).map(String)),
    })]);
  }
  if (!entries.length) throw new Error("plugin support records no installed community tool bundle the apply path carries");
  return new Map(entries);
}

function recordedPluginRegistry() {
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(new URL("../../../runtime/skills/community/plugin-support.json", import.meta.url), "utf8"));
  } catch {
    // Absent in a released image by construction; the snapshot above is the
    // asserted-equal copy, not a guess.
    return pluginRegistryFrom(PLUGIN_SUPPORT_SNAPSHOT);
  }
  try {
    return pluginRegistryFrom(recorded);
  } catch (error) {
    // Present but unusable is a mistake, not a deployment shape: say so rather
    // than silently running on the snapshot.
    process.stderr.write(`plugin support record unusable, falling back to the recorded snapshot: ${error?.message ?? error}\n`);
    return pluginRegistryFrom(PLUGIN_SUPPORT_SNAPSHOT);
  }
}

/** @type {Map<string, any>} */
export const PLUGIN_REGISTRY = recordedPluginRegistry();
export const PLUGIN_VERSION = PLUGIN_REGISTRY.get(PLUGIN_ID)?.version ?? "";

/**
 * Where the control plane reads what the nightly matrix observed about plugin
 * availability.
 *
 * The web image ships a file at this path, and it is a placeholder rather than
 * an observation: schema-valid, no plugin rows, deliberately dated 1970, so
 * `pluginAvailability` reads it as `unknown` by the staleness rule below and
 * can never read it as `current`. Shipping it keeps the image self-contained
 * and keeps production on the same read path dev runs instead of a
 * missing-file branch nothing exercises.
 *
 * What must never be committed here is a real matrix run: a recorded
 * observation carries a timestamp, and one committed inside the freshness
 * window would have a released image answering `current` from whatever was
 * true on the day of the commit. `deploy.test.mjs` fails if the committed copy
 * stops being the 1970 placeholder. An operator who wants a real answer
 * bind-mounts the nightly job's `plugin-availability.json` over this path;
 * that is the intended way to get one, because the alternative — a
 * request-path lookup — would have the control plane naming an external host
 * while answering a browser.
 *
 * A fixed path rather than an environment variable: compose passes the API
 * container its environment item by item, so a variable added here and not
 * there would be a knob that reads as configured and does nothing. A bind
 * mount at this path needs no new knob, and `PluginService` still takes the
 * path as an option for the day `config.mjs` carries it.
 */
export const DEFAULT_AVAILABILITY_FILE = fileURLToPath(new URL("../../../plugin-availability.json", import.meta.url));

/** @param {string} pluginId @param {Map<string,any>} registry */
export function pluginEntry(pluginId, registry = PLUGIN_REGISTRY) {
  const entry = registry.get(String(pluginId));
  if (!entry) throw new HttpError(404, "plugin_not_supported", "This plugin is not approved for this runtime image.");
  return entry;
}

/** @param {any} value @param {string[]} keys */
function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
/** @param {any} entry @param {number} maxTimeoutMs */
function settingsSchema(entry, maxTimeoutMs) {
  return Object.fromEntries(Object.entries(entry.settings).map(([key, field]) =>
    [key, { min: field.min, max: field.deploymentCapped ? Math.min(field.max, maxTimeoutMs) : field.max }]));
}
/** The configuration a project that has never saved one is running.
 *  @param {any} entry @param {number} maxTimeoutMs */
export function defaultConfiguration(entry, maxTimeoutMs = 15000) {
  const schema = settingsSchema(entry, maxTimeoutMs);
  return { enabled: true, settings: Object.fromEntries(Object.entries(schema).map(([key, field]) => [key, entry.settings[key].default ?? field.max])) };
}
/** Removal is a state, not a deletion: the binary ships inside the runtime
 *  image and no per-project request can take it out of there. What a project
 *  can do is stop using it and drop its own configuration.
 *  @param {any} entry @param {number} maxTimeoutMs */
export function removalConfiguration(entry, maxTimeoutMs = 15000) {
  return { ...defaultConfiguration(entry, maxTimeoutMs), enabled: false };
}
/** @param {any} value @param {number} maxTimeoutMs @param {any} entry */
export function validatePluginConfig(value, maxTimeoutMs = 15000, entry = pluginEntry(PLUGIN_ID)) {
  const keys = Object.keys(entry.settings);
  if (!exact(value, ["expectedRevision", "enabled", "settings"]) || typeof value.enabled !== "boolean"
    || !exact(value.settings, keys)) throw new HttpError(400, "plugin_config_invalid", `Only enabled${keys.length ? ` and ${keys.join(", ")}` : ""} may be configured.`);
  productInteger(value.expectedRevision, 0, 2_147_483_646);
  const schema = settingsSchema(entry, maxTimeoutMs);
  /** @type {Record<string, number>} */
  const settings = {};
  for (const key of keys) settings[key] = productInteger(value.settings[key], schema[key].min, schema[key].max);
  return { enabled: value.enabled, settings };
}

/** How long a recorded availability observation is worth acting on. The matrix
 *  runs nightly; three missed nights is not a record, it is a silence. */
const AVAILABILITY_MAX_AGE_MS = 72 * 60 * 60 * 1000;

/**
 * What the nightly matrix recorded about this plugin's upstream availability.
 *
 * Read, never fetched: the control plane names no external host on a request
 * path, so "is there a newer build" is answered from a file a scheduled job
 * wrote, and every way of not having that answer — no file, wrong schema, too
 * old, a different build, an observation the job could not make — is
 * `unknown`. None of them is `current`. A matrix that reports green because it
 * could not look is a matrix that reports green forever, and the same is true
 * of a card that says "no update available" because nobody checked.
 *
 * @param {any} record @param {any} entry @param {number} now
 * @returns {{state:"unknown"|"current"|"update-available",checkedAt:string|null,reason:string,availableUpdate:{version:string,recordedAt:string,source:string}|null}}
 */
export function pluginAvailability(record, entry, now = Date.now()) {
  const unknown = (reason, checkedAt = null) => ({ state: /** @type {const} */ ("unknown"), checkedAt, reason, availableUpdate: null });
  if (!record || typeof record !== "object" || record.schemaVersion !== 1) return unknown(record ? "unsupported-record" : "no-record");
  const recordedAt = Date.parse(String(record.generatedAt ?? ""));
  if (!Number.isFinite(recordedAt)) return unknown("unreadable-timestamp");
  const checkedAt = new Date(recordedAt).toISOString();
  const age = now - recordedAt;
  if (age > AVAILABILITY_MAX_AGE_MS) return unknown("stale", checkedAt);
  // A record from the future is a clock this reader cannot reason about, not a
  // fresh one. A minute of tolerance covers ordinary skew between the job's
  // host and this one; beyond it, nothing is known.
  if (age < -60_000) return unknown("recorded-in-the-future", checkedAt);
  const row = (Array.isArray(record.plugins) ? record.plugins : []).find(item => item?.id === entry.id);
  if (!row) return unknown("not-recorded", checkedAt);
  if (row.installedVersion !== entry.version) return unknown("records-another-build", checkedAt);
  if (typeof row.available !== "string" || !row.available) return unknown(String(row.reason ?? "not-observed"), checkedAt);
  if (row.available === entry.version) return { state: "current", checkedAt, reason: "recorded", availableUpdate: null };
  return { state: "update-available", checkedAt, reason: "recorded", availableUpdate: { version: row.available, recordedAt: checkedAt, source: String(row.source ?? "recorded") } };
}

/** @param {string} projectId @param {string} pluginId @param {Map<string,any>} registry */
export function projectPluginId(projectId, pluginId = PLUGIN_ID, registry = PLUGIN_REGISTRY) {
  return `project:${productId(projectId, "project")}:${pluginEntry(pluginId, registry).id}`;
}
/** Strict projection shared by customer history and account archives. @param {any} payload @param {Map<string,any>} registry */
export function exportPluginPayload(payload, registry = PLUGIN_REGISTRY) {
  try {
    if (!exact(payload, ["schemaVersion", "pluginId", "binaryVersion", "enabled", "settings"]) || payload.schemaVersion !== 1) throw new Error("shape");
    const entry = pluginEntry(payload.pluginId, registry);
    if (!entry.supportedBinaryVersions.includes(payload.binaryVersion)) throw new Error("binary version");
    const config = validatePluginConfig({ expectedRevision: 0, enabled: payload.enabled, settings: payload.settings }, 15000, entry);
    return { schemaVersion: 1, pluginId: entry.id, binaryVersion: payload.binaryVersion, ...config };
  } catch { throw new HttpError(503, "account_export_unsupported_state", "Stored plugin settings need a supported customer export shape."); }
}
/** @param {any} row @param {any} entry */
function revision(row, entry = pluginEntry(PLUGIN_ID)) {
  const value = exportPluginPayload(row.payload, new Map([[entry.id, entry]]));
  return { revision: row.revision, enabled: value.enabled, settings: value.settings };
}

/**
 * The state one plugin is in for one project, as the browser reads it.
 *
 * A pure projection so the parts that are decidable without a database — the
 * defaults, the schema the client must be able to render, whether the saved
 * configuration *is* the removal state, and what the availability record does
 * or does not say — are tested without one.
 *
 * @param {any} entry @param {any} row
 * @param {{availability?:any,maxTimeoutMs?:number,verified?:boolean,now?:number}} options
 */
export function pluginState(entry, row, { availability = null, maxTimeoutMs = 15000, verified = true, now = Date.now() } = {}) {
  const defaults = defaultConfiguration(entry, maxTimeoutMs);
  const removal = removalConfiguration(entry, maxTimeoutMs);
  const desired = row ? revision(row, entry) : { revision: 0, ...defaults };
  const update = pluginAvailability(availability, entry, now);
  const schema = settingsSchema(entry, maxTimeoutMs);
  return {
    id: entry.id,
    binaryVersion: entry.version,
    tools: [...entry.tools],
    settingsSchema: schema,
    availableUpdate: update.availableUpdate,
    availability: { state: update.state, checkedAt: update.checkedAt, reason: update.reason },
    desired,
    effective: verified ? row?.effective ?? null : null,
    phase: !verified && ["effective", "rolled_back"].includes(row?.phase) ? "saved" : row?.phase ?? "saved",
    error: row?.error ?? null,
    // Derived, not stored: removal has no marker of its own because it has no
    // state of its own. Saying "removed" about anything other than exactly the
    // removal configuration would be a claim the record cannot support.
    removed: desired.revision > 0 && desired.enabled === removal.enabled
      && Object.keys(schema).every(key => desired.settings[key] === removal.settings[key]),
    limits: { minTimeoutMs: schema.timeoutMs?.min ?? 2000, maxTimeoutMs: schema.timeoutMs?.max ?? maxTimeoutMs },
  };
}

/** Configuration history is immutable; observations never create a configuration revision. */
export class PluginService {
  /** @param {any} database @param {{maxTimeoutMs?:number,jobs?:any,registry?:Map<string,any>,availabilityFile?:string}} options */
  constructor(database, { maxTimeoutMs = 15000, jobs = null, registry = PLUGIN_REGISTRY, availabilityFile = DEFAULT_AVAILABILITY_FILE } = {}) {
    this.database = database;
    this.admission = new AsyncLocalStorage();
    this.documents = new ProductDocuments(database);
    /** @type {((project:any)=>string|null)|null} */ this.runtimeGeneration = null;
    this.jobs = jobs ?? new ProductJobs(database);
    this.maxTimeoutMs = Math.min(15000, Math.max(2000, Math.trunc(maxTimeoutMs)));
    this.registry = registry;
    this.availabilityFile = availabilityFile;
    /** @type {any} */ this.availabilityCache = null;
    this.availabilityReadAt = 0;
  }
  /** @param {string} pluginId */
  entry(pluginId = PLUGIN_ID) { return pluginEntry(pluginId, this.registry); }
  /** Every registered plugin, in the order the record lists them. */
  entries() { return [...this.registry.values()]; }
  /** @param {string} pluginId */
  supports(pluginId) { return this.registry.has(String(pluginId)); }
  /** @param {string} projectId @param {any} entry */
  documentId(projectId, entry) { return `project:${productId(projectId, "project")}:${entry.id}`; }
  /**
   * The availability observation the nightly matrix last wrote.
   *
   * A file, not a request: the control plane must not name an external host
   * while answering a browser. Absent, unreadable or stale all mean the same
   * thing to every caller — nothing is known — and `pluginAvailability` is
   * what turns that into a verdict.
   */
  async availabilityRecord() {
    const now = Date.now();
    if (this.availabilityCache !== null && now - this.availabilityReadAt < 60_000) return this.availabilityCache.record;
    let record = null;
    try { record = JSON.parse(await readFile(this.availabilityFile, "utf8")); } catch { record = null; }
    this.availabilityCache = { record };
    this.availabilityReadAt = now;
    return record;
  }
  /** @param {any} owner @param {any} project @param {any} client */
  async scope(owner, project, client) {
    const userId = typeof owner === "string" ? owner : owner.id;
    const accountCreatedAt = typeof owner === "string" ? null : owner.accountCreatedAt ?? null;
    const result = await client.query(`SELECT u.created_at::text AS "accountCreatedAt",p.created_at::text AS "projectCreatedAt"
      FROM evimed_control.users u JOIN evimed_control.projects p ON p.user_id=u.id
      WHERE u.id=$1 AND p.id=$2 AND ($3::timestamptz IS NULL OR u.created_at=$3::timestamptz) FOR SHARE OF u,p`,
    [productId(userId), productId(project.id), accountCreatedAt]);
    if (!result.rows[0] || (project.userId && project.userId !== userId)) throw new HttpError(404, "plugin_project_unavailable", "This project is unavailable.");
    return { userId, ...result.rows[0] };
  }
  /** One plugin's state for one project. The default id keeps every existing
   *  caller — the launch plan, the apply worker's owner, the account archive —
   *  reading exactly what it read before.
   *  @param {any} owner @param {any} project @param {string} pluginId */
  async get(owner, project, pluginId = PLUGIN_ID) {
    return (await this.states(owner, project, [this.entry(pluginId)]))[0];
  }
  /** Every registered plugin with this project's configuration state.
   *  @param {any} owner @param {any} project */
  async list(owner, project) {
    return { plugins: await this.states(owner, project, this.entries()) };
  }
  /** @param {any} owner @param {any} project @param {any[]} entries */
  async states(owner, project, entries) {
    await migrateProductStore(this.database);
    const availability = await this.availabilityRecord();
    const read = async client => {
      const { userId } = await this.scope(owner, project, client);
      const ids = entries.map(entry => this.documentId(project.id, entry));
      const result = await client.query(`SELECT d.*,s.phase,s.effective,s.error,s.desired_revision,s.runtime_generation FROM evimed_product.documents d
        LEFT JOIN evimed_product.plugin_application_state s ON s.user_id=d.user_id AND s.id=d.id
        WHERE d.user_id=$1 AND d.kind='plugin' AND d.id=ANY($2::text[]) AND d.deleted_at IS NULL`, [userId, ids]);
      return entries.map((entry, index) => {
        const row = result.rows.find(candidate => candidate.id === ids[index]) ?? null;
        const verifiedHere = !this.runtimeGeneration || Boolean(row?.runtime_generation && this.runtimeGeneration(project) === row.runtime_generation);
        return pluginState(entry, row, { availability, maxTimeoutMs: this.maxTimeoutMs, verified: verifiedHere });
      });
    };
    const current = this.admission.getStore();
    return current?.projectKey === `${project.userId}:${project.id}` ? read(current.client) : this.database.transaction(read);
  }
  /** @param {any} owner @param {any} project @param {any} input @param {string} pluginId */
  async save(owner, project, input, pluginId = PLUGIN_ID) {
    const entry = this.entry(pluginId);
    const value = validatePluginConfig(input, this.maxTimeoutMs, entry);
    await migrateProductStore(this.database);
    await this.database.transaction(async client => {
      const scope = await this.scope(owner, project, client);
      const id = this.documentId(project.id, entry);
      const doc = await this.documents.put(scope.userId, "plugin", id,
        { schemaVersion: 1, pluginId: entry.id, binaryVersion: entry.version, ...value },
        { expectedRevision: input.expectedRevision, projectId: project.id, transactionClient: client });
      await client.query(`INSERT INTO evimed_product.plugin_application_state(user_id,id,desired_revision,phase)
        VALUES ($1,$2,$3,'pending') ON CONFLICT(user_id,id) DO UPDATE SET desired_revision=$3,phase='pending',error=NULL,updated_at=clock_timestamp()`,
      [scope.userId, id, doc.revision]);
      await this.enqueue(client, scope, project, doc.revision, entry);
    });
    return this.get(owner, project, entry.id);
  }
  /** Uninstall, honestly: the binary is inside the runtime image and no
   *  per-project request takes it out of there. What removal does is stop the
   *  project using it — disable it, drop the project's own settings back to
   *  their defaults, and leave that as an immutable revision the apply worker
   *  converges the runtime onto. Idempotent at the revision it produced, and
   *  guarded by the same expectedRevision rule as a save.
   *  @param {any} owner @param {any} project @param {any} input @param {string} pluginId */
  async remove(owner, project, input, pluginId = PLUGIN_ID) {
    const entry = this.entry(pluginId);
    if (!exact(input, ["expectedRevision"])) throw new HttpError(400, "plugin_config_invalid", "Removal accepts only an expected configuration revision.");
    productInteger(input.expectedRevision, 0, 2_147_483_646);
    const state = await this.get(owner, project, entry.id);
    if (state.desired.revision !== input.expectedRevision) throw new HttpError(409, "product_revision_conflict", "The configuration changed; reload before removing.");
    if (state.removed) return state;
    return this.save(owner, project, { expectedRevision: input.expectedRevision, ...removalConfiguration(entry, this.maxTimeoutMs) }, entry.id);
  }
  /** @param {any} client @param {any} scope @param {any} project @param {number} desiredRevision @param {any} entry */
  async enqueue(client, scope, project, desiredRevision, entry = pluginEntry(PLUGIN_ID)) {
    // `pluginApplyWorker` still addresses one document per project by the
    // default id, so the id rides along only when it is not that one — which
    // keeps dsh-cite's idempotency key byte-identical across this change, and
    // leaves the worker a name to read when a second bundle is installed.
    const payload = { revision: desiredRevision, accountCreatedAt: scope.accountCreatedAt, projectCreatedAt: scope.projectCreatedAt,
      ...(entry.id === PLUGIN_ID ? {} : { pluginId: entry.id }) };
    const key = createHash("sha256").update(JSON.stringify([scope.userId, project.id, payload])).digest("hex");
    return this.jobs.enqueue(scope.userId, "plugin-apply", payload,
      { idempotencyKey: `plugin-apply:${key}`, projectId: project.id, maxAttempts: 10, transactionClient: client, rearmFailed: true });
  }
  /** @param {any} owner @param {any} project @param {string} pluginId */
  async history(owner, project, pluginId = PLUGIN_ID) {
    const entry = this.entry(pluginId);
    const state = await this.get(owner, project, entry.id);
    if (state.desired.revision === 0) return { items: [] };
    const rows = await this.documents.history(typeof owner === "string" ? owner : owner.id, "plugin", this.documentId(project.id, entry), { limit: 100 });
    return { items: rows.map(row => revision(row, entry)) };
  }
  /** @param {any} owner @param {any} project @param {any} input @param {string} pluginId */
  async rollback(owner, project, input, pluginId = PLUGIN_ID) {
    const entry = this.entry(pluginId);
    if (!exact(input, ["expectedRevision", "targetRevision"])) throw new HttpError(400, "plugin_config_invalid", "Expected a saved configuration revision.");
    productInteger(input.expectedRevision, 1, 2_147_483_646);
    productInteger(input.targetRevision, 1, 2_147_483_646);
    await this.get(owner, project, entry.id);
    const row = await this.database.query(`SELECT payload,revision FROM evimed_product.revisions
      WHERE user_id=$1 AND kind='plugin' AND id=$2 AND revision=$3`,
    [typeof owner === "string" ? owner : owner.id, this.documentId(project.id, entry), input.targetRevision]);
    if (!row.rows[0]) throw new HttpError(404, "plugin_revision_unavailable", "The configuration revision is unavailable.");
    const target = revision(row.rows[0], entry);
    return this.save(owner, project, { expectedRevision: input.expectedRevision, enabled: target.enabled, settings: target.settings }, entry.id);
  }
  /** @param {any} owner @param {any} project @param {string} pluginId */
  async retry(owner, project, pluginId = PLUGIN_ID) {
    const entry = this.entry(pluginId);
    const id = this.documentId(project.id, entry);
    await migrateProductStore(this.database);
    await this.database.transaction(async client => {
      const scope = await this.scope(owner, project, client);
      const result = await client.query("SELECT revision FROM evimed_product.documents WHERE user_id=$1 AND kind='plugin' AND id=$2 AND deleted_at IS NULL", [scope.userId, id]);
      if (!result.rows[0]) throw new HttpError(404, "plugin_config_unavailable", "Save plugin settings before retrying.");
      // Completion locks the job before its document. Retry uses the same
      // order; its unlocked revision read only selects the job to lock.
      const observedRevision = result.rows[0].revision;
      const job = await this.enqueue(client, scope, project, observedRevision, entry);
      const current = await client.query("SELECT revision FROM evimed_product.documents WHERE user_id=$1 AND kind='plugin' AND id=$2 AND deleted_at IS NULL FOR UPDATE", [scope.userId, id]);
      if (current.rows[0]?.revision !== observedRevision) {
        // Throw inside the transaction so a concurrent save also rolls back
        // any rearming of the previously observed revision's job.
        throw new HttpError(409, "product_revision_conflict", "The configuration changed; reload before retrying.");
      }
      // Rearm an explicitly requested attempt, including a verified rollback.
      await client.query(`UPDATE evimed_product.jobs SET status='queued',attempts=0,finished_at=NULL,error=NULL,run_after=clock_timestamp()
        WHERE id=$1 AND status IN ('succeeded','failed','canceled')`, [job.id]);
      await client.query("UPDATE evimed_product.plugin_application_state SET phase='pending',error=NULL WHERE user_id=$1 AND id=$2 AND phase<>'applying'", [scope.userId, id]);
    });
    return this.get(owner, project, entry.id);
  }
  /** A newly started binary must verify even a previously effective revision.
   * @param {any} project */
  async runtimeStarted(project) {
    for (const entry of this.entries()) {
      const state = await this.get(project.userId, project, entry.id);
      if (state.desired.revision > 0) await this.retry(project.userId, project, entry.id);
    }
  }
  /** A shared transaction lock surrounds prompt acceptance; apply takes its exclusive counterpart.
   * @param {any} project @param {() => Promise<any>} operation @param {{prompt?:boolean}} options */
  async withAdmission(project, operation, { prompt = false } = {}) {
    await migrateProductStore(this.database);
    const projectKey = `${project.userId}:${project.id}`;
    const accept = async client => {
      if (!prompt) return operation();
      const id = randomUUID();
      await client.query("INSERT INTO evimed_product.plugin_prompt_admissions(id,user_id,project_id) VALUES ($1,$2,$3)", [id, project.userId, project.id]);
      try {
        const value = await operation();
        await client.query("DELETE FROM evimed_product.plugin_prompt_admissions WHERE id=$1", [id]);
        return value;
      } catch (error) {
        if (error?.definitivelyRejected || (error?.status >= 400 && error?.status < 500)) {
          await client.query("DELETE FROM evimed_product.plugin_prompt_admissions WHERE id=$1", [id]);
        }
        throw error;
      }
    };
    const current = this.admission.getStore();
    if (current?.projectKey === projectKey) return accept(current.client);
    const outcome = await this.database.transaction(async client => {
      const lock = await client.query("SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS acquired", [`plugin-project:${projectKey}`]);
      if (!lock.rows[0].acquired) throw new HttpError(423, "plugin_apply_in_progress", "Plugin settings are being applied; retry shortly.");
      await this.scope(project.userId, project, client);
      return this.admission.run({ projectKey, client }, async () => {
        try { return { value: await accept(client) }; }
        // Commit an unknown acceptance receipt before surfacing its transport
        // error. The shared lock excludes apply until that receipt is durable.
        catch (error) { return { error }; }
      });
    });
    if (outcome.error) throw outcome.error;
    return outcome.value;
  }
  /** @param {any} project */
  async hasPendingPrompts(project) {
    const result = await this.database.query("SELECT 1 FROM evimed_product.plugin_prompt_admissions WHERE user_id=$1 AND project_id=$2 LIMIT 1", [project.userId, project.id]);
    return result.rowCount > 0;
  }
  /** Explicit runtime cancellation settles unknown transport admissions. @param {any} project */
  async clearPromptAdmissions(project) {
    await this.database.query("DELETE FROM evimed_product.plugin_prompt_admissions WHERE user_id=$1 AND project_id=$2", [project.userId, project.id]);
  }
}
