"""Terminology lookup behind `term_normalize`: the names a medical term goes by, in Chinese and English, with the codes of the vocabularies that carry it.

The data is one read-only SQLite file built by `scripts/ops/build-terminology.mjs` from the vocabularies the platform may use (MeSH and its Chinese
edition, the NCI Thesaurus, the Human Phenotype Ontology with its Chinese labels, HGNC, CIViC, ICD-10 in its national-insurance edition, and the curated
zh-en bridge). It is configured by `EVIMED_TERMINOLOGY_DB` (an absolute path), the way the pharmacy reference is: read in this process where the file is
local, and served by the evidence adapter (`/api/v1/evimed/terminology-lookup`) to the runtimes that cannot see it.

A lookup is a tool result, never a verdict. It finds the entities whose names match the term — exactly (case, width and spacing folded), by a code, by the
start of a name, or by the words of a name — and returns what each entity is called and coded. A missing, unreadable or foreign file answers
`available: false` with a reason, and the caller goes on with its built-in table; nothing here raises into a turn.
"""
import json
import os
import re
import sqlite3
import stat
import unicodedata
import urllib.parse
from datetime import datetime, timezone

RELEASE = "evimed-terminology-v1"
ENV_DB = "EVIMED_TERMINOLOGY_DB"
MAX_DB_BYTES = 1024 * 1024 * 1024
SCALES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "clinical-scales.json")

# The entity types the file reports (the builder's `CONCEPT_TYPES`).
KINDS = ("disease", "finding", "drug", "chemical", "gene", "variant", "procedure", "lab", "anatomy", "organism", "phenotype", "other")

TERM_MAX_CHARS = 200
LIMIT_DEFAULT = 5
LIMIT_MAX = 10
SYNONYMS_PER_LANGUAGE = 10
SYNONYM_MAX_CHARS = 80
ABBREVIATIONS_MAX = 6
CODES_MAX = 24
CODES_PER_SYSTEM = 3
# How many rows of a prefix scan are looked at, and how many entities each stage hands on to ranking.
PREFIX_ROWS = 3000
STAGE_ENTITIES = 60

# The order a reader looks for a code in: the clinical coding systems first, the identifiers of genes and variants after.
CODE_SYSTEMS = (
    "ICD-10", "ICD-10-CN", "MeSH", "NCIt", "HPO", "HGNC", "Entrez Gene", "OMIM", "UniProt", "Ensembl",
    "CIViC gene", "CIViC variant", "ClinVar", "ClinGen Allele Registry", "MeSH tree",
)

_CJK = re.compile("[㐀-鿿豈-﫿]")
_CJK_RUNS = re.compile("[㐀-鿿豈-﫿]+|[^㐀-鿿豈-﫿]+")
_WORDS = re.compile(r"[^\W_]+")
_CODE_SHAPE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.:_/-]{0,39}$")


class TerminologyError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


_DASHES = re.compile("[-\u2010-\u2015_]")


def fold(value):
    """The form names are compared in: width and compatibility folded, lower case, dashes and underscores read as spaces, spaces collapsed. The
    builder (`scripts/ops/terminology-sources.mjs`) folds the same way."""
    return " ".join(_DASHES.sub(" ", unicodedata.normalize("NFKC", str(value or "")).lower()).split())


def has_cjk(value):
    return bool(_CJK.search(value or ""))


def search_words(value):
    """The words full-text search indexes: Chinese runs as overlapping character pairs, everything else as its own words."""
    out = []
    for piece in _CJK_RUNS.findall(fold(value)):
        if has_cjk(piece):
            if len(piece) == 1:
                out.append(piece)
            else:
                out.extend(piece[index:index + 2] for index in range(len(piece) - 1))
        else:
            out.extend(_WORDS.findall(piece))
    return out


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# The file
# ---------------------------------------------------------------------------

def configured():
    return bool(os.environ.get(ENV_DB, "").strip())


