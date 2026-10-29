/**
 * Scoring for the follow-up judge's calibration: case shape, the confusion matrix, per-class precision and recall, the precision of
 * `adopt` on its own, quotation validity, and the learned methods a verdict names. Pure: no model, no network.
 *
 * Hidden knowledge: what a wrong verdict costs is not the same in every cell. A `correction`, `preference` or `rejection` becomes
 * learning evidence and, for a correction, queues a distillation; `adopt` (the person asks that the way just used be kept for future
 * work of this kind) is the strongest of them, because it makes a method out of one conversation. So a false `adopt` is the error
 * that matters most (precision), a missed one costs a second sentence from the person (recall), and the near misses the cases carry —
 * 「这次就这样吧」, 「好的谢谢」, 「记住我喜欢短的」, 「格式就按这个，内容再补两条」, 「顺便帮我查一下 X」 — are the ones the report names.
 *
 * What the module made of the model's answer is what counts: a verdict the module's own parser refuses (`followUpVerdictFrom`
 * answers a failure) is `unreadable` here, as it is in production, where it is no evidence at all.
 */

export const CLASSES = Object.freeze(["correction", "preference", "rejection", "accept", "none", "adopt"]);
/** The classes whose verdict carries a rule and a quotation of the message. */
export const RULE_CLASSES = Object.freeze(["correction", "preference", "rejection", "adopt"]);
export const UNREADABLE = "unreadable";

const squash = (/** @type {unknown} */ text) => String(text ?? "").replace(/\s+/g, "");

/**
 * What is wrong with the case file, or [].
 * @param {readonly any[]} cases
 */
export function caseIssues(cases) {
  /** @type {string[]} */
  const issues = [];
  const ids = new Set();
  for (const item of cases) {
    const where = String(item?.id ?? "?");
    if (!item?.id || ids.has(item.id)) issues.push(`${where}: the id is missing or repeated`);
    ids.add(item?.id);
    if (!CLASSES.includes(item?.class)) issues.push(`${where}: class ${JSON.stringify(item?.class)} is not one of ${CLASSES.join(", ")}`);
    if (!["zh", "en"].includes(item?.lang)) issues.push(`${where}: lang is zh or en`);
    for (const field of ["previousRequest", "delivered", "message"]) {
      if (typeof item?.[field] !== "string" || !item[field].trim()) issues.push(`${where}: ${field} is empty`);
    }
    if (RULE_CLASSES.includes(item?.class)) {
      if (typeof item?.quote !== "string" || !item.quote) issues.push(`${where}: a ${item?.class} carries the gold quotation`);
      else if (!squash(item.message).includes(squash(item.quote))) issues.push(`${where}: the gold quotation is not a substring of the message`);
    } else if (item?.quote) {
      issues.push(`${where}: a ${item?.class} carries no quotation`);
    }
    if (item?.ambiguous === true && !(typeof item.why === "string" && item.why.trim())) issues.push(`${where}: an ambiguous case says why`);
    for (const other of item?.alsoAcceptable ?? []) {
      if (!CLASSES.includes(other) || other === item.class) issues.push(`${where}: alsoAcceptable ${JSON.stringify(other)} is not another class`);
    }
    if (item?.alsoAcceptable?.length && item.ambiguous !== true) issues.push(`${where}: a second acceptable class is a hesitation, so the case is ambiguous`);
    const opened = new Set((item?.methodsOpened ?? []).map((/** @type {any} */ method) => method.id));
    for (const id of item?.concerns ?? []) if (!opened.has(id)) issues.push(`${where}: concerns ${JSON.stringify(id)} is not a method the run opened`);
    if (item?.concerns && !item?.methodsOpened) issues.push(`${where}: concerns without methodsOpened`);
  }
  return issues;
}

/**
 * @typedef {{ id: string, lang: string, gold: string, alsoAcceptable: string[], ambiguous: boolean, predicted: string, failure: string | null,
 *   rawVerdict: string | null, quote: string | null, goldQuote: string | null, concerns: string[], goldConcerns: string[] | null, tag?: string,
 *   adoptCheck?: "confirmed" | "disagreed" | null }} Result
 */

/** Whether a result is right: the gold class, or (lenient) a class the label allows. @param {Result} result @param {boolean} [lenient] */
export function isRight(result, lenient = false) {
  return result.predicted === result.gold || (lenient && result.alsoAcceptable.includes(result.predicted));
}

