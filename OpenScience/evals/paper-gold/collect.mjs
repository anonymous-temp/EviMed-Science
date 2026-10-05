import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { digest } from "./evaluator.mjs";
/** Fetch primary open-access records. No unverified numeric gold is inferred. */
export async function collectCalibration(dataDir, fetchImpl = fetch) {
  const tracks = { meta: 'meta-analysis randomized', pharmacovigilance: 'FAERS disproportionality', mr: 'Mendelian randomization two-sample' };
  const directory = path.join(dataDir, "paper-gold", "calibration");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = [];
  for (const [track, query] of Object.entries(tracks)) {
    const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
    url.search = new URLSearchParams({ query: `${query} AND OPEN_ACCESS:Y AND FIRST_PDATE:[2018-01-01 TO 2025-12-31]`, format: "json", resultType: "lite", pageSize: "20" }).toString();
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
      if (response.ok) break;
    }
    if (!response.ok) throw new Error(`Europe PMC returned ${response.status}`);
    for (const record of (await response.json()).resultList.result.filter(row => !/retract|protocol|scoping review|editorial|commentary|review of|methodological quality/i.test(row.title)).slice(0, 5)) {
      const id = `${track}-${record.id}`;
      let fullText = null;
      let fullTextStatus = "unavailable";
      if (record.pmcid) {
        const full = await fetchImpl(`https://www.ebi.ac.uk/europepmc/webservices/rest/${record.pmcid}/fullTextXML`, { signal: AbortSignal.timeout(60000) });
        if (full.ok) { fullText = await full.text(); fullTextStatus = "preserved"; }
      }
      const hidden = { record, fullText, fetchedAt: new Date().toISOString(), goldStatus: "numeric_extraction_pending", missing: ["independently_verified_numeric_gold", "same_version_analysis_inputs", "neutral_rewrite_independent_qa", "retraction_screen"] };
      await writeFile(path.join(directory, `${id}.json`), JSON.stringify(hidden), { mode: 0o600 });
      manifest.push({ id, track, doi: record.doi ?? null, pmid: record.pmid ?? (record.source === "MED" ? record.id : null), pmcid: record.pmcid ?? null, sourceUrl: record.source === "MED" ? `https://europepmc.org/article/MED/${record.id}` : `https://europepmc.org/articles/${record.pmcid ?? record.id}`, hiddenHash: digest(hidden), fullTextStatus, readiness: "candidate_only", numericGold: "unavailable_pending_verified_extraction" });
    }
  }
  return { schemaVersion: 1, fetchedAt: new Date().toISOString(), status: "public_candidates_not_scored_calibration", cases: manifest };
}
if (process.argv[1]?.endsWith("collect.mjs")) {
  const directory = process.env.OPEN_SCIENCE_EVALUATION_DATA_DIR;
  if (!directory) throw new Error("OPEN_SCIENCE_EVALUATION_DATA_DIR must be outside all runtime mounts.");
  const manifest = await collectCalibration(directory);
  await writeFile(new URL("./calibration-manifest.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Preserved ${manifest.cases.length} primary records; numeric gold still needs verified extraction.\n`);
}
