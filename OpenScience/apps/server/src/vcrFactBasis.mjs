/**
 * Whether two facts of one patient stand on the same words of the chart (the 「58 岁女性」 → 「未妊娠」 incident, 2026-10-29).
 *
 * Hidden knowledge:
 *
 * - **The literal check cannot judge meaning, and this is not a judgement of meaning either.** A fact passes when its quotation is
 *   the document's bytes and its surface is in the quotation; it passes whatever the sentence implies. A run that read 「58岁女性」
 *   saved sex = female, then pregnancy = negated on the surface 「女性」, and the formal judgment rested on both. Whether a text
 *   denies a pregnancy is language; whether two facts claim the *same characters* of the document is arithmetic on offsets, and
 *   that is all that is computed here: the document, the character interval of each fact's surface inside it, the polarity the
 *   fact is reasoned from, and the variable.
 * - **A word that makes one statement does not make its opposite about something else.** An affirmed fact of one variable and a
 *   negated fact of another whose surfaces overlap are two readings of the same characters. It is not always a mistake — 「未绝经」
 *   is both `menopause` negated and `premenopausal` affirmed — so it is a notice beside the write, never a refusal: the fact is
 *   saved, the run is told which two facts share the words, and it decides.
 * - **What it cannot see.** A negated fact on words no other fact uses, or on a surface nobody else read, passes. Only the rule the
 *   run reads where it writes (`FACT_EVIDENCE_RULE`) reaches that case.
 *
 * @module vcrFactBasis
 */

/**
 * The characters a fact stands on, in the document's own offsets: where its surface sits inside its verified quotation.
 * `null` for a fact with no located source (a cell of a frozen snapshot) or whose surface is not in its quotation.
 * @param {{ source?: { documentId?: string, start?: number, quote?: string } | null, surface?: string | null }} fact
 * @returns {{ documentId: string, from: number, to: number } | null}
 */
export function surfaceBasis(fact) {
  const source = fact?.source;
  const surface = typeof fact?.surface === "string" ? fact.surface : "";
  if (!source?.documentId || !Number.isInteger(source.start) || typeof source.quote !== "string" || !surface) return null;
  const at = source.quote.indexOf(surface);
  if (at < 0) return null;
  const from = /** @type {number} */ (source.start) + at;
  return { documentId: String(source.documentId), from, to: from + surface.length };
}

/**
 * The facts of the same patient that stand on the same characters as this one, one an affirmed reading and the other a
 * negated one, about different variables.
 * @param {{ variable: string, polarity: string, basis: { documentId: string, from: number, to: number } | null }} fact
 * @param {ReadonlyArray<{ id?: string, variable: string, polarity: string, basis: { documentId: string, from: number, to: number } | null }>} others
 * @returns {Array<{ id: string | null, variable: string, polarity: string }>}
 */
export function factsOnSameWords(fact, others) {
  if (!fact.basis || !["affirmed", "negated"].includes(fact.polarity)) return [];
  const opposite = fact.polarity === "affirmed" ? "negated" : "affirmed";
  const here = fact.basis;
  return others
    .filter((other) => other.polarity === opposite && other.variable !== fact.variable && other.basis
      && other.basis.documentId === here.documentId && other.basis.from < here.to && here.from < other.basis.to)
    .map((other) => ({ id: other.id ?? null, variable: other.variable, polarity: other.polarity }));
}