def _database_file():
    path = os.environ.get(ENV_DB, "").strip()
    if not path:
        raise TerminologyError("terminology_unconfigured", "No terminology file is configured for this runtime.")
    if not os.path.isabs(path) or "\0" in path:
        raise TerminologyError("terminology_invalid", "The terminology file must be given as an absolute path.")
    try:
        metadata = os.lstat(path)
    except OSError as error:
        raise TerminologyError("terminology_unavailable", "The terminology file is not readable here.") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode) or metadata.st_size <= 0 or metadata.st_size > MAX_DB_BYTES:
        raise TerminologyError("terminology_invalid", "The terminology file is not a bounded regular file.")
    return path


def _connect():
    path = _database_file()
    try:
        connection = sqlite3.connect("file:%s?mode=ro&immutable=1" % urllib.parse.quote(path), uri=True, timeout=2)
        connection.execute("PRAGMA query_only = ON")
        release = connection.execute("SELECT value FROM metadata WHERE key = 'release'").fetchone()
    except sqlite3.Error as error:
        raise TerminologyError("terminology_invalid", "The terminology file cannot be read.") from error
    if release != (RELEASE,):
        connection.close()
        raise TerminologyError("terminology_invalid", "The terminology file is not a release this reader knows.")
    return connection


def status():
    """What is configured and what the file holds, for health and for the answer's provenance. Never raises."""
    if not configured():
        return {"configured": False, "available": False, "reason": "terminology_unconfigured"}
    try:
        connection = _connect()
    except TerminologyError as error:
        return {"configured": True, "available": False, "reason": error.code}
    try:
        meta = dict(connection.execute("SELECT key, value FROM metadata").fetchall())
        sources = [dict(zip(("id", "version", "concepts"), row)) for row in connection.execute("SELECT id, version, concepts FROM sources ORDER BY id")]
    except sqlite3.Error:
        return {"configured": True, "available": False, "reason": "terminology_invalid"}
    finally:
        connection.close()
    return {"configured": True, "available": True, "release": meta.get("release"), "entities": int(meta.get("entities", 0)), "sources": sources}


# ---------------------------------------------------------------------------
# Lookup
# ---------------------------------------------------------------------------

def _rank_key(prefer):
    def key(row):
        entity = row["entity"]
        types = set(entity["types"].split("|"))
        return (
            row["stage"],
            0 if prefer and types & prefer else 1,
            row["kind"],
            -len(entity["sources"].split(",")),
            0 if entity["en"] and entity["zh"] else 1,
            entity["id"],
        )
    return key


def _stage_exact(connection, folded):
    return [(row[0], row[1]) for row in connection.execute(
        "SELECT entity_id, MIN(kind) FROM lookup WHERE folded = ? GROUP BY entity_id LIMIT ?", (folded, STAGE_ENTITIES))]


def _stage_code(connection, term):
    text = term.strip()
    if not _CODE_SHAPE.match(text) or not any(char.isdigit() for char in text):
        return []
    values = {text, text.upper()}
    found = []
    for value in values:
        found.extend((row[0], 0) for row in connection.execute("SELECT entity_id FROM code_lookup WHERE code = ? LIMIT ?", (value, STAGE_ENTITIES)))
    return found


def _stage_prefix(connection, folded):
    if len(folded) < (2 if has_cjk(folded) else 3):
        return []
    return [(row[0], row[1]) for row in connection.execute(
        "SELECT entity_id, MIN(kind) FROM (SELECT entity_id, kind FROM lookup WHERE folded >= ? AND folded < ? LIMIT ?) "
        "GROUP BY entity_id ORDER BY MIN(kind), entity_id LIMIT ?",
        (folded, folded + "\U0010ffff", PREFIX_ROWS, STAGE_ENTITIES))]


def _stage_words(connection, term):
    words = search_words(term)[:12]
    if not words:
        return []
    match = " ".join('"%s"' % word.replace('"', '""') for word in words[:-1] + [words[-1]])
    if len(words[-1]) >= 2:
        match = match[:-1] + '"*'
    try:
        return [(row[0], 1) for row in connection.execute("SELECT rowid FROM entity_fts WHERE entity_fts MATCH ? ORDER BY rank LIMIT ?", (match, STAGE_ENTITIES))]
    except sqlite3.Error:
        return []


