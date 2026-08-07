// The scoping skill ships two scripts and the run is told to iterate against
// the preflight until it returns ok. That instruction is only honest if the
// gates actually fire, and if the profiler the run is told to use does not
// itself produce something a gate rejects — which it did: printing the value
// vocabulary of a five-patient PATIENT_ID column wrote five real hospital
// numbers into data-profile.md, and the identifier gate caught its own toolchain.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const skillRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../runtime/skills/evimed/dataset-research-scoping",
);
const profileScript = path.join(skillRoot, "scripts/profile_dataset.py");
const preflightScript = path.join(skillRoot, "scripts/preflight.py");
const topicSkillRoot = path.resolve(skillRoot, "../research-topic-selection");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

// START_DATETIME is day-first, as the real extract exported it; RECORD_CONTENT
// is the vital-signs column whose name contains "record" without being one.
// MED_REC_NO is the medical record number as a real front page abbreviates it;
// ADM_DEPT_CODE is the admitting department, a covariate; the last column has
// no name at all and carries the patient id, as one real sheet does.
const ORDERS = [
  "PATIENT_ID,DRUG,FREQUENCY,START_DATETIME,END_DATETIME,BP,RECORD_CONTENT,MED_REC_NO,ADM_DEPT_CODE,",
  "P90000001,olanzapine,BID4,2/1/2026 08:00,0/0/0 00:00:00,129/74,101/62,M90000001,DEPT07,P90000001",
  "P90000002,quetiapine,QD11,3/1/2026 08:00,9/1/2026 08:00,131/80,110/70,M90000002,DEPT07,P90000002",
  "P90000003,olanzapine,ONCE,4/1/2026 08:00,0/0/0 00:00:00,140/90,120/80,M90000003,DEPT09,P90000003",
].join("\n");
// The join key is declared and entirely empty, which no schema diagram shows.
const DIAGNOSIS = ["PATIENT_ID,MAIN_DIAGNOSIS_CODE,AGE", ",F20.0,56岁", ",F31.1,44岁"].join("\n");
// AGE is text here and an integer above.
const LABS = ["PATIENT_ID,LOINC_CODE,VALUE,AGE", "P90000001,3016-3,12.4,56", "P90000002,3016-3,8.1,44"].join("\n");

const FEASIBILITY = [
  "# 可行性矩阵",
  "## 课题 A",
  "- 入组标准 → ✅ MAIN_DIAGNOSIS_CODE",
  "判定：可行。",
  "## 课题 B",
  // The gap is shown to bind (compared in the same units) and the degraded
  // question is stated, which is what the gate now requires of a refusal.
  "该表连接键全空，跨住院次链接率 0%，与所需 100% 相差一个数量级，敏感性分析无法弥补。",
  "判定：不可行。缺失字段：diagnosis 表 PATIENT_ID 全空。仍可退而求其次做单次住院内的横断面描述。",
].join("\n");
const QUALITY = [
  "# 数据质量",
  "填充率为 density completeness（Weiskopf 四义之一）。",
  // An identity the schema implies, run, with a count — what licenses the numbers.
  "一致性校验：总值 = 分项之和，3 组中 3 组通过；参考范围内外判定 2 内 / 1 外。",
  "## 预处理必做清单",
  "- 拆分 BP 复合值：否则无法计算收缩压",
].join("\n");
const PORTFOLIO = [
  "# 课题组合",
  "课题 A 的最小可检出效应 MDE=0.6 SD，预期 CI 宽度 0.8。",
  "新颖性：最接近的已发表工作是 PMID 30000001，差异轴为人群（该文为门诊，本数据为住院）。",
  // Phase 4b: the eight families walked, and an estimator named for what survives.
  "## 分析族逐条记录",
  "- 预测：以实测值为特征预测目标剂量；消耗 labs.VALUE + 体重 + 年龄；估计量为 LASSO 回归，LOOCV。",
  "- 同类药 class-level：各药按自身参考范围归一后比较。",
  "- 关联挖掘：以 LONG_D_NO 为篮，apriori 计 support/confidence/lift。",
  "- 因果：目标试验模拟，估计量 IPTW，时间零点取 START_DATETIME。",
  "- 不良反应 ADR：体征轨迹对暴露，外接 FAERS 计 ROR。",
  "- 外部资源接驳：LOINC/RxNorm/ATC 见 external-linkage.md。",
  "- 多库证据合成：pooled 参考分布，见 evidence-map.md。",
  "- 描述性：仅在上述均被排除时作为兜底，本次未采用为默认。",
].join("\n");
const LINKAGE = "# 外部资源接驳\n- LOINC：通过 `LOINC_CODE` 连接，检验项粒度，单位需配 UCUM\n";
const PROTOCOL = "# 研究方案\n## 课题 A\n变量构造：VALUE 取自 labs.VALUE。分析计划：描述统计 + Bootstrap 区间。\n";

