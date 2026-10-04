"""The standard-format import: FHIR, OMOP CDM and CDISC ADaM into the module's tables.

The committed fixtures are real public samples (``fixtures/vcr_imports/provenance.json``
says where each came from, under what licence, when it was fetched, and holds its
SHA-256 so a fixture cannot change unnoticed). Every number asserted about a
fixture below was read from the fixture independently of this converter: record
counts and values with ``jq`` over the NDJSON, day counts with ``date``, OMOP rows
with ``awk`` over the CSV, ADaM datasets with R's ``foreign::read.xport``. A test
whose expected value was copied out of the converter's own output would only
prove the converter agrees with itself.

Hostile and malformed inputs are built byte by byte in the tests, so nothing
binary is committed for them.
"""

import contextlib
import csv
import hashlib
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import vcr_import_convert as convert  # noqa: E402

FIXTURES = ROOT / "test" / "fixtures" / "vcr_imports"
SMART = FIXTURES / "smart-10-patients.zip"
OWN_COLUMNS = {"observed", "calculated", "imputed", "extracted"}


def run_bytes(data, form, extension, *, limits=None, expect=None):
    """The converter on some bytes, as the container runs it: a staged file, an output directory, a result."""
    with tempfile.TemporaryDirectory() as scratch:
        source = pathlib.Path(scratch) / f"import.{extension}"
        source.write_bytes(data)
        out = pathlib.Path(scratch) / "out"
        out.mkdir()
        request = {
            "format": form, "extension": extension,
            "file": expect or {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)},
            "limits": limits or {},
        }
        try:
            result = convert.run(request, source, out)
        except convert.Refusal as refusal:
            return {"outcome": "refused", "reason": refusal.reason}, {}
        tables = {item["name"]: list(csv.reader(io.StringIO((out / item["file"]).read_text(encoding="utf-8")))) for item in result["tables"]}
        return result, tables


def refusal_of(data, form, extension, **kwargs):
    result, _ = run_bytes(data, form, extension, **kwargs)
    assert result["outcome"] == "refused", result.get("coverage")
    return result["reason"]


def rows_of(table):
    header, *body = table
    return [dict(zip(header, row)) for row in body]


def entry(result, table, column):
    found = [item for item in result["fieldMap"] if item["table"] == f"{table}.csv" and item["column"] == column]
    assert len(found) == 1, (table, column)
    return found[0]


def coverage_of(result, kind):
    found = [item for item in result["coverage"]["inputs"] if item["kind"] == kind]
    assert len(found) == 1, kind
    return found[0]


def notices_of(result):
    return {item["code"]: item["count"] for item in result["coverage"]["notices"]}


def zip_bytes(members):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, body in members.items():
            archive.writestr(name, body)
    return buffer.getvalue()


def ndjson(*resources):
    return "\n".join(json.dumps(item) for item in resources).encode("utf-8") + b"\n"


