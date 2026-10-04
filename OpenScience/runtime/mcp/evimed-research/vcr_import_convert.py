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
import struct
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from vcr_record_extract import Refusal, read_verified  # noqa: E402  (the one verified read of a staged file)

NAME = "evimed-import-convert"
VERSION = "1.0.0"
PROTOCOL = 1
FORMATS = ("fhir", "omop", "adam")

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
            # A zip is a local file header, or the end record alone (an archive with nothing in it).
            if data[:4] not in (b"PK\x03\x04", b"PK\x05\x06"):
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

    def add_input(self, kind: str, records: int | None, imported: int, status: str, reason: str | None = None, skipped: Counter | None = None,
                  into: str | None = None) -> None:
        entry: dict = {"kind": kind, "records": records, "imported": imported, "status": status}
        if reason:
            entry["reason"] = reason
        if into:
            entry["into"] = into
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
    if spec.get("identifier"):
        entry["identifier"] = True
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


# ---------------------------------------------------------------------------
# OHDSI OMOP CDM 5.3 / 5.4
# ---------------------------------------------------------------------------

OMOP_SUPPORTED = ("person", "observation_period", "visit_occurrence", "condition_occurrence", "drug_exposure", "measurement", "death")
# The other tables of the CDM (5.3 and 5.4): known by name, so a zip of them is an OMOP export that this import does not read in full,
# and a zip of nothing else is not an OMOP export at all.
OMOP_OTHER_TABLES = frozenset({
    "attribute_definition", "care_site", "cdm_source", "cohort", "cohort_attribute", "cohort_definition", "concept", "concept_ancestor", "concept_class",
    "concept_relationship", "concept_synonym", "condition_era", "cost", "device_exposure", "domain", "dose_era", "drug_era", "drug_strength", "episode",
    "episode_event", "fact_relationship", "location", "metadata", "note", "note_nlp", "observation", "payer_plan_period", "procedure_occurrence",
    "provider", "relationship", "source_to_concept_map", "specimen", "visit_detail", "vocabulary",
})
OMOP_REQUIRED = {
    "person": ("person_id", "gender_concept_id", "year_of_birth"),
    "observation_period": ("person_id", "observation_period_start_date", "observation_period_end_date"),
    "death": ("person_id", "death_date"),
    "visit_occurrence": ("person_id", "visit_concept_id", "visit_start_date"),
    "condition_occurrence": ("person_id", "condition_concept_id", "condition_start_date"),
    "drug_exposure": ("person_id", "drug_concept_id", "drug_exposure_start_date"),
    "measurement": ("person_id", "measurement_concept_id", "measurement_date"),
}
OMOP_CODING = "OMOP concept_id"
OMOP_TYPE = "OMOP Type Concept"
CONCEPT_COLUMNS = ("concept_id", "concept_name", "domain_id", "vocabulary_id", "concept_class_id", "standard_concept", "concept_code")


def _concept(name: str, label: str, concept: str, *, coding: str = OMOP_CODING, **extra) -> dict:
    return column(name, OBSERVED, label, concept=concept, coding=coding, **extra)


