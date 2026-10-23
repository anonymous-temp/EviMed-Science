import { createHash } from "node:crypto";
import { canonicalJson } from "./geoStore.mjs";
import { readGeoSelection, withGeoReadTransaction, geoReadScopeInput } from "./geoReadScope.mjs";
import { HttpError } from "./security.mjs";

export const geoPlanDigest = value => createHash("sha256").update(canonicalJson(value)).digest("hex");
const canonicalScope = scope => Object.fromEntries(Object.entries(scope).filter(([key]) => key !== "selectionRef"));
export function geoPlanCanonicalScope(scope, questions = []) {
  const versions = [...new Set(questions.map(question => Number(question.set_version ?? question.setVersion)).filter(Number.isFinite))];
  return { ...canonicalScope(scope), questionVersion: scope.questionVersion ?? (versions.length === 1 ? versions[0] : null) };
}
export const geoPlanScopeKey = (scope, focus = {}) => `gps_${geoPlanDigest({ scope: canonicalScope(scope), sourceId: focus.sourceId ?? null, url: focus.url ?? null })}`;
const fail = (code, message, status = 409) => new HttpError(status, code, message);
const sourceDigest = source => geoPlanDigest(Object.fromEntries(["id", "domain", "name", "kind", "layer", "icpMatches", "newsIndexed", "medicalVertical", "impostor", "checkedAt", "checkEvidence", "blacklistReason"].map(key => [key, source[key] ?? null])));
const claimSummary = claim => ({ id: claim.id, claimKey: claim.claimKey, version: claim.version, digest: geoPlanDigest({ statement: claim.statement, quote: claim.quote,
  sourceRef: claim.sourceRef, population: claim.population, elements: claim.elements, inLabel: claim.inLabel, validUntil: claim.validUntil, status: claim.status }), status: claim.status });

