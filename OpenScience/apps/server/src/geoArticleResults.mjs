import { createHash } from "node:crypto";
import path from "node:path";
import { HttpError } from "./security.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const editable = file => /\.(?:md|markdown|docx)$/i.test(file ?? "");

/** Business links over shared immutable results. No byte storage or file engine lives here. */
export class GeoArticleResults {
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
    const geo = await this.store.projectByControlProject(project.userId, project.id);
    if (!geo || !request?.sessionId) return null;
    await this.service.requireProject(user, geo.id, "edit");
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
      const editableVersions = found.items.filter(version => editable(version.path));
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
      const version = versions.find(item => item.path === article.path && item.digest === article.contentSha256);
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
