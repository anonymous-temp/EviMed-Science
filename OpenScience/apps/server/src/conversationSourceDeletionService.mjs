import { lineFingerprint } from './nativeMemoryOverlay.mjs';
import { randomUUID } from 'node:crypto';
import { HttpError, safeId } from './security.mjs';

const unavailable = () => new HttpError(404, 'runtime_session_not_found', 'Conversation not found.');
const sessionFields = new Set(['sessionId', 'rootSessionId', 'sourceSessionId', 'targetSessionId', 'parentSessionId', 'childSessionId', 'agentId']);

/** Native RPC identity fields, including a caller-selected id on create/fork. */
export function conversationIdsInRequest(method, payload) {
  const found = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if ((sessionFields.has(key) || key === 'id' && ['session/create', 'session/fork'].includes(method)) && typeof item === 'string') found.add(item);
      else if (key === 'sessionIds' && Array.isArray(item)) item.filter(id => typeof id === 'string').forEach(id => found.add(id));
      else if (typeof item === 'object') visit(item);
    }
  };
  visit(payload); return [...found];
}

/** Remove only deleted conversation identities. A fork's parent link does not make the fork a managed child. */
export function filterDeletedConversationValue(value, deleted) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => filterDeletedConversationValue(item, deleted)).filter(item => item !== null);
  if (value.origin === 'subagent' && deleted.has(value.parentSession)) return null;
  if ([value.sessionId, value.rootSessionId, value.agentId, value.id].some(id => typeof id === 'string' && deleted.has(id))) return null;
  if (typeof value.event === 'string' && value.event.startsWith('api-session/') && Array.isArray(value.args) && (deleted.has(value.args[0]) || deleted.has(value.args[0]?.sessionId))) return null;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (['sessionIds', 'pinned', 'archived', 'pinnedSessionIds', 'archivedSessionIds'].includes(key) && Array.isArray(item)) next[key] = item.filter(id => !deleted.has(id));
    else if (['projections', 'sessions'].includes(key) && item && typeof item === 'object' && !Array.isArray(item)) next[key] = Object.fromEntries(Object.entries(item).filter(([id]) => !deleted.has(id)).map(([id, data]) => [id, filterDeletedConversationValue(data, deleted)]));
    else next[key] = filterDeletedConversationValue(item, deleted);
  }
  return next;
}

