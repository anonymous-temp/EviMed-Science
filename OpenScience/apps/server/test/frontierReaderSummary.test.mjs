// The reader's fourth text and the give-up of an unreadable item, without a database (c2-gaps G2, G11, 2026-10-25): what an
// item with no full text, abstract or page excerpt is read from, built from the record shapes the plugin delivers, and when an item
// that still has nothing to read leaves the queue.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FRONTIER_READER_SOURCES,
  FRONTIER_READER_TEXT_SOURCES,
  FRONTIER_SUMMARY_TEXT_MIN,
  FRONTIER_TEXT_GIVE_UP_MS,
  frontierItemReadable,
  frontierReaderText,
  frontierSummaryText,
  frontierTextGivenUp,
} from "../src/frontierPipeline.mjs";
import { buildLeadInput, frontierLeadLimit, verifyLead } from "../src/frontierLead.mjs";
import { buildBriefInput } from "../src/frontierBrief.mjs";
import { frontierSettledParagraphs, frontierTidyBasis } from "../src/frontierReaderTidy.mjs";

const registry = { id: "openfda-drugsfda-api", access: "json-api", source_type: "regulator", safety_feed: false };
const guidelines = { id: "prepare-guideline-registry", access: "json-api", source_type: "evidence-body", safety_feed: false };
const medwatch = { id: "fda-medwatch", access: "rss", source_type: "regulator", safety_feed: true };
const media = { id: "m-stat", access: "rss", source_type: "media", safety_feed: false };

// The shapes below are the plugin's own (knowledge_plugin/adapters/json_api.py `parse_openfda_drugsfda`, `parse_openfda_shortages`,
// `parse_prepare`; the contract fixture identity-fda.json), as the platform stores them after the ingest's whitelist.
const drugsfda = {
  title_raw: "FDA approval: ZILBRYSQ — NDA216834 SUPPL-15 (Efficacy)", doi: null, pmid: null, defects: ["link-derived"],
  summary_raw: "Sponsor: UCB INC. Products: ZILBRYSQ INJECTABLE SUBCUTANEOUS ZILUCOPLAN SODIUM EQ 16.6MG BASE/0.416ML. Review priority: STANDARD. "
    + "Documents: Letter: https://www.accessdata.fda.gov/drugsatfda_docs/appletter/2026/216834Orig1s015ltr.pdf; Label: https://www.accessdata.fda.gov/drugsatfda_docs/label/2026/216834s015lbl.pdf.",
  facts: { fda_application: "NDA216834", fda_supplement: "SUPPL-15", sponsor: "UCB INC" },
};
const shortage = {
  title_raw: "Drug shortage (To Be Discontinued): Molnupiravir Capsule — Merck Sharp & Dohme LLC", doi: null, pmid: null, defects: ["link-derived"],
  summary_raw: "Molnupiravir Capsule, 200 mg, NDC 0006-5055-06. Status: To Be Discontinued. Therapeutic category: Anti-Infective. Reason: Discontinuation of the manufacture of the drug.",
  facts: { fda_application: "EUA", sponsor: "Merck Sharp & Dohme LLC" },
};
const prepare = {
  title_raw: "毛发移植团队序贯培养模式中国专家共识", doi: null, pmid: null, defects: ["link-derived"], registry_ids: ["PREPARE-2025CN1821"],
  summary_raw: "中华医学会医学美学与美容学分会毛发医学学组。规范毛发移植团队的序贯培养路径，明确各阶段培训内容与考核要求。Type: guideline; stage: published; version: original; registration number PREPARE-2025CN1821.",
  facts: { sponsor: "中华医学会医学美学与美容学分会毛发医学学组" },
};

test("a registry record is read from its own description, its links out, and the facts it does not already say", () => {
  const text = frontierSummaryText(drugsfda, registry);
  assert.ok(text);
  assert.match(text, /^Sponsor: UCB INC\. Products: ZILBRYSQ INJECTABLE SUBCUTANEOUS ZILUCOPLAN SODIUM EQ 16\.6MG BASE\/0\.416ML\. Review priority: STANDARD\./);
  assert.doesNotMatch(text, /https?:|Documents:|accessdata/, "the document addresses are no text");
  // The sponsor is said in the summary; the application and supplement are not, and follow as labelled sentences.
  assert.match(text, /\n\nFDA application: NDA216834\. Supplement: SUPPL-15\.$/);
  assert.equal(text.match(/UCB INC/g)?.length, 1, "a fact the text already says is not said twice");
  // Nothing is written in: every digit run of the text is in the entry.
  const source = `${drugsfda.summary_raw} ${JSON.stringify(drugsfda.facts)}`;
  for (const run of text.match(/\d+/g) ?? []) assert.ok(source.includes(run), run);
});

