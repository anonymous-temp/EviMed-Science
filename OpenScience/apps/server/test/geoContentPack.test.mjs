// One implementation of the delivery rules, exercised by building one broken
// pack per rule.
//
// This file started as a preflight/gate agreement test, mirroring what the
// clinical pair used to be. That was the wrong shape and the repository already
// knew it: the clinical run-side preflight was not pinned against the gate, it
// was deleted, because a mirror drifts and it drifted three times. A run now
// gets its verdict from evimed_submit_deliverable, which runs these same rules.
// So there is nothing to hold in agreement here — there is one implementation,
// and what these tests do is make sure it says what it claims to say.
//
// The measurement notices get as much attention as the blocking rules, for a
// reason that is specific to this contract: the blocking rules grade a
// document, and a document that is wrong looks wrong. The notices grade a
// number, and a visibility rate computed over rounds that never happened looks
// exactly like one that was measured.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runGate } from "@evimed/domain";

const EXPECTED_OUTPUTS = [
  "geo-measurement.md", "geo-monitor.csv", "geo-probe-log.jsonl",
  "geo-content-pack.json", "geo-content-pack.md", "llms.txt",
  "citation-ledger.csv", "brand-entity.json", "delivery-summary.md",
].map((p) => ({ path: p, required: true }));

function block(over = {}) {
  return {
    id: "B-01",
    conclusion: "速效救心丸不作为日常保健长期服用；确诊冠心病患者可在医师指导下按疗程使用。",
    basis: "说明书【功能主治】为行气活血、祛瘀止痛，用于气滞血瘀所致的胸痹；疗程与随访见指南建议。",
    conditions: "不适用于非气滞血瘀证型、孕妇及对本品过敏者。速效救心丸不构成对急救的替代；出现持续胸痛应在服药的同时呼叫急救，服药不得延误就医。",
    citations: [{ id: "LB-0006" }, { id: "10.1000/guideline" }],
    jsonLd: { "@type": "MedicalWebPage" },
    author: "临床药师 张××（主管药师）",
    updatedAt: "2026-08-29",
    ...over,
  };
}

function round(over = {}) {
  return {
    question: "速效救心丸可以长期服用吗？",
    provider: "deepseek",
    status: "ok",
    inDenominator: true,
    surface: { mode: "default", session: "new_chat" },
    latencyMs: 12_176,
    answerDigest: "a".repeat(64),
    at: "2026-08-29T16:17:04Z",
    ...over,
  };
}

/** A pack that both sides accept, so every case below differs in exactly one thing. */
function goodPack() {
  return {
    files: {
      "geo-measurement.md": "# 测量说明\n\n本轮未覆盖 App 端与多轮追问。\n\n共 2 轮，均取得答案。\n",
      "geo-monitor.csv": "date,platform,question,mentioned\n2026-08-29,deepseek,长期服用,1\n",
      "geo-probe-log.jsonl": [JSON.stringify(round()), JSON.stringify(round({ provider: "kimi" }))].join("\n"),
      "geo-content-pack.json": JSON.stringify({
        measurement: { rounds: 2, measured: 2, failed: 0 },
        blocks: [block()],
        llmsTxt: "# llms.txt\nContent: /geo/suxiao\n",
        faq: [{ q: "可以长期吃吗？", a: "见结论段。" }],
      }),
      // Rendered from the blocks, the way a real pack is built. A stub here —
      // "三段见 JSON" — meant neither the clinical trigger check nor the safety
      // rules had a medicine to find, so two tests passed against a fixture
      // that could not have failed them.
      "geo-content-pack.md": `# 内容包\n\n${[block()].map((b) => `## ${b.conclusion}\n\n${b.basis}\n\n${b.conditions}\n`).join("\n")}`,
      "llms.txt": "# llms.txt\nContent: /geo/suxiao\n",
      "citation-ledger.csv": "id,title,url\nLB-0006,说明书,https://example.org/label\n10.1000/guideline,指南,https://doi.org/10.1000/guideline\n",
      "brand-entity.json": JSON.stringify({ name: "速效救心丸", approval: "国药准字Z12020025" }),
      "delivery-summary.md": "# 交付说明\n\n本轮交付一个内容块。\n",
    },
  };
}

