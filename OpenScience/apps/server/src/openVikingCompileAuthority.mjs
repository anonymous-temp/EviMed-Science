import { createHash, randomInt } from "node:crypto";
import { canonicalJson, PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { OPENVIKING_PROJECT_ID } from "./internalProjects.mjs";

const RECORD_ID = "openviking:compile-qualification";
const SKILLS = new Set(["llm-wiki", "knowledge-graph"]);
const digest = value => createHash("sha256").update(canonicalJson(value)).digest("hex");
const positive = value => Number.isSafeInteger(value) && value > 0;
const environmentOf = binding => ({ imageDigest: binding.imageDigest, engineVersion: binding.engineVersion,
  configDigest: binding.configDigest, qualificationDigest: binding.qualificationDigest, upstreamCommit: binding.upstreamCommit });

/** One deployment-wide authority, using the existing internal engine project.
 * A known unsafe engine or Skill must invalidate historical use in every
 * project, not only the project that happened to observe it. No raw engine
 * configuration, prompt, tool output or credential is stored here. */
export class OpenVikingCompileAuthority {
  constructor({ documents, ensureOwner, scopeDigest, isCurrentBinding, readConfigurationDigest }) {
    this.documents = documents;
    this.ensureOwner = ensureOwner;
    this.scopeDigest = scopeDigest;
    this.isCurrentBinding = isCurrentBinding;
    this.readConfigurationDigest = readConfigurationDigest;
  }

  async snapshot(transactionClient = null) {
    if (!this.documents) return { revision: 0, value: null };
    let row;
    if (transactionClient) {
      const reply = await transactionClient.query(`SELECT project_id AS "projectId",revision,payload FROM evimed_product.documents
        WHERE user_id=$1 AND kind='knowledge' AND id=$2 AND deleted_at IS NULL FOR SHARE`, [PLATFORM_PUBLISHER_USER_ID, RECORD_ID]);
      row = reply.rows[0] ?? null;
    } else row = await this.documents.get(PLATFORM_PUBLISHER_USER_ID, "knowledge", RECORD_ID);
    if (!row) return { revision: 0, value: null };
    if (row.projectId !== OPENVIKING_PROJECT_ID || row.payload?.recordType !== "knowledge-compile-qualification"
      || row.payload.version !== 1) throw new Error("knowledge_compile_authority_invalid");
    return { revision: row.revision, value: row.payload };
  }

  /** Snapshot is read BEFORE observation. A stale success cannot overwrite a
   * newer revocation: CAS conflict asks the caller to observe again. */
  async record(snapshot, observation) {
    if (!this.documents || !this.ensureOwner || observation.state === "unavailable") return null;
    const owner = await this.ensureOwner();
    if (owner?.userId !== PLATFORM_PUBLISHER_USER_ID || owner?.projectId !== OPENVIKING_PROJECT_ID) return null;
    const old = snapshot.value;
    const sameScope = old?.scopeDigest === this.scopeDigest;
    const next = sameScope ? structuredClone(old) : { recordType: "knowledge-compile-qualification", version: 1,
      // A fresh authority lifetime must not restart at the same epoch after
      // its internal owner/document was removed and recreated.
      scopeDigest: this.scopeDigest, environment: { epoch: old?.environment?.epoch ?? randomInt(1, 2 ** 48), state: "revoked" }, skills: {} };
    if (observation.state === "qualified") {
      const { skill, binding } = observation;
      if (!SKILLS.has(skill) || !this.isCurrentBinding(binding, skill)) return null;
      const basis = environmentOf(binding);
      if (next.environment.state !== "qualified" || digest(next.environment.basis ?? null) !== digest(basis)) {
        next.environment = { epoch: next.environment.epoch + 1, state: "qualified", basis };
        next.skills = {};
      }
      const bindingDigest = digest(binding), held = next.skills[skill];
      if (held?.state !== "qualified" || held.bindingDigest !== bindingDigest || held.environmentEpoch !== next.environment.epoch) {
        next.skills[skill] = { epoch: (held?.epoch ?? 0) + 1, environmentEpoch: next.environment.epoch,
          state: "qualified", binding, bindingDigest };
      }
    } else if (observation.state === "rejected") {
      const code = /^[a-z][a-z0-9_]{0,63}$/.test(observation.code ?? "") ? observation.code : "observation_rejected";
      if (observation.scope === "skill" && SKILLS.has(observation.skill)) {
        const held = next.skills[observation.skill];
        if (held?.state !== "revoked" || held.reasonCode !== code) {
          next.skills[observation.skill] = { epoch: (held?.epoch ?? 0) + 1, environmentEpoch: next.environment.epoch,
            state: "revoked", reasonCode: code };
        }
      } else {
        if (next.environment.state !== "revoked" || next.environment.reasonCode !== code) {
          next.environment = { epoch: next.environment.epoch + 1, state: "revoked", reasonCode: code };
          next.skills = {};
        }
      }
    } else return null;
    if (!positive(next.environment.epoch) || Object.values(next.skills).some(slot => !positive(slot.epoch))) return null;
    // Even an unchanged success must not race past an intervening revocation.
    if (old && digest(old) === digest(next)) {
      const current = await this.snapshot();
      return current.revision === snapshot.revision ? current : null;
    }
    try {
      const row = await this.documents.put(PLATFORM_PUBLISHER_USER_ID, "knowledge", RECORD_ID, next,
        { projectId: OPENVIKING_PROJECT_ID, expectedRevision: snapshot.revision });
      return { revision: row.revision, value: row.payload };
    } catch (error) {
      if (error?.code === "product_revision_conflict") return null;
      throw error;
    }
  }

  slot(snapshot, skill, binding) {
    const state = snapshot.value, held = state?.skills?.[skill];
    if (state?.scopeDigest !== this.scopeDigest || state.environment?.state !== "qualified" || held?.state !== "qualified"
      || !positive(state.environment.epoch) || !positive(held.epoch) || held.environmentEpoch !== state.environment.epoch
      || !this.isCurrentBinding(binding, skill) || !this.isCurrentBinding(held.binding, skill)
      || held.bindingDigest !== digest(binding) || digest(held.binding) !== held.bindingDigest
      || digest(environmentOf(binding)) !== digest(state.environment.basis)) return null;
    return { environmentEpoch: state.environment.epoch, skillEpoch: held.epoch, bindingDigest: held.bindingDigest };
  }

  async reference(skill, binding, transactionClient = null) {
    return this.slot(await this.snapshot(transactionClient), skill, binding);
  }

  /** Historical output verification never starts or resumes a compile. Its
   * saved authority reference is required separately from request.execution. */
  async completed(skill, binding, authorityRef, transactionClient = null) {
    if (!authorityRef || Object.keys(authorityRef).sort().join(",") !== "bindingDigest,environmentEpoch,skillEpoch") return null;
    const snapshot = await this.snapshot(transactionClient), current = this.slot(snapshot, skill, binding);
    if (!current || digest(current) !== digest(authorityRef)) return null;
    const configurationDigest = await this.readConfigurationDigest();
    if (configurationDigest !== snapshot.value.environment.basis.configDigest) return null;
    return snapshot.value.skills[skill].binding;
  }
}
