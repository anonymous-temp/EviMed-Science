#!/usr/bin/env python3
"""Keep every `evals/*/briefs.json` well formed and runnable.

An eval brief is only worth writing if a run could actually be dispatched from
it. Two things make that false and neither is visible by reading the file: a
brief that omits an input its capability manifest declares **required** can
never run at all, and a brief that drifts from the shape the other packs use
cannot be read by whatever harness eventually drives them. Both were caught by
hand during the wave that wrote seven packs at once, by a validator that lived
in `/tmp` and is therefore gone. This is that validator, in the repository.

Two tiers, deliberately:

* **Blocking** — the deterministic half. The file is JSON, it carries briefs,
  ids are unique, a brief written in the complete schema carries every field
  that schema requires with the right type, and every input the manifest calls
  required is present and non-empty. A directory exists or it does not; a key
  is there or it is not.
* **Advisory** — an input key the manifest does not declare, and a pack that
  names no capability at all. Three packs written before the manifests carried
  an `inputs` block do this today (`sources`, `eligibility`, `replaySearches`,
  `unbrandedQuestionSet`, `injectedTemptation`), and they are legitimate fixture
  material rather than defects. A new check ships as a notice first.

The real-repository cases assert the scan actually read the tree — pack count,
brief count and the seven packs by name — so a walk that stopped reading cannot
agree with a tree that had also stopped carrying briefs. The last case takes a
real pack, removes one required input from it in a scratch checkout and asserts
the checker rejects it, so the passing verdict on the real tree is known not to
be vacuous.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]

# Walk floors. They are not targets: they are the assertion that the scan is
# reading the tree, because an empty walk agrees with every schema.
MINIMUM_PACKS = 14
MINIMUM_BRIEFS = 50

# The seven packs written on 2026-09-07, with the brief counts the acceptance
# ledger reads off disk. Changing a number here means changing it there too.
WAVE_PACK_BRIEF_COUNTS = {
    "adr-analysis": 4,
    "bibliometric-analysis": 4,
    "dataset-research-scoping": 4,
    "mendelian-randomization": 4,
    "meta-analysis": 4,
    "off-label-analysis": 4,
    "peer-review": 4,
}

# A brief carrying any of these is written in the complete schema and owes the
# rest of it. The three packs that predate the schema carry none of them.
COMPLETE_SCHEMA_MARKERS = ("title", "why", "gradedOn")
COMPLETE_SCHEMA_REQUIRED = ("id", "title", "why", "inputs", "mustDo", "mustNotDo")
COMPLETE_SCHEMA_STRINGS = ("title", "why")
COMPLETE_SCHEMA_STRING_LISTS = ("mustDo", "mustNotDo")
OPTIONAL_STRING_FIELDS = ("gradedOn",)


def _is_filled_string(value):
    return isinstance(value, str) and value.strip() != ""


def discover_brief_packs(evals_root):
    """Return every `evals/*/briefs.json` on disk, in a stable order."""
    root = Path(evals_root)
    if not root.is_dir():
        return []
    return sorted(
        directory / "briefs.json"
        for directory in root.iterdir()
        if directory.is_dir() and (directory / "briefs.json").is_file()
    )


def manifest_input_names(capabilities_root, capability_id):
    """Return (required, optional) input names a capability manifest declares.

    `None` means the capability has no manifest, which is itself an issue: a
    pack naming a capability that is not in the tree cannot be cross-checked
    and cannot be dispatched either.
    """
    manifest = Path(capabilities_root) / capability_id / "capability.yaml"
    if not manifest.is_file():
        return None
    document = yaml.safe_load(manifest.read_text(encoding="utf-8")) or {}
    declared = document.get("inputs") or {}
    return (
        tuple(declared.get("required") or ()),
        tuple(declared.get("optional") or ()),
    )


def _brief_shape_issues(label, index, brief, seen_ids):
    """Issues about one brief's own shape. Returns (issues, identifier)."""
    issues = []
    if not isinstance(brief, dict):
        return ["%s brief %d is not an object" % (label, index)], None
    identifier = brief.get("id")
    if not _is_filled_string(identifier):
        return ["%s brief %d has no id" % (label, index)], None
    if identifier in seen_ids:
        issues.append("%s repeats brief id %r" % (label, identifier))
    seen_ids.add(identifier)

    if not any(marker in brief for marker in COMPLETE_SCHEMA_MARKERS):
        return issues, identifier

    for field in COMPLETE_SCHEMA_REQUIRED:
        if field not in brief:
            issues.append(
                "%s brief %s is written in the complete schema but omits %s"
                % (label, identifier, field)
            )
    for field in COMPLETE_SCHEMA_STRINGS + OPTIONAL_STRING_FIELDS:
        if field in brief and not _is_filled_string(brief[field]):
            issues.append(
                "%s brief %s field %s is not a non-empty string" % (label, identifier, field)
            )
    for field in COMPLETE_SCHEMA_STRING_LISTS:
        value = brief.get(field)
        if field not in brief:
            continue
        if (
            not isinstance(value, list)
            or not value
            or not all(_is_filled_string(item) for item in value)
        ):
            issues.append(
                "%s brief %s field %s is not a non-empty list of non-empty strings"
                % (label, identifier, field)
            )
    if "inputs" in brief and not isinstance(brief["inputs"], dict):
        issues.append("%s brief %s has no inputs object" % (label, identifier))
    return issues, identifier


