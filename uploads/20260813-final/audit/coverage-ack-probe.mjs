// C4's false-positive arm. For every sentence in the corpus's 摘要 / 结论 /
// 临床实践要点 that admits a gap in the reviewers' own words, register a gap
// entry whose question is that same sentence — the strongest possible topic
// overlap — and check the gate does not flag it. A rule that punished these
// would teach runs to stop writing them, which is the opposite of the point.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { validateClinicalEvidencePackage } from "/home/coder/workspace/EviMedScience/OpenScience/apps/server/src/clinicalEvidenceQuality.mjs";

const root = "/home/coder/workspace/EviMedScience/uploads/20260813-final";
const dirs = readdirSync(root).filter((name) => (
  /^RQ-\d+_/.test(name) && existsSync(path.join(root, name, "clinical-evidence-report.md"))
)).sort();
const ack = /未(?:能)?检索到|尚未检索|未(?:能)?(?:获|经)(?:得)?(?:核验|核实)|证据空(?:白|缺)|未见(?:相关|直接|任何|以|有)|尚无(?:直接|已发表|公开|相应)?(?:的)?(?:证据|研究|数据|报道)|证据不足|不足以支持|未(?:能)?(?:追溯|定位)到|未述及|缺乏(?:直接)?(?:证据|研究|数据)|无直接(?:证据|研究)/;
const section = (text, heading) => text.match(
  new RegExp(`(?:^|\\n)##\\s+[^\\n]*(?:${heading})[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i"),
)?.[1] ?? "";

const found = [];
for (const name of dirs) {
  const dir = path.join(root, name);
  const reportText = readFileSync(path.join(dir, "clinical-evidence-report.md"), "utf8");
  for (const heading of ["摘要", "结论", "临床实践要点|临床要点"]) {
    for (const line of section(reportText, heading).split("\n")) {
      for (const sentence of line.split(/(?<=[。！？；;])/)) {
        const value = sentence.trim();
        if (value.length < 16 || !ack.test(value)) continue;
        found.push({ name, heading: heading.split("|")[0], sentence: value });
      }
    }
  }
}

// Each candidate becomes its own one-entry ledger on its own package, so the
// only thing the gate can react to is that sentence.
const hits = [];
for (const candidate of found) {
  const dir = path.join(root, candidate.name);
  const reportText = readFileSync(path.join(dir, "clinical-evidence-report.md"), "utf8");
  const searchLogText = readFileSync(path.join(dir, "clinical-evidence-search.json"), "utf8");
  const log = JSON.parse(searchLogText);
  const first = log.queries?.[0] ?? {};
  const ledger = {
    schemaVersion: 1,
    entries: [{
      id: "1.1",
      question: candidate.sentence.replace(/<!--[\s\S]*?-->/g, "").slice(0, 90),
      status: "gap",
      searches: [{
        query: String(first.query ?? ""),
        database: String(first.database ?? ""),
        searchedAt: String(log.searchedAt ?? "").slice(0, 10),
      }],
    }],
  };
  const result = validateClinicalEvidencePackage({
    reportText,
    matrix: JSON.parse(readFileSync(path.join(dir, "clinical-evidence-matrix.json"), "utf8")),
    runReceipt: JSON.parse(readFileSync(path.join(dir, "clinical-evidence-run.json"), "utf8")),
    searchLogText,
    questionCoverageText: JSON.stringify(ledger),
  });
  // Only whether the acknowledgement sentence itself was flagged. A different
  // sentence in the same section reacting to a question built out of a whole
  // sentence is an artefact of the probe, not of the rule.
  const own = candidate.sentence.trim().slice(0, 20);
  const flagged = result.issues.filter((issue) => {
    if (!/登记为 gap/.test(issue)) return false;
    const quoted = /：「([\s\S]*?)」。摘要、结论与临床实践要点/.exec(issue)?.[1] ?? "";
    return quoted.trim().startsWith(own);
  });
  if (flagged.length) hits.push({ ...candidate, flagged });
}
console.log(JSON.stringify({
  compliantSentences: found.length,
  packages: [...new Set(found.map((entry) => entry.name))].length,
  flagged: hits.length,
  samples: found.slice(0, 40).map((entry) => `${entry.name}/${entry.heading}: ${entry.sentence.replace(/<!--[\s\S]*?-->/g, "").slice(0, 90)}`),
  hits: hits.map((entry) => ({ name: entry.name, sentence: entry.sentence.slice(0, 120), issue: entry.flagged[0].slice(0, 180) })),
}, null, 1));
