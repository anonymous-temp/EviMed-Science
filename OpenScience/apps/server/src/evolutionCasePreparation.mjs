import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { numericScore, simulationRequiredReplicates, simulationSpecificationIssues } from "../../../evals/paper-gold/evaluator.mjs";
import { createEvolutionAggregateCasePreparation, AGGREGATE_REFERENCE_METHODS } from "./evolutionAggregateCasePreparation.mjs";
const hash = text => createHash("sha256").update(text).digest("hex");
/** Deterministic independent curation for published DARTH cases. Expected values are
 * preserved primary-paper tables; pinned author R reproduces them in an isolated executor.
 * The future development candidate never receives these assets. @param {any} deps */
export function createEvolutionCasePreparation({ config, controller, fetchImpl = fetch }) {
  const dataDir = config.evaluationDataDir || path.join(config.dataDir, "evaluation-control");
  const casesDir = path.join(dataDir, "paper-gold", "candidate-cases");
  const sourceDir = path.join(dataDir, "paper-gold", "economics");
  const get = async url => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(60000), redirect: "error" });
    if (!response.ok) throw new Error("Published author-code acquisition is unavailable.");
    const text = await response.text();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Reference acquisition exceeded bound.");
    return text;
  };
  const summary = definition => {
    const published = (definition.cases ?? []).filter(row => row.kind === "published" && row.hidden === true && row.independentQa?.passed === true && row.sourceHash && row.publicationId && Object.keys(row.numeric ?? {}).length);
    const publishedReferenceCount = new Set(published.map(row => row.publicationId)).size;
    const admitted = (definition.cases ?? []).filter(row => row.hidden === true && row.independentQa?.passed === true && row.sourceHash);
    // A simulation is ready when its specification stays inside the bounds a specification may not choose
    // for itself, it preregistered as many datasets as its own tolerance needs, and at least one scenario's
    // truth is far enough from the null to tell the method from an estimator that always answers the null.
    const simulations = admitted.filter(row => row.kind === "simulation" && Array.isArray(row.inputs) && Number.isFinite(Date.parse(row.preregistered?.at))
      && row.preregistered?.hash === hash(JSON.stringify({ inputs: row.inputs, specification: row.specification }))
      && simulationSpecificationIssues(row.specification).length === 0 && row.inputs.length >= simulationRequiredReplicates(row.specification));
    const simulationReady = definition.noPublishedExamples === true && simulations.some(row => Math.abs(row.specification.truth - (row.specification.nullValue ?? 0)) > row.specification.maxBias);
    const workflowSmokeReady = admitted.some(row => row.kind === "workflow-smoke" && row.input && Object.keys(row.numeric ?? {}).length > 0);
    const ok = publishedReferenceCount >= 2 || simulationReady || workflowSmokeReady;
    return { ok, ...(ok ? {} : { status: "waiting_resource", resourceCode: "independent_published_references_incomplete" }),
      simulationReady, workflowSmokeReady, noPublishedExamples: definition.noPublishedExamples === true,
      independentImplementation: published.length > 0 && published.every(row => row.independentImplementation),
      caseIds: admitted.map(row => row.id), publishedReferenceCount, publicInputCount: definition.publicInputCount ?? (definition.methodId === "cohort-state-transition" ? 2 : 0),
      sourceHashes: admitted.map(row => row.sourceHash), access: "evaluation-only", hash: hash(JSON.stringify(definition)) };
  };
  return {
    /** @param {any} card @param {any} [options] */
    async prepareCases(card, { signal = undefined } = {}) {
      const methodId = card.methodId ?? card.id;
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(String(methodId))) throw new Error("Invalid method identity.");
      const destination = path.join(casesDir, `${methodId}.json`);
      try {
        const existing = JSON.parse(await readFile(destination, "utf8"));
        if (existing.methodId !== methodId || existing.frozen !== true) throw new Error("Unfrozen evaluator cases.");
        return summary(existing);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (AGGREGATE_REFERENCE_METHODS.includes(methodId)) return createEvolutionAggregateCasePreparation({ config, controller }).prepareCases(card, { signal });
      if (methodId !== "cohort-state-transition" && card.methodFamily !== "cohort-state-transition") return { ok: false, status: "waiting_resource", resourceCode: "independent_published_reference_curation_unavailable" };
      const exportCode = await readFile(new URL("../../../evals/paper-gold/darth_reference_export.R", import.meta.url), "utf8");
      const cases = [];
      for (const [kind, repository, script] of [["independent", "cohort-modeling-tutorial-intro", "analysis/cSTM_time_indep.R"], ["dependent", "cohort-modeling-tutorial-timedep", "analysis/cSTM_time_dep_simulation.R"]]) {
        const id = `darth-time-${kind}`;
        let primary;
        try { primary = JSON.parse(await readFile(path.join(sourceDir, `${id}.json`), "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; return { ok: false, status: "waiting_resource", resourceCode: "primary_published_numeric_table_unavailable", caseIds: [id] }; }
        const commit = JSON.parse(await get(`https://api.github.com/repos/DARTH-git/${repository}/commits/main`)).sha;
        if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid author revision identity.");
        const original = await get(`https://raw.githubusercontent.com/DARTH-git/${repository}/${commit}/${script}`);
        const functions = await get(`https://raw.githubusercontent.com/DARTH-git/${repository}/${commit}/R/Functions.R`);
        const files = { "reference-functions.R": functions };
        let program = original.slice(original.indexOf("# Model input ----"), original.indexOf("# Cost-effectiveness analysis (CEA) ----"));
        program = program.slice(0, program.indexOf("# Plot Outputs ----")) + program.slice(program.indexOf("# State Rewards ----"));
        if (kind === "dependent") {
          files["lifetable.csv"] = await get(`https://raw.githubusercontent.com/DARTH-git/${repository}/${commit}/data/LifeTable_USA_Mx_2015.csv`);
          program = program.replace('"data/LifeTable_USA_Mx_2015.csv"', '"/candidate/lifetable.csv"').replace(/v_r_mort_by_age <- lt_usa_2015 %>%[\s\S]*?as.matrix\(\)/, 'v_r_mort_by_age <- as.matrix(lt_usa_2015[lt_usa_2015$Age >= n_age_init & lt_usa_2015$Age < n_age_max, "Total", drop=FALSE])');
        }
        files["reference.R"] = `source("/candidate/reference-functions.R")\n${program}\n${exportCode}`;
        const result = await controller.execVerify({ files, code: 'import subprocess,gzip,base64\nresult=subprocess.run(["Rscript","--vanilla","/candidate/reference.R"],capture_output=True,text=True,check=True,timeout=60)\nprint(base64.b64encode(gzip.compress(result.stdout.encode())).decode())\n', input: {} }, { signal });
        if (result.ok !== true || result.joined !== true) return { ok: false, status: "waiting_resource", resourceCode: "independent_reference_execution_unavailable", caseIds: [id] };
        const lines = gunzipSync(Buffer.from(String(result.output).trim(), "base64"), { maxOutputLength: 1024 * 1024 }).toString("utf8").trim().split("\n");
        const specification = JSON.parse(lines.find(line => line.startsWith("SPECIFICATION:")).slice("SPECIFICATION:".length));
        const start = lines.indexOf('"cost","qaly"');
        if (start < 0) throw new Error("Author reference did not return numerical evidence.");
        const rows = lines.slice(start + 1, start + 5).map(line => line.split(",").map(Number));
        const numeric = {}, independent = {};
        for (const [index, label] of ["soc", "a", "b", "ab"].entries()) for (const [column, metric, printed] of [[0, "cost", "cost"], [1, "qaly", "qalys"]]) {
          const key = `${label}.${metric}`, reference = primary.numeric[`${label}_${printed}`];
          if (!numericScore(rows[index][column], reference).valid) return { ok: false, status: "waiting_resource", resourceCode: "published_parameter_version_disagreement", caseIds: [id] };
          numeric[key] = { ...reference, outputPath: key }; independent[key] = rows[index][column];
        }
        cases.push({ id, hidden: true, kind: "published", publicationId: primary.doi, input: { specification }, numeric, sourceHash: hash(JSON.stringify(primary)), authorCode: { commit, originalHash: hash(original), functionsHash: hash(functions) }, independentQa: { writer: "primary_table_transcription", reviewer: "published_author_R_reproduction", passed: true }, independentImplementation: { implementationId: "published_DARTH_R", numeric: independent } });
      }
      const definition = { methodId, frozen: true, cases };
      await mkdir(casesDir, { recursive: true, mode: 0o700 });
      await writeFile(destination, JSON.stringify(definition), { mode: 0o600, flag: "wx" });
      return summary(definition);
    },
  };
}