/** Freeze authorized member references and typed readings in one database snapshot. No source body is copied. */
export async function freezeGeoPlanBasis(store, project, input = {}, focus = {}) {
  return withGeoReadTransaction(store, async () => {
    const selected = await readGeoSelection(store, project, geoReadScopeInput(input));
    const ids = [...new Set(selected.questions.map(question => question.group_id))];
    const groups = (await store.query(`SELECT id,set_version,name,pool FROM evimed_geo.question_groups WHERE geo_project_id=$1 AND id=ANY($2::text[]) ORDER BY id`, [project.id, ids])).rows;
    // The native task's evidence read is project-wide; freeze that actual evidence catalogue as its dependency set.
    const claims = await store.listClaims(project.id);
    const sources = await store.listSources(project.id);
    const citedUrls = new Set(selected.rows.flatMap(row => (row.citations ?? []).map(citation => typeof citation === "string" ? citation : citation.url).filter(Boolean)));
    const urls = [...new Set([...citedUrls, ...claims.map(claim => claim.sourceRef).filter(ref => /^https?:\/\//.test(ref ?? ""))])].sort();
    const refs = urls.map(url => {
      let domain = null; try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch { /* invalid historic citation remains explicitly unknown */ }
      const source = sources.find(item => item.domain === domain);
      return { id: source?.id ?? null, url, origin: citedUrls.has(url) ? "citation" : "claim", digest: null, availability: "unknown", metadataDigest: source ? sourceDigest(source) : null };
    });
    const prices = (await store.query(`SELECT resource_id,domain,name,price_cny,synced_at FROM evimed_geo.media WHERE domain=ANY($1::text[]) AND price_cny IS NOT NULL AND available=true`,
      [sources.filter(source => refs.some(ref => ref.id === source.id)).map(source => source.domain)])).rows;
    const priceReferences = prices.map(price => ({ kind: "source_price", id: String(price.resource_id), domain:price.domain, name:price.name, digest: geoPlanDigest({ id:price.resource_id, domain:price.domain, price:price.price_cny }), currency: "CNY", price: Number(price.price_cny), observedAt: price.synced_at }));
    const targets = await store.latestTargets(project.id);
    const basis = { schemaVersion: 1, capturedAt: new Date().toISOString(), selection: selected.questions.length <= 1000 ? selected.selection : { ...selected.selection, questionIds: undefined, questionIdsReference: selected.selection.reference },
      scope: geoPlanCanonicalScope(selected.scope, selected.questions), questionSets: [...new Set(selected.questions.map(q => Number(q.set_version)))].sort().map(version => ({ version,
        digest: geoPlanDigest(selected.questions.filter(q => Number(q.set_version) === version)) })),
      groups: groups.map(group => ({ id: group.id, setVersion: Number(group.set_version), name: group.name, pool: group.pool })),
      observations: { memberDigest: selected.selection.memberDigest, snapshotIds: selected.rows.length <= 1000 ? selected.rows.map(row => row.snapshotId).sort() : [], snapshotCount: selected.rows.length, memberReference: selected.selection.reference, snapshotIdsAvailable: selected.rows.length <= 1000 },
      claims: claims.map(claimSummary), sources: refs, priceReferences, focus: { sourceId: focus.sourceId ?? null, url: focus.url ?? null, errorIds: focus.errorIds ?? [] },
      targets: targets ?? { version: null, rows: [] }, readings: { baseline: null, selected: { cells: selected.computed.cells.filter(cell => !cell.variant && !cell.rival && !cell.arm).map(cell => ({
        ...Object.fromEntries(["metricId", "scope", "pool", "engine", "groupId", "arm", "variant", "rival", "numerator", "denominator", "value", "ciLow", "ciHigh", "ci_low", "ci_high", "status", "dataType", "data_type", "reason", "methodVersion"].filter(key => cell[key] !== undefined).map(key => [key, cell[key]])),
        memberReference: selected.selection.reference, memberCount: cell.members?.total ?? null, memberDigest: cell.members?.digest ?? null })), counts: selected.selection.counts,
        rounds: selected.rounds.map(round => ({ id: round.id, date: round.sample_date ?? null, kind: round.kind })) } } };
    if (Buffer.byteLength(JSON.stringify(basis)) > 200_000) throw fail("geo_plan_basis_too_large", "Narrow the selected groups, sources or dates before planning.", 422);
    return { selected, basis };
  });
}

/** Revalidate dependencies without rewriting historical plans or replacing their measured cells. */
export async function geoPlanFreshness(store, project, basis, viewingScope = null, viewingFocus = null) {
  if (!basis) return { status: "unknown", reasons: ["basis_unavailable"] };
  const reasons = [];
  try {
    const current = await freezeGeoPlanBasis(store, project, basis.scope, basis.focus);
    if (current.basis.selection.dataRevision !== basis.selection.dataRevision) reasons.push("selection_changed");
    if (canonicalJson(current.basis.questionSets) !== canonicalJson(basis.questionSets)) reasons.push("question_set_changed");
    const claims = await store.listClaims(project.id);
    if (basis.claims.some(old => { const now = claims.find(item => item.id === old.id) ?? claims.find(item => item.claimKey === old.claimKey); return !now || claimSummary(now).digest !== old.digest; })) reasons.push("claim_changed");
    const sources = await store.listSources(project.id);
    if (basis.sources.some(old => old.id && old.metadataDigest && (!sources.some(item => item.id === old.id) || sourceDigest(sources.find(item => item.id === old.id)) !== old.metadataDigest))) reasons.push("source_changed");
    if (canonicalJson(current.basis.priceReferences.map(ref => [ref.id,ref.digest])) !== canonicalJson((basis.priceReferences ?? []).map(ref => [ref.id,ref.digest]))) reasons.push("source_changed");
    if (current.basis.targets.version !== basis.targets.version) reasons.push("targets_changed");
    if (viewingFocus && (viewingFocus.sourceId != null && viewingFocus.sourceId !== basis.focus.sourceId || viewingFocus.url != null && viewingFocus.url !== basis.focus.url)) reasons.push("view_scope_differs");
    if (viewingScope && canonicalJson(canonicalScope(viewingScope)) !== canonicalJson(basis.scope)) reasons.push("view_scope_differs");
    return { status: reasons.length ? "needs_update" : basis.sources.some(source => !source.digest) ? "unknown" : "current", reasons: reasons.length ? [...new Set(reasons)] : basis.sources.some(source => !source.digest) ? ["basis_unavailable"] : [] };
  } catch { return { status: "unknown", reasons: ["basis_unavailable"] }; }
}

/** Thin durable request input reference over the existing product ledger. */
export class GeoPlanContext {
  constructor({ documents, store, service, authorizeSession, runs, articleResults = null }) {
    this.documents = documents; this.store = store; this.service = service; this.authorizeSession = authorizeSession; this.runs = runs; this.articleResults = articleResults;
  }
  async resolve(user, project, referenceId) {
    if (!/^gpc_[a-f0-9]{64}$/.test(referenceId ?? "")) throw fail("geo_plan_context_invalid", "Refresh the selected plan.", 400);
    const row = await this.documents.get(project.userId, "geo-plan-context", referenceId);
    if (!row || row.projectId !== project.projectId || row.payload.geoId !== project.id || row.payload.actorId !== user.id) throw fail("geo_plan_context_not_found", "The selected plan is unavailable.", 404);
    return row;
  }
  async stage(user, geoId, body) {
    const project = await this.service.requireProject(user, geoId, "edit");
    const allowed = ["requestKey", "sessionId", "mode", "selectionRef", "strategyVersion", "sourceId", "url", "groupIds", "errorIds", "actionKeys"];
    if (!body || Object.keys(body).some(key => !allowed.includes(key)) || !/^[A-Za-z0-9_-]{1,160}$/.test(body.requestKey ?? "")
      || !/^[A-Za-z0-9_-]{1,160}$/.test(body.sessionId ?? "") || !["strategy", "content"].includes(body.mode)
      || ["groupIds", "errorIds", "actionKeys"].some(key => body[key] != null && (!Array.isArray(body[key]) || body[key].length > 100 || body[key].some(value => typeof value !== "string" || value.length > 240)))
      || body.url != null && (typeof body.url !== "string" || body.url.length > 2000)) throw fail("geo_plan_context_invalid", "Invalid planning selection.", 400);
    await this.authorizeSession(user, project, body.sessionId);
    const id = `gpc_${geoPlanDigest([user.id, project.id, body.requestKey])}`, fingerprint = geoPlanDigest(body);
    const existing = await this.documents.get(project.userId, "geo-plan-context", id);
    if (existing) { if (existing.payload.fingerprint !== fingerprint) throw fail("geo_plan_context_conflict", "This request key already names another selection."); return this.publicOf(existing); }
    let basis, scopeKey, actions = [];
    if (body.mode === "content") {
      if (!Number.isSafeInteger(body.strategyVersion) || body.strategyVersion < 1 || !body.actionKeys?.length) throw fail("geo_plan_context_invalid", "Choose a plan version and its actions.", 400);
      const plan = await this.store.latestStrategy(project.id, { strategyVersion: body.strategyVersion });
      if (!plan?.basis) throw fail("geo_plan_basis_unavailable", "Refresh this plan before using it.");
      basis = plan.basis; scopeKey = plan.scopeKey;
      if (body.selectionRef && body.selectionRef !== basis.selection.reference) throw fail("geo_plan_focus_invalid", "This content task must use its plan version input.", 400);
      const view = await this.service.strategyOf(project, { strategyVersion: plan.version });
      actions = view.implementation.actions.filter(action => body.actionKeys.includes(action.key));
      if (actions.length !== new Set(body.actionKeys).size) throw fail("geo_plan_action_invalid", "Choose actions from this plan.", 400);
      for (const action of actions) if (action.work?.mode === "modify_existing") {
        const article = await this.store.getArticle(project.id, action.work.articleId);
        if (!article || article.currentResultVersionId !== action.work.resultVersionId || article.contentSha256 !== action.work.digest) throw fail("geo_article_head_changed", "Reopen the current article.");
      }
    } else {
      const frozen = await freezeGeoPlanBasis(this.store, project, body.selectionRef ? { selectionRef: body.selectionRef } : {}, body);
      basis = frozen.basis; scopeKey = geoPlanScopeKey(basis.scope, basis.focus);
    }
    if ((body.groupIds ?? []).some(groupId => !basis.groups.some(group => group.id === groupId)) || body.sourceId && !basis.sources.some(source => source.id === body.sourceId && source.origin === "citation")
      || body.url && !basis.sources.some(source => source.url === body.url && source.origin === "citation")) throw fail("geo_plan_focus_invalid", "The focus is outside this selection.", 400);
    if (body.errorIds?.length) {
      const selectedIds = basis.observations.snapshotIdsAvailable === false ? (await readGeoSelection(this.store, project, {selectionRef:basis.selection.reference})).rows.map(row => row.snapshotId) : basis.observations.snapshotIds;
      const rows = (await this.store.query(`SELECT id FROM evimed_geo.errors WHERE geo_project_id=$1 AND id=ANY($2::text[]) AND (first_snapshot_id=ANY($3::text[]) OR last_snapshot_id=ANY($3::text[]))`, [project.id, body.errorIds, selectedIds])).rows;
      if (rows.length !== new Set(body.errorIds).size) throw fail("geo_plan_focus_invalid", "The error is outside this selection.", 400);
    }
    const draft = body.mode === "strategy" ? "请根据所选问题群和信源生成或调整实施方案，保留依据与不确定性。" : "请按所选方案行动处理内容，保留依据和原稿，完成后关联成果。";
    const payload = { recordType: "geo-plan-context", id, geoId: project.id, actorId: user.id, fingerprint, sessionId: body.sessionId, mode: body.mode,
      strategyVersion: body.strategyVersion ?? null, scopeKey, basis, basisDigest: geoPlanDigest(basis), actions, groupIds: body.groupIds ?? basis.groups.map(group => group.id),
      actionKeys: body.actionKeys ?? [], draft, state: "staged", requestId: null, outputs: [] };
    try { return this.publicOf(await this.documents.put(project.userId, "geo-plan-context", id, payload, { projectId: project.projectId, expectedRevision: 0 })); }
    catch (error) { const row = await this.documents.get(project.userId, "geo-plan-context", id); if (row?.payload.fingerprint === fingerprint) return this.publicOf(row); throw error; }
  }
  publicOf(row) { return { referenceId: row.id, sessionId: row.payload.sessionId, draft: row.payload.draft }; }
  async bind(user, controlProject, request) {
    if (request.geoPlanContext === undefined) return null;
    const envelope = request.geoPlanContext;
    if (!envelope || Object.keys(envelope).length !== 1) throw fail("geo_plan_context_invalid", "Refresh the selected plan.", 400);
    const project = await this.store.projectByControlProject(controlProject.userId, controlProject.id);
    if (!project) throw fail("geo_plan_context_not_found", "The plan project is unavailable.", 404);
    await this.service.requireProject(user, project.id, "edit");
    await this.authorizeSession(user, project, request.sessionId);
    let row = await this.resolve(user, project, envelope.referenceId);
    const text = (request.content ?? []).filter(part => part?.type === "text").map(part => part.text).join("\n");
    const requestDigest = geoPlanDigest(text);
    if (row.payload.sessionId !== request.sessionId || !request.requestId || !text.startsWith(row.payload.draft)) throw fail("geo_plan_context_mismatch", "Reopen the selected plan in this conversation.");
    if (row.payload.state === "bound") {
      if (row.payload.requestId !== request.requestId || row.payload.requestDigest !== requestDigest) throw fail("geo_plan_context_consumed", "This selection belongs to another submitted request.");
    } else {
      for (const action of row.payload.actions ?? []) if (action.work?.mode === "modify_existing") {
        const article = await this.store.getArticle(project.id, action.work.articleId);
        if (!article || article.currentResultVersionId !== action.work.resultVersionId || article.contentSha256 !== action.work.digest) throw fail("geo_article_head_changed", "Reopen the current article.");
      }
      if (row.payload.mode === "strategy") await readGeoSelection(this.store, project, { selectionRef: row.payload.basis.selection.reference });
      const bindingId = `gpcbind_${geoPlanDigest([user.id,controlProject.id,request.requestId])}`;
      const binding = {recordType:"geo-plan-request",geoId:project.id,actorId:user.id,sessionId:request.sessionId,requestId:request.requestId,requestDigest,referenceId:row.id};
      try { await this.documents.put(project.userId,"geo-plan-context",bindingId,binding,{projectId:controlProject.id,expectedRevision:0}); }
      catch (error) {
        const existing = await this.documents.get(project.userId,"geo-plan-context",bindingId);
        if (!existing || existing.projectId !== controlProject.id || canonicalJson(existing.payload) !== canonicalJson(binding)) throw fail("geo_plan_context_conflict","This submitted request already names another planning input.");
        if (error?.code !== "product_revision_conflict") throw error;
      }
      try { row = await this.documents.put(project.userId, "geo-plan-context", row.id, { ...row.payload, state: "bound", requestId: request.requestId, requestDigest }, { projectId: controlProject.id, expectedRevision: row.revision }); }
      catch (error) {
        const latest = await this.resolve(user,project,envelope.referenceId);
        if (latest.payload.state !== "bound" || latest.payload.requestId !== request.requestId || latest.payload.requestDigest !== requestDigest || latest.payload.sessionId !== request.sessionId) throw error;
        row = latest;
      }
    }
    request.content.push({ type: "text", text: `\n<evimed_geo_plan_context>${JSON.stringify({ referenceId: row.id, requestId: request.requestId, ...row.payload,
      instruction: "Use this frozen input. geo_read strategy/targets accepts planContextRef. For a strategy task write deliverables/<unique-deliverable-id>/strategy.json and geo-strategy.md using the existing geo-strategy format. Scoped geo_write is unavailable because a project token cannot attest the producing request; the completed run imports the file under its actual bound context. For content use the existing geo-content article files and articles.json registration. Preserve exact group/action IDs. Do not replace the frozen basis. No purchase or publication is authorized." }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}</evimed_geo_plan_context>` });
    delete request.geoPlanContext;
    return row.payload;
  }
  async forRun(project, run, hint = null) {
    if (!run?.kernelRequestIds?.length || !run.sessionId) return null;
    let cursor = null;
    const found = [];
    do {
      const page = await this.documents.list(project.userId, "geo-plan-context", { projectId: project.projectId ?? project.id, limit: 100, cursor,
        filter: { recordType: "geo-plan-context", state: "bound", sessionId: run.sessionId } });
      const matches = page.items.filter(row => (!hint || row.id === hint) && run.kernelRequestIds.includes(row.payload.requestId));
      found.push(...matches);
      if (found.length > 1) throw fail("geo_plan_context_ambiguous", "Name the producing request's context.");
      cursor = page.nextCursor;
    } while (cursor);
    if (found.length) await this.service.requireProject({id:found[0].payload.actorId},project.id,"edit");
    return found.length ? { ...found[0].payload, referenceId: found[0].id, runId: run.id } : null;
  }
  async outputLinks(project, articleId = null, resultVersionId = null) {
    const links = [];
    let cursor = null;
    do {
      const page = await this.documents.list(project.userId, "geo-plan-context", { projectId: project.projectId, limit: 100, cursor,
        filter: { recordType: "geo-plan-context", mode: "content", state: "bound" } });
      for (const row of page.items) if (row.payload.geoId === project.id) for (const output of row.payload.outputs ?? []) {
        if ((!articleId || output.articleId === articleId) && (!resultVersionId || output.resultVersionId === resultVersionId)) links.push({ contextRef: row.id, ...output });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return links;
  }
  async activeScoped(project) {
    for (const run of await this.runs(project)) {
      if (run.status !== "running") continue;
      try { if (await this.forRun(project, run)) return true; }
      catch (error) { if (error?.code === "geo_plan_context_ambiguous") return true; throw error; }
    }
    return false;
  }
  async complete(controlProject, run) {
    const project = await this.store.projectByControlProject(controlProject.userId, controlProject.id);
    if (!project) return;
    const context = await this.forRun(project, run);
    if (!context || context.mode !== "content") return;
    const articles = await this.store.listArticles(project.id);
    const outputs = [];
    for (const article of articles) {
      const versions = await this.store.articleVersions(project.id, article.id);
      for (const version of versions) if (version.runId === run.id && (!version.requestId || version.requestId === context.requestId)) outputs.push({ articleId: article.id,
        resultVersionId: version.resultVersionId, digest: version.digest, runId: run.id, requestId: context.requestId, strategyVersion: context.strategyVersion,
        basisDigest: context.basisDigest, actionKeys: context.actionKeys, groupIds: context.groupIds });
    }
    const row = await this.documents.get(project.userId, "geo-plan-context", context.referenceId);
    if (canonicalJson(row.payload.outputs) !== canonicalJson(outputs)) {
      try { await this.documents.put(project.userId, "geo-plan-context", row.id, { ...row.payload, outputs }, { projectId: controlProject.id, expectedRevision: row.revision }); }
      catch (error) {
        const latest = await this.documents.get(project.userId,"geo-plan-context",row.id);
        if (canonicalJson(latest?.payload.outputs) !== canonicalJson(outputs)) throw error;
      }
    }
  }
}