/** Gold rows × predicted columns, `unreadable` last. @param {readonly Result[]} results */
export function confusion(results) {
  /** @type {Record<string, Record<string, number>>} */
  const matrix = Object.fromEntries(CLASSES.map((gold) => [gold, Object.fromEntries([...CLASSES, UNREADABLE].map((predicted) => [predicted, 0]))]));
  for (const result of results) matrix[result.gold][CLASSES.includes(result.predicted) ? result.predicted : UNREADABLE] += 1;
  return matrix;
}

/** @param {number} numerator @param {number} denominator */
const ratio = (numerator, denominator) => (denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 1000);

/** Precision, recall and F1 per class, on the gold labels alone. @param {readonly Result[]} results */
export function perClass(results) {
  const matrix = confusion(results);
  return Object.fromEntries(CLASSES.map((cls) => {
    const truePositive = matrix[cls][cls];
    const predicted = CLASSES.reduce((sum, gold) => sum + matrix[gold][cls], 0);
    const support = Object.values(matrix[cls]).reduce((sum, count) => sum + count, 0);
    const precision = ratio(truePositive, predicted);
    const recall = ratio(truePositive, support);
    const f1 = precision !== null && recall !== null && precision + recall > 0 ? Math.round((2 * precision * recall) / (precision + recall) * 1000) / 1000 : null;
    return [cls, { support, predicted, truePositive, precision, recall, f1 }];
  }));
}

/**
 * `adopt` on its own, because it triggers learning: how often a predicted adopt is one (precision, strict and with the labels' own
 * second choices), how often a real one is found, and the cases that were wrongly adopted, named.
 * @param {readonly Result[]} results
 */
export function adoptReport(results) {
  const predictedAdopt = results.filter((result) => result.predicted === "adopt");
  const gold = results.filter((result) => result.gold === "adopt");
  const right = predictedAdopt.filter((result) => result.gold === "adopt");
  const rightLenient = predictedAdopt.filter((result) => result.gold === "adopt" || result.alsoAcceptable.includes("adopt"));
  return {
    predicted: predictedAdopt.length, gold: gold.length, correct: right.length,
    precision: ratio(right.length, predictedAdopt.length), precisionLenient: ratio(rightLenient.length, predictedAdopt.length),
    recall: ratio(gold.filter((result) => result.predicted === "adopt").length, gold.length),
    falseAdopts: predictedAdopt.filter((result) => !rightLenient.includes(result)).map((result) => ({ id: result.id, gold: result.gold, tag: result.tag ?? null })),
    missedAdopts: gold.filter((result) => result.predicted !== "adopt").map((result) => ({ id: result.id, predicted: result.predicted })),
    // The second reading of every first-reading `adopt` (examples in the other order): it stood, or it did not.
    checks: { confirmed: results.filter((result) => result.adoptCheck === "confirmed").length, disagreed: results.filter((result) => result.adoptCheck === "disagreed").length },
  };
}

/**
 * Quotations. Among the cases whose gold class carries one: how many the module accepted (a quotation that is not a substring of the
 * message is `quote_not_found`, no evidence at all), and of those that it accepted, how many overlap the gold quotation.
 * @param {readonly Result[]} results
 */
export function quoteReport(results) {
  const carrying = results.filter((result) => RULE_CLASSES.includes(result.gold));
  const accepted = carrying.filter((result) => typeof result.quote === "string" && result.quote);
  const notFound = results.filter((result) => result.failure === "quote_not_found");
  const overlapping = accepted.filter((result) => {
    const mine = squash(result.quote);
    const gold = squash(result.goldQuote);
    return Boolean(gold) && (mine.includes(gold) || gold.includes(mine));
  });
  return {
    carrying: carrying.length, accepted: accepted.length, quoteNotFound: notFound.length,
    validRate: ratio(accepted.length, accepted.length + notFound.length), overlapsGold: overlapping.length, overlapRate: ratio(overlapping.length, accepted.length),
  };
}

/** The learned methods a verdict names, over the cases whose run opened one. @param {readonly Result[]} results */
export function concernReport(results) {
  const withMethods = results.filter((result) => result.goldConcerns !== null);
  const exact = withMethods.filter((result) => {
    const mine = [...result.concerns].sort().join("\u0000");
    return mine === [...(result.goldConcerns ?? [])].sort().join("\u0000");
  });
  return { cases: withMethods.length, exact: exact.length, rate: ratio(exact.length, withMethods.length),
    wrong: withMethods.filter((result) => !exact.includes(result)).map((result) => ({ id: result.id, said: result.concerns, gold: result.goldConcerns })) };
}