def _parse_detail(detail, letters):
    lines = detail.split("\n")
    cut = lines.index("#") if "#" in lines else len(lines)
    terms = []
    for line in lines[:cut]:
        if len(line) >= 4:
            terms.append({"lang": "zh" if line[0] == "z" else "en", "kind": int(line[1]) if line[1].isdigit() else 1, "source": letters.get(line[2], line[2]), "text": line[3:]})
    codes = []
    for line in lines[cut + 1:]:
        if "\t" in line and len(line) > 2:
            system, code = line[1:].split("\t", 1)
            codes.append({"system": system, "code": code, "source": letters.get(line[0], line[0])})
    return terms, codes


def _present(entity, matched, stage, letters, language):
    terms, codes = _parse_detail(entity["detail"], letters)
    names = {fold(entity["en"] or ""), fold(entity["zh"] or "")}
    synonyms = {"en": [], "zh": []}
    abbreviations = []
    for term in terms:
        key = fold(term["text"])
        if key in names:
            continue
        if term["kind"] == 2:
            if len(abbreviations) < ABBREVIATIONS_MAX and term["text"] not in abbreviations:
                abbreviations.append(term["text"])
        elif len(term["text"]) <= SYNONYM_MAX_CHARS and len(synonyms[term["lang"]]) < SYNONYMS_PER_LANGUAGE and term["text"] not in synonyms[term["lang"]]:
            synonyms[term["lang"]].append(term["text"])
    if language in ("en", "zh"):
        synonyms = {key: (value if key == language else []) for key, value in synonyms.items()}
    per_system = {}
    shown = []
    order = {system: index for index, system in enumerate(CODE_SYSTEMS)}
    for code in sorted(codes, key=lambda item: order.get(item["system"], len(order))):
        taken = per_system.get(code["system"], 0)
        if taken >= CODES_PER_SYSTEM or len(shown) >= CODES_MAX:
            continue
        per_system[code["system"]] = taken + 1
        shown.append(code)
    return {
        "concept": entity["en"] or entity["zh"],
        "english": entity["en"], "chinese": entity["zh"],
        "types": entity["types"].split("|"),
        "synonyms": synonyms,
        **({"abbreviations": abbreviations} if abbreviations else {}),
        "codes": shown,
        "sources": entity["sources"].split(","),
        "matchedOn": {"text": matched, "how": stage},
    }


STAGE_NAMES = ("exact", "code", "prefix", "words")


