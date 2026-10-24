import { createHash } from 'node:crypto';
import { geoAbilitiesOf } from '@evimed/domain';
import { canonicalJson } from './geoStore.mjs';
import { HttpError } from './security.mjs';
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const sessionIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const missing = () => new HttpError(404, 'runtime_session_not_found', 'This GEO conversation is unavailable.');
const changed = () => new HttpError(403, 'geo_member_forbidden', 'The GEO conversation authority changed. Reopen it from the project.');

/** GEO-scoped delegation to the existing owner workspace. Generic account project authority stays unchanged. */
export class GeoNativeAuthority {
  constructor({ store, accounts, service, documents, results, createSession, ensureSession, runs }) {
    this.store = store; this.accounts = accounts; this.service = service; this.documents = documents; this.results = results;
    this.createSession = createSession; this.ensureSession = ensureSession; this.runs = runs;
  }

  async identity(user, geoId, { ability = 'run', client = null } = {}) {
    if (!this.service.allows(user)) throw missing();
    const geo = await this.service.requireProject(user, geoId, ability);
    const query = client ? (sql, values) => client.query(sql, values) : (sql, values) => this.store.query(sql, values);
    const identity = (await query(`SELECT g.user_id AS owner_id,g.project_id,g.created_at::text AS geo_created_at,
      p.created_at::text AS project_created_at,u.created_at::text AS owner_created_at,a.created_at::text AS actor_created_at
      FROM evimed_geo.projects g JOIN evimed_control.projects p ON p.user_id=g.user_id AND p.id=g.project_id
      JOIN evimed_control.users u ON u.id=g.user_id JOIN evimed_control.users a ON a.id=$2
      WHERE g.id=$1 AND g.deleted_at IS NULL AND p.archived_at IS NULL${client ? ' FOR SHARE OF g,p,u,a' : ''}`, [geo.id, user.id])).rows[0];
    if (!identity || identity.owner_id !== geo.userId || identity.project_id !== geo.projectId) throw missing();
    const membership = user.id === geo.userId ? null : (await query(`SELECT role,created_at::text AS epoch FROM evimed_geo.members
      WHERE geo_project_id=$1 AND user_id=$2 ORDER BY role${client ? ' FOR SHARE' : ''}`, [geo.id, user.id])).rows;
    const abilities = geoAbilitiesOf(membership ? membership.map(item => item.role) : ['owner']);
    if (!abilities.includes(ability) || ability === 'run' && !abilities.includes('edit')) throw changed();
    const owner = await this.accounts.userById(geo.userId);
    if (!owner) throw missing();
    const project = await this.accounts.requireProject(owner, geo.projectId);
    return { geo, project, principal: { kind: 'geo', actorId: String(user.id), ownerId: geo.userId, controlProjectId: geo.projectId,
      geoProjectId: geo.id, actorCreatedAt: identity.actor_created_at, ownerCreatedAt: identity.owner_created_at,
      projectCreatedAt: identity.project_created_at, geoCreatedAt: identity.geo_created_at,
      membershipEpoch: membership ? hash(membership) : null } };
  }

  base(identity) {
    const { principal } = identity;
    return { geoId: principal.geoProjectId, ownerId: principal.ownerId, projectId: principal.controlProjectId,
      ownerCreatedAt: principal.ownerCreatedAt, projectCreatedAt: principal.projectCreatedAt, geoCreatedAt: principal.geoCreatedAt };
  }

  sessionKey(identity, sessionId) { return `gns_${hash([this.base(identity), sessionId])}`; }
  primaryKey(identity) { return `gnp_${hash(this.base(identity))}`; }

  /** Called only after the server created or explicitly bound the primary session. */
  async registerPrimary(geo, sessionId) {
    if (!sessionIdValid(sessionId)) throw missing();
    const identity = await this.identity({ id: geo.userId }, geo.id), base = this.base(identity);
    const id = this.sessionKey(identity, sessionId), pointer = this.primaryKey(identity);
    const existing = await this.documents.get(geo.userId, 'geo-plan-context', pointer);
    if (existing) {
      if (existing.projectId !== geo.projectId || existing.payload.recordType !== 'geo-native-primary' || existing.payload.referenceId !== id
        || existing.payload.sessionId !== sessionId || canonicalJson(existing.payload.base) !== canonicalJson(base)) throw changed();
      return this.proveSession(identity, sessionId);
    }
    try {
      await this.documents.createBatch(geo.userId, [
        { kind: 'geo-plan-context', id, projectId: geo.projectId, payload: { recordType: 'geo-native-session', base, sessionId, association: 'primary' } },
        { kind: 'geo-plan-context', id: pointer, projectId: geo.projectId, payload: { recordType: 'geo-native-primary', base, sessionId, referenceId: id } },
      ]);
    } catch (error) {
      const saved = await this.documents.get(geo.userId, 'geo-plan-context', pointer);
      if (saved?.payload?.sessionId !== sessionId || canonicalJson(saved.payload.base) !== canonicalJson(base)) throw error;
    }
    return sessionId;
  }

