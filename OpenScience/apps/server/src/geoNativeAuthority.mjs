import { createHash } from 'node:crypto';
import { geoAbilitiesOf } from '@evimed/domain';
import { geoPlanDigest } from './geoPlanContext.mjs';
import { canonicalJson } from './geoStore.mjs';
import { HttpError } from './security.mjs';
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const sessionIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const missing = () => new HttpError(404, 'runtime_session_not_found', 'This GEO conversation is unavailable.');
const changed = () => new HttpError(403, 'geo_member_forbidden', 'The GEO conversation authority changed. Reopen it from the project.');
/** The kernel's inventory was read and does not list the session (`authorizeOwnedNativeSession`); any other failure proves nothing. */
const absent = error => error?.status === 404 && error?.code === 'runtime_session_not_found';
const PRIMARY_LOCK = "SELECT pg_advisory_xact_lock(hashtext('geo-native-primary:' || $1))";

/** GEO-scoped delegation to the existing owner workspace. Generic account project authority stays unchanged. */
export class GeoNativeAuthority {
  #runSnapshots = new WeakMap();
  /**
   * `adoptSession(identity)` names the conversation a project already has, for a project whose primary conversation was never
   * registered (one made before GEO conversations were delegated, 2026-10-25): its recorded conversation while that still exists, else
   * the oldest one of the person's. Without it the owner's first open of such a project made a new, empty conversation beside the
   * research conversation the project had been worked in. It is asked for the owner only: the primary is the conversation every member
   * reads, and only the owner may make one of their own conversations that.
   * `sessionListed(project, sessionId)` says whether the runtime that is already running lists the session, without starting one; the
   * owner's read registers a kept conversation only then.
   */
  constructor({ store, accounts, service, documents, results, createSession, ensureSession, runs, adoptSession = null, sessionListed = null }) {
    this.store = store; this.accounts = accounts; this.service = service; this.documents = documents; this.results = results;
    this.createSession = createSession; this.ensureSession = ensureSession; this.runs = runs; this.adoptSession = adoptSession;
    this.sessionListed = sessionListed;
    this.primaryCreates = new Map();
  }

  /** Internal dispatch association only; the server constructs the verified proof. */
  async recordKnowledgeDispatch(project, geoId, current, binding, proof) {
    const saved = await this.store.query(`UPDATE evimed_geo.schedule_marks SET detail=jsonb_set(detail,'{nativeKnowledgeDispatch}',$1::jsonb,true)
      WHERE geo_project_id=$2 AND user_id=$3 AND kind='run' AND dispatch_id=$4 AND state IN ('claimed','running')
        AND detail->>'capabilityId'=$5 AND (run_id IS NULL OR run_id=$6) AND (session_id IS NULL OR session_id=$7) RETURNING key`,
    [JSON.stringify(proof), geoId, project.userId, current.dispatchId, binding.agentId, current.id, current.sessionId]);
    if (saved.rows.length !== 1) throw new HttpError(409, "knowledge_scope_denied", "The module source dispatch is unavailable.");
  }

  /** Read inside the caller's canonical run snapshot; duplicates remain untrusted. */
  async knowledgeDispatchMarks(project, geoId, dispatchId) {
    return (await this.store.query(`SELECT run_id,session_id,detail FROM evimed_geo.schedule_marks
          WHERE geo_project_id=$1 AND user_id=$2 AND kind='run' AND dispatch_id=$3 AND state IN ('claimed','running')`,
        [geoId, project.userId, dispatchId])).rows;
  }