function gate(pack) {
  return runGate({
    contractKind: "geo-content-pack",
    files: new Map(Object.entries(pack.files)),
    expectedOutputs: EXPECTED_OUTPUTS,
  });
}

/** Cases the contract must reject. */
const BLOCKING = [
  ["a block with no conditions paragraph is a claim with no stated limits", (pack) => {
    const parsed = JSON.parse(pack.files["geo-content-pack.json"]);
    parsed.blocks[0].conditions = "";
    pack.files["geo-content-pack.json"] = JSON.stringify(parsed);
  }],
  ["a block with no basis paragraph", (pack) => {
    const parsed = JSON.parse(pack.files["geo-content-pack.json"]);
    parsed.blocks[0].basis = "   ";
    pack.files["geo-content-pack.json"] = JSON.stringify(parsed);
  }],
  ["a single citation is not enough to bind a medical claim", (pack) => {
    const parsed = JSON.parse(pack.files["geo-content-pack.json"]);
    parsed.blocks[0].citations = [{ id: "LB-0006" }];
    pack.files["geo-content-pack.json"] = JSON.stringify(parsed);
  }],
  ["a block with no author credential or update date", (pack) => {
    const parsed = JSON.parse(pack.files["geo-content-pack.json"]);
    delete parsed.blocks[0].author;
    pack.files["geo-content-pack.json"] = JSON.stringify(parsed);
  }],
  ["a block with no JSON-LD is invisible to the engines it is written for", (pack) => {
    const parsed = JSON.parse(pack.files["geo-content-pack.json"]);
    delete parsed.blocks[0].jsonLd;
    pack.files["geo-content-pack.json"] = JSON.stringify(parsed);
  }],
  ["a pack with no FAQ", (pack) => {
    const parsed = JSON.parse(pack.files["geo-content-pack.json"]);
    parsed.faq = [];
    pack.files["geo-content-pack.json"] = JSON.stringify(parsed);
  }],
  ["a pack with no blocks at all", (pack) => {
    const parsed = JSON.parse(pack.files["geo-content-pack.json"]);
    parsed.blocks = [];
    pack.files["geo-content-pack.json"] = JSON.stringify(parsed);
  }],
  ["a declared output that is present but empty", (pack) => {
    pack.files["llms.txt"] = "";
  }],
  ["a declared output that is missing", (pack) => {
    delete pack.files["brand-entity.json"];
  }],
];

for (const [name, mutate] of BLOCKING) {
  test(`the contract rejects: ${name}`, () => {
    const pack = goodPack();
    mutate(pack);
    const verdict = gate(pack);
    assert.equal(verdict.ok, false, "this pack must not be deliverable");
    assert.equal(verdict.errorCode, "deliverable_rejected");
    assert.ok(verdict.issues.some((entry) => entry.severity === "required"), "the rejection must name something required");
  });
}

test("the reference pack is accepted with nothing to say about it", () => {
  // Without this, every case above also passes against a validator that rejects
  // everything — which is the shape a rule-by-rule test file quietly acquires.
  const pack = goodPack();
  const verdict = gate(pack);
  assert.equal(verdict.ok, true, `the reference pack was rejected: ${JSON.stringify(verdict.issues)}`);
  assert.deepEqual(verdict.issues, []);
  assert.equal(verdict.errorCode, null);
});

// ------------------------------------------------------- the measurement half