def lookup(term, limit=LIMIT_DEFAULT, language=None, kinds=None, prefer=None):
    """The entities a term names. Never raises: a file that is not there is `available: false` with a reason.

    `kinds` keeps only entities of those types; `prefer` (a set of types) only puts such entities first; `language` ('zh' or 'en') returns the
    synonyms in that language only (the term itself may be in either)."""
    text = " ".join(str(term or "").split())
    if not text or len(text) > TERM_MAX_CHARS:
        return {"available": True, "release": RELEASE, "term": text[:TERM_MAX_CHARS], "matches": [], "reason": "term_invalid"}
    limit = max(1, min(LIMIT_MAX, int(limit or LIMIT_DEFAULT)))
    kinds = set(kinds or [])
    prefer = set(prefer or [])
    try:
        connection = _connect()
    except TerminologyError as error:
        return {"available": False, "reason": error.code}
    try:
        folded = fold(text)
        letters = dict(connection.execute("SELECT letter, id FROM sources").fetchall())
        stages = [(0, _stage_exact(connection, folded)), (1, _stage_code(connection, text))]
        if not any(found for _, found in stages) or sum(len(found) for _, found in stages) < limit:
            stages.append((2, _stage_prefix(connection, folded)))
        if not any(found for _, found in stages):
            stages.append((3, _stage_words(connection, text)))
        best = {}
        for stage, found in stages:
            for entity_id, kind in found:
                held = best.get(entity_id)
                if held is None or (stage, kind) < (held[0], held[1]):
                    best[entity_id] = (stage, kind)
        rows = []
        ids = list(best)
        for start in range(0, len(ids), 100):
            chunk = ids[start:start + 100]
            for row in connection.execute(
                "SELECT id, en, zh, types, sources, detail FROM entities WHERE id IN (%s)" % ",".join("?" * len(chunk)), chunk
            ):
                entity = dict(zip(("id", "en", "zh", "types", "sources", "detail"), row))
                if kinds and not (set(entity["types"].split("|")) & kinds):
                    continue
                rows.append({"entity": entity, "stage": best[entity["id"]][0], "kind": best[entity["id"]][1]})
        rows.sort(key=_rank_key(prefer))
        matches = [_present(row["entity"], text, STAGE_NAMES[row["stage"]], letters, language) for row in rows[:limit]]
        used = sorted({source for match in matches for source in match["sources"]})
        sources = []
        if used:
            for row in connection.execute("SELECT id, name, version, license, attribution FROM sources WHERE id IN (%s) ORDER BY id" % ",".join("?" * len(used)), used):
                sources.append(dict(zip(("id", "name", "version", "license", "attribution"), row)))
        return {
            "available": True, "release": RELEASE, "term": text, "queryLanguage": "zh" if has_cjk(text) else "en",
            "matches": matches, "found": len(rows), "sources": sources,
        }
    except sqlite3.Error:
        return {"available": False, "reason": "terminology_invalid"}
    finally:
        connection.close()


# ---------------------------------------------------------------------------
# Scale definitions
# ---------------------------------------------------------------------------

_SCALES = None


def scales():
    """The committed scale definitions (`data/clinical-scales.json`), or an empty list when the file cannot be read."""
    global _SCALES
    if _SCALES is None:
        try:
            with open(SCALES_FILE, encoding="utf-8") as handle:
                data = json.load(handle)
            _SCALES = {"note": str(data.get("note") or ""), "scales": [item for item in data.get("scales", []) if isinstance(item, dict)]}
        except (OSError, ValueError):
            _SCALES = {"note": "", "scales": []}
    return _SCALES


def scale(name):
    """The definition of the scale a name (or alias, either language) points at, or None."""
    wanted = fold(name)
    compact = re.sub(r"[\s_-]+", "", wanted)
    for item in scales()["scales"]:
        names = [item.get("id", ""), item.get("name", "")] + list(item.get("aliases", []))
        if any(fold(candidate) == wanted or re.sub(r"[\s_-]+", "", fold(candidate)) == compact for candidate in names if candidate):
            return item
    return None


def scale_names():
    return [item.get("name") for item in scales()["scales"]]


# ---------------------------------------------------------------------------
# The adapter's answer
# ---------------------------------------------------------------------------

def adapter_result(arguments):
    """A lookup as the evidence adapter answers it (a ToolResult): the matches with the file as their source, or a warning that says the file is not there."""
    outcome = lookup(arguments.get("term"), arguments.get("limit", LIMIT_DEFAULT), arguments.get("language"), arguments.get("kinds"), arguments.get("prefer"))
    if not outcome.get("available"):
        return {
            "status": "warning",
            "summary": "The terminology file is not available in this deployment.",
            "warnings": ["The terminology lookup is unavailable (%s); only the built-in vocabulary can be used." % outcome.get("reason", "terminology_unavailable")],
            "next_actions": ["Continue with the built-in vocabulary, and say the term was not looked up in the terminology file."],
        }
    return {
        "status": "success",
        "summary": "Found %d terminology matches for the term." % len(outcome.get("matches", [])),
        "data": outcome,
        "sources": [{"id": RELEASE, "source": "evimed-terminology", "retrievedAt": _now(), "title": "EviMed terminology %s" % RELEASE}],
    }
