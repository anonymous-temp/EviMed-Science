// The skill tells a run to fix every preflight issue and rerun until it returns
// ok=true, then hands the package to the server gate. That instruction is only
// honest if the two agree: whatever the gate rejects, the preflight must have
// already caught, while the run could still act on it.
//
// They have now disagreed three times in production, each time costing a
// finished package. The ledger header had to be three exact columns that the
// preflight never looked at. The ledger row count included derived claims the
// gate excludes. And clinical-evidence-run.json had to carry
// successfulSourceArtifacts, which the preflight never checked — so a run that
// preserved five sources and wrote all seven deliverables was failed after 45
// minutes, told only "specialist_evidence_traceability_failed", and could not
// even be sent back to fix it, because the repair path needs an issue to hand
// over and that failure carried none.
//
// Checking by hand caught each one after the fact. This checks it on every
// change to either side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { validateClinicalEvidencePackage } from "../src/clinicalEvidenceQuality.mjs";
import { deepResearchPackage } from "./fixtures/clinicalEvidencePackage.mjs";

const execFileAsync = promisify(execFile);
const preflightScript = new URL(
  "../../../runtime/skills/evimed/clinical-evidence-synthesis/scripts/preflight.py",
  import.meta.url,
).pathname;

async function writeWorkspace(input) {
  const workspace = await mkdtemp(path.join(tmpdir(), "clinical-preflight-"));
  const files = {
    "clinical-evidence-report.md": input.reportText,
    "clinical-evidence-matrix.json": JSON.stringify(input.matrix),
    "clinical-evidence-run.json": JSON.stringify(input.runReceipt),
    "clinical-evidence-search.json": input.searchLogText,
    "references.bib": input.referencesText,
    "citation-ledger.csv": input.citationLedgerText,
    "citation-audit.md": input.citationAuditText,
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(workspace, name), content, "utf8");
  }
  for (const [artifactPath, content] of Object.entries(input.sourceArtifacts)) {
    await mkdir(path.join(workspace, path.dirname(artifactPath)), { recursive: true });
    await writeFile(path.join(workspace, artifactPath), content, "utf8");
  }
  return workspace;
}