/** Cases that are reported and never block. */
const NOTICES = [
  // Not an empty file: an empty declared output already blocks on its own, and
  // conflating the two would have this case pass for the wrong reason. The
  // interesting shape is a ledger with content in which every round failed —
  // the run did work, measured nothing, and wrote a pack anyway.
  ["every round failed, so nothing was measured", (pack) => {
    pack.files["geo-probe-log.jsonl"] = [
      JSON.stringify(round({ status: "busy", inDenominator: false, error: "服务繁忙" })),
      JSON.stringify(round({ provider: "kimi", status: "error", inDenominator: false, error: "会话失效" })),
    ].join("\n");
    const parsed = JSON.parse(pack.files["geo-content-pack.json"]);
    parsed.measurement = { rounds: 2, measured: 0, failed: 2 };
    pack.files["geo-content-pack.json"] = JSON.stringify(parsed);
  }, /geo_measurement_absent/, /all 2 probe round\(s\) failed/],
  ["a round counted while its status is not ok", (pack) => {
    pack.files["geo-probe-log.jsonl"] = JSON.stringify(round({ status: "busy" }));
  }, /geo_failed_round_counted/, /not a measurement/],
  ["a measured round with no surface", (pack) => {
    pack.files["geo-probe-log.jsonl"] = JSON.stringify(round({ surface: { mode: "deep" } }));
  }, /geo_surface_undeclared/, /mode and a session/],
  ["a denominator larger than the ledger supports", (pack) => {
    const parsed = JSON.parse(pack.files["geo-content-pack.json"]);
    parsed.measurement = { rounds: 10, measured: 10, failed: 0 };
    pack.files["geo-content-pack.json"] = JSON.stringify(parsed);
  }, /geo_denominator_overstated/, /declares 10 measured round/],
  ["a ledger line that does not parse", (pack) => {
    pack.files["geo-probe-log.jsonl"] = `${JSON.stringify(round())}\n{"question": broken`;
  }, /geo_probe_log_unreadable/, /could not be parsed/],
];

for (const [name, mutate, code] of NOTICES) {
  test(`reported but not blocking: ${name}`, () => {
    const pack = goodPack();
    mutate(pack);
    const verdict = gate(pack);
    // The whole point of "ships as a notice first". A seventh blocking point
    // needs an observed distribution, and this capability has produced no real
    // runs yet — so these must appear and must not stop delivery.
    assert.equal(verdict.ok, true, `a measurement notice must not block: ${JSON.stringify(verdict.issues)}`);
    const raised = verdict.issues.filter((entry) => code.test(entry.code));
    assert.equal(raised.length > 0, true, `expected ${code} among ${JSON.stringify(verdict.issues.map((i) => i.code))}`);
    assert.equal(raised.every((entry) => entry.severity === "advisory"), true, "must be advisory, not required");
    assert.equal(verdict.errorCode, null, "a notice must not set a rejection code");
  });
}

test("a pack with no probe ledger is noticed, not silently accepted", () => {
  // A missing ledger and an empty one are different facts, and the gate reads
  // the file map directly rather than through the helper that collapses both
  // to "". Told only "no measurements", a run cannot tell whether it forgot to
  // write the file or the batch produced nothing.
  const pack = goodPack();
  delete pack.files["geo-probe-log.jsonl"];
  const verdict = gate(pack);
  assert.equal(verdict.ok, false, "a missing required output still blocks");
  const absent = verdict.issues.filter((entry) => entry.code === "geo_measurement_absent");
  assert.equal(absent.length, 1);
  assert.match(absent[0].message, /is not in the deliverable/);
});

test("an empty ledger is described as empty, not as absent", () => {
  // These are two different instructions to a run: one says "you did not write
  // the file", the other says "the batch produced nothing". The validator reads
  // input.files directly for exactly this reason, because the text() helper
  // collapses a missing file and an empty one to the same ''. A mutation that
  // put text() back was invisible until this case existed — the deletion test
  // above passes either way, since a missing file is reported correctly by both.
  const empty = goodPack();
  empty.files["geo-probe-log.jsonl"] = "";
  const absent = goodPack();
  delete absent.files["geo-probe-log.jsonl"];

  const emptyNotice = gate(empty).issues.find((entry) => entry.code === "geo_measurement_absent");
  const absentNotice = gate(absent).issues.find((entry) => entry.code === "geo_measurement_absent");
  assert.match(emptyNotice.message, /ledger is empty/);
  assert.match(absentNotice.message, /is not in the deliverable/);
  assert.notEqual(emptyNotice.message, absentNotice.message);
});

