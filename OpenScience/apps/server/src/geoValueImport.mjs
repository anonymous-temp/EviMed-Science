import { createHash } from "node:crypto";
import { deliverableDir, GEO_RESEARCH_CAPABILITIES, geoValueObject } from "@evimed/domain";

/**
 * Import optional analysis plus the original specialist output, even after a
 * partial run. A report is research material, not an automatically verified
 * clinical conclusion. The next GEO turn interprets it in its decision context.
 * @param {{ store: any, project: any, geoProject: any, run: any, readFile: Function, report: Function, capabilityOutputs?: (id: string) => Promise<string[]> }} input
 */
export async function importGeoValue({ store, project, geoProject, run, readFile, report, capabilityOutputs = async () => [] }) {
  if (typeof store.writeValue !== "function") return;
  const request = typeof store.researchRequests === "function"
    ? (await store.researchRequests(geoProject.id)).find((entry) => entry.runId === run.id) : null;
  const deliverables = run.deliverables ?? run.progress?.deliverables ?? [];
  for (const delivery of deliverables) {
    if (!delivery?.id) continue;
    const capability = delivery.capability ?? run.capabilityId ?? run.agentId;
    if (capability && !String(capability).startsWith("geo-") && !GEO_RESEARCH_CAPABILITIES.includes(capability)) continue;
    const base = deliverableDir(String(delivery.id));
    const optional = await readFile(project.workspaceDir, `${base}/geo-value.json`).catch(() => null);
    if (optional != null) try {
      const raw = String(optional);
      if (Buffer.byteLength(raw) <= 256 * 1024) {
        const parsed = JSON.parse(raw);
        if (geoValueObject(parsed)) await store.writeValue(project.userId, geoProject.id, parsed, run.id);
        else report("geo_value_json_invalid");
      } else report("geo_value_json_too_large");
    } catch { report("geo_value_import_failed"); }
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
    if (!materials.length && !GEO_RESEARCH_CAPABILITIES.includes(capability)) continue;
    try {
      await store.writeValue(project.userId, geoProject.id, { researchResults: [{ id: `run:${run.id}:${delivery.id}`,
        runId: run.id, deliverableId: delivery.id, capabilityId: capability ?? null, status: "available",
        requestId: request?.id ?? null, basisVersion: request?.basisVersion ?? null,
        findingIds: request?.findingIds ?? [], groupIds: request?.groupIds ?? [], opportunityId: request?.opportunityId ?? null,
        runStatus: run.status, verification: delivery.verification ?? "unverified", materials,
        summary: delivery.title ?? delivery.name ?? "Research output available", basis: "research_output" }] }, run.id);
    } catch { report("geo_value_import_failed"); }
  }
}