OMOP_COLUMNS = {
    "omop_person": [
        column("person_id", OBSERVED, "person.person_id, as the source system issued it", role="subject_key", concept="Subject identifier"),
        column("gender_concept_id", OBSERVED, "person.gender_concept_id", role="covariate", concept="Sex (gender concept)", coding="OMOP Gender concept", alias="SEX"),
        column("year_of_birth", OBSERVED, "person.year_of_birth (month, day and birth_datetime are not carried)", role="covariate", concept="Year of birth", unit="year",
               alias="BRTHYR", kind="integer"),
        column("race_concept_id", OBSERVED, "person.race_concept_id", role="covariate", concept="Race (concept)", coding="OMOP Race concept", alias="RACE"),
        column("ethnicity_concept_id", OBSERVED, "person.ethnicity_concept_id", role="covariate", concept="Ethnicity (concept)", coding="OMOP Ethnicity concept", alias="ETHNIC"),
        column("age_at_index", CALCULATED, "Completed years from the birth date to the index date; the year difference when the birth date is incomplete", role="covariate",
               concept="Age at index date", unit="years", alias="AGE", kind="number"),
        column("index_date", CALCULATED, "The start of the earliest observation period (else the earliest dated record) of the person", role="time_zero",
               concept="Index date", time_kind="occurred_at", kind="date"),
        column("deceased", OBSERVED, "1 when the person has a row in the death table, blank when not (no death row is not a statement of being alive)", role="covariate",
               concept="Death recorded", alias="DTHFL", outcome=True),
        column("os_days", CALCULATED, "Days from the index date to death, or to the end of the last observation period when no death is recorded", role="outcome_time",
               concept="All-cause follow-up time", unit="days", parameter="OS", kind="integer"),
        column("os_event", CALCULATED, "1 when a death is recorded, 0 when follow-up ends at the observation period's end; that end is not a verified vital status",
               role="outcome_event", concept="All-cause death", parameter="OS", codes={"event": ["1"], "censored": ["0"]}),
    ],
    "omop_observation_period": [
        column("observation_period_id", OBSERVED, "observation_period.observation_period_id", concept="Observation period identifier", mapped=False),
        column("person_id", OBSERVED, "observation_period.person_id", role="subject_key", concept="Subject identifier"),
        column("observation_period_start_date", OBSERVED, "observation_period.observation_period_start_date", concept="Observation period start", time_kind="occurred_at", kind="date"),
        column("observation_period_end_date", OBSERVED, "observation_period.observation_period_end_date", concept="Observation period end", time_kind="occurred_at", kind="date"),
        _concept("period_type_concept_id", "observation_period.period_type_concept_id: where the period was derived from", "Period provenance", coding=OMOP_TYPE),
    ],
    "omop_visit_occurrence": [
        column("visit_occurrence_id", OBSERVED, "visit_occurrence.visit_occurrence_id", concept="Visit identifier", mapped=False),
        column("person_id", OBSERVED, "visit_occurrence.person_id", role="subject_key", concept="Subject identifier"),
        _concept("visit_concept_id", "visit_occurrence.visit_concept_id", "Visit type"),
        column("visit_start_date", OBSERVED, "visit_occurrence.visit_start_date", concept="Visit start", time_kind="occurred_at", kind="date"),
        column("visit_end_date", OBSERVED, "visit_occurrence.visit_end_date", concept="Visit end", time_kind="occurred_at", kind="date"),
        _concept("visit_type_concept_id", "visit_occurrence.visit_type_concept_id: where the visit was recorded", "Visit provenance", coding=OMOP_TYPE),
    ],
    "omop_condition_occurrence": [
        column("condition_occurrence_id", OBSERVED, "condition_occurrence.condition_occurrence_id", concept="Condition record identifier", mapped=False),
        column("person_id", OBSERVED, "condition_occurrence.person_id", role="subject_key", concept="Subject identifier"),
        _concept("condition_concept_id", "condition_occurrence.condition_concept_id", "Condition"),
        column("condition_start_date", OBSERVED, "condition_occurrence.condition_start_date", concept="Condition start", time_kind="occurred_at", kind="date"),
        column("condition_end_date", OBSERVED, "condition_occurrence.condition_end_date", concept="Condition end", time_kind="occurred_at", kind="date"),
        _concept("condition_type_concept_id", "condition_occurrence.condition_type_concept_id: where the condition was recorded", "Condition provenance", coding=OMOP_TYPE),
        _concept("condition_status_concept_id", "condition_occurrence.condition_status_concept_id (5.3 and later)", "Condition status"),
        column("visit_occurrence_id", OBSERVED, "condition_occurrence.visit_occurrence_id", concept="Visit identifier", mapped=False),
    ],
    "omop_drug_exposure": [
        column("drug_exposure_id", OBSERVED, "drug_exposure.drug_exposure_id", concept="Drug exposure identifier", mapped=False),
        column("person_id", OBSERVED, "drug_exposure.person_id", role="subject_key", concept="Subject identifier"),
        _concept("drug_concept_id", "drug_exposure.drug_concept_id", "Drug"),
        column("drug_exposure_start_date", OBSERVED, "drug_exposure.drug_exposure_start_date", concept="Exposure start", time_kind="occurred_at", kind="date"),
        column("drug_exposure_end_date", OBSERVED, "drug_exposure.drug_exposure_end_date", concept="Exposure end", time_kind="occurred_at", kind="date"),
        _concept("drug_type_concept_id", "drug_exposure.drug_type_concept_id: where the exposure was recorded", "Drug provenance", coding=OMOP_TYPE),
        column("quantity", OBSERVED, "drug_exposure.quantity", concept="Quantity", kind="number"),
        column("days_supply", OBSERVED, "drug_exposure.days_supply", concept="Days supply", unit="days", kind="number"),
        _concept("route_concept_id", "drug_exposure.route_concept_id", "Route"),
        column("visit_occurrence_id", OBSERVED, "drug_exposure.visit_occurrence_id", concept="Visit identifier", mapped=False),
    ],
    "omop_measurement": [
        column("measurement_id", OBSERVED, "measurement.measurement_id", concept="Measurement identifier", mapped=False),
        column("person_id", OBSERVED, "measurement.person_id", role="subject_key", concept="Subject identifier"),
        _concept("measurement_concept_id", "measurement.measurement_concept_id", "Measurement"),
        column("measurement_date", OBSERVED, "measurement.measurement_date", concept="Measurement date", time_kind="occurred_at", kind="date"),
        _concept("measurement_type_concept_id", "measurement.measurement_type_concept_id: where the measurement was recorded", "Measurement provenance", coding=OMOP_TYPE),
        _concept("operator_concept_id", "measurement.operator_concept_id (<, <=, =, >=, >)", "Value operator"),
        column("value_as_number", OBSERVED, "measurement.value_as_number, as stated (no unit conversion)", concept="Numeric value", kind="number"),
        _concept("value_as_concept_id", "measurement.value_as_concept_id", "Coded value"),
        _concept("unit_concept_id", "measurement.unit_concept_id", "Unit", coding="OMOP Unit concept"),
        column("unit_source_value", OBSERVED, "measurement.unit_source_value: the unit as the source wrote it", concept="Unit text", coding="UCUM"),
        column("range_low", OBSERVED, "measurement.range_low", concept="Reference range, low", kind="number"),
        column("range_high", OBSERVED, "measurement.range_high", concept="Reference range, high", kind="number"),
        column("visit_occurrence_id", OBSERVED, "measurement.visit_occurrence_id", concept="Visit identifier", mapped=False),
    ],
    "omop_concept": [
        column("concept_id", OBSERVED, "concept.concept_id", concept="Concept identifier", mapped=False),
        column("concept_name", OBSERVED, "concept.concept_name", concept="Concept name", mapped=False),
        column("domain_id", OBSERVED, "concept.domain_id", concept="Domain", mapped=False),
        column("vocabulary_id", OBSERVED, "concept.vocabulary_id", concept="Vocabulary", mapped=False),
        column("concept_class_id", OBSERVED, "concept.concept_class_id", concept="Concept class", mapped=False),
        column("standard_concept", OBSERVED, "concept.standard_concept", concept="Standard concept flag", mapped=False),
        column("concept_code", OBSERVED, "concept.concept_code, the code in its vocabulary", concept="Concept code", mapped=False),
    ],
}
# Which carried columns hold a concept_id the lookup table explains.
OMOP_CONCEPT_COLUMNS = {
    "omop_person": ("gender_concept_id", "race_concept_id", "ethnicity_concept_id"),
    "omop_observation_period": ("period_type_concept_id",),
    "omop_visit_occurrence": ("visit_concept_id", "visit_type_concept_id"),
    "omop_condition_occurrence": ("condition_concept_id", "condition_type_concept_id", "condition_status_concept_id"),
    "omop_drug_exposure": ("drug_concept_id", "drug_type_concept_id", "route_concept_id"),
    "omop_measurement": ("measurement_concept_id", "measurement_type_concept_id", "operator_concept_id", "value_as_concept_id", "unit_concept_id"),
}
# The columns of the long tables read from the source, and which of them are dates and numbers (normalised, not interpreted).
OMOP_DATE_COLUMNS = frozenset({"observation_period_start_date", "observation_period_end_date", "visit_start_date", "visit_end_date", "condition_start_date",
                               "condition_end_date", "drug_exposure_start_date", "drug_exposure_end_date", "measurement_date"})
