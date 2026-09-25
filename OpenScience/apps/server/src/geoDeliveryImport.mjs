import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { deliverableDir, deliverableIdOfPath } from "@evimed/domain";
import { geoRuntimeWrite, GEO_WRITE_LIMITS } from "./geoWrites.mjs";
import { readFileNoFollow, resolveScopedPath } from "./security.mjs";

/**
 * The claim library a finished `geo-insight` run delivered, registered in its
 * GEO project from the deliverable's own `claims.json` (build spec 2026-09-25
 * §4; "contracts bind outputs").
 *
 * The run registers claims through `geo_write` as it goes, and the page reads
 * the table. On the first production run (2026-09-25, 信尔美) the delivered
 * file held 80 claims and the table 3: the method's claim records carry fields
 * the table does not keep, and the write refused each of those items whole.
 * The file is what the gate checked, so the platform takes it from there once
 * the run ends — through the same writer and the same per-item validation as
 * the tool, so nothing the tool would refuse gets in. Idempotent: claims are
 * upserted by key, and an unchanged statement is not a new version.
 *
 * Which deliverables: the run's own geo-insight ones, and any deliverable
 * folder of the project that looks like one (`claims.json` beside
 * `question-map.json`) — so a run that ended before this import existed, or
 * whose end was missed by a restart, is picked up when the project's next run
 * ends.
 *
 * Build to delete: once runs register every claim themselves (the write now
 * ignores extra fields instead of refusing the item), this import only
 * confirms what is already there.
 */

const TERMINAL = new Set(["succeeded", "failed", "canceled", "cancelled"]);
/** Below the write's 256 KB body limit, with room for the envelope. */
const CHUNK_BYTES = 200 * 1024;

/**
 * @param {unknown[]} items
 * @returns {unknown[][]}
 */
export function claimChunks(items) {
  /** @type {unknown[][]} */
  const chunks = [];
  let current = /** @type {unknown[]} */ ([]);
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item ?? null), "utf8");
    if (current.length && (bytes + size > CHUNK_BYTES || current.length >= GEO_WRITE_LIMITS.claims)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * A delivered competitor in the tool's shape. The first production run
 * (2026-09-25) wrote `{ name: "司美格鲁肽注射液（诺和盈/Wegovy）", manufacturer,
 * role, … }`, which the write refused whole for having no brand or generic
 * name, so no rival was ever registered. The label's own layout is read: the
 * name before the brackets is the generic name, the first name inside them
 * the brand and the rest aliases. An entry already in the tool's shape passes.
 * @param {Record<string, any>} entry
 */
export function competitorForWrite(entry) {
  if (entry.brandName || entry.genericName) return entry;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name) return entry;
  const match = /^(.+?)\s*[（(]([^（）()]+)[）)]$/.exec(name);
  const inner = match ? match[2].split(/[/／、,，]/).map((part) => part.trim()).filter(Boolean) : [];
  return {
    genericName: match ? match[1].trim() : name,
    brandName: inner[0] ?? null,
    aliases: inner.slice(1),
    holder: entry.holder ?? entry.manufacturer ?? null,
    indication: entry.indication ?? null,
    reason: entry.reason ?? entry.role ?? null,
  };
}

/**
 * The project's deliverable folders. Real directories only; a symlinked
 * folder is not followed.
 * @param {string} workspaceDir
 * @returns {Promise<string[]>}
 */
