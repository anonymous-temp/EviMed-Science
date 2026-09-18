"""The EviMed drug-label index: Chinese drug labels, one per approval number.

A read-only SQLite file built by `build_drug_label_index.py` from exported label
databases, and queried here by `drug_label_search` wherever the file is mounted.
In production that is the drug evidence adapter, which mounts the control
plane's data volume read-only at /data. The runtime image never carries the
file: it is several hundred megabytes, it changes on its own schedule, and the
runtime delta ships only this directory's Python sources.

A label is addressed by its approval number (批准文号) as `label:<approval>`,
one of its sections as `label:<approval>#<section>`. When a run reads a label
its sections are preserved in the workspace under
`.evimed-sources/drug-labels/<digest>/<capture version>/<section>.md`, which is
where `locate_quote` and the delivery gate find the words a claim quotes.

Standard library only: this module is imported by the research server, and a
third-party import there forces a full runtime rebuild.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import stat
import unicodedata
import urllib.parse
from datetime import datetime, timezone

SCHEMA = "evimed-drug-label-index-v1"
DATABASE_ENV = "EVIMED_DRUG_LABEL_DB"
MAX_DATABASE_BYTES = 4 * 1024 * 1024 * 1024
CAPTURE_DIR = ".evimed-sources/drug-labels"
SOURCE_NAME = "evimed-drug-label-index"
JURISDICTION = "China (NMPA)"
SEARCH_LIMIT_DEFAULT = 5
SEARCH_LIMIT_MAX = 10
PREVIEW_CHARS = 120

# A label's sections in the order the NMPA template prints them. The slug is
# the stable part of a section id; the title is what a pharmacist reads.
SECTIONS = (
    ("composition", "成份"),
    ("description", "性状"),
    ("indications", "适应症"),
    ("specification", "规格"),
    ("dosage", "用法用量"),
    ("adverse-reactions", "不良反应"),
    ("contraindications", "禁忌"),
    ("precautions", "注意事项"),
    ("pregnancy-lactation", "孕妇及哺乳期妇女用药"),
    ("pediatric", "儿童用药"),
    ("geriatric", "老年用药"),
    ("interactions", "药物相互作用"),
    ("overdose", "药物过量"),
    ("pharmacology-toxicology", "药理毒理"),
    ("pharmacokinetics", "药代动力学"),
    ("storage", "贮藏"),
    ("shelf-life", "有效期"),
)
SECTION_TITLES = dict(SECTIONS)
SECTION_ORDER = {slug: index for index, (slug, _title) in enumerate(SECTIONS)}
# Headings as labels and databases print them, so a caller may name a section
# the way it reads on the page.
SECTION_ALIASES = {
    **{title: slug for slug, title in SECTIONS},
    "成分": "composition",
    "主要成份": "composition",
    "主要成分": "composition",
    "功能主治": "indications",
    "功能主治/适应症": "indications",
    "适应证": "indications",
    "包装规格": "specification",
    "老人用药": "geriatric",
    "老年患者用药": "geriatric",
    "孕妇及哺乳期用药": "pregnancy-lactation",
}
# The sections a label is judged complete by when two copies of one approval
# number disagree.
CORE_SECTIONS = ("indications", "dosage", "adverse-reactions", "contraindications", "precautions", "interactions")

_CJK = "%s-%s" % (chr(0x3400), chr(0x9FFF))
_CJK_RUN = re.compile("[%s]+" % _CJK)
_SCRIPT_BOUNDARY = re.compile("(?<=[%s])(?=[^%s])|(?<=[^%s])(?=[%s])" % (_CJK, _CJK, _CJK, _CJK))
_QUERY_TOKEN = re.compile("[a-z0-9][a-z0-9._+-]*|[%s]+" % _CJK)
_REGISTRATION_PREFIX = re.compile("^(?:进口药品注册证号|医药产品注册证号|注册证号)")
_APPROVAL = re.compile(r"(?:国药准字[A-Z]{1,2}|[A-Z]{1,2})\d{8}")
_LABEL_ID = re.compile(r"(?:label:)?([^#\s/]{1,96})(?:#([^#\s/]{1,48}))?")


class DrugLabelIndexError(Exception):
    """A label lookup that cannot be answered, with the code a run is shown."""

    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


# ---------------------------------------------------------------------------
# Identifiers
# ---------------------------------------------------------------------------
def canonical_approval(value) -> str | None:
    """The approval number in the one spelling ids are built from, or None.

    Domestic numbers keep their 国药准字 prefix; import and Hong Kong, Macao
    and Taiwan registrations (H/S/Z/BH/HC… plus eight digits) drop the
    注册证号 wording some exports put in front. Anything else — health-food
    and device numbers, placeholders, two numbers in one cell — is not a drug
    label this index can address."""
    text = re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(value or ""))).upper()
    text = _REGISTRATION_PREFIX.sub("", text)
    return text if _APPROVAL.fullmatch(text) else None


def section_slug(value) -> str | None:
    """The slug for a section named by slug or by its Chinese heading."""
    text = str(value or "").strip().strip("【】[]")
    if text in SECTION_TITLES:
        return text
    lowered = text.casefold()
    if lowered in SECTION_TITLES:
        return lowered
    return SECTION_ALIASES.get(text)


def label_id(approval: str) -> str:
    return "label:%s" % approval


def section_id(approval: str, section: str) -> str:
    return "label:%s#%s" % (approval, section)


def parse_label_id(value) -> tuple[str, str | None]:
    """`label:<approval>[#<section>]` (or a bare approval number) → parts."""
    match = _LABEL_ID.fullmatch(unicodedata.normalize("NFKC", str(value or "")).strip())
    approval = canonical_approval(match.group(1)) if match else None
    if approval is None:
        raise DrugLabelIndexError(
            "drug_label_id_invalid",
            "labelId must be label:<approval number> as a drug_label_search result gives it, for example label:国药准字H19990280.",
        )
    section = None
    if match.group(2) is not None:
        section = section_slug(match.group(2))
        if section is None:
            raise DrugLabelIndexError("drug_label_section_unknown", _unknown_sections_message([match.group(2)]))
    return approval, section


def _unknown_sections_message(names) -> str:
    return "Unknown label section %s. Sections are: %s." % (
        ", ".join(str(name) for name in names), ", ".join(slug for slug, _title in SECTIONS)
    )


def capture_root(approval: str) -> str:
    """Where a label's preserved sections live, relative to the workspace.

    `locate_quote` resolves `label:<approval>#<section>` through the same
    function, so the two can never disagree about the path."""
    digest = hashlib.sha256(("evimed-label:%s" % approval).encode("utf-8")).hexdigest()[:16]
    return "%s/%s" % (CAPTURE_DIR, digest)


# ---------------------------------------------------------------------------
# Search text: the same splitting on both sides of the index
# ---------------------------------------------------------------------------
def search_text(values) -> str:
    """Index text for names and ingredients: case-folded, with every run of
    Chinese characters also written out as bigrams, because the tokenizer has
    no word boundary to find inside one. Latin and Chinese are split apart so
    `维C银翘片` is findable as 维C and as 银翘."""
    text = " ".join(
        _SCRIPT_BOUNDARY.sub(" ", unicodedata.normalize("NFKC", str(value)).casefold())
        for value in values if value
    )
    bigrams = []
    for run in _CJK_RUN.findall(text):
        bigrams.extend(run[index:index + 2] for index in range(len(run) - 1))
    return " ".join([text, *bigrams]) if bigrams else text


def fts_query(*values) -> str | None:
    """An FTS5 expression every term of which must match, or None when the
    input names nothing searchable. A Chinese run of three or more
    characters becomes its bigrams; a Latin or numeric token of two or more
    characters matches as a prefix."""
    text = " ".join(
        _SCRIPT_BOUNDARY.sub(" ", unicodedata.normalize("NFKC", str(value)).casefold())
        for value in values if value
    )
    terms = []
    for token in _QUERY_TOKEN.findall(text)[:32]:
        if _CJK_RUN.fullmatch(token):
            if len(token) >= 3:
                terms.extend('"%s"' % token[index:index + 2] for index in range(len(token) - 1))
            else:
                terms.append('"%s"' % token)
        elif len(token) >= 2:
            terms.append('"%s"*' % token.replace('"', '""'))
        else:
            terms.append('"%s"' % token)
    terms = list(dict.fromkeys(terms))
    return " AND ".join(terms) if terms else None


# ---------------------------------------------------------------------------
# The file
# ---------------------------------------------------------------------------
def database_path() -> str | None:
    """The configured index file, None when there is none to read.

    Unset and absent are the same answer: a deployment that has not shipped
    the file yet searches the other label connectors. A path that is set but
    wrong — relative, a symlink, not a regular file, or implausibly sized — is
    refused as invalid rather than treated as absent."""
    configured = os.environ.get(DATABASE_ENV, "").strip()
    if not configured:
        return None
    if not os.path.isabs(configured) or "\0" in configured:
        raise DrugLabelIndexError("drug_label_index_invalid", "%s must be an absolute path." % DATABASE_ENV)
    try:
        metadata = os.lstat(configured)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise DrugLabelIndexError("drug_label_index_invalid", "The drug-label index cannot be read.") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise DrugLabelIndexError("drug_label_index_invalid", "The drug-label index is not a regular file.")
    if metadata.st_size <= 0 or metadata.st_size > MAX_DATABASE_BYTES:
        raise DrugLabelIndexError("drug_label_index_invalid", "The drug-label index has an implausible size.")
    return configured


def configured() -> bool:
    try:
        return database_path() is not None
    except DrugLabelIndexError:
        return False


def _connect(path: str) -> sqlite3.Connection:
    uri = "file:%s?mode=ro&immutable=1" % urllib.parse.quote(path)
    try:
        connection = sqlite3.connect(uri, uri=True)
        schema = connection.execute("SELECT value FROM metadata WHERE key = 'schema'").fetchone()
    except sqlite3.Error as error:
        raise DrugLabelIndexError("drug_label_index_invalid", "The drug-label index cannot be opened.") from error
    if schema != (SCHEMA,):
        connection.close()
        raise DrugLabelIndexError("drug_label_index_invalid", "The drug-label index was built for another schema.")
    return connection


def _metadata(connection) -> dict:
    return {key: value for key, value in connection.execute("SELECT key, value FROM metadata")}


def status() -> dict:
    """What `/health` and the research server's health report say about it."""
    try:
        path = database_path()
    except DrugLabelIndexError as error:
        return {"configured": False, "error": error.code}
    if path is None:
        return {"configured": False}
    try:
        connection = _connect(path)
    except DrugLabelIndexError as error:
        return {"configured": False, "error": error.code}
    try:
        metadata = _metadata(connection)
    finally:
        connection.close()
    return {
        "configured": True,
        "release": metadata.get("release"),
        "labels": int(metadata.get("label_count") or 0),
        "builtAt": metadata.get("built_at"),
    }


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------
_LABEL_COLUMNS = (
    "id, approval, generic_name, trade_name, product_name, manufacturer, category, rx_class, "
    "national_code, origin, source_url, version, revised_at, alternates, aliases_json"
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _row(record) -> dict:
    keys = [name.strip() for name in _LABEL_COLUMNS.split(",")]
    return dict(zip(keys, record))


def _snapshot(metadata: dict, origin: str) -> str:
    snapshots = json.loads(metadata.get("snapshots_json") or "{}")
    return snapshots.get(origin) or origin


def _source_record(row: dict) -> dict:
    title = row["generic_name"] or row["product_name"] or row["approval"]
    if row["manufacturer"]:
        title = "%s（%s）" % (title, row["manufacturer"])
    record = {
        "id": label_id(row["approval"]),
        "title": title,
        "source": SOURCE_NAME,
        "retrievedAt": _now(),
        "evidenceAccess": "regulatory_record",
    }
    if row["source_url"]:
        record["url"] = row["source_url"]
    return record


def _label_summary(row: dict, metadata: dict) -> dict:
    aliases = json.loads(row["aliases_json"] or "{}")
    value = {
        "id": label_id(row["approval"]),
        "labelId": label_id(row["approval"]),
        "approvalNumber": row["approval"],
        "genericName": row["generic_name"],
        "tradeName": row["trade_name"],
        "productName": row["product_name"],
        "manufacturer": row["manufacturer"],
        "category": row["category"],
        "rxClass": row["rx_class"],
        "nationalDrugCode": row["national_code"],
        "revisedAt": row["revised_at"],
        "version": row["version"],
        "snapshot": _snapshot(metadata, row["origin"]),
        "sourceUrl": row["source_url"],
        "jurisdiction": JURISDICTION,
    }
    others = {key: values for key, values in aliases.items() if values}
    if others:
        value["otherNames"] = others
    if row["alternates"]:
        value["alternateVersions"] = row["alternates"]
    return {key: item for key, item in value.items() if item not in (None, "", [], {})}


def _sections(connection, label_rowid: int) -> list[tuple[str, str, int, str | None]]:
    rows = connection.execute(
        "SELECT s.section, t.body, s.chars, s.flags FROM sections s JOIN texts t ON t.id = s.text WHERE s.label = ?",
        (label_rowid,),
    ).fetchall()
    return sorted(rows, key=lambda row: SECTION_ORDER.get(row[0], len(SECTION_ORDER)))


def _bounded_limit(value) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return SEARCH_LIMIT_DEFAULT
    return max(1, min(number, SEARCH_LIMIT_MAX))


def search(arguments: dict, path: str) -> dict:
    """Labels for a drug, product, manufacturer or approval number.

    An approval number is looked up exactly. Otherwise every term must match
    the label's names, ingredients or holder, names weighing most; when a
    product or manufacturer narrows the search to nothing, the drug alone is
    searched and the result says so."""
    drug = str(arguments.get("drug") or "").strip()
    product = str(arguments.get("product") or "").strip()
    manufacturer = str(arguments.get("manufacturer") or "").strip()
    limit = _bounded_limit(arguments.get("limit", SEARCH_LIMIT_DEFAULT))
    connection = _connect(path)
    widened = False
    try:
        metadata = _metadata(connection)
        rows = []
        approval = canonical_approval(drug) or canonical_approval(product)
        if approval:
            rows = connection.execute(
                "SELECT %s FROM labels WHERE approval = ?" % _LABEL_COLUMNS, (approval,)
            ).fetchall()
        if not rows:
            rows = _match(connection, fts_query(drug, product, manufacturer), drug or product, limit)
            if not rows and (product or manufacturer) and drug:
                rows = _match(connection, fts_query(drug), drug, limit)
                widened = bool(rows)
        items, sources = [], []
        for record in rows:
            row = _row(record)
            sections = _sections(connection, row["id"])
            item = _label_summary(row, metadata)
            item["sections"] = [section for section, _body, _chars, _flags in sections]
            indications = next((body for section, body, _chars, _flags in sections if section == "indications"), "")
            if indications:
                item["indicationsPreview"] = indications[:PREVIEW_CHARS] + ("…" if len(indications) > PREVIEW_CHARS else "")
            items.append(item)
            sources.append(_source_record(row))
    except sqlite3.Error as error:
        raise DrugLabelIndexError("drug_label_index_invalid", "The drug-label index cannot be queried.") from error
    finally:
        connection.close()
    release = metadata.get("release")
    warnings = [
        "These labels come from the EviMed drug-label index (%s), a snapshot of public label databases: "
        "a label may have been revised since, and a scraped field can be cut short or misplaced. "
        "Check the current NMPA-approved label before relying on a detail." % release
    ]
    if widened:
        warnings.insert(0, "No label matched the drug together with the product or manufacturer given; these are labels for the drug alone.")
    return {
        "status": "warning",
        "summary": "Found %d Chinese drug label%s in the EviMed drug-label index." % (len(items), "" if len(items) == 1 else "s"),
        "data": {"items": items, "indexRelease": release, "labelJurisdiction": JURISDICTION},
        "sources": sources,
        "warnings": warnings,
        "next_actions": [
            "Read the sections you need with drug_label_search {labelId, sections}; they are preserved for citation as label:<approval>#<section>.",
            "For a United States label, search again with jurisdiction US.",
        ],
    }


def _match(connection, query: str | None, name: str, limit: int) -> list:
    if not query:
        return []
    return connection.execute(
        """
        SELECT %s FROM labels_fts JOIN labels l ON l.id = labels_fts.rowid
        WHERE labels_fts MATCH ?
        ORDER BY (l.generic_name = ?) DESC, bm25(labels_fts, 8.0, 1.0), l.approval
        LIMIT ?
        """ % ", ".join("l.%s" % column.strip() for column in _LABEL_COLUMNS.split(",")),
        (query, name, limit),
    ).fetchall()


def read(arguments: dict, path: str) -> dict:
    """One label with the full text of every section it has.

    The research server preserves what this returns before a run sees it, and
    trims the text to the sections asked for; the adapter that answers here
    has no workspace to write into."""
    approval, named_section = parse_label_id(arguments.get("labelId"))
    requested = requested_sections(arguments.get("sections"), named_section)
    connection = _connect(path)
    try:
        metadata = _metadata(connection)
        record = connection.execute("SELECT %s FROM labels WHERE approval = ?" % _LABEL_COLUMNS, (approval,)).fetchone()
        if record is None:
            raise DrugLabelIndexError(
                "drug_label_not_found",
                "The drug-label index has no label for %s. Search with drug_label_search to find the approval number." % approval,
            )
        row = _row(record)
        sections = _sections(connection, row["id"])
    except sqlite3.Error as error:
        raise DrugLabelIndexError("drug_label_index_invalid", "The drug-label index cannot be queried.") from error
    finally:
        connection.close()
    label = _label_summary(row, metadata)
    label["indexRelease"] = metadata.get("release")
    label["sections"] = [
        {
            "section": section,
            "title": SECTION_TITLES.get(section, section),
            "sectionId": section_id(approval, section),
            "chars": chars,
            "text": body,
            **({"possiblyTruncated": True} if flags and "possibly-truncated" in flags.split(",") else {}),
        }
        for section, body, chars, flags in sections
    ]
    if requested:
        label["requestedSections"] = requested
    name = label.get("genericName") or label.get("productName") or approval
    return {
        "status": "warning",
        "summary": "Read the label of %s (%s) from the EviMed drug-label index." % (name, approval),
        "data": {"label": label},
        "sources": [_source_record(row)],
        "warnings": [
            "This label text comes from the EviMed drug-label index (%s), a snapshot of public label databases (%s). "
            "It may have been revised since; check the current NMPA-approved label before relying on a detail."
            % (metadata.get("release"), _snapshot(metadata, row["origin"]))
        ],
        "next_actions": [
            "Quote a section verbatim from its preserved file and cite it by its sectionId; locate_quote checks a quotation against it.",
        ],
    }


def requested_sections(value, named_section: str | None = None) -> list[str]:
    """The section slugs a read asked for, in label order; empty means all."""
    names = list(value or [])
    if named_section:
        names.append(named_section)
    slugs, unknown = [], []
    for name in names:
        slug = section_slug(name)
        if slug is None:
            unknown.append(name)
        elif slug not in slugs:
            slugs.append(slug)
    if unknown:
        raise DrugLabelIndexError("drug_label_section_unknown", _unknown_sections_message(unknown))
    return sorted(slugs, key=lambda slug: SECTION_ORDER[slug])


# ---------------------------------------------------------------------------
# Preservation: what a read writes into the workspace
# ---------------------------------------------------------------------------
LABEL_METADATA_NAME = "label.json"


def capture_artifacts(label: dict) -> dict[str, bytes]:
    """The files one label read preserves: every section as `<slug>.md`, and
    `label.json` saying which label, holder and index release they are.

    The whole label, not only the sections asked for, so one label text is
    one capture version however it is read, and a later citation of another
    section already has its bytes on disk. Deterministic: no timestamp."""
    approval = canonical_approval(label.get("approvalNumber"))
    sections = label.get("sections")
    if approval is None or not isinstance(sections, list) or not sections:
        raise DrugLabelIndexError("drug_label_index_invalid", "The label read carried no sections to preserve.")
    artifacts: dict[str, bytes] = {}
    for entry in sections:
        slug = section_slug(entry.get("section")) if isinstance(entry, dict) else None
        text = entry.get("text") if isinstance(entry, dict) else None
        if slug is None or not isinstance(text, str) or not text.strip():
            raise DrugLabelIndexError("drug_label_index_invalid", "The label read carried a malformed section.")
        artifacts["%s.md" % slug] = (text.rstrip("\n") + "\n").encode("utf-8")
    metadata = {
        key: label[key]
        for key in (
            "labelId", "approvalNumber", "genericName", "tradeName", "productName", "manufacturer", "category",
            "rxClass", "nationalDrugCode", "revisedAt", "version", "indexRelease", "snapshot", "sourceUrl", "jurisdiction",
        )
        if label.get(key) not in (None, "")
    }
    metadata["sections"] = [
        {"section": section_slug(entry["section"]), "title": SECTION_TITLES[section_slug(entry["section"])],
         "sectionId": section_id(approval, section_slug(entry["section"])),
         **({"possiblyTruncated": True} if entry.get("possiblyTruncated") else {})}
        for entry in sections
    ]
    artifacts[LABEL_METADATA_NAME] = (
        json.dumps(metadata, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    ).encode("utf-8")
    return artifacts
