import { createHash } from "node:crypto";
import path from "node:path";
import { HttpError } from "./security.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const editable = file => /\.(?:md|markdown|docx)$/i.test(file ?? "");

/** Business links over shared immutable results. No byte storage or file engine lives here. */
export class GeoArticleResults {
  #prepared = new WeakMap();

  /** Phase A selects preserved bytes only. Historical business-head migration
   * is retained as metadata and occurs during the admitted bind, never here. */
  async prepare(user, project, request, selection = undefined) {
    const geo = await this.store.projectByControlProject(project.userId, project.id);
    if (!geo || !request?.sessionId) return null;
    await this.service.requireProject(user, geo.id, "edit");
    const current = await this.revisions.requestScope(user.id, project, request);
    if (current.userId !== project.userId) throw new HttpError(403, "result_project_forbidden", "The result project is unavailable.");
    if (request.evimedResultRevision !== undefined) {
      let row = await this.documents.get(project.userId, "result-revision", request.evimedResultRevision?.referenceId);
      if (!row || row.projectId !== project.id || row.payload.requestedBy !== user.id || row.payload.sessionId !== request.sessionId) throw new HttpError(409, "result_revision_stale", "Reopen the article.");
      if (!row.payload.target && row.payload.state !== "bound") {
        const article = (await this.store.listArticles(geo.id)).find(item => item.currentResultVersionId === row.payload.versionId);
        if (article) row = await this.documents.put(project.userId, "result-revision", row.id, { ...row.payload,
          target: { kind: "geo-article", geoProjectId: geo.id, articleId: article.id }, expectedHeadVersionId: article.currentResultVersionId },
        { projectId: project.id, expectedRevision: row.revision });
      }
      this.#prepared.set(request, { referenceId: row.id, geoId: geo.id });
      await this.validatePrepared(user, project, request);
      return { referenceId: row.id };
    }
    // Same-ID retries retain the original staged/bound selection even after a
    // successor advances the head. Journal replay decides whether it may send.
    let reference = await this.revisions.prepareConversation(user.id, project, request);
    if (!reference && selection !== null) {
      let selected = selection;
      if (selected === undefined) {
        const candidates = [];
        for (const article of await this.store.listArticles(geo.id)) {
          if (!editable(article.path)) continue;
          if (article.currentResultVersionId) {
            const version = await this.results.get(project.userId, project.id, article.currentResultVersionId);
            if (version.producer?.sessionId === request.sessionId) candidates.push({ version, article });
          } else if (article.runId) {
            const page = await this.results.list(project.userId, { projectId: project.id, path: article.path, runId: article.runId, limit: 100 });
            if (page.nextCursor) continue;
            const version = page.items.find(item => item.digest === article.contentSha256 && item.producer?.sessionId === request.sessionId
              && item.producer?.runId === article.runId && item.producer?.kind !== "workspace");
            if (version) candidates.push({ version, article, migration: { path: article.path, runId: article.runId, digest: article.contentSha256 } });
          }
        }
        if (!candidates.length) {
          const found = await this.results.query(project.userId, project.id, { producer: { sessionId: request.sessionId } }, { limit: 100 });
          const versions = found.items.filter(item => editable(item.path) && item.producer?.kind !== "workspace");
          const parents = new Set(versions.map(item => item.supersedesVersionId).filter(Boolean));
          const parentBytes = new Set(versions.filter(item => parents.has(item.versionId)).map(item => `${item.path}\0${item.digest}`));
          const leaves = [...new Map(versions.filter(item => !parents.has(item.versionId) && !parentBytes.has(`${item.path}\0${item.digest}`))
            .map(item => [`${item.path}\0${item.digest}`, item])).values()];
          if (leaves.length === 1 && !found.nextCursor) selected = { versionId: leaves[0].versionId, digest: leaves[0].digest, target: null, expectedHeadVersionId: null };
        } else if (candidates.length === 1) {
          const { version, article, migration = null } = candidates[0];
          selected = { versionId: version.versionId, digest: version.digest, target: { kind: "geo-article", geoProjectId: geo.id, articleId: article.id },
            expectedHeadVersionId: version.versionId, migration };
        }
      }
      if (selected) reference = await this.revisions.prepareConversation(user.id, project, request, selected);
    }
    this.#prepared.set(request, { referenceId: reference?.referenceId ?? null, geoId: geo.id });
    return reference;
  }

  async validatePrepared(user, project, request) {
    const prepared = this.#prepared.get(request);
    if (!prepared) throw new HttpError(409, "result_revision_stale", "Prepare the article selection first.");
    await this.service.requireProject(user, prepared.geoId, "edit");
    await this.revisions.requestScope(user.id, project, request);
    if (!prepared.referenceId) return null;
    const row = await this.documents.get(project.userId, "result-revision", prepared.referenceId);
    if (!row || row.projectId !== project.id || row.payload.requestedBy !== user.id || row.payload.sessionId !== request.sessionId) throw new HttpError(409, "result_revision_stale", "Reopen the article.");
    if (row.payload.target?.kind === "geo-article" && !(row.payload.state === "bound" && row.payload.promptRequestId === request.requestId)) {
      const article = await this.store.getArticle(prepared.geoId, row.payload.target.articleId);
      const migration = row.payload.migration;
      if (!(migration && !article?.currentResultVersionId && article?.path === migration.path && article?.runId === migration.runId
        && article?.contentSha256 === migration.digest)) await this.assertHead(project, { id: prepared.geoId }, row.payload);
    }
    return row;
  }

