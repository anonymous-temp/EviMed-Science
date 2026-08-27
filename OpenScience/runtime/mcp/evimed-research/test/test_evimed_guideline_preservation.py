"""A retrieved guideline's own prose must land on disk, or it can never be quoted.

The delivery gate binds a claim to a preserved artifact and checks the quote
appears in it verbatim. Nothing in the EviMed connectors wrote one: only
`official_pages` and `open_access_fulltext` did. So every guideline this
deployment retrieved -- full text included, which the upstream returns -- could
be cited by number and never carry a verified claim.

Measured on three real runs before the fix: the number of references able to
carry a claim equalled the number of preserved full texts exactly (3, 3, 1),
while 12 of 15, 6 of 9 and 29 of 30 references could not.
"""

import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_module():
    sys.path.insert(0, str(ROOT))
    spec = importlib.util.spec_from_file_location("evimed_public_sources_pres_test", ROOT / "public_sources.py")
    try:
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.pop(0)


class GuidelinePreservationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.workspace = pathlib.Path(self.temp.name) / "workspace"
        self.workspace.mkdir()
        self.previous = os.environ.get("OPEN_SCIENCE_WORKSPACE_DIR")
        os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = str(self.workspace)

    def tearDown(self):
        if self.previous is None:
            os.environ.pop("OPEN_SCIENCE_WORKSPACE_DIR", None)
        else:
            os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = self.previous
        self.temp.cleanup()

    def test_full_text_is_written_and_quotable_verbatim(self):
        sentence = "疑似急性心肌梗死者应立即呼叫急救，任何自救用药都不得作为延迟呼救的理由。"
        body = sentence + "".join("第 %d 段补充说明。" % index for index in range(40))
        path = self.module._preserve_guideline_text(
            "g-1",
            "急性胸痛急诊诊疗专家共识",
            {"fullText": body, "publisher": "中华医学会", "year": "2019"},
        )

        self.assertIsNotNone(path, "a guideline carrying full text must be preserved")
        written = (self.workspace / path).read_text(encoding="utf-8")
        # The gate's own rule: the quote has to be findable in the artifact.
        self.assertIn(sentence, written)
        self.assertIn("中华医学会", written, "provenance travels with the text, or the artifact is anonymous")

    def test_text_blocks_are_preserved_when_there_is_no_full_text(self):
        blocks = [{"text": "第一段：" + "内容" * 60}, {"text": "第二段：" + "内容" * 60}]
        path = self.module._preserve_guideline_text("g-2", "指南", {"blocks": blocks})

        self.assertIsNotNone(path)
        written = (self.workspace / path).read_text(encoding="utf-8")
        for block in blocks:
            self.assertIn(block["text"], written, "every block must survive, not just the first")

    def test_a_record_with_no_prose_preserves_nothing(self):
        # The control. Writing a stub for a metadata-only hit would make an
        # empty artifact look like preserved evidence, which is worse than
        # having none: the gate would bind a claim to a file with no text in it.
        for record in ({}, {"fullText": "   "}, {"fullText": "太短"}, {"blocks": []}):
            self.assertIsNone(
                self.module._preserve_guideline_text("g-3", "标题", record),
                "a record with no usable prose must not produce an artifact: %r" % (record,),
            )
        self.assertEqual(list(self.workspace.rglob("*.md")), [], "nothing may be written")

    def test_a_broken_workspace_degrades_instead_of_failing_the_retrieval(self):
        # A retrieval that returned records must not be turned into an error by
        # a disk problem: the records are still usable as citations, they just
        # cannot carry a verbatim claim.
        os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = "/nonexistent/evimed/workspace"
        self.assertIsNone(
            self.module._preserve_guideline_text("g-4", "标题", {"fullText": "有效正文" * 60}),
        )


if __name__ == "__main__":
    unittest.main()
