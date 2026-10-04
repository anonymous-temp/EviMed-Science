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
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import vcr_import_convert as convert  # noqa: E402

FIXTURES = ROOT / "test" / "fixtures" / "vcr_imports"
SMART = FIXTURES / "smart-10-patients.zip"
NJ = FIXTURES / "synthea27nj-5.4.zip"
GIBLEED = FIXTURES / "gibleed-5.3-first150.zip"
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
        # The reduced sample is reproducible from its download by the script that made it.
        reduced = [item for item in manifest["fixtures"] if item.get("derivedFrom")]
        self.assertEqual([item["file"] for item in reduced], ["gibleed-5.3-first150.zip"])
        self.assertTrue((FIXTURES / reduced[0]["derivedFrom"]["script"]).is_file())
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


def csv_zip(tables, *, newline="\n"):
    """A zip of CSV tables from {name: [header, row, ...]} (each row a list), as an OMOP export is."""
    members = {}
    for name, rows in tables.items():
        buffer = io.StringIO()
        csv.writer(buffer, lineterminator=newline).writerows(rows)
        members[name] = buffer.getvalue()
    return zip_bytes(members)


class OmopSynthea(unittest.TestCase):
    """OHDSI Eunomia's Synthea27Nj, CDM 5.4, lowercase headers: 28 persons, 3 deaths, 38 tables."""

    @classmethod
    def setUpClass(cls):
        cls.result, cls.tables = run_bytes(NJ.read_bytes(), "omop", "zip")

    def test_the_tables_have_the_row_counts_the_files_hold(self):
        # awk over each CSV (lines less the header): the seven tables the import reads, and the vocabulary rows they use.
        counts = {name: len(rows) - 1 for name, rows in self.tables.items()}
        self.assertEqual(counts, {"omop_person": 28, "omop_observation_period": 28, "omop_visit_occurrence": 1791, "omop_condition_occurrence": 470,
                                  "omop_drug_exposure": 883, "omop_measurement": 10040, "omop_concept": 306})
        self.assertEqual(self.result["standard"], {"name": "OMOP CDM", "release": "5.4", "vocabulary": "v5.0 09-APR-22*"})
        # 316 distinct concept_ids are used by the carried columns (0 is "no matching concept" and is not looked up); 306 are in the shard.
        self.assertEqual(notices_of(self.result)["concept_ids_not_in_vocabulary"], 10)

    def test_what_the_import_does_not_read_is_named_with_the_rows_it_left(self):
        for name, rows in (("observation", 8099), ("procedure_occurrence", 1649), ("condition_era", 469), ("visit_detail", 1791), ("provider", 67),
                           ("concept_relationship", 266588), ("device_exposure", 1), ("vocabulary", 1)):
            got = coverage_of(self.result, name)
            self.assertEqual((got["status"], got["reason"], got["records"], got["imported"]), ("skipped", "unsupported_table", rows, 0), name)
        listed = {item["kind"] for item in self.result["coverage"]["inputs"]}
        self.assertNotIn("care_site", listed, "an empty table has nothing in it to skip")
        death = coverage_of(self.result, "death")
        self.assertEqual((death["status"], death["records"], death["imported"], death["into"]), ("imported", 3, 3, "omop_person"))
        self.assertEqual(coverage_of(self.result, "measurement")["imported"], 10040)

    def test_follow_up_runs_from_the_observation_period_to_death_or_to_its_end(self):
        persons = {row["person_id"]: row for row in rows_of(self.tables["omop_person"])}
        # awk over PERSON, OBSERVATION_PERIOD and DEATH, and `date` for the day counts.
        self.assertEqual((persons["1"]["year_of_birth"], persons["1"]["age_at_index"], persons["1"]["index_date"], persons["1"]["os_days"], persons["1"]["os_event"], persons["1"]["deceased"]),
                         ("1998", "2", "2000-12-27", "7947", "0", ""))
        self.assertEqual((persons["7"]["age_at_index"], persons["7"]["index_date"], persons["7"]["os_days"], persons["7"]["os_event"], persons["7"]["deceased"]), ("18", "1956-04-17", "23051", "1", "1"))
        self.assertEqual((persons["11"]["age_at_index"], persons["11"]["os_days"], persons["11"]["os_event"]), ("1", "19915", "1"))
        self.assertEqual((persons["23"]["age_at_index"], persons["23"]["os_days"], persons["23"]["os_event"]), ("0", "1190", "1"))
        self.assertEqual(sorted(pid for pid, row in persons.items() if row["os_event"] == "1"), ["11", "23", "7"])
        self.assertEqual(sum(1 for row in persons.values() if row["os_event"] == "0"), 25)
        self.assertEqual(notices_of(self.result).get("follow_up_from_records"), None, "every person has an observation period")

    def test_values_are_carried_as_stated(self):
        measurements = rows_of(self.tables["omop_measurement"])
        weights = [float(row["value_as_number"]) for row in measurements if row["measurement_concept_id"] == "3025315" and row["value_as_number"]]
        self.assertEqual(len(weights), 511)
        self.assertAlmostEqual(sum(weights), 31672.7, places=6)
        self.assertEqual(len([row for row in measurements if not row["value_as_number"]]), 933)
        self.assertEqual(len([row for row in measurements if row["unit_concept_id"] == "9529"]), 511)
        self.assertEqual(rows_of(self.tables["omop_person"])[0]["gender_concept_id"], "8507")
        # The shard's own rows for the concepts the tables use: grep over CONCEPT.csv.
        concept = {row["concept_id"]: row for row in rows_of(self.tables["omop_concept"])}
        self.assertEqual(len(concept), 306)
        self.assertEqual((concept["372328"]["concept_name"], concept["372328"]["vocabulary_id"], concept["372328"]["concept_code"]), ("Otitis media", "SNOMED", "65363002"))
        self.assertEqual((concept["38003564"]["concept_name"], concept["38003564"]["domain_id"]), ("Not Hispanic or Latino", "Ethnicity"))

    def test_nothing_that_identifies_a_person_is_carried(self):
        with tempfile.TemporaryDirectory() as scratch:
            source = pathlib.Path(scratch) / "import.zip"
            source.write_bytes(NJ.read_bytes())
            out = pathlib.Path(scratch) / "out"
            out.mkdir()
            convert.run({"format": "omop", "extension": "zip", "file": {"sha256": hashlib.sha256(NJ.read_bytes()).hexdigest(), "bytes": NJ.stat().st_size}}, source, out)
            everything = "".join(path.read_text(encoding="utf-8") for path in out.iterdir() if path.suffix == ".csv")
            header = (out / "omop_person.csv").read_text(encoding="utf-8").splitlines()[0]
        # The source's own identifier of each person (a GUID in person_source_value), her birth date and the columns that carry them are in nothing it produced,
        # nor is the date of death a column (a date can coincide with another record's, so the columns are what is checked).
        for identifying in ("1007c05b-8d20-8fe6-6790-44622f8316df", "13025201-4834-d1ca-c3ca-38d6614438f1", "birth_datetime", "person_source_value", "month_of_birth", "death_date", "cause_source_value"):
            self.assertNotIn(identifying, everything)
        self.assertNotIn("1998-04-09 00:00:00", everything)
        self.assertEqual(header, "person_id,gender_concept_id,year_of_birth,race_concept_id,ethnicity_concept_id,age_at_index,index_date,deceased,os_days,os_event")

    def test_every_column_states_its_value_source_and_the_map_names_the_subject_and_the_outcome(self):
        for table in self.result["tables"]:
            for column_ in table["columns"]:
                self.assertIn(column_["valueSource"], OWN_COLUMNS)
        calculated = {(item["table"], item["column"]) for item in self.result["fieldMap"] if item["valueSource"] == "calculated"}
        self.assertEqual(calculated, {("omop_person.csv", name) for name in ("age_at_index", "index_date", "os_days", "os_event")})
        keys = sorted(item["table"] for item in self.result["fieldMap"] if item["role"] == "subject_key")
        self.assertEqual(keys, sorted(f"omop_{name}.csv" for name in ("condition_occurrence", "drug_exposure", "measurement", "observation_period", "person", "visit_occurrence")))
        self.assertEqual(entry(self.result, "omop_person", "os_days")["role"], "outcome_time")
        event = entry(self.result, "omop_person", "os_event")
        self.assertEqual((event["parameter"], event["codes"]), ("OS", {"event": ["1"], "censored": ["0"]}))
        self.assertTrue(entry(self.result, "omop_person", "deceased")["outcome"])
        self.assertEqual(entry(self.result, "omop_person", "index_date")["role"], "time_zero")
        # The vocabulary table explains the concept ids; it is not a person's table and has no map entry.
        self.assertFalse([item for item in self.result["fieldMap"] if item["table"] == "omop_concept.csv"])
        self.assertEqual(entry(self.result, "omop_measurement", "unit_concept_id")["codingSystem"], "OMOP Unit concept")
        self.assertEqual({item["column"].split(".")[0] for item in self.result["dictionary"]}, {table["name"] for table in self.result["tables"]})