OMOP_NUMBER_COLUMNS = frozenset({"quantity", "days_supply", "value_as_number", "range_low", "range_high"})
OMOP_TABLE_OF = {name[len("omop_"):]: name for name in OMOP_COLUMNS if name != "omop_concept"}
_OMOP_DATE = re.compile(r"^(\d{4})-?(\d{2})-?(\d{2})(?!\d)")


def omop_date(value: object, notices: Counter) -> str:
    """An OMOP date as ISO: `2020-01-31`, a datetime's date part, or the `YYYYMMDD` an older export writes. Anything else is blank and counted."""
    text_value = value.strip() if isinstance(value, str) else ""
    if not text_value:
        return ""
    found = _OMOP_DATE.match(text_value)
    if found:
        try:
            return date(int(found.group(1)), int(found.group(2)), int(found.group(3))).isoformat()
        except ValueError:
            pass
    notices["date_unreadable"] += 1
    return ""


def omop_number(value: object, notices: Counter) -> str:
    text_value = value.strip() if isinstance(value, str) else ""
    if not text_value:
        return ""
    parsed = as_float(text_value)
    if parsed != parsed:
        notices["number_unreadable"] += 1
        return ""
    return number_text(parsed) if abs(parsed) < 1e15 else text_value


class CsvTable:
    """One CSV member of a zip as rows keyed by lower-cased header names."""

    def __init__(self, archive: Archive, member: dict) -> None:
        self.archive = archive
        self.member = member

    def rows(self):
        """Yield (header, row) pairs; raise `Refusal("text_encoding")` on bytes that are not UTF-8."""
        csv.field_size_limit(MAX_CELL_CHARS * 64)
        with self.archive.open(self.member) as stream:
            wrapper = io.TextIOWrapper(stream, encoding="utf-8-sig", newline="")
            reader = csv.reader(wrapper)
            try:
                header = next(reader, None)
                if header is None:
                    return
                names = [name.strip().lower() for name in header]
                for row in reader:
                    if not row:
                        continue
                    yield names, row
            except UnicodeDecodeError as error:
                raise Refusal("text_encoding", self.member["name"]) from error
            except csv.Error as error:
                raise Refusal("corrupt", "csv") from error

    def header(self) -> list[str]:
        for names, _ in self.rows():
            return names
        # An empty table still has a header line.
        with self.archive.open(self.member) as stream:
            first = stream.readline(MAX_LINE_BYTES).decode("utf-8-sig", "replace")
        return [name.strip().lower() for name in next(csv.reader([first]), [])]


