// The citation gift (evidence-flywheel F07): an interface that does nothing until the owner chooses an amount, and, once on,
// a gifted lot through the credits service's own grant entry point, once per card and milestone.
import assert from "node:assert/strict";
import test from "node:test";
import { EVIDENCE_CITATION_GIFT_DAYS, EVIDENCE_CITATION_MILESTONES, createCitationGift } from "../src/evidenceCitationGift.mjs";
import { evidencePublishMetricFamilies, resetEvidencePublishMetrics } from "../src/evidencePublishMetrics.mjs";

const CARD = "ec_0123456789abcdef";
const gifts = () => evidencePublishMetricFamilies({ citationGiftEnabled: false }).find((family) => family.name === "open_science_evidence_citation_gifts_total").series;

test("off by default: the hook returns before it asks the wallet or counts anything", async () => {
  resetEvidencePublishMetrics();
  let asked = 0;
  const grant = async () => { asked += 1; return {}; };
  for (const config of [{}, { evidenceCitationGiftEnabled: false, evidenceCitationGiftAmount: 5 }, { evidenceCitationGiftEnabled: true, evidenceCitationGiftAmount: 0 }, { evidenceCitationGiftEnabled: true }]) {
    const hook = createCitationGift({ config, grant });
    assert.deepEqual(await hook({ cardId: CARD, authorId: "alice", count: 10 }), { status: "off" }, JSON.stringify(config));
  }
  assert.equal(asked, 0);
  assert.ok(gifts().every((entry) => entry.value === 0));
});

test("on, a milestone grants one gifted lot to the author through the wallet's grant entry point, once per card and count", async () => {
  resetEvidencePublishMetrics();
  const asked = /** @type {any[]} */ ([]);
  const reports = /** @type {any[]} */ ([]);
  let duplicate = false;
  const hook = createCitationGift({
    config: { evidenceCitationGiftEnabled: true, evidenceCitationGiftAmount: 12.5 },
    grant: async (accountId, grant) => { asked.push([accountId, grant]); return { duplicate }; },
    report: (event, detail) => reports.push([event, detail]),
  });
  assert.deepEqual(await hook({ cardId: CARD, authorId: "alice", count: 10 }), { status: "granted" });
  const [accountId, grant] = asked[0];
  assert.equal(accountId, "alice");
  assert.equal(grant.source, "campaign", "an operator grant's own source");
  assert.equal(grant.amount, "12.5");
  assert.equal(grant.days, EVIDENCE_CITATION_GIFT_DAYS);
  assert.match(grant.requestId, /^[A-Za-z0-9_-]{8,64}$/, "the wallet's own request id shape");
  assert.match(grant.note, /被其他研究者的研究引用 10 次/);
  duplicate = true;
  assert.deepEqual(await hook({ cardId: CARD, authorId: "alice", count: 10 }), { status: "duplicate" });
  assert.equal(asked[1][1].requestId, grant.requestId, "the same crossing is the same request");
  duplicate = false;
  await hook({ cardId: CARD, authorId: "alice", count: 50 });
  assert.notEqual(asked[2][1].requestId, grant.requestId, "another milestone is another gift");
  assert.deepEqual(gifts().map((entry) => [entry.labels.outcome, entry.value]), [["granted", 2], ["duplicate", 1], ["failed", 0]]);
  assert.equal(reports[0][0], "evidence.citation_gift");
  assert.ok(!JSON.stringify(reports).includes("被其他研究者"), "the audit line never carries the note's text");
});

test("what is not a milestone, or not a card, is ignored, and a wallet that fails is a counted outcome that throws into nothing", async () => {
  resetEvidencePublishMetrics();
  let asked = 0;
  const failing = createCitationGift({
    config: { evidenceCitationGiftEnabled: true, evidenceCitationGiftAmount: 1 },
    grant: async () => { asked += 1; throw Object.assign(new Error("wallet down"), { code: "evimed_credits_unreachable" }); },
  });
  assert.deepEqual(await failing({ cardId: CARD, authorId: "alice", count: 3 }), { status: "ignored" });
  assert.deepEqual(await failing({ cardId: "not-a-card", authorId: "alice", count: 10 }), { status: "ignored" });
  assert.deepEqual(await failing({ cardId: CARD, authorId: "", count: 10 }), { status: "ignored" });
  assert.equal(asked, 0);
  assert.deepEqual(await failing({ cardId: CARD, authorId: "alice", count: 10 }), { status: "failed" });
  assert.equal(gifts().find((entry) => entry.labels.outcome === "failed").value, 1);
  const noWallet = createCitationGift({ config: { evidenceCitationGiftEnabled: true, evidenceCitationGiftAmount: 1 }, grant: null });
  assert.deepEqual(await noWallet({ cardId: CARD, authorId: "alice", count: 10 }), { status: "unavailable" });
  assert.deepEqual([...EVIDENCE_CITATION_MILESTONES], [10, 50, 200]);
});
