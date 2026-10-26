import { canonicalJson } from '@evimed/domain';
import { HttpError } from './security.mjs';

const changed = () => new HttpError(409, 'geo_native_input_conflict', 'The selected article context changed.');

/** Coordinates existing selectors before the native journal freezes its input.
 * authorizeRequest(user, ownerProject, exactRequest) must resolve the current
 * GeoNativeAuthority identity for the exact retained root with run/edit access.
 * It must reject a different owner/control project. This callback is server
 * configuration; nothing on a browser request can supply or inherit it. */
export class GeoNativeSelections {
  #prepared = new WeakMap();
  constructor({ contexts, revisions, articles, authorizeRequest }) {
    this.contexts = contexts; this.revisions = revisions; this.articles = articles; this.authorizeRequest = authorizeRequest;
  }
  async prepare(user, project, request) {
    const identity=await this.revisions.authorizeNativeRequest(user, project, request, this.authorizeRequest);
    const original = canonicalJson(request);
    const principal=identity.principal;
    const existing=await this.articles.documents.list(project.userId,'geo-plan-context',{projectId:project.id,limit:1,fields:{recordType:true},
      filter:{recordType:'geo-native-input',rootSessionId:request.sessionId,native:{requestId:request.requestId},
        principal:{ownerCreatedAt:principal.ownerCreatedAt,projectCreatedAt:principal.projectCreatedAt,geoCreatedAt:principal.geoCreatedAt}}});
    if(existing.items.length){
      // This is only a replay hint. The journal still checks the real actor,
      // original request and full current authority before returning its saved
      // disposition. A disappeared or different receipt cannot create a new
      // candidate through this shortcut.
      this.#prepared.set(request,{original,replayOnly:true});
      return;
    }
    let plan = null;
    if (request.geoPlanContext !== undefined) {
      await this.contexts.prepare(user, project, request);
      plan = await this.contexts.preview(user, project, request);
    }
    const modifying = (plan?.actions ?? []).filter(action => action.work?.mode === 'modify_existing');
    const selection = modifying.length === 1 ? { versionId: modifying[0].work.resultVersionId, digest: modifying[0].work.digest,
      target: { kind: 'geo-article', geoProjectId: plan.geoId, articleId: modifying[0].work.articleId }, expectedHeadVersionId: modifying[0].work.resultVersionId } : request.geoPlanContext === undefined ? undefined : null;
    const reference = await this.articles.prepare(user, project, request, selection);
    this.#prepared.set(request, { original, reference, selection });
    // Compare authorized metadata here, before the journal resolves replays.
    // Rendering preserved bytes belongs to preview(), which the journal calls
    // only after ruling out an existing exact submission and its disposition.
    // A selected modification may never silently redirect an explicit result.
    if (reference && selection) {
      const row = await this.articles.validatePrepared(user, project, request);
      if (row.payload.versionId !== selection.versionId || row.payload.digest !== selection.digest
        || canonicalJson(row.payload.target) !== canonicalJson(selection.target)) throw changed();
    }
  }
  async preview(user, project, request) {
    const prepared = this.#prepared.get(request);
    if (!prepared || prepared.replayOnly || canonicalJson(request) !== prepared.original) throw changed();
    const parts = [], bindings = [];
    if (request.geoPlanContext !== undefined) {
      const plan = await this.contexts.preview(user, project, request);
      parts.push(plan.part); bindings.push(plan.binding);
    }
    if (prepared.reference) {
      await this.articles.validatePrepared(user, project, request);
      const revision = await this.revisions.preview(user.id, project, request);
      parts.push(revision.part); bindings.push(revision.binding);
    }
    return { parts, bindings };
  }
  async bindResult(user, project, request) {
    if (!this.#prepared.has(request) || this.#prepared.get(request).replayOnly) throw changed();
    return this.articles.bindPrepared(user, project, request);
  }
}