class OmopImport:
    def __init__(self, directory: Path, limits: Limits, coverage: Coverage) -> None:
        self.directory = directory
        self.limits = limits
        self.coverage = coverage
        self.tables: dict[str, TableOut] = {}
        self.dates: Counter = Counter()
        self.persons: dict[str, dict] = {}
        self.periods: dict[str, list[date | None]] = {}
        self.deaths: dict[str, str] = {}
        self.span: dict[str, list[date]] = {}
        self.referenced: set[str] = set()
        self.concepts: set[str] = set()
        self.skipped: dict[str, Counter] = defaultdict(Counter)
        self.read: Counter = Counter()
        self.kept: Counter = Counter()
        self.failed: set[str] = set()
        self.from_records = 0
        self.version = ""
        self.vocabulary = ""

    def table(self, name: str) -> TableOut:
        if name not in self.tables:
            self.tables[name] = TableOut(self.directory, name, OMOP_COLUMNS[name], self.limits)
        return self.tables[name]

    def seen(self, person_id: str, *dates: date | None) -> None:
        self.referenced.add(person_id)
        stamps = [stamp for stamp in dates if stamp is not None]
        if not stamps:
            return
        span = self.span.get(person_id)
        if span is None:
            self.span[person_id] = [min(stamps), max(stamps)]
        else:
            span[0] = min(span[0], *stamps)
            span[1] = max(span[1], *stamps)

    def usable(self, name: str, csv_table: CsvTable) -> list[str] | None:
        """The table's header when it carries what the module needs of it; else None, with the missing column named."""
        try:
            header = csv_table.header()
        except Refusal as refusal:
            if refusal.reason != "text_encoding":
                raise
            self.coverage.add_input(name, None, 0, "skipped", "text_encoding")
            return None
        missing = [column_name for column_name in OMOP_REQUIRED[name] if column_name not in header]
        if missing:
            self.coverage.add_input(name, None, 0, "skipped", f"missing_required_column:{missing[0]}")
            return None
        return header

    # -- one table ---------------------------------------------------------

    def read_person(self, csv_table: CsvTable) -> None:
        counter = self.skipped["person"]
        for names, row in csv_table.rows():
            self.read["person"] += 1
            get = lambda key: row[names.index(key)].strip() if key in names and names.index(key) < len(row) else ""  # noqa: E731
            person_id = cell(get("person_id"))
            if not person_id:
                counter["missing_person_id"] += 1
                continue
            if person_id in self.persons:
                counter["duplicate_person_id"] += 1
                continue
            self.persons[person_id] = {
                "gender": cell(get("gender_concept_id")), "year": get("year_of_birth"), "month": get("month_of_birth"), "day": get("day_of_birth"),
                "datetime": get("birth_datetime"), "race": cell(get("race_concept_id")), "ethnicity": cell(get("ethnicity_concept_id")),
            }
            self.kept["person"] += 1
            for key in ("gender_concept_id", "race_concept_id", "ethnicity_concept_id"):
                if get(key):
                    self.concepts.add(cell(get(key)))

    def read_period(self, csv_table: CsvTable) -> None:
        counter = self.skipped["observation_period"]
        out = self.table("omop_observation_period")
        for names, row in csv_table.rows():
            self.read["observation_period"] += 1
            get = lambda key: row[names.index(key)].strip() if key in names and names.index(key) < len(row) else ""  # noqa: E731
            person_id = cell(get("person_id"))
            if not person_id:
                counter["missing_person_id"] += 1
                continue
            begins, ends = omop_date(get("observation_period_start_date"), self.dates), omop_date(get("observation_period_end_date"), self.dates)
            out.write([cell(get("observation_period_id")), person_id, begins, ends, cell(get("period_type_concept_id"))])
            self.kept["observation_period"] += 1
            self.referenced.add(person_id)
            # The index is the earliest readable start and the end of follow-up the latest readable end, each on its own.
            start, end = day(begins), day(ends)
            held = self.periods.setdefault(person_id, [None, None])
            if start is not None:
                held[0] = start if held[0] is None else min(held[0], start)
            if end is not None:
                held[1] = end if held[1] is None else max(held[1], end)
            if get("period_type_concept_id"):
                self.concepts.add(cell(get("period_type_concept_id")))

    def read_death(self, csv_table: CsvTable) -> None:
        counter = self.skipped["death"]
        for names, row in csv_table.rows():
            self.read["death"] += 1
            get = lambda key: row[names.index(key)].strip() if key in names and names.index(key) < len(row) else ""  # noqa: E731
            person_id = cell(get("person_id"))
            if not person_id:
                counter["missing_person_id"] += 1
                continue
            if person_id in self.deaths:
                counter["duplicate_death_row"] += 1
                continue
            when = omop_date(get("death_date"), self.dates)
            if not when:
                counter["death_date_unreadable"] += 1
                continue
            self.deaths[person_id] = when
            self.kept["death"] += 1

    def read_long(self, name: str, csv_table: CsvTable) -> None:
        """A condition, drug, measurement or visit table, row by row: the carried columns, dates and numbers normalised."""
        output = OMOP_TABLE_OF[name]
        out = self.table(output)
        wanted = [spec["name"] for spec in OMOP_COLUMNS[output]]
        counter = self.skipped[name]
        concept_columns = OMOP_CONCEPT_COLUMNS.get(output, ())
        for names, row in csv_table.rows():
            self.read[name] += 1
            at = {key: names.index(key) for key in wanted if key in names}
            person_id = cell(row[at["person_id"]]) if at["person_id"] < len(row) else ""
            if not person_id:
                counter["missing_person_id"] += 1
                continue
            cells = []
            stamps = []
            for key in wanted:
                raw = row[at[key]] if key in at and at[key] < len(row) else ""
                if key in OMOP_DATE_COLUMNS:
                    value = omop_date(raw, self.dates)
                    stamps.append(day(value))
                elif key in OMOP_NUMBER_COLUMNS:
                    value = omop_number(raw, self.dates)
                else:
                    value = cell(raw)
                if key in concept_columns and value:
                    self.concepts.add(value)
                cells.append(value)
            out.write(cells)
            self.kept[name] += 1
            self.seen(person_id, *stamps)

    # -- the roll-up -------------------------------------------------------

    def finish_persons(self) -> None:
        out = self.table("omop_person")
        for person_id, info in self.persons.items():
            period = self.periods.get(person_id) or [None, None]
            span = self.span.get(person_id) or [None, None]
            index = period[0] if period[0] is not None else span[0]
            end = period[1] if period[1] is not None else span[1]
            if (period[0] is None or period[1] is None) and span[0] is not None:
                self.from_records += 1
            born = None
            year = re.match(r"^\d{4}$", info["year"])
            if year and info["month"].isdigit() and info["day"].isdigit():
                try:
                    born = date(int(info["year"]), int(info["month"]), int(info["day"]))
                except ValueError:
                    born = None
            if born is None and info["datetime"]:
                born = day(info["datetime"])
            age = ""
            if index is not None:
                if born is not None:
                    age = str(completed_years(born, index))
                elif year:
                    age = str(index.year - int(info["year"]))
                    self.coverage.notice("age_by_year_difference")
            death = day(self.deaths.get(person_id, ""))
            os_days = event = ""
            if index is None:
                self.coverage.notice("no_dated_record")
            elif death is not None:
                if death < index:
                    self.coverage.notice("death_before_index")
                else:
                    os_days, event = str((death - index).days), "1"
            elif end is not None and end >= index:
                os_days, event = str((end - index).days), "0"
                if os_days == "0":
                    self.coverage.notice("zero_follow_up")
            else:
                self.coverage.notice("follow_up_before_index")
            out.write([person_id, info["gender"], info["year"] if year else "", info["race"], info["ethnicity"], age, index.isoformat() if index else "",
                       "1" if person_id in self.deaths else "", os_days, event])

    def write_concepts(self, archive: Archive, member: dict | None) -> None:
        if member is None:
            self.coverage.notice("concept_table_absent")
            return
        used = {value for value in self.concepts if value and value != "0"}
        out = self.table("omop_concept")
        found: set[str] = set()
        try:
            for names, row in CsvTable(archive, member).rows():
                at = {key: names.index(key) for key in CONCEPT_COLUMNS if key in names}
                if "concept_id" not in at or at["concept_id"] >= len(row):
                    break
                concept_id = row[at["concept_id"]].strip()
                if concept_id in used and concept_id not in found:
                    found.add(concept_id)
                    out.write([cell(row[at[key]]) if key in at and at[key] < len(row) else "" for key in CONCEPT_COLUMNS])
        except Refusal as refusal:
            if refusal.reason != "text_encoding":
                raise
            out.overflow = "text_encoding"
            self.coverage.notice("concept_table_unreadable")
            return
        missing = used - found
        if missing:
            self.coverage.notice("concept_ids_not_in_vocabulary", len(missing))

    # -- the members of the upload -----------------------------------------

    def version_of(self, archive: Archive, member: dict) -> None:
        try:
            for names, row in CsvTable(archive, member).rows():
                get = lambda key: row[names.index(key)].strip() if key in names and names.index(key) < len(row) else ""  # noqa: E731
                self.version = cell(get("cdm_version"))[:30]
                self.vocabulary = cell(get("vocabulary_version"))[:40]
                break
        except Refusal as refusal:
            if refusal.reason != "text_encoding":
                raise
            self.coverage.notice("cdm_source_unreadable")

    def run(self, archive: Archive) -> dict:
        by_name: dict[str, dict] = {}
        other: list[dict] = []
        for member in archive.members:
            base = member["name"].lower()
            if base.endswith(".csv") and base[:-4] in OMOP_SUPPORTED + tuple(OMOP_OTHER_TABLES):
                by_name[base[:-4]] = member
            else:
                other.append(member)
        if not by_name:
            raise Refusal("not_omop" if other or archive.members else "nothing_to_import")
        if not any(name in by_name for name in OMOP_SUPPORTED):
            for name, member in sorted(by_name.items()):
                self.coverage.add_input(name, self.count_rows(archive, member), 0, "skipped", "unsupported_table")
            raise Refusal("no_supported_table")
        if "cdm_source" in by_name:
            self.version_of(archive, by_name["cdm_source"])
        usable: dict[str, list[str]] = {}
        for name in OMOP_SUPPORTED:
            if name in by_name:
                header = self.usable(name, CsvTable(archive, by_name[name]))
                if header is not None:
                    usable[name] = header
        reads = {"person": self.read_person, "observation_period": self.read_period, "death": self.read_death}
        for name in ("person", "observation_period", "death"):
            if name in usable:
                self.guarded(name, lambda csv_table, fn=reads[name]: fn(csv_table), archive, by_name[name])
        for name in ("visit_occurrence", "condition_occurrence", "drug_exposure", "measurement"):
            if name in usable:
                self.guarded(name, lambda csv_table, key=name: self.read_long(key, csv_table), archive, by_name[name])
        if "person" in by_name and "person" in usable and self.persons:
            self.finish_persons()
        elif "person" not in usable:
            self.coverage.notice("person_table_absent")
        outside = self.referenced - set(self.persons)
        if self.persons and outside:
            self.coverage.notice("person_not_in_person_table", len(outside))
        if self.from_records:
            self.coverage.notice("follow_up_from_records", self.from_records)
        if "death" not in by_name:
            self.coverage.notice("death_table_absent")
        elif not self.read["death"]:
            self.coverage.notice("death_table_empty")
        self.write_concepts(archive, by_name.get("concept"))
        for name in OMOP_SUPPORTED:
            if name not in by_name:
                continue
            if name not in usable or name in self.failed:
                continue
            into = "omop_person" if name == "death" else None
            produced = self.kept[name]
            reason = None if produced else ("empty_table" if not self.read[name] else "all_rows_skipped")
            self.coverage.add_input(name, self.read[name], produced, "imported" if produced else "skipped", reason, self.skipped.get(name), into=into)
        for name, member in sorted(by_name.items()):
            if name in OMOP_SUPPORTED or name == "concept" or name == "cdm_source":
                continue
            rows = self.count_rows(archive, member)
            # An empty table has nothing in it to skip: it is not listed.
            if rows != 0:
                self.coverage.add_input(name, rows, 0, "skipped", "unsupported_table")
        for member in other:
            self.coverage.add_input(member["name"], None, 0, "skipped", "not_an_omop_table")
        for key, count in sorted(self.dates.items()):
            self.coverage.notice(key, count)
        if self.version and not re.match(r"^v?5\.[34]", self.version):
            self.coverage.notice("cdm_version_not_tested", 1, self.version)
        elif not self.version:
            self.coverage.notice("cdm_version_undeclared")
        return {"name": "OMOP CDM", "release": self.version or "undeclared", **({"vocabulary": self.vocabulary} if self.vocabulary else {})}

    def guarded(self, name: str, work, archive: Archive, member: dict) -> None:
        """Read one table; bytes that are not UTF-8 skip that table by name and leave the others."""
        try:
            work(CsvTable(archive, member))
        except Refusal as refusal:
            if refusal.reason != "text_encoding":
                raise
            self.coverage.add_input(name, None, 0, "skipped", "text_encoding")
            target = self.tables.get(OMOP_TABLE_OF.get(name, f"omop_{name}"))
            if target is not None:
                target.overflow = "text_encoding"
            # What a half-read table contributed to the roll-up goes with it.
            {"person": self.persons, "observation_period": self.periods, "death": self.deaths}.get(name, {}).clear()
            self.read[name] = 0
            self.kept[name] = 0
            self.failed.add(name)

    def count_rows(self, archive: Archive, member: dict) -> int | None:
        """Data rows of a table this import does not read: counted, so the coverage can say how much was left."""
        if member["size"] > 300 * 1024 * 1024:
            return None
        try:
            total = 0
            for _ in CsvTable(archive, member).rows():
                total += 1
            return total
        except Refusal:
            return None


