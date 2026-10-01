import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createEvidenceSourceReader } from "../src/evidenceSourceReader.mjs";
import {
  evidenceStructuredContent,
  evidenceHash,
  evidencePublicExcerpt,
} from "../src/evidenceCardContent.mjs";

test("primary abstract reader retains stable scholarly text, raw byte hash and honest coverage", async () => {
  const raw = Buffer.from(
    JSON.stringify({
      resultList: {
        result: [
          {
            id: "12345",
            source: "MED",
            title: "A randomized trial",
            abstractText:
              "<h4>Background</h4><p>A primary trial.</p><h4>Results</h4><p>Benefit was observed.</p>",
          },
        ],
      },
    }),
  );
  const visited = [];
  const reader = createEvidenceSourceReader({
    userAgent: "EviMedBot",
    readWeb: async () => {
      throw new Error("Page chrome must not define scholarly source identity.");
    },
    transport: async ({ url }) => {
      visited.push(url.href);
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body:
          url.pathname === "/robots.txt"
            ? Buffer.from("User-agent: *\nAllow: /\n")
            : raw,
      };
    },
  });
  const result = await reader("https://pubmed.ncbi.nlm.nih.gov/12345/");
  assert.equal(
    result.text,
    "Background A primary trial. Results Benefit was observed.",
  );
  assert.equal(result.coverage, "abstract");
  assert.equal(
    result.receipt.sha256,
    createHash("sha256").update(raw).digest("hex"),
  );
  assert.equal(visited.length, 2);
  assert.match(result.receipt.finalUrl, /europepmc\/webservices/);
});
test("non-scholarly primary pages use the existing web reader", async () => {
  const reader = createEvidenceSourceReader({
    userAgent: "EviMedBot",
    readWeb: async (url) => ({ text: "Official notice", url }),
    transport: async () => {
      throw new Error("Not a scholarly API request");
    },
  });
  assert.equal(
    (await reader("https://www.fda.gov/drugs/notice")).text,
    "Official notice",
  );
});
test("risk and rate comparison units must match their measure", () => {
  const comparison = {
    title: "Outcome",
    outcome: "Events",
    timeframe: "Annualized",
    denominator: 100,
    control: { label: "Control", events: 3.09 },
    intervention: { label: "Treatment", events: 2.13 },
    sourceIndexes: [1],
    measure: "rate",
    denominatorUnit: "person-years",
  };
  assert.ok(evidenceStructuredContent({ comparisons: [comparison] }, 1));
  assert.throws(
    () =>
      evidenceStructuredContent(
        { comparisons: [{ ...comparison, denominatorUnit: "people" }] },
        1,
      ),
    { code: "evidence_invalid" },
  );
  assert.throws(
    () =>
      evidenceStructuredContent(
        { comparisons: [{ ...comparison, measure: "risk" }] },
        1,
      ),
    { code: "evidence_invalid" },
  );
});

test("scientific hashes survive JSONB key ordering and nested malformed content is a 400", () => {
  assert.equal(
    evidenceHash({ question: "Q", population: "Adults", answer: "A" }),
    evidenceHash({ answer: "A", question: "Q", population: "Adults" }),
  );
  for (const key of ["sections", "tables", "comparisons"])
    assert.throws(() => evidenceStructuredContent({ [key]: [null] }, 1), {
      code: "evidence_invalid",
    });
});

test("public quote anchors remain bounded for Chinese sources without spaces", () => {
  const paragraph =
    "临床研究报告了患者人群与随访结果，需要结合适用范围理解结论。".repeat(1000);
  const anchor = evidencePublicExcerpt(paragraph);
  assert.ok(anchor.length <= 300);
  assert.ok(anchor.length < paragraph.length);
  const words = [
    ...new Intl.Segmenter("zh", { granularity: "word" }).segment(anchor),
  ].filter((segment) => segment.isWordLike);
  assert.ok(words.length <= 25);
  assert.ok(paragraph.includes(anchor));
  const short = "需要结合适用范围理解结论。";
  assert.equal(evidencePublicExcerpt(paragraph, short), short);
  const english = Array.from(
    { length: 100 },
    (_, index) => `word${index}`,
  ).join(" ");
  assert.equal(evidencePublicExcerpt(english).split(/\s+/).length, 25);
});