def _brief_input_report(label, identifier, brief, capability, declared):
    """Cross-check one brief's inputs against its capability manifest."""
    issues = []
    notices = []
    inputs = brief.get("inputs")
    if not isinstance(inputs, dict):
        return issues, notices
    required, optional = declared
    for name in required:
        if name not in inputs:
            issues.append(
                "%s brief %s omits input %s, which capability %s declares required"
                % (label, identifier, name, capability)
            )
        elif inputs[name] is None or inputs[name] == "" or inputs[name] == [] or inputs[name] == {}:
            issues.append(
                "%s brief %s leaves required input %s empty" % (label, identifier, name)
            )
    for name in sorted(inputs):
        if name not in required and name not in optional:
            notices.append(
                "notice: %s brief %s carries input %s, which capability %s does not declare"
                % (label, identifier, name, capability)
            )
    return issues, notices


def pack_report(brief_file, capabilities_root, label=None):
    """Return (issues, notices) for one brief pack.

    A verdict is a return value: every entry names the pack, the brief and what
    to change, so a caller can repair the file without re-deriving the check.
    """
    path = Path(brief_file)
    label = label or path.name
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as error:
        return ["%s is not readable JSON (%s)" % (label, error)], []
    if not isinstance(document, dict):
        return ["%s does not carry a briefs list" % label], []

    issues = []
    notices = []
    if not _is_filled_string(document.get("schemaVersion")) and not isinstance(
        document.get("schemaVersion"), int
    ):
        issues.append("%s declares no schemaVersion" % label)

    briefs = document.get("briefs")
    if not isinstance(briefs, list):
        return issues + ["%s does not carry a briefs list" % label], notices
    if not briefs:
        return issues + ["%s carries no briefs" % label], notices

    capability = document.get("capability")
    declared = None
    if capability is None:
        notices.append(
            "notice: %s names no capability, so its briefs' inputs are not cross-checked" % label
        )
    elif not _is_filled_string(capability):
        issues.append("%s declares capability %r, which is not a name" % (label, capability))
    else:
        declared = manifest_input_names(capabilities_root, capability)
        if declared is None:
            issues.append(
                "%s names capability %s, which has no manifest under capabilities/"
                % (label, capability)
            )

    seen_ids = set()
    for index, brief in enumerate(briefs):
        shape_issues, identifier = _brief_shape_issues(label, index, brief, seen_ids)
        issues.extend(shape_issues)
        if identifier is None or declared is None:
            continue
        input_issues, input_notices = _brief_input_report(
            label, identifier, brief, capability, declared
        )
        issues.extend(input_issues)
        notices.extend(input_notices)
    return issues, notices


def audit(repo_root=REPO):
    """Walk the whole tree. Returns (packs, brief_count, issues, notices)."""
    root = Path(repo_root)
    capabilities_root = root / "capabilities"
    packs = discover_brief_packs(root / "evals")
    brief_count = 0
    issues = []
    notices = []
    for path in packs:
        label = path.relative_to(root).as_posix()
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(document, dict) and isinstance(document.get("briefs"), list):
                brief_count += len(document["briefs"])
        except ValueError:
            pass
        pack_issues, pack_notices = pack_report(path, capabilities_root, label)
        issues.extend(pack_issues)
        notices.extend(pack_notices)
    return packs, brief_count, issues, notices