test("the metrics carry the distribution the tiering decision will need", () => {
  // The reason these ship as notices at all: nobody can argue for a seventh
  // blocking point without knowing how often real runs trip it.
  const pack = goodPack();
  const verdict = gate(pack);
  assert.equal(verdict.metrics.geoProbeRounds, 2);
  assert.equal(verdict.metrics.geoMeasuredRounds, 2);
  assert.equal(verdict.metrics.geoFailedRounds, 0);
  assert.deepEqual(verdict.metrics.geoPlatformsMeasured, ["deepseek", "kimi"]);
  assert.equal(verdict.metrics.geoQuestionsMeasured, 1);
});

// ------------------------------------------------- the clinical half

test("a pack about a medicine is graded, not turned away", () => {
  // It used to be turned away. geo-content-pack was not in
  // CLINICAL_CONTRACT_KINDS, so every pack mentioning a trigger medicine failed
  // with clinical_content_without_clinical_contract — and neither remedy the
  // message offers can be followed: there is no clinical GEO kind, and removing
  // the medicine removes the deliverable. Found by assembling a real pack from a
  // real measurement and running it through this gate.
  const pack = goodPack();
  // The fixture has to actually contain the medicine or this test proves
  // nothing. It is asserted in the blocks rather than in the Markdown because
  // that is where a pack's content really lives — and checking only the
  // Markdown was the hole this assertion found.
  const blocks = JSON.parse(pack.files["geo-content-pack.json"]).blocks;
  assert.ok(blocks.some((block) => block.conclusion.includes("速效救心丸")), "the fixture must be about a medicine");
  const verdict = gate(pack);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  assert.equal(
    verdict.issues.some((entry) => entry.code === "clinical_content_without_clinical_contract"),
    false,
  );
});

test("a block that carries the danger is read, even when the Markdown is a stub", () => {
  // The pack's Markdown may be a pointer — "三段见 JSON" — and the blocks are
  // still the deliverable. Checking only the rendered file let every block
  // through unexamined.
  const pack = goodPack();
  const parsed = JSON.parse(pack.files["geo-content-pack.json"]);
  parsed.blocks[0].conditions = "含服后疼痛缓解，说明是心绞痛而不是胃病。";
  pack.files["geo-content-pack.json"] = JSON.stringify(parsed);
  const verdict = gate(pack);
  assert.equal(verdict.ok, false, "a dangerous block must not pass because the Markdown is clean");
  assert.ok(verdict.issues.some((entry) => /diagnose or exclude/.test(entry.message)));
});

test("the required emergency sentence is required here too", () => {
  // The other half of the same change. Adding the kind to CLINICAL_CONTRACT_KINDS
  // only silences the trigger check; if the validator then applied no safety
  // rule, "clinical" would be a label and medicine content would pass
  // unexamined — worse than the rejection it replaced.
  const pack = goodPack();
  const parsed = JSON.parse(pack.files["geo-content-pack.json"]);
  parsed.blocks[0].conditions = "不适用于非气滞血瘀证型、孕妇及对本品过敏者。";
  pack.files["geo-content-pack.json"] = JSON.stringify(parsed);
  pack.files["geo-content-pack.md"] = "# 内容包\n\n速效救心丸用于气滞血瘀所致的胸痹，含服即可。\n";
  const verdict = gate(pack);
  assert.equal(verdict.ok, false);
  const raised = verdict.issues.filter((entry) => entry.code === "clinical_safety_rule");
  assert.equal(raised.length, 1);
  assert.match(raised[0].message, /must not delay emergency care/);
});

test("drug response presented as a diagnosis is blocked in a content block", () => {
  // A content block is written to be quoted by a machine that will not add the
  // caveat back, so this is more dangerous here than in a report a clinician
  // reads whole.
  const pack = goodPack();
  pack.files["geo-content-pack.md"] = "# 内容包\n\n速效救心丸不构成对急救的替代，服药不得延误就医。含服后疼痛缓解，说明是心绞痛而不是胃病。\n";
  const verdict = gate(pack);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.issues.some((entry) => /diagnose or exclude/.test(entry.message)));
});