def convert_omop(archive: Archive, directory: Path, limits: Limits, coverage: Coverage) -> tuple[list[TableOut], dict]:
    importer = OmopImport(directory, limits, coverage)
    standard = importer.run(archive)
    order = [name for name in OMOP_COLUMNS if name in importer.tables]
    return [importer.tables[name] for name in order], standard


# ---------------------------------------------------------------------------
# CDISC ADaM in SAS transport (XPORT v5) files
# ---------------------------------------------------------------------------

XPT_RECORD = 80
XPT_NAMESTR = 140
MAX_XPT_BYTES = 192 * 1024 * 1024
XPT_LIBRARY = b"HEADER RECORD*******LIBRARY HEADER RECORD!!!!!!!"
XPT_LIBRARY_V8 = (b"HEADER RECORD*******LIBV8   HEADER RECORD!!!!!!!", b"HEADER RECORD*******LIB8    HEADER RECORD!!!!!!!")
XPT_MEMBER = b"HEADER RECORD*******MEMBER  HEADER RECORD!!!!!!!"
XPT_NAMESTR_HEADER = b"HEADER RECORD*******NAMESTR HEADER RECORD!!!!!!!"
XPT_OBS_HEADER = b"HEADER RECORD*******OBS     HEADER RECORD!!!!!!!"
SAS_EPOCH = date(1960, 1, 1)
# A missing numeric is one of these first bytes with every other byte zero: `.`, `._` and `.A` to `.Z`.
XPT_MISSING_FIRST = frozenset(b"._ABCDEFGHIJKLMNOPQRSTUVWXYZ")
DATE_FORMATS = ("DATE", "DDMMYY", "MMDDYY", "YYMMDD", "E8601DA", "B8601DA", "MONYY", "WORDDATE", "WEEKDATE", "JULIAN")
DATETIME_FORMATS = ("DATETIME", "E8601DT", "B8601DT", "DATEAMPM")
TIME_FORMATS = ("TIME", "TIMEAMPM", "E8601TM", "B8601TM", "HHMM")
ADAM_DATASETS = ("ADSL", "ADTTE", "ADAE")
ADAM_REQUIRED = {"ADSL": ("USUBJID",), "ADTTE": ("USUBJID", "PARAMCD", "AVAL", "CNSR"), "ADAE": ("USUBJID",)}
PARAMETER = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,31}$")
# ADaM's direct identifiers by the standard's own names: carried as received, never used as data.
ADAM_IDENTIFIERS = frozenset({"BRTHDTC", "BRTHDT", "SUBJID"})
# Post-baseline outcome variables of ADSL by the standard's own names: the death flag and date are sealed with the outcome pair.
ADAM_OUTCOME_COVARIATES = frozenset({"DTHFL", "DTHDT"})
ADAM_COVARIATES = (("AGE", "Age"), ("SEX", "Sex"), ("RACE", "Race"), ("ETHNIC", "Ethnicity"))


