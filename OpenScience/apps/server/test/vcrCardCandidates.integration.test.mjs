// Flywheel F23 (2026-10-06): an evidence item may say which evidence card led a run to it. The card is a lead and nothing else —
// the item is checked against the registry record the study holds exactly as before, the field is stored and shown and read by no
// verdict, and an item whose source is a card's own page is refused by a named code.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { skipWithoutDatabase, startVcr } from "./helpers/vcrFlywheelFixture.mjs";

/** @type {Awaited<ReturnType<typeof startVcr>>} */
let fixture;
/** @type {any} */
let study;
const USER = "u-cand";
const QUOTE = "protocolSection.designModule.enrollmentInfo.count: 674";
const ITEM = { registryId: "NCT02296125", parameter: "enrollment_actual", armRole: "overall", value: 674, unit: "participants", quote: QUOTE, endpointKey: "enrollment" };

before(async () => {
  if (!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL) return;
  fixture = await startVcr({ label: "vcrcand", config: { publicUrl: "https://science.example/ev/" } });
  study = await fixture.vcr.store.createStudy({ userId: USER, projectId: "prj-cand", name: "EV-301 卡片候选", question: "q", dataTier: "T0" });
  await fixture.write(study, "precedent", [{ registryId: "NCT02296125" }]);
});
after(async () => { await fixture?.close(); });

test("a candidate found through a card is stored with its provenance and shown on the item", skipWithoutDatabase, async () => {
  const written = await fixture.write(study, "evidence_item", [{ ...ITEM, candidateFrom: { cardId: "card_abc123", claimId: "CLM-1" } }]);
  assert.equal(written.ok, true);
  assert.equal(written.results[0].verified, true);
  const [row] = (await fixture.vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id, parameter: "enrollment_actual" }))
    .filter((entry) => entry.locator?.authoredBy === "run");
  assert.deepEqual(row.detail.candidateFrom, { cardId: "card_abc123", claimId: "CLM-1" });
  const read = await fixture.vcr.evidence.evidenceRead(study, { kind: "enrollment_actual" });
  assert.deepEqual(read.items.find((entry) => entry.id === row.id)?.candidateFrom, { cardId: "card_abc123", claimId: "CLM-1" });
  assert.deepEqual(fixture.vcr.evidence.counters, { cardCandidates: 1, cardCandidatesVerified: 1 });
});

test("a card is never trusted: the item is checked against the record like any other, and a failing one counts as written but not verified", skipWithoutDatabase, async () => {
  const before = { ...fixture.vcr.evidence.counters };
  // The number is the card's, not the record's: the item fails the same check an item without a card would.
  const wrong = await fixture.write(study, "evidence_item", [{ ...ITEM, value: 999, candidateFrom: { cardId: "card_abc123" } }]);
  assert.equal(wrong.results[0].verified, false);
  assert.equal(wrong.issues[0].code, "vcr_evidence_unverified");
  const unmarked = await fixture.write(study, "evidence_item", [{ ...ITEM, value: 999 }]);
  assert.equal(unmarked.results[0].state, wrong.results[0].state, "the verdict is the same with or without a card");
  assert.deepEqual(fixture.vcr.evidence.counters, { cardCandidates: before.cardCandidates + 1, cardCandidatesVerified: before.cardCandidatesVerified });
  const [stored] = (await fixture.vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id, parameter: "enrollment_actual" }))
    .filter((entry) => entry.id === wrong.ids[0]);
  assert.equal(stored.value, null, "a refused value keeps no number");
});

test("an item whose source is a card's page is refused by name, whole, and nothing is stored", skipWithoutDatabase, async () => {
  const count = async () => (await fixture.vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id })).length;
  const stored = await count();
  for (const source of ["https://www.evimed.com/evidence/c/card_abc123", "/evidence/c/card_abc123", "https://science.example/ev/evidence/c/card_abc123?view=clinical"]) {
    const refused = await fixture.write(study, "evidence_item", [{ ...ITEM, source }]);
    assert.equal(refused.ok, false, source);
    assert.deepEqual(refused.issues.map((issue) => [issue.field, issue.code]), [["source", "vcr_evidence_source_is_card"]], source);
  }
  assert.equal(await count(), stored, "no row, not even a refused one, for an item that names a card as its source");
  // The primary source a card points at is what an item may name.
  const accepted = await fixture.write(study, "evidence_item", [{ ...ITEM, source: "https://doi.org/10.1056/NEJMoa1713137" }]);
  assert.equal(accepted.ok, true);
  const [row] = (await fixture.vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id })).filter((entry) => entry.id === accepted.ids[0]);
  assert.equal(row.detail.source, "https://doi.org/10.1056/NEJMoa1713137");
});

test("candidateFrom carries a card id and nothing else", skipWithoutDatabase, async () => {
  for (const candidateFrom of [{ cardId: "card_abc123", quote: "a number the card said" }, { claimId: "CLM-1" }, { cardId: "has spaces" }, "card_abc123"]) {
    const refused = await fixture.write(study, "evidence_item", [{ ...ITEM, candidateFrom }]);
    assert.equal(refused.ok, false, JSON.stringify(candidateFrom));
    assert.equal(refused.issues[0].field.startsWith("candidateFrom"), true, JSON.stringify(candidateFrom));
  }
});