  async identity(user, geoId, { ability = 'run', client = null } = {}) {
    if (!this.service?.allows(user)) throw missing();
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

  /** Read-only internal association lookup. A disabled module cannot issue
   * frames or commission sessions, while accepted owner work keeps its scope.
   * The caller supplies an already resolved control project and persistent floor. */
  async retainedIdentity(project, policy) {
    if (policy?.kind !== 'geo-project' || project?.userId !== policy.ownerId || project.id !== policy.controlProjectId) throw missing();
    const saved = await this.documents.get(project.userId, 'geo-plan-context', policy.referenceId);
    if (saved?.projectId !== project.id || saved.payload.recordType !== 'geo-native-context-policy'
      || canonicalJson(saved.payload.namespace) !== canonicalJson(policy.namespace)) throw missing();
    const row = (await this.store.query(`SELECT g.created_at::text AS geo_created_at,p.created_at::text AS project_created_at,
      u.created_at::text AS owner_created_at FROM evimed_geo.projects g
      JOIN evimed_control.projects p ON p.user_id=g.user_id AND p.id=g.project_id
      JOIN evimed_control.users u ON u.id=g.user_id WHERE g.id=$1 AND g.user_id=$2 AND g.project_id=$3 AND p.archived_at IS NULL`,
    [policy.geoProjectId, project.userId, project.id])).rows[0];
    if (!row || row.owner_created_at !== policy.ownerCreatedAt || row.project_created_at !== policy.projectCreatedAt) throw missing();
    const owner = await this.accounts.userById(project.userId);
    const current = await this.accounts.requireProject(owner, project.id);
    return { geo: {id:policy.geoProjectId,userId:project.userId,projectId:project.id}, project:current,
      principal:{kind:'geo',actorId:project.userId,ownerId:project.userId,controlProjectId:project.id,geoProjectId:policy.geoProjectId,
        actorCreatedAt:row.owner_created_at,ownerCreatedAt:row.owner_created_at,projectCreatedAt:row.project_created_at,
        geoCreatedAt:row.geo_created_at,membershipEpoch:null} };
  }

  /** One lazy canonical ledger read for one server-owned operation. The
   * opaque token is never accepted from a request and expires on return. */
  async withRunSnapshot(identity, operation) {
    const token = Object.freeze({});
    this.#runSnapshots.set(token, { base: canonicalJson(this.base(identity)), identity, loaded: null });
    try { return await operation(token); }
    finally { this.#runSnapshots.delete(token); }
  }

  #readRunSnapshot(identity, token) {
    const snapshot = this.#runSnapshots.get(token);
    if (!snapshot || snapshot.base !== canonicalJson(this.base(identity))) throw changed();
    return snapshot;
  }

  async #loadRunSnapshot(identity, token) {
    const snapshot = this.#readRunSnapshot(identity, token);
    if (!snapshot.loaded) snapshot.loaded = Promise.resolve().then(async () => {
      const rows = await this.runs(snapshot.identity.geo);
      if (!Array.isArray(rows)) throw missing();
      const runs = Object.freeze([...rows]), bySession = new Map();
      for (const run of runs) {
        const group = bySession.get(run.sessionId) ?? [];
        group.push(run); bySession.set(run.sessionId, group);
      }
      return { runs, bySession };
    });
    const loaded = await snapshot.loaded;
    this.#readRunSnapshot(identity, token);
    return loaded;
  }

