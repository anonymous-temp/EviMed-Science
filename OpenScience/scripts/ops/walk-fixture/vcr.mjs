/**
 * 虚拟临床研究 for the walk's fixture: three studies furnished the way the module furnishes them — through its own stores, with results
 * shaped as the engine returns them (`apps/server/test/vcrViewsSeed.mjs`, the page contract's seed, which the UI walk reuses so that what
 * it draws is what the contract tests prove).
 *
 *  - **EV-201, finished**: all seven steps done — 2,000 generated patients (the engine is absent here, so the table is written into the
 *    data plane the way the engine writes it), four designs, a literature control, a matching list with referrals and sites. This is the
 *    study the walk reads first (the one with the most steps done), so the charts, grids and long tables of the seven tabs are drawn.
 *  - **EV-202, mixed**: the same study left as the contract seeds it — a failed patients step with a partial result, a job running and a
 *    job waiting for its budget — which the walk reads second (`vcr-*@2`), so the header's 确认预算 and the frame's note are drawn.
 *  - **GLP-1 周制剂, empty**: a study nobody has started — the recipes of every tab.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "server");
const seedModule = () => import(pathToFileURL(path.join(server, "test", "vcrViewsSeed.mjs")).href);

/**
 * @param {any} app the control plane (`createWebApiApp`'s return) @param {any} user the fixture account
 * @param {{ log: (line: string) => void }} context
 * @returns {Promise<{ finished: string, mixed: string, empty: string, projects: { finished: string, mixed: string, empty: string } }>} the studies' ids and their projects'
 
 */
export async function furnishVcr(app, user, { log }) {
  const { seedEv201 } = await seedModule();
  const { store, matchStore, evidenceStore } = app.vcr;
  const plane = String(app.config.vcrDataPlaneDir ?? "");
  if (!plane) throw new Error("the fixture's control plane has no VCR data plane directory (vcrDataPlaneDir)");
  await mkdir(plane, { recursive: true, mode: 0o700 });
  const project = async (id, name) => (await app.store.createProject(user, id, name)).id ?? id;
  const common = { store, matchStore, evidenceStore, plane, owner: user.id };

  // The finished study, and the empty one the contract seeds beside it.
  const first = await seedEv201({
    ...common, projectId: await project("vcr-ev201", "EV-201 二线 NSCLC：单臂 II 期还是随机"), emptyProjectId: await project("vcr-glp1", "GLP-1 周制剂 III 期：样本量与脱落情景"),
  });
  await finish(store, first.study.id);

  // The mixed one, on a project of its own and under its own name.
  const second = await seedEv201({
    ...common, projectId: await project("vcr-ev202", "EV-202 二线 NSCLC：随机 III 期的样本量"), name: "EV-202 二线 NSCLC：随机 III 期的样本量", withEmpty: false, idTag: "_b",
  });
  log(`vcr: ${first.study.id} finished, ${second.study.id} mixed, ${first.empty.id} empty`);
  return { finished: first.study.id, mixed: second.study.id, empty: first.empty.id, projects: { finished: "vcr-ev201", mixed: "vcr-ev202", empty: "vcr-glp1" } };
}

/**
 * What the contract seeds as a study in the middle of its work, brought to its end: the patients step done with every replicate counted,
 * the job that was running and the one that waited for a budget succeeded, nothing marked as stale.
 * @param {any} store @param {string} studyId
 */
async function finish(store, studyId) {
  await store.setStep(studyId, "patients", { status: "done", requested: true, note: "2,000 名" });
  await store.query(`UPDATE evimed_vcr.results SET diagnostics = (diagnostics - 'partial') || '{"replicatesCompleted": 2000, "replicatesPlanned": 2000}'::jsonb
    WHERE study_id = $1 AND kind = 'patient_set'`, [studyId]);
  await store.query(`UPDATE evimed_vcr.jobs SET state = 'succeeded', finished_at = coalesce(finished_at, updated_at), cpu_seconds_used = greatest(cpu_seconds_used, 12)
    WHERE study_id = $1 AND state IN ('running', 'awaiting_budget', 'queued')`, [studyId]);
  await store.query("DELETE FROM evimed_vcr.stale_marks WHERE study_id = $1", [studyId]);
}
