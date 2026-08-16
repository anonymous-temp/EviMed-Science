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
import { deepResearchPackage, questionCoverageLedger, researchBrief } from "./fixtures/clinicalEvidencePackage.mjs";

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
    "question-coverage.json": input.questionCoverageText,
    // The read-only copy the server writes at dispatch. The preflight reads
    // this one; the gate reads input.briefText, which is the server's own copy.
    // A case that sets them differently is testing exactly that difference.
    ".evimed-brief/research-brief.md": input.workspaceBriefText ?? input.briefText,
  };
  for (const [name, content] of Object.entries(files)) {
    if (content == null) continue;
    await mkdir(path.join(workspace, path.dirname(name)), { recursive: true });
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
  // The coverage ledger cites report line numbers, and almost every case here
  // edits the report. Rebuild it against the report the case actually built,
  // unless the case is about the ledger and set one itself.
  if (!input.keepCoverage) input.questionCoverageText = questionCoverageLedger(input.reportText, input.searchLogText);
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
      // Verbatim from the returned report, label and all. Both rules fire on
      // this one line because that is how it arrived: nine of them stood in the
      // delivered document, three in a single paragraph.
      label: "the source's own dosing sentence pasted behind the label, as delivered",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n院前给药剂量见指南 [2]。"
            + "原文：the recommended doses of NTG include sublingual or spray (0.3 to 0.6 mg) every 5 minutes up to a maximum of 3 doses\n",
        );
      },
    },
    {
      // 原句 is the label's other word and an ASCII colon its other
      // punctuation. A run told to stop writing 原文： reaches for the nearest
      // spelling, and a spelling only one side reads is a package failed for a
      // sentence its own preflight accepted. The quoted clause is deliberately
      // short, so the label alone is what decides this case.
      label: "the same device relabelled 原句 with an ASCII colon",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n该说明书对给药途径有明确表述。原句: sublingual administration is preferred\n",
        );
      },
    },
    {
      // The finding the question was built on, left in the source's sentences
      // instead of being stated in the paper's own voice with its citation.
      // No label introduces it, so only the length of the run identifies it.
      label: "the pivotal finding left in the source's own language",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\ncarriers of the ALDH2 rs671 variant showed a lower response rate than non-carriers, "
            + "and the difference persisted after adjustment for age and sex\n",
        );
      },
    },
    {
      // 本文以……为读者 is above, verbatim from line 21 of the returned report.
      // These are the same declaration in the shapes a run reaches for next, and
      // each is a separate branch of the pattern on both sides.
      label: "the readership declared with 面向 instead of 以……为读者",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n本文面向临床医师与药师，说明两种院外自救用药的证据位置。\n",
        );
      },
    },
    {
      label: "the readership declared as a target-reader field",
      break: (input) => {
        input.reportText = input.reportText.replace("## 讨论\n", "## 讨论\n本报告的目标读者为基层全科医师。\n");
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
      // The flatter form of the same error, and the one the skill names first:
      // the verdict verb changes from a recommendation to a property of the
      // drug, while the evidence behind it is still an empty search.
      label: "a gap summarised into a statement that the drug does not work",
      break: (input) => {
        input.reportText = input.reportText.replace("## 讨论\n", "## 讨论\n未检索到直接证据，所以该药无疗效。\n");
      },
    },
    {
      label: "a GRADE level reaching 高 in the same sentence as a downgrade reason",
      break: (input) => {
        input.reportText = input.reportText
          .replace("## 检索与方法\n", "## 检索与方法\n证据体确定性以 GRADE 表述。\n")
          .replace(
            "## 结果\n",
            "## 结果\n纳入研究整体方法学质量偏低、多数为单中心小样本试验，按 GRADE 在中至高之间 [5]。\n",
          );
      },
    },
    {
      // A hand-written flow sentence. The log and the receipt agree with each
      // other, so every existing check passes and nobody reads the prose.
      label: "a screening flow number the search log contradicts",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 结果\n",
          "## 结果\n共获得 40 条记录，去重并剔除无关记录后余 24 条，最终纳入 12 个来源。\n",
        );
      },
    },
    {
      // A record kept at included:false while it is numbered in 参考文献 and
      // cited in the body. sourcesIncluded === includedRecords.length still
      // holds, so the log reads as consistent.
      label: "a numbered reference whose source record was never included",
      break: (input) => {
        const log = JSON.parse(input.searchLogText);
        log.sourceRecords[11].included = false;
        log.sourceRecords[11].accessLevel = "bibliographic";
        log.sourceRecords[11].exclusionReason = "题录层级，未获全文";
        log.screening.sourcesIncluded = 11;
        input.searchLogText = JSON.stringify(log);
      },
    },
    {
      // A numbered entry nobody cites. The nearest existing check counts
      // entries, so padding the list satisfied it.
      label: "a numbered reference the body never cites",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "\n\n## 参考文献",
          "\n\n## 参考文献\n13. Walker NJ. Characteristics and outcomes of young adults with chest pain. Acad Emerg Med. 2001. PMID:11435184.",
        );
      },
    },
    {
      label: "a bibliographic identifier standing in the citation slot",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n与此最接近的研究均属间接：中医诊断变量信度研究[题录，PMID 22897413，全文未获]。\n",
        );
      },
    },
    {
      label: "a repeated claim marker on a line that does not carry its number",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "\n\n## 参考文献",
          "\n4. 发作频率增加时及时就医评估而非自行调整剂量 [6]。<!-- claim:CLM-001 -->\n\n## 参考文献",
        );
      },
    },
    {
      // An attributed position resting on a numeric quote. Every figure on the
      // line is in the cited quote, so the numeric audit is silent; the stance
      // is in no quote at all.
      label: "a position attributed to a source that only reported measurements",
      break: (input) => {
        input.matrix.claims[0].supportQuote = "213,976 women with 10,037 cardiovascular outcomes were followed for 5.3 to 15 years (RR = 1.28).";
        input.sourceArtifacts[input.matrix.claims[0].artifactPath]
          += `\n${input.matrix.claims[0].supportQuote}`;
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n作者将血管舒缩症状视为可能的心血管风险标记而非因果因素 [1] <!-- claim:CLM-001 -->\n",
        );
      },
    },
    {
      // Verbatim from a delivered report. [1] is a preserved journal source,
      // not the statute: an article locator asserts what a normative text says
      // at clause granularity, and only the issuing authority can carry that.
      label: "an article-level regulatory citation resting on a journal source",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n《医师法》第 29 条第 2 款将超说明书用药的合法条件规定为四点 [1]。\n",
        );
      },
    },
    {
      // Verbatim from a delivered practice point. The same section also carries
      // "服药不是等待的理由，应在服药的同时呼叫急救", so the two instructions are
      // mutually exclusive and a reader cannot execute both.
      label: "an emergency-call trigger conditioned on how the medicine performed",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "\n\n## 参考文献",
          "\n4. 胸痛持续、伴大汗、气促、含药不缓解者应立即拨打急救电话。[1] <!-- claim:CLM-001 -->\n\n## 参考文献",
        );
      },
    },
    {
      // The six rewritings the adversarial pass found. Each is the same
      // assertion as a case above with one thing changed, and each of them used
      // to pass both sides — so if either side loses one of them, the other
      // side must lose it too.
      label: "an emergency trigger rewritten across a comma and with a synonym",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "\n\n## 参考文献",
          "\n4. 若含服硝酸甘油后，症状仍不缓解，应立即拨打 120，不要自行驾车前往医院。[1] <!-- claim:CLM-001 -->\n\n## 参考文献",
        );
      },
    },
    {
      label: "an emergency trigger resumed by an anaphor after a full stop",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "\n\n## 参考文献",
          "\n4. 含服硝酸甘油一片后观察。仍不缓解者拨打 120。[1] <!-- claim:CLM-001 -->\n\n## 参考文献",
        );
      },
    },
    {
      label: "an emergency trigger stated with the drug named instead of the act",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "\n\n## 参考文献",
          "\n4. 若硝酸甘油未能奏效，应立即拨打 120。[1] <!-- claim:CLM-001 -->\n\n## 参考文献",
        );
      },
    },
    {
      label: "a GRADE verdict split from its downgrade reason by a full stop",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 结果\n",
          "## 结果\n纳入研究方法学质量普遍偏低 [1]。按 GRADE 属高级别证据 [1]。\n",
        );
      },
    },
    {
      label: "an article-level statute citation written without its book-title marks",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n医师法第 29 条第 2 款将超说明书用药的合法条件规定为四点 [1]。\n",
        );
      },
    },
    {
      label: "an attributed stance with a measure word inside the subject",
      break: (input) => {
        input.matrix.claims[0].supportQuote = "213,976 women with 10,037 cardiovascular outcomes were followed for 5.3 to 15 years (RR = 1.28).";
        input.sourceArtifacts[input.matrix.claims[0].artifactPath]
          += `\n${input.matrix.claims[0].supportQuote}`;
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n这项研究认为血管舒缩症状是可能的心血管风险标记 [1] <!-- claim:CLM-001 -->\n",
        );
      },
    },
    {
      // The stance exemption on both sides has to clear the same quotes. This
      // one carries `could` and `our` and no position at all.
      label: "a stance exemption resting on a token rather than on a predication",
      break: (input) => {
        input.matrix.claims[0].supportQuote = "You could be having a heart attack. Forty-one trials involving 6276 patients were included in our analysis (RR = 1.28).";
        input.sourceArtifacts[input.matrix.claims[0].artifactPath]
          += `\n${input.matrix.claims[0].supportQuote}`;
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n该研究提示血管舒缩症状是可能的心血管风险标记 [1] <!-- claim:CLM-001 -->\n",
        );
      },
    },
    {
      // The practical section located by a heading neither side recognises.
      label: "the practical answer written under a heading outside the vocabulary",
      break: (input) => {
        input.reportText = input.reportText.replace("## 实际处置", "## 结论与处置建议");
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
    // The question-coverage ledger. It is the newest deliverable and the one a
    // run writes last, which is exactly when a run is most likely to be told
    // "done" by the preflight and then failed by the gate. One case per
    // cross-check, each breaking only that check.
    {
      label: "a coverage ledger that is not there at all",
      break: (input) => {
        input.keepCoverage = true;
        input.questionCoverageText = "";
      },
    },
    {
      label: "a coverage entry whose status is neither answered nor gap",
      break: (input) => {
        const ledger = JSON.parse(input.questionCoverageText);
        ledger.entries[0].status = "partial";
        input.keepCoverage = true;
        input.questionCoverageText = JSON.stringify(ledger);
      },
    },
    {
      label: "an answered sub-question pointing past the end of the report",
      break: (input) => {
        const ledger = JSON.parse(input.questionCoverageText);
        ledger.entries[0].reportLines = [9999];
        input.keepCoverage = true;
        input.questionCoverageText = JSON.stringify(ledger);
      },
    },
    {
      label: "an answered sub-question pointing at the reference list",
      break: (input) => {
        const referencesLine = input.reportText.split("\n").findIndex((line) => /^1\. Author group\./.test(line)) + 1;
        const ledger = JSON.parse(input.questionCoverageText);
        ledger.entries[0].reportLines = [referencesLine];
        ledger.entries[1].reportLines = [referencesLine];
        input.keepCoverage = true;
        input.questionCoverageText = JSON.stringify(ledger);
      },
    },
    {
      label: "a declared gap whose search never ran",
      break: (input) => {
        const ledger = JSON.parse(input.questionCoverageText);
        ledger.entries[2].searches = [{
          query: "a search that was never run in this session",
          database: "PubMed",
          searchedAt: "2026-02-11",
        }];
        input.keepCoverage = true;
        input.questionCoverageText = JSON.stringify(ledger);
      },
    },
    {
      label: "a registered gap written as a finding in the conclusion",
      break: (input) => {
        const ledger = JSON.parse(input.questionCoverageText);
        ledger.entries[2].question = "本品在夜间低血压人群中的院外自救有无以临床结局为终点的直接研究";
        input.keepCoverage = true;
        input.questionCoverageText = JSON.stringify(ledger);
        input.reportText = input.reportText.replace(
          "## 结论\n",
          "## 结论\n本品在夜间低血压人群中的院外自救无相关证据 [1] <!-- claim:CLM-001 -->。\n",
        );
      },
    },
    {
      // Was "an abstract that restates five questions as three", which the
      // gate caught by comparing two numbers the run wrote itself. It now
      // compares against the brief, and this is the construction that walked
      // through the old rule: register one of the brief's two questions, mark
      // it answered, and never contradict yourself anywhere.
      label: "a brief question the ledger does not register at all",
      break: (input) => {
        const ledger = JSON.parse(input.questionCoverageText);
        ledger.entries = ledger.entries.filter((entry) => !entry.id.startsWith("2."));
        input.keepCoverage = true;
        input.questionCoverageText = JSON.stringify(ledger);
      },
    },
    {
      label: "a ledger entry that does not transcribe the brief question its id names",
      break: (input) => {
        const ledger = JSON.parse(input.questionCoverageText);
        ledger.entries[0].question = "本报告自拟的一条概括性子问，与题面任何一问都无关";
        input.keepCoverage = true;
        input.questionCoverageText = JSON.stringify(ledger);
      },
    },
    {
      label: "an item the brief spells out that the report never uses",
      break: (input) => {
        input.briefText = researchBrief().replace(
          "1. 胸口突然发闷发紧",
          "1. 请给出心率、血压、心率变异性、儿茶酚胺水平、房性期前收缩负荷、炎症指标、随访时长各自的实测数据。胸口突然发闷发紧",
        );
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n本节给出心率、血压与心率变异性的实测数据。\n",
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

test("what the gate degrades, the preflight also degrades", async () => {
  // The other half of the same invariant. A gap the gate reports without
  // withholding delivery must not stop the run either, or the skill's
  // "fix every preflight issue and rerun until ok=true" makes a finished
  // package unfinishable over something the gate would have delivered.
  const cases = [
    {
      // Seven instruments declared and none executed, as delivered. Blocking
      // on it rejected twenty-nine of the thirty delivered packages, because
      // pre-specifying an instrument per design stratum is what the method
      // section is supposed to do and an empty stratum owes no retraction.
      label: "an appraisal instrument named in the methods and never applied",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 检索与方法\n",
          "## 检索与方法\n干预性研究用 Cochrane RoB 2 评估偏倚风险，系统评价用 AMSTAR 2。\n",
        );
      },
      pattern: /资料与方法声明了 /,
    },
    {
      label: "an appraisal instrument hedged with 思路, which is not using it",
      break: (input) => {
        input.reportText = input.reportText.replace(
          "## 检索与方法\n",
          "## 检索与方法\n药物—不良事件因果判断采用 Naranjo 思路；本报告未做新因果判断。\n",
        );
      },
      pattern: /资料与方法声明了 /,
    },
    {
      // The exclusion ledger is the search apparatus describing itself, not a
      // claim about medicine. Blocking on it also judged twenty-two delivered
      // packages by a field the spec did not have when they were written.
      label: "an excluded source record with no exclusion reason",
      break: (input) => {
        const log = JSON.parse(input.searchLogText);
        log.sourceRecords.push({
          sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/evidence/source-13",
          included: false,
          accessLevel: "bibliographic",
        });
        input.searchLogText = JSON.stringify(log);
      },
      pattern: /sourceRecords\[\d+\] 标记为 "included": false/,
    },
  ];

  for (const scenario of cases) {
    const input = deepResearchPackage();
    scenario.break(input);
    const { gate, preflight } = await verdicts(input, scenario.label);
    assert.equal(
      gate.issues.some((issue) => scenario.pattern.test(issue)),
      true,
      `${scenario.label}: the gate no longer reports this at all, so this case tests nothing`,
    );
    assert.deepEqual(
      gate.blockingIssues.filter((issue) => scenario.pattern.test(issue)),
      [],
      `${scenario.label}: this is degradable and must not withhold the package`,
    );
    assert.equal(
      preflight.issues.some((issue) => scenario.pattern.test(issue)),
      false,
      `${scenario.label}: the gate delivers this package but the preflight fails the run for it`,
    );
    assert.equal(
      preflight.notes.some((note) => scenario.pattern.test(note)),
      true,
      `${scenario.label}: the run must still be told, as advice`,
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
      // Lowercase, so Title Case does not exempt it, and past twelve words. It
      // is still not a sentence: English prose is held together by closed-class
      // words and an enumeration of technical terms carries none.
      label: "a drug class listed by INN",
      write: "硝酸酯类包括 isosorbide dinitrate, isosorbide mononitrate, nitroglycerin, glyceryl trinitrate, pentaerythritol tetranitrate, erythrityl tetranitrate, amyl nitrite, sodium nitroprusside 等。",
    },
    {
      // The report is asked to bridge from mechanism where direct evidence is
      // thin, and a signalling cascade is named in Latin molecule by molecule.
      label: "a signalling cascade named molecule by molecule",
      write: "该通路依次涉及 nitric oxide, cyclic guanosine monophosphate, soluble guanylate cyclase, protein kinase G, myosin light chain phosphatase 等分子。",
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
      // The gap in the exact form the skill prescribes as the repair: the failed
      // search, then the study that would answer the question. It carries every
      // word the rejected form carries, so a run that follows the instruction
      // and is rejected for it has nowhere left to go.
      label: "a gap stated with the study that would close it",
      write: "未检索到支持其用于该场景的直接随机对照证据；能够回答该问题的研究应为以院外未分化胸痛人群为对象、"
        + "以临床结局为终点的随机对照试验。",
    },
    {
      label: "a recommendation reported with the body that made it",
      write: "该指南因缺乏随机对照证据，不推荐将其常规用于未分化胸痛 [3]。",
    },
    {
      // The two instruments the method is required to name, in the sentences the
      // skill prescribes for them. Both carry 判定, and neither delivers a
      // verdict on a proposition of this report's own.
      label: "the appraisal instruments named the way the method must name them",
      write: "证据体按 GRADE 判定证据确定性为低；不良反应因果关系采用 Naranjo 量表进行因果关系判定。",
    },
    {
      // The Latin script a Chinese manuscript carries by convention, three kinds
      // on one line: a journal, an INN beside its Chinese name, and an
      // abbreviation expanded at first use. Each sits inside a Chinese sentence,
      // which is what keeps every run short.
      label: "a journal name, an INN, and an abbreviation expanded at first use",
      write: "该研究发表于 Frontiers in Pharmacology；硝酸甘油（nitroglycerin, NTG）用于急性冠脉综合征"
        + "（acute coronary syndrome, ACS）的症状缓解。",
    },
    {
      // 面向 and 写给 with something other than the paper as their subject. A
      // guideline states whom it was written for and that is a property of the
      // guideline; a leaflet's audience is a finding about the leaflet.
      label: "another document's readership, which is a finding and not self-reference",
      write: "该指南面向基层医疗机构医师制定，其推荐强度与证据等级分列；该科普手册写给患者家属参考，其内容未经系统评价。",
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
    // Scoped to the three families, because these fixture lines carry figures
    // and citations that the unrelated numeric-provenance checks read.
    const families = [/^临床实践要点第 \d+ 行把/, /^GRADE 等级与降级理由不自洽/, /^资料与方法声明了 /];
    const preflightFamilies = [/^practical line \d+: 「/, /GRADE 等级与降级理由不自洽/, /资料与方法声明了 /];
    assert.deepEqual(
      gate.issues.filter((issue) => families.some((pattern) => pattern.test(issue))),
      [],
      `${write}: the gate flags a line the adversarial pass proved compliant`,
    );
    assert.deepEqual(
      preflight.issues.filter((issue) => preflightFamilies.some((pattern) => pattern.test(issue))),
      [],
      `${write}: the preflight fails a run over a line the gate delivers`,
    );
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

  // The untranslated-prose notice is read off a second blanked copy — 参考文献
  // gone, and 检索与方法 gone as well, because a search strategy is in the
  // source language by design. That is two blanking passes per side that have
  // to stay aligned with each other and with the file the author is editing.
  for (const [write, gateReason, preflightReason] of [
    ["原文：sublingual administration is preferred", "pastes a source quotation", "a source quotation is pasted"],
    [
      "the recommended doses of NTG include sublingual or spray every 5 minutes up to a maximum of 3 doses",
      "carries \\d+ consecutive words of untranslated source prose",
      "\\d+ consecutive words of untranslated source prose",
    ],
  ]) {
    const shifted = deepResearchPackage();
    shifted.reportText = shifted.reportText.replace("## 局限与不确定性\n", `## 局限与不确定性\n${write}\n`);
    const line = shifted.reportText.split("\n").findIndex((text) => text.includes(write)) + 1;
    const named = await verdicts(shifted, write);
    assert.match(named.gate.issues.join("\n"), new RegExp(`report line ${line} ${gateReason}`));
    assert.match(named.preflight.issues.join("\n"), new RegExp(`line ${line}: ${preflightReason}`));
  }
});

test("statistics are Latin script the manuscript cannot translate, and both sides read them as statistics", async () => {
  // The comparison the returned report was built on is a table of figures: a
  // variant identifier, two response rates, a risk ratio with its interval, a p
  // value. None of it can be written in Chinese and all of it is Latin script,
  // so a run of consecutive Latin words is the wrong thing to count here — which
  // is why the run is cut at every CJK character and the count only ever sees
  // one fragment. The figures are wired to the claim that states them, which is
  // what the numeric audit asks of any number in the body.
  const input = deepResearchPackage();
  const quote = "In this cohort the response rate was 50.6% among carriers and 79.4% among non-carriers "
    + "(RR 0.82, 95% CI 0.75-0.90, P < 0.01).";
  const [first] = input.matrix.claims;
  first.supportQuote = quote;
  input.sourceArtifacts[first.artifactPath] += `\n${quote}`;
  input.citationLedgerText = input.citationLedgerText
    .split("\n")
    .map((row) => (row.startsWith(`${first.claimId},`) ? `${first.claimId},${first.referenceNumber},"${quote}"` : row))
    .join("\n");
  input.reportText = input.reportText.replace(
    "## 讨论\n",
    "## 讨论\n携带 ALDH2 rs671 变异者的缓解率为 50.6%，非携带者为 79.4%（RR 0.82，95%CI 0.75–0.90，P < 0.01）。"
      + `[${first.referenceNumber}](${first.sourceUrl}) <!-- claim:${first.claimId} -->\n`,
  );
  const { gate, preflight } = await verdicts(input, "statistics");
  assert.equal(gate.valid, true, gate.issues.join("\n"));
  assert.equal(preflight.ok, true, JSON.stringify(preflight.issues));
});

test("the reference list is untranslated by definition, and it is the only section that is", async () => {
  // A bibliography is written in the sources' language — that is what a
  // bibliography is — so both sides blank the whole section before reading
  // register. The exemption has to be the section and not the string: the same
  // title one section earlier is exactly the pasted source prose the rule exists
  // for, and a rule that exempted the words would have no rule left.
  const title = "Sublingual nitroglycerin versus placebo for the relief of ischaemic chest pain in the "
    + "prehospital setting: a multicentre randomised controlled trial";

  const listed = deepResearchPackage();
  listed.reportText = listed.reportText.replace(
    "1. Author group. Verified clinical source 1.",
    `1. Author group. ${title}. Verified clinical source 1.`,
  );
  const cited = await verdicts(listed, "an untranslated title in the reference list");
  assert.equal(cited.gate.valid, true, cited.gate.issues.join("\n"));
  assert.equal(cited.preflight.ok, true, JSON.stringify(cited.preflight.issues));

  const body = deepResearchPackage();
  body.reportText = body.reportText.replace("## 讨论\n", `## 讨论\n${title}。\n`);
  const inBody = await verdicts(body, "the same title in the discussion");
  assert.equal(inBody.gate.valid, false, "the exemption is the section, not the title");
  assert.equal(inBody.preflight.ok, false, JSON.stringify(inBody.preflight.issues));
});

// The axis table the comparison rule asks for, written the way the skill writes
// it. No cell carries a quantity, so the numeric audit has nothing to wire up
// and the table is testing the comparison rule and nothing else.
const comparisonAxes = [
  "| 维度 | 舌下含服硝酸甘油 | 该中成药制剂 | 该维度可支持的结论边界 |",
  "| --- | --- | --- | --- |",
  "| 核准适用场景 | 心绞痛发作的急性缓解与预防 [1] | 气滞血瘀型冠心病心绞痛 [7] | 只能判断某一用法是否落在核准范围内 |",
  "| 急性按需使用证据 | 已确诊心绞痛发作人群，结局为症状缓解与血流动力学 [2] | 未检索到以急性发作缓解时间为结局的随机对照研究 | 可分别陈述，不足以排序 |",
  "| 人群反应差异 | 按基因型分层的缓解率差异已被测得 [9] | 未检索到按基因型分层的反应数据 | 一方为已测得的异质性，另一方为未测量 |",
].join("\n");

test("a comparison the title announces is carried out on fixed axes, on both sides", async () => {
  // The commissioned report's own defect: the title promised a comparison of two
  // medicines and the body reviewed each one's literature in turn, then closed
  // with a shared verdict. The two accounts never met, so the verdict came from
  // whichever arm had the thinner file — which is how "both lack evidence in
  // out-of-hospital self-rescue" got written over an arm with an approved
  // indication and an established use.
  //
  // Only the absence of the matrix is decidable: which columns are the arms is
  // not readable from the text, so what is required is a table with an axis
  // column and one column per arm, and nothing is asserted about its rows.
  const missing = deepResearchPackage();
  missing.reportText = missing.reportText.replace(
    "# 急性胸部压迫感的鉴别与处置",
    "# 急性胸痛院外自救用药的证据评价：两种含服制剂的比较",
  );
  const withoutMatrix = await verdicts(missing, "a comparative title with no matrix");
  assert.equal(withoutMatrix.gate.valid, false);
  assert.match(withoutMatrix.gate.issues.join("\n"), /titled as a comparison .* but no table in the analysis body/s);
  assert.equal(
    withoutMatrix.preflight.ok,
    false,
    `the gate rejects this package but the preflight accepted it: ${JSON.stringify(withoutMatrix.preflight.issues)}`,
  );
  assert.match(withoutMatrix.preflight.issues.join("\n"), /the title announces a comparison/);

  // The same title over a body that fills the axes. This is the repair the
  // notice asks for, so it must clear both sides.
  const filled = deepResearchPackage();
  filled.reportText = filled.reportText
    .replace("# 急性胸部压迫感的鉴别与处置", "# 急性胸痛院外自救用药的证据评价：两种含服制剂的比较")
    .replace("## 讨论\n", `## 讨论\n${comparisonAxes}\n`);
  const withMatrix = await verdicts(filled, "a comparative title with its matrix");
  assert.equal(withMatrix.gate.valid, true, withMatrix.gate.issues.join("\n"));
  assert.equal(withMatrix.preflight.ok, true, JSON.stringify(withMatrix.preflight.issues));

  // A title is not a comparison merely because it contains 对比: 对比剂 is an
  // ordinary pharmacology noun, and a paper about contrast-induced nephropathy
  // compares nothing.
  const contrastAgent = deepResearchPackage();
  contrastAgent.reportText = contrastAgent.reportText.replace(
    "# 急性胸部压迫感的鉴别与处置",
    "# 碘对比剂相关急性肾损伤的证据评价",
  );
  const unrelated = await verdicts(contrastAgent, "对比剂 in a title");
  assert.equal(unrelated.gate.valid, true, unrelated.gate.issues.join("\n"));
  assert.equal(unrelated.preflight.ok, true, JSON.stringify(unrelated.preflight.issues));
});

test("a substitution claim the report says it has no comparison for is rejected on both sides", async () => {
  // The bridge the commissioned report walked in silence: a variant lowers one
  // arm's response, therefore switch to the other. Links 3 to 6 — that the other
  // arm is untouched by the same pathway, that switching improves outcomes, that
  // it substitutes at all, that the genotype is a selection rule — were never
  // established, and an arm never tested for a mechanism is untested rather than
  // immune.
  //
  // What is decidable is not how strong the evidence should have been. It is
  // that the report states there is no direct comparison and then concludes one
  // anyway; the licence a substitution claim needs is exactly the comparison it
  // has just said does not exist.
  const declared = "未检索到两者在该场景的头对头随机对照比较。";
  for (const write of [
    "此类人群可改用该中成药制剂。",
    "对低反应人群，该中成药制剂可能是更合适的选择。",
    "就院外自救而言后者更为可靠。",
    // A link asserted 已建立 is the conclusion itself, and a source noun in
    // front of the verb does not turn a claim about the medicines into a claim
    // about the literature. Neither exemption may become a way through.
    "低反应者改用该中成药制剂后结局更好，该环已建立。",
    "现有研究表明该中成药制剂优于硝酸甘油。",
  ]) {
    const input = deepResearchPackage();
    input.reportText = input.reportText.replace("## 讨论\n", `## 讨论\n${declared}\n${write}\n`);
    const { gate, preflight } = await verdicts(input, write);
    assert.equal(gate.valid, false, `${write}: the gate accepted a substitution claim it has no comparison for`);
    assert.match(gate.issues.join("\n"), /concludes that one arm can take the other's place/);
    assert.equal(
      preflight.ok,
      false,
      `${write}: the gate rejects this package but the preflight returned ok=true, `
        + JSON.stringify(preflight.issues),
    );
    assert.match(preflight.issues.join("\n"), /can take the other's place/);
  }

  // Every one of these carries the words the rule reads, beside the same
  // declared absence, and none of them is a substitution claim. Rejecting one
  // would send the run back to break a sentence the skill prescribes.
  for (const write of [
    // The skill's own 正例 for the bridge that does not close.
    "ALDH2 相关反应差异提示，院外心绞痛用药效果可能存在显著个体差异，不宜将硝酸甘油视为对所有中国患者反应完全一致的单一标准。"
      + "另一药具有不同的药物组成和证据路径，但其在低反应人群中的相对价值仍需直接临床研究验证。",
    // The skill's 正例 for the merged PICO, whose 替代 is the safety statement.
    "两药在已确诊冠心病心绞痛患者中均有相应应用依据，但在首次发生或病因未明的院外急性胸痛中，现有证据不能支持患者自行选择药物替代专业评估。",
    // A trial's own control arm, which is not the other arm of this comparison.
    "该试验中试验组的症状缓解率优于对照组 [11]。",
    // Somebody else's recommendation, reported with the body that made it.
    "该指南建议含服无效者改用静脉给药 [2]。",
    // The safety instruction, at the full strength the practical section owes it.
    "任何自救药物都不能替代及时呼救与心电图评估。",
    // The gap stated as a gap, which is the sentence the notice asks for.
    "两药的相对效能尚不能判断，缺乏可回答该问题的随机对照研究。",
    // The bridge written out link by link, which is the repair this rule's own
    // notice asks for: the link that has not been shown is word for word the
    // sentence the rule reads as a conclusion, so the 未建立 mark licenses it
    // whether it sits in the same clause, a clause away, or in the short
    // sentence that follows.
    "低反应者改用该中成药制剂后结局更好：未建立，未检索到以临床结局为终点的研究。",
    "链条的第四环是低反应者改用该中成药制剂后结局更好。该环未建立。",
    // Asking the question this rule exists to keep open is not answering it.
    "低反应人群是否应换用该中成药制剂，目前尚无研究可以回答。",
    // Which evidence base is stronger is a statement about the literature: an
    // axis may hold measured evidence on one arm and nothing on the other
    // without any head-to-head study existing anywhere.
    "该维度上硝酸甘油的证据强度优于该中成药制剂 [2]。",
  ]) {
    const input = deepResearchPackage();
    input.reportText = input.reportText.replace("## 讨论\n", `## 讨论\n${declared}\n${write}\n`);
    const { gate, preflight } = await verdicts(input, write);
    // Scoped to the three families, because these fixture lines carry figures
    // and citations that the unrelated numeric-provenance checks read.
    const families = [/^临床实践要点第 \d+ 行把/, /^GRADE 等级与降级理由不自洽/, /^资料与方法声明了 /];
    const preflightFamilies = [/^practical line \d+: 「/, /GRADE 等级与降级理由不自洽/, /资料与方法声明了 /];
    assert.deepEqual(
      gate.issues.filter((issue) => families.some((pattern) => pattern.test(issue))),
      [],
      `${write}: the gate flags a line the adversarial pass proved compliant`,
    );
    assert.deepEqual(
      preflight.issues.filter((issue) => preflightFamilies.some((pattern) => pattern.test(issue))),
      [],
      `${write}: the preflight fails a run over a line the gate delivers`,
    );
  }
});

test("the merged PICO, the unanswered question and the unlicensed substitution are advice", async () => {
  // Three more defects the commissioning reviewers named, none of them
  // decidable. Whether 结论 answered a question in prose, whether this
  // question's population has strata at all, and whether a comparison the
  // report never mentions exists in the literature are all judgements a pattern
  // cannot make — so each is reported to the run while it can still act, none
  // of them decides ok, and none has a server counterpart.
  const drifted = deepResearchPackage();
  drifted.reportText = drifted.reportText
    .replace(
      "## 摘要\n",
      "## 摘要\n目的：（1）比较两种含服制剂在同一场景中的证据位置；（2）评价基因型相关的人群反应差异；"
        + "（3）界定自救用药的安全边界。方法：系统检索并按主张逐条对应。\n",
    )
    .replace("## 结论\n", "## 结论\n（1）两者的证据位置以固定维度分别陈述。（2）人群反应差异已被测得，其外推受到限制。\n");
  const questions = await verdicts(drifted, "three questions, two answers");
  assert.equal(questions.preflight.ok, true, JSON.stringify(questions.preflight.issues));
  assert.equal(questions.gate.valid, true, questions.gate.issues.join("\n"));
  assert.match(questions.preflight.notes.join("\n"), /目的 lists 3 research questions and 结论 gives 2 numbered answers/);

  // One verdict for every arm at once, over a report that never names a
  // stratum: the shape a merged PICO takes in a sentence. The stratum with the
  // least evidence sets the verdict for all of them, and the uses that do have
  // an established basis are never asked about on their own.
  const merged = deepResearchPackage();
  merged.reportText = merged.reportText.replace("## 讨论\n", "## 讨论\n两药在院外自救场景中均缺乏证据。\n");
  const mergedRun = await verdicts(merged, "one verdict for every arm");
  assert.equal(mergedRun.preflight.ok, true, JSON.stringify(mergedRun.preflight.issues));
  assert.equal(mergedRun.gate.valid, true, mergedRun.gate.issues.join("\n"));
  assert.match(mergedRun.preflight.notes.join("\n"), /one verdict is given for every arm at once/);

  // The same sentence with its stratum named is the repair, and the repair must
  // not draw the note again.
  const stratified = deepResearchPackage();
  stratified.reportText = stratified.reportText.replace(
    "## 讨论\n",
    "## 讨论\n两药在已确诊冠心病心绞痛患者中均有相应应用依据，但在首次发生或病因未明的院外急性胸痛中，"
      + "现有证据不能支持患者自行选择药物替代专业评估。\n",
  );
  const stratifiedRun = await verdicts(stratified, "the stratum named");
  assert.equal(stratifiedRun.preflight.ok, true, JSON.stringify(stratifiedRun.preflight.issues));
  assert.deepEqual(stratifiedRun.preflight.notes, []);

  // A substitution claim over a report that never says whether a direct
  // comparison exists. The gate stays silent — it rejects the contradiction,
  // not the silence — so this one has to reach the run as advice or not at all.
  const unlicensed = deepResearchPackage();
  unlicensed.reportText = unlicensed.reportText.replace("## 讨论\n", "## 讨论\n此类人群可改用该中成药制剂。\n");
  const unlicensedRun = await verdicts(unlicensed, "a substitution claim with nothing said about comparison");
  assert.equal(unlicensedRun.preflight.ok, true, JSON.stringify(unlicensedRun.preflight.issues));
  assert.equal(unlicensedRun.gate.valid, true, unlicensedRun.gate.issues.join("\n"));
  assert.match(unlicensedRun.preflight.notes.join("\n"), /never says whether a direct comparison between them exists/);

  // Length is a claim about importance, and which section serves which question
  // is not decidable either — so the shares are measured and handed over, and
  // the run applies the rule.
  const { preflight } = await verdicts(deepResearchPackage(), "section shares");
  const shares = preflight.metrics.sectionShares;
  assert.ok(Object.keys(shares).length >= 6, JSON.stringify(shares));
  assert.ok(!Object.keys(shares).some((heading) => heading.includes("参考文献")), JSON.stringify(shares));
  assert.ok(Math.abs(Object.values(shares).reduce((total, share) => total + share, 0) - 100) <= 5, JSON.stringify(shares));
});

test("both sides look for the matrix in the analysis body, and both read it as a matrix", async () => {
  // Two judgements are duplicated in two languages here: which sections are the
  // analysis (both blank 参考文献 and 检索与方法 before looking) and what counts
  // as a matrix (three columns, two filled rows). A run that satisfies one side
  // and not the other is told it is done and then failed for the table it just
  // wrote — the exact failure this file exists to prevent.
  const comparativeTitle = "# 急性胸痛院外自救用药的证据评价：两种含服制剂的优劣";
  const oneArmColumn = [
    "| 维度 | 该中成药制剂 |",
    "| --- | --- |",
    "| 核准适用场景 | 气滞血瘀型冠心病心绞痛 [7] |",
    "| 急性按需使用证据 | 未检索到以急性发作缓解时间为结局的随机对照研究 |",
  ].join("\n");
  for (const [placement, anchor, table] of [
    // A table under 检索与方法 is a search strategy and a table under 参考文献 is
    // somebody else's paper. Neither shows this report's arms meeting, and both
    // sections are blanked before either side looks.
    ["the matrix left in 检索与方法", "## 检索与方法\n", comparisonAxes],
    ["the matrix left in 参考文献", "## 参考文献\n", comparisonAxes],
    // One arm's column with the other's missing is a summary of one medicine.
    ["one arm's column, the other's missing", "## 讨论\n", oneArmColumn],
  ]) {
    const input = deepResearchPackage();
    input.reportText = input.reportText
      .replace("# 急性胸部压迫感的鉴别与处置", comparativeTitle)
      .replace(anchor, `${anchor}${table}\n`);
    const { gate, preflight } = await verdicts(input, placement);
    assert.equal(gate.valid, false, `${placement}: the gate accepted a comparison with no matrix in its body`);
    assert.match(gate.issues.join("\n"), /but no table in the analysis body/, placement);
    assert.equal(
      preflight.ok,
      false,
      `${placement}: the gate rejects this package but the preflight accepted it: ${JSON.stringify(preflight.issues)}`,
    );
    assert.match(preflight.issues.join("\n"), /the title announces a comparison/, placement);
  }
});

test("the absence may be declared after the conclusion it contradicts, and both sides name the same two lines", async () => {
  // 讨论 concludes and 局限 declares the gap — the order a manuscript is written
  // in, and the reverse of the order the check reads in. Both sides scan the
  // whole body for the declaration before judging any sentence, and both count
  // lines over their own blanked copy, so a notice that names a line the author
  // cannot find is a repair with nowhere to go.
  const input = deepResearchPackage();
  const conclusion = "低反应者可换用该中成药制剂。";
  const absence = "两药之间缺乏头对头随机对照比较。";
  input.reportText = input.reportText
    .replace("## 讨论\n", `## 讨论\n${conclusion}\n`)
    .replace("## 局限与不确定性\n", `## 局限与不确定性\n${absence}\n`);
  const lines = input.reportText.split("\n");
  const conclusionLine = lines.findIndex((line) => line.includes(conclusion)) + 1;
  const absenceLine = lines.findIndex((line) => line.includes(absence)) + 1;
  const { gate, preflight } = await verdicts(input, "the absence declared after the conclusion");
  assert.equal(gate.valid, false, "the gate accepted a swap it has just said it has no comparison for");
  assert.match(gate.issues.join("\n"), new RegExp(`report line ${conclusionLine} concludes that one arm`));
  assert.match(gate.issues.join("\n"), new RegExp(`while line ${absenceLine} states`));
  assert.equal(
    preflight.ok,
    false,
    `the gate rejects this package but the preflight accepted it: ${JSON.stringify(preflight.issues)}`,
  );
  assert.match(preflight.issues.join("\n"), new RegExp(`line ${conclusionLine}: the report concludes`));
  assert.match(preflight.issues.join("\n"), new RegExp(`while line ${absenceLine} states`));
});

test("the sentences the reviewers wrote as the repair pass both sides unchanged", async () => {
  // A false rejection costs more than a missed one here: the run is sent back to
  // break a sentence the reviewers themselves wrote as the correct form, and it
  // has no way to say what the evidence says. Each of these carries the words
  // the rule reads, beside the declared absence that arms it.
  const declared = "未检索到两者在该场景的头对头随机对照比较。";
  for (const write of [
    // Refusing the swap, written with the verb the rule blocks. The reviewers'
    // wording names both medicines; this fixture's question names none, and a
    // medicine-free question may not have one introduced into its report, so the
    // arms are written the way this report writes them. The reviewers' exact
    // sentence is pinned in clinicalEvidenceQuality.test.mjs, whose question is
    // about that medicine.
    "尚无证据支持以该中成药制剂替代含服硝酸酯。",
    // The bridge that stops at the last established link, standing on its own
    // line rather than inside the paragraph the earlier test writes it in.
    "其在 ALDH2 低反应人群中的相对价值仍需直接临床研究验证。",
    // Somebody else's comparison, under the two source nouns the attributed
    // pattern carries besides 指南 and 该试验 — which is how most cross-arm
    // sentences in a review get there at all.
    "该系统评价报告含服硝酸酯的缓解率优于该中成药制剂 [3]。",
    "该 Meta 分析显示该中成药制剂优于安慰剂 [5]。",
  ]) {
    const input = deepResearchPackage();
    input.reportText = input.reportText.replace("## 讨论\n", `## 讨论\n${declared}\n${write}\n`);
    const { gate, preflight } = await verdicts(input, write);
    assert.equal(gate.valid, true, `${write}: ${gate.issues.join("\n")}`);
    assert.equal(preflight.ok, true, `${write}: ${JSON.stringify(preflight.issues)}`);
  }

  // The merged-PICO note reads a verdict given for every arm at once, and one
  // verdict is legitimately true of every stratum at once: that no head-to-head
  // study exists. Drawing the note there would teach the run to stratify a
  // sentence that has nothing to stratify.
  const shared = deepResearchPackage();
  shared.reportText = shared.reportText.replace("## 讨论\n", "## 讨论\n两药之间均未检索到头对头随机对照研究证据。\n");
  const sharedRun = await verdicts(shared, "a shared absence of head-to-head evidence");
  assert.equal(sharedRun.gate.valid, true, sharedRun.gate.issues.join("\n"));
  assert.equal(sharedRun.preflight.ok, true, JSON.stringify(sharedRun.preflight.issues));
  assert.deepEqual(sharedRun.preflight.notes, []);
});

test("the lines the adversarial pass proved compliant clear both sides", async () => {
  // Verbatim from delivered packages, each rejected by the first version of one
  // of these rules. A rule that rejects them buys delivery with methodological
  // transparency or with a safety sentence, which is the wrong trade in both
  // directions — and it has to be the wrong trade on both sides at once, or a
  // run fixes the preflight and is failed by the gate anyway.
  for (const [where, write] of [
    // The emergency rule: a clause boundary the span may not cross, and a
    // rejection that may stand anywhere later in the sentence.
    ["practical", "4. 慢性稳定型心绞痛患者，症状经首次含服明显改善后，方可每间隔 5 分钟重复给药；未完全缓解即呼叫 120。"],
    ["practical", "5. 已服药者，出现新发晕厥、意识不清且症状不缓解，立即呼叫 120。"],
    ["practical", "3. 若含服后心绞痛持续不缓解或性质改变，应立即呼叫急救，不得因已服药而推迟。"],
    ["practical", "6. 含服后 20 分钟以上胸痛不缓解符合急性心肌梗死的警示特征，应立即呼叫 120，症状自觉缓解不等同于心肌缺血解除。"],
    // The GRADE rule: naming the five domains is how a high-certainty verdict
    // is justified, not how it is contradicted.
    ["body", "两项大型随机对照试验偏倚风险低、结果一致、估计精确、无发表偏倚证据，按 GRADE 评为高确定性 [1]。"],
    ["body", "未对任何领域降级，按 GRADE 评为高确定性 [1]。"],
    // The appraisal rule: a body-level certainty stands a paragraph below the
    // studies it grades and carries no bracket of its own.
    ["body", "综合而言，机制层面可支持方向性结论，按 GRADE 属低确定性，降级理由为间接性。"],
  ]) {
    const input = deepResearchPackage();
    input.reportText = where === "practical"
      ? input.reportText.replace("\n\n## 参考文献", `\n${write} <!-- claim:CLM-001 --> [1]\n\n## 参考文献`)
      : input.reportText
        .replace("## 检索与方法\n", "## 检索与方法\n证据体确定性以 GRADE 表述。\n")
        .replace("## 结果\n", `## 结果\n${write}\n`);
    const { gate, preflight } = await verdicts(input, write);
    // Scoped to the three families, because these fixture lines carry figures
    // and citations that the unrelated numeric-provenance checks read.
    const families = [/^临床实践要点第 \d+ 行把/, /^GRADE 等级与降级理由不自洽/, /^资料与方法声明了 /];
    const preflightFamilies = [/^practical line \d+: 「/, /GRADE 等级与降级理由不自洽/, /资料与方法声明了 /];
    assert.deepEqual(
      gate.issues.filter((issue) => families.some((pattern) => pattern.test(issue))),
      [],
      `${write}: the gate flags a line the adversarial pass proved compliant`,
    );
    assert.deepEqual(
      preflight.issues.filter((issue) => preflightFamilies.some((pattern) => pattern.test(issue))),
      [],
      `${write}: the preflight fails a run over a line the gate delivers`,
    );
  }
});

test("appraisal asymmetry is advice the run can act on, and never withholds a package", async () => {
  // Two arms of one comparison appraised with two instruments is the defect the
  // returned report was sent back for: the familiar arm was vouched for by
  // 长期临床使用与指南推荐 while the other was graded 按 GRADE 为低至极低, when
  // both stood in the same position — neither had in-indication randomised
  // evidence for out-of-hospital self-rescue. (The second arm is unnamed here:
  // naming a medicine the question never raised is its own violation.)
  //
  // Which nouns in a sentence are the compared arms is not decidable from the
  // text: the same two vocabularies can belong to one arm across two
  // indications, which is correct writing. So this is reported and never blocks,
  // and it has no server counterpart — a rule that cannot be decided must not be
  // able to withhold a finished package.
  const asymmetric = deepResearchPackage();
  asymmetric.reportText = asymmetric.reportText
    .replace("## 摘要", "## 摘要\n本文比较两种院外自救用药在同一场景中的证据位置。")
    .replace(
      "## 结论\n",
      "## 结论\n舌下含服硝酸甘油缓解心绞痛发作的疗效有长期临床使用与指南推荐支持。"
        + "该中成药制剂的随机对照证据确定性按 GRADE 为低至极低。\n",
    );
  const asymmetricRun = await verdicts(asymmetric, "asymmetric appraisal");
  assert.equal(
    asymmetricRun.preflight.ok,
    true,
    `advice must not fail the preflight: ${JSON.stringify(asymmetricRun.preflight.issues)}`,
  );
  assert.equal(asymmetricRun.gate.valid, true, asymmetricRun.gate.issues.join("\n"));
  assert.match(asymmetricRun.preflight.notes.join("\n"), /one arm is vouched for by clinical tradition/);
  assert.match(asymmetricRun.preflight.notes.join("\n"), /same instrument, for the same indication/);

  // One ruler for both arms, with the gap they share stated for both: the
  // repair the note asks for must not draw the note again.
  const symmetric = deepResearchPackage();
  symmetric.reportText = symmetric.reportText
    .replace("## 摘要", "## 摘要\n本文比较两种院外自救用药在同一场景中的证据位置。")
    .replace(
      "## 结论\n",
      "## 结论\n在未分化急性胸痛的院外自救场景中，两者均未检索到适应症内随机对照证据，同一外推按 GRADE 均为极低确定性。\n",
    );
  const symmetricRun = await verdicts(symmetric, "one ruler for both arms");
  assert.equal(symmetricRun.preflight.ok, true, JSON.stringify(symmetricRun.preflight.issues));
  assert.deepEqual(symmetricRun.preflight.notes, []);

  // A report that compares nothing is not asked about symmetry, however both
  // vocabularies are used across its sections.
  const { preflight: clean } = await verdicts(deepResearchPackage(), "clean");
  assert.deepEqual(clean.notes, []);
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

test("the coverage ledger is checked field for field on the run's side, not only at delivery", async () => {
  // The agreement above proves the preflight rejects these packages. It does
  // not prove it rejects them *for the coverage defect* — and an issue that
  // names something else leaves the run to guess. Each case names its own.
  const cases = [
    [(ledger) => { ledger.entries[0].reportLines = [9999]; }, /question-coverage\.json: 1\.1 points at report line 9999/],
    [(ledger) => { ledger.entries[0].status = "partial"; }, /question-coverage\.json: 1\.1\.status must be/],
    [(ledger) => { ledger.entries[1].id = "1.1"; }, /entry id 1\.1 appears twice/],
    [(ledger) => { ledger.entries[2].searches[0].query = "never ran"; }, /1「never ran」|declares the search 「never ran」/],
    [(ledger) => { ledger.entries[2].searches[0].database = "Embase"; }, /under database 「Embase」/],
    [(ledger) => { ledger.entries[2].searches = []; }, /2\.1 is a gap, so searches must give/],
  ];
  for (const [breakLedger, expected] of cases) {
    const input = deepResearchPackage();
    input.questionCoverageText = questionCoverageLedger(input.reportText, input.searchLogText);
    const ledger = JSON.parse(input.questionCoverageText);
    breakLedger(ledger);
    input.keepCoverage = true;
    input.questionCoverageText = JSON.stringify(ledger);
    const { gate, preflight } = await verdicts(input, String(expected));
    assert.equal(gate.valid, false, `${expected}: the gate accepted it`);
    assert.match(preflight.issues.join("\n"), expected);
  }

  // And the deliverable's absence, which is the state every already-delivered
  // package is in: the preflight has to say which file and what goes in it.
  const missing = deepResearchPackage();
  missing.keepCoverage = true;
  missing.questionCoverageText = "";
  const workspace = await writeWorkspace(missing);
  try {
    await rm(path.join(workspace, "question-coverage.json"));
    const preflight = await runPreflight(workspace);
    assert.equal(preflight.ok, false);
    assert.match(preflight.issues.join("\n"), /question-coverage\.json: missing\./);
    assert.match(preflight.issues.join("\n"), /one entry per atomic sub-question/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
