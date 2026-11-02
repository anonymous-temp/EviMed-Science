#!/usr/bin/env python3
"""Build the pinned, read-only FDA approval-records index shipped with EviMed.

    python3 build_fda_approvals.py [--output <file>.sqlite] [--source-cache <dir of pinned inputs>]

The inputs are four public FDA files, pinned by size and SHA-256 below:

  orange-book.zip       the Orange Book data files (products.txt, patent.txt, exclusivity.txt, tilde-delimited)
  drugsatfda.zip        the Drugs@FDA data file (tab-delimited tables)
  the two code tables   the Orange Book's exclusivity-code and patent-use-code definitions (HTML)

FDA replaces the first two in place (the Drugs@FDA file every weekday, the Orange Book every month), so unlike SIDER the
publisher's URL does not keep serving the pinned bytes: a build whose download no longer matches the pin stops and names
it, and the pinned bytes are supplied with --source-cache (a directory of files named by their SHA-256). The index records
the digests of the inputs it was built from, so a build handed the index a previous build made verifies it instead of
building again (`reusable`), exactly as the SIDER builder does. Moving to a newer snapshot is a change to SOURCES, to the
labels beside it, and to the cache key in .github/workflows/web.yml; nothing else.

The rows are written in key order and the file carries no build time, so two builds of the same inputs are the same file.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import html.parser
import io
import json
import os
import sqlite3
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import drug_approval_index as index  # noqa: E402

# Raise it with any change to what the builder writes: `reusable` takes an index with this version and these inputs for the one it would build.
BUILDER_VERSION = 1
MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024
MAX_MEMBER_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 128 * 1024 * 1024
FETCHED_ON = "2026-11-02"
ORANGE_BOOK_LABEL = "Orange Book data files, September 2026 edition (EOBZIP_2026_09; files dated 2026-10-09, published 2026-10-13)"
DRUGS_AT_FDA_LABEL = "Drugs@FDA data file of 2026-10-30 (dafdata20261030)"
SHORT_LABEL = "Orange Book 2026-09 edition, Drugs@FDA 2026-10-30"

SOURCES = {
    "orange-book.zip": {
        "url": "https://www.fda.gov/media/76860/download?attachment",
        "bytes": 1_099_838,
        "sha256": "c2088c7a36db1930a152b63db23e7a995c471bf4b18c960b1d28190580984e4d",
        "label": ORANGE_BOOK_LABEL,
    },
    "drugsatfda.zip": {
        "url": "https://www.fda.gov/media/89850/download?attachment",
        "bytes": 6_107_790,
        "sha256": "5eaa76eca3655215f1a95456e7ba67fa4e72a583d3b21e8e0c321c81ba2817fe",
        "label": DRUGS_AT_FDA_LABEL,
    },
    "exclusivity-codes.html": {
        "url": "https://www.accessdata.fda.gov/scripts/cder/ob/results_exclusivity.cfm",
        "bytes": 428_486,
        "sha256": "3a79adea2322bd54bbdc6005a356f99f92b1bb79228a52798cb4610b47128133",
        "label": "Orange Book exclusivity codes and definitions",
    },
    "patent-use-codes.html": {
        "url": "https://www.accessdata.fda.gov/scripts/cder/ob/results_patent.cfm",
        "bytes": 876_571,
        "sha256": "d1ebc1030075332b8b5b3fb050268ad95aa7b006c10e4bfc15e2040e2447f9e5",
        "label": "Orange Book patent use codes and definitions",
    },
}

ORANGE_BOOK_MEMBERS = {
    "products.txt": ("Ingredient", "DF;Route", "Trade_Name", "Applicant", "Strength", "Appl_Type", "Appl_No", "Product_No", "TE_Code",
                     "Approval_Date", "RLD", "RS", "Type", "Applicant_Full_Name"),
    "patent.txt": ("Appl_Type", "Appl_No", "Product_No", "Patent_No", "Patent_Expire_Date_Text", "Drug_Substance_Flag", "Drug_Product_Flag",
                   "Patent_Use_Code", "Delist_Flag", "Submission_Date"),
    "exclusivity.txt": ("Appl_Type", "Appl_No", "Product_No", "Exclusivity_Code", "Exclusivity_Date"),
}
# Every Drugs@FDA table the index reads, with its exact header: a changed column is refused, because a silently dropped
# column is a silently dropped fact. The tables not listed (documents, property types, the document-type lookup) are not read.
DRUGS_AT_FDA_MEMBERS = {
    "Applications.txt": ("ApplNo", "ApplType", "ApplPublicNotes", "SponsorName"),
    "Products.txt": ("ApplNo", "ProductNo", "Form", "Strength", "ReferenceDrug", "DrugName", "ActiveIngredient", "ReferenceStandard"),
    "Submissions.txt": ("ApplNo", "SubmissionClassCodeID", "SubmissionType", "SubmissionNo", "SubmissionStatus", "SubmissionStatusDate",
                        "SubmissionsPublicNotes", "ReviewPriority"),
    "SubmissionClass_Lookup.txt": ("SubmissionClassCodeID", "SubmissionClassCode", "SubmissionClassCodeDescription"),
    "ActionTypes_Lookup.txt": ("ActionTypes_LookupID", "ActionTypes_LookupDescription", "SupplCategoryLevel1Code", "SupplCategoryLevel2Code"),
    "Join_Submission_ActionTypes_Lookup.txt": ("SubmissionType", "j_submissionActionTypeID", "ApplNo", "SubmissionNo", "ActionTypes_LookupID"),
    "MarketingStatus.txt": ("MarketingStatusID", "ApplNo", "ProductNo"),
    "MarketingStatus_Lookup.txt": ("MarketingStatusID", "MarketingStatusDescription"),
    "TE.txt": ("ApplNo", "ProductNo", "MarketingStatusID", "TECode"),
}
SUBMISSION_STATUS = {"AP": "approved", "TA": "tentative approval"}
APPLICATION_TYPE_OF_LETTER = {"N": "NDA", "A": "ANDA"}
UNKNOWN_TYPE = "unknown"


def refuse(message):
    raise SystemExit("FDA approvals build: " + message)


def verified_payload(name: str, payload: bytes, spec: dict) -> bytes:
    digest = hashlib.sha256(payload).hexdigest()
    if len(payload) != spec["bytes"] or digest != spec["sha256"]:
        refuse(
            "input %s changed: expected %s bytes / %s, received %s bytes / %s. FDA replaces these files in place; the build needs "
            "the pinned bytes, supplied with --source-cache (a directory of files named by their sha256)."
            % (name, spec["bytes"], spec["sha256"], len(payload), digest)
        )
    return payload


def download(name: str, spec: dict, cache: Path | None = None) -> bytes:
    cached = cache / spec["sha256"] if cache is not None else None
    if cached is not None and cached.is_file():
        with cached.open("rb") as handle:
            return verified_payload(name, handle.read(MAX_DOWNLOAD_BYTES + 1), spec)
    request = urllib.request.Request(spec["url"], headers={"user-agent": "EviMed-FDA-approvals-builder/1.0"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = response.read(MAX_DOWNLOAD_BYTES + 1)
            break
        except urllib.error.HTTPError as error:
            error.close()
            if error.code not in {429, 500, 502, 503, 504} or attempt == 2:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == 2:
                raise
        time.sleep(2 ** (attempt + 1))
    verified_payload(name, payload, spec)
    if cached is not None:
        cached.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=cached.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(payload)
        try:
            temporary.replace(cached)
        finally:
            temporary.unlink(missing_ok=True)
    return payload


def zip_members(payload: bytes, expected: dict) -> dict:
    """The named members of a pinned archive as text tables: header checked, ragged rows refused."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile as error:
        refuse("an input archive cannot be read: %s" % error)
    names = {entry.filename: entry for entry in archive.infolist()}
    total = 0
    tables = {}
    for name, header in expected.items():
        if name not in names:
            refuse("the archive has no %s (it holds %s)" % (name, ", ".join(sorted(names))))
        entry = names[name]
        if entry.file_size > MAX_MEMBER_BYTES:
            refuse("%s is larger than %d bytes" % (name, MAX_MEMBER_BYTES))
        with archive.open(entry) as handle:
            raw = handle.read(MAX_MEMBER_BYTES + 1)
        if len(raw) > MAX_MEMBER_BYTES:
            refuse("%s expanded past %d bytes" % (name, MAX_MEMBER_BYTES))
        total += len(raw)
        if total > MAX_EXPANDED_BYTES:
            refuse("the archive expanded past %d bytes" % MAX_EXPANDED_BYTES)
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            # One Drugs@FDA table (Submissions.txt) carries a few Windows-1252 bytes in its free-text notes.
            try:
                text = raw.decode("cp1252")
            except UnicodeDecodeError:
                refuse("%s is neither UTF-8 nor Windows-1252" % name)
        delimiter = "~" if expected is ORANGE_BOOK_MEMBERS else "\t"
        reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter, quoting=csv.QUOTE_NONE)
        first = next(reader, None)
        if tuple(first or ()) != header:
            refuse("%s has columns %s, not the %d the index reads (%s)" % (name, first, len(header), ", ".join(header)))
        rows = []
        for number, row in enumerate(reader, start=2):
            if not row:
                continue
            if len(row) != len(header):
                refuse("%s line %d has %d fields, not %d" % (name, number, len(row), len(header)))
            rows.append(row)
        if not rows:
            refuse("%s holds no rows" % name)
        tables[name] = rows
    return tables