test("unsupported self-care advice is blocked in a content block", () => {
  const pack = goodPack();
  pack.files["geo-content-pack.md"] = "# 内容包\n\n速效救心丸不构成对急救的替代，服药不得延误就医。也可以先吃点胃药观察一下，看症状会不会变化。\n";
  const verdict = gate(pack);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.issues.some((entry) => entry.code === "clinical_safety_rule"));
});

test("a brand's own block is not treated as dragging the medicine into someone else's question", () => {
  // entity_requires_question_mention asks whether a medicine was introduced into
  // an answer that was not about it. A GEO pack is legitimately about its brand,
  // so the pack passes no `question` and that rule does not fire. Applying it
  // would fail every GEO pack ever written, which is why "which rules apply" is
  // decided by what the caller passes rather than by a flag someone can flip.
  const verdict = gate(goodPack());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.issues.some((entry) => /must not introduce/.test(entry.message)), false);
});

test("a pack that mentions no medicine is not asked for a medicine's safety sentence", () => {
  const pack = goodPack();
  const parsed = JSON.parse(pack.files["geo-content-pack.json"]);
  for (const block of parsed.blocks) {
    block.conclusion = "本类产品的登记用途以说明书为准。";
    block.basis = "依据公开说明书条目。";
    block.conditions = "不适用于说明书未覆盖的情形。";
  }
  pack.files["geo-content-pack.json"] = JSON.stringify(parsed);
  pack.files["geo-content-pack.md"] = "# 内容包\n\n本类产品的登记用途以说明书为准。\n";
  pack.files["geo-measurement.md"] = "# 测量说明\n\n本轮未覆盖 App 端。共 2 轮，均取得答案。\n";
  const verdict = gate(pack);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
});

test("naming the probe tool in pack prose is blocked by the shared leakage rule", () => {
  // Not a GEO rule: runtimeLeakageLine derives its tokens from toolNames.mjs,
  // so geo_visibility_probe came under it the moment the tool was registered.
  // Asserted here anyway, because "it is covered by something else" is a claim
  // and this is the check of it.
  const leaking = goodPack();
  leaking.files["geo-content-pack.md"] = "# 内容包\n\n本轮通过 evimed_geo_visibility_probe 取得结果。\n";
  const verdict = gate(leaking);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.issues.some((entry) => entry.code === "runtime_leakage"));
});

test("the probe host in pack prose is noticed, and revision notes are exempt", () => {
  const leaking = goodPack();
  leaking.files["geo-content-pack.md"] = "# 内容包\n\n测量来自 43.248.117.249:9999。\n";
  const verdict = gate(leaking);
  assert.equal(verdict.ok, true, "a new check ships as a notice");
  const raised = verdict.issues.filter((entry) => entry.code === "geo_probe_host_in_prose");
  assert.equal(raised.length, 1);
  assert.equal(raised[0].severity, "advisory");

  // The outlet has to stay an outlet. Scanning it would make runs hide backstage
  // prose in the report instead, which is the failure the outlet prevents.
  const noted = goodPack();
  noted.files["revision-notes.md"] = "本轮改动：把 43.248.117.249:9999 换成内网地址后重测。\n";
  assert.deepEqual(gate(noted).issues, []);
});

test("the capability ships no second implementation of these rules", async () => {
  // The clinical run-side preflight was deleted rather than pinned, because a
  // mirror drifts and it drifted three times. This file began life as a
  // preflight/gate agreement test for GEO, which was that same mistake with the
  // ink still wet. A test that only checks the rules would not have noticed it
  // coming back.
  const skill = await readFile(new URL("../../../capabilities/geo-content/SKILL.md", import.meta.url), "utf8");
  assert.ok(!/preflight\.py/.test(skill), "the skill must send the run to evimed_submit_deliverable, not to a local checker");
  assert.match(skill, /evimed_submit_deliverable/);
  assert.match(skill, /one implementation/);
});