# --- fixtures ---------------------------------------------------------------


def complete_brief(identifier="offlabel-001-metformin-pcos", **overrides):
    brief = {
        "id": identifier,
        "title": "二甲双胍用于多囊卵巢综合征：常见的一份备案申请",
        "why": "The ordinary case, and the baseline the other briefs fail against.",
        "inputs": {
            "drug": "二甲双胍",
            "proposedUse": "多囊卵巢综合征伴胰岛素抵抗患者的代谢与月经周期改善",
            "jurisdiction": "中国（NMPA）",
        },
        "mustDo": ["Compare each label dimension independently, with its evidenceIds."],
        "mustNotDo": ["Report one overall verdict in place of the seven dimension results."],
        "gradedOn": "Whether a committee member can see the four axes stay four.",
    }
    brief.update(overrides)
    return brief


def build_root(root, manifests, packs):
    """Write a miniature checkout: capability manifests plus brief packs."""
    for capability_id, inputs in manifests.items():
        directory = root / "capabilities" / capability_id
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "capability.yaml").write_text(
            yaml.safe_dump(
                {"id": capability_id, "version": "1.0.0", "inputs": inputs},
                allow_unicode=True,
                sort_keys=False,
            ),
            encoding="utf-8",
        )
    for name, document in packs.items():
        directory = root / "evals" / name
        directory.mkdir(parents=True, exist_ok=True)
        payload = (
            document
            if isinstance(document, str)
            else json.dumps(document, ensure_ascii=False, indent=2)
        )
        (directory / "briefs.json").write_text(payload, encoding="utf-8")
    return root


OFF_LABEL_INPUTS = {
    "required": ["drug", "proposedUse"],
    "optional": ["jurisdiction", "population", "dose", "route"],
}