test("a shortage notice, a guideline registration and a safety notice have their own words as the text", () => {
  assert.match(String(frontierSummaryText(shortage, registry)), /^Molnupiravir Capsule, 200 mg, NDC 0006-5055-06\. Status: To Be Discontinued\./);
  assert.match(String(frontierSummaryText(shortage, registry)), /FDA application: EUA\.$/, "the sponsor is in the title and not in the summary: it is told once, as a fact");
  const guideline = String(frontierSummaryText(prepare, guidelines));
  assert.match(guideline, /^中华医学会医学美学与美容学分会毛发医学学组。规范毛发移植团队的序贯培养路径/);
  assert.doesNotMatch(guideline, /Sponsor:/, "the developer is the first words of the description");
  const notice = { title_raw: "Early Alert: Diagnostic Ultrasound System Issue", doi: null, pmid: null, defects: [],
    summary_raw: "FDA is issuing this early alert because the manufacturer reports 8 complaints of lost scanning on a software issue.", facts: { recall_class: "Class I" } };
  assert.match(String(frontierSummaryText(notice, medwatch)), /8 complaints[^]*Recall class: Class I\.$/, "a safety feed's notice is a text whatever its length");
});

test("only what the publish gate admits without a text has a summary text, and a thin one has none", () => {
  const feed = { title_raw: "Hospital opens a clinic", doi: null, pmid: null, defects: [], summary_raw: "A hospital in Ohio opened an outpatient clinic for 120 patients a week, the third of its kind in the state.", facts: {} };
  assert.ok(frontierSummaryText(feed, media), "a usable feed summary is a text");
  assert.equal(frontierSummaryText({ ...feed, defects: ["truncated-summary"] }, media), null, "a truncated summary is not usable (usableSummary)");
  assert.equal(frontierSummaryText({ ...feed, summary_raw: "Short." }, media), null);
  assert.equal(frontierSummaryText({ ...feed, doi: "10.1000/x", summary_raw: "Short." }, registry), null, "an article is not a record: no record text without a summary");
  assert.equal(frontierSummaryText({ ...drugsfda, summary_raw: null, facts: {} }, registry), null, "a record with nothing to say has no text");
  assert.equal(frontierSummaryText(null, registry), null);
  const thin = frontierSummaryText({ ...drugsfda, summary_raw: null, facts: { sponsor: "UCB" } }, registry);
  assert.equal(thin, null, `under ${FRONTIER_SUMMARY_TEXT_MIN} characters is a label, not a text`);
  // A paragraph of a feed summary survives, and a link inside a sentence of real prose goes without the sentence.
  const prose = frontierSummaryText({ ...feed, summary_raw: "A new rule takes effect on 1 January for 40 hospitals in the region, per the notice at https://example.org/rule today.\n\nA second paragraph says the rule applies to 12 services." }, media);
  assert.match(String(prose), /^A new rule takes effect on 1 January for 40 hospitals in the region, per the notice at today\.\n\nA second paragraph/);
});

