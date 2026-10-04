#!/usr/bin/env python3
"""Standard-format import for 「虚拟临研」: FHIR, OMOP CDM and CDISC ADaM into the
module's own tables, run in a disposable container.

A hospital platform holds its patients as FHIR resources or OMOP tables, a
sponsor as ADaM datasets. The control plane starts this script in the same
bounded, network-less container the record-document extractor uses
(``apps/server/src/vcrIntakeController.mjs``, operation ``convert``): it sees
exactly two paths -- ``/input/import.<ext>``, the one uploaded file, read-only,
and ``/output``, an empty directory -- both inside the VCR data plane's scratch
area, and nothing else: no model, no workspace, no credential, no network. Patient
data is converted here and nowhere else: never in a research runtime, never by the
external parsing service.

What comes out is the module's own shape, and everything about it is stated:

- ``<format>_<table>.csv`` files: one flat table per concept (a person per row, a
  condition per row ...), UTF-8, header row, the standard's own column names.
- ``result.json``: for every table the columns with the value source of each
  (``observed`` for a fact the source system recorded, ``calculated`` for what this
  script computed from other columns, ``imputed`` for a value a declared method
  filled in), a field map (which column is the subject key, which carries the
  arm, the covariates, the outcome pair ...) and a dictionary generated from the
  standard (which concept a column realises, its unit, its code system), and the
  coverage: what was read, what was imported, what was skipped and why, counted.

Hidden knowledge:

- **The script measures and reports; the control plane decides.** Every number in
  the coverage is counted here from the input; ``vcrImport.mjs`` re-checks the
  files against the digests it is told, holds the tables to the plane's limits
  again, and passes every field-map entry through the plane's own validation.
- **Identifiers stay as received and nothing is looked up.** A subject's key is
  the id the source system used (a pseudonym is derived from it by the plane);
  names, addresses, telephone numbers, national and medical-record numbers, free
  text, the date of birth and the date of death are never carried -- the date of
  birth enters only as the year and as the age this script computes from it, the
  death only as a flag and as the follow-up time. A date that tells who a person
  is, once carried, is a column the plane has to exclude from its analysis tables
  by name. Nothing is enriched from outside the file.
- **A derived value says so.** Age and the all-cause follow-up (days from the
  first dated record to death, or to the last dated record when no death is
  recorded) are computed here and are ``calculated``; the follow-up's end is the
  last record in the file, which is not a verified vital status, and the
  dictionary says that. What the source does not state is left blank, never
  filled: absence of a death is not a statement of being alive.
- **Skipped is counted, never silent.** A row with no subject, a table the module
  does not read, a resource type it does not know, a table that would pass the
  plane's row or size limit: each is a named reason with a count. A file that is
  not what it claims to be is refused whole, by name.
- **The archive is read, never unpacked.** A zip is a list of members read one by
  one as streams; nothing is written under the names it carries, nested archives
  are not opened, and the declared unpacked size, the member count and the length
  of a line are bounded before anything is parsed.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import signal
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from vcr_record_extract import Refusal, read_verified  # noqa: E402  (the one verified read of a staged file)

NAME = "evimed-import-convert"
VERSION = "1.0.0"
PROTOCOL = 1
FORMATS = ("fhir",)

OBSERVED = "observed"
CALCULATED = "calculated"
IMPUTED = "imputed"

MAX_MEMBERS = 400
MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024
MAX_LINE_BYTES = 16 * 1024 * 1024
MAX_BUNDLE_BYTES = 32 * 1024 * 1024
DEFAULT_MAX_TABLE_BYTES = 50 * 1024 * 1024
DEFAULT_MAX_ROWS = 2_000_000
DEFAULT_MAX_COLUMNS = 500
# A text cell is one value: control characters are a space, and a cell is cut here.
MAX_CELL_CHARS = 2000



# ---------------------------------------------------------------------------
# Small pieces every format shares
# ---------------------------------------------------------------------------


class Limits:
    """What one table of the module may be: the plane's own ceilings, handed in."""

    def __init__(self, max_table_bytes: int, max_rows: int, max_columns: int) -> None:
        self.max_table_bytes = max_table_bytes
        self.max_rows = max_rows
        self.max_columns = max_columns


_CONTROL = re.compile(r"[\x00-\x08\x0a-\x1f\x7f]")


def cell(value: object) -> str:
    """One CSV cell: text, control characters turned into a space, cut at a sane length."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    text = value if isinstance(value, str) else str(value)
    text = _CONTROL.sub(" ", text).strip()
    return text[:MAX_CELL_CHARS]


def number_text(value: float) -> str:
    """A number as the shortest text that keeps 15 significant digits: SAS's own accuracy, and no 1.0999999999999999."""
    if value != value or value in (float("inf"), float("-inf")):
        return ""
    if value == int(value) and abs(value) < 1e15:
        return str(int(value))
    return ("%.15g" % value)


def as_float(raw: object) -> float:
    """A JSON number, or a numeric string, as a float; anything else is NaN (which `number_text` writes as blank)."""
    if isinstance(raw, bool):
        return float("nan")
    if isinstance(raw, (int, float)):
        return float(raw)
    if isinstance(raw, str):
        try:
            return float(raw.strip())
        except ValueError:
            return float("nan")
    return float("nan")


def column(name: str, source: str, label: str, *, role: str = "other", concept: str = "", unit: str | None = None, coding: str | None = None,
           time_kind: str | None = None, parameter: str | None = None, alias: str | None = None, outcome: bool = False,
           codes: dict | None = None, kind: str | None = None, mapped: bool = True) -> dict:
    """One column of an output table: what it is, where its value comes from, and how the module reads it."""
    return {"name": name, "source": source, "label": label, "role": role, "concept": concept, "unit": unit, "coding": coding,
            "timeKind": time_kind, "parameter": parameter, "alias": alias, "outcome": outcome, "codes": codes, "type": kind, "mapped": mapped}