/** Everything the report prints. @param {readonly Result[]} results */
export function summarize(results) {
  const settled = results.filter((result) => result.failure !== "model_failed");
  const clear = settled.filter((result) => !result.ambiguous);
  /** @type {Record<string, number>} */
  const failures = {};
  for (const result of results) if (result.failure) failures[result.failure] = (failures[result.failure] ?? 0) + 1;
  /** @type {Record<string, any>} */
  const byLang = {};
  for (const lang of ["zh", "en"]) {
    const mine = settled.filter((result) => result.lang === lang);
    byLang[lang] = { n: mine.length, accuracy: ratio(mine.filter((result) => isRight(result)).length, mine.length) };
  }
  return {
    cases: results.length, modelFailed: results.length - settled.length,
    accuracy: ratio(settled.filter((result) => isRight(result)).length, settled.length),
    accuracyLenient: ratio(settled.filter((result) => isRight(result, true)).length, settled.length),
    accuracyOnUnambiguous: ratio(clear.filter((result) => isRight(result)).length, clear.length),
    unambiguous: clear.length, byLang, failures,
    perClass: perClass(settled), confusion: confusion(settled), adopt: adoptReport(settled), quotes: quoteReport(settled), concerns: concernReport(settled),
    wrong: settled.filter((result) => !isRight(result, true)).map((result) => ({ id: result.id, gold: result.gold, predicted: result.predicted, failure: result.failure, rawVerdict: result.rawVerdict, tag: result.tag ?? null })),
  };
}

/** The text report. @param {ReturnType<typeof summarize>} summary */
export function render(summary) {
  const pct = (/** @type {number | null} */ value) => (value === null ? "  - " : value.toFixed(2));
  const lines = [
    `cases ${summary.cases} (model failures ${summary.modelFailed}); accuracy ${pct(summary.accuracy)}, lenient ${pct(summary.accuracyLenient)}, on the ${summary.unambiguous} unambiguous ${pct(summary.accuracyOnUnambiguous)}; zh ${pct(summary.byLang.zh.accuracy)}, en ${pct(summary.byLang.en.accuracy)}`,
    `module refusals: ${Object.keys(summary.failures).length ? JSON.stringify(summary.failures) : "none"}`,
    "",
    `${"class".padEnd(11)} ${"support".padStart(7)} ${"predicted".padStart(9)} ${"precision".padStart(9)} ${"recall".padStart(7)} ${"f1".padStart(5)}`,
    ...CLASSES.map((cls) => {
      const row = summary.perClass[cls];
      return `${cls.padEnd(11)} ${String(row.support).padStart(7)} ${String(row.predicted).padStart(9)} ${pct(row.precision).padStart(9)} ${pct(row.recall).padStart(7)} ${pct(row.f1).padStart(5)}`;
    }),
    "",
    `confusion (gold ↓, predicted →): ${[...CLASSES, UNREADABLE].join(" / ")}`,
    ...CLASSES.map((gold) => `${gold.padEnd(11)} ${[...CLASSES, UNREADABLE].map((predicted) => String(summary.confusion[gold][predicted]).padStart(4)).join(" ")}`),
    "",
    `adopt: predicted ${summary.adopt.predicted}, right ${summary.adopt.correct} → precision ${pct(summary.adopt.precision)} (with the labels' second choices ${pct(summary.adopt.precisionLenient)}), recall ${pct(summary.adopt.recall)}`,
    `  false adopts: ${summary.adopt.falseAdopts.map((item) => `${item.id}(${item.gold}${item.tag ? `, ${item.tag}` : ""})`).join(" ") || "none"}`,
    `  missed adopts: ${summary.adopt.missedAdopts.map((item) => `${item.id}→${item.predicted}`).join(" ") || "none"}`,
    `  second reading of an adopt: confirmed ${summary.adopt.checks.confirmed}, disagreed ${summary.adopt.checks.disagreed}`,
    `quotations: accepted ${summary.quotes.accepted} of ${summary.quotes.carrying} that should carry one; not a substring ${summary.quotes.quoteNotFound}; valid ${pct(summary.quotes.validRate)}; overlap the gold ${pct(summary.quotes.overlapRate)}`,
    `methods named: exact ${summary.concerns.exact} of ${summary.concerns.cases}`,
    "",
    `wrong (even leniently): ${summary.wrong.map((item) => `${item.id} ${item.gold}→${item.predicted}${item.rawVerdict && item.rawVerdict !== item.predicted ? `(raw ${item.rawVerdict})` : ""}`).join(", ") || "none"}`,
  ];
  return lines.join("\n");
}