// One row per work, across the channels Phase 3 names. A run that searched a
// single index produced twelve unmapped, unlinkable citations and a portfolio
// nobody could tell was new; these are the floors that answer for that.
const EVIDENCE_CHANNEL_ROWS = [
  (n) => [`PMID ${30000000 + n}`, `https://pubmed.ncbi.nlm.nih.gov/${30000000 + n}/`, "pubmed"],
  (n) => [`PMC${7000000 + n}`, `https://europepmc.org/article/PMC/PMC${7000000 + n}`, "europe-pmc"],
  (n) => [`W${2000000000 + n}`, `https://openalex.org/W${2000000000 + n}`, "openalex"],
  (n) => [`10.1234/s2.${n}`, `https://www.semanticscholar.org/paper/${n}`, "semantic-scholar"],
  (n) => [`10.5555/cr.${n}`, `https://doi.org/10.5555/cr.${n}`, "crossref"],
  (n) => [`10.1101/2026.01.${n}`, `https://www.biorxiv.org/content/10.1101/2026.01.${n}`, "biorxiv"],
];

function evidenceMap(works = 32) {
  const rows = ["| 文献 | 标识符 | URL | 渠道 | 检索轴 | 用于 | 全文 |", "|---|---|---|---|---|---|---|"];
  for (let index = 0; index < works; index += 1) {
    const [id, url, channel] = EVIDENCE_CHANNEL_ROWS[index % EVIDENCE_CHANNEL_ROWS.length](index + 1);
    rows.push(`| 文献 ${index + 1} | ${id} | ${url} | ${channel} | 方法学 | 课题 A 的比较基准 | 是 |`);
  }
  return `# 证据地图\n\n${rows.join("\n")}\n`;
}

async function buildWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "dataset-scoping-"));
  await writeFile(path.join(root, "evidence-map.md"), evidenceMap(), "utf8");
  // Full texts are counted from disk, not from the "全文" column: the tool
  // writes each retrieved article into .evimed-sources/<slug>/.
  for (let index = 0; index < 5; index += 1) {
    const slug = path.join(root, ".evimed-sources", `article-${index + 1}`);
    await mkdir(slug, { recursive: true });
    await writeFile(path.join(slug, "fulltext.md"), "# Methods\n", "utf8");
  }
  await writeFile(path.join(root, "orders.csv"), ORDERS, "utf8");
  await writeFile(path.join(root, "diagnosis.csv"), DIAGNOSIS, "utf8");
  await writeFile(path.join(root, "labs.csv"), LABS, "utf8");
  await writeFile(path.join(root, "feasibility-matrix.md"), FEASIBILITY, "utf8");
  await writeFile(path.join(root, "data-quality.md"), QUALITY, "utf8");
  await writeFile(path.join(root, "research-portfolio.md"), PORTFOLIO, "utf8");
  await writeFile(path.join(root, "external-linkage.md"), LINKAGE, "utf8");
  await writeFile(path.join(root, "study-protocol.md"), PROTOCOL, "utf8");
  await writeFile(
    path.join(root, "scoping-run.json"),
    JSON.stringify({
      priorDataContact: {
        filesReceived: ["orders.csv", "diagnosis.csv", "labs.csv"],
        partsInspected: "headers and value vocabularies",
        outcomeDistributionSeen: false,
      },
      searches: [],
    }),
    "utf8",
  );
  // The skill tells the run to copy the profiler in as data-profile.py so the
  // deliverable regenerates from a deliverable; do exactly that.
  await writeFile(path.join(root, "data-profile.py"), await readFile(profileScript, "utf8"), "utf8");
  await execFileAsync("python3", [
    path.join(root, "data-profile.py"),
    path.join(root, "orders.csv"),
    path.join(root, "diagnosis.csv"),
    path.join(root, "labs.csv"),
    "--json", path.join(root, "data-profile.json"),
    "--markdown", path.join(root, "data-profile.md"),
  ], { cwd: root });
  return root;
}