class XptVariable:
    def __init__(self, ntype: int, length: int, number: int, name: str, label: str, fmt: str, position: int) -> None:
        self.numeric = ntype == 1
        self.length = length
        self.number = number
        self.name = name
        self.label = label
        self.format = fmt
        self.position = position


class XptDataset:
    def __init__(self, name: str, label: str, variables: list[XptVariable], body: memoryview, row_length: int, rows: int) -> None:
        self.name = name
        self.label = label
        self.variables = variables
        self.body = body
        self.row_length = row_length
        self.rows = rows


def ibm_to_float(raw: bytes) -> float | None | str:
    """One IBM-370 floating point value of 2-8 bytes: a float, None for `.`, or the missing code (`A` for `.A`) for a special missing."""
    padded = raw + b"\x00" * (8 - len(raw))
    first = padded[0]
    if first in XPT_MISSING_FIRST and not any(padded[1:]):
        return None if first == 0x2E else chr(first)
    if not any(padded):
        return 0.0
    sign = -1.0 if first & 0x80 else 1.0
    exponent = (first & 0x7F) - 64
    fraction = int.from_bytes(padded[1:], "big")
    return sign * (fraction / float(1 << 56)) * (16.0 ** exponent)


def _text(raw: bytes) -> str:
    return raw.decode("ascii", "replace").strip()


def parse_xpt(data: bytes) -> list[XptDataset]:
    """The datasets of a SAS transport (V5) file, as views over its bytes; anything else is a named refusal."""
    if len(data) < XPT_RECORD * 6:
        raise Refusal("not_xpt")
    if data.startswith(XPT_LIBRARY_V8):
        raise Refusal("xpt_version_unsupported", "V8")
    if not data.startswith(XPT_LIBRARY):
        raise Refusal("not_xpt")
    view = memoryview(data)
    datasets: list[XptDataset] = []
    at = XPT_RECORD * 3
    while at + XPT_RECORD <= len(data):
        record = data[at:at + XPT_RECORD]
        if not record.startswith(XPT_MEMBER):
            if not record.strip(b" \x00"):
                break
            raise Refusal("corrupt", "member header")
        namestr_length = record[75:78]
        if not namestr_length.isdigit() or int(namestr_length) != XPT_NAMESTR:
            raise Refusal("xpt_version_unsupported", "namestr length")
        # member header, descriptor header, the member's name record, its second record, then the NAMESTR header
        at += XPT_RECORD * 2
        name_record = data[at:at + XPT_RECORD]
        second = data[at + XPT_RECORD:at + 2 * XPT_RECORD]
        at += XPT_RECORD * 2
        header = data[at:at + XPT_RECORD]
        if not header.startswith(XPT_NAMESTR_HEADER) or len(second) < XPT_RECORD:
            raise Refusal("corrupt", "namestr header")
        count_text = header[54:58]
        if not count_text.isdigit():
            raise Refusal("corrupt", "variable count")
        count = int(count_text)
        at += XPT_RECORD
        end = at + count * XPT_NAMESTR
        if count < 1 or end > len(data):
            raise Refusal("corrupt", "variables")
        variables: list[XptVariable] = []
        for index in range(count):
            raw = data[at + index * XPT_NAMESTR:at + (index + 1) * XPT_NAMESTR]
            ntype, _hfun, length, number = struct.unpack(">hhhh", raw[:8])
            position = struct.unpack(">l", raw[84:88])[0]
            if ntype not in (1, 2) or length < 1 or (ntype == 1 and not 2 <= length <= 8) or position < 0:
                raise Refusal("corrupt", "variable")
            variables.append(XptVariable(ntype, length, number, _text(raw[8:16]), _text(raw[16:56]), _text(raw[56:64]).upper(), position))
        at = end + (-end) % XPT_RECORD
        if not data[at:at + XPT_RECORD].startswith(XPT_OBS_HEADER):
            raise Refusal("corrupt", "observation header")
        at += XPT_RECORD
        row_length = sum(variable.length for variable in variables)
        if any(variable.position + variable.length > row_length for variable in variables):
            raise Refusal("corrupt", "variable positions")
        # The observations run to the next member header on a record boundary, or to the end.
        stop = at
        while True:
            stop = data.find(XPT_MEMBER, stop)
            if stop < 0:
                stop = len(data)
                break
            if stop % XPT_RECORD == 0:
                break
            stop += 1
        rows = (stop - at) // row_length
        # Padding to a record boundary is blanks; a row of nothing but blanks at the end is padding, not an observation.
        while rows and not data[at + (rows - 1) * row_length:at + rows * row_length].strip(b" "):
            rows -= 1
        datasets.append(XptDataset(_text(name_record[8:16]).upper(), _text(second[32:72]), variables, view[at:at + rows * row_length], row_length, rows))
        at = stop
    if not datasets:
        raise Refusal("not_xpt")
    return datasets


