import { createHash } from 'node:crypto';
import { projectNativeMemoryNamespace } from './openVikingLayout.mjs';
import { canonicalJson } from './geoStore.mjs';
import { HttpError } from './security.mjs';

const KIND = 'geo-plan-context';
const RECORD_TYPE = 'geo-native-context-policy';
const refused = () => new HttpError(403, 'memory_scope_denied', 'The project context policy is unavailable or changed.');
const keyOf = namespace => `gncp_${createHash('sha256').update(namespace.id).digest('hex')}`;

/** Persistent project context floor of a shared GEO project, derived from the
 * owner's canonical control project rather than the browser's actor, selected
 * tab or current session. It applies while the project has a member; a GEO
 * project its owner works in alone is an owned project. Uses the existing
 * product document ledger; it stores no memory text.
 */
export class GeoSharedContext {
  constructor({ database, documents }) { this.database = database; this.documents = documents; }

  read(row, ownerId, expected = null) {
    const payload = row?.payload;
    if (!payload || payload.recordType !== RECORD_TYPE || payload.policyVersion !== 1
      || Object.keys(payload).some(key => !['recordType', 'policyVersion', 'geoProjectId', 'namespace'].includes(key))
      || typeof payload.geoProjectId !== 'string' || !payload.geoProjectId
      || !Number.isSafeInteger(row.revision) || row.revision < 1) throw refused();
    let namespace;
    try { namespace = projectNativeMemoryNamespace(payload.namespace); } catch { throw refused(); }
    if (canonicalJson(namespace) !== canonicalJson(payload.namespace) || row.id !== keyOf(namespace)
      || ownerId !== namespace.ownerId || row.kind !== KIND || row.deletedAt != null || row.projectId !== namespace.projectId
      || expected && canonicalJson(expected) !== canonicalJson(namespace)) throw refused();
    return Object.freeze({ kind: 'geo-project', ownerId: namespace.ownerId, controlProjectId: namespace.projectId,
      geoProjectId: payload.geoProjectId, ownerCreatedAt: namespace.ownerCreatedAt, projectCreatedAt: namespace.projectCreatedAt,
      policyVersion: 1, revision: row.revision, referenceId: row.id, namespace });
  }

  /** Caller already resolved a real owned project or authenticated workload. */
  async forProject(project) {
    if (!project || typeof project.userId !== 'string' || typeof project.id !== 'string') throw refused();
    return this.database.transaction(client => this.database.withTransactionClient(client, async () => {
      const identity = (await client.query(`SELECT u.id AS "ownerId",u.created_at::text AS "ownerCreatedAt",
        p.id AS "projectId",p.created_at::text AS "projectCreatedAt"
        FROM evimed_control.users u JOIN evimed_control.projects p ON p.user_id=u.id
        WHERE u.id=$1 AND p.id=$2 AND p.archived_at IS NULL FOR SHARE OF u,p`, [project.userId, project.id])).rows[0];
      if (!identity) throw refused();
      const namespace = projectNativeMemoryNamespace(identity), id = keyOf(namespace);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id]);
      const saved = await this.documents.get(project.userId, KIND, id, { includeDeleted: true });
      // A saved floor is checked whatever the membership says: a changed or removed one is refused, never read as personal.
      const policy = saved ? this.read(saved, project.userId, namespace) : null;
      const owned = { kind: 'owned', ownerId: project.userId, controlProjectId: project.id };
      const tables = (await client.query(`SELECT to_regclass('evimed_geo.projects') IS NOT NULL AS projects,
        to_regclass('evimed_geo.members') IS NOT NULL AS members`)).rows[0];
      // The project namespace is a shared project's: a live GEO project with at least one member (owner ruling 2026-10-25).
      // A one-person GEO project is its owner's like any other project — their own memory, capsule, packs and methods, the
      // project a label — and the decision is read here on every call, so adding the first member or removing the last one
      // takes effect at the next operation. Nothing is moved: what was written in either namespace stays where it is.
      const geo = tables?.projects ? (await client.query(`SELECT g.id, g.deleted_at IS NULL AS live,
        ${tables.members ? 'EXISTS (SELECT 1 FROM evimed_geo.members m WHERE m.geo_project_id=g.id)' : 'false'} AS shared
        FROM evimed_geo.projects g WHERE g.user_id=$1 AND g.project_id=$2`, [project.userId, project.id])).rows : [];
      if (geo.length > 1) throw refused();
      if (!geo[0]?.live || !geo[0].shared) return owned;
      if (policy) return policy;
      const row = await this.documents.put(project.userId, KIND, id, { recordType: RECORD_TYPE, policyVersion: 1,
        geoProjectId: geo[0].id, namespace }, { projectId: project.id, expectedRevision: 0, transactionClient: client });
      return this.read(row, project.userId, namespace);
    }));
  }

  /** The gateway calls this only after checking its workload token. A body
   * session id cannot select an owner's personal context or another project. */
  forWorkload(identity) { return this.forProject({ userId: identity?.userId, id: identity?.projectId }); }

  /** Include historical project incarnations for owner export/cleanup. Never
   * include a previous account incarnation with a reused public account id. */
  async namespacesForOwner(ownerId) {
    return (await this.policiesForOwner(ownerId)).map(policy => policy.namespace);
  }

  async policiesForOwner(ownerId) {
    return this.database.transaction(client => this.database.withTransactionClient(client, async () => {
      const owner = (await client.query('SELECT created_at::text AS created FROM evimed_control.users WHERE id=$1 FOR SHARE', [ownerId])).rows[0];
      if (!owner) throw refused();
      const namespaces = [], seen = new Set();
      let cursor = null;
      do {
        const page = await this.documents.list(ownerId, KIND, { limit: 100, cursor,
          filter: { recordType: RECORD_TYPE, namespace: { ownerId, ownerCreatedAt: owner.created } } });
        for (const row of page.items) {
          const policy = this.read(row, ownerId);
          if (seen.has(policy.namespace.id)) throw refused();
          seen.add(policy.namespace.id); namespaces.push(policy);
          if (namespaces.length > 10000) throw new HttpError(502, 'memory_index_listing_too_large', 'The project memory namespace listing exceeded its bound.');
        }
        cursor = page.nextCursor;
      } while (cursor);
      return namespaces.sort((left, right) => left.namespace.id.localeCompare(right.namespace.id));
    }));
  }
}