async function preflight(root) {
  try {
    const { stdout } = await execFileAsync("python3", [preflightScript, "--workspace", root], { cwd: root });
    return JSON.parse(stdout);
  } catch (error) {
    return JSON.parse(error.stdout);
  }
}

test("the profiler reports the traps and never emits an identifier", { skip: !hasPython3 }, async () => {
  const root = await buildWorkspace();
  try {
    const profile = JSON.parse(await readFile(path.join(root, "data-profile.json"), "utf8"));
    const markdown = await readFile(path.join(root, "data-profile.md"), "utf8");
    const table = (name) => profile.tables.find((t) => t.name === name);
    const column = (name, field) => table(name).columns.find((c) => c.name === field);

    // A declared join key that is entirely empty.
    assert.equal(column("diagnosis.csv", "PATIENT_ID").filled, 0);
    const emptyJoin = profile.joins.find((j) => j.left.startsWith("diagnosis.csv"));
    assert.equal(emptyJoin.reachable, false);
    // The populated pair still resolves, computed from values that are not emitted.
    const liveJoin = profile.joins.find((j) => j.left === "labs.csv.PATIENT_ID");
    assert.equal(liveJoin.reachable, true);

    // A local coding vocabulary is the finding, so it is reported in full.
    const frequency = column("orders.csv", "FREQUENCY");
    assert.equal(frequency.vocabulary.complete, true);
    assert.ok(frequency.vocabulary.values.some(([value]) => value === "BID4"));

    assert.deepEqual(column("orders.csv", "END_DATETIME").sentinelSuspects, ["0/0/0 00:00:00"]);
    // Neither a sentinel date nor a day-first timestamp is a cell carrying two
    // values. Matching only year-first dates made 915 timestamps of one real
    // column read as composite and buried the comorbidity strings that were.
    assert.equal(column("orders.csv", "END_DATETIME").compositeSuspects.count, 0);
    assert.equal(column("orders.csv", "START_DATETIME").compositeSuspects.count, 0);
    assert.equal(column("orders.csv", "START_DATETIME").inferredType, "date");
    assert.equal(column("orders.csv", "BP").compositeSuspects.count, 3);
    // "record" alone must not mask a column: RECORD_CONTENT carries the vital
    // signs, and masking it hid that blood pressure is stored as a composite.
    const recordContent = column("orders.csv", "RECORD_CONTENT");
    assert.equal(recordContent.vocabulary.identifying, false);
    assert.equal(recordContent.compositeSuspects.count, 3);
    assert.deepEqual(profile.typeConflicts.map((c) => c.column), ["AGE"]);

    // Abbreviated identifier, false-positive covariate, and a column with no
    // name whose values give it away — each cost a real leak or a masked finding.
    assert.equal(column("orders.csv", "MED_REC_NO").vocabulary.identifying, true);
    assert.equal(column("orders.csv", "ADM_DEPT_CODE").vocabulary.identifying, false);
    const unnamed = table("orders.csv").columns.find((c) => c.name === "");
    assert.ok(unnamed, "the unnamed column should be profiled");
    assert.equal(unnamed.vocabulary.identifying, true, "an unnamed column carrying ids must be masked by value");

    // No identifier reaches either deliverable, while its cardinality still does.
    assert.equal(column("orders.csv", "PATIENT_ID").distinct, 3);
    assert.equal(column("orders.csv", "PATIENT_ID").vocabulary.identifying, true);
    for (const identifier of ["P90000001", "P90000002", "P90000003"]) {
      assert.equal(markdown.includes(identifier), false, `data-profile.md leaked ${identifier}`);
      assert.equal(
        JSON.stringify(profile).includes(identifier),
        false,
        `data-profile.json leaked ${identifier}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a complete scoping package passes preflight", { skip: !hasPython3 }, async () => {
  const root = await buildWorkspace();
  try {
    const result = await preflight(root);
    assert.deepEqual(result.issues, []);
    assert.equal(result.ok, true);
    assert.equal(result.metrics.profileRecomputable, true);
    assert.equal(result.metrics.identifierLeaks, 0);
    assert.equal(result.metrics.infeasibleVerdicts, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("each blocking gate rejects what it exists to catch", { skip: !hasPython3 }, async () => {
  const cases = [
    {
      name: "an identifier copied out of the source data",
      apply: async (root) => {
        const file = path.join(root, "research-portfolio.md");
        await writeFile(file, `${await readFile(file, "utf8")}\n患者 P90000001 的浓度最高。\n`, "utf8");
      },
      expect: /carries the source identifier/,
    },
    {
      name: "a pseudonym mapping written into a working file",
      apply: async (root) => {
        // Not a declared deliverable — exactly how the real leak escaped.
        await writeFile(
          path.join(root, "tdm-derived.json"),
          JSON.stringify({ pseudonyms: { P90000001: "P1" } }),
          "utf8",
        );
      },
      expect: /tdm-derived\.json: carries the source identifier/,
    },
    {
      name: "profile numbers that are not the script's",
      apply: async (root) => {
        const file = path.join(root, "data-profile.json");
        const profile = JSON.parse(await readFile(file, "utf8"));
        profile.tables[0].rows = 999;
        await writeFile(file, JSON.stringify(profile), "utf8");
      },
      expect: /does not match what data-profile\.py produces/,
    },
    {
      name: "an infeasible verdict that names no missing field",
      apply: async (root) => {
        const file = path.join(root, "feasibility-matrix.md");
        await writeFile(file, `${await readFile(file, "utf8")}\n## 课题 C\n判定：不可行。\n`, "utf8");
      },
      expect: /must name the missing field/,
    },
    {
      name: "an infeasible verdict that never shows the gap binds",
      apply: async (root) => {
        const file = path.join(root, "feasibility-matrix.md");
        const text = (await readFile(file, "utf8"))
          .replace("该表连接键全空，跨住院次链接率 0%，与所需 100% 相差一个数量级，敏感性分析无法弥补。", "该表连接键全空。");
        await writeFile(file, text, "utf8");
      },
      expect: /without showing anywhere that the gap/,
    },
    {
      name: "an infeasible verdict with no remaining question",
      apply: async (root) => {
        const file = path.join(root, "feasibility-matrix.md");
        const text = (await readFile(file, "utf8"))
          .replace("仍可退而求其次做单次住院内的横断面描述。", "");
        await writeFile(file, text, "utf8");
      },
      expect: /naming the strongest question/,
    },
    {
      name: "a post-hoc power calculation",
      apply: async (root) => {
        const file = path.join(root, "research-portfolio.md");
        await writeFile(file, `${await readFile(file, "utf8")}\n事后功效为 0.42。\n`, "utf8");
      },
      expect: /post-hoc power is uninformative/,
    },
    {
      name: "a landscape assembled from too little of the field",
      apply: async (root) => {
        await writeFile(path.join(root, "evidence-map.md"), evidenceMap(12), "utf8");
      },
      expect: /cite 12 distinct works; the floor is 30/,
    },
    {
      name: "a landscape assembled from one index",
      apply: async (root) => {
        const rows = ["| 文献 | 标识符 | URL | 渠道 |", "|---|---|---|---|"];
        for (let index = 1; index <= 32; index += 1) {
          rows.push(
            `| 文献 ${index} | PMID ${30000000 + index} | https://pubmed.ncbi.nlm.nih.gov/${30000000 + index}/ | pubmed |`,
          );
        }
        await writeFile(path.join(root, "evidence-map.md"), `# 证据地图\n${rows.join("\n")}\n`, "utf8");
      },
      expect: /draws on 1 channels/,
    },
    {
      name: "a design transferred from abstracts alone",
      apply: async (root) => {
        await rm(path.join(root, ".evimed-sources"), { recursive: true, force: true });
      },
      expect: /0 full texts were retrieved/,
    },
    {
      name: "a work cited in the report but absent from the map",
      apply: async (root) => {
        const file = path.join(root, "research-portfolio.md");
        await writeFile(file, `${await readFile(file, "utf8")}\n阈值取自 PMID 29999999。\n`, "utf8");
      },
      expect: /cited in the report but absent from evidence-map\.md/,
    },
    {
      name: "a citation a reader cannot open",
      apply: async (root) => {
        const file = path.join(root, "evidence-map.md");
        const text = (await readFile(file, "utf8"))
          .replace("https://pubmed.ncbi.nlm.nih.gov/30000001/", "见 PubMed");
        await writeFile(file, text, "utf8");
      },
      expect: /carry an identifier with no URL/,
    },
    {
      name: "a surviving question with no novelty statement",
      apply: async (root) => {
        await writeFile(path.join(root, "research-portfolio.md"), "# 课题组合\n课题 A 的 MDE=0.6 SD。\n", "utf8");
      },
      expect: /0 novelty statements for 1 surviving questions/,
    },
    {
      name: "an analysis that never considered most of the families",
      apply: async (root) => {
        await writeFile(
          path.join(root, "research-portfolio.md"),
          "# 课题组合\n新颖性：最接近 PMID 30000001，差异轴为人群。\n本次仅做描述性审计。估计量为 bootstrap 置信区间。\n",
          "utf8",
        );
      },
      expect: /analysis families appear anywhere/,
    },
    {
      name: "a surviving question with no named estimator",
      apply: async (root) => {
        const file = path.join(root, "research-portfolio.md");
        const text = (await readFile(file, "utf8"))
          .replaceAll(/估计量[^。]*。|LASSO 回归，LOOCV。|apriori 计 support\/confidence\/lift。|计 ROR。|pooled 参考分布，见 evidence-map.md。/g, "略。");
        await writeFile(file, text, "utf8");
        const protocolFile = path.join(root, "study-protocol.md");
        await writeFile(protocolFile, "# 研究方案\n## 课题 A\n变量构造：VALUE 取自 labs.VALUE。\n", "utf8");
      },
      expect: /estimator mentions across/,
    },
    {
      name: "a topic named after the activity instead of the question",
      apply: async (root) => {
        const file = path.join(root, "research-portfolio.md");
        const text = await readFile(file, "utf8");
        await writeFile(file, `${text}\n## TDM 采样实践审计\n判定：可行。\n`, "utf8");
      },
      expect: /named after the activity performed/,
    },
    {
      name: "a package that ran no consistency identity",
      apply: async (root) => {
        const file = path.join(root, "data-quality.md");
        const text = (await readFile(file, "utf8")).replace(/^一致性校验.*$/m, "");
        await writeFile(file, text, "utf8");
      },
      expect: /no internal-consistency identity is reported/,
    },
    {
      name: "a prior data contact declaration written after the fact",
      apply: async (root) => {
        await writeFile(path.join(root, "scoping-run.json"), JSON.stringify({ searches: [] }), "utf8");
      },
      expect: /priorDataContact is required/,
    },
  ];

  for (const { name, apply, expect } of cases) {
    const root = await buildWorkspace();
    try {
      await apply(root);
      const result = await preflight(root);
      assert.equal(result.ok, false, `preflight accepted ${name}`);
      assert.ok(
        result.issues.some((issue) => expect.test(issue)),
        `no issue matched ${expect} for ${name}: ${JSON.stringify(result.issues)}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("the reader-visible defects warn instead of blocking", { skip: !hasPython3 }, async () => {
  const root = await buildWorkspace();
  try {
    // Keeps the identity line: this test is about the fill-rate qualifier and the
    // join key, and dropping the identity would block on a different gate.
    await writeFile(
      path.join(root, "data-quality.md"),
      "# 数据质量\n本表填充率见上。\n一致性校验：总值 = 分项之和，3 组中 3 组通过。\n",
      "utf8",
    );
    await writeFile(path.join(root, "external-linkage.md"), "# 外部资源\n- LOINC：可用于标准化\n", "utf8");
    const result = await preflight(root);
    assert.equal(result.ok, true, "a visible defect must not withhold the package");
    assert.ok(result.warnings.some((w) => /completeness definitions/.test(w)));
    assert.ok(result.warnings.some((w) => /naming the field that joins them/.test(w)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Skill packages are copied into the runtime independently and cannot import
// from one another, so the floor logic exists twice. Drift between the server
// gate and the run-side preflight has cost three finished packages in
// production; this is the same failure mode one directory over.
test("both research-planning skills carry the same evidence floor", async () => {
  const [scoping, topic] = await Promise.all([
    readFile(path.join(skillRoot, "scripts/evidence_floor.py"), "utf8"),
    readFile(path.join(topicSkillRoot, "scripts/evidence_floor.py"), "utf8"),
  ]);
  assert.equal(topic, scoping, "evidence_floor.py has drifted between the two skill packages");
});

test("the topic preflight holds an agenda to the same floors", { skip: !hasPython3 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "topic-selection-"));
  const topicPreflight = path.join(topicSkillRoot, "scripts/preflight.py");
  const run = async () => {
    try {
      const { stdout } = await execFileAsync("python3", [topicPreflight, "--workspace", root], { cwd: root });
      return JSON.parse(stdout);
    } catch (error) {
      return JSON.parse(error.stdout);
    }
  };
  try {
    await writeFile(path.join(root, "research-topic-run.json"), JSON.stringify({ jobState: "succeeded" }), "utf8");
    await writeFile(
      path.join(root, "research-topic-report.md"),
      "# 选题报告\n检索范围：见证据地图。\n## Q1 住院 TDM 基准\n设计为横断面描述。\n",
      "utf8",
    );
    await writeFile(path.join(root, "evidence-map.md"), evidenceMap(12), "utf8");

    const thin = await run();
    assert.equal(thin.ok, false, "an agenda written off twelve works must not pass");
    assert.ok(thin.issues.some((issue) => /cite 12 distinct works; the floor is 30/.test(issue)));
    assert.ok(thin.issues.some((issue) => /0 full texts were retrieved/.test(issue)));
    assert.ok(thin.issues.some((issue) => /0 novelty statements for 1 surviving questions/.test(issue)));

    await writeFile(path.join(root, "evidence-map.md"), evidenceMap(), "utf8");
    for (let index = 0; index < 5; index += 1) {
      const slug = path.join(root, ".evimed-sources", `article-${index + 1}`);
      await mkdir(slug, { recursive: true });
      await writeFile(path.join(slug, "fulltext.md"), "# Methods\n", "utf8");
    }
    await writeFile(
      path.join(root, "research-topic-report.md"),
      [
        "# 选题报告",
        "检索范围：PubMed / Europe PMC / OpenAlex / Semantic Scholar / Crossref / bioRxiv。",
        "## Q1 住院 TDM 基准",
        "新颖性：最接近的是 PMID 30000001（门诊人群），本题为住院人群，差异轴为治疗场景。",
      ].join("\n"),
      "utf8",
    );
    const expanded = await run();
    assert.deepEqual(expanded.issues, []);
    assert.equal(expanded.metrics.channels.length >= 5, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