class TableOut:
    """One output table, written row by row under the plane's own ceilings.

    A table that would pass the row or byte ceiling is not written partially: its
    file is removed and the table is reported skipped by name, so a snapshot is
    never frozen from half a table that reads as the whole.
    """

    def __init__(self, directory: Path, name: str, columns: list[dict], limits: Limits) -> None:
        self.name = name
        self.file = f"{name}.csv"
        self.columns = columns
        self.limits = limits
        self.rows = 0
        self.skipped: Counter = Counter()
        self.overflow: str | None = None
        self._path = directory / f"{self.file}.part"
        self._final = directory / self.file
        names = [item["name"] for item in columns]
        if len(names) > limits.max_columns:
            self.overflow = "too_many_columns"
            self._handle = None
            self._writer = None
            return
        if len(set(names)) != len(names):
            raise Refusal("failed", "duplicate column names in " + name)
        self._handle = open(self._path, "w", encoding="utf-8", newline="")  # noqa: SIM115 - closed in finish()
        self._writer = csv.writer(self._handle, lineterminator="\n")
        self._writer.writerow(names)

    def write(self, row: list[str]) -> None:
        if self.overflow is not None or self._writer is None:
            return
        if self.rows + 1 > self.limits.max_rows:
            self.overflow = "too_many_rows"
            return
        self._writer.writerow(row)
        self.rows += 1
        if self.rows % 2048 == 0 and self._handle is not None:
            self._handle.flush()
            if os.fstat(self._handle.fileno()).st_size > self.limits.max_table_bytes:
                self.overflow = "table_too_large"

    def finish(self) -> dict | None:
        """Close the table. ``None`` when it was not kept (and ``overflow`` says why)."""
        if self._handle is not None:
            self._handle.close()
            if self.overflow is None and self._path.stat().st_size > self.limits.max_table_bytes:
                self.overflow = "table_too_large"
        if self.overflow is not None:
            if self._path.exists():
                self._path.unlink()
            return None
        os.replace(self._path, self._final)
        digest = hashlib.sha256()
        with open(self._final, "rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
        return {"file": self.file, "rows": self.rows, "bytes": self._final.stat().st_size, "sha256": digest.hexdigest()}


class Archive:
    """The staged upload as a list of readable members: the entries of a zip, or the one file itself."""

    def __init__(self, data: bytes, extension: str, limits_members: int = MAX_MEMBERS) -> None:
        self.data = data
        self.extension = extension.lower()
        self.zip: zipfile.ZipFile | None = None
        self.ignored = 0
        self.members: list[dict] = []
        if self.extension == "zip":
            if data[:4] != b"PK\x03\x04":
                raise Refusal("not_zip")
            try:
                archive = zipfile.ZipFile(io.BytesIO(data))
            except zipfile.BadZipFile as error:
                raise Refusal("corrupt", "zip") from error
            infos = archive.infolist()
            if len(infos) > limits_members:
                raise Refusal("corrupt", "members")
            if sum(info.file_size for info in infos) > MAX_UNPACKED_BYTES:
                raise Refusal("too_large", "unpacked size")
            if any(info.flag_bits & 0x1 for info in infos):
                raise Refusal("encrypted")
            self.zip = archive
            for info in infos:
                if info.is_dir():
                    continue
                parts = [part for part in info.filename.replace("\\", "/").split("/") if part]
                base = parts[-1] if parts else ""
                # Archive metadata of the tools that wrote the zip is not data and is not listed.
                if not base or base.startswith("._") or base == ".DS_Store" or "__MACOSX" in parts:
                    self.ignored += 1
                    continue
                self.members.append({"name": base, "size": info.file_size, "info": info})
        else:
            self.members.append({"name": f"import.{self.extension}", "size": len(data), "info": None})

    def open(self, member: dict) -> io.BufferedIOBase:
        if member["info"] is None:
            return io.BytesIO(self.data)
        return self.zip.open(member["info"])  # type: ignore[union-attr]

    def read_all(self, member: dict, limit: int) -> bytes:
        with self.open(member) as stream:
            body = stream.read(limit + 1)
        if len(body) > limit:
            raise Refusal("too_large", member["name"])
        return body


def read_lines(stream: io.BufferedIOBase):
    """Binary lines of a stream, each at most MAX_LINE_BYTES; a longer one is yielded as ``None`` and drained."""
    while True:
        line = stream.readline(MAX_LINE_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_LINE_BYTES and not line.endswith(b"\n"):
            while True:
                rest = stream.readline(MAX_LINE_BYTES)
                if not rest or rest.endswith(b"\n"):
                    break
            yield None
            continue
        yield line


_FULL_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")


def day(text: object) -> date | None:
    """The calendar date a FHIR or OMOP date text states in full, else None. Time and zone are not read."""
    found = _FULL_DATE.match(text.strip()) if isinstance(text, str) else None
    if not found:
        return None
    try:
        return date(int(found.group(1)), int(found.group(2)), int(found.group(3)))
    except ValueError:
        return None


def date_cell(text: object, notices: Counter) -> str:
    """A date as the date part of what was written (zone untouched). A partial date (a year, a month) is kept as written."""
    if not isinstance(text, str) or not text.strip():
        return ""
    value = text.strip()
    if day(value) is not None:
        return value[:10]
    if re.fullmatch(r"\d{4}(-\d{2})?", value):
        notices["partial_date"] += 1
        return value
    notices["date_unreadable"] += 1
    return ""


def completed_years(born: date, at: date) -> int:
    years = at.year - born.year - ((at.month, at.day) < (born.month, born.day))
    return years


class Coverage:
    """What was read, imported and skipped, counted. The control plane prints it next to the tables."""

    def __init__(self) -> None:
        self.inputs: list[dict] = []
        self.skipped_tables: list[dict] = []
        self.notices: Counter = Counter()
        self.notice_detail: dict[str, list[str]] = defaultdict(list)

    def add_input(self, kind: str, records: int | None, imported: int, status: str, reason: str | None = None, skipped: Counter | None = None) -> None:
        entry: dict = {"kind": kind, "records": records, "imported": imported, "status": status}
        if reason:
            entry["reason"] = reason
        if skipped:
            entry["skipped"] = dict(sorted(skipped.items()))
        self.inputs.append(entry)

    def notice(self, code: str, count: int = 1, example: str | None = None) -> None:
        self.notices[code] += count
        if example and len(self.notice_detail[code]) < 5:
            self.notice_detail[code].append(example)

    def as_json(self) -> dict:
        return {
            "inputs": self.inputs, "skippedTables": self.skipped_tables,
            "notices": [{"code": code, "count": count, **({"examples": self.notice_detail[code]} if self.notice_detail.get(code) else {})}
                        for code, count in sorted(self.notices.items())],
        }


def entry_of(table_file: str, spec: dict) -> dict:
    """A column's field-map entry, in the keys the plane's own validation reads."""
    entry: dict = {"table": table_file, "column": spec["name"], "role": spec["role"], "valueSource": spec["source"]}
    if spec["concept"]:
        entry["concept"] = spec["concept"][:80]
    if spec["unit"]:
        entry["unit"] = str(spec["unit"])[:32]
    if spec["coding"]:
        entry["codingSystem"] = str(spec["coding"])[:40]
    if spec["timeKind"]:
        entry["timeKind"] = spec["timeKind"]
    if spec["parameter"]:
        entry["parameter"] = spec["parameter"]
    if spec["alias"]:
        entry["alias"] = spec["alias"]
    if spec["type"]:
        entry["type"] = spec["type"]
    if spec["outcome"]:
        entry["outcome"] = True
    if spec["codes"]:
        entry["codes"] = spec["codes"]
    return entry


def dictionary_of(table: str, spec: dict) -> dict:
    """A dictionary row: `table.column`, what it realises, its code system and its value source."""
    label = spec["label"]
    if spec["coding"]:
        label = f"{label} [{spec['coding']}]"
    return {"column": f"{table}.{spec['name']}", "label": f"{label} · {spec['source']}"[:120], "unit": str(spec["unit"] or "")[:32]}


# ---------------------------------------------------------------------------
# HL7 FHIR R4
# ---------------------------------------------------------------------------

FHIR_SUPPORTED = ("Patient", "Condition", "Observation", "MedicationRequest", "MedicationStatement", "Procedure", "Encounter")
FHIR_TABLE_OF = {
    "Condition": "fhir_condition", "Observation": "fhir_observation", "MedicationRequest": "fhir_medication",
    "MedicationStatement": "fhir_medication", "Procedure": "fhir_procedure", "Encounter": "fhir_encounter",
}
US_CORE_RACE = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-race"
US_CORE_ETHNICITY = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity"
FHIR_CODING = "FHIR Coding (system, code)"

FHIR_PATIENT_COLUMNS = [
    column("patient_id", OBSERVED, "Patient.id, as the source system issued it", role="subject_key", concept="Subject identifier"),
    column("gender", OBSERVED, "Patient.gender", role="covariate", concept="Sex (administrative gender)", coding="FHIR administrative-gender", alias="SEX"),
    column("birth_year", CALCULATED, "Year of Patient.birthDate (the date itself is not carried)", role="covariate", concept="Year of birth", unit="year",
           alias="BRTHYR", kind="integer"),
    column("race", OBSERVED, "US Core race extension, ombCategory display", role="covariate", concept="Race", coding="US Core OMB race", alias="RACE"),
    column("ethnicity", OBSERVED, "US Core ethnicity extension, ombCategory display", role="covariate", concept="Ethnicity", coding="US Core OMB ethnicity", alias="ETHNIC"),
    column("age_at_index", CALCULATED, "Completed years from Patient.birthDate to the first dated record", role="covariate", concept="Age at index date", unit="years",
           alias="AGE", kind="number"),
    column("first_record_date", CALCULATED, "Earliest dated record of the patient in the imported tables (the index date)", role="time_zero",
           concept="Index date", time_kind="occurred_at", kind="date"),
    column("deceased", OBSERVED, "1 for Patient.deceasedDateTime or deceasedBoolean true, 0 for deceasedBoolean false, blank when not stated", role="covariate",
           concept="Death recorded", alias="DTHFL", outcome=True),
    column("os_days", CALCULATED, "Days from the first dated record to death, or to the last dated record when no death is recorded", role="outcome_time",
           concept="All-cause follow-up time", unit="days", parameter="OS", kind="integer"),
    column("os_event", CALCULATED, "1 when a death is recorded, 0 when follow-up ends at the last record; the last record is not a verified vital status",
           role="outcome_event", concept="All-cause death", parameter="OS", codes={"event": ["1"], "censored": ["0"]}),
]


def _coded(prefix: str, extra: list[dict] | None = None) -> list[dict]:
    """The three columns every coded resource carries for its code."""
    return [
        column(f"{prefix}code_system", OBSERVED, "The system of the first coding of the code", concept="Code system", mapped=False),
        column(f"{prefix}code", OBSERVED, "The code of the first coding", concept="Code", coding=FHIR_CODING),
        column(f"{prefix}display", OBSERVED, "The display of the first coding, else the text of the code", concept="Code display", mapped=False),
        *(extra or []),
    ]


FHIR_CONDITION_COLUMNS = [
    column("condition_id", OBSERVED, "Condition.id", concept="Condition identifier", mapped=False),
    column("patient_id", OBSERVED, "Condition.subject, the Patient id", role="subject_key", concept="Subject identifier"),
    *_coded(""),
    column("clinical_status", OBSERVED, "Condition.clinicalStatus, first coding code", concept="Clinical status"),
    column("verification_status", OBSERVED, "Condition.verificationStatus, first coding code", concept="Verification status"),
    column("onset_date", OBSERVED, "Condition.onsetDateTime or onsetPeriod.start", concept="Onset date", time_kind="occurred_at", kind="date"),
    column("abatement_date", OBSERVED, "Condition.abatementDateTime or abatementPeriod.end", concept="Abatement date", time_kind="occurred_at", kind="date"),
    column("recorded_date", OBSERVED, "Condition.recordedDate", concept="Recorded date", time_kind="recorded_at", kind="date"),
    column("encounter_id", OBSERVED, "Condition.encounter, the Encounter id", concept="Encounter identifier", mapped=False),
]
FHIR_OBSERVATION_COLUMNS = [
    column("observation_id", OBSERVED, "Observation.id", concept="Observation identifier", mapped=False),
    column("patient_id", OBSERVED, "Observation.subject, the Patient id", role="subject_key", concept="Subject identifier"),
    column("category", OBSERVED, "Observation.category, first coding code", concept="Observation category"),
    *_coded(""),
    column("component_code", OBSERVED, "Observation.component.code, first coding code (blank on the observation's own value)", concept="Component code", coding=FHIR_CODING),
    column("component_display", OBSERVED, "Observation.component.code display", concept="Component display", mapped=False),
    column("effective_date", OBSERVED, "Observation.effectiveDateTime, effectivePeriod.start or effectiveInstant", concept="Effective date", time_kind="occurred_at", kind="date"),
    column("value_type", OBSERVED, "The value[x] type the observation carries (Quantity, CodeableConcept, ...)", concept="Value type"),
    column("value_number", OBSERVED, "valueQuantity.value or valueInteger, as stated (no unit conversion)", concept="Numeric value", kind="number"),
    column("value_comparator", OBSERVED, "valueQuantity.comparator (<, <=, >=, >)", concept="Value comparator"),
    column("value_unit", OBSERVED, "valueQuantity.code (the UCUM code), else its unit text", concept="Unit of the value", coding="UCUM"),
    column("value_text", OBSERVED, "valueCodeableConcept display, valueString or valueBoolean", concept="Text value", mapped=False),
    column("status", OBSERVED, "Observation.status", concept="Observation status"),
    column("encounter_id", OBSERVED, "Observation.encounter, the Encounter id", concept="Encounter identifier", mapped=False),
]
FHIR_MEDICATION_COLUMNS = [
    column("medication_id", OBSERVED, "MedicationRequest.id or MedicationStatement.id", concept="Medication record identifier", mapped=False),
    column("patient_id", OBSERVED, "The subject Patient id", role="subject_key", concept="Subject identifier"),
    column("resource_type", OBSERVED, "MedicationRequest or MedicationStatement", concept="Resource type"),
    *_coded(""),
    column("status", OBSERVED, "The resource's status", concept="Medication status"),
    column("intent", OBSERVED, "MedicationRequest.intent (blank for a statement)", concept="Request intent"),
    column("start_date", OBSERVED, "MedicationRequest.authoredOn, or MedicationStatement.effectiveDateTime / effectivePeriod.start", concept="Start date",
           time_kind="occurred_at", kind="date"),
    column("end_date", OBSERVED, "MedicationStatement.effectivePeriod.end, or MedicationRequest.dispenseRequest.validityPeriod.end", concept="End date",
           time_kind="occurred_at", kind="date"),
    column("encounter_id", OBSERVED, "The encounter's id", concept="Encounter identifier", mapped=False),
]
FHIR_PROCEDURE_COLUMNS = [
    column("procedure_id", OBSERVED, "Procedure.id", concept="Procedure identifier", mapped=False),
    column("patient_id", OBSERVED, "Procedure.subject, the Patient id", role="subject_key", concept="Subject identifier"),
    *_coded(""),
    column("status", OBSERVED, "Procedure.status", concept="Procedure status"),
    column("performed_start", OBSERVED, "Procedure.performedDateTime or performedPeriod.start", concept="Performed start", time_kind="occurred_at", kind="date"),
    column("performed_end", OBSERVED, "Procedure.performedPeriod.end", concept="Performed end", time_kind="occurred_at", kind="date"),
    column("encounter_id", OBSERVED, "Procedure.encounter, the Encounter id", concept="Encounter identifier", mapped=False),
]
FHIR_ENCOUNTER_COLUMNS = [
    column("encounter_id", OBSERVED, "Encounter.id", concept="Encounter identifier", mapped=False),
    column("patient_id", OBSERVED, "Encounter.subject, the Patient id", role="subject_key", concept="Subject identifier"),
    column("class_code", OBSERVED, "Encounter.class.code", concept="Encounter class", coding="HL7 v3 ActCode"),
    column("type_code", OBSERVED, "Encounter.type, first coding code", concept="Encounter type", coding=FHIR_CODING),
    column("type_display", OBSERVED, "Encounter.type, first coding display", concept="Encounter type display", mapped=False),
    column("status", OBSERVED, "Encounter.status", concept="Encounter status"),
    column("period_start", OBSERVED, "Encounter.period.start", concept="Period start", time_kind="occurred_at", kind="date"),
    column("period_end", OBSERVED, "Encounter.period.end", concept="Period end", time_kind="occurred_at", kind="date"),
]
FHIR_COLUMNS = {
    "fhir_patient": FHIR_PATIENT_COLUMNS, "fhir_condition": FHIR_CONDITION_COLUMNS, "fhir_observation": FHIR_OBSERVATION_COLUMNS,
    "fhir_medication": FHIR_MEDICATION_COLUMNS, "fhir_procedure": FHIR_PROCEDURE_COLUMNS, "fhir_encounter": FHIR_ENCOUNTER_COLUMNS,
}
FHIR_OBSERVATION_VALUES = ("Quantity", "Integer", "CodeableConcept", "String", "Boolean")


def first_coding(concept: object) -> tuple[str, str, str]:
    """(system, code, display) of the first coding that has a code; the concept's own text when no coding names a display."""
    if not isinstance(concept, dict):
        return "", "", ""
    text = concept.get("text") if isinstance(concept.get("text"), str) else ""
    for coding in concept.get("coding") or []:
        if isinstance(coding, dict) and coding.get("code") not in (None, ""):
            return cell(coding.get("system")), cell(coding.get("code")), cell(coding.get("display") or text)
    return "", "", cell(text)


def reference_id(reference: object, resource_type: str, full_urls: dict[str, str] | None = None) -> str:
    """The id a reference to `resource_type` names: `Patient/1`, `.../Patient/1/_history/2`, or a bundle's `urn:uuid:`. A display is never read."""
    value = reference.get("reference") if isinstance(reference, dict) else None
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if full_urls and value in full_urls:
        return full_urls[value]
    if value.startswith("urn:uuid:"):
        return value[len("urn:uuid:"):]
    segments = [segment for segment in value.split("/") if segment]
    for index in range(len(segments) - 2, -1, -1):
        if segments[index] == resource_type:
            return segments[index + 1]
    return ""


def extension_display(resource: dict, url: str) -> str:
    """The OMB category display of a US Core race or ethnicity extension."""
    for extension in resource.get("extension") or []:
        if isinstance(extension, dict) and extension.get("url") == url:
            for inner in extension.get("extension") or []:
                if isinstance(inner, dict) and inner.get("url") == "ombCategory":
                    coding = inner.get("valueCoding")
                    if isinstance(coding, dict):
                        return cell(coding.get("display") or coding.get("code"))
    return ""


class FhirImport:
    """One FHIR import: resources in, six flat tables and a patient roll-up out."""

    def __init__(self, directory: Path, limits: Limits, coverage: Coverage) -> None:
        self.directory = directory
        self.limits = limits
        self.coverage = coverage
        self.tables: dict[str, TableOut] = {}
        self.patients: dict[str, dict] = {}
        self.span: dict[str, list[date]] = {}
        self.referenced: set[str] = set()
        self.types: dict[str, Counter] = defaultdict(Counter)
        self.skipped: dict[str, Counter] = defaultdict(Counter)
        self.units: dict[str, set[str]] = defaultdict(set)
        self.value_not_carried: Counter = Counter()
        self.date_notices: Counter = Counter()
        self.parsed_lines = 0
        self.bad_lines = 0
        self.non_json = 0
        self.no_value = 0

    # -- the tables --------------------------------------------------------

    def table(self, name: str) -> TableOut:
        if name not in self.tables:
            self.tables[name] = TableOut(self.directory, name, FHIR_COLUMNS[name], self.limits)
        return self.tables[name]

    def seen(self, patient_id: str, *dates: date | None) -> None:
        """A record of this patient was written: the roll-up's first and last date, when it has one."""
        self.referenced.add(patient_id)
        stamps = [stamp for stamp in dates if stamp is not None]
        if not stamps:
            return
        span = self.span.get(patient_id)
        if span is None:
            self.span[patient_id] = [min(stamps), max(stamps)]
        else:
            span[0] = min(span[0], *stamps)
            span[1] = max(span[1], *stamps)

    # -- one resource ------------------------------------------------------

    def resource(self, item: object, full_urls: dict[str, str] | None = None) -> None:
        if not isinstance(item, dict) or not isinstance(item.get("resourceType"), str):
            self.bad_lines += 1
            return
        kind = item["resourceType"]
        if kind == "Bundle":
            self.bundle(item)
            return
        self.parsed_lines += 1
        counter = self.types[kind]
        counter["read"] += 1
        if kind not in FHIR_SUPPORTED:
            return
        if kind == "Patient":
            self.patient(item, counter)
            return
        patient = reference_id(item.get("subject") or item.get("patient"), "Patient", full_urls)
        if not patient:
            counter["skipped"] += 1
            self.skipped[kind]["no_patient_reference"] += 1
            return
        getattr(self, "_" + kind.lower())(item, patient, counter)

    def bundle(self, item: dict) -> None:
        entries = [entry for entry in (item.get("entry") or []) if isinstance(entry, dict) and isinstance(entry.get("resource"), dict)]
        full_urls = {str(entry["fullUrl"]): str(entry["resource"].get("id", "")) for entry in entries
                     if isinstance(entry.get("fullUrl"), str) and entry["resource"].get("resourceType") == "Patient"}
        for entry in entries:
            self.resource(entry["resource"], full_urls)

    def patient(self, item: dict, counter: Counter) -> None:
        patient_id = cell(item.get("id"))
        if not patient_id:
            counter["skipped"] += 1
            self.skipped["Patient"]["no_id"] += 1
            return
        if patient_id in self.patients:
            counter["skipped"] += 1
            self.skipped["Patient"]["duplicate_patient_id"] += 1
            return
        counter["imported"] += 1
        deceased_time = item.get("deceasedDateTime")
        deceased_flag = item.get("deceasedBoolean")
        self.patients[patient_id] = {
            "gender": cell(item.get("gender")),
            "birth": item.get("birthDate") if isinstance(item.get("birthDate"), str) else "",
            "race": extension_display(item, US_CORE_RACE),
            "ethnicity": extension_display(item, US_CORE_ETHNICITY),
            "death": date_cell(deceased_time, self.date_notices) if isinstance(deceased_time, str) else "",
            "deceased": deceased_flag if isinstance(deceased_flag, bool) else None,
            "deceased_time": isinstance(deceased_time, str) and bool(deceased_time.strip()),
        }

    def _condition(self, item: dict, patient: str, counter: Counter) -> None:
        onset = item.get("onsetDateTime") or (item.get("onsetPeriod") or {}).get("start")
        abatement = item.get("abatementDateTime") or (item.get("abatementPeriod") or {}).get("end")
        row = {
            "onset": date_cell(onset, self.date_notices), "abatement": date_cell(abatement, self.date_notices),
            "recorded": date_cell(item.get("recordedDate"), self.date_notices),
        }
        system, code, display = first_coding(item.get("code"))
        self.table("fhir_condition").write([
            cell(item.get("id")), patient, system, code, display, first_coding(item.get("clinicalStatus"))[1],
            first_coding(item.get("verificationStatus"))[1], row["onset"], row["abatement"], row["recorded"],
            reference_id(item.get("encounter"), "Encounter"),
        ])
        counter["imported"] += 1
        self.seen(patient, *(day(row[key]) for key in ("onset", "abatement", "recorded")))

    def _observation(self, item: dict, patient: str, counter: Counter) -> None:
        effective = item.get("effectiveDateTime") or (item.get("effectivePeriod") or {}).get("start") or item.get("effectiveInstant")
        when = date_cell(effective, self.date_notices)
        system, code, display = first_coding(item.get("code"))
        category = ""
        for entry in item.get("category") or []:
            category = first_coding(entry)[1]
            if category:
                break
        out = self.table("fhir_observation")
        base = [cell(item.get("id")), patient, category, system, code, display]
        tail = [cell(item.get("status")), reference_id(item.get("encounter"), "Encounter")]
        rows = 0

        def emit(component: dict | None, source: dict) -> None:
            nonlocal rows
            value_type, number, comparator, unit, text = self.value_of(source)
            if not value_type:
                self.no_value += 1
            comp = first_coding(component.get("code")) if component else ("", "", "")
            out.write([*base, comp[1], comp[2] if component else "", when, value_type, number, comparator, unit, text, *tail])
            rows += 1
            if unit:
                self.units[f"{system}|{code}|{comp[1]}"].add(unit)

        components = [entry for entry in (item.get("component") or []) if isinstance(entry, dict)]
        own = any(key.startswith("value") for key in item)
        if own or not components:
            emit(None, item)
        for component in components:
            emit(component, component)
        counter["imported"] += 1
        self.seen(patient, day(when))

    def value_of(self, source: dict) -> tuple[str, str, str, str, str]:
        """(value_type, number, comparator, unit, text) of a value[x]; a type this table cannot hold is named and counted, not guessed."""
        for key in sorted(key for key in source if key.startswith("value") and key != "valueSet"):
            kind = key[5:]
            value = source[key]
            if kind == "Quantity" and isinstance(value, dict):
                number = number_text(as_float(value.get("value")))
                if not number:
                    self.value_not_carried["Quantity_without_value"] += 1
                unit = cell(value.get("code") or value.get("unit"))
                return kind, number, cell(value.get("comparator")), unit, ""
            if kind == "Integer" and isinstance(value, int) and not isinstance(value, bool):
                return kind, str(value), "", "", ""
            if kind == "CodeableConcept":
                return kind, "", "", "", first_coding(value)[2] or first_coding(value)[1]
            if kind == "String" and isinstance(value, str):
                return kind, "", "", "", cell(value)
            if kind == "Boolean" and isinstance(value, bool):
                return kind, "", "", "", "true" if value else "false"
            self.value_not_carried[kind or "unknown"] += 1
            return kind, "", "", "", ""
        return "", "", "", "", ""

    def _medicationrequest(self, item: dict, patient: str, counter: Counter) -> None:
        dispense = item.get("dispenseRequest") if isinstance(item.get("dispenseRequest"), dict) else {}
        validity = dispense.get("validityPeriod") if isinstance(dispense.get("validityPeriod"), dict) else {}
        self._medication(item, patient, counter, "MedicationRequest", item.get("authoredOn"), validity.get("end"))

    def _medicationstatement(self, item: dict, patient: str, counter: Counter) -> None:
        period = item.get("effectivePeriod") if isinstance(item.get("effectivePeriod"), dict) else {}
        self._medication(item, patient, counter, "MedicationStatement", item.get("effectiveDateTime") or period.get("start"), period.get("end"))

    def _medication(self, item: dict, patient: str, counter: Counter, kind: str, start: object, end: object) -> None:
        system, code, display = first_coding(item.get("medicationCodeableConcept"))
        if not code:
            # A medication by reference (or in a later release's shape) is not resolved: the Medication resource is not read.
            counter["skipped"] += 1
            self.skipped[kind]["medication_not_coded"] += 1
            return
        begins, ends = date_cell(start, self.date_notices), date_cell(end, self.date_notices)
        self.table("fhir_medication").write([
            cell(item.get("id")), patient, kind, system, code, display, cell(item.get("status")), cell(item.get("intent")), begins, ends,
            reference_id(item.get("encounter") or item.get("context"), "Encounter"),
        ])
        counter["imported"] += 1
        self.seen(patient, day(begins), day(ends))

    def _procedure(self, item: dict, patient: str, counter: Counter) -> None:
        period = item.get("performedPeriod") if isinstance(item.get("performedPeriod"), dict) else {}
        begins = date_cell(item.get("performedDateTime") or period.get("start"), self.date_notices)
        ends = date_cell(period.get("end"), self.date_notices)
        system, code, display = first_coding(item.get("code"))
        self.table("fhir_procedure").write([
            cell(item.get("id")), patient, system, code, display, cell(item.get("status")), begins, ends, reference_id(item.get("encounter"), "Encounter"),
        ])
        counter["imported"] += 1
        self.seen(patient, day(begins), day(ends))

    def _encounter(self, item: dict, patient: str, counter: Counter) -> None:
        period = item.get("period") if isinstance(item.get("period"), dict) else {}
        begins, ends = date_cell(period.get("start"), self.date_notices), date_cell(period.get("end"), self.date_notices)
        types = item.get("type") or []
        _, type_code, type_display = first_coding(types[0]) if types and isinstance(types[0], dict) else ("", "", "")
        klass = item.get("class") if isinstance(item.get("class"), dict) else {}
        self.table("fhir_encounter").write([
            cell(item.get("id")), patient, cell(klass.get("code")), type_code, type_display, cell(item.get("status")), begins, ends,
        ])
        counter["imported"] += 1
        self.seen(patient, day(begins), day(ends))

    # -- the members of the upload -----------------------------------------

    def member(self, archive: Archive, member: dict) -> None:
        name = member["name"]
        lower = name.lower()
        if lower.endswith((".ndjson", ".jsonl")):
            before = (self.parsed_lines, self.bad_lines)
            with archive.open(member) as stream:
                first = True
                for line in read_lines(stream):
                    if line is None:
                        self.bad_lines += 1
                        self.coverage.notice("line_too_long")
                        continue
                    if first:
                        line = line.lstrip(b"\xef\xbb\xbf")
                        first = False
                    if not line.strip():
                        continue
                    try:
                        parsed_line = json.loads(line)
                    except (ValueError, RecursionError):
                        self.bad_lines += 1
                        self.non_json += 1
                        continue
                    self.resource(parsed_line)
            parsed, bad = self.parsed_lines - before[0], self.bad_lines - before[1]
            if not parsed:
                self.coverage.add_input(name, bad, 0, "skipped", "not_fhir_resources")
            return
        if lower.endswith(".json"):
            if member["size"] > MAX_BUNDLE_BYTES:
                self.coverage.add_input(name, None, 0, "skipped", "bundle_too_large")
                return
            try:
                body = json.loads(archive.read_all(member, MAX_BUNDLE_BYTES))
            except (ValueError, RecursionError):
                self.bad_lines += 1
                self.non_json += 1
                self.coverage.add_input(name, None, 0, "skipped", "not_json")
                return
            before = self.parsed_lines
            self.resource(body)
            if self.parsed_lines == before:
                self.coverage.add_input(name, None, 0, "skipped", "not_fhir_resources")
            return
        self.coverage.add_input(name, None, 0, "skipped", "not_a_fhir_file")

    # -- the roll-up and the answer ----------------------------------------

    def finish_patients(self) -> None:
        table = self.table("fhir_patient")
        ahead = Counter()
        for patient_id, info in self.patients.items():
            span = self.span.get(patient_id)
            first, last = (span[0], span[1]) if span else (None, None)
            born = day(info["birth"])
            birth_year = ""
            age = ""
            if info["birth"]:
                year = re.match(r"^\d{4}", info["birth"])
                birth_year = year.group(0) if year else ""
            if born is not None and first is not None:
                age = str(completed_years(born, first))
            elif birth_year and first is not None:
                age = str(first.year - int(birth_year))
                self.coverage.notice("age_by_year_difference")
            death = day(info["death"])
            os_days = ""
            event = ""
            if first is not None:
                if death is not None:
                    if death < first:
                        self.coverage.notice("death_before_first_record")
                    else:
                        os_days, event = str((death - first).days), "1"
                        if last is not None and last > death:
                            ahead["records_after_death"] += 1
                elif info["deceased"] is True or (info["deceased_time"] and death is None):
                    self.coverage.notice("death_date_unknown")
                elif last is not None:
                    os_days, event = str((last - first).days), "0"
                    if os_days == "0":
                        self.coverage.notice("zero_follow_up")
            else:
                self.coverage.notice("no_dated_record")
            deceased = "1" if (death is not None or info["deceased"] is True or info["deceased_time"]) else ("0" if info["deceased"] is False else "")
            table.write([patient_id, info["gender"], birth_year, info["race"], info["ethnicity"], age, first.isoformat() if first else "",
                         deceased, os_days, event])
        for code, count in ahead.items():
            self.coverage.notice(code, count)

    def run(self, archive: Archive) -> None:
        for member in archive.members:
            self.member(archive, member)
        if not self.parsed_lines:
            # Nothing was a FHIR resource: say whether it was JSON at all.
            raise Refusal("not_fhir" if self.bad_lines > self.non_json else "not_json" if self.non_json else "nothing_to_import")
        if not any(self.types[kind]["read"] for kind in FHIR_SUPPORTED):
            raise Refusal("no_supported_resource")
        if self.patients:
            self.finish_patients()
        outside = self.referenced - set(self.patients)
        if outside:
            self.coverage.notice("patient_not_in_file", len(outside))
        for kind in sorted(self.types):
            counter = self.types[kind]
            if kind in FHIR_SUPPORTED:
                self.coverage.add_input(kind, counter["read"], counter["imported"], "imported" if counter["imported"] else "skipped",
                                        None if counter["imported"] else "all_rows_skipped", self.skipped.get(kind))
            else:
                self.coverage.add_input(kind, counter["read"], 0, "skipped", "unsupported_resource_type")
        if self.bad_lines:
            self.coverage.notice("lines_not_resources", self.bad_lines)
        if self.no_value:
            self.coverage.notice("observation_without_value", self.no_value)
        for key, count in sorted(self.value_not_carried.items()):
            self.coverage.notice(f"value_not_carried:{key}", count)
        for key, count in sorted(self.date_notices.items()):
            self.coverage.notice(key, count)
        mixed = sorted(key for key, units in self.units.items() if len(units) > 1)
        if mixed:
            self.coverage.notice("mixed_units", len(mixed), ", ".join(mixed[:3]))


STANDARDS = {"fhir": {"name": "HL7 FHIR", "release": "R4"}}


def convert_fhir(archive: Archive, directory: Path, limits: Limits, coverage: Coverage) -> tuple[list[TableOut], dict]:
    importer = FhirImport(directory, limits, coverage)
    importer.run(archive)
    order = [name for name in FHIR_COLUMNS if name in importer.tables]
    return [importer.tables[name] for name in order], dict(STANDARDS["fhir"])


CONVERTERS = {"fhir": convert_fhir}


# ---------------------------------------------------------------------------
# The container's entry
# ---------------------------------------------------------------------------


def _libraries() -> dict:
    return {"python": "%d.%d.%d" % sys.version_info[:3]}


def build_result(form: str, archive: Archive, tables: list[TableOut], standard: dict, coverage: Coverage, input_meta: dict) -> dict:
    kept: list[dict] = []
    entries: list[dict] = []
    dictionary: list[dict] = []
    for table in tables:
        done = table.finish()
        if done is None:
            coverage.skipped_tables.append({"table": table.name, "reason": table.overflow or "not_kept"})
            continue
        kept.append({
            **done, "name": table.name,
            "columns": [{"name": spec["name"], "valueSource": spec["source"], "label": spec["label"], "unit": spec["unit"] or "", "codingSystem": spec["coding"] or ""}
                        for spec in table.columns],
            **({"skipped": dict(sorted(table.skipped.items()))} if table.skipped else {}),
        })
        for spec in table.columns:
            dictionary.append(dictionary_of(table.name, spec))
            if spec["mapped"]:
                entries.append(entry_of(table.file, spec))
    if not kept:
        raise Refusal("nothing_to_import")
    return {
        "protocol": PROTOCOL, "outcome": "converted",
        "converter": {"name": NAME, "version": VERSION, "libraries": _libraries()},
        "format": form, "standard": standard, "input": input_meta,
        "tables": kept, "fieldMap": entries, "dictionary": dictionary, "coverage": coverage.as_json(),
    }


def run(request: dict, source: Path, output_dir: Path) -> dict:
    data = read_verified(source, request.get("file") or {})
    form = str(request.get("format") or "")
    if form not in CONVERTERS:
        raise Refusal("request_invalid", "format")
    extension = str(request.get("extension") or "").lower()
    if not re.fullmatch(r"[a-z0-9]{1,8}", extension):
        raise Refusal("request_invalid", "extension")
    limits_in = request.get("limits") or {}
    limits = Limits(int(limits_in.get("maxTableBytes", DEFAULT_MAX_TABLE_BYTES)), int(limits_in.get("maxRows", DEFAULT_MAX_ROWS)),
                    int(limits_in.get("maxColumns", DEFAULT_MAX_COLUMNS)))
    archive = Archive(data, extension)
    coverage = Coverage()
    if archive.ignored:
        coverage.notice("archive_metadata_ignored", archive.ignored)
    tables, standard = CONVERTERS[form](archive, output_dir, limits, coverage)
    input_meta = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "members": len(archive.members), "extension": extension}
    return build_result(form, archive, tables, standard, coverage, input_meta)


def _write_result(output_dir: Path, result: dict) -> None:
    (output_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, sort_keys=True), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--file", required=True, help="the one staged file, bound read-only")
    parser.add_argument("--format", required=True, choices=list(FORMATS))
    parser.add_argument("--extension", required=True, help="the staged file's extension (zip, ndjson, json, ...)")
    parser.add_argument("--expect-sha256", required=True)
    parser.add_argument("--expect-bytes", required=True, type=int)
    parser.add_argument("--max-table-bytes", type=int, default=DEFAULT_MAX_TABLE_BYTES)
    parser.add_argument("--max-rows", type=int, default=DEFAULT_MAX_ROWS)
    parser.add_argument("--max-columns", type=int, default=DEFAULT_MAX_COLUMNS)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--deadline", type=int, default=0, help="seconds after which the script ends itself (0 = none)")
    args = parser.parse_args(argv)
    output_dir = Path(args.output_dir)
    base = {"protocol": PROTOCOL, "converter": {"name": NAME, "version": VERSION, "libraries": _libraries()}}

    def on_alarm(_signal: int, _frame: object) -> None:
        raise Refusal("deadline")

    if args.deadline > 0 and hasattr(signal, "SIGALRM"):
        signal.signal(signal.SIGALRM, on_alarm)
        signal.alarm(args.deadline)
    try:
        request = {
            "format": args.format, "extension": args.extension, "file": {"sha256": args.expect_sha256, "bytes": args.expect_bytes},
            "limits": {"maxTableBytes": args.max_table_bytes, "maxRows": args.max_rows, "maxColumns": args.max_columns},
        }
        result = run(request, Path(args.file), output_dir)
    except Refusal as refusal:
        result = {**base, "outcome": "refused", "reason": refusal.reason, "format": args.format}
    except MemoryError:
        result = {**base, "outcome": "refused", "reason": "memory", "format": args.format}
    except Exception as error:  # noqa: BLE001 - the control plane is told the class, never the message (it may quote the data)
        result = {**base, "outcome": "refused", "reason": "failed", "errorClass": type(error).__name__, "format": args.format}
    finally:
        if args.deadline > 0 and hasattr(signal, "SIGALRM"):
            signal.alarm(0)
    if result.get("outcome") == "refused":
        # A refused import leaves no table behind: nothing partial is for the control plane to read.
        for leftover in output_dir.glob("*.csv*"):
            leftover.unlink(missing_ok=True)
    _write_result(output_dir, result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
