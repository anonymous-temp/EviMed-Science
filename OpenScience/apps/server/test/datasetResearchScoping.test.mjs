// The scoping skill ships two scripts and the run is told to iterate against
// the preflight until it returns ok. That instruction is only honest if the
// gates actually fire, and if the profiler the run is told to use does not
// itself produce something a gate rejects — which it did: printing the value
// vocabulary of a five-patient PATIENT_ID column wrote five real hospital
// numbers into data-profile.md, and the identifier gate caught its own toolchain.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

// START_DATETIME is day-first, as the real extract exported it; RECORD_CONTENT
// is the vital-signs column whose name contains "record" without being one.
const ORDERS = [
  "PATIENT_ID,DRUG,FREQUENCY,START_DATETIME,END_DATETIME,BP,RECORD_CONTENT",
  "P11322133,olanzapine,BID4,2/1/2026 08:00,0/0/0 00:00:00,129/74,101/62",
  "P11322134,quetiapine,QD11,3/1/2026 08:00,9/1/2026 08:00,131/80,110/70",
  "P11322135,olanzapine,ONCE,4/1/2026 08:00,0/0/0 00:00:00,140/90,120/80",
].join("\n");
// The join key is declared and entirely empty, which no schema diagram shows.
const DIAGNOSIS = ["PATIENT_ID,MAIN_DIAGNOSIS_CODE,AGE", ",F20.0,56岁", ",F31.1,44岁"].join("\n");
// AGE is text here and an integer above.
const LABS = ["PATIENT_ID,LOINC_CODE,VALUE,AGE", "P11322133,3016-3,12.4,56", "P11322134,3016-3,8.1,44"].join("\n");

const FEASIBILITY = [
  "# 可行性矩阵",
  "## 课题 A",
  "- 入组标准 → ✅ MAIN_DIAGNOSIS_CODE",
  "判定：可行。",
  "## 课题 B",
  "判定：不可行。缺失字段：diagnosis 表 PATIENT_ID 全空。",
].join("\n");
const QUALITY = [
  "# 数据质量",
  "填充率为 density completeness（Weiskopf 四义之一）。",
  "## 预处理必做清单",
  "- 拆分 BP 复合值：否则无法计算收缩压",
].join("\n");
const PORTFOLIO = "# 课题组合\n课题 A 的最小可检出效应 MDE=0.6 SD，预期 CI 宽度 0.8。\n";
const LINKAGE = "# 外部资源接驳\n- LOINC：通过 `LOINC_CODE` 连接，检验项粒度，单位需配 UCUM\n";

async function buildWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "dataset-scoping-"));
  await writeFile(path.join(root, "orders.csv"), ORDERS, "utf8");
  await writeFile(path.join(root, "diagnosis.csv"), DIAGNOSIS, "utf8");
  await writeFile(path.join(root, "labs.csv"), LABS, "utf8");
  await writeFile(path.join(root, "feasibility-matrix.md"), FEASIBILITY, "utf8");
  await writeFile(path.join(root, "data-quality.md"), QUALITY, "utf8");
  await writeFile(path.join(root, "research-portfolio.md"), PORTFOLIO, "utf8");
  await writeFile(path.join(root, "external-linkage.md"), LINKAGE, "utf8");
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

    // No identifier reaches either deliverable, while its cardinality still does.
    assert.equal(column("orders.csv", "PATIENT_ID").distinct, 3);
    assert.equal(column("orders.csv", "PATIENT_ID").vocabulary.identifying, true);
    for (const identifier of ["P11322133", "P11322134", "P11322135"]) {
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
        await writeFile(file, `${await readFile(file, "utf8")}\n患者 P11322133 的浓度最高。\n`, "utf8");
      },
      expect: /carries the source identifier/,
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
      name: "a post-hoc power calculation",
      apply: async (root) => {
        const file = path.join(root, "research-portfolio.md");
        await writeFile(file, `${await readFile(file, "utf8")}\n事后功效为 0.42。\n`, "utf8");
      },
      expect: /post-hoc power is uninformative/,
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
    await writeFile(path.join(root, "data-quality.md"), "# 数据质量\n本表填充率见上。\n", "utf8");
    await writeFile(path.join(root, "external-linkage.md"), "# 外部资源\n- LOINC：可用于标准化\n", "utf8");
    const result = await preflight(root);
    assert.equal(result.ok, true, "a visible defect must not withhold the package");
    assert.ok(result.warnings.some((w) => /completeness definitions/.test(w)));
    assert.ok(result.warnings.some((w) => /naming the field that joins them/.test(w)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
