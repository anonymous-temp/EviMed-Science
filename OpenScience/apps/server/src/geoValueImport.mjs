import { createHash } from "node:crypto";
import { deliverableDir, GEO_RESEARCH_CAPABILITIES, geoValueObject } from "@evimed/domain";

/**
 * Import optional analysis plus the original specialist output, even after a
 * partial run. A report is research material, not an automatically verified
 * clinical conclusion. The next GEO turn interprets it in its decision context.
 *
 * Only a run of a research capability leaves a research result. A GEO
 * capability (insight, strategy, content, export) is the programme's own work:
 * its deliverables are files in the workspace the pages already list, and its
 * one contribution to the profile is the `geo-value.json` it wrote on purpose.
 * Importing their excerpts as "research" put six thousand characters of each
 * into the profile, the judge's prompt and every round's frozen basis, and the
 * profile grew with every run of the programme (D-02).
 *
 * Answers the codes of the writes that failed (`failed`): a failed write is reported and the next one goes on, and the caller
 * decides whether the import is whole — a run's value that did not reach the profile is not something to forget (D-24).
 * @param {{ store: any, project: any, geoProject: any, run: any, readFile: Function, report: Function, capabilityOutputs?: (id: string) => Promise<string[]> }} input
 * @returns {Promise<{ failed: string[] }>}
 */
export async function importGeoValue({ store, project, geoProject, run, readFile, report, capabilityOutputs = async () => [] }) {
  /** @type {string[]} */
  const failed = [];
  if (typeof store.writeValue !== "function") return { failed };
  const request = typeof store.researchRequests === "function"
    ? (await store.researchRequests(geoProject.id)).find((entry) => entry.runId === run.id) : null;
  const deliverables = run.deliverables ?? run.progress?.deliverables ?? [];
  for (const delivery of deliverables) {
    if (!delivery?.id) continue;
    const capability = delivery.capability || run.effectiveAgentId || run.capabilityId || run.agentId;
    const research = GEO_RESEARCH_CAPABILITIES.includes(capability);
    if (capability && !String(capability).startsWith("geo-") && !research) continue;
    const base = deliverableDir(String(delivery.id));
    const optional = await readFile(project.workspaceDir, `${base}/geo-value.json`).catch(() => null);
    if (optional != null) try {
      const raw = String(optional);
      if (Buffer.byteLength(raw) <= 256 * 1024) {
        const parsed = JSON.parse(raw);
        if (geoValueObject(parsed)) await store.writeValue(project.userId, geoProject.id, parsed, run.id);
        else report("geo_value_json_invalid");
      } else report("geo_value_json_too_large");
    } catch { failed.push("geo_value_import_failed"); report("geo_value_import_failed"); }
    if (!research) continue;
    const materials = [];
    // Exact, bounded artifact names rather than a recursive scan or another model call.
    const declared = await capabilityOutputs(String(capability ?? "")).catch(() => []);
    const names = [...new Set(["evaluation-summary.json", "evidence-snapshot.json", "comprehensive-evaluation-report.md", "safety-report.md", "report.md", ...declared])]
      .filter((name) => typeof name === "string" && /\.(?:md|json|csv|txt)$/i.test(name)
        && !name.startsWith("/") && !name.split(/[\\/]/).some((part) => part === ".." || !part)).slice(0, 40);
    for (const name of names) {
      try {
        const bytes = await readFile(project.workspaceDir, `${base}/${name}`);
        const text = String(bytes);
        materials.push({ path: `${base}/${name}`, sha256: createHash("sha256").update(bytes).digest("hex"),
          excerpt: text.slice(0, 6000), truncated: text.length > 6000 });
      } catch { /* A capability can deliver a different artifact set. */ }
    }
    try {
      await store.writeValue(project.userId, geoProject.id, { researchResults: [{ id: `run:${run.id}:${delivery.id}`,
        runId: run.id, deliverableId: delivery.id, capabilityId: capability ?? null, status: "available",
        requestId: request?.id ?? null, basisVersion: request?.basisVersion ?? null,
        findingIds: request?.findingIds ?? [], groupIds: request?.groupIds ?? [], opportunityId: request?.opportunityId ?? null,
        runStatus: run.status, verification: delivery.verification ?? "unverified", materials,
        summary: delivery.title ?? delivery.name ?? "Research output available", basis: "research_output" }] }, run.id);
    } catch { failed.push("geo_value_import_failed"); report("geo_value_import_failed"); }
  }
  return { failed };
}