  async primary(identity) {
    const pointer = await this.documents.get(identity.geo.userId, 'geo-plan-context', this.primaryKey(identity));
    if (!pointer) return null;
    if (pointer.projectId !== identity.geo.projectId || pointer.payload.recordType !== 'geo-native-primary'
      || pointer.payload.referenceId !== this.sessionKey(identity, pointer.payload.sessionId)
      || canonicalJson(pointer.payload.base) !== canonicalJson(this.base(identity))) throw missing();
    return this.proveSession(identity, pointer.payload.sessionId);
  }

  async proveSession(identity, sessionId) {
    if (!sessionIdValid(sessionId)) throw missing();
    const saved = await this.documents.get(identity.geo.userId, 'geo-plan-context', this.sessionKey(identity, sessionId));
    if (saved) {
      if (saved.projectId !== identity.geo.projectId || saved.payload.recordType !== 'geo-native-session' || saved.payload.sessionId !== sessionId
        || canonicalJson(saved.payload.base) !== canonicalJson(this.base(identity))) throw missing();
      return sessionId;
    }
    // Existing completed handling records are proof; arbitrary owner session
    // inventory and staged contexts never commission a delegated conversation.
    for (const run of await this.runs(identity.geo)) if (run.sessionId === sessionId) {
      try { if ((await this.results.scope({ id: identity.geo.userId }, identity.geo.id, null, run.id)).context) return sessionId; }
      catch (error) { if (error?.status !== 404) throw error; }
    }
    throw missing();
  }

  async resolve(user, scope, { claims = null, ability = 'run', client = null } = {}) {
    if (!scope || scope.kind !== 'geo' || Object.keys(scope).some(key => !['kind', 'geoProjectId', 'sessionId'].includes(key))) throw missing();
    const identity = await this.identity(user, scope.geoProjectId, { ability, client });
    const rootSessionId = await this.proveSession(identity, scope.sessionId);
    const principal = { ...identity.principal, rootSessionId };
    if (claims && canonicalJson(claims) !== canonicalJson(principal)) throw changed();
    return { ...identity, principal };
  }

  async descriptor(user, geoId, target) {
    if (!target || Object.keys(target).some(key => !['kind', 'referenceId', 'sessionId'].includes(key))) throw missing();
    let identity = await this.identity(user, geoId), sessionId;
    if (target.kind === 'primary' && Object.keys(target).length === 1) {
      sessionId = await this.primary(identity);
      if (!sessionId) {
        sessionId = await this.store.transaction(client => this.store.database.withTransactionClient(client, async () => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('geo-native-primary:' || $1))", [geoId]);
          identity = await this.identity(user, geoId, { client });
          const existing = await this.primary(identity);
          if (existing) return existing;
          const created = await this.createSession(identity.project);
          return this.registerPrimary(identity.geo, created.id);
        }));
      }
    } else if (target.kind === 'session' && Object.keys(target).length === 2) sessionId = await this.proveSession(identity, target.sessionId);
    else if (target.kind === 'context' && Object.keys(target).length === 2 && /^gpc_[a-f0-9]{64}$/.test(target.referenceId ?? '')) {
      const context = await this.documents.get(identity.geo.userId, 'geo-plan-context', target.referenceId);
      if (context?.projectId !== identity.geo.projectId || context.payload.geoId !== geoId || context.payload.state !== 'bound') throw missing();
      sessionId = await this.proveSession(identity, context.payload.sessionId);
    } else throw missing();
    await this.ensureSession(identity.project, sessionId);
    const fresh = await this.resolve(user, { kind: 'geo', geoProjectId: geoId, sessionId });
    return { scope: { kind: 'geo', geoProjectId: geoId, sessionId }, projectId: fresh.project.id, projectName: fresh.project.name, sessionId };
  }

  async withFrame(user, claims, operation) {
    return this.store.transaction(client => this.store.database.withTransactionClient(client, async () => {
      const resolved = await this.resolve(user, { kind: 'geo', geoProjectId: claims.geoProjectId, sessionId: claims.rootSessionId }, { claims, client });
      return operation(resolved);
    }));
  }
}