async function deliverableFolders(workspaceDir) {
  try {
    const entries = await fs.readdir(resolveScopedPath(workspaceDir, "deliverables"), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * The project's deliverable folders that hold an insight pack.
 * @param {string} workspaceDir
 * @returns {Promise<string[]>}
 */
async function insightFolders(workspaceDir) {
  /** @type {string[]} */
  const found = [];
  for (const name of await deliverableFolders(workspaceDir)) {
    const names = await fs.readdir(resolveScopedPath(workspaceDir, deliverableDir(name))).catch(() => []);
    if (names.includes("claims.json") && names.includes("question-map.json")) found.push(name);
  }
  return found;
}

/**
 * The workspace file at a path relative to the workspace, never following a
 * link. `readFileNoFollow` takes an absolute target (a relative one resolves
 * against the process's own directory and is refused as escaping) — which the
 * first cut of this module passed, so production read nothing.
 * @param {string} workspaceDir @param {string} relative
 */
export const readWorkspaceFile = async (workspaceDir, relative) => readFileNoFollow(workspaceDir, resolveScopedPath(workspaceDir, relative));

/**
 * @param {{ store: import("./geoStore.mjs").GeoStore, report?: (code: string) => void,
 *   readFile?: (rootDir: string, file: string) => Promise<Buffer | string>,
 *   listInsightFolders?: (workspaceDir: string) => Promise<string[]>,
 *   listDeliverableFolders?: (workspaceDir: string) => Promise<string[]>,
 *   articleGate?: ((project: any, ref: { runId: string | null, deliverableId: string | null, path: string }) => Promise<string>) | null,
 *   articleRunId?: ((project: any, deliverableId: string) => Promise<string | null>) | null }} deps
 */
export function createGeoDeliveryImport({ store, report = () => {}, readFile = readWorkspaceFile, listInsightFolders = insightFolders,
  listDeliverableFolders = deliverableFolders, articleGate = null, articleRunId = null }) {
  /** Runs already imported by this process; the writes are idempotent either way. */
  const seen = new Set();
  /**
   * @param {{ id: string, userId: string, workspaceDir: string }} project the control-plane project
   * @param {Record<string, any>} run
   * @returns {Promise<{ imported: number, issues: number, located: number, gated: number } | null>}
   */
  return async function importDelivery(project, run) {
    if (!run?.id || !TERMINAL.has(String(run.status ?? "")) || seen.has(run.id)) return null;
    const geoProject = await store.projectByControlProject(project.userId, project.id);
    if (!geoProject) return null;
    seen.add(run.id);
    const deliverables = /** @type {any[]} */ (run.deliverables ?? run.progress?.deliverables ?? []);
    const ids = new Set(deliverables
      .filter((deliverable) => typeof deliverable?.id === "string" && (!deliverable.capability || deliverable.capability === "geo-insight"))
      .map((deliverable) => String(deliverable.id)));
    for (const folder of await listInsightFolders(project.workspaceDir)) ids.add(folder);
    let imported = 0;
    let issues = 0;
    for (const id of ids) {
      let parsed;
      try {
        parsed = JSON.parse(String(await readFile(project.workspaceDir, `${deliverableDir(id)}/claims.json`)));
      } catch {
        continue;
      }
      // The competitors the run named, when the project has none yet: the
      // parser recognises a rival only by a registered name, so without them
      // share of voice and the rival cells are never computed (production,
      // 2026-09-25: a baseline measured with competitors []).
      const rivals = Array.isArray(parsed?.competitors)
        ? parsed.competitors.filter((entry) => entry && typeof entry === "object").map(competitorForWrite) : [];
      if (rivals.length && !(geoProject.competitors ?? []).length) {
        try {
          await geoRuntimeWrite({ store, project: geoProject, what: "product", body: { data: { competitors: rivals.slice(0, GEO_WRITE_LIMITS.competitors) } } });
          geoProject.competitors = (await store.projectByControlProject(project.userId, project.id))?.competitors ?? [];
          report(`competitors imported ${geoProject.competitors.length} of ${rivals.length}`);
        } catch (error) {
          report(typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "geo_competitors_import_failed");
        }
      }
      const claims = Array.isArray(parsed?.claims) ? parsed.claims : Array.isArray(parsed) ? parsed : [];
      for (const chunk of claimChunks(claims)) {
        try {
          const result = await geoRuntimeWrite({ store, project: geoProject, what: "claims", body: { items: chunk } });
          imported += result.ids.length;
          issues += result.issues.filter((issue) => issue.code !== "ignored_fields").length;
        } catch (error) {
          report(typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "geo_claims_import_failed");
        }
      }
    }
    if (imported || issues) report(`claims imported ${imported}, refused ${issues}`);
    // Articles registered by their path inside the deliverable folder, as the
    // skill used to say (`articles/<id>.md`): with no workspace path and no
    // run, the gate could not be read, the page could not open them and the
    // market could not send them. Found by that path under one deliverable
    // folder — the one whose file has the registered hash when two have it.
    let located = 0;
    const folders = await listDeliverableFolders(project.workspaceDir);
    for (const article of await store.listArticles(geoProject.id)) {
      if (!article.path) continue;
      if (article.path.startsWith("deliverables/")) {
        // At its workspace path but with no run: the page opens an article by both.
        const deliverableId = article.deliverableId ?? deliverableIdOfPath(article.path);
        const runId = !article.runId && deliverableId && articleRunId ? await articleRunId(geoProject, deliverableId).catch(() => null) : null;
        if (runId && await store.attachArticleRun(geoProject.id, article.id, runId)) located += 1;
        continue;
      }
      /** @type {Array<{ folder: string, same: boolean }>} */
      const found = [];
      for (const folder of folders) {
        let bytes;
        try {
          bytes = await readFile(project.workspaceDir, `${deliverableDir(folder)}/${article.path}`);
        } catch {
          continue;
        }
        found.push({ folder, same: createHash("sha256").update(bytes).digest("hex") === article.contentSha256 });
      }
      const exact = found.filter((entry) => entry.same);
      const match = exact.length === 1 ? exact[0] : exact.length === 0 && found.length === 1 ? found[0] : null;
      if (!match) {
        if (found.length) report("geo_article_location_ambiguous");
        continue;
      }
      const runId = articleRunId ? await articleRunId(geoProject, match.folder).catch(() => null) : null;
      const path = `${deliverableDir(match.folder)}/${article.path}`;
      if (await store.relocateArticle(geoProject.id, article.id, { path, deliverableId: match.folder, runId })) located += 1;
    }
    if (located) report(`articles located or given their run ${located}`);
    // The articles written in this run have a verdict now (production,
    // 2026-09-25: five articles stayed 「draft · unverified」 after their
    // deliverable was delivered with a pass, so nothing was publishable).
    let gated = 0;
    if (articleGate) {
      for (const article of await store.listArticles(geoProject.id)) {
        if (article.gate === "passed" || !["draft", "publishable"].includes(String(article.status))) continue;
        try {
          const gate = await articleGate(geoProject, { runId: article.runId ?? null, deliverableId: article.deliverableId ?? null, path: article.path });
          if (["passed", "unverified", "failed"].includes(String(gate)) && await store.refreshArticleGate(geoProject.id, article.id, /** @type {any} */ (gate))) gated += 1;
        } catch (error) {
          report(typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "geo_article_gate_failed");
        }
      }
      if (gated) report(`article gates refreshed ${gated}`);
    }
    return { imported, issues, located, gated };
  };
}