  async bindPrepared(user, project, request) {
    const row = await this.validatePrepared(user, project, request);
    if (!row) return null;
    if (row.payload.migration && row.payload.state !== "bound") {
      const article = await this.store.getArticle(row.payload.target.geoProjectId, row.payload.target.articleId);
      if (!article.currentResultVersionId) {
        const version = await this.results.get(project.userId, project.id, row.payload.versionId);
        await this.store.linkArticleVersion(row.payload.target.geoProjectId, article.id, { version });
      }
      await this.assertHead(project, { id: row.payload.target.geoProjectId }, row.payload);
    }
    return this.revisions.bind(user.id, project, request);
  }

  /** @param {{store:any,service:any,results:any,revisions:any,documents:any,cards:any,parser:any,report?:(code:string)=>void}} deps */
  constructor({ store, service, results, revisions, documents, cards, parser, report = () => {} }) {
    this.store = store; this.service = service; this.results = results; this.revisions = revisions;
    this.documents = documents; this.cards = cards; this.parser = parser; this.report = report;
  }

  /** Decode only through the existing parser; Word is never interpreted as UTF-8 ZIP bytes. */
  async readVersion(project, versionId) {
    const { version, bytes } = await this.results.raw(project.userId, project.id, versionId);
    if (/\.(?:md|markdown)$/i.test(version.path)) return { version, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    if (/\.docx$/i.test(version.path)) {
      const parsed = await this.parser.parseBytes({ bytes, filename: path.posix.basename(version.path), mediaType: version.mimeType, sha256: version.digest });
      return { version, text: parsed.text };
    }
    throw new HttpError(415, "geo_article_text_unsupported", "This file has no supported editable text representation.");
  }

  /** Resolve by this conversation only. Ambiguous files stay with the model's native clarification. */
  async bind(user, project, request) {
    if (this.#prepared.has(request)) return this.bindPrepared(user, project, request);
    const geo = await this.store.projectByControlProject(project.userId, project.id);
    if (!geo || !request?.sessionId) return null;
    await this.service.requireProject(user, geo.id, "edit");
    // Migrate only an exact preserved producer identity, never today's bytes under a historical path.
    for (const article of await this.store.listArticles(geo.id)) {
      if (article.currentResultVersionId || !article.runId || !editable(article.path)) continue;
      const captured = await this.results.list(user.id, { projectId: project.id, path: article.path, runId: article.runId, limit: 100 });
      const version = captured.items.find(item => item.digest === article.contentSha256 && item.producer?.sessionId === request.sessionId
        && item.producer?.runId === article.runId && item.producer?.kind !== "workspace");
      if (!version) continue;
      await this.results.raw(user.id, project.id, version.versionId);
      try { await this.store.linkArticleVersion(geo.id, article.id, { version }); }
      catch (error) { if (error?.code !== "geo_article_head_changed") throw error; }
    }
    if (request.evimedResultRevision !== undefined) {
      let row = await this.documents.get(project.userId, "result-revision", request.evimedResultRevision?.referenceId);
      if (row?.projectId === project.id && !row.payload.target) {
        const article = (await this.store.listArticles(geo.id)).find(candidate => candidate.currentResultVersionId === row.payload.versionId);
        if (article) {
          row = await this.documents.put(project.userId, "result-revision", row.id, { ...row.payload,
            target: { kind: "geo-article", geoProjectId: geo.id, articleId: article.id }, expectedHeadVersionId: article.currentResultVersionId },
          { projectId: project.id, expectedRevision: row.revision });
        }
      }
      if (row?.payload?.target?.kind === "geo-article" && !(row.payload.state === "bound" && row.payload.promptRequestId === request.requestId)) await this.assertHead(project, geo, row.payload);
      return this.revisions.bind(user.id, project, request);
    }
    // Retry by actual request identity before looking at a head that this request may already have advanced.
    const requestId = typeof request.requestId === "string" ? request.requestId : "";
    const id = `rr_${sha(JSON.stringify([user.id, project.id, requestId]))}`;
    const previous = await this.documents.get(project.userId, "result-revision", id);
    if (previous?.payload?.mode === "conversation") {
      const staged = previous.payload;
      if (previous.projectId !== project.id || staged.requestedBy !== user.id || staged.sessionId !== request.sessionId) throw new HttpError(409, "result_revision_stale", "Reopen the article.");
      return this.revisions.bindConversation(user.id, project, request, staged);
    }
    const candidates = [];
    let truncated = false;
    for (const article of await this.store.listArticles(geo.id)) {
      if (!article.currentResultVersionId || !editable(article.path)) continue;
      const version = await this.results.get(user.id, project.id, article.currentResultVersionId);
      if (version.producer?.sessionId === request.sessionId) candidates.push({ article, version });
    }
    // An ordinary generated file without GEO business metadata still belongs to the shared result chain.
    if (!candidates.length) {
      const found = await this.results.query(user.id, project.id, { producer: { sessionId: request.sessionId } }, { limit: 100 });
      const editableVersions = found.items.filter(version => editable(version.path) && version.producer?.kind !== "workspace");
      const parents = new Set(editableVersions.map(version => version.supersedesVersionId).filter(Boolean));
      const parentBytes = new Set(editableVersions.filter(version => parents.has(version.versionId)).map(version => `${version.path}\0${version.digest}`));
      const leaves = [...new Map(editableVersions.filter(version => !parents.has(version.versionId) && !parentBytes.has(`${version.path}\0${version.digest}`))
        .map(version => [`${version.path}\0${version.digest}`, version])).values()];
      truncated = Boolean(found.nextCursor);
      if (leaves.length === 1 && !truncated) return this.revisions.bindConversation(user.id, project, request,
        { versionId: leaves[0].versionId, digest: leaves[0].digest, target: null, expectedHeadVersionId: null });
      candidates.push(...leaves.map(version => ({ article: { title: path.posix.basename(version.path) }, version })));
    }
    if (candidates.length !== 1 || truncated) {
      if (candidates.length > 1 || truncated) request.content = [...request.content, { type: "text", text:
        `\n<evimed_result_selection>${JSON.stringify({ files: candidates.map(({ article, version }) => ({ title: article.title, path: version.path })),
          instruction: "Several editable articles belong to this conversation. If the intended file is not clear from the conversation, use native clarification before revising. Do not choose the project's newest file." })}</evimed_result_selection>` }];
      return null;
    }
    const { article, version } = candidates[0];
    return this.revisions.bindConversation(user.id, project, request, { versionId: version.versionId, digest: version.digest,
      target: { kind: "geo-article", geoProjectId: geo.id, articleId: article.id }, expectedHeadVersionId: article.currentResultVersionId });
  }

  async assertHead(project, geo, staged) {
    const article = await this.store.getArticle(geo.id, staged.target.articleId);
    if (staged.target.geoProjectId !== geo.id || !article || article.currentResultVersionId !== staged.expectedHeadVersionId
      || article.contentSha256 !== staged.digest || staged.projectId !== project.id) throw new HttpError(409, "geo_article_head_changed", "The article has a newer version.");
  }

  /** Called after capture and delivery import, and safely again on restart/retry. */
  async complete(project, run) {
    const geo = await this.store.projectByControlProject(project.userId, project.id);
    if (!geo || !run?.id) return { linked: 0 };
    const versions = [];
    let cursor = null;
    for (let i = 0; i < 10; i += 1) {
      const page = await this.results.list(project.userId, { projectId: project.id, runId: run.id, limit: 100, cursor });
      versions.push(...page.items); cursor = page.nextCursor;
      if (!cursor) break;
    }
    let linked = 0;
    // Initial association requires the registered bytes, this run, and this exact path. Backfills cannot claim old-run authorship.
    for (const article of await this.store.listArticles(geo.id)) {
      if (article.currentResultVersionId || article.runId !== run.id) continue;
      const version = versions.find(item => item.path === article.path && item.digest === article.contentSha256
        && item.producer?.sessionId === run.sessionId && item.producer?.kind !== "workspace");
      if (version) linked += Number((await this.store.linkArticleVersion(geo.id, article.id, { version })).linked);
    }
    const page = await this.documents.list(project.userId, "result-revision", { projectId: project.id, limit: 100,
      filter: { recordType: "result-revision", state: "bound", sessionId: run.sessionId } });
    for (const row of page.items) {
      const staged = row.payload;
      if (staged.target?.kind !== "geo-article" || staged.target.geoProjectId !== geo.id
        || !(run.kernelRequestIds ?? []).includes(staged.promptRequestId)) continue;
      const selected = versions.filter(item => item.supersedesVersionId === staged.versionId
        && item.path.startsWith(`artifacts/result-revisions/${staged.id}/output/`))
        .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))[0];
      if (!selected) continue; // A normal reply or unchanged copy consumes no business head and emits no failure.
      try {
        await this.service.requireProject({ id: staged.requestedBy }, geo.id, "edit");
        const article = await this.store.getArticle(geo.id, staged.target.articleId);
        let checks = null;
        try {
          const read = await this.readVersion(project, selected.versionId);
          checks = await this.cards.checkText(geo, { text: read.text, layer: article.layer });
        } catch (error) { this.report(error?.code ?? "geo_article_check_unavailable"); }
        linked += Number((await this.store.linkArticleVersion(geo.id, article.id, { version: selected,
          expectedHeadVersionId: staged.expectedHeadVersionId, requestId: staged.promptRequestId, checks })).linked);
      } catch (error) { this.report(error?.code ?? "geo_article_link_failed"); }
    }
    return { linked };
  }
}