async function runPreflight(workspace) {
  try {
    const { stdout } = await execFileAsync("python3", [preflightScript, "--workspace", workspace]);
    return JSON.parse(stdout);
  } catch (error) {
    // Non-zero exit is how it reports issues; the payload is still on stdout.
    if (error?.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}

/** @param {any} input @param {string} label */
async function verdicts(input, label) {
  const workspace = await writeWorkspace(input);
  try {
    return {
      label,
      gate: validateClinicalEvidencePackage(input),
      preflight: await runPreflight(workspace),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("a package both sides accept", async () => {
  const { gate, preflight } = await verdicts(deepResearchPackage(), "valid");
  assert.equal(gate.valid, true, gate.issues.join("\n"));
  assert.equal(preflight.ok, true, JSON.stringify(preflight.issues));
});

test("whatever the server gate rejects, the preflight already caught", async () => {
  // Each case is a real production failure, reduced to the one field that
  // caused it. If the preflight passes any of these, a run is told it is done
  // and then failed for it — which is what happened, three times.
  const cases = [
    {
      label: "run receipt without successfulSourceArtifacts",
      break: (input) => { delete input.runReceipt.successfulSourceArtifacts; },
    },
    {
      label: "run receipt naming a source artifact that is not on disk",
      break: (input) => { input.runReceipt.successfulSourceArtifacts = [".evimed-sources/missing/content.md"]; },
    },
    {
      label: "run receipt naming a path outside .evimed-sources",
      break: (input) => { input.runReceipt.successfulSourceArtifacts = ["workspace/notes.md"]; },
    },
    {
      label: "citation ledger whose header omits a column the cross-check reads",
      break: (input) => {
        input.citationLedgerText = input.citationLedgerText.replace(
          "claimId,referenceNumber,supportQuote",
          "claim,source,quote",
        );
      },
    },
    {
      label: "citation ledger missing a row",
      break: (input) => {
        const rows = input.citationLedgerText.trim().split("\n");
        input.citationLedgerText = [rows[0], ...rows.slice(2)].join("\n");
      },
    },
    // The register the fifteen speed-of-heart-rescue-pill reports were written
    // in. Each line below is verbatim from one of them. They passed every
    // structural check and were delivered, and the reader who commissioned them
    // read a technical work record instead of a paper.
    {
      label: "commissioning vocabulary in the analysis",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          '## 讨论\n题库目标答案"有胸闷症状者常备作为应急"无证据支持。\n',
        );
      },
    },
    {
      label: "a section named after an acceptance condition",
      break: (input) => {
        input.reportText = input.reportText.replace("## 讨论\n", "## 临床问题与判定条件\n本节说明证据门槛。\n\n## 讨论\n");
      },
    },
    {
      label: "lettered propositions with pass/fail conditions",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n"
            + "- 命题 A（发生率可定量）：需有分母明确、主动系统采集不良事件的研究。\n"
            + "- 命题 B（可归因）：仅有时间先后关系时不成立。\n",
        );
      },
    },
    {
      label: "判为 delivering a verdict on the report's own proposition",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          '## 讨论\n仅有说明书反应罗列、无分母的病例系列或综述转述，判为"无发生率证据"。\n',
        );
      },
    },
    {
      label: "the report narrating itself as the thing being delivered",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          '## 讨论\n两个被评价的指标只作为被评价对象出现，不作为质量达标判据。\n',
        );
      },
    },
    {
      label: "the runtime's own nouns for artifacts, access levels and its environment",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n该来源的访问层级为摘要，全文未能经本环境取得，相关工件已保存。\n",
        );
      },
    },
    {
      // The other half of the runtime's Chinese vocabulary: one retrieval pass
      // and the container it ran in. A methods section describes a search, not
      // the pass that performed it.
      label: "the runtime's nouns for one retrieval pass and its search environment",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n本轮检索未覆盖中文数据库，检索环境仅可访问公开摘要。\n",
        );
      },
    },
    {
      // The eleven commissioning terms are one list on each side, and only 题库
      // and 目标答案 are exercised above. These three carry the rest of the
      // brief's vocabulary: the group the question was drawn from, the prompt
      // that was dispatched, and the rate the answer was scored at.
      label: "the item bank's semantic group, dispatched prompt and pass rate",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n派发题面要求给出可执行建议，达标率按语义群统计。\n",
        );
      },
    },
    {
      label: "the metrics the run was scored against, named as the subject of the analysis",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          '## 讨论\n两个被评价的 KPI（"归因解释率""行动建议率"）只作为被评价对象出现，不作为质量达标判据。\n',
        );
      },
    },
    {
      label: "the report announcing which of the brief's percentages it refuses",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n本报告拒绝以任何提及率或强调率百分比作为结论或验收依据。\n",
        );
      },
    },
    {
      label: "the brief named alongside the report's own conditions",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n本报告的判定条件（与任务书一致）如下。\n",
        );
      },
    },
    {
      label: "the clinical question restated as an item-bank semantic question",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n本报告检验一个题库语义问题的学术化版本：使用者服药后出现的头晕与乏力，能否归因于药物本身。\n",
        );
      },
    },
    {
      // The heading rule spans levels two to four, and the level-two case above
      // only proves one of them. A run that was told to stop naming a section
      // 判定条件 will demote it to a subsection first — which is the shape the
      // superseded skill itself prescribed as section 2.
      label: "an acceptance-condition heading demoted to a subsection",
      break: (input) => {
        input.reportText = input.reportText.replace("## 讨论\n", "## 讨论\n### 论点与判定条件\n本节列出证据门槛。\n");
      },
    },
    {
      // The bulleted case above proves the bullet prefix; a numbered list is the
      // other form production used, and 交付判据 is the term the fourth
      // proposition was scored against.
      label: "numbered propositions scored against a delivery criterion",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n"
            + "1. 命题 C（可外推至老年人群）：需有年龄分层数据。\n"
            + "2. 命题 D（百分比指标可作为交付判据）：不支持。\n",
        );
      },
    },
    {
      // The verdict rule has two doors: a quoted verdict string, exercised
      // above, and a sentence whose subject is one of this report's own angles.
      // Only the second one catches a verdict written as plain prose.
      label: "an unquoted verdict on one of the report's own angles",
      break: (input) => {
        input.reportText = input.reportText.replace("## 讨论\n", "## 讨论\n该角度判定为不足以支持因果归因。\n");
      },
    },
    {
      // The traceability device pasted where nothing checks it. Verbatim in the
      // body of a delivered report, nine times, three of them in one paragraph.
      label: "a source quotation pasted into the body behind a 原文： label",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n其推荐含服剂量见指南 [2]。原文：sublingual administration is preferred\n",
        );
      },
    },
    {
      label: "a paragraph of the source's own language in the body",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\nrecent chest pain guidelines suggest that the relief of chest pain by nitroglycerin should not be used as a diagnostic factor\n",
        );
      },
    },
    {
      label: "the readership declared in the opening line",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n本文以临床医师与药师为读者，系统检索并评价上述问题所依赖的证据。\n",
        );
      },
    },
    {
      // A search that returned nothing is insufficient evidence to judge. The
      // summary is where this error does its damage: 结论 and 摘要 compress, and
      // a gap compressed into 不推荐使用 states a finding the report never made.
      label: "a gap summarised into a recommendation against use",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n未检索到该药在院外自救场景的直接证据，因此不推荐使用。\n",
        );
      },
    },
    {
      label: "derived result asserted without its 〔推导〕 mark",
      break: (input) => {
        input.matrix.claims.push({
          claimId: "CLM-101",
          claimType: "derived",
          claim: "推算：在给定条件下 6 个月残余约 78%。",
          method: "以蒸汽压与密封体系损失曲线为输入，按一级逸散近似 ln(C/C0) = -k·t 反解 k，代入 6 个月得 78%。",
          assumptions: "温度恒定 20 ℃，每日开盖 2 次，顶空体积不变。",
          sensitivity: "开盖频率翻倍时降至约 61%。",
          applicability: "仅适用于同类滴丸的密闭玻璃瓶包装。",
          uncertainty: "输入曲线来自密封体系，为量级判断而非测定值。",
          derivedFrom: ["CLM-001", "CLM-002"],
        });
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n在给定条件下 6 个月残余约 78%。 <!-- claim:CLM-101 -->\n",
        );
      },
    },
  ];

  for (const scenario of cases) {
    const input = deepResearchPackage();
    scenario.break(input);
    const { gate, preflight } = await verdicts(input, scenario.label);
    assert.equal(gate.valid, false, `${scenario.label}: the gate accepted it, so this case no longer tests anything`);
    assert.equal(
      preflight.ok,
      false,
      `${scenario.label}: the gate rejects this package but the preflight returned ok=true, `
        + "so a run would be told it is finished and then failed for it",
    );
  }
});