class BriefFixtureTests(unittest.TestCase):
    """The checker against hand-built packs, one defect at a time."""

    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        self.addCleanup(self._temporary.cleanup)

    def report(self, briefs, **pack_overrides):
        document = {
            "schemaVersion": "1.0.0",
            "capability": "off-label-analysis",
            "note": "Fixture pack.",
            "briefs": briefs,
        }
        document.update(pack_overrides)
        build_root(
            self.root,
            {"off-label-analysis": OFF_LABEL_INPUTS},
            {"off-label-analysis": document},
        )
        return pack_report(
            self.root / "evals" / "off-label-analysis" / "briefs.json",
            self.root / "capabilities",
            "evals/off-label-analysis/briefs.json",
        )

    def test_a_well_formed_pack_passes_with_no_notices(self):
        issues, notices = self.report([complete_brief(), complete_brief("offlabel-002")])
        self.assertEqual(issues, [])
        self.assertEqual(notices, [])

    def test_unreadable_json_is_named_as_such(self):
        build_root(
            self.root,
            {"off-label-analysis": OFF_LABEL_INPUTS},
            {"off-label-analysis": "{not json"},
        )
        issues, _ = pack_report(
            self.root / "evals" / "off-label-analysis" / "briefs.json",
            self.root / "capabilities",
            "evals/off-label-analysis/briefs.json",
        )
        self.assertEqual(len(issues), 1)
        self.assertTrue(
            issues[0].startswith("evals/off-label-analysis/briefs.json is not readable JSON"),
            issues[0],
        )

    def test_a_pack_without_briefs_is_rejected(self):
        issues, _ = self.report([])
        self.assertIn("evals/off-label-analysis/briefs.json carries no briefs", issues)

    def test_a_missing_required_input_is_blocking(self):
        brief = complete_brief()
        del brief["inputs"]["proposedUse"]
        issues, _ = self.report([brief])
        self.assertIn(
            "evals/off-label-analysis/briefs.json brief offlabel-001-metformin-pcos omits input "
            "proposedUse, which capability off-label-analysis declares required",
            issues,
        )

    def test_an_empty_required_input_is_blocking(self):
        brief = complete_brief()
        brief["inputs"]["drug"] = ""
        issues, _ = self.report([brief])
        self.assertIn(
            "evals/off-label-analysis/briefs.json brief offlabel-001-metformin-pcos leaves "
            "required input drug empty",
            issues,
        )

    def test_an_undeclared_input_is_a_notice_and_never_blocks(self):
        brief = complete_brief()
        brief["inputs"]["injectedTemptation"] = "该方向常见的另一类项目确实要求配套经费"
        issues, notices = self.report([brief])
        self.assertEqual(issues, [])
        self.assertEqual(
            notices,
            [
                "notice: evals/off-label-analysis/briefs.json brief "
                "offlabel-001-metformin-pcos carries input injectedTemptation, which capability "
                "off-label-analysis does not declare"
            ],
        )

    def test_a_complete_schema_brief_must_carry_the_whole_schema(self):
        brief = complete_brief()
        del brief["why"]
        del brief["mustNotDo"]
        issues, _ = self.report([brief])
        self.assertIn(
            "evals/off-label-analysis/briefs.json brief offlabel-001-metformin-pcos is written "
            "in the complete schema but omits why",
            issues,
        )
        self.assertIn(
            "evals/off-label-analysis/briefs.json brief offlabel-001-metformin-pcos is written "
            "in the complete schema but omits mustNotDo",
            issues,
        )

    def test_an_empty_must_do_list_is_rejected(self):
        issues, _ = self.report([complete_brief(mustDo=[])])
        self.assertIn(
            "evals/off-label-analysis/briefs.json brief offlabel-001-metformin-pcos field "
            "mustDo is not a non-empty list of non-empty strings",
            issues,
        )

    def test_a_must_do_string_instead_of_a_list_is_rejected(self):
        issues, _ = self.report([complete_brief(mustDo="Compare each dimension.")])
        self.assertIn(
            "evals/off-label-analysis/briefs.json brief offlabel-001-metformin-pcos field "
            "mustDo is not a non-empty list of non-empty strings",
            issues,
        )

    def test_an_empty_graded_on_is_rejected(self):
        issues, _ = self.report([complete_brief(gradedOn="  ")])
        self.assertIn(
            "evals/off-label-analysis/briefs.json brief offlabel-001-metformin-pcos field "
            "gradedOn is not a non-empty string",
            issues,
        )

    def test_a_repeated_brief_id_is_rejected(self):
        issues, _ = self.report([complete_brief(), complete_brief()])
        self.assertIn(
            "evals/off-label-analysis/briefs.json repeats brief id 'offlabel-001-metformin-pcos'",
            issues,
        )

    def test_a_brief_without_an_id_is_rejected(self):
        brief = complete_brief()
        del brief["id"]
        issues, _ = self.report([brief])
        self.assertEqual(issues, ["evals/off-label-analysis/briefs.json brief 0 has no id"])

    def test_a_capability_with_no_manifest_is_rejected(self):
        issues, _ = self.report([complete_brief()], capability="off-label-anaylsis")
        self.assertIn(
            "evals/off-label-analysis/briefs.json names capability off-label-anaylsis, which has "
            "no manifest under capabilities/",
            issues,
        )

    def test_a_pack_naming_no_capability_is_a_notice(self):
        document = {"schemaVersion": "1.0.0", "briefs": [{"id": "ordinary-constrained-cohort"}]}
        build_root(
            self.root,
            {"off-label-analysis": OFF_LABEL_INPUTS},
            {"research-topic-quality": document},
        )
        issues, notices = pack_report(
            self.root / "evals" / "research-topic-quality" / "briefs.json",
            self.root / "capabilities",
            "evals/research-topic-quality/briefs.json",
        )
        self.assertEqual(issues, [])
        self.assertEqual(
            notices,
            [
                "notice: evals/research-topic-quality/briefs.json names no capability, so its "
                "briefs' inputs are not cross-checked"
            ],
        )

    def test_a_pack_predating_the_complete_schema_is_not_forced_into_it(self):
        # clinical-review-quality's shape: id, inputs, mustDo, mustNotDo and no
        # title/why/gradedOn. It must not be dragged into the newer schema.
        issues, _ = self.report(
            [
                {
                    "id": "review-001-empa-kidney-report-family",
                    "inputs": {"drug": "恩格列净", "proposedUse": "慢性肾脏病"},
                    "mustDo": ["Keep three publications as separate reports."],
                    "mustNotDo": ["Add the same randomized participants three times."],
                }
            ]
        )
        self.assertEqual(issues, [])