def iso_date(text: str, *, fda_text: bool) -> str | None:
    """A date as ISO. Orange Book dates read `Aug 24, 2026`; Drugs@FDA dates read `2026-08-24 00:00:00`."""
    text = text.strip()
    if not text:
        return None
    try:
        if fda_text:
            return datetime.strptime(text, "%b %d, %Y").strftime("%Y-%m-%d")
        return datetime.strptime(text[:10], "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        refuse("an unreadable date: %r" % text)


class _CodeTables(html.parser.HTMLParser):
    """The two-column tables of a code page: {table id: [(code, definition)]}."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = {}
        self._table = None
        self._row = None
        self._cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._table = dict(attrs).get("id") or "table%d" % len(self.tables)
            self.tables.setdefault(self._table, [])
        elif tag == "tr" and self._table is not None:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self.tables[self._table].append(tuple(self._row))
            self._row = None
        elif tag == "table":
            self._table = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def code_table(payload: bytes, name: str, expect_tables: int, minimum: int) -> dict:
    parser = _CodeTables()
    parser.feed(payload.decode("utf-8", errors="replace"))
    parser.close()
    tables = {key: rows for key, rows in parser.tables.items() if any(len(row) == 2 and row[0] == "Code" for row in rows)}
    if len(tables) != expect_tables:
        refuse("%s: expected %d code table(s), found %d" % (name, expect_tables, len(tables)))
    codes = {}
    for rows in tables.values():
        for row in rows:
            if len(row) != 2 or row == ("Code", "Definition"):
                continue
            code, meaning = row[0].strip(), row[1].strip()
            if not code or not meaning:
                refuse("%s: a code row without a code or a definition: %r" % (name, row))
            if codes.get(code, meaning) != meaning:
                refuse("%s: the code %s has two definitions" % (name, code))
            codes[code] = meaning
    if len(codes) < minimum:
        refuse("%s: only %d codes read, expected at least %d" % (name, len(codes), minimum))
    return codes


def table(tables: dict, name: str, header: tuple) -> list:
    return [dict(zip(header, row)) for row in tables[name]]


def build_rows(payloads: dict) -> dict:
    ob = zip_members(payloads["orange-book.zip"], ORANGE_BOOK_MEMBERS)
    daf = zip_members(payloads["drugsatfda.zip"], DRUGS_AT_FDA_MEMBERS)

    applications = {}
    for row in table(daf, "Applications.txt", DRUGS_AT_FDA_MEMBERS["Applications.txt"]):
        number = row["ApplNo"].strip().zfill(6)
        if number in applications:
            refuse("application %s is listed twice in Drugs@FDA" % number)
        if row["ApplType"].strip() not in index.APPLICATION_TYPES:
            refuse("application %s has the type %r" % (number, row["ApplType"]))
        applications[number] = {"type": row["ApplType"].strip(), "sponsor": row["SponsorName"].strip(), "notes": row["ApplPublicNotes"].strip()}

    classes = {}
    class_code_of_id = {}
    for row in table(daf, "SubmissionClass_Lookup.txt", DRUGS_AT_FDA_MEMBERS["SubmissionClass_Lookup.txt"]):
        code, description = row["SubmissionClassCode"].strip(), row["SubmissionClassCodeDescription"].strip()
        class_code_of_id[row["SubmissionClassCodeID"].strip()] = code
        if code and classes.get(code, description) != description:
            refuse("submission class %s has two descriptions" % code)
        if code:
            classes[code] = description or code

    actions = {}
    for row in table(daf, "ActionTypes_Lookup.txt", DRUGS_AT_FDA_MEMBERS["ActionTypes_Lookup.txt"]):
        description = row["ActionTypes_LookupDescription"].strip()
        if any(character.isalnum() for character in description):
            actions[row["ActionTypes_LookupID"].strip()] = description
    categories = {}
    for row in table(daf, "Join_Submission_ActionTypes_Lookup.txt", DRUGS_AT_FDA_MEMBERS["Join_Submission_ActionTypes_Lookup.txt"]):
        description = actions.get(row["ActionTypes_LookupID"].strip())
        if description:
            categories.setdefault((row["ApplNo"].strip().zfill(6), row["SubmissionType"].strip(), int(row["SubmissionNo"])), set()).add(description)

    submissions = {}
    for row in table(daf, "Submissions.txt", DRUGS_AT_FDA_MEMBERS["Submissions.txt"]):
        number = row["ApplNo"].strip().zfill(6)
        kind = row["SubmissionType"].strip()
        if kind not in ("ORIG", "SUPPL"):
            refuse("submission type %r" % kind)
        key = (number, kind, int(row["SubmissionNo"]))
        if key in submissions:
            refuse("submission %s %s %s is listed twice" % key)
        if number not in applications:
            # Drugs@FDA's Applications table omits about 1,450 old applications that its Submissions table still lists.
            applications[number] = {"type": UNKNOWN_TYPE, "sponsor": "", "notes": ""}
        status = row["SubmissionStatus"].strip()
        priority = row["ReviewPriority"].strip()
        submissions[key] = {
            "date": iso_date(row["SubmissionStatusDate"], fda_text=False),
            "status": SUBMISSION_STATUS.get(status, status) if status else None,
            "class_code": class_code_of_id.get(row["SubmissionClassCodeID"].strip()) or None,
            "priority": priority.lower() if priority in ("Standard", "Priority", "STANDARD", "PRIORITY") else None,
            "categories": "; ".join(sorted(categories.get(key, ()))) or None,
        }

    marketing_names = {row["MarketingStatusID"].strip(): row["MarketingStatusDescription"].strip()
                       for row in table(daf, "MarketingStatus_Lookup.txt", DRUGS_AT_FDA_MEMBERS["MarketingStatus_Lookup.txt"])}
    marketing = {}
    for row in table(daf, "MarketingStatus.txt", DRUGS_AT_FDA_MEMBERS["MarketingStatus.txt"]):
        key = (row["ApplNo"].strip().zfill(6), row["ProductNo"].strip().zfill(3))
        if key in marketing:
            refuse("product %s/%s has two marketing statuses" % key)
        if row["MarketingStatusID"].strip() not in marketing_names:
            refuse("marketing status %r is not in the lookup" % row["MarketingStatusID"])
        marketing[key] = marketing_names[row["MarketingStatusID"].strip()]
    te_codes = {}
    for row in table(daf, "TE.txt", DRUGS_AT_FDA_MEMBERS["TE.txt"]):
        te_codes[(row["ApplNo"].strip().zfill(6), row["ProductNo"].strip().zfill(3))] = row["TECode"].strip() or None

    products = {}
    for row in table(daf, "Products.txt", DRUGS_AT_FDA_MEMBERS["Products.txt"]):
        key = (row["ApplNo"].strip().zfill(6), row["ProductNo"].strip().zfill(3))
        if key in products:
            refuse("product %s/%s is listed twice in Drugs@FDA" % key)
        if key[0] not in applications:
            applications[key[0]] = {"type": UNKNOWN_TYPE, "sponsor": "", "notes": ""}
        products[key] = {
            "form": row["Form"].strip() or None, "strength": row["Strength"].strip() or None,
            "drug_name": row["DrugName"].strip() or None, "ingredient": row["ActiveIngredient"].strip() or None,
            "marketing": marketing.get(key), "te": te_codes.get(key), "approved": None, "trade": None, "ob_type": None,
            "applicant": None, "in_ob": False,
        }

    # The Orange Book: per-product approval date and full applicant name, trade name and type.
    ob_only_applications = {}
    for row in table(ob, "products.txt", ORANGE_BOOK_MEMBERS["products.txt"]):
        key = (row["Appl_No"].strip().zfill(6), row["Product_No"].strip().zfill(3))
        if row["Appl_Type"].strip() not in APPLICATION_TYPE_OF_LETTER:
            refuse("Orange Book application type %r" % row["Appl_Type"])
        if key[0] not in applications or applications[key[0]]["type"] == UNKNOWN_TYPE:
            # An application the Drugs@FDA tables do not type is typed by the Orange Book's N or A.
            applications.setdefault(key[0], {"sponsor": "", "notes": ""})["type"] = APPLICATION_TYPE_OF_LETTER[row["Appl_Type"].strip()]
            ob_only_applications[key[0]] = True
        entry = products.get(key)
        if entry is None:
            entry = products[key] = {
                "form": None, "strength": None, "drug_name": None, "ingredient": None, "marketing": None, "te": te_codes.get(key),
                "approved": None, "trade": None, "ob_type": None, "applicant": None, "in_ob": False,
            }
        text = row["Approval_Date"].strip()
        entry["approved"] = "before 1982-01-01 (Orange Book: approved prior to Jan 1, 1982)" if text.lower().startswith("approved prior") else iso_date(text, fda_text=True)
        entry["trade"] = row["Trade_Name"].strip() or None
        entry["ob_type"] = row["Type"].strip() or None
        entry["applicant"] = row["Applicant_Full_Name"].strip() or None
        entry["in_ob"] = True
        entry["te"] = entry["te"] or row["TE_Code"].strip() or None
        entry["ob_ingredient"] = row["Ingredient"].strip() or None
        if not entry["form"]:
            entry["form"] = row["DF;Route"].strip() or None
        if not entry["strength"]:
            entry["strength"] = row["Strength"].strip() or None
        if not entry["ingredient"]:
            entry["ingredient"] = entry["ob_ingredient"]
        if not entry["drug_name"]:
            entry["drug_name"] = entry["trade"]
        if entry["marketing"] is None and entry["ob_type"]:
            entry["marketing"] = {"RX": "Prescription", "OTC": "Over-the-counter", "DISCN": "Discontinued"}.get(entry["ob_type"])

    patents = []
    for row in table(ob, "patent.txt", ORANGE_BOOK_MEMBERS["patent.txt"]):
        number, product = row["Appl_No"].strip().zfill(6), row["Product_No"].strip().zfill(3)
        if (number, product) not in products:
            refuse("a patent of a product the files do not list: %s/%s" % (number, product))
        patents.append((
            number, product, row["Patent_No"].strip(), iso_date(row["Patent_Expire_Date_Text"], fda_text=True), row["Patent_Expire_Date_Text"].strip() or None,
            1 if row["Drug_Substance_Flag"].strip().upper() == "Y" else 0, 1 if row["Drug_Product_Flag"].strip().upper() == "Y" else 0,
            row["Patent_Use_Code"].strip() or None, 1 if row["Delist_Flag"].strip().upper() == "Y" else 0,
            iso_date(row["Submission_Date"], fda_text=True),
        ))
    patents.sort(key=lambda item: tuple("" if value is None else str(value) for value in item))
    exclusivities = []
    for row in table(ob, "exclusivity.txt", ORANGE_BOOK_MEMBERS["exclusivity.txt"]):
        number, product = row["Appl_No"].strip().zfill(6), row["Product_No"].strip().zfill(3)
        if (number, product) not in products:
            refuse("an exclusivity of a product the files do not list: %s/%s" % (number, product))
        exclusivities.append((number, product, row["Exclusivity_Code"].strip(), iso_date(row["Exclusivity_Date"], fda_text=True), row["Exclusivity_Date"].strip() or None))
    exclusivities.sort(key=lambda item: tuple("" if value is None else str(value) for value in item))

    exclusivity_meanings = code_table(payloads["exclusivity-codes.html"], "exclusivity codes", 2, 20)
    use_meanings = code_table(payloads["patent-use-codes.html"], "patent use codes", 1, 1000)
    missing = sorted({item[2] for item in exclusivities} - set(exclusivity_meanings))
    missing_use = sorted({item[7] for item in patents if item[7]} - set(use_meanings))

    # Application level summary: the original and the latest approved submission, applicant, counts.
    by_application = {}
    for key, value in submissions.items():
        by_application.setdefault(key[0], []).append((key, value))
    product_of = {}
    for (number, product), value in products.items():
        product_of.setdefault(number, []).append(value)
    patent_count, exclusivity_count = {}, {}
    for item in patents:
        patent_count[item[0]] = patent_count.get(item[0], 0) + 1
    for item in exclusivities:
        exclusivity_count[item[0]] = exclusivity_count.get(item[0], 0) + 1

    application_rows = []
    for number in sorted(applications):
        info = applications[number]
        items = sorted(by_application.get(number, []), key=lambda pair: (pair[1]["date"] or "", pair[0][1] == "SUPPL", pair[0][2]))
        originals = sorted((pair for pair in items if pair[0][1] == "ORIG" and pair[1]["status"] in ("approved", "tentative approval")),
                           key=lambda pair: (pair[1]["status"] != "approved", pair[1]["date"] or "9999", pair[0][2]))
        original = [None, None, None, None, None, None]
        if originals:
            (_, _, original_no), value = originals[0]
            original = [value["date"], value["status"], value["class_code"], original_no, "Drugs@FDA ORIG submission"]
        else:
            dated = sorted(item["approved"] for item in product_of.get(number, []) if item["approved"])
            if dated:
                first = dated[0]
                if first.startswith("before 1982"):
                    original = [None, "approved", None, None, "Orange Book product approval date: approved prior to Jan 1, 1982"]
                else:
                    original = [first, "approved", None, None, "Orange Book product approval date (Drugs@FDA lists no original submission)"]
        approved = [pair for pair in items if pair[1]["status"] == "approved" and pair[1]["date"]]
        latest = [None, None, None, None]
        if approved:
            (_, kind, latest_no), value = approved[-1]
            latest = [value["date"], kind, latest_no, value["class_code"]]
        applicants = sorted({item["applicant"] for item in product_of.get(number, []) if item["applicant"]})
        application_rows.append((
            number, info["type"], info["sponsor"] or None, " | ".join(applicants) or None, info["notes"] or None,
            original[0], original[1], original[2], original[3], original[4],
            latest[0], latest[1], latest[2], latest[3],
            sum(1 for pair in items if pair[0][1] == "ORIG"), sum(1 for pair in items if pair[0][1] == "SUPPL"),
            1 if any(item["in_ob"] for item in product_of.get(number, [])) else 0,
            patent_count.get(number, 0), exclusivity_count.get(number, 0),
        ))

    product_rows = []
    names = set()
    for (number, product) in sorted(products):
        value = products[(number, product)]
        product_rows.append((
            number, product, value["form"], value["strength"], value["drug_name"], value["ingredient"], value["marketing"], value["te"],
            value["approved"], value["trade"], value["ob_type"],
        ))
        for text, kind in ((value["drug_name"], "n"), (value["trade"], "n")):
            norm = index.normalize(text)
            if norm:
                names.add((norm, kind, number))
        for text in (value["ingredient"], value.get("ob_ingredient")):
            norm = index.normalize(text)
            if norm:
                names.add((norm, "i", number))
            parts = index.ingredient_parts(text)
            if len(parts) > 1:
                for part in parts:
                    names.add((part, "c", number))

    submission_rows = [
        (key[0], key[1], key[2], value["date"], value["status"], value["class_code"], value["priority"], value["categories"])
        for key, value in sorted(submissions.items())
    ]
    return {
        "application": application_rows, "product": product_rows, "submission": submission_rows, "patent": patents,
        "exclusivity": exclusivities, "name": sorted(names), "class": sorted(classes.items()),
        "code_meaning": sorted([("exclusivity", code, meaning) for code, meaning in exclusivity_meanings.items()]
                               + [("use", code, meaning) for code, meaning in use_meanings.items()]),
        "unexplained": {"exclusivity": missing, "use": missing_use},
        "ob_only_applications": sorted(ob_only_applications),
    }


SCHEMA_SQL = """
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE application (
        appl_no TEXT PRIMARY KEY, appl_type TEXT NOT NULL, sponsor TEXT, applicant TEXT, notes TEXT,
        orig_date TEXT, orig_status TEXT, orig_class TEXT, orig_no INTEGER, orig_source TEXT,
        latest_date TEXT, latest_type TEXT, latest_no INTEGER, latest_class TEXT,
        n_orig INTEGER NOT NULL, n_suppl INTEGER NOT NULL, in_ob INTEGER NOT NULL, n_patent INTEGER NOT NULL, n_excl INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE product (
        appl_no TEXT NOT NULL, product_no TEXT NOT NULL, form TEXT, strength TEXT, drug_name TEXT, ingredient TEXT,
        marketing TEXT, te TEXT, approved TEXT, trade TEXT, ob_type TEXT, PRIMARY KEY (appl_no, product_no)
    ) WITHOUT ROWID;
    CREATE TABLE submission (
        appl_no TEXT NOT NULL, kind TEXT NOT NULL, no INTEGER NOT NULL, date TEXT, status TEXT, class_code TEXT, priority TEXT, categories TEXT,
        PRIMARY KEY (appl_no, kind, no)
    ) WITHOUT ROWID;
    CREATE TABLE patent (
        appl_no TEXT NOT NULL, product_no TEXT NOT NULL, patent_no TEXT NOT NULL, expire_iso TEXT, expire_text TEXT,
        substance INTEGER NOT NULL, drug_product INTEGER NOT NULL, use_code TEXT, delist INTEGER NOT NULL, submitted_iso TEXT
    );
    CREATE INDEX patent_application ON patent(appl_no);
    CREATE TABLE exclusivity (
        appl_no TEXT NOT NULL, product_no TEXT NOT NULL, code TEXT NOT NULL, expire_iso TEXT, expire_text TEXT
    );
    CREATE INDEX exclusivity_application ON exclusivity(appl_no);
    CREATE TABLE class (code TEXT PRIMARY KEY, description TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE code_meaning (kind TEXT NOT NULL, code TEXT NOT NULL, meaning TEXT NOT NULL, PRIMARY KEY (kind, code)) WITHOUT ROWID;
    CREATE TABLE name (norm TEXT NOT NULL, kind TEXT NOT NULL, appl_no TEXT NOT NULL, PRIMARY KEY (norm, kind, appl_no)) WITHOUT ROWID;
"""


def inputs_record() -> list:
    return [{"name": name, "url": spec["url"], "bytes": spec["bytes"], "sha256": spec["sha256"], "label": spec["label"]} for name, spec in SOURCES.items()]


def build(output: Path, cache: Path | None = None) -> None:
    payloads = {name: download(name, spec, cache) for name, spec in SOURCES.items()}
    rows = build_rows(payloads)
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".fda-approvals-", suffix=".sqlite", dir=output.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        connection = sqlite3.connect(temporary)
        try:
            connection.executescript(SCHEMA_SQL)
            connection.executemany("INSERT INTO application VALUES (%s)" % ",".join("?" * 19), rows["application"])
            connection.executemany("INSERT INTO product VALUES (%s)" % ",".join("?" * 11), rows["product"])
            connection.executemany("INSERT INTO submission VALUES (%s)" % ",".join("?" * 8), rows["submission"])
            connection.executemany("INSERT INTO patent VALUES (%s)" % ",".join("?" * 10), rows["patent"])
            connection.executemany("INSERT INTO exclusivity VALUES (%s)" % ",".join("?" * 5), rows["exclusivity"])
            connection.executemany("INSERT INTO class VALUES (?, ?)", rows["class"])
            connection.executemany("INSERT INTO code_meaning VALUES (?, ?, ?)", rows["code_meaning"])
            connection.executemany("INSERT INTO name VALUES (?, ?, ?)", rows["name"])
            counts = {name: len(rows[name]) for name in ("application", "product", "submission", "patent", "exclusivity", "name", "code_meaning")}
            connection.executemany("INSERT INTO metadata VALUES (?, ?)", [
                ("schema", index.SCHEMA),
                ("builderVersion", str(BUILDER_VERSION)),
                ("orangeBookLabel", ORANGE_BOOK_LABEL),
                ("drugsAtFdaLabel", DRUGS_AT_FDA_LABEL),
                ("shortLabel", SHORT_LABEL),
                ("fetchedOn", FETCHED_ON),
                ("inputs", json.dumps(inputs_record(), sort_keys=True, ensure_ascii=True)),
                ("counts", json.dumps(counts, sort_keys=True)),
                ("terms", "Public FDA data files. A snapshot, not the official record; FDA does not endorse this use."),
                ("unexplainedCodes", json.dumps(rows["unexplained"], sort_keys=True)),
            ])
            connection.commit()
            if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                refuse("the generated SQLite failed its integrity check")
            connection.execute("PRAGMA user_version = 1")
            connection.commit()
            connection.execute("VACUUM")
        finally:
            connection.close()
        os.chmod(temporary, 0o444)
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print("built %s: %s applications, %s products, %s submissions, %s patent rows, %s exclusivity rows, %s bytes, sha256=%s" % (
        output, counts["application"], counts["product"], counts["submission"], counts["patent"], counts["exclusivity"], output.stat().st_size, digest,
    ))


def reusable(output: Path) -> bool:
    """Whether `output` is already the index this builder makes from the pinned inputs.

    The index records the digests of the inputs it was built from and the row counts it holds; a file that names exactly the
    pinned inputs, whose counts are its own and whose integrity check passes is the same index, so it is verified instead of
    being built again. Unlike the SIDER inputs the FDA files cannot be fetched again by digest, so this is what lets a build
    that was handed the index (a CI cache, a build context) proceed without the pinned bytes.
    """
    if not output.is_file():
        return False
    try:
        connection = sqlite3.connect("file:%s?mode=ro" % output, uri=True)
        try:
            if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                return False
            recorded = dict(connection.execute("SELECT key, value FROM metadata").fetchall())
            held = {
                "application": connection.execute("SELECT count(*) FROM application").fetchone()[0],
                "product": connection.execute("SELECT count(*) FROM product").fetchone()[0],
                "submission": connection.execute("SELECT count(*) FROM submission").fetchone()[0],
                "patent": connection.execute("SELECT count(*) FROM patent").fetchone()[0],
                "exclusivity": connection.execute("SELECT count(*) FROM exclusivity").fetchone()[0],
                "name": connection.execute("SELECT count(*) FROM name").fetchone()[0],
                "code_meaning": connection.execute("SELECT count(*) FROM code_meaning").fetchone()[0],
            }
        finally:
            connection.close()
        counts = json.loads(recorded.get("counts", "{}"))
    except (sqlite3.Error, ValueError):
        return False
    return (
        recorded.get("schema") == index.SCHEMA
        and recorded.get("builderVersion") == str(BUILDER_VERSION)
        and recorded.get("orangeBookLabel") == ORANGE_BOOK_LABEL
        and recorded.get("drugsAtFdaLabel") == DRUGS_AT_FDA_LABEL
        and recorded.get("inputs") == json.dumps(inputs_record(), sort_keys=True, ensure_ascii=True)
        and all(held[name] > 0 and counts.get(name) == held[name] for name in held)
    )


def receipt_agrees() -> bool:
    """Whether data/fda-approvals.SOURCE.json names exactly the inputs this builder pins."""
    try:
        recorded = json.loads((Path(__file__).resolve().parent / "data" / "fda-approvals.SOURCE.json").read_text(encoding="utf-8"))["inputs"]
    except (OSError, ValueError, KeyError):
        return False
    return recorded == {name: {"url": spec["url"], "bytes": spec["bytes"], "sha256": spec["sha256"]} for name, spec in SOURCES.items()}


def verify(output: Path) -> None:
    """Exercise the shipped query path without any external request."""
    if output.stat().st_mode & 0o222:
        refuse("the index must ship read-only")
    previous = os.environ.get(index.DATABASE_ENV)
    os.environ[index.DATABASE_ENV] = str(output)
    try:
        found = index.find({"action": "find", "name": "metformin"})
        if found["status"] not in {"success", "warning"} or not found["data"]["applications"]:
            refuse("the smoke search for metformin returned no application")
        if "snapshot" not in found["data"] or not found["data"]["snapshot"]["caveat"]:
            refuse("the smoke search lost its snapshot statement")
        first = found["data"]["applications"][0]
        detail = index.record({"action": "record", "applNo": first["applNo"]})
        if not detail["data"]["submissions"]["rows"]:
            refuse("the smoke record of %s lists no submission" % first["applNo"])
        missing = index.find({"action": "find", "name": "zzqxv not a drug"})
        if missing["data"]["applications"]:
            refuse("a name the files do not hold returned a row")
    finally:
        if previous is None:
            os.environ.pop(index.DATABASE_ENV, None)
        else:
            os.environ[index.DATABASE_ENV] = previous
    if not receipt_agrees():
        refuse("the index must ship with a source receipt (data/fda-approvals.SOURCE.json) that names exactly the pinned inputs")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "data" / "fda-approvals.sqlite")
    parser.add_argument("--source-cache", type=Path, help="Directory of the pinned inputs, each named by its sha256; every read is reverified")
    arguments = parser.parse_args()
    output = arguments.output.resolve()
    if reusable(output):
        os.chmod(output, 0o444)
        print("reused %s: built from the pinned inputs, sha256=%s" % (output, hashlib.sha256(output.read_bytes()).hexdigest()))
    else:
        build(output, arguments.source_cache)
    verify(output)


if __name__ == "__main__":
    main()