class OmopGiBleed(unittest.TestCase):
    """GiBleed 5.3.1 reduced to its first 150 persons: uppercase headers, an empty DEATH, observation periods that do not all name a person."""

    @classmethod
    def setUpClass(cls):
        cls.result, cls.tables = run_bytes(GIBLEED.read_bytes(), "omop", "zip")

    def test_counts_and_the_empty_death_table(self):
        counts = {name: len(rows) - 1 for name, rows in self.tables.items()}
        # wc -l and a separate csv reading over the 8 kept tables: 3,536 condition rows, 3,722 drug exposures, 2,503 measurements, 53 visits.
        self.assertEqual(counts, {"omop_person": 150, "omop_observation_period": 150, "omop_visit_occurrence": 53, "omop_condition_occurrence": 3536,
                                  "omop_drug_exposure": 3722, "omop_measurement": 2503, "omop_concept": 191})
        self.assertEqual(self.result["standard"]["release"], "v5.3.1")
        death = coverage_of(self.result, "death")
        self.assertEqual((death["status"], death["reason"], death["records"]), ("skipped", "empty_table", 0))
        persons = rows_of(self.tables["omop_person"])
        self.assertTrue(all(row["deceased"] == "" and row["os_event"] == "0" for row in persons), "no death recorded: every person is censored, and none is called dead or alive")
        self.assertEqual(notices_of(self.result)["death_table_empty"], 1)
        self.assertEqual(notices_of(self.result)["concept_ids_not_in_vocabulary"], 10)
        self.assertEqual(coverage_of(self.result, "procedure_occurrence")["records"], 1807)
        self.assertEqual(coverage_of(self.result, "drug_era")["records"], 2847)

    def test_the_first_person_and_the_uppercase_headers(self):
        first = rows_of(self.tables["omop_person"])[0]
        # PERSON.csv: 6, born 1963-12-31, observation period 1963-12-31 to 2007-02-06 -> age 0, 15,743 days (python's date arithmetic and `date`).
        self.assertEqual((first["person_id"], first["gender_concept_id"], first["year_of_birth"], first["age_at_index"], first["index_date"], first["os_days"], first["os_event"]),
                         ("6", "8532", "1963", "0", "1963-12-31", "15743", "0"))
        counts = Counter(row["gender_concept_id"] for row in rows_of(self.tables["omop_person"]))
        self.assertEqual(dict(counts), {"8532": 78, "8507": 72})


