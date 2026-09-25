import fs from "node:fs/promises";
import { deliverableDir } from "@evimed/domain";
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
 * The project's deliverable folders that hold an insight pack. Real
 * directories only; a symlinked folder is not followed.
 * @param {string} workspaceDir
 * @returns {Promise<string[]>}
 */
async function insightFolders(workspaceDir) {
  try {
    const root = resolveScopedPath(workspaceDir, "deliverables");
    const entries = await fs.readdir(root, { withFileTypes: true });
    /** @type {string[]} */
    const found = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const names = await fs.readdir(resolveScopedPath(workspaceDir, deliverableDir(entry.name))).catch(() => []);
      if (names.includes("claims.json") && names.includes("question-map.json")) found.push(entry.name);
    }
    return found;
  } catch {
    return [];
  }
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
 *   articleGate?: ((project: any, ref: { runId: string | null, deliverableId: string | null, path: string }) => Promise<string>) | null }} deps
 */
export function createGeoDeliveryImport({ store, report = () => {}, readFile = readWorkspaceFile, listInsightFolders = insightFolders,
  articleGate = null }) {
  /** Runs already imported by this process; the writes are idempotent either way. */
  const seen = new Set();
  /**
   * @param {{ id: string, userId: string, workspaceDir: string }} project the control-plane project
   * @param {Record<string, any>} run
   * @returns {Promise<{ imported: number, issues: number, gated?: number } | null>}
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
      const rivals = Array.isArray(parsed?.competitors) ? parsed.competitors.filter((entry) => entry && typeof entry === "object") : [];
      if (rivals.length && !(geoProject.competitors ?? []).length) {
        try {
          const result = await geoRuntimeWrite({ store, project: geoProject, what: "product", body: { data: { competitors: rivals.slice(0, GEO_WRITE_LIMITS.competitors) } } });
          if (result.ok) {
            geoProject.competitors = result.product ? (await store.projectByControlProject(project.userId, project.id))?.competitors ?? [] : geoProject.competitors;
            report(`competitors imported ${rivals.length}`);
          }
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
    return { imported, issues, gated };
  };
}