test("the register rules read the sentence, not the word", async () => {
  // 判定, 命题, 本环境 and 工件 all occur inside ordinary clinical and
  // bibliographic prose. A rule that fires on the word instead of its use would
  // fail correct analysis — the most expensive kind of false positive here,
  // because the run is sent back to break something that was right.
  const cases = [
    {
      label: "因果关系判定 and 误判为 as ordinary clinical vocabulary",
      write: "不良反应的因果关系判定需要去激发与再激发观察；急性冠脉综合征可能被误判为胃食管反流。",
    },
    {
      label: "a published grading instrument applied and named",
      write: '按 WHO-UMC 因果关系评定标准判定为"可能有关"，证据体按 GRADE 判定为低确定性。',
    },
    {
      label: "a reference standard defining what counts as positive",
      write: "以冠脉造影显著狭窄判定为阳性，作为参考标准。",
    },
    {
      label: "a single 命题 referred to in reasoning",
      write: "该推理依赖命题（若无分母则无法估计发生率）这一前提。",
    },
    {
      label: "本环境 inside 基本环境, 日本环境 and 样本环境",
      write: "遗传与基本环境因素共同作用，日本环境省公布的数据与样本环境条件一致。",
    },
    {
      // The instrument the skill names for adverse-event attribution. 因果关系判定
      // is the standard phrase for it, so a rule reading 判定 as a verdict verb
      // would reject the appraisal criterion the method is required to state.
      label: "Naranjo applied as the attribution criterion",
      write: "不良反应的因果关系判定采用 Naranjo 量表进行，并结合去激发与再激发观察。",
    },
    {
      // 判定为 attached to a certainty level rather than to a proposition of the
      // report's own — the exact wording the skill prescribes as the replacement.
      label: "GRADE certainty reported with 判定 in the sentence",
      write: "该结局的证据体按 GRADE 判定证据等级为低，降级理由为间接性与不精确性。",
    },
    {
      label: "命题 as the term of art in 命题逻辑",
      write: "命题逻辑与因果推断的区别在于前提是否可被经验检验。",
    },
    {
      label: "工件 inside 加工件 and 本环境 inside 标本环境",
      write: "职业流行病学研究报告了金属加工件粉尘暴露与呼吸道症状的关联，标本环境温度亦被记录。",
    },
    {
      // Deliberate threshold, not an oversight: one such line can be a reference
      // to someone else's numbered proposition, and it is the list of them with
      // their pass/fail conditions that is the acceptance form. Two of these
      // lines are rejected above; this pins where the boundary was drawn.
      label: "a single lettered proposition, which is a reference and not a checklist",
      write: "命题 A（发生率可定量）需要分母明确的前瞻性主动监测研究支持。",
    },
    // Latin script in a Chinese manuscript is normal: instrument names, reporting
    // guidelines, journals, genes, drug names and statistics are all written in
    // it. What is banned is a paragraph of the source's own sentences, so the
    // rule counts a run of twelve consecutive words — longer than any of these.
    {
      label: "reporting-guideline expansions, which are names and not sentences",
      write: "报告规范遵循 Preferred Reporting Items for Systematic Reviews and Meta-Analyses (PRISMA) 与 Strengthening the Reporting of Observational Studies in Epidemiology (STROBE)。",
    },
    {
      label: "a guideline title carried in full",
      write: "2021 AHA/ACC/ASE/CHEST/SAEM/SCCT/SCMR Guideline for the Evaluation and Diagnosis of Chest Pain in the Emergency Department 将胸痛缓解排除在诊断依据之外。",
    },
    {
      label: "statistics, identifiers, scales and drug names",
      write: "ALDH2 rs671 变异携带者的缓解率较低；因果关系按 Naranjo 量表与 WHO-UMC 标准评定；硝酸甘油（glyceryl trinitrate, nitroglycerin, GTN）经舌下黏膜吸收。",
    },
    {
      label: "a short quotation inside a Chinese sentence, which the skill allows",
      write: "说明书适应症英文原句为 “for the treatment of angina pectoris due to coronary artery disease”，未涵盖未分化胸痛。",
    },
    {
      label: "a database search strategy, which is Boolean syntax and not prose",
      write: "检索式为 (\"acute chest pain\"[MeSH] OR \"chest discomfort\"[tiab]) AND (\"nitroglycerin\"[MeSH] OR \"prehospital\"[tiab]) NOT \"review\"[pt]。",
    },
    {
      label: "原文 without the label's colon, reporting what a source says",
      write: "原文报告 Jadad 评分较低；该指南原文为英文，本文按术语表统一译名后引用。",
    },
    {
      label: "a study population and studied material, which are not a readership",
      write: "本研究以急性胸痛患者为研究对象；该科普材料的受众对象为老年人，其阅读理解水平限制了信息传递效果。",
    },
    {
      // The compliant half of the gap rule. Every one of these contains the
      // words the rule reads — a failed search, a connective, a negation — and
      // none of them turns the gap into a finding about the drug.
      label: "a gap stated as a gap, with what would close it",
      write: "未检索到支持其用于该场景的直接证据；缺乏头对头比较研究，因此两药的相对效能尚不能判断。",
    },
    {
      label: "a recommendation reported with the body that made it",
      write: "该指南因缺乏随机对照证据，不推荐将其常规用于未分化胸痛 [3]。",
    },
  ];
  for (const scenario of cases) {
    const input = deepResearchPackage();
    input.reportText = input.reportText.replace("## 讨论\n", `## 讨论\n${scenario.write}\n`);
    const { gate, preflight } = await verdicts(input, scenario.label);
    assert.equal(gate.valid, true, `${scenario.label}: ${gate.issues.join("\n")}`);
    assert.equal(preflight.ok, true, `${scenario.label}: ${JSON.stringify(preflight.issues)}`);
  }
});

