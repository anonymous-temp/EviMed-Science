import { createHash } from "node:crypto";
import { canonicalJson, CONNECTOR_CREDENTIALS } from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { extensionArray, extensionIdentifier, extensionRequestObject } from "./extensionAccess.mjs";

const credentialKinds = new Set(CONNECTOR_CREDENTIALS.map(item => item.id));
/** An operation registry is platform-owned. A package cannot widen a connection's allowed actions. @param {any} entry */
function requirements(entry) {
  if (!entry) return [];
  return extensionArray(entry.connectionRequirements ?? [], 16).map(value => {
    const item = extensionRequestObject(value, ["kind", "operations"]);
    extensionIdentifier(item.kind);
    const operations = extensionArray(item.operations, 32).map(extensionIdentifier);
    if (!operations.length || new Set(operations).size !== operations.length) throw new HttpError(400, "extension_contract_invalid", "Invalid admitted connection operations.");
    return { kind: item.kind, operations };
  });
}
/** Reference revisions contain metadata only; credential values stay in the existing store/gateway. @param {unknown} value */
const revision = value => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
/**
 * What of a researcher's own credential row a revision binds: when it was
 * written and until when it holds. Advice recorded beside the row (the upstream
 * check on save) is not part of it — a revision computed from the status and
 * one recomputed from the row must agree, and they disagreed the day `check`
 * was added to the status.
 * @param {any} own
 */
const ownIdentity = own => own ? { updatedAt: own.updatedAt, expiresAt: own.expiresAt ?? null, expired: Boolean(own.expired) } : null;

/** Reuse existing credential and channel adapters. No new token table, plaintext export or raw runtime credential endpoint. */
export class ExtensionConnections {
  /** @param {{credentials:any,access:any,adapters?:Map<string,any>}} options */
  constructor({ credentials, access, adapters = new Map() }) {
    this.credentials = credentials; this.access = access; this.adapters = adapters;
  }
  /** Eligible references are resolved for the authenticated actor and current manage right, never the project's owner's credentials. @param {any} user @param {any} entry @param {string} projectId */
  async list(user, entry, projectId) {
    const project = await this.access.project(user, projectId, { manage: true });
    const wanted = requirements(entry), items = [];
    const statuses = this.credentials && wanted.some(item => credentialKinds.has(item.kind)) ? await this.credentials.status(user.id) : [];
    for (const requirement of wanted) {
      const adapter = this.adapters.get(requirement.kind);
      if (adapter) {
        const rows = await adapter.list(user, { project, operations: requirement.operations });
        extensionArray(rows, 64);
        for (const row of rows) {
          const allowed = extensionRequestObject(row, ["id", "title", "kind", "operations", "revision"]);
          extensionIdentifier(allowed.id);
          if (allowed.kind !== requirement.kind || typeof allowed.title !== "string" || allowed.title.length > 240
            || typeof allowed.revision !== "string" || !/^sha256:[a-f0-9]{64}$/.test(allowed.revision)
            || !Array.isArray(allowed.operations) || allowed.operations.some(operation => !requirement.operations.includes(operation))) {
            throw new HttpError(502, "extension_contract_invalid", "Invalid managed connection descriptor.");
          }
          // Hydration always rechecks revocation and operation scope, even if a caller's adapter cached its inventory.
          if (await adapter.authorize(user, allowed.id, { project, operations: requirement.operations, revision: allowed.revision })) items.push(allowed);
        }
      } else {
        const status = statuses.find(item => item.id === requirement.kind);
        if (!status || !["user", "deployment"].includes(status.source)) continue;
        items.push({ id: `connector:${status.id}`, title: status.title, kind: status.id, operations: requirement.operations,
          revision: revision({ actorId: user.id, connector: status.id, source: status.source, own: ownIdentity(status.own) }) });
      }
    }
    if (items.length > 64 || new Set(items.map(item => item.id)).size !== items.length) throw new HttpError(502, "extension_contract_invalid", "Invalid managed connection inventory.");
    return { items, supportedKinds: wanted.map(item => item.kind) };
  }
  /** Called on configuration AND every gateway operation. `entry` and operation are supplied by trusted dispatch, not tool arguments. @param {any} user @param {string} ref @param {{client?:any,project?:any,entry?:any,operation?:string,revision?:string}} scope */
  async authorize(user, ref, { client = null, project, entry, operation, revision: expectedRevision } = {}) {
    const wanted = requirements(entry);
    if (!project || !wanted.length) return false;
    // This resolves membership again, including completion/refresh after a grant is revoked.
    const currentProject = await this.access.project(user, project.id, { manage: !operation, ability: operation === 'doc_write' ? 'write' : operation ? 'read' : 'manage_study', client });
    if (project.userId !== currentProject.userId) return false;
    for (const requirement of wanted) {
      if (operation && !requirement.operations.includes(operation)) continue;
      const adapter = this.adapters.get(requirement.kind);
      if (adapter && await adapter.authorize(user, ref, { client, project, operations: operation ? [operation] : requirement.operations,
        ...(expectedRevision ? { revision: expectedRevision } : {}) })) return true;
      if (!adapter && ref === `connector:${requirement.kind}` && credentialKinds.has(requirement.kind) && this.credentials) {
        if (this.credentials.deploymentConfigured(requirement.kind)) {
          const status = (await this.credentials.status(user.id)).find(item => item.id === requirement.kind);
          if (!status || status.source !== "deployment") return false;
          return !expectedRevision || expectedRevision === revision({ actorId: user.id, connector: status.id, source: status.source, own: ownIdentity(status.own) });
        }
        const database = client ?? this.credentials.database;
        const result = await database.query(`SELECT connector,expires_at,updated_at FROM evimed_control.user_connector_credentials
          WHERE user_id=$1 AND connector=$2 AND (expires_at IS NULL OR expires_at>clock_timestamp())${client ? " FOR SHARE" : ""}`,
        [user.id, requirement.kind]);
        if (!result.rows[0]) return false;
        if (expectedRevision) {
          const row = result.rows[0], expiresAt = row.expires_at ? new Date(row.expires_at).toISOString() : null;
          const current = revision({ actorId: user.id, connector: requirement.kind, source: "user", own: {
            updatedAt: new Date(row.updated_at).toISOString(), expiresAt, expired: false,
          } });
          if (current !== expectedRevision) return false;
        }
        return true;
      }
    }
    return false;
  }
}