test("the summary is the reader's text below the body, the abstract and the excerpt, and never one a translation is made from; the reports of a paper come after it", () => {
  assert.deepEqual([...FRONTIER_READER_SOURCES], ["body", "abstract", "excerpt"]);
  assert.deepEqual([...FRONTIER_READER_TEXT_SOURCES], ["body", "abstract", "excerpt", "summary", "reports"]);
  const summaryOnly = { reader_summary: "Sponsor: UCB INC. Products: ZILBRYSQ.\n\nFDA application: NDA216834." };
  assert.deepEqual(frontierReaderText(summaryOnly), { source: "summary", text: "Sponsor: UCB INC. Products: ZILBRYSQ.\n\nFDA application: NDA216834." });
  assert.equal(frontierReaderText({ ...summaryOnly, body_excerpt: "A page's text." })?.source, "excerpt");
  assert.equal(frontierReaderText({ ...summaryOnly, abstract_raw: "Background: x." })?.source, "abstract");
  assert.equal(frontierReaderText({ reader_summary: "" }), null, "'' says it was looked at and there is nothing");
  assert.equal(frontierReaderText({ reader_summary: "   " }), null);
  assert.equal(frontierReaderText({ body_text: "Full text." }, "summary"), null, "a text asked for by name is that column's");
  // Its verdict is kept for exactly that text, and a verdict on another is not this one's.
  const basis = frontierTidyBasis(summaryOnly, "summary");
  assert.ok(basis && /^[a-f0-9]{64}$/.test(basis.sha));
  assert.equal(frontierTidyBasis({ reader_summary: "Another text entirely." }, "summary")?.sha === basis.sha, false);
  assert.deepEqual(frontierSettledParagraphs(summaryOnly.reader_summary, "summary", { source: "summary", sha: basis.sha, drop: [] }), ["Sponsor: UCB INC. Products: ZILBRYSQ.", "FDA application: NDA216834."]);
  // The item the gate published without a text is still readable by the same rule.
  assert.equal(frontierItemReadable({ texts: summaryOnly, entry: { summary_raw: "x", defects: [] }, source: media }), true);
});

test("the 导读 and 要点 are asked to write from a 来源摘要, and the 导读's numbers are the summary's and the title's", () => {
  const text = String(frontierSummaryText(drugsfda, registry));
  const input = { sourceName: "FDA", date: "2026-10-23", titleRaw: drugsfda.title_raw, titleZh: "FDA批准ZILBRYSQ补充申请", text, kind: /** @type {const} */ ("summary") };
  const lead = buildLeadInput(input);
  assert.match(lead, /\n正文（来源摘要）：\nSponsor: UCB INC\./);
  assert.match(buildBriefInput(input), /\n正文（来源摘要）：\nSponsor: UCB INC\./);
  // Numbers: a lead that restates the application number passes; one that adds a count the source does not hold is refused.
  assert.deepEqual(verifyLead({ lead_zh: "美国食品药品监督管理局批准UCB公司ZILBRYSQ的补充申请NDA216834 SUPPL-15，审评优先级为标准。" }, lead).issues, []);
  const invented = verifyLead({ lead_zh: "美国食品药品监督管理局批准UCB公司ZILBRYSQ的补充申请，批准基于 3 项试验的 99 例患者。" }, lead);
  assert.ok(invented.issues.length > 0, "a number the summary does not hold is the check's to refuse");
  // A short source supports a short 导读 (the limit follows the text, at least 80).
  assert.ok(frontierLeadLimit(text) <= 380 && frontierLeadLimit(text) >= 80);
});

test("an item that still has nothing to read gives up once its entry has waited FRONTIER_TEXT_GIVE_UP_MS (G11)", () => {
  const now = new Date("2026-10-25T04:00:00Z");
  const ago = (ms) => new Date(now.getTime() - ms);
  assert.equal(frontierTextGivenUp({ entry: { received_at: ago(FRONTIER_TEXT_GIVE_UP_MS - 1000) }, now }), false);
  assert.equal(frontierTextGivenUp({ entry: { received_at: ago(FRONTIER_TEXT_GIVE_UP_MS) }, now }), true);
  assert.equal(frontierTextGivenUp({ entry: { received_at: ago(FRONTIER_TEXT_GIVE_UP_MS + 86_400_000).toISOString() }, now }), true, "a stored time as text reads the same");
  // The entry is the clock; the item's first sighting is the clock where no entry is left (its entry was dropped at the same age).
  assert.equal(frontierTextGivenUp({ entry: null, item: { first_seen_at: ago(FRONTIER_TEXT_GIVE_UP_MS * 2) }, now }), true);
  assert.equal(frontierTextGivenUp({ entry: null, item: { first_seen_at: ago(3 * 86_400_000) }, now }), false);
  assert.equal(frontierTextGivenUp({ entry: { received_at: ago(86_400_000) }, item: { first_seen_at: ago(FRONTIER_TEXT_GIVE_UP_MS * 2) }, now }), false,
    "a fresh revision of an old item starts its wait again");
  assert.equal(frontierTextGivenUp({ now }), false, "no time on record is no give-up");
});