test("the sentences the skill prescribes as the repair are not themselves rejected", async () => {
  // Every ban above is stated in the skill with the wording that replaces it.
  // If a replacement trips the rule it was written to satisfy, the run has
  // nowhere to go: it is sent back, writes the prescribed sentence, and is sent
  // back again. Each line here is the 正例 the skill gives for one of the 反例
  // rejected above.
  const prescribed = [
    "本文评价使用者报告的头晕与乏力能否归因于该药，以及现有证据可支持的归因强度。",
    "对于该说法，未检索到以临床结局为终点、检验自备或按需用药策略的研究。",
    "现有报告仅提供用药与症状的时间关联，缺少去激发与再激发观察及标准化因果关系评定，故不足以支持因果归因。",
    "发生率估计仅采纳分母明确、前瞻性主动监测的研究；说明书的不良反应罗列与无分母病例系列不用于估计发生率，"
      + "相应表述限于“已有记载，发生率未知”。",
    "现有证据为观察性研究且未校正觉醒时点与晨间活动量，仅支持“事件时间分布不均”这一较弱表述，尚不足以支持因果性解释。",
    // Subject-matter subsection titles, which replace the workflow ones.
    "### 不良反应归因评定\n各来源的归因强度依据去激发观察与替代解释的排除程度。",
    // The finding restated in the paper's own voice, replacing the two 原文：
    // quotations that carried it in the delivered report.
    "指南推荐对仍有缺血症状者舌下含服硝酸甘油 [2]；欧洲心脏病学会给出 I 类 C 级推荐 [3]。",
    // Quotation where the exact wording is itself the object of analysis.
    "该说明书将适应症限定为“气滞血瘀型冠心病心绞痛”[7]，未涵盖未分化急性胸痛。",
    // One ruler for both arms, with the gap they share stated for both.
    "在未分化急性胸痛的院外自救场景中，两者均未检索到适应症内随机对照证据，同一外推按 GRADE 均为极低确定性 [2,11]。",
    // The gap written as a gap, naming the study that would close it.
    "未检索到在该场景中以临床结局为终点的随机对照研究，现有证据不足以判断其在该场景的效能；可回答该问题的研究为以院外未分化胸痛人群为对象的随机对照试验。",
  ];
  for (const write of prescribed) {
    const input = deepResearchPackage();
    input.reportText = input.reportText.replace("## 讨论\n", `## 讨论\n${write}\n`);
    const { gate, preflight } = await verdicts(input, write);
    assert.equal(gate.valid, true, `${write}: ${gate.issues.join("\n")}`);
    assert.equal(preflight.ok, true, `${write}: ${JSON.stringify(preflight.issues)}`);
  }
});

