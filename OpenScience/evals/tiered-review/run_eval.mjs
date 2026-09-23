#!/usr/bin/env node
/**
 * The independent reviewer's incidents as an eval (principle 6).
 *
 * Offline, every case runs the deterministic half through the platform's own
 * domain functions and must pass: the statistics check, the reference parser,
 * the numeric trace, the evidence rule that drops a paraphrased finding, the
 * reply tier. With `--live`, the reference cases also ask the registries
 * through the control plane's own resolver, and the reply case asks the
 * reviewer model (Qwen3.8-Max, the pinned snapshot) through the control
 * plane's own client — recorded, and scored against the case's expectation.
 *
 *   node evals/tiered-review/run_eval.mjs [--live] [--samples <n>] [--narrow] [--key-file <path>] [--only <case-id>]
 *
 * `--narrow` shows the editor each source as v1.1 first shipped it — ±300
 * characters around each quote — the control arm the source-window case was
 * written against.
 *
 * A model's answer is a sample, not a verdict (principle 11): `--samples`
 * asks the reviewer each live case n times and records every answer.
 *
 * The key file defaults to the workspace's local DashScope key; nothing is
 * metered and nothing is written but the result file.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  REPLY_CHECK_OUTPUT_SCHEMA, acceptEditorChecks, acceptEditorFindings, acceptReplyVerdicts, editorSaidNothing, numericTraceFindings,
  referenceEntries, referenceLookups, referenceResolutionFindings, replyCitedSentences, replyReviewTier, reviewEditorSchema, statConsistencyFindings,
} from "../../packages/domain/index.mjs";
import { createReferenceResolver } from "../../apps/server/src/referenceResolver.mjs";
import { callReviewModel } from "../../apps/server/src/reviewModel.mjs";
import { checklistFor, claimsWithSources, editorMessage, editorSystemPrompt, replyMessage, replySystemPrompt } from "../../apps/server/src/reviewService.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    live: { type: "boolean", default: false },
    samples: { type: "string", default: "1" },
    narrow: { type: "boolean", default: false },
    "key-file": { type: "string", default: resolve(here, "../../../.evimed-local/secrets/dashscope.api-key") },
    only: { type: "string" },
  },
});
const cases = JSON.parse(await readFile(join(here, "cases.json"), "utf8"));
const pins = JSON.parse(await readFile(join(here, "../../deps-version.json"), "utf8"));
const wanted = (/** @type {{ id: string }} */ item) => !values.only || item.id === values.only;
const samples = Math.max(1, Math.min(10, Number(values.samples) || 1));
/** @param {string} id @param {number} sample */
const sampled = (id, sample) => (samples > 1 ? `${id}#${sample}` : id);
/** @type {any[]} */
const results = [];
/** @param {string} group @param {string} id @param {boolean} pass @param {Record<string, any>} detail */
const record = (group, id, pass, detail) => {
  results.push({ group, id, pass, ...detail });
  process.stdout.write(`${pass ? "PASS" : "FAIL"} ${group}/${id}${detail.note ? ` — ${detail.note}` : ""}\n`);
};
const same = (/** @type {unknown[]} */ left, /** @type {unknown[]} */ right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

for (const item of cases.stat.filter(wanted)) {
  const found = statConsistencyFindings(item.text).map((finding) => finding.check);
  record("stat", item.id, same(found, item.expect), { found });
}

const resolver = values.live ? createReferenceResolver({ timeoutMs: 15_000 }) : null;
for (const item of cases.references.filter(wanted)) {
  const entries = referenceEntries(item.report);
  const dois = entries.flatMap((entry) => entry.dois);
  const parsed = same(dois, item.expectDois);
  if (!resolver) {
    record("references", item.id, parsed, { dois });
    continue;
  }
  const resolved = await resolver.resolve(referenceLookups(entries));
  const kinds = referenceResolutionFindings(entries, resolved).findings.map((finding) => finding.kind);
  record("references", item.id, parsed && same(kinds, item.expectLive), {
    dois, kinds,
    registry: Object.fromEntries([...resolved.doi, ...resolved.pmid].map(([key, value]) => [key, value.status])),
  });
}

for (const item of cases.numeric.filter(wanted)) {
  const { findings } = numericTraceFindings({ reportText: item.report, outputs: item.outputs });
  const unsupported = findings.filter((finding) => finding.verdict === "unsupported").flatMap((finding) => finding.numbers);
  record("numeric", item.id, same(unsupported, item.expectUnsupported), { unsupported });
}

for (const item of cases.editor.filter(wanted)) {
  const { findings, dropped } = acceptEditorFindings(item.raw, { haystacks: [item.haystack] });
  const silent = editorSaidNothing(item.raw, Number(item.asked ?? 0));
  record("editor", item.id, findings.length === item.expectKept && same(dropped.map((entry) => entry.reason), item.expectDropped) && silent === Boolean(item.expectSilent), {
    kept: findings.length, dropped: dropped.map((entry) => entry.reason), silent,
  });
}

const apiKey = values.live ? (await readFile(values["key-file"], "utf8")).trim() : "";
const review = pins.dashscope.review;
const modelConfig = { dashscopeApiKey: apiKey, reviewModel: review.model, reviewApiBase: review.apiBase };
/**
 * A model call as the control plane makes it: one retry after a pause when
 * the provider's failure is transient; a second failure is the case's result.
 * @param {Parameters<typeof callReviewModel>[1]} call
 * @returns {Promise<(Awaited<ReturnType<typeof callReviewModel>> | { error: any }) & { ms: number }>}
 */
const ask = async (call) => {
  const started = Date.now();
  const answer = await callReviewModel({ config: modelConfig }, call).catch(async (error) => {
    if (!error?.retryable) return { error };
    await new Promise((done) => setTimeout(done, 5_000));
    return callReviewModel({ config: modelConfig }, call).catch((again) => ({ error: again }));
  });
  return { ...answer, ms: Date.now() - started };
};
/** @param {any} error */
const failure = (error) => ({ error: error?.code ?? String(error), note: `model call failed: ${error?.message ?? error}` });

// The reply check, with the control plane's own prompt, sources and schema.
for (const item of cases.replies.filter(wanted)) {
  const tier = replyReviewTier(item.reply);
  const { sentences, references } = replyCitedSentences(item.reply);
  // A cited reply whose sentences are not read is a check that judged nothing.
  const tierOk = tier.tier === item.expectTier && (item.expectCitedSentences == null || sentences.length === item.expectCitedSentences);
  if (!values.live || !item.expectLiveVerdict) {
    record("replies", item.id, tierOk, { tier: tier.tier, medicines: tier.medicines, citedSentences: sentences.length });
    continue;
  }
  const cited = references.filter((reference) => sentences.some((sentence) => sentence.numbers.includes(reference.number)));
  const readable = await /** @type {any} */ (resolver).sourceTexts(cited);
  for (let sample = 1; sample <= samples; sample += 1) {
    const answer = await ask({
      userId: "eval", projectId: "eval",
      messages: [{ role: "system", content: replySystemPrompt() }, { role: "user", content: replyMessage({ sentences, references: cited, readable }) }],
      schema: REPLY_CHECK_OUTPUT_SCHEMA, schemaName: "reply_check", thinking: { enabled: false }, maxTokens: 4_000, timeoutMs: 90_000,
    });
    if ("error" in answer) {
      record("replies", sampled(item.id, sample), false, failure(answer.error));
      continue;
    }
    const verdicts = acceptReplyVerdicts(answer.value, { sentences, readable });
    record("replies", sampled(item.id, sample), tierOk && verdicts[0]?.verdict === item.expectLiveVerdict, {
      tier: tier.tier, verdicts, raw: answer.value, cost: answer.cost, model: answer.model, sourcesRead: readable.size, ms: answer.ms,
      note: `${verdicts[0]?.verdict ?? "none"}${verdicts[0]?.safety && verdicts[0].safety !== "none" ? ` / safety ${verdicts[0].safety}` : ""}`,
    });
  }
}

// The editor, with the control plane's own system prompt, submission and
// schema, thinking as configured: planted defects found, a faithful claim left alone.
for (const item of values.live ? (cases.editorLive ?? []).filter(wanted) : []) for (let sample = 1; sample <= samples; sample += 1) {
  const files = new Map([["report.md", item.report]]);
  const checklist = checklistFor(item.contractKind);
  const packageText = [...files.entries()].map(([name, text]) => `${name}\n${text}`).join("\n\n");
  // The sources as the control plane shows them: each case source is written
  // into a scratch workspace and read back through claimsWithSources, so the
  // eval measures the production window, not the case's own excerpt.
  const scratch = await mkdtemp(join(tmpdir(), "tiered-review-"));
  const matrix = { claims: [] };
  for (const claim of item.claims) {
    for (const source of claim.sources) {
      const artifactPath = `.evimed-sources/eval/${source.artifactPath.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
      await mkdir(dirname(join(scratch, artifactPath)), { recursive: true });
      await writeFile(join(scratch, artifactPath), values.narrow ? narrowed(source.text, source.quote) : source.text);
      /** @type {any[]} */ (matrix.claims).push({ claimId: claim.claimId, claimType: claim.claimType, claim: claim.claim, artifactPath, supportQuote: source.quote, sourceTitle: source.title });
    }
  }
  const { claims, sources } = await claimsWithSources(scratch, JSON.stringify(matrix));
  await rm(scratch, { recursive: true, force: true });
  const haystacks = [packageText, ...sources.map((source) => source.text)];
  const answer = await ask({
    userId: "eval", projectId: "eval",
    messages: [
      { role: "system", content: editorSystemPrompt({ safety: true, pass: 1 }) },
      { role: "user", content: editorMessage({
        contractKind: item.contractKind, deliverableId: "eval", tier: { tier: "L2", safety: true }, files, claims, sources, checklist, acceptanceItems: [],
        deterministic: { references: null, referenceFindings: [], numeric: null, stats: [] }, previousFindings: [],
      }) },
    ],
    schema: reviewEditorSchema({ checklistIds: checklist.map((entry) => entry.id), acceptanceCount: 0 }), schemaName: "review_findings",
    thinking: { enabled: true, budget: Number(review.thinkingBudget) }, maxTokens: 24_000, timeoutMs: 900_000,
  });
  if ("error" in answer) {
    record("editor-live", sampled(item.id, sample), false, failure(answer.error));
    continue;
  }
  const { findings, dropped } = acceptEditorFindings(answer.value, { haystacks, idPrefix: "E" });
  const checks = acceptEditorChecks(answer.value, { haystacks, checklistItems: checklist, acceptanceItems: [] });
  /** @param {string} claimId */
  const about = (claimId) => {
    const claim = item.claims.find((/** @type {any} */ entry) => entry.claimId === claimId);
    const texts = [claim.claim, ...claim.sources.map((/** @type {any} */ source) => source.text)];
    return findings.filter((finding) => finding.location.includes(claimId) || texts.some((text) => text.includes(finding.evidence)));
  };
  const found = item.expectFound.map((/** @type {any} */ want) => ({ ...want, hit: about(want.claimId).some((finding) => want.kinds.includes(finding.kind)) }));
  const clean = item.expectClean.map((/** @type {any} */ want) => ({
    ...want,
    flagged: about(want.claimId)
      .filter((finding) => want.kinds.includes(finding.kind) || (want.forbidFix && new RegExp(want.forbidFix).test(finding.fix)))
      .map((finding) => `${finding.kind}: ${finding.fix.slice(0, 60)}`),
  }));
  const silent = editorSaidNothing(answer.value, checklist.length);
  record("editor-live", sampled(item.id, sample), !silent && found.every((entry) => entry.hit) && clean.every((entry) => !entry.flagged.length), {
    found, clean, findings, dropped, raw: answer.value, checklist: checks.checklist, usage: answer.usage, cost: answer.cost, model: answer.model, reasoningChars: answer.reasoningChars, ms: answer.ms,
    silent, checklistAnswered: checks.returned.checklist,
    note: `${silent ? "SAID NOTHING; " : ""}${findings.length} kept, ${dropped.length} dropped; checklist ${checks.returned.checklist}/${checklist.length}; planted ${found.filter((entry) => entry.hit).length}/${found.length}; false alarms ${clean.flatMap((entry) => entry.flagged).length}; ¥${answer.cost.toFixed(3)}; ${Math.round(answer.ms / 1000)} s`,
  });
}

/** The source as the first shipped window showed it: ±300 characters around the quote. @param {string} text @param {string} quote */
function narrowed(text, quote) {
  const at = text.indexOf(quote.slice(0, 40));
  return at < 0 ? text.slice(0, 600) : text.slice(Math.max(0, at - 300), at + quote.length + 300);
}

const failed = results.filter((result) => !result.pass).length;
await mkdir(join(here, "results"), { recursive: true });
const file = join(here, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}${values.live ? "-live" : ""}${values.narrow ? "-narrow" : ""}.json`);
await writeFile(file, `${JSON.stringify({ live: values.live, narrow: values.narrow, model: values.live ? pins.dashscope.review.model : null, passed: results.length - failed, failed, results }, null, 2)}\n`);
process.stdout.write(`\n${results.length - failed}/${results.length} passed; ${file}\n`);
process.exitCode = failed ? 1 : 0;
