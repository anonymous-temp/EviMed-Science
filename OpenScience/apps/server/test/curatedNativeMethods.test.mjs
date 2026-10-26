import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../runtime/skills/curated-scientific");
const hypothesis = path.join(root, "hypothesis-development");
const python = process.env.SKILL_TEST_PYTHON || "python3";
const run = (script, args) => spawnSync(python, [path.join(hypothesis, "scripts", script), ...args], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });

test("native hypothesis CLI validates the real template, rejects malformed records and broken references", async () => {
  const template = path.join(hypothesis, "assets/hypothesis_record_template.json");
  const valid = run("validate_hypothesis_schema.py", [template]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).valid, true);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hypothesis-native-"));
  try {
    const record = JSON.parse(await fs.readFile(template, "utf8"));
    const malformed = path.join(temporary, "malformed.json");
    await fs.writeFile(malformed, JSON.stringify({ schema_version: record.schema_version }));
    assert.notEqual(run("validate_hypothesis_schema.py", [malformed]).status, 0);
    record.predictions[0].hypothesis_id = "H-MISSING";
    const broken = path.join(temporary, "broken.json");
    await fs.writeFile(broken, JSON.stringify(record));
    const result = run("validate_hypothesis_schema.py", [broken]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).valid, false);
    assert.match(result.stdout, /H-MISSING/);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test("the hypothesis record and the prediction matrix name their passing status alike", () => {
  const record = run("validate_hypothesis_schema.py", [path.join(hypothesis, "assets/hypothesis_record_template.json")]);
  const matrix = run("validate_prediction_matrix.py", [path.join(hypothesis, "assets/prediction_rival_matrix_template.csv")]);
  assert.equal(matrix.status, 0, matrix.stderr);
  assert.equal(JSON.parse(matrix.stdout).status, "VALID_FOR_REVIEW");
  assert.match(JSON.parse(record.stdout).status, /^VALID_(FOR_REVIEW|WITH_REVIEW_NOTES)$/);
});

test("native preregistration scaffold resolves bundled assets deterministically", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "preregistration-native-"));
  try {
    const outputs = [path.join(temporary, "first.md"), path.join(temporary, "second.md")];
    for (const output of outputs) {
      const result = run("generate_preregistration_scaffold.py", [path.join(hypothesis, "assets/hypothesis_record_template.json"), "--output", output]);
      assert.equal(result.status, 0, result.stderr);
    }
    const [first, second] = await Promise.all(outputs.map((output) => fs.readFile(output, "utf8")));
    assert.equal(first, second);
    assert.match(first, /HG-SYN-001/);
    assert.doesNotMatch(first, /\{\{[A-Z0-9_]+\}\}/);
    const pending = JSON.parse(await fs.readFile(path.join(hypothesis, "assets/hypothesis_record_template.json"), "utf8"));
    pending.ethics_and_feasibility.human_subjects_gate = "requires_review";
    pending.ethics_and_feasibility.required_reviews = ["Institutional review before conducting research"];
    pending.ethics_and_feasibility.unresolved_blocks = ["Oversight determination pending"];
    const pendingPath = path.join(temporary, "pending.json");
    await fs.writeFile(pendingPath, JSON.stringify(pending));
    const output = path.join(temporary, "pending.md");
    const draft = run("generate_preregistration_scaffold.py", [pendingPath, "--output", output]);
    assert.equal(draft.status, 0, "unresolved research oversight is recorded in a draft, not a delivery approval gate");
    assert.match(await fs.readFile(output, "utf8"), /Oversight determination pending/);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test("grant method ships every local reference and template and keeps its bounded baseline", async () => {
  const dir = path.join(root, "research-grant-development");
  const skill = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
  for (const entry of ["references/nsf_guidelines.md", "references/nih_guidelines.md", "references/doe_guidelines.md", "references/darpa_guidelines.md", "references/nstc_guidelines.md", "references/core_components.md", "references/review_criteria.md", "references/writing_principles.md", "references/proposal_types_and_resubmission.md", "references/broader_impacts.md", "references/specific_aims_guide.md", "references/README.md", "assets/nsf_project_summary_template.md", "assets/nih_specific_aims_template.md", "assets/budget_justification_template.md"]) {
    assert.ok((await fs.stat(path.join(dir, entry))).size > 0, entry);
  }
  assert.match(skill, /Deterministic baseline/);
  assert.match(skill, /execute_skill\.py/);
  assert.doesNotMatch(skill, /OPENROUTER_API_KEY|scientific-schematics/);
  for (const match of skill.matchAll(/(?:references|assets)\/[A-Za-z0-9_.-]+\.(?:md|json|csv)/g)) assert.ok((await fs.stat(path.join(dir, match[0]))).isFile(), match[0]);
});

test("biosequence method retains full references and actual Biopython transforms, alignment and file round trips work", async (t) => {
  const dir = path.join(root, "biosequence-analysis");
  for (const file of ["advanced", "alignment", "blast", "databases", "phylogenetics", "review", "sequence_io", "structure"]) assert.ok((await fs.stat(path.join(dir, "references", `${file}.md`))).size > 0);
  const interpreter = process.env.BIOPYTHON_TEST_PYTHON || python;
  const probe = spawnSync(interpreter, ["-c", "import Bio; print(Bio.__version__)"], { encoding: "utf8" });
  if (probe.status !== 0) { t.skip(`Biopython unavailable in ${interpreter}; image smoke requires it`); return; }
  t.diagnostic(`Biopython ${probe.stdout.trim()} in ${interpreter}; this is local API evidence, not the image's 1.88 certification`);
  const result = spawnSync(interpreter, ["-c", `from io import StringIO
from Bio import SeqIO, Align
from Bio.Seq import Seq
from Bio.SeqRecord import SeqRecord
sequence = Seq("ATGGCCATTGTAATGGGCCGCTGAAAGGGTGCCCGATAG")
assert str(sequence.translate()) == "MAIVMGR*KGAR*"
assert sequence.reverse_complement().reverse_complement() == sequence
assert str(sequence.transcribe()) == str(sequence).replace("T", "U")
record = SeqRecord(sequence, id="synthetic", description="local offline fixture", annotations={"molecule_type": "DNA"})
for format in ("fasta", "genbank"):
    target = StringIO()
    assert SeqIO.write(record, target, format) == 1
    target.seek(0)
    restored = SeqIO.read(target, format)
    assert restored.seq == sequence and restored.id == record.id
aligner = Align.PairwiseAligner()
aligner.mode = "global"
aligner.match_score = 2
aligner.mismatch_score = -1
aligner.open_gap_score = -2
aligner.extend_gap_score = -0.5
assert aligner.score("ACCGGT", "ACGGT") == 8
assert len(aligner.align("ACCGGT", "ACGGT")) > 0
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("image native smoke runs the bundled hypothesis assets and Biopython API without a model", async (t) => {
  const interpreter = process.env.BIOPYTHON_TEST_PYTHON || python;
  const probe = spawnSync(interpreter, ["-c", "import Bio"], { encoding: "utf8" });
  if (probe.status !== 0) { t.skip(`Biopython unavailable in ${interpreter}; image smoke requires it`); return; }
  const result = spawnSync(interpreter, [path.join(root, "_runtime/smoke_native_methods.py"), "--root", root], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.hypothesis_native_operations, 7);
  assert.equal(receipt.grant_reference_and_asset_files, 15);
  assert.equal(receipt.biopython_round_trips, 2);
  assert.match(receipt.biopython_version, /^\d+\.\d+/);
  const installer = await fs.readFile(path.resolve(root, "../../../deploy/runtime-dsh/install-runtime.sh"), "utf8");
  assert.match(installer, /subprocess\.run\(\[sys\.executable, str\(root \/ "_runtime\/smoke_native_methods\.py"\)/);
});

test("native expectation checks distinguish Chinese hypotheses and still reject identical expectations", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hypothesis-unicode-"));
  try {
    const prepared = spawnSync(python, ["-c", `import copy,csv,json,pathlib,sys
root,out=map(pathlib.Path,sys.argv[1:])
rows=list(csv.DictReader((root/'assets/prediction_rival_matrix_template.csv').open()))
source=json.loads((root/'assets/falsification_controls_template.json').read_text())
for suffix,rival in [('distinct','干预组主要指标持续明显降低'),('same','干预组主要指标持续明显升高')]:
    matrix=copy.deepcopy(rows)
    matrix[0]['expected_if_focal']='干预组主要指标持续明显升高'
    matrix[0]['expected_if_rivals']=rival
    with (out/(suffix+'.csv')).open('w',newline='') as target:
        writer=csv.DictWriter(target,fieldnames=list(matrix[0]));writer.writeheader();writer.writerows(matrix)
    controls=copy.deepcopy(source)
    target=controls['hypotheses'][0]['discriminating_tests'][0]
    target['focal_expected']='干预组主要指标持续明显升高';target['rival_expected']=rival
    (out/(suffix+'.json')).write_text(json.dumps(controls,ensure_ascii=False))
`, hypothesis, temporary], { encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    for (const [script, extension] of [["validate_prediction_matrix.py", "csv"], ["check_falsification_controls.py", "json"]]) {
      const different = run(script, [path.join(temporary, `distinct.${extension}`)]);
      assert.equal(different.status, 0, different.stdout + different.stderr);
      const same = run(script, [path.join(temporary, `same.${extension}`)]);
      assert.equal(same.status, 1, same.stdout + same.stderr);
      assert.match(same.stdout, /IDENTICAL/);
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test("native schema warning order does not depend on Python's hash seed", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hypothesis-order-"));
  try {
    const record = JSON.parse(await fs.readFile(path.join(hypothesis, "assets/hypothesis_record_template.json"), "utf8"));
    for (const key of Object.keys(record.risk_register)) record.risk_register[key] = [];
    const input = path.join(temporary, "empty-risks.json");
    await fs.writeFile(input, JSON.stringify(record));
    const outputs = ["1", "2"].map(seed => spawnSync(python, [path.join(hypothesis, "scripts/validate_hypothesis_schema.py"), input], {
      encoding: "utf8", env: { ...process.env, PYTHONHASHSEED: seed, PYTHONDONTWRITEBYTECODE: "1" },
    }));
    outputs.forEach(result => assert.equal(result.status, 0, result.stderr));
    assert.equal(outputs[0].stdout, outputs[1].stdout);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