class OmopShapes(unittest.TestCase):
    def test_an_older_export_and_its_quirks_are_read_and_counted(self):
        data = csv_zip({
            "PERSON.csv": [["PERSON_ID", "GENDER_CONCEPT_ID", "YEAR_OF_BIRTH", "RACE_CONCEPT_ID", "TIME_OF_BIRTH"], ["1", "8507", "1970", "8527", "0000"], ["2", "8532", "1980", "", ""],
                           ["1", "8507", "1971", "8527", ""], ["", "8507", "1990", "", ""]],
            "OBSERVATION_PERIOD.csv": [["person_id", "observation_period_start_date", "observation_period_end_date"], ["1", "20100101", "20150101"], ["1", "2016-02-03", "2019-12-31"], ["2", "20100101", "not-a-date"]],
            "DEATH.csv": [["PERSON_ID", "DEATH_DATE"], ["2", "20120505"]],
            "CONDITION_OCCURRENCE.csv": [["person_id", "condition_concept_id", "condition_start_date"], ["1", "201826", "20120101"], ["", "201826", "20120101"], ["9", "201826", "2012-06-07"]],
            "README.txt": ["see the data users guide"],
        })
        result, tables = run_bytes(data, "omop", "zip")
        self.assertEqual(result["outcome"], "converted")
        persons = {row["person_id"]: row for row in rows_of(tables["omop_person"])}
        # Person 1 has two periods: follow-up runs from the first start to the last end. The birth month and day are missing, so age is a year difference.
        self.assertEqual((persons["1"]["index_date"], persons["1"]["age_at_index"], persons["1"]["os_days"], persons["1"]["os_event"]), ("2010-01-01", "40", "3651", "0"))
        # Person 2 died 2012-05-05, 855 days after the start of the period (its end was unreadable, and a death does not need it).
        self.assertEqual((persons["2"]["os_days"], persons["2"]["os_event"], persons["2"]["deceased"]), ("855", "1", "1"))
        self.assertEqual(coverage_of(result, "person")["skipped"], {"duplicate_person_id": 1, "missing_person_id": 1})
        self.assertEqual(coverage_of(result, "condition_occurrence")["skipped"], {"missing_person_id": 1})
        notices = notices_of(result)
        self.assertEqual(notices["date_unreadable"], 1)
        self.assertEqual(notices["age_by_year_difference"], 2)
        self.assertEqual(notices["person_not_in_person_table"], 1)
        self.assertEqual(notices["concept_table_absent"], 1)
        self.assertEqual(notices["cdm_version_undeclared"], 1)
        self.assertEqual(result["standard"]["release"], "undeclared")
        self.assertEqual(coverage_of(result, "README.txt")["reason"], "not_an_omop_table")
        self.assertEqual(rows_of(tables["omop_observation_period"])[2]["observation_period_end_date"], "")
        self.assertEqual(rows_of(tables["omop_condition_occurrence"])[0]["condition_start_date"], "2012-01-01", "YYYYMMDD is the same date")

    def test_a_table_without_what_the_module_needs_of_it_is_skipped_by_name(self):
        data = csv_zip({
            "person.csv": [["person_id", "gender_concept_id", "year_of_birth"], ["1", "8507", "1970"]],
            # The malformed header of a real public export: a column named with its own timestamp.
            "death.csv": [["person_id", "death_date 00:00:00"], ["1", "20120505"]],
            "measurement.csv": [["person_id", "measurement_concept_id", "measurement_date"], ["1", "3025315", "2012-01-01"]],
        })
        result, tables = run_bytes(data, "omop", "zip")
        self.assertEqual(coverage_of(result, "death")["reason"], "missing_required_column:death_date")
        self.assertEqual(rows_of(tables["omop_person"])[0]["deceased"], "", "an unread death table says nothing about death")
        self.assertNotIn("death_table_absent", notices_of(result), "the table is there; it could not be read")
        # No period at all: the index and the end come from the one measurement there is, which is a follow-up of no days, and says so.
        self.assertEqual((notices_of(result)["follow_up_from_records"], notices_of(result)["zero_follow_up"]), (1, 1))

    def test_a_table_of_another_encoding_is_skipped_and_the_others_still_land(self):
        data = zip_bytes({
            "person.csv": "person_id,gender_concept_id,year_of_birth\n1,8507,1970\n",
            "condition_occurrence.csv": "person_id,condition_concept_id,condition_start_date\n1,201826,2012-01-01\n".encode("utf-8") + "\n1,\xe9,2012-01-01\n".encode("latin-1"),
        })
        result, tables = run_bytes(data, "omop", "zip")
        self.assertEqual(sorted(tables), ["omop_person"])
        self.assertEqual(coverage_of(result, "condition_occurrence")["reason"], "text_encoding")
        self.assertEqual(result["tables"][0]["name"], "omop_person")