  async runsInSnapshot(identity, token) { return (await this.#loadRunSnapshot(identity, token)).runs; }

  /** The existing bound-GPC receipts are sufficient only together with the
   * exact canonical run request ids. Staged or caller-chosen contexts are not. */
  async retainedContext(identity, sessionId, snapshot = null) {
    const runs = snapshot === null ? await this.runs(identity.geo) : (await this.#loadRunSnapshot(identity, snapshot)).bySession.get(sessionId) ?? [];
    for (const run of runs) if (run.sessionId === sessionId && Array.isArray(run.kernelRequestIds)) {
      const candidates = []; let cursor = null;
      for (let page = 0; page < 100; page += 1) {
        const found = await this.documents.list(identity.geo.userId,'geo-plan-context',{projectId:identity.geo.projectId,limit:100,cursor,
          filter:{recordType:'geo-plan-context',geoId:identity.geo.id,state:'bound',sessionId}});
        candidates.push(...found.items.filter(row=>run.kernelRequestIds.includes(row.payload.requestId) && row.payload.basisDigest===geoPlanDigest(row.payload.basis)));
        cursor=found.nextCursor;if(!cursor)break;if(page===99)throw missing();
      }
      if(candidates.length!==1)continue;
      const context=candidates[0], p=context.payload;
      const request=await this.documents.get(identity.geo.userId,'geo-plan-context',`gpcbind_${geoPlanDigest([p.actorId,identity.geo.projectId,p.requestId])}`);
      const handling=p.mode==='signal'?await this.documents.get(identity.geo.userId,'geo-plan-context',`gpcsignal_${geoPlanDigest([identity.geo.id,p.basis.handlingKey])}`):null;
      let valid=true;
      for(const [receipt,type] of [[request,'geo-plan-request'],[handling,'geo-signal-request']]) {
        if(type==='geo-signal-request'&&p.mode!=='signal')continue;
        if(!receipt||receipt.projectId!==identity.geo.projectId||receipt.payload.recordType!==type||receipt.payload.geoId!==identity.geo.id
          ||receipt.payload.referenceId!==context.id||receipt.payload.actorId!==p.actorId||receipt.payload.sessionId!==sessionId
          ||receipt.payload.requestId!==p.requestId||receipt.payload.requestDigest!==p.requestDigest)valid=false;
      }
      if(valid)return context;
    }
    return null;
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

  /**
   * The project's conversation as a read sees it: the primary; else, for the owner, the conversation the project was worked in, which
   * becomes the primary under the open's lock when the running kernel still lists it. A read never starts a runtime or begins a
   * conversation: null when there is nothing it can prove, and the next open settles it.
   */
  async readPrimary(user, geoId) {
    const identity = await this.identity(user, geoId, { ability: 'read' });
    const primary = await this.primary(identity);
    if (primary || !this.#owns(user, identity) || !this.adoptSession || !this.sessionListed) return primary;
    const kept = await this.adoptSession(identity);
    if (!sessionIdValid(kept) || !await this.sessionListed(identity.project, kept)) return null;
    return this.#registerUnderLock(user, geoId, kept, 'read');
  }

  #owns(user, identity) { return String(user.id) === identity.geo.userId; }

  /** Whether the kernel has the session, starting the runtime as an open does. Only a read inventory that lacks it says no. */
  async #present(project, sessionId) {
    try { await this.ensureSession(project, sessionId); return true; }
    catch (error) { if (absent(error)) return false; throw error; }
  }

  /** One in-process attempt per key: concurrent opens of one replica share it instead of each beginning a conversation. */
  #once(key, attempt) {
    let pending = this.primaryCreates.get(key);
    if (!pending) {
      pending = attempt();
      this.primaryCreates.set(key, pending);
      void pending.finally(() => { if (this.primaryCreates.get(key) === pending) this.primaryCreates.delete(key); }).catch(() => {});
    }
    return pending;
  }

  /** Runtime preparation performs network and filesystem work and must not hold the product transaction (including a pool of one
   * connection), so a candidate is found first and only registered here. Concurrent replicas may have found another: only the
   * canonical winner is associated, and a losing candidate never becomes visible through the delegated frame. */
  #registerUnderLock(user, geoId, sessionId, ability) {
    return this.store.transaction(client => this.store.database.withTransactionClient(client, async () => {
      await client.query(PRIMARY_LOCK, [geoId]);
      const fresh = await this.identity(user, geoId, { client, ability });
      return await this.primary(fresh) ?? this.registerPrimary(fresh.geo, sessionId);
    }));
  }

  /** A project without a registered primary: the owner's kept conversation while the kernel still has it, else a new one. */
  #initializePrimary(user, geoId, identity) {
    return this.#once(this.primaryKey(identity), async () => {
      const current = await this.identity(user, geoId);
      const existing = await this.primary(current);
      if (existing) return existing;
      const kept = this.#owns(user, current) && this.adoptSession ? await this.adoptSession(current) : null;
      const candidate = sessionIdValid(kept) && await this.#present(current.project, kept) ? kept : (await this.createSession(current.project)).id;
      return this.#registerUnderLock(user, geoId, candidate, 'run');
    });
  }

  /**
   * The owner's replacement of a primary the kernel's inventory no longer lists (a conversation removed upstream, or one adopted before
   * adoption was checked): a new conversation, swapped in under the lock only while the pointer still names the missing one, so
   * concurrent repairs agree and a replaced pointer is never replaced again by a stale caller. A member cannot do this; their open
   * keeps answering that the conversation is unavailable until the owner opens it.
   */
  #replacePrimary(user, geoId, identity, lost) {
    return this.#once(`${this.primaryKey(identity)}:${lost}`, async () => {
      const created = (await this.createSession(identity.project)).id;
      if (!sessionIdValid(created)) throw missing();
      return this.store.transaction(client => this.store.database.withTransactionClient(client, async () => {
        await client.query(PRIMARY_LOCK, [geoId]);
        const fresh = await this.identity(user, geoId, { client });
        if (!this.#owns(user, fresh)) throw changed();
        const current = await this.primary(fresh);
        if (current !== lost) return current;
        const owner = fresh.geo.userId, projectId = fresh.geo.projectId, base = this.base(fresh);
        const pointerId = this.primaryKey(fresh), pointer = await this.documents.get(owner, 'geo-plan-context', pointerId);
        const id = this.sessionKey(fresh, created);
        await this.documents.put(owner, 'geo-plan-context', id, { recordType: 'geo-native-session', base, sessionId: created, association: 'primary' },
          { expectedRevision: 0, projectId, transactionClient: client });
        await this.documents.put(owner, 'geo-plan-context', pointerId, { recordType: 'geo-native-primary', base, sessionId: created, referenceId: id, replaces: lost },
          { expectedRevision: pointer.revision, projectId, transactionClient: client });
        return created;
      }));
    });
  }

  async primary(identity, snapshot = null) {
    const pointer = await this.documents.get(identity.geo.userId, 'geo-plan-context', this.primaryKey(identity));
    if (!pointer) return null;
    if (pointer.projectId !== identity.geo.projectId || pointer.payload.recordType !== 'geo-native-primary'
      || pointer.payload.referenceId !== this.sessionKey(identity, pointer.payload.sessionId)
      || canonicalJson(pointer.payload.base) !== canonicalJson(this.base(identity))) throw missing();
    return this.proveSession(identity, pointer.payload.sessionId, snapshot);
  }

  async proveSession(identity, sessionId, snapshot = null) {
    if (snapshot !== null) this.#readRunSnapshot(identity, snapshot);
    if (!sessionIdValid(sessionId)) throw missing();
    const saved = await this.documents.get(identity.geo.userId, 'geo-plan-context', this.sessionKey(identity, sessionId));
    if (saved) {
      if (saved.projectId !== identity.geo.projectId || saved.payload.recordType !== 'geo-native-session' || saved.payload.sessionId !== sessionId
        || canonicalJson(saved.payload.base) !== canonicalJson(this.base(identity))) throw missing();
      return sessionId;
    }
    if (await this.retainedContext(identity, sessionId, snapshot)) return sessionId;
    throw missing();
  }

  async proofReferences(identity, sessionId, snapshot = null) {
    await this.proveSession(identity, sessionId, snapshot);
    const saved = await this.documents.get(identity.geo.userId, 'geo-plan-context', this.sessionKey(identity, sessionId));
    if (saved) return [saved.id];
    const context = await this.retainedContext(identity, sessionId, snapshot);
    if (context) return [context.id];
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
    const identity = await this.identity(user, geoId);
    let sessionId, ensured = false;
    if (target.kind === 'primary' && Object.keys(target).length === 1) {
      sessionId = await this.primary(identity) ?? await this.#initializePrimary(user, geoId, identity);
      if (this.#owns(user, identity)) {
        if (await this.#present(identity.project, sessionId)) ensured = true;
        else sessionId = await this.#replacePrimary(user, geoId, identity, sessionId);
      }
    } else if (target.kind === 'session' && Object.keys(target).length === 2) sessionId = await this.proveSession(identity, target.sessionId);
    else if (target.kind === 'context' && Object.keys(target).length === 2 && /^gpc_[a-f0-9]{64}$/.test(target.referenceId ?? '')) {
      const context = await this.documents.get(identity.geo.userId, 'geo-plan-context', target.referenceId);
      if (context?.projectId !== identity.geo.projectId || context.payload.geoId !== geoId || context.payload.state !== 'bound') throw missing();
      sessionId = await this.proveSession(identity, context.payload.sessionId);
    } else throw missing();
    if (!ensured) await this.ensureSession(identity.project, sessionId);
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