/** Durable intent precedes source cleanup. Physical removal is an idle-only maintenance operation, never a kernel RPC. */
export class ConversationSourceDeletionService {
  constructor({ ledger, runtime, resolveProject, removeHistory, removeDerived, memoryRootFor = async (_project) => null, prepareFence = async(_project,_sessionIds)=>null, contributionsFor=async(_row)=>[], nativeRootsFor=async(_project,_frozen,_identity)=>null, recordIdForUri=null, revisionSource=async(_userId,_row)=>null }) {
    this.contributionsFor=contributionsFor; this.nativeRootsFor=nativeRootsFor; this.recordIdForUri=recordIdForUri; this.revisionSource=revisionSource;
    this.memoryRootFor = memoryRootFor; this.prepareFence=prepareFence; this.knownFences=new Map();this.epochComparisons=new Map();
    this.ledger = ledger; this.runtime = runtime; this.resolveProject = resolveProject;
    this.removeHistory = removeHistory; this.removeDerived = removeDerived;
    this.running = null; this.timer = null; this.refreshing = new Map();
  }
  async historyFingerprints(userId) {
    const result=new Map();
    for(const row of await this.ledger.recordsForOwner(userId)) {
      for(const [uri,prints] of Object.entries(row.historyPrints??{})) {const set=result.get(uri)??new Set();for(const print of prints)set.add(print);result.set(uri,set);}
      for(const contribution of await this.contributionsFor(row)) {const set=result.get(contribution.uri)??new Set();for(const line of contribution.lines)set.add(lineFingerprint(line));result.set(contribution.uri,set);}
    }
    return result;
  }
  redactText(text,prints) { return text===null?null:String(text??'').split('\n').filter(line=>!prints.has(lineFingerprint(line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/,'')))).join('\n'); }
  async sameEpoch(left,right) {
    if(left===right)return true;const key=JSON.stringify([left,right]);
    if(!this.epochComparisons.has(key)){if(this.epochComparisons.size>=1000)this.epochComparisons.clear();this.epochComparisons.set(key,this.ledger.sameEpoch(left,right));}
    return this.epochComparisons.get(key);
  }
  async independentRevision(userId,row,fences) {
    const affected=fences.filter(fence=>Object.hasOwn(fence.historyPrints??{},row.uri));
    if(!affected.length)return false;
    const source=await this.revisionSource(userId,row);
    if(source?.projectCreatedAt) {
      let same=false;for(const fence of affected)if(fence.projectId===source.projectId&&await this.sameEpoch(fence.projectCreatedAt,source.projectCreatedAt))same=true;
      if(!same) {
        const privatePrints=new Set(affected.flatMap(fence=>fence.historyPrints?.[row.uri]??[]));
        const carriesOld=String(row.actor??'')!=='user'&&String(row.before??'').split('\n').some(line=>privatePrints.has(lineFingerprint(line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/,''))));
        if(!carriesOld)return true;
      }
    }
    if(affected.some(fence=>fence.cleanedRevisionId==null))return false;
    const watermark=affected.reduce((value,fence)=>BigInt(fence.cleanedRevisionId)>value?BigInt(fence.cleanedRevisionId):value,0n);
    if(!/^\d+$/.test(String(row.id))||BigInt(row.id)<=watermark)return false;
    return !source||!affected.some(fence=>fence.projectId===source.projectId&&fence.sessionIds.includes(source.sessionId));
  }
  async redactRevisions(userId,rows) {
    const byUri=await this.historyFingerprints(userId),hidden=new Set(await this.ledger.hiddenMemoryUris(userId)),fences=await this.ledger.recordsForOwner(userId);
    const quarantined=fences.flatMap(row=>[...(row.lineageRoots??[]),...(row.nativeRoots??[]).filter(root=>hidden.has(root))]);
    return Promise.all(rows.map(async row=>{if(quarantined.some(root=>row.uri===root||row.uri.startsWith(`${root}/`)))return {...row,before:null,after:null,sourceDeletedText:true};
      const prints=byUri.get(row.uri);if(!prints?.size||await this.independentRevision(userId,row,fences))return row;
      const before=this.redactText(row.before,prints),after=this.redactText(row.after,prints);
      return {...row,before,after,...(before!==row.before||after!==row.after||String(row.reason).includes('[source-deleted]')?{sourceDeletedText:true}:{})};}));
  }
  async redactRecords(userId,rows) {
    const byUri=await this.historyFingerprints(userId),fences=await this.ledger.recordsForOwner(userId);
    return Promise.all(rows.map(async row=>{const prints=byUri.get(row.uri);return {...row,revisions:await Promise.all((row.revisions??[]).map(async revision=>{
      const {sourceRevisionId,sourceEngineSession,sourceArchiveUri,sourceProjectId,sourceProjectCreatedAt,sourceActor,...shown}=revision;
      const independent=await this.independentRevision(userId,{id:sourceRevisionId,uri:row.uri,engineSession:sourceEngineSession,archiveUri:sourceArchiveUri,projectId:sourceProjectId,sourceProjectId,sourceProjectCreatedAt,actor:sourceActor,before:shown.value},fences);
      return !prints?.size||independent?shown:{...shown,value:this.redactText(revision.value,prints)};
    }))};}));
  }
  scopeKey(project) { const owner=project.sourceOwnerCreatedAt??project.accountCreatedAt,created=project.sourceProjectCreatedAt;
    return typeof owner==='string'&&typeof created==='string'?JSON.stringify([project.userId,project.id,owner,created]):null; }
  knownDeleted(project,sessionId) { const key=this.scopeKey(project);return key!==null&&this.knownFences.get(key)?.has(sessionId)===true; }
  rememberFence(project,sessionIds) { const key=this.scopeKey(project);if(key===null)return;const known=this.knownFences.get(key)??new Set();for(const id of sessionIds)known.add(id);this.knownFences.set(key,known); }
  async assertSnapshotSourcesAvailable(userId,entries) {
    if(!entries?.some(entry=>entry.nativeSource))return;
    const uris=await this.ledger.quarantinedUris(userId);if(!uris.length)return;
    if(!this.recordIdForUri)throw new HttpError(409,'memory_source_lineage_unverified','Native source lineage is still being resolved.');
    const ids=uris.map(this.recordIdForUri);
    if(entries.some(entry=>ids.some(id=>entry.id===id||String(entry.id).startsWith(`${id}_`))))throw new HttpError(409,'memory_source_lineage_unverified','Native source lineage is still being resolved.');
  }
  async assertAccountExportSafe(userId) { if((await this.ledger.recordsForOwner(userId,{pendingOnly:true})).length)throw new HttpError(409,'source_deletion_pending','A source conversation is still being removed.'); }
  async withProjectExport(project,operation) { return this.ledger.withProjectDisclosure(project,async()=>{
    if(await this.ledger.pendingCleanupForProject(project))throw new HttpError(409,'source_deletion_pending','A source conversation is still being removed.');
    return operation();
  }); }
  async assertNativeExportSafe(userId) { if((await this.ledger.recordsForOwner(userId,{pendingOnly:true})).length)throw new HttpError(409,'memory_source_cleanup_busy','A source deletion is still being cleaned up.'); }
  version(userId) { return this.ledger.version(userId); }
  hiddenMemoryUris(userId) { return this.ledger.hiddenMemoryUris(userId); }
  async refreshClosure(project) {
    if (!this.ledger.pendingForProject) return;
    const rows=await this.ledger.pendingForProject(project);if(!rows.length)return;
    const key=JSON.stringify([project.userId,project.id,rows[0].accountCreatedAt,rows[0].projectCreatedAt]);
    if (this.refreshing.has(key)) return this.refreshing.get(key);
    const task=(async()=>{
      for (const row of rows) {
        const current=await this.runtime.captureConversationSource({...project,sourceOwnerCreatedAt:row.accountCreatedAt,sourceProjectCreatedAt:row.projectCreatedAt},row.rootSessionId);
        const identity=value=>JSON.stringify([value?.id,value?.createdAt,value?.cwd,value?.isSeeded,value?.absent===true]);
        if (identity(current.root)!==identity(row.frozen.root)) throw new HttpError(503,'source_deletion_identity_changed','The deleted source identity cannot be verified.');
        const ids=await this.ledger.extendSessions(row,current.sessions.map(session=>session.id));this.rememberFence({...project,sourceOwnerCreatedAt:row.accountCreatedAt,sourceProjectCreatedAt:row.projectCreatedAt},ids);
      }
    })();
    this.refreshing.set(key,task);
    try { await task; } finally { if(this.refreshing.get(key)===task)this.refreshing.delete(key); }
  }
  async assertAvailable(project,sessionId) { if(this.knownDeleted(project,sessionId))throw unavailable();
    if(await this.ledger.get(project,sessionId))throw unavailable();await this.refreshClosure(project);if(await this.ledger.get(project,sessionId))throw unavailable(); }
  async authorize(project, method, payload) {
    const ids=conversationIdsInRequest(method,payload);
    if(ids.some(id=>this.knownDeleted(project,id)))throw unavailable();
    for(const id of ids)if(await this.ledger.get(project,id))throw unavailable();
    await this.refreshClosure(project);
    for (const id of ids) if(await this.ledger.get(project,id)) throw unavailable();
  }
  async projectValue(project, method, payload, value) {
    if(method==='$events') {
      const session=value?.agentId ?? (value?.type==='emit'&&String(value.event).startsWith('api-session/') ? value.args?.[0]?.sessionId??value.args?.[0] : null);
      if(typeof session==='string'&&(this.knownDeleted(project,session)||await this.ledger.get(project,session)))return {forward:false};
    }
    await this.authorize(project, method, payload);
    const deleted = new Set(await this.ledger.deletedIds(project));
    const hidden = item => deleted.has(item?.sessionId ?? item?.id) || item?.origin === 'subagent' && deleted.has(item.parentSession ?? item.parentSessionId);
    if (method === 'session/list') {
      if (Array.isArray(value)) return { forward: true, value: value.filter(item => !hidden(item)) };
      if (Array.isArray(value?.items)) return { forward: true, value: { ...value, items: value.items.filter(item => !hidden(item)) } };
    }
    if (method === 'session/control') {
      if (value?.type === 'baseline' && value.value?.projections && typeof value.value.projections === 'object') {
        return { forward: true, value: { ...value, value: { ...value.value, projections: Object.fromEntries(Object.entries(value.value.projections).filter(([id]) => !deleted.has(id))) } } };
      }
      return { forward: !hidden(value), value };
    }
    if (method === '$events') {
      const source = typeof value?.agentId === 'string' ? value.agentId
        : value?.type === 'emit' && String(value.event).startsWith('api-session/') ? value.args?.[0]?.sessionId ?? value.args?.[0] : null;
      return { forward: !deleted.has(source), value };
    }
    // A bound transcript/projection belongs to the already checked request. Its literal content is never interpreted as authority.
    if (method.startsWith('session/') && conversationIdsInRequest(method, payload).length) return { forward: !hidden(value), value };
    const filtered = filterDeletedConversationValue(value, deleted);
    return { forward: filtered !== null, value: filtered };
  }
  async request(project, rawSessionId) {
    const sessionId = safeId(rawSessionId, 'conversation id');
    const existing = await this.ledger.get(project, sessionId);
    if (existing) return this.publicStatus(existing);
    const identity = await this.ledger.scope(project);
    const frozen = await this.runtime.captureConversationSource({ ...project, sourceProjectCreatedAt: identity.projectCreatedAt, sourceOwnerCreatedAt: identity.accountCreatedAt }, sessionId);
    if (!frozen?.root || frozen.root.id !== sessionId || !Array.isArray(frozen.sessions) || !frozen.sessions.some(row => row.id === sessionId)) throw unavailable();
    const currentRoot=await this.memoryRootFor(project);
    const nativeRoots=await this.nativeRootsFor(project,frozen,identity)??(currentRoot?[currentRoot]:[]);
    const sessionIds=[...new Set(frozen.sessions.map(session=>session.id))];
    const discloseFence=await this.prepareFence(project,sessionIds);
    const row = await this.ledger.put({ id: randomUUID(), userId: project.userId, projectId: project.id, ...identity,
      rootSessionId: sessionId, sessionIds: [...new Set(frozen.sessions.map(session => session.id))], frozen,
      memoryUserRoot: nativeRoots[0]??currentRoot,nativeRoots, cleanup: 'pending', sourceRemoved: false, createdAt: new Date().toISOString(), reason: null });
    this.rememberFence({...project,sourceOwnerCreatedAt:identity.accountCreatedAt,sourceProjectCreatedAt:identity.projectCreatedAt},row.sessionIds);
    discloseFence?.();
    // An index failure cannot erase the already durable source fence. The worker repeats it.
    try { await this.removeHistory(project, row); } catch { /* Cleanup remains owed. */ }
    return this.publicStatus(row);
  }
  publicStatus(row) { return { id: row.id, sessionId: row.rootSessionId, sourceRemoved: row.sourceRemoved === true, cleanup: row.cleanup, reason: row.reason ?? null }; }
  async status(project, sessionId) { const row = await this.ledger.get(project, sessionId); if (!row) throw unavailable(); return this.publicStatus(row); }
  async drain() {
    if (this.running) return this.running;
    this.running = this.drainOnce();
    try { return await this.running; } finally { this.running = null; }
  }
  async drainOnce() {
    for (const row of await this.ledger.pending()) {
      try {
        const resolved = await this.resolveProject(row);
        const project = { ...resolved, sourceProjectCreatedAt: row.projectCreatedAt, sourceOwnerCreatedAt: row.accountCreatedAt };
        await this.ledger.exclusive(project, async () => {
          const guard = () => this.ledger.assertIdentity(row);
          await guard(); await this.removeHistory(project, row);
          const result = row.sourceRemoved === true ? { sourceRemoved: true } : await this.runtime.purgeConversationSource(project, row.frozen, guard);
          if (result?.sourceRemoved !== true) { await this.ledger.update(row, { cleanup: 'pending', reason: result?.reason ?? 'runtime_busy', backoff: true }); return; }
          if (Array.isArray(result.removedSessionIds) && this.ledger.extendSessions) {
            row.sessionIds = await this.ledger.extendSessions(row, result.removedSessionIds);
          }
          await guard();
          if (!row.sourceRemoved) { await this.ledger.update(row,{sourceRemoved:true,cleanup:'pending',reason:'derived_cleanup_pending'}); row.sourceRemoved=true; }
          await this.removeDerived(project, row);
          await this.ledger.update(row, { sourceRemoved: true, cleanup: 'complete', reason: null });
        });
      } catch(error) { await this.ledger.update(row, { cleanup: 'pending', backoff: true, reason: error?.code==='memory_source_lineage_unverified'?'native_lineage_unverified':['memory_source_cleanup_busy','memory_source_body_changed'].includes(error?.code)?'account_memory_busy':'cleanup_unavailable' }); }
    }
  }
  start() { if (this.timer) return; this.timer = setInterval(() => { void this.drain().catch(() => {}); }, 5000); this.timer.unref(); }
  async stop() { clearInterval(this.timer); this.timer = null; await this.running; }
}