class OmopRefusals(unittest.TestCase):
    def test_named_refusals(self):
        self.assertEqual(refusal_of(zip_bytes({"patients.csv": "a,b\n1,2\n"}), "omop", "zip"), "not_omop")
        self.assertEqual(refusal_of(zip_bytes({"notes.txt": "hello"}), "omop", "zip"), "not_omop")
        self.assertEqual(refusal_of(zip_bytes({}), "omop", "zip"), "nothing_to_import")
        self.assertEqual(refusal_of(csv_zip({"concept.csv": [["concept_id", "concept_name"], ["1", "x"]], "provider.csv": [["provider_id"], ["1"]]}), "omop", "zip"), "no_supported_table")
        self.assertEqual(refusal_of(csv_zip({"person.csv": [["id", "sex"], ["1", "m"]]}), "omop", "zip"), "nothing_to_import")
        self.assertEqual(refusal_of(b"person_id\n1\n", "omop", "zip"), "not_zip")
        self.assertEqual(refusal_of(b"PK\x03\x04 broken", "omop", "zip"), "corrupt")

    def test_a_table_past_the_planes_limits_is_skipped_by_name_and_the_others_still_land(self):
        result, tables = run_bytes(GIBLEED.read_bytes(), "omop", "zip", limits={"maxRows": 3000})
        self.assertEqual(sorted(tables), ["omop_concept", "omop_measurement", "omop_observation_period", "omop_person", "omop_visit_occurrence"])
        skipped = {item["table"]: item["reason"] for item in result["coverage"]["skippedTables"]}
        self.assertEqual(skipped, {"omop_condition_occurrence": "too_many_rows", "omop_drug_exposure": "too_many_rows"})
        self.assertIn("omop_measurement", tables)


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
