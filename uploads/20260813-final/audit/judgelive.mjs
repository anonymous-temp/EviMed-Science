// Live measurement of the semantic coverage judge over the 29-package corpus.
//
// One model call per package, exactly as a delivery would make it. Resumable:
// each package's result is appended to judgelive.jsonl and an existing line is
// skipped, so an interrupted run continues with "node judgelive.mjs".
//
// Usage: node uploads/20260813-final/audit/judgelive.mjs [RQ-01_研究任务 ...]
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import { coverageJudgeContext } from "/home/coder/workspace/EviMedScience/OpenScience/apps/server/src/clinicalEvidenceQuality.mjs";
import { CoverageJudge, parseJudgeVerdicts } from "/home/coder/workspace/EviMedScience/OpenScience/apps/server/src/coverageJudge.mjs";

const root = "/home/coder/workspace/EviMedScience/uploads/20260813-final";
const briefRoot = "/home/coder/workspace/EviMedScience/uploads/20260812-sxjxw-33/briefs";
const outputPath = path.join(root, "audit", "judgelive.jsonl");
const key = readFileSync("/home/coder/workspace/EviMedScience/.evimed-local/secrets/deepseek.api-key", "utf8").trim();

// One judge per package, each with its own capturing fetch: four packages run
// concurrently and a shared judge's lastFailure would belong to whichever
// finished last. The capture keeps the model's RAW verdict list, so a change to
// the verification rules can be re-scored offline instead of re-buying 29 calls.
function judgeFor(capture) {
  return new CoverageJudge({
    coverageJudgeEnabled: true,
    coverageJudgeTimeoutMs: 420_000,
    deepseekProviderEnabled: true,
    deepseekApiKey: key,
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: process.env.MODEL ?? "deepseek-v4-pro",
    production: false,
  }, {
    fetchImpl: async (url, init) => {
      capture.requestBytes = Buffer.byteLength(String(init?.body ?? ""), "utf8");
      const response = await fetch(url, init);
      const text = await response.text();
      capture.body = text;
      return new Response(text, { status: response.status, headers: response.headers });
    },
  });
}

const done = new Set(
  existsSync(outputPath)
    ? readFileSync(outputPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).name)
    : [],
);

const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readFileSync(path.join(root, "audit", "coverage-labels.json"), "utf8")
    && [...new Set(
      JSON.parse(readFileSync(path.join(root, "audit", "coverage-labels.json"), "utf8")).labels.map((label) => `${label.rq}_研究任务`),
    )].sort();

const pending = names.filter((name) => !done.has(name));
process.stderr.write(`judging ${pending.length} of ${names.length} packages\n`);

async function judgeOne(name) {
  const dir = path.join(root, name);
  const report = path.join(dir, "clinical-evidence-report.md");
  const coverage = path.join(root, "audit", "coverage", `${name}.question-coverage.json`);
  const brief = path.join(briefRoot, `${name}.md`);
  if (![report, coverage, brief].every((file) => existsSync(file))) {
    return { name, skipped: "missing-files" };
  }
  const context = coverageJudgeContext({
    briefText: readFileSync(brief, "utf8"),
    questionCoverageText: readFileSync(coverage, "utf8"),
    reportText: readFileSync(report, "utf8"),
  });
  if (!context) return { name, skipped: "not-judgeable" };
  const capture = {};
  const judge = judgeFor(capture);
  const started = Date.now();
  const result = await judge.judge(context);
  let parsed = null;
  let usage = null;
  try {
    const body = JSON.parse(capture.body ?? "null");
    usage = body?.usage ?? null;
    const message = body?.choices?.[0]?.message;
    parsed = parseJudgeVerdicts(message?.content) ?? parseJudgeVerdicts(message?.reasoning_content);
  } catch { /* the failure is already recorded below */ }
  return {
    name,
    ms: Date.now() - started,
    judged: result.judged,
    failure: judge.lastFailure ?? null,
    requestBytes: capture.requestBytes ?? null,
    excerptLines: context.excerpt.length,
    reportLines: context.totalLines,
    entries: context.entries.length,
    truncated: context.truncated,
    usage,
    rawVerdicts: parsed,
    verdicts: result.verdicts,
    notices: result.notices,
  };
}

const queue = [...pending];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (;;) {
    const name = queue.shift();
    if (!name) return;
    let record;
    try {
      record = await judgeOne(name);
    } catch (error) {
      record = { name, error: String(error?.message ?? error) };
    }
    appendFileSync(outputPath, `${JSON.stringify(record)}\n`);
    process.stderr.write(`${name}: ${record.skipped ?? record.error ?? `${record.verdicts?.length ?? 0} verdicts in ${record.ms} ms`}\n`);
  }
}));
