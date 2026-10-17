// The list line of a programme card that has no headline claim (R19 audit D C3): an earlier release wrote one neutral sentence as the
// summary of every such card, so a zone listed nineteen identical rows. The schema step takes those cards to their first conclusion,
// against PostgreSQL — and recognises exactly the sentence the builder wrote, so the two cannot drift apart.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { claimVerification } from "@evimed/domain/clinical-evidence";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { buildProgrammeCard, evaluateProgrammeClaims } from "../src/evidenceProgrammeCard.mjs";
import { EVIDENCE_ZONE_SQL, migrateEvidenceZones } from "../src/evidenceZonePersistence.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const tag = randomUUID().slice(0, 8);
const hex32 = () => randomUUID().replaceAll("-", "");
const owner = `ps_owner_${tag}`;

const PATH_A = ".evimed-sources/a1/aristotle.txt";
const PATH_B = ".evimed-sources/b2/rely.txt";
const TEXT_A = "In ARISTOTLE, apixaban was superior to warfarin in preventing stroke or systemic embolism (hazard ratio 0.79; 95% CI 0.66 to 0.95).";
const TEXT_B = "RE-LY found dabigatran 150 mg twice daily reduced stroke or systemic embolism compared with warfarin (relative risk 0.66).";
const directA = { claimId: "CLM-001", claimType: "direct", claim: "阿哌沙班预防卒中或系统性栓塞优于华法林。", sourceUrl: "https://doi.org/10.1056/NEJMoa1107039", sourceTitle: "ARISTOTLE",
  artifactPath: PATH_A, accessLevel: "full_text", supportQuote: "apixaban was superior to warfarin in preventing stroke or systemic embolism" };
const directB = { claimId: "CLM-002", claimType: "direct", claim: "达比加群 150 mg 每日两次降低卒中或系统性栓塞。", sourceUrl: "https://doi.org/10.1056/NEJMoa0905561", sourceTitle: "RE-LY",
  artifactPath: PATH_B, accessLevel: "abstract", supportQuote: "dabigatran 150 mg twice daily reduced stroke or systemic embolism compared with warfarin" };
const captured = new Map([[PATH_A, { text: TEXT_A, digest: "a".repeat(64), capturedAt: "2026-10-05T01:00:00.000Z" }], [PATH_B, { text: TEXT_B, digest: "b".repeat(64), capturedAt: "2026-10-05T01:00:00.000Z" }]]);

/** A card as the builder wrote it before this change: the neutral answer was also its summary. */
function neutralCard(claim) {
  const matrix = { claims: [claim] };
  const evaluation = evaluateProgrammeClaims({ matrix, verification: claimVerification({ matrix, sourceArtifacts: { [PATH_A]: TEXT_A, [PATH_B]: TEXT_B } }), agendaClaims: [] });
  const built = buildProgrammeCard({
    zone: { id: "ez_zone", title: "房颤抗凝" }, question: "房颤患者用口服抗凝药，各药有什么证据？", taskType: "evidence-update", capabilityId: "clinical-evidence-synthesis",
    decisionId: "programme-decision-2026-10-05", agenda: { id: "agenda-1" }, episode: { id: "episode-1" }, runId: "run_1", resultVersionId: `rv_${"c".repeat(64)}`,
    evaluation, captured, machineValues: [], model: "deepseek-flash", at: new Date("2026-10-05T02:00:00.000Z"),
  });
  assert.equal(built.status, "card");
  assert.equal(built.headlineClaimId, null, "no headline: the answer is the neutral sentence");
  return built.card;
}

/** @type {any} */ let database; let zone;
const ids = { a: `ec_${hex32()}`, b: `ec_${hex32()}`, synthesized: `ec_${hex32()}`, written: `ec_${hex32()}` };

async function insert(id, { summary, claims }) {
  await database.query(`INSERT INTO evimed_frontier.evidence_cards(id,zone_id,user_id,title,subtype,summary,sources,state,content,claims,producer)
    VALUES($1,$2,$3,'卡片','academic',$4,'[]'::jsonb,'published','{}'::jsonb,$5::jsonb,$6::jsonb)`,
  [id, zone, owner, summary, JSON.stringify(claims), JSON.stringify({ kind: "platform", name: "EviMed 证据中心", relation: "none" })]);
}
const summaryOf = async (id) => (await database.query("SELECT summary FROM evimed_frontier.evidence_cards WHERE id=$1", [id])).rows[0].summary;
const version = async () => Number((await database.query("SELECT version FROM evimed_frontier.evidence_zone_meta")).rows[0].version);

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  await migrateEvidenceZones(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Programme Owner','development')", [owner]);
  zone = `ez_${hex32()}`;
  await database.query("INSERT INTO evimed_frontier.evidence_zones(id,user_id,title,state) VALUES($1,$2,'房颤抗凝','published')", [zone, owner]);
  const a = neutralCard(directA);
  const b = neutralCard(directB);
  assert.match(a.content.answer, /^这张卡汇总了 1 条/, "the card still carries the neutral answer");
  // The list line the earlier release wrote: the neutral sentence, on both cards alike.
  await insert(ids.a, { summary: a.content.answer, claims: a.claims });
  await insert(ids.b, { summary: b.content.answer, claims: b.claims });
  // A card that opens with a synthesis, which only the builder can label: left as it is.
  await insert(ids.synthesized, { summary: a.content.answer, claims: [{ ...a.claims[0], claimType: "synthesized" }] });
  // A card with a line of its own.
  await insert(ids.written, { summary: "自己写的一行。", claims: a.claims });
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.evidence_zones WHERE id=$1", [zone]);
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  await database.close();
});

test("the schema step takes a neutral list line to the card's first conclusion, once, and moves the version once", options, async () => {
  const neutral = await summaryOf(ids.a);
  assert.equal(neutral, await summaryOf(ids.b), "before: the two cards read alike");
  const before = await version();
  await database.query(EVIDENCE_ZONE_SQL);
  assert.equal(await summaryOf(ids.a), directA.claim);
  assert.equal(await summaryOf(ids.b), directB.claim);
  assert.notEqual(await summaryOf(ids.a), await summaryOf(ids.b));
  assert.equal(await summaryOf(ids.synthesized), neutral, "a synthesis keeps the line until the builder rewrites it with its label");
  assert.equal(await summaryOf(ids.written), "自己写的一行。", "a line somebody wrote is not touched");
  assert.equal(await version(), before + 1, "the zones' version moved, so a cached list is read again");
  // Idempotent: the next start finds nothing to do.
  await database.query(EVIDENCE_ZONE_SQL);
  assert.equal(await summaryOf(ids.a), directA.claim);
  assert.equal(await version(), before + 1, "and moves nothing");
});