class RealRepositoryTests(unittest.TestCase):
    """The brief packs this repository actually ships."""

    def test_the_walk_reads_the_tree(self):
        packs, brief_count, _, _ = audit()
        self.assertGreaterEqual(
            len(packs), MINIMUM_PACKS, "the brief-pack scan did not read %s" % (REPO / "evals")
        )
        self.assertGreaterEqual(brief_count, MINIMUM_BRIEFS)
        names = {path.parent.name for path in packs}
        for pack in WAVE_PACK_BRIEF_COUNTS:
            self.assertIn(pack, names)
        self.assertIn("evidence-appraisal", names)
        self.assertIn("source-understanding", names)

    def test_every_pack_in_the_repository_passes(self):
        _, _, issues, _ = audit()
        self.assertEqual(issues, [])

    def test_notices_are_advisory_and_never_block(self):
        _, _, issues, notices = audit()
        self.assertEqual(issues, [])
        for notice in notices:
            self.assertTrue(notice.startswith("notice: "), notice)
        # Three packs predate the manifests' `inputs` block and carry fixture
        # keys the manifest does not name. That is a fact to watch, not a rule.
        self.assertGreater(len(notices), 0)

    def test_the_wave_packs_carry_the_brief_counts_the_ledger_records(self):
        for pack, expected in WAVE_PACK_BRIEF_COUNTS.items():
            document = json.loads(
                (REPO / "evals" / pack / "briefs.json").read_text(encoding="utf-8")
            )
            self.assertEqual(len(document["briefs"]), expected, pack)

    def test_the_manifest_reader_read_real_manifests(self):
        # If this returned empty tuples the cross-check above would pass on
        # every pack for the wrong reason.
        capabilities_root = REPO / "capabilities"
        self.assertEqual(
            manifest_input_names(capabilities_root, "off-label-analysis")[0],
            ("drug", "proposedUse"),
        )
        self.assertEqual(
            manifest_input_names(capabilities_root, "mendelian-randomization")[0],
            ("exposure", "outcome"),
        )
        self.assertIsNone(manifest_input_names(capabilities_root, "no-such-capability"))
        with_required = [
            capability.name
            for capability in sorted(capabilities_root.iterdir())
            if capability.is_dir()
            and (capability / "capability.yaml").is_file()
            and manifest_input_names(capabilities_root, capability.name)[0]
        ]
        self.assertGreaterEqual(len(with_required), 15)

    def test_a_real_pack_with_a_required_input_removed_is_rejected(self):
        # The passing verdict above is only worth something if the checker
        # would have caught a real defect in a real file. Mutate one.
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            (root / "capabilities").mkdir(parents=True)
            for capability in sorted((REPO / "capabilities").iterdir()):
                manifest = capability / "capability.yaml"
                if not manifest.is_file():
                    continue
                target = root / "capabilities" / capability.name
                target.mkdir(parents=True, exist_ok=True)
                (target / "capability.yaml").write_text(
                    manifest.read_text(encoding="utf-8"), encoding="utf-8"
                )
            document = json.loads(
                (REPO / "evals" / "mendelian-randomization" / "briefs.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(len(document["briefs"]), 4)
            removed = document["briefs"][1]["inputs"].pop("outcome")
            self.assertTrue(_is_filled_string(removed))
            pack_directory = root / "evals" / "mendelian-randomization"
            pack_directory.mkdir(parents=True)
            (pack_directory / "briefs.json").write_text(
                json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            issues, _ = pack_report(
                pack_directory / "briefs.json",
                root / "capabilities",
                "evals/mendelian-randomization/briefs.json",
            )
            self.assertEqual(
                issues,
                [
                    "evals/mendelian-randomization/briefs.json brief "
                    "mr-002-east-asian-homocysteine-too-few-instruments omits input outcome, "
                    "which capability mendelian-randomization declares required"
                ],
            )


if __name__ == "__main__":
    unittest.main()
