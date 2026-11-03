"""Source alignment regressions: labels cannot influence geometry or coverage."""
import copy
import unittest
from alignment import align, from_utf16_span, native_label, score_aligned


def fixture(text="Age >= 18 years", kind="inclusion"):
    identity = dict(patient_id="p", trial_id="t", criterion_type=kind, source_id="s", source_version="v")
    return {"sources": [dict(id="s", version="v", trial_id="t", criterion_type=kind, text=text)],
            "gold_units": [dict(id="g", text=text, **identity)],
            "platform_units": [dict(id="x", text=text, state="satisfied", applicable=True, **identity)]}


class AlignmentTests(unittest.TestCase):
    def test_exact_and_final_exclusion_polarity(self):
        data = fixture(kind="exclusion")
        result = align(data)
        self.assertEqual(result["scorable"], 1)
        self.assertEqual(native_label(data["platform_units"][0]), "not excluded")
        data["platform_units"][0]["state"] = "not_satisfied"
        self.assertEqual(native_label(data["platform_units"][0]), "excluded")

    def test_labels_do_not_change_mapping(self):
        data = fixture(); original = align(data)
        data["platform_units"][0].update(state="not_satisfied", applicable=False, expert_label="included")
        data["gold_units"][0]["label"] = "not included"
        self.assertEqual(original, align(data))

    def test_whitespace_fullwidth_and_original_offsets(self):
        data = fixture("  Age\t>= １８ years  ")
        data["gold_units"][0]["text"] = "Age >= 18 years"
        result = align(data)
        self.assertEqual(result["rows"][0]["gold_span"], (2, 17))
        self.assertEqual(result["scorable"], 1)

    def test_repeated_fragment_requires_locator(self):
        data = fixture("Age >= 18 years; Age >= 18 years")
        data["gold_units"][0]["text"] = "Age >= 18 years"
        data["platform_units"][0].update(text="Age >= 18 years", start=0, end=15)
        self.assertEqual(align(data)["rows"][0]["status"], "ambiguous_overlap")
        data["gold_units"][0].update(start=0, end=15)
        self.assertEqual(align(data)["scorable"], 1)

    def test_source_version_and_subject_isolation(self):
        for key, value in [("patient_id", "other"), ("trial_id", "other"),
                           ("source_version", "v2"), ("criterion_type", "exclusion")]:
            with self.subTest(key=key):
                data = fixture(); data["platform_units"][0][key] = value
                self.assertEqual(align(data)["scorable"], 0)

    def test_split_and_merged_are_not_guessed(self):
        data = fixture("Age >= 18 years and ECOG <= 1")
        first = data["platform_units"][0]
        data["platform_units"] = [dict(first, text="Age >= 18 years"), dict(first, id="y", text="ECOG <= 1")]
        self.assertEqual(align(data)["rows"][0]["status"], "partial_overlap")
        # Complete split coverage is still not a whole-clause judgment.
        data["platform_units"][0]["text"] = "Age >= 18 years and "
        self.assertEqual(align(data)["rows"][0]["status"], "split_unresolved")
        data = fixture("Age >= 18 years and ECOG <= 1")
        data["gold_units"][0]["text"] = "Age >= 18 years"
        self.assertEqual(align(data)["rows"][0]["status"], "merged_unresolved")

    def test_do_not_align_invented_threshold_or_locator(self):
        data = fixture(); data["platform_units"][0]["text"] = "Age >= 19 years"
        self.assertEqual(align(data)["scorable"], 0)
        data = fixture(); data["platform_units"][0].update(start=1, end=15)
        self.assertEqual(align(data)["unlocated_platform"][0]["reason"], "invalid_locator")

    def test_negation_cannot_be_lost_by_high_overlap(self):
        data = fixture("not " + "a serious condition with a sufficiently long descriptive qualification " * 3)
        data["platform_units"][0]["text"] = data["platform_units"][0]["text"][4:]
        self.assertEqual(align(data)["scorable"], 0)

    def test_unique_whole_clause_preferred_to_children(self):
        data = fixture("Age >= 18 years and ECOG <= 1")
        data["platform_units"].append(dict(data["platform_units"][0], id="child", text="ECOG <= 1"))
        self.assertEqual(align(data)["rows"][0]["platform_ids"], ["x"])

    def test_duplicate_answers_are_ambiguous(self):
        data = fixture(); data["platform_units"].append(dict(data["platform_units"][0], id="y"))
        self.assertEqual(align(data)["rows"][0]["status"], "ambiguous_overlap")

    def test_one_aggregate_cannot_answer_two_annotations(self):
        data = fixture(); data["gold_units"].append(dict(data["gold_units"][0], id="g2"))
        self.assertEqual(align(data)["buckets"], {"merged_unresolved": 2})

    def test_unmatched_not_wrong_but_missing_aligned_answer_is_counted(self):
        data = fixture(); data["gold_units"].append(dict(data["gold_units"][0], id="g2", text="unknown source"))
        report = align(data)
        scored = score_aligned(report, data["platform_units"], {"g": "included"})
        self.assertEqual((scored["accuracy_on_scorable"], scored["alignment_coverage"]), (1, .5))
        data["platform_units"][0].pop("state")
        scored = score_aligned(report, data["platform_units"], {"g": "included"})
        self.assertEqual(scored["missing_answers_on_aligned"], 1)
        self.assertEqual(scored["accuracy_on_scorable"], 0)
        self.assertEqual(scored["unresolved"], 1)

    def test_missing_applicability_not_interpreted_as_not_applicable(self):
        self.assertIsNone(native_label({"state": "satisfied", "criterion_type": "inclusion"}))
        self.assertEqual(native_label({"applicable": False}), "not applicable")

    def test_duplicate_or_unowned_sources_refused(self):
        data = fixture(); data["sources"].append(copy.deepcopy(data["sources"][0]))
        with self.assertRaises(ValueError): align(data)

    def test_locator_edge_whitespace_and_unicode_expansion(self):
        data = fixture("Age and ECOG")
        data["gold_units"][0].update(text="Age", start=0, end=4)
        data["platform_units"][0]["text"] = "Age"
        self.assertEqual(align(data)["scorable"], 1)
        data = fixture("Stage Ⅳ")
        for unit in [*data["gold_units"], *data["platform_units"]]: unit["text"] = "V"
        self.assertEqual(align(data)["scorable"], 0)

    def test_native_utf16_positions_are_explicitly_converted(self):
        self.assertEqual(from_utf16_span("🧪 Age", 3, 6), (2, 5))
        with self.assertRaises(ValueError): from_utf16_span("🧪 Age", 1, 6)

    def test_substantive_aggregate_boundary_and_unicode_minus(self):
        phrase = "A clinically documented condition with a relevant history and appropriate diagnostic confirmation in the last year"
        data = fixture(phrase + "; HIV")
        data["gold_units"][0]["text"] = phrase
        self.assertEqual(align(data)["scorable"], 0)
        data["gold_units"].append(dict(data["gold_units"][0], id="whole", text=phrase + "; HIV"))
        report = align(data)
        self.assertEqual(report["scorable"], 1)
        self.assertEqual(report["rows"][1]["status"], "aligned")
        data = fixture("−5 points in a previous validated clinical evaluation of the patient")
        data["platform_units"][0]["text"] = data["platform_units"][0]["text"][1:]
        self.assertEqual(align(data)["scorable"], 0)

    def test_every_platform_unit_has_a_disposition(self):
        data = fixture("Age and ECOG")
        data["gold_units"][0]["text"] = "Age"
        data["platform_units"][0]["text"] = "Age"
        data["platform_units"].append(dict(data["platform_units"][0], id="other", text="ECOG"))
        result = align(data)
        self.assertEqual(result["platform_buckets"], {"aligned": 1, "unmatched": 1})

    def test_scoring_rejects_replaced_patient_and_invalid_gold(self):
        data = fixture(); report = align(data)
        with self.assertRaises(ValueError): score_aligned(report, data["platform_units"], {"g": None})
        with self.assertRaises(ValueError): score_aligned(report, data["platform_units"], {"g": "excluded"})
        data["platform_units"][0]["patient_id"] = "other"
        with self.assertRaises(ValueError): score_aligned(report, data["platform_units"], {"g": "included"})

    def test_nonstring_text_rejected(self):
        data = fixture("True"); data["gold_units"][0]["text"] = True
        with self.assertRaises(ValueError): align(data)

    def test_fragment_cannot_cut_a_word_or_negative_prefix(self):
        for phrase, quote in [("inactive infection", "active infection"), ("non-active infection", "active infection")]:
            data = fixture(phrase)
            for unit in [*data["gold_units"], *data["platform_units"]]: unit["text"] = quote
            self.assertEqual(align(data)["scorable"], 0)
        data = fixture("inactive infection")
        for unit in [*data["gold_units"], *data["platform_units"]]: unit.update(text="active infection", start=2, end=18)
        self.assertEqual(align(data)["scorable"], 0)

    def test_unique_exact_owner_survives_punctuation_near_match(self):
        data = fixture("Age >= 18 years.")
        data["gold_units"].append(dict(data["gold_units"][0], id="near", text="Age >= 18 years"))
        result = align(data)
        self.assertEqual(result["scorable"], 1)
        self.assertEqual([r["status"]for r in result["rows"]], ["aligned", "merged_unresolved"])

    def test_numeric_and_unicode_token_boundaries(self):
        for source, quote in [("non‑active infection", "active infection"), ("−5 points", "5 points"),
                              ("1.5 mg", "5 mg"), ("<5 mg", "5 mg"), ("≤5 mg", "5 mg"),
                              ("<=5 mg", "=5 mg"), ("1.5 mg", "1"), ("5mg", "5")]:
            for explicit in (False, True):
                with self.subTest(source=source, explicit=explicit):
                    data = fixture(source)
                    for unit in [*data["gold_units"], *data["platform_units"]]:
                        unit["text"] = quote
                        if explicit: unit.update(start=source.index(quote), end=source.index(quote) + len(quote))
                    self.assertEqual(align(data)["scorable"], 0)

    def test_section_constraints_prevent_cross_kind_anchoring(self):
        data=fixture("Age >= 18\n\nExclusion Criteria:\nAge >= 70")
        data["sources"][0].update(section_start=0,section_end=9)
        for unit in [*data["gold_units"],*data["platform_units"]]:unit["text"]="Age >= 70"
        self.assertEqual(align(data)["scorable"],0)
        for unit in [*data["gold_units"],*data["platform_units"]]:unit.update(start=31,end=40)
        self.assertEqual(align(data)["scorable"],0)
        data = fixture(); data["gold_units"][0].pop("patient_id")
        with self.assertRaises(ValueError): align(data)


if __name__ == "__main__":
    unittest.main()