test("both sides name the same line of the report the author has", async () => {
  // A repair edits the line the notice names, so the number has to survive both
  // sides blanking sections before they read. Collapsing a blanked section
  // instead of preserving its newlines moves every later line up, and a notice
  // pointing at the wrong line is a repair with nowhere to go — which has
  // already happened once, to the numeric audit.
  const input = deepResearchPackage();
  const offender = "该角度判定为不足以支持因果归因。";
  // Placed after the reference-free sections both sides blank, where a shifted
  // line count would show.
  input.reportText = input.reportText.replace("## 局限与不确定性\n", `## 局限与不确定性\n${offender}\n`);
  const expected = input.reportText.split("\n").findIndex((line) => line.includes(offender)) + 1;
  const { gate, preflight } = await verdicts(input, "line agreement");
  assert.match(gate.issues.join("\n"), new RegExp(`report line ${expected} delivers a verdict`));
  assert.match(preflight.issues.join("\n"), new RegExp(`line ${expected}: 判为/判定为 delivers a verdict`));
});

test("the practical answer is found under its old and its manuscript name", async () => {
  // The section carries every safety duty the report has, and every check on it
  // finds it by heading. A rename that stopped matching would not fail loudly —
  // the section would simply be absent and nothing in it would be audited.
  for (const heading of ["## 安全优先的实际处置", "## 临床实践要点", "## 临床要点"]) {
    const input = deepResearchPackage();
    input.reportText = input.reportText.replace("## 实际处置", heading);
    const { gate, preflight } = await verdicts(input, heading);
    assert.equal(gate.valid, true, `${heading}: ${gate.issues.join("\n")}`);
    assert.equal(preflight.ok, true, `${heading}: ${JSON.stringify(preflight.issues)}`);
  }
});
