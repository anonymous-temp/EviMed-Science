// The reviewer's source texts are what a reader is later shown as verbatim
// quotes, so they are decoded the way the registry meant them
// (referenceResolver.mjs).
import assert from "node:assert/strict";
import test from "node:test";

import { createReferenceResolver } from "../src/referenceResolver.mjs";

// PubMed's efetch XML for TIM-HF2, as the registry writes it: the Lancet's
// decimal point is a numeric character reference.
const EFETCH = `<?xml version="1.0" ?>
<PubmedArticleSet><PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">30153985</PMID><Article PubModel="Print-Electronic">
<ArticleTitle>Efficacy of telemedical interventional management in patients with heart failure (TIM-HF2): a randomised, controlled, parallel-group, unmasked trial.</ArticleTitle>
<Abstract><AbstractText Label="FINDINGS" NlmCategory="RESULTS">The percentage of days lost due to unplanned cardiovascular hospital admissions and all-cause death was 4&#xb7;88% (95% CI 4&#xb7;55-5&#xb7;23) in the remote patient management group and 6&#xb7;64% (6&#183;19-7&#183;13) in the usual care group; an escaped &amp;#xb7; stays escaped.</AbstractText></Abstract>
</Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">30153985</ArticleId><ArticleId IdType="doi">10.1016/S0140-6736(18)31880-4</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`;

test("a PubMed abstract reaches the reviewer decoded, so the quote a reader sees is the paper's own", async () => {
  /** @type {string[]} */
  const asked = [];
  const resolver = createReferenceResolver({
    fetchImpl: /** @type {any} */ (async (/** @type {string} */ url) => {
      asked.push(new URL(url).pathname);
      return new Response(EFETCH, { status: 200, headers: { "content-type": "application/xml" } });
    }),
  });
  const texts = await resolver.sourceTexts([{ number: 1, text: "Koehler F, et al. TIM-HF2.", pmids: ["30153985"], dois: [], urls: [] }]);
  const text = String(texts.get(1));
  assert.deepEqual(asked, ["/entrez/eutils/efetch.fcgi"]);
  assert.match(text, /^Efficacy of telemedical interventional management/);
  assert.match(text, /FINDINGS: .*was 4·88% \(95% CI 4·55-5·23\) in the remote patient management group and 6·64% \(6·19-7·13\)/, "hex and decimal references both decoded");
  assert.equal(text.includes("&#xb7;"), true, "an escaped reference is decoded once, not twice");
  assert.equal(/\d&#(?:x[0-9a-f]+|\d+);\d/i.test(text), false, "no numeric reference left inside a number");
});