class Fixtures(unittest.TestCase):
    def test_every_committed_fixture_is_the_file_its_provenance_names(self):
        manifest = json.loads((FIXTURES / "provenance.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(manifest["fixtures"]), 1)
        for item in manifest["fixtures"]:
            body = (FIXTURES / item["file"]).read_bytes()
            self.assertEqual(hashlib.sha256(body).hexdigest(), item["sha256"], item["file"])
            for key in ("source", "licence", "fetchedAt"):
                self.assertTrue(item.get(key), f"{item['file']} has no {key}")
        # A fixture under terms that forbid modification is never committed.
        self.assertFalse([item for item in manifest["fixtures"] if "cdisc-pilot" in item["file"].lower()])


class FhirSample(unittest.TestCase):
    """SMART's 10-patient bulk export (Synthea, US Core, R4): 18 resource types, 7,887 lines."""

    @classmethod
    def setUpClass(cls):
        cls.result, cls.tables = run_bytes(SMART.read_bytes(), "fhir", "zip")

    def test_the_tables_have_the_row_counts_the_files_hold(self):
        counts = {name: len(rows) - 1 for name, rows in self.tables.items()}
        # wc -l of each *.000.ndjson, and jq: 2,672 observations carry a value of their own, 178 carry only
        # components (1,516 of them) and no observation does both: 2,672 + 1,516 = 4,188 rows.
        self.assertEqual(counts, {
            "fhir_patient": 11, "fhir_condition": 298, "fhir_observation": 4188, "fhir_medication": 172, "fhir_procedure": 1341, "fhir_encounter": 413,
        })
        self.assertEqual({item["name"]: item["rows"] for item in self.result["tables"]}, counts)

    def test_every_resource_is_accounted_for_and_what_was_not_read_is_named(self):
        for kind, read in (("Patient", 11), ("Condition", 298), ("Observation", 2850), ("MedicationRequest", 172), ("Procedure", 1341), ("Encounter", 413)):
            got = coverage_of(self.result, kind)
            self.assertEqual((got["status"], got["records"], got["imported"]), ("imported", read, read), kind)
        unread = {"AllergyIntolerance": 11, "Device": 39, "DiagnosticReport": 780, "DocumentReference": 413, "EpisodeOfCare": 413, "Immunization": 143,
                  "Location": 44, "Organization": 43, "Practitioner": 43, "PractitionerRole": 43, "ServiceRequest": 413, "Specimen": 413}
        for kind, read in unread.items():
            got = coverage_of(self.result, kind)
            self.assertEqual((got["status"], got["reason"], got["records"], got["imported"]), ("skipped", "unsupported_resource_type", read, 0), kind)
        # The export's own log is not a resource file.
        log = coverage_of(self.result, "log.ndjson")
        self.assertEqual((log["status"], log["reason"], log["records"]), ("skipped", "not_fhir_resources", 4))

    def test_the_follow_up_is_computed_from_the_records_and_says_so(self):
        patients = {row["patient_id"][:8]: row for row in rows_of(self.tables["fhir_patient"])}
        # jq: the earliest and latest date of any resource of the patient; `date` for the day counts.
        deceased = patients["da73946b"]
        self.assertEqual((deceased["birth_year"], deceased["age_at_index"], deceased["first_record_date"]), ("1986", "13", "1999-12-15"))
        self.assertEqual((deceased["deceased"], deceased["os_days"], deceased["os_event"]), ("1", "3341", "1"))
        alive = patients["0bee1bc6"]
        self.assertEqual((alive["birth_year"], alive["age_at_index"], alive["first_record_date"], alive["os_days"], alive["os_event"]),
                         ("1978", "18", "1996-07-05", "9401", "0"))
        self.assertEqual(alive["deceased"], "", "no death recorded is not a statement of being alive")
        oldest = patients["f2d47e71"]
        self.assertEqual((oldest["first_record_date"], oldest["os_days"], oldest["os_event"]), ("1945-07-15", "28329", "0"))
        # Exactly one patient has a death, and one has records after it (the export's own data quality, counted).
        self.assertEqual([row["patient_id"][:8] for row in patients.values() if row["os_event"] == "1"], ["da73946b"])
        self.assertEqual(notices_of(self.result)["records_after_death"], 1)

    def test_values_are_carried_as_stated_and_units_are_not_converted(self):
        observations = rows_of(self.tables["fhir_observation"])
        weights = [float(row["value_number"]) for row in observations if row["code"] == "29463-7" and not row["component_code"]]
        heights = [float(row["value_number"]) for row in observations if row["code"] == "8302-2"]
        # jq over valueQuantity.value: 111 weights summing to 7571.9, 95 heights summing to 15075.7.
        self.assertEqual(len(weights), 111)
        self.assertAlmostEqual(sum(weights), 7571.9, places=6)
        self.assertEqual(len(heights), 95)
        self.assertAlmostEqual(sum(heights), 15075.7, places=6)
        # A panel's components are rows of their own with the component's code.
        panel = [row for row in observations if row["code"] == "85354-9"]
        self.assertEqual(len(panel), 116 * 2)
        self.assertEqual({row["component_code"] for row in panel}, {"8480-6", "8462-4"})
        self.assertEqual(len([row for row in observations if row["component_code"]]), 1516)
        first = observations[0]
        self.assertEqual((first["code"], first["value_type"], first["value_number"], first["value_unit"], first["effective_date"]), ("72514-3", "Quantity", "4", "{score}", "2022-04-01"))
        self.assertEqual(notices_of(self.result)["mixed_units"], 2)
        medications = [row["code"] for row in rows_of(self.tables["fhir_medication"])]
        self.assertEqual(medications.count("1535362"), 20)
        self.assertEqual({row["class_code"] for row in rows_of(self.tables["fhir_encounter"])}, {"AMB", "EMER", "HH", "IMP"})
        self.assertEqual(len([row for row in rows_of(self.tables["fhir_condition"]) if row["clinical_status"] == "active"]), 90)

    def test_nothing_that_identifies_a_person_is_carried(self):
        with tempfile.TemporaryDirectory() as scratch:
            source = pathlib.Path(scratch) / "import.zip"
            source.write_bytes(SMART.read_bytes())
            out = pathlib.Path(scratch) / "out"
            out.mkdir()
            convert.run({"format": "fhir", "extension": "zip", "file": {"sha256": hashlib.sha256(SMART.read_bytes()).hexdigest(), "bytes": SMART.stat().st_size}}, source, out)
            everything = "".join(path.read_text(encoding="utf-8") for path in out.iterdir())
        # The first patient's name, her social-security and driver's-licence numbers, her birth date, her address town.
        # ... and the one recorded death's date, 2009-02-06, appears nowhere as a column value (only the days to it do).
        for identifying in ("Hyatt152", "Brandon214", "999-59-5908", "S99990168", "1978-05-12", "Parsons", "555-352-7285", "Nelida367"):
            self.assertNotIn(identifying, everything)

    def test_every_column_states_its_value_source_and_only_the_computed_ones_are_calculated(self):
        for table in self.result["tables"]:
            for column in table["columns"]:
                self.assertIn(column["valueSource"], OWN_COLUMNS, (table["name"], column["name"]))
        calculated = {(item["table"], item["column"]) for item in self.result["fieldMap"] if item["valueSource"] == "calculated"}
        self.assertEqual(calculated, {("fhir_patient.csv", name) for name in ("birth_year", "age_at_index", "first_record_date", "os_days", "os_event")})
        for item in self.result["fieldMap"]:
            self.assertIn(item["valueSource"], OWN_COLUMNS)
        self.assertEqual({item["column"].split(".")[0] for item in self.result["dictionary"]}, {table["name"] for table in self.result["tables"]})

    def test_the_field_map_names_the_subject_the_outcome_and_what_is_sealed(self):
        keys = [item for item in self.result["fieldMap"] if item["role"] == "subject_key"]
        self.assertEqual(sorted(item["table"] for item in keys), sorted(f"{table['name']}.csv" for table in self.result["tables"]))
        self.assertEqual(entry(self.result, "fhir_patient", "os_days")["role"], "outcome_time")
        event = entry(self.result, "fhir_patient", "os_event")
        self.assertEqual((event["role"], event["parameter"], event["codes"]), ("outcome_event", "OS", {"event": ["1"], "censored": ["0"]}))
        self.assertEqual(entry(self.result, "fhir_patient", "first_record_date")["role"], "time_zero")
        # The death flag is an outcome: it is a covariate flagged as one, so a confirmatory seal holds it. The date of death is not carried.
        self.assertTrue(entry(self.result, "fhir_patient", "deceased")["outcome"])
        self.assertNotIn("death_date", self.tables["fhir_patient"][0])
        for item in self.result["fieldMap"]:
            self.assertLessEqual(set(item), {"table", "column", "role", "valueSource", "concept", "unit", "codingSystem", "timeKind", "parameter", "alias", "type", "outcome", "codes"})
            self.assertLessEqual(len(item.get("concept", "")), 80)
        self.assertEqual(self.result["standard"], {"name": "HL7 FHIR", "release": "R4"})


class FhirShapes(unittest.TestCase):
    def test_a_bundle_resolves_its_urn_references_and_reads_components_and_statements(self):
        bundle = {
            "resourceType": "Bundle", "type": "transaction", "entry": [
                {"fullUrl": "urn:uuid:p-1", "resource": {"resourceType": "Patient", "id": "p-1", "gender": "male", "birthDate": "1970-06-15"}},
                {"fullUrl": "urn:uuid:c-1", "resource": {"resourceType": "Condition", "id": "c-1", "subject": {"reference": "urn:uuid:p-1", "display": "Jan Doe"},
                                                        "code": {"coding": [{"system": "http://snomed.info/sct", "code": "44054006", "display": "Diabetes"}]},
                                                        "onsetPeriod": {"start": "2020-01-10"}}},
                {"fullUrl": "urn:uuid:o-1", "resource": {"resourceType": "Observation", "id": "o-1", "subject": {"reference": "urn:uuid:p-1"},
                                                        "code": {"coding": [{"system": "http://loinc.org", "code": "85354-9"}]}, "effectiveDateTime": "2020-02-01T10:00:00+01:00",
                                                        "component": [{"code": {"coding": [{"code": "8480-6"}]}, "valueQuantity": {"value": 120, "code": "mm[Hg]", "comparator": ">"}},
                                                                      {"code": {"coding": [{"code": "8462-4"}]}, "valueQuantity": {"value": 80, "code": "mm[Hg]"}}]}},
                {"fullUrl": "urn:uuid:m-1", "resource": {"resourceType": "MedicationStatement", "id": "m-1", "subject": {"reference": "Patient/p-1"},
                                                        "medicationCodeableConcept": {"coding": [{"system": "rxnorm", "code": "860975"}]}, "effectivePeriod": {"start": "2020-03-01", "end": "2021-03-01"}}},
            ],
        }
        result, tables = run_bytes(json.dumps(bundle).encode("utf-8"), "fhir", "json")
        self.assertEqual(result["outcome"], "converted")
        self.assertEqual({name: len(rows) - 1 for name, rows in tables.items()},
                         {"fhir_patient": 1, "fhir_condition": 1, "fhir_observation": 2, "fhir_medication": 1})
        condition = rows_of(tables["fhir_condition"])[0]
        self.assertEqual((condition["patient_id"], condition["code"], condition["onset_date"]), ("p-1", "44054006", "2020-01-10"))
        panel = rows_of(tables["fhir_observation"])
        self.assertEqual([(row["component_code"], row["value_number"], row["value_comparator"], row["value_unit"], row["effective_date"]) for row in panel],
                         [("8480-6", "120", ">", "mm[Hg]", "2020-02-01"), ("8462-4", "80", "", "mm[Hg]", "2020-02-01")])
        self.assertEqual(rows_of(tables["fhir_medication"])[0]["resource_type"], "MedicationStatement")
        patient = rows_of(tables["fhir_patient"])[0]
        # First record 2020-01-10, last 2021-03-01; the birth date was 1970-06-15: 49 completed years.
        self.assertEqual((patient["age_at_index"], patient["first_record_date"], patient["os_days"], patient["os_event"]), ("49", "2020-01-10", "416", "0"))
        self.assertNotIn("Jan Doe", json.dumps(tables))

    def test_a_row_with_no_patient_and_a_medication_with_no_code_are_counted_not_dropped_silently(self):
        data = ndjson(
            {"resourceType": "Patient", "id": "a"},
            {"resourceType": "Patient", "id": "a"},
            {"resourceType": "Patient"},
            {"resourceType": "Condition", "id": "c1", "subject": {"reference": "Group/9"}, "code": {"coding": [{"code": "x"}]}},
            {"resourceType": "Condition", "id": "c2", "subject": {"reference": "Patient/zz"}, "code": {"coding": [{"code": "x"}]}, "onsetDateTime": "2020"},
            {"resourceType": "MedicationRequest", "id": "m1", "subject": {"reference": "Patient/a"}, "medicationReference": {"reference": "Medication/1"}},
            {"resourceType": "Observation", "id": "o1", "subject": {"reference": "Patient/a"}, "code": {"coding": [{"code": "k"}]}, "valueRange": {"low": {"value": 1}}},
            {"resourceType": "Observation", "id": "o2", "subject": {"reference": "Patient/a"}, "code": {"coding": [{"code": "k"}]}},
        )
        result, tables = run_bytes(data, "fhir", "ndjson")
        self.assertEqual(coverage_of(result, "Patient")["skipped"], {"duplicate_patient_id": 1, "no_id": 1})
        self.assertEqual(coverage_of(result, "Condition")["skipped"], {"no_patient_reference": 1})
        self.assertEqual(coverage_of(result, "MedicationRequest")["status"], "skipped")
        self.assertEqual(coverage_of(result, "MedicationRequest")["skipped"], {"medication_not_coded": 1})
        notices = notices_of(result)
        self.assertEqual(notices["patient_not_in_file"], 1)
        self.assertEqual(notices["partial_date"], 1)
        self.assertEqual(notices["value_not_carried:Range"], 1)
        self.assertEqual(notices["observation_without_value"], 1)
        # A Patient with no record has no follow-up, and says nothing instead of inventing one.
        patient = rows_of(tables["fhir_patient"])[0]
        self.assertEqual((patient["first_record_date"], patient["os_days"], patient["os_event"]), ("", "", ""))

    def test_a_death_without_a_date_and_a_death_before_the_first_record_leave_the_follow_up_blank(self):
        data = ndjson(
            {"resourceType": "Patient", "id": "u", "deceasedBoolean": True},
            {"resourceType": "Patient", "id": "e", "deceasedDateTime": "2019-01-01T00:00:00Z"},
            {"resourceType": "Encounter", "id": "1", "subject": {"reference": "Patient/u"}, "period": {"start": "2020-01-01", "end": "2020-01-02"}},
            {"resourceType": "Encounter", "id": "2", "subject": {"reference": "Patient/e"}, "period": {"start": "2020-01-01", "end": "2020-01-02"}},
        )
        result, tables = run_bytes(data, "fhir", "ndjson")
        rows = {row["patient_id"]: row for row in rows_of(tables["fhir_patient"])}
        self.assertEqual((rows["u"]["deceased"], rows["u"]["os_days"], rows["u"]["os_event"]), ("1", "", ""))
        self.assertEqual((rows["e"]["deceased"], rows["e"]["os_days"], rows["e"]["os_event"]), ("1", "", ""))
        self.assertEqual(notices_of(result)["death_date_unknown"], 1)
        self.assertEqual(notices_of(result)["death_before_first_record"], 1)


class FhirRefusals(unittest.TestCase):
    """A file that is not what it claims to be is refused whole, by name, with nothing written."""

    def test_named_refusals(self):
        self.assertEqual(refusal_of(b"patient_id,age\n1,40\n2,50\n", "fhir", "ndjson"), "not_json")
        self.assertEqual(refusal_of(b'{"id": 1}\n{"id": 2}\n', "fhir", "ndjson"), "not_fhir")
        self.assertEqual(refusal_of(b'{"hello": "world"}', "fhir", "json"), "not_fhir")
        self.assertEqual(refusal_of(b"[1, 2", "fhir", "json"), "not_json")
        self.assertEqual(refusal_of(ndjson({"resourceType": "Practitioner", "id": "x"}), "fhir", "ndjson"), "no_supported_resource")
        self.assertEqual(refusal_of(b"not a zip", "fhir", "zip"), "not_zip")
        self.assertEqual(refusal_of(b"PK\x03\x04 truncated", "fhir", "zip"), "corrupt")
        self.assertEqual(refusal_of(zip_bytes({"readme.txt": "hello"}), "fhir", "zip"), "nothing_to_import")
        self.assertEqual(refusal_of(b"", "fhir", "ndjson", expect={"sha256": hashlib.sha256(b"").hexdigest(), "bytes": 1}), "request_invalid")

    def test_a_file_that_is_not_the_one_digested_is_never_read(self):
        data = ndjson({"resourceType": "Patient", "id": "a"})
        self.assertEqual(refusal_of(data, "fhir", "ndjson", expect={"sha256": "0" * 64, "bytes": len(data)}), "request_invalid")
        self.assertEqual(refusal_of(data, "fhir", "ndjson", expect={"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data) + 1}), "request_invalid")

    def test_a_standard_the_script_does_not_know_and_an_extension_it_cannot_spell_are_refused(self):
        data = ndjson({"resourceType": "Patient", "id": "a"})
        self.assertEqual(refusal_of(data, "hl7v2", "ndjson"), "request_invalid")
        self.assertEqual(refusal_of(data, "fhir", "nd json"), "request_invalid")

    def test_an_archive_with_too_many_members_or_an_encrypted_member_is_refused(self):
        many = zip_bytes({f"f{index}.ndjson": "" for index in range(convert.MAX_MEMBERS + 1)})
        self.assertEqual(refusal_of(many, "fhir", "zip"), "corrupt")
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("a.ndjson", ndjson({"resourceType": "Patient", "id": "a"}))
        raw = bytearray(buffer.getvalue())
        # Set the "encrypted" bit in the local and central headers.
        for marker in (b"PK\x03\x04", b"PK\x01\x02"):
            at = raw.find(marker)
            raw[at + (6 if marker == b"PK\x03\x04" else 8)] |= 0x1
        self.assertEqual(refusal_of(bytes(raw), "fhir", "zip"), "encrypted")

    def test_a_table_past_the_planes_row_limit_is_skipped_by_name_and_the_others_still_land(self):
        result, tables = run_bytes(SMART.read_bytes(), "fhir", "zip", limits={"maxRows": 500})
        self.assertEqual(result["outcome"], "converted")
        self.assertEqual(sorted(tables), ["fhir_condition", "fhir_encounter", "fhir_medication", "fhir_patient"])
        skipped = {item["table"]: item["reason"] for item in result["coverage"]["skippedTables"]}
        self.assertEqual(skipped, {"fhir_observation": "too_many_rows", "fhir_procedure": "too_many_rows"})
        self.assertEqual(len(tables["fhir_condition"]) - 1, 298)

    def test_a_table_past_the_byte_limit_is_not_written_partially(self):
        with tempfile.TemporaryDirectory() as scratch:
            source = pathlib.Path(scratch) / "import.zip"
            source.write_bytes(SMART.read_bytes())
            out = pathlib.Path(scratch) / "out"
            out.mkdir()
            result = convert.run({"format": "fhir", "extension": "zip", "file": {"sha256": hashlib.sha256(SMART.read_bytes()).hexdigest(), "bytes": SMART.stat().st_size},
                                  "limits": {"maxTableBytes": 100_000}}, source, out)
            # wc -c of the tables: observation 1.1 MB and procedure 0.3 MB pass 100,000 bytes; the other four do not.
            self.assertEqual({item["table"]: item["reason"] for item in result["coverage"]["skippedTables"]},
                             {"fhir_observation": "table_too_large", "fhir_procedure": "table_too_large"})
            self.assertEqual(sorted(path.name for path in out.iterdir()), sorted([item["file"] for item in result["tables"]]),
                             "no partial table and no .part file is left in the output directory")

    def test_a_table_past_the_column_limit_is_skipped(self):
        result, tables = run_bytes(SMART.read_bytes(), "fhir", "zip", limits={"maxColumns": 10})
        # Patient has 10 columns, procedure 9 and encounter 8; condition and medication have 11 and observation 16.
        self.assertEqual(sorted(tables), ["fhir_encounter", "fhir_patient", "fhir_procedure"])
        self.assertEqual({item["table"]: item["reason"] for item in result["coverage"]["skippedTables"]},
                         {name: "too_many_columns" for name in ("fhir_condition", "fhir_observation", "fhir_medication")})


class CommandLine(unittest.TestCase):
    def test_the_container_entry_writes_a_result_and_a_refusal_leaves_no_table(self):
        with tempfile.TemporaryDirectory() as scratch:
            source = pathlib.Path(scratch) / "import.ndjson"
            data = ndjson({"resourceType": "Patient", "id": "a"}, {"resourceType": "Encounter", "id": "e", "subject": {"reference": "Patient/a"}, "period": {"start": "2020-01-01"}})
            source.write_bytes(data)
            out = pathlib.Path(scratch) / "out"
            out.mkdir()
            argv = ["--file", str(source), "--format", "fhir", "--extension", "ndjson", "--expect-sha256", hashlib.sha256(data).hexdigest(),
                    "--expect-bytes", str(len(data)), "--output-dir", str(out), "--deadline", "30"]
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(convert.main(argv), 0)
            result = json.loads((out / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["outcome"], "converted")
            self.assertEqual(result["input"], {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "members": 1, "extension": "ndjson"})
            self.assertEqual(result["converter"]["name"], "evimed-import-convert")
            self.assertEqual({path.name for path in out.iterdir()}, {"result.json", "fhir_patient.csv", "fhir_encounter.csv"})
            # The same call with a wrong digest: refused, and not one table is left for anyone to read.
            bad = argv[:argv.index("--expect-sha256") + 1] + ["f" * 64] + argv[argv.index("--expect-sha256") + 2:]
            self.assertEqual(convert.main(bad), 0)
            result = json.loads((out / "result.json").read_text(encoding="utf-8"))
            self.assertEqual((result["outcome"], result["reason"]), ("refused", "request_invalid"))
            self.assertEqual({path.name for path in out.iterdir()}, {"result.json"})


if __name__ == "__main__":
    unittest.main()