class XptCleaner:
    """How one dataset's cells become text: numbers, SAS dates and times, and characters in the encoding they decode as."""

    def __init__(self, dataset: XptDataset, coverage: Coverage) -> None:
        self.dataset = dataset
        self.coverage = coverage
        self.kinds: dict[str, str] = {}
        self.basis: dict[str, str] = {}
        for variable in dataset.variables:
            self.kinds[variable.name], self.basis[variable.name] = self.kind_of(variable)

    @staticmethod
    def kind_of(variable: XptVariable) -> tuple[str, str]:
        if not variable.numeric:
            return "text", ""
        fmt = variable.format
        if fmt.startswith(DATETIME_FORMATS):
            return "datetime", f"format {fmt}"
        if fmt.startswith(TIME_FORMATS):
            return "time", f"format {fmt}"
        if fmt.startswith(DATE_FORMATS):
            return "date", f"format {fmt}"
        # With no date format on it, ADaM's own naming says what a numeric *DT, *DTM or *TM variable is.
        if not fmt:
            if re.search(r"DTM$", variable.name):
                return "datetime", "ADaM name *DTM"
            if re.search(r"DT$", variable.name):
                return "date", "ADaM name *DT"
            if re.search(r"TM$", variable.name):
                return "time", "ADaM name *TM"
        return "number", ""

    def rows(self):
        """Yield each observation as a list of text cells, in the variable order."""
        dataset = self.dataset
        specials = 0
        for index in range(dataset.rows):
            raw = dataset.body[index * dataset.row_length:(index + 1) * dataset.row_length]
            cells = []
            for variable in dataset.variables:
                chunk = bytes(raw[variable.position:variable.position + variable.length])
                if not variable.numeric:
                    cells.append(self.character(chunk))
                    continue
                value = ibm_to_float(chunk)
                if value is None or isinstance(value, str):
                    specials += 1 if isinstance(value, str) else 0
                    cells.append("")
                    continue
                cells.append(self.number(variable.name, value))
            yield cells
        if specials:
            self.coverage.notice("special_missing_values", specials)

    @staticmethod
    def character(chunk: bytes) -> str:
        trimmed = chunk.rstrip(b" \x00")
        try:
            return cell(trimmed.decode("utf-8"))
        except UnicodeDecodeError:
            try:
                return cell(trimmed.decode("gb18030"))
            except UnicodeDecodeError as error:
                raise Refusal("text_encoding") from error

    def number(self, name: str, value: float) -> str:
        kind = self.kinds[name]
        try:
            if kind == "date":
                return (SAS_EPOCH + timedelta(days=int(value // 1))).isoformat()
            if kind == "datetime":
                moment = datetime(1960, 1, 1) + timedelta(seconds=round(value))
                return moment.isoformat(timespec="seconds")
            if kind == "time":
                seconds = int(round(value)) % 86400
                return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"
        except (OverflowError, ValueError):
            self.coverage.notice("date_unreadable")
            return ""
        return number_text(value)


def _adam_label(variable: XptVariable, basis: str) -> str:
    label = variable.label or variable.name
    return f"{label} [{basis}]" if basis else label


def _common_unit(values: set[str]) -> str | None:
    values.discard("")
    return values.pop().lower() if len(values) == 1 else None


class AdamImport:
    def __init__(self, directory: Path, limits: Limits, coverage: Coverage) -> None:
        self.directory = directory
        self.limits = limits
        self.coverage = coverage
        self.tables: list[TableOut] = []
        self.standard = {"name": "CDISC ADaM", "release": "SAS transport V5"}
        self.first_error: Refusal | None = None
        self.names: set[str] = set()

    def spec(self, variable: XptVariable, cleaner: XptCleaner, *, role: str = "other", concept: str = "", unit: str | None = None, parameter: str | None = None,
             alias: str | None = None, outcome: bool = False, codes: dict | None = None, source: str = OBSERVED, identifier: bool = False) -> dict:
        kind = cleaner.kinds[variable.name]
        built = column(variable.name, source, _adam_label(variable, cleaner.basis[variable.name]), role=role, concept=(concept or variable.label or variable.name)[:80],
                       unit=unit, time_kind="occurred_at" if kind in ("date", "datetime") else None, parameter=parameter, alias=alias, outcome=outcome, codes=codes,
                       kind={"date": "date", "datetime": "date", "number": "number"}.get(kind))
        built["identifier"] = identifier
        return built

    def claim(self, name: str) -> bool:
        if name in self.names:
            self.coverage.skipped_tables.append({"table": name, "reason": "duplicate_table"})
            return False
        self.names.add(name)
        return True

    def run(self, archive: Archive) -> dict:
        members = [member for member in archive.members if member["name"].lower().endswith((".xpt", ".xport"))]
        for member in archive.members:
            if member not in members:
                self.coverage.add_input(member["name"], None, 0, "skipped", "not_an_xpt_file")
        if not members:
            raise Refusal("not_xpt" if archive.members else "nothing_to_import")
        for member in members:
            try:
                if member["size"] > MAX_XPT_BYTES:
                    raise Refusal("too_large", member["name"])
                datasets = parse_xpt(archive.read_all(member, MAX_XPT_BYTES))
            except Refusal as refusal:
                self.first_error = self.first_error or refusal
                self.coverage.add_input(member["name"], None, 0, "skipped", refusal.reason)
                continue
            for dataset in datasets:
                self.dataset(dataset)
        if not self.tables:
            raise self.first_error or Refusal("no_supported_dataset")
        return dict(self.standard)

    def dataset(self, dataset: XptDataset) -> None:
        if dataset.name not in ADAM_DATASETS:
            self.coverage.add_input(dataset.name or "(unnamed)", dataset.rows, 0, "skipped", "unsupported_dataset")
            return
        names = {variable.name for variable in dataset.variables}
        missing = [name for name in ADAM_REQUIRED[dataset.name] if name not in names]
        if missing:
            self.coverage.add_input(dataset.name, dataset.rows, 0, "skipped", f"missing_required_column:{missing[0]}")
            return
        cleaner = XptCleaner(dataset, self.coverage)
        try:
            {"ADSL": self.adsl, "ADTTE": self.adtte, "ADAE": self.adae}[dataset.name](dataset, cleaner)
        except Refusal as refusal:
            self.first_error = self.first_error or refusal
            self.coverage.add_input(dataset.name, dataset.rows, 0, "skipped", refusal.reason)

    def columns_for(self, dataset: XptDataset, cleaner: XptCleaner, special: dict[str, dict]) -> list[dict]:
        """One column spec per variable of the dataset, in file order; `special` gives the ones the module reads by role."""
        dtype_used = False
        if "DTYPE" in {variable.name for variable in dataset.variables}:
            at = [variable.name for variable in dataset.variables].index("DTYPE")
            dtype_used = any(row[at] for row in cleaner.rows())
            if dtype_used:
                self.coverage.notice("dtype_populated")
        out = []
        for variable in dataset.variables:
            extra = dict(special.get(variable.name, {}))
            if dtype_used and variable.name in ("AVAL", "AVALC") and "source" not in extra:
                # A record the sponsor derived or imputed (DTYPE) is in this column: it is labelled with the least direct source.
                extra["source"] = IMPUTED
            if variable.name in ADAM_IDENTIFIERS:
                extra["identifier"] = True
            out.append(self.spec(variable, cleaner, **extra))
        return out

    def write_all(self, dataset: XptDataset, cleaner: XptCleaner, table: TableOut) -> int:
        for cells in cleaner.rows():
            table.write(cells)
        return table.rows

    def adsl(self, dataset: XptDataset, cleaner: XptCleaner) -> None:
        present = {variable.name: variable for variable in dataset.variables}
        at = {variable.name: index for index, variable in enumerate(dataset.variables)}
        special: dict[str, dict] = {"USUBJID": {"role": "subject_key", "concept": "Unique subject identifier"}}
        arm = "TRT01P" if "TRT01P" in present else "ARM" if "ARM" in present else None
        if arm:
            special[arm] = {"role": "arm", "alias": arm, "concept": "Planned treatment arm"}
        units = set()
        if "AGEU" in present:
            for cells in cleaner.rows():
                units.add(cells[at["AGEU"]])
        for name, concept in ADAM_COVARIATES:
            if name in present and name not in special:
                special[name] = {"role": "covariate", "alias": name, "concept": concept, **({"unit": _common_unit(units)} if name == "AGE" else {})}
        for name in ADAM_OUTCOME_COVARIATES:
            if name in present:
                special[name] = {"role": "covariate", "alias": name, "outcome": True}
        table_name = "adam_adsl"
        if not self.claim(table_name):
            return
        columns = self.columns_for(dataset, cleaner, special)
        table = TableOut(self.directory, table_name, columns, self.limits)
        seen: set[str] = set()
        key = at["USUBJID"]
        duplicate = 0
        for cells in cleaner.rows():
            if cells[key] in seen:
                duplicate += 1
            seen.add(cells[key])
            table.write(cells)
        self.tables.append(table)
        if duplicate:
            self.coverage.notice("duplicate_subject_rows", duplicate)
        self.coverage.add_input("ADSL", dataset.rows, table.rows if table.overflow is None else 0, "imported" if table.overflow is None else "skipped", table.overflow, into=None)

    def adae(self, dataset: XptDataset, cleaner: XptCleaner) -> None:
        special = {"USUBJID": {"role": "subject_key", "concept": "Unique subject identifier"}}
        if not self.claim("adam_adae"):
            return
        table = TableOut(self.directory, "adam_adae", self.columns_for(dataset, cleaner, special), self.limits)
        self.write_all(dataset, cleaner, table)
        self.tables.append(table)
        self.coverage.add_input("ADAE", dataset.rows, table.rows if table.overflow is None else 0, "imported" if table.overflow is None else "skipped", table.overflow)

    def adtte(self, dataset: XptDataset, cleaner: XptCleaner) -> None:
        """One table per parameter: the module reads a time-to-event pair by column, so each PARAMCD is its own table, rows as received."""
        names = [variable.name for variable in dataset.variables]
        at = {name: index for index, name in enumerate(names)}
        units = {cells[at["AVALU"]] for cells in cleaner.rows()} if "AVALU" in at else set()
        unit = _common_unit(units)
        outputs: dict[str, TableOut] = {}
        spelled: dict[str, str] = {}
        skipped: Counter = Counter()
        per_subject: Counter = Counter()
        not_binary = 0
        for cells in cleaner.rows():
            code = cells[at["PARAMCD"]]
            if not PARAMETER.match(code):
                skipped["paramcd_not_usable"] += 1
                continue
            key = code.lower()
            if spelled.setdefault(key, code) != code:
                skipped["paramcd_case_collision"] += 1
                continue
            if key not in outputs:
                table_name = f"adam_adtte_{key}"
                if not self.claim(table_name):
                    skipped["duplicate_table"] += 1
                    continue
                special = {
                    "USUBJID": {"role": "subject_key", "concept": "Unique subject identifier"},
                    "AVAL": {"role": "outcome_time", "parameter": code, "concept": "Analysis value: time to event", "unit": unit},
                    "CNSR": {"role": "outcome_event", "parameter": code, "concept": "Censor flag (1 = censored)", "codes": {"event": ["0"], "censored": ["1"]}},
                }
                if "STARTDT" in at:
                    special["STARTDT"] = {"role": "time_zero", "concept": "Time-to-event origin date"}
                outputs[key] = TableOut(self.directory, table_name, self.columns_for(dataset, cleaner, special), self.limits)
                self.tables.append(outputs[key])
            outputs[key].write(cells)
            per_subject[(key, cells[at["USUBJID"]])] += 1
            if cells[at["CNSR"]] not in ("0", "1", ""):
                not_binary += 1
        rows_in = sum(table.rows for table in outputs.values())
        for key, table in outputs.items():
            self.coverage.add_input(f"ADTTE {spelled[key]}", table.rows, table.rows if table.overflow is None else 0, "imported" if table.overflow is None else "skipped", table.overflow)
        if not outputs:
            self.coverage.add_input("ADTTE", dataset.rows, 0, "skipped", "no_usable_parameter", skipped)
        elif skipped:
            self.coverage.add_input("ADTTE (rows not placed)", dataset.rows - rows_in, 0, "skipped", "rows_not_placed", skipped)
        repeated = sum(1 for count in per_subject.values() if count > 1)
        if repeated:
            self.coverage.notice("duplicate_subject_parameter_rows", repeated)
        if not_binary:
            self.coverage.notice("cnsr_not_binary", not_binary)


def convert_adam(archive: Archive, directory: Path, limits: Limits, coverage: Coverage) -> tuple[list[TableOut], dict]:
    importer = AdamImport(directory, limits, coverage)
    standard = importer.run(archive)
    return importer.tables, standard


CONVERTERS = {"fhir": convert_fhir, "omop": convert_omop, "adam": convert_adam}


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
