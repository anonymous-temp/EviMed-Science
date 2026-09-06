import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "./security.mjs";
import { migrateProductStore, productId, productInteger } from "./productPersistence.mjs";
import { ProductDocuments, ProductJobs } from "./productStore.mjs";

export const PLUGIN_ID = "dsh-cite";
export const PLUGIN_VERSION = "0.3.2";
/** @param {any} value @param {string[]} keys */
function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
/** @param {any} value @param {number} maxTimeoutMs */
export function validatePluginConfig(value, maxTimeoutMs = 15000) {
  if (!exact(value, ["expectedRevision", "enabled", "settings"]) || typeof value.enabled !== "boolean"
    || !exact(value.settings, ["timeoutMs"])) throw new HttpError(400, "plugin_config_invalid", "Only enabled and timeoutMs may be configured.");
  productInteger(value.expectedRevision, 0, 2_147_483_646);
  productInteger(value.settings.timeoutMs, 2000, Math.min(15000, maxTimeoutMs));
  return { enabled: value.enabled, settings: { timeoutMs: value.settings.timeoutMs } };
}
/** @param {string} projectId */
export function projectPluginId(projectId) { return `project:${productId(projectId, "project")}:${PLUGIN_ID}`; }
/** Strict projection shared by customer history and account archives. @param {any} payload */
export function exportPluginPayload(payload) {
  try {
    if (!exact(payload, ["schemaVersion", "pluginId", "binaryVersion", "enabled", "settings"])
      || payload.schemaVersion !== 1 || payload.pluginId !== PLUGIN_ID || payload.binaryVersion !== PLUGIN_VERSION) throw new Error("shape");
    const config = validatePluginConfig({ expectedRevision: 0, enabled: payload.enabled, settings: payload.settings });
    return { schemaVersion: 1, pluginId: PLUGIN_ID, binaryVersion: PLUGIN_VERSION, ...config };
  } catch { throw new HttpError(503, "account_export_unsupported_state", "Stored plugin settings need a supported customer export shape."); }
}
/** @param {any} row */
function revision(row) {
  const value = exportPluginPayload(row.payload);
  return { revision: row.revision, enabled: value.enabled, settings: value.settings };
}
/** Configuration history is immutable; observations never create a configuration revision. */
export class PluginService {
  /** @param {any} database @param {{maxTimeoutMs?:number,jobs?:any}} options */
  constructor(database, { maxTimeoutMs = 15000, jobs = null } = {}) {
    this.database = database;
    this.admission = new AsyncLocalStorage();
    this.documents = new ProductDocuments(database);
    /** @type {((project:any)=>string|null)|null} */ this.runtimeGeneration = null;
    this.jobs = jobs ?? new ProductJobs(database);
    this.maxTimeoutMs = Math.min(15000, Math.max(2000, Math.trunc(maxTimeoutMs)));
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
  /** @param {any} owner @param {any} project */
  async get(owner, project) {
    await migrateProductStore(this.database);
    const read = async client => {
      const { userId } = await this.scope(owner, project, client);
      const result = await client.query(`SELECT d.*,s.phase,s.effective,s.error,s.desired_revision,s.runtime_generation FROM evimed_product.documents d
        LEFT JOIN evimed_product.plugin_application_state s ON s.user_id=d.user_id AND s.id=d.id
        WHERE d.user_id=$1 AND d.kind='plugin' AND d.id=$2 AND d.deleted_at IS NULL`, [userId, projectPluginId(project.id)]);
      const row = result.rows[0];
      const verifiedHere = !this.runtimeGeneration || (row?.runtime_generation && this.runtimeGeneration(project) === row.runtime_generation);
      return { id: PLUGIN_ID, binaryVersion: PLUGIN_VERSION, availableUpdate: null,
        desired: row ? revision(row) : { revision: 0, enabled: true, settings: { timeoutMs: this.maxTimeoutMs } },
        effective: verifiedHere ? row?.effective ?? null : null, phase: !verifiedHere && ["effective", "rolled_back"].includes(row?.phase) ? "saved" : row?.phase ?? "saved", error: row?.error ?? null,
        limits: { minTimeoutMs: 2000, maxTimeoutMs: this.maxTimeoutMs } };
    };
    const current = this.admission.getStore();
    return current?.projectKey === `${project.userId}:${project.id}` ? read(current.client) : this.database.transaction(read);
  }
  /** @param {any} owner @param {any} project @param {any} input */
  async save(owner, project, input) {
    const value = validatePluginConfig(input, this.maxTimeoutMs);
    await migrateProductStore(this.database);
    await this.database.transaction(async client => {
      const scope = await this.scope(owner, project, client);
      const id = projectPluginId(project.id);
      const doc = await this.documents.put(scope.userId, "plugin", id,
        { schemaVersion: 1, pluginId: PLUGIN_ID, binaryVersion: PLUGIN_VERSION, ...value },
        { expectedRevision: input.expectedRevision, projectId: project.id, transactionClient: client });
      await client.query(`INSERT INTO evimed_product.plugin_application_state(user_id,id,desired_revision,phase)
        VALUES ($1,$2,$3,'pending') ON CONFLICT(user_id,id) DO UPDATE SET desired_revision=$3,phase='pending',error=NULL,updated_at=clock_timestamp()`,
      [scope.userId, id, doc.revision]);
      await this.enqueue(client, scope, project, doc.revision);
    });
    return this.get(owner, project);
  }
  /** @param {any} client @param {any} scope @param {any} project @param {number} desiredRevision */
  async enqueue(client, scope, project, desiredRevision) {
    const payload = { revision: desiredRevision, accountCreatedAt: scope.accountCreatedAt, projectCreatedAt: scope.projectCreatedAt };
    const key = createHash("sha256").update(JSON.stringify([scope.userId, project.id, payload])).digest("hex");
    return this.jobs.enqueue(scope.userId, "plugin-apply", payload,
      { idempotencyKey: `plugin-apply:${key}`, projectId: project.id, maxAttempts: 10, transactionClient: client, rearmFailed: true });
  }
  /** @param {any} owner @param {any} project */
  async history(owner, project) {
    const state = await this.get(owner, project);
    if (state.desired.revision === 0) return { items: [] };
    const rows = await this.documents.history(typeof owner === "string" ? owner : owner.id, "plugin", projectPluginId(project.id), { limit: 100 });
    return { items: rows.map(revision) };
  }
  /** @param {any} owner @param {any} project @param {any} input */
  async rollback(owner, project, input) {
    if (!exact(input, ["expectedRevision", "targetRevision"])) throw new HttpError(400, "plugin_config_invalid", "Expected a saved configuration revision.");
    productInteger(input.expectedRevision, 1, 2_147_483_646);
    productInteger(input.targetRevision, 1, 2_147_483_646);
    await this.get(owner, project);
    const row = await this.database.query(`SELECT payload,revision FROM evimed_product.revisions
      WHERE user_id=$1 AND kind='plugin' AND id=$2 AND revision=$3`,
    [typeof owner === "string" ? owner : owner.id, projectPluginId(project.id), input.targetRevision]);
    if (!row.rows[0]) throw new HttpError(404, "plugin_revision_unavailable", "The configuration revision is unavailable.");
    const target = revision(row.rows[0]);
    return this.save(owner, project, { expectedRevision: input.expectedRevision, enabled: target.enabled, settings: target.settings });
  }
  /** @param {any} owner @param {any} project */
  async retry(owner, project) {
    await migrateProductStore(this.database);
    await this.database.transaction(async client => {
      const scope = await this.scope(owner, project, client);
      const result = await client.query("SELECT revision FROM evimed_product.documents WHERE user_id=$1 AND kind='plugin' AND id=$2 AND deleted_at IS NULL", [scope.userId, projectPluginId(project.id)]);
      if (!result.rows[0]) throw new HttpError(404, "plugin_config_unavailable", "Save plugin settings before retrying.");
      // Completion locks the job before its document. Retry uses the same
      // order; its unlocked revision read only selects the job to lock.
      const observedRevision = result.rows[0].revision;
      const job = await this.enqueue(client, scope, project, observedRevision);
      const current = await client.query("SELECT revision FROM evimed_product.documents WHERE user_id=$1 AND kind='plugin' AND id=$2 AND deleted_at IS NULL FOR UPDATE", [scope.userId, projectPluginId(project.id)]);
      if (current.rows[0]?.revision !== observedRevision) {
        // Throw inside the transaction so a concurrent save also rolls back
        // any rearming of the previously observed revision's job.
        throw new HttpError(409, "product_revision_conflict", "The configuration changed; reload before retrying.");
      }
      // Rearm an explicitly requested attempt, including a verified rollback.
      await client.query(`UPDATE evimed_product.jobs SET status='queued',attempts=0,finished_at=NULL,error=NULL,run_after=clock_timestamp()
        WHERE id=$1 AND status IN ('succeeded','failed','canceled')`, [job.id]);
      await client.query("UPDATE evimed_product.plugin_application_state SET phase='pending',error=NULL WHERE user_id=$1 AND id=$2 AND phase<>'applying'", [scope.userId, projectPluginId(project.id)]);
    });
    return this.get(owner, project);
  }
  /** A newly started binary must verify even a previously effective revision.
   * @param {any} project */
  async runtimeStarted(project) {
    const state = await this.get(project.userId, project);
    if (state.desired.revision > 0) await this.retry(project.userId, project);
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
