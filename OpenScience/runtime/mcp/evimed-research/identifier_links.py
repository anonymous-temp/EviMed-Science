"""Linked identifiers: PMID, PMCID and DOI resolved to one another as one operation, with a preserved answer.

Hidden knowledge, from the live wire (2026-10-04) and not from the documentation:

- **The ID converter only knows PMC.** `pmc.ncbi.nlm.nih.gov/tools/idconv` answers
  "Identifier not found in PMC" for a PMID that exists in PubMed and has no PMC
  copy. That is an answer about PMC, not about the PMID, so it is read as
  "no PMCID" (`inPmc: false`) and the PMID is then asked of PubMed, which is the
  authority for whether it exists. A wrong identifier is the one no source holds.
- **All ids in one request must be one type.** A request mixing PMIDs, PMCIDs
  and DOIs is refused with `invalid_pmids`; the type is read from the first id
  unless `idtype` is given. So the ids are grouped by type and one request is
  made per type.
- **Europe PMC lower-cases the DOIs it returns** and the converter returns them as
  registered; a DOI is compared case-insensitively and reported as the primary
  source registered it.
- **Crossref's batch lookup omits what it does not hold.** A DOI Crossref has no
  record of is absent from the list, not an error.

The operation, in the order it asks: the ID converter once per identifier type
(PMC's own mapping, with the article's PMC versions); Europe PMC for what the
converter could not place (the existing fallback); PubMed for every PMID that is
known (existence, title, the DOI PubMed records, a second opinion on the link);
Crossref for a DOI nothing else has seen. Each source that answered is named on
the item it answered for, and two sources that disagree about a linked identifier
make the item a `conflict` listing who said what, never a silent pick.

An identifier ends in one of five statuses, each a named outcome and none of them
withholding anything: `resolved`, `conflict`, `not_found` (a source answered and
holds nothing: not evidence that the paper does not exist), `invalid` (not a
PMID, a PMCID or a DOI: nothing was asked) and `unchecked` (every source asked
failed, so no answer exists). What could not be linked is `null` with its reason
in `unresolved`, never an empty guess.

The answer is preserved as one content-addressed file (`links.json`) so the same
request later reads the same bytes, and a changed answer is a new version beside
the old one. The bytes carry no timestamp: the retrieval time is on the source
records.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

import public_sources
import source_outcome
import source_transport as transport
from immutable_capture import managed_workspace, preserve

MAX_IDENTIFIERS = public_sources.MAX_IDENTIFIER_BATCH
DEADLINE_SECONDS = 45.0
# Terms per Europe PMC / Crossref query: long OR chains are refused by both.
QUERY_BATCH = 20
SOURCES_ORDER = ("ncbi-idconv", "pubmed", "europe-pmc", "crossref")
SOURCE_TITLES = {
    "ncbi-idconv": "the NCBI ID converter",
    "pubmed": "PubMed",
    "europe-pmc": "Europe PMC",
    "crossref": "Crossref",
}
# The connector id a source record carries (`source_types` reads it).
SOURCE_IDS = {"ncbi-idconv": "ncbi-id-converter", "pubmed": "pubmed", "europe-pmc": "europe-pmc", "crossref": "crossref"}

_PMID = re.compile(r"^(?:PMID\s*:?\s*)?(\d{1,9})$", re.I)
_PMCID = re.compile(r"^(?:PMCID\s*:?\s*)?PMC(\d{3,10})(?:\.(\d{1,3}))?$", re.I)
_DOI = re.compile(r"^(?:doi\s*:?\s*|(?:https?://)?(?:dx\.)?doi\.org/)?(10\.\d{4,9}/\S+)$", re.I)
_PUBMED_URL = re.compile(r"^https?://pubmed\.ncbi\.nlm\.nih\.gov/(\d{1,9})/?(?:[?#].*)?$", re.I)
_PMC_URL = re.compile(
    r"^https?://(?:pmc\.ncbi\.nlm\.nih\.gov/articles/|(?:www\.)?ncbi\.nlm\.nih\.gov/pmc/articles/)PMC(\d{3,10})(?:\.\d+)?/?(?:[?#].*)?$",
    re.I,
)


def _deadline_seconds():
    try:
        return min(max(float(os.environ.get("EVIMED_IDENTIFIER_DEADLINE_SECONDS", DEADLINE_SECONDS)), 5.0), transport.MAX_DEADLINE_SECONDS)
    except ValueError:
        return DEADLINE_SECONDS


def _strip_doi_tail(value):
    text = value.rstrip(".,;:")
    # A closing bracket is part of the DOI only when its opener is.
    while text and text[-1] in ")]" and text.count({")": "(", "]": "["}[text[-1]]) < text.count(text[-1]):
        text = text[:-1].rstrip(".,;:")
    return text


def parse_identifier(raw):
    """One identifier as `{input, kind, value}`, or `{input, kind: "invalid", reason}`.

    Format checks only, over machine-written strings (a PMID is digits, a PMCID
    is PMC and digits, a DOI starts 10.): nothing here reads language.
    """
    text = raw.strip() if isinstance(raw, str) else ""
    if not text:
        return {"input": raw if isinstance(raw, str) else "", "kind": "invalid", "reason": "empty"}
    if len(text) > 300:
        return {"input": text[:80] + "...", "kind": "invalid", "reason": "too_long"}
    match = _PUBMED_URL.match(text) or _PMID.match(text)
    if match:
        return {"input": text, "kind": "pmid", "value": match.group(1)}
    match = _PMC_URL.match(text) or _PMCID.match(text)
    if match:
        suffix = match.group(2) if match.lastindex and match.lastindex >= 2 else None
        return {"input": text, "kind": "pmcid", "value": "PMC" + match.group(1), **({"requestedVersion": int(suffix)} if suffix else {})}
    match = _DOI.match(text)
    if match:
        doi = _strip_doi_tail(match.group(1))
        return {"input": text, "kind": "doi", "value": doi.casefold()}
    if any(character.isspace() for character in text) and text.casefold().startswith(("doi", "10.")):
        return {"input": text, "kind": "invalid", "reason": "doi_contains_whitespace"}
    return {"input": text, "kind": "invalid", "reason": "not_a_pmid_pmcid_or_doi"}


class _Item:
    """One identifier and everything the sources said about it."""

    def __init__(self, parsed):
        self.input = parsed["input"]
        self.kind = parsed["kind"]
        self.value = parsed.get("value")
        self.requested_version = parsed.get("requestedVersion")
        self.invalid_reason = parsed.get("reason")
        self.duplicate_of = None
        self.observed = {}     # source -> {pmid, pmcid, doi, title, year}
        self.found_by = []     # sources that hold it
        self.absent_from = []  # sources that answered and hold nothing
        self.failed = []       # SourceError per source that was asked and failed
        self.in_pmc = None
        self.pmc_versions = []

    def authoritative(self):
        """The sources whose "I hold nothing" settles that no such record exists.

        The ID converter only knows PMC, so its "not found" says a PMID or a DOI
        is not in PMC and nothing about whether it exists: PubMed is the authority
        for a PMID, and a DOI that is in neither PMC nor Europe PMC may still be
        one Crossref holds.
        """
        return {"pmid": ("pubmed",), "pmcid": ("ncbi-idconv", "europe-pmc"), "doi": ("ncbi-idconv", "europe-pmc", "crossref")}[self.kind]

    def settled_absent(self):
        return all(source in self.absent_from for source in self.authoritative())

    def known(self, field):
        for source in SOURCES_ORDER:
            value = self.observed.get(source, {}).get(field)
            if value:
                return value
        return self.value if field == self.kind else None

    def asked(self, source):
        return source in self.found_by or source in self.absent_from or any(error.scope == SOURCE_TITLES[source] for error in self.failed)


def _normalize(field, value):
    text = str(value).strip()
    return text.casefold() if field == "doi" else (text.upper() if field == "pmcid" else text)


def _observe(item, source, **fields):
    record = item.observed.setdefault(source, {})
    for field, value in fields.items():
        if value not in (None, "", []):
            record[field] = str(value).strip() if field != "pmcVersions" else value
    if source not in item.found_by:
        item.found_by.append(source)


def _base(env_name, fallback):
    return public_sources._base(env_name, fallback)  # noqa: SLF001 - one validator for every base URL


def _url(base, path, params):
    return "%s/%s?%s" % (base, path.strip("/"), urllib.parse.urlencode(params, doseq=True))


def _ncbi_params(params):
    return public_sources._ncbi_params(params)  # noqa: SLF001 - the tool name, and the contact address when configured


# ----------------------------------------------------------------------------
# The sources
# ----------------------------------------------------------------------------
def _idconv(items, kind, deadline):
    """The ID converter for every item of one identifier type. Raises `SourceError`."""
    values = sorted({item.value for item in items})
    base = _base("EVIMED_IDCONV_BASE_URL", "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles")
    url = _url(base, "", _ncbi_params({
        "ids": ",".join(values), "idtype": kind, "format": "json", "versions": "yes",
    }))
    body, _ = transport.fetch_json(url, deadline=deadline, scope=SOURCE_TITLES["ncbi-idconv"], strict=False)
    if not isinstance(body, dict) or body.get("status") != "ok" or not isinstance(body.get("records"), list):
        raise source_outcome.unavailable("The NCBI ID converter answered with something that is not a list of records.",
            scope=SOURCE_TITLES["ncbi-idconv"], reason="invalid_response", retryable=False,
        )
    by_requested = {}
    for record in body["records"]:
        if isinstance(record, dict) and record.get("requested-id") is not None:
            by_requested[_normalize(kind, record["requested-id"])] = record
    for item in items:
        record = by_requested.get(_normalize(kind, item.value))
        if record is None:
            continue  # the converter was asked and did not mention it: neither found nor absent
        if record.get("status") == "error":
            item.absent_from.append("ncbi-idconv")
            item.in_pmc = False
            continue
        versions = [
            {"id": str(entry.get("pmcid")), "current": bool(entry.get("current"))}
            for entry in record.get("versions", []) if isinstance(entry, dict) and entry.get("pmcid")
        ]
        _observe(item, "ncbi-idconv", pmid=record.get("pmid"), pmcid=record.get("pmcid"), doi=record.get("doi"))
        if record.get("pmcid"):
            item.in_pmc = True
        item.pmc_versions = versions


def _esummary(items, deadline):
    """PubMed for every PMID known so far: existence, title, the DOI and PMCID it records."""
    wanted = {}
    for item in items:
        pmid = item.known("pmid")
        if pmid:
            wanted.setdefault(pmid, []).append(item)
    if not wanted:
        return
    base = _base("EVIMED_PUBMED_BASE_URL", "https://eutils.ncbi.nlm.nih.gov/entrez/eutils")
    url = _url(base, "esummary.fcgi", _ncbi_params({"db": "pubmed", "id": ",".join(sorted(wanted)), "retmode": "json"}))
    body, _ = transport.fetch_json(url, deadline=deadline, scope=SOURCE_TITLES["pubmed"], strict=False)
    result = body.get("result") if isinstance(body, dict) else None
    if not isinstance(result, dict):
        raise source_outcome.unavailable("PubMed answered with something that is not a summary list.",
            scope=SOURCE_TITLES["pubmed"], reason="invalid_response", retryable=False,
        )
    for pmid, holders in wanted.items():
        record = result.get(pmid)
        if not isinstance(record, dict):
            continue
        for item in holders:
            if "error" in record:
                # Asked for a PMID PubMed has no summary for: it holds nothing under it.
                if "pubmed" not in item.absent_from:
                    item.absent_from.append("pubmed")
                continue
            ids = {entry.get("idtype"): entry.get("value") for entry in record.get("articleids", []) if isinstance(entry, dict)}
            _observe(
                item, "pubmed", pmid=record.get("uid") or pmid, doi=ids.get("doi"), pmcid=ids.get("pmc"),
                title=record.get("title"), year=str(record.get("pubdate") or "")[:4],
            )


def _europe_pmc(items, field, deadline):
    """The existing fallback for what the ID converter could not place."""
    terms = {}
    for item in items:
        value = item.known(field)
        if value:
            terms.setdefault(value, []).append(item)
    base = _base("EVIMED_EUROPE_PMC_BASE_URL", "https://www.ebi.ac.uk/europepmc/webservices/rest")
    keys = sorted(terms)
    for start in range(0, len(keys), QUERY_BATCH):
        batch = keys[start:start + QUERY_BATCH]
        if field == "doi":
            query = " OR ".join('DOI:"%s"' % value for value in batch)
        elif field == "pmcid":
            query = " OR ".join("PMCID:%s" % value for value in batch)
        else:
            query = " OR ".join("(EXT_ID:%s AND SRC:MED)" % value for value in batch)
        url = _url(base, "search", {"query": query, "format": "json", "resultType": "lite", "pageSize": min(100, len(batch) * 2)})
        body, _ = transport.fetch_json(url, deadline=deadline, scope=SOURCE_TITLES["europe-pmc"])
        records = ((body or {}).get("resultList") or {}).get("result") if isinstance(body, dict) else None
        if not isinstance(records, list):
            raise source_outcome.unavailable("Europe PMC answered with something that is not a result list.",
                scope=SOURCE_TITLES["europe-pmc"], reason="invalid_response", retryable=False,
            )
        index = {}
        for record in records:
            if not isinstance(record, dict):
                continue
            for name in ("doi", "pmcid", "pmid"):
                if record.get(name):
                    index.setdefault((name, _normalize(name, record[name])), record)
        for value in batch:
            record = index.get((field, _normalize(field, value)))
            for item in terms[value]:
                if record is None:
                    if "europe-pmc" not in item.absent_from:
                        item.absent_from.append("europe-pmc")
                    continue
                _observe(
                    item, "europe-pmc", pmid=record.get("pmid"), pmcid=record.get("pmcid"), doi=record.get("doi"),
                    title=record.get("title"), year=record.get("pubYear"),
                )
                if record.get("inPMC") == "Y" and item.in_pmc is None:
                    item.in_pmc = True


def _crossref(items, deadline):
    """A DOI no other source has seen: does Crossref hold it, and under what title."""
    terms = {}
    for item in items:
        doi = item.known("doi")
        if doi:
            terms.setdefault(doi, []).append(item)
    base = _base("EVIMED_CROSSREF_BASE_URL", "https://api.crossref.org")
    keys = sorted(terms)
    for start in range(0, len(keys), QUERY_BATCH):
        batch = keys[start:start + QUERY_BATCH]
        url = _url(base, "works", {
            "filter": ",".join("doi:%s" % value for value in batch), "select": "DOI,title,type,issued", "rows": len(batch),
        })
        body, _ = transport.fetch_json(url, deadline=deadline, scope=SOURCE_TITLES["crossref"])
        found = {}
        for record in (((body or {}).get("message") or {}).get("items") or []) if isinstance(body, dict) else []:
            if isinstance(record, dict) and record.get("DOI"):
                found[_normalize("doi", record["DOI"])] = record
        for doi in batch:
            record = found.get(_normalize("doi", doi))
            for item in terms[doi]:
                if record is None:
                    if "crossref" not in item.absent_from:
                        item.absent_from.append("crossref")
                    continue
                title = record.get("title")
                parts = ((record.get("issued") or {}).get("date-parts") or [[None]])[0]
                _observe(
                    item, "crossref", doi=record.get("DOI"), title=title[0] if isinstance(title, list) and title else title,
                    year=parts[0] if parts else None,
                )


# ----------------------------------------------------------------------------
# One answer per identifier
# ----------------------------------------------------------------------------
def _conflicts(item):
    found = []
    for field in ("pmid", "pmcid", "doi"):
        values = {}
        for source in SOURCES_ORDER:
            value = item.observed.get(source, {}).get(field)
            if value:
                values.setdefault(_normalize(field, value), {})[source] = value
        if len(values) > 1:
            found.append({"field": field, "values": {source: shown for group in values.values() for source, shown in group.items()}})
    return found


def _record(item):
    """The item's final answer: one status, the linked identifiers, and what is unknown and why."""
    if item.kind == "invalid":
        return {"input": item.input, "status": "invalid", "reason": item.invalid_reason}
    linked = {field: item.known(field) for field in ("pmid", "pmcid", "doi")}
    conflicts = _conflicts(item)
    if conflicts:
        status = "conflict"
    elif item.found_by:
        status = "resolved"
    elif item.settled_absent():
        status = "not_found"
    else:
        status = "unchecked"
    record = {"input": item.input, "kind": item.kind, "status": status, **{field: value for field, value in linked.items()}}
    if item.duplicate_of is not None:
        record["duplicateOf"] = item.duplicate_of
    if status in ("resolved", "conflict"):
        # The DOI as the source that registered it wrote it (the converter and
        # Crossref keep the registrant's case); matching above is case-insensitive.
        for source in ("ncbi-idconv", "crossref", "pubmed", "europe-pmc"):
            registered = item.observed.get(source, {}).get("doi")
            if registered:
                record["doi"] = registered
                break
        title = next((item.observed[source]["title"] for source in SOURCES_ORDER if item.observed.get(source, {}).get("title")), None)
        year = next((item.observed[source]["year"] for source in SOURCES_ORDER if item.observed.get(source, {}).get("year")), None)
        if title:
            record["title"] = title
        if year:
            record["year"] = year
        record["inPmc"] = item.in_pmc
        if item.pmc_versions:
            record["pmcVersions"] = item.pmc_versions
        if item.requested_version is not None:
            current = next((entry for entry in item.pmc_versions if entry.get("current")), None)
            record["requestedVersion"] = item.requested_version
            record["requestedVersionIsCurrent"] = (
                None if current is None else current["id"].endswith(".%d" % item.requested_version)
            )
        record["resolvedBy"] = [source for source in SOURCES_ORDER if source in item.found_by]
    unresolved = {}
    if status in ("resolved", "conflict"):
        for field in ("pmid", "pmcid", "doi"):
            if linked[field]:
                continue
            if field == "pmcid":
                unresolved[field] = "not_in_pmc" if item.in_pmc is False else ("not_asked" if item.in_pmc is None else "not_reported")
            elif field == "pmid":
                unresolved[field] = "not_indexed_in_pubmed" if "pubmed" in item.absent_from or "pubmed" in item.found_by else "not_reported"
            else:
                unresolved[field] = "no_doi_recorded"
    if unresolved:
        record["unresolved"] = unresolved
    if conflicts:
        record["conflicts"] = conflicts
    if status in ("not_found", "unchecked"):
        record["askedOf"] = [SOURCE_TITLES[source] for source in SOURCES_ORDER if item.asked(source)]
        record["notFoundIn"] = [SOURCE_TITLES[source] for source in item.absent_from]
        if item.failed:
            record["failed"] = [error.entry() for error in item.failed]
    return record


def _request_key(items):
    canonical = json.dumps(sorted("%s:%s" % (item.kind, item.value) for item in items if item.kind != "invalid"), separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _preserve(records, unresolved, key):
    """The answer as one content-addressed file. None when it cannot be written: the answer is still returned."""
    try:
        payload = (json.dumps(
            {"schemaVersion": 1, "tool": "identifier_resolve", "items": records, "unresolved": unresolved},
            ensure_ascii=False, sort_keys=True, indent=1,
        ) + "\n").encode("utf-8")
        paths = preserve(managed_workspace(), Path(".evimed-sources") / "identifiers" / key, {"links.json": payload})
        return {"path": paths["links.json"], "sha256": hashlib.sha256(payload).hexdigest()}
    except Exception:  # noqa: BLE001
        # isolated: evimed_identifier_preservation_failures_total
        return None


def _url_for(record):
    if record.get("pmid"):
        return "https://pubmed.ncbi.nlm.nih.gov/%s/" % urllib.parse.quote(record["pmid"])
    if record.get("pmcid"):
        return "https://pmc.ncbi.nlm.nih.gov/articles/%s/" % urllib.parse.quote(record["pmcid"])
    return "https://doi.org/%s" % urllib.parse.quote(record["doi"], safe="/") if record.get("doi") else None


def resolve(arguments):
    """`identifier_resolve`: PMIDs, PMCIDs and DOIs linked to one another, as one answer.

    Raises `PublicSourceError("public_source_identifier_invalid")` when nothing
    asked is an identifier at all, and `SourceError` when every source asked
    failed; otherwise returns the ToolResult, with whatever failed on the way
    named in `data.outcome.failed`.
    """
    raw = arguments.get("identifiers")
    if not isinstance(raw, list) or not raw or len(raw) > MAX_IDENTIFIERS:
        raise public_sources.PublicSourceError(
            "public_source_identifier_invalid", "Pass between 1 and %d identifiers (PMIDs, PMCIDs or DOIs)." % MAX_IDENTIFIERS,
        )
    items = [_Item(parse_identifier(value)) for value in raw]
    first = {}
    for position, item in enumerate(items):
        if item.kind == "invalid":
            continue
        key = (item.kind, item.value)
        if key in first:
            item.duplicate_of = first[key]
        else:
            first[key] = position
    live = [item for item in items if item.kind != "invalid" and item.duplicate_of is None]
    if not live:
        raise public_sources.PublicSourceError(
            "public_source_identifier_invalid",
            "None of the %d values is a PMID, a PMCID or a DOI; nothing was asked of any source." % len(items),
        )
    deadline = transport.Deadline(_deadline_seconds())
    failures = []

    def attempt(source, subjects, call):
        try:
            call()
        except source_outcome.SourceError as error:
            failures.append(error)
            for item in subjects:
                item.failed.append(error)
        except public_sources.SourceNotConfigured as error:
            wrapped = source_outcome.denied(str(error), scope=SOURCE_TITLES[source], reason="not_configured", retryable=False)
            failures.append(wrapped)
            for item in subjects:
                item.failed.append(wrapped)

    for kind in ("pmid", "pmcid", "doi"):
        group = [item for item in live if item.kind == kind]
        if group:
            attempt("ncbi-idconv", group, lambda group=group, kind=kind: _idconv(group, kind, deadline))
    # What the converter could not place goes to Europe PMC; the converter only knows PMC.
    for field in ("pmcid", "doi"):
        missing = [item for item in live if item.kind == field and "ncbi-idconv" in item.absent_from]
        if missing:
            attempt("europe-pmc", missing, lambda missing=missing, field=field: _europe_pmc(missing, field, deadline))
    # PMIDs: PubMed is the authority for whether one exists, and a second opinion on every link.
    attempt("pubmed", [item for item in live if item.known("pmid")], lambda: _esummary(live, deadline))
    unseen = [item for item in live if item.known("doi") and not item.observed.get("crossref") and not item.found_by]
    if unseen:
        attempt("crossref", unseen, lambda: _crossref(unseen, deadline))

    answered = [item for item in live if item.found_by or item.absent_from]
    if not answered and failures:
        # Nothing answered at all: the failure is the whole result.
        raise failures[0]

    records = {}
    for position, item in enumerate(items):
        if item.duplicate_of is not None:
            continue
        records[position] = _record(item)
    for position, item in enumerate(items):
        if item.duplicate_of is not None:
            records[position] = {**records[item.duplicate_of], "input": item.input, "duplicateOf": item.duplicate_of}
    ordered = [records[position] for position in range(len(items))]
    usable = [record for record in ordered if record["status"] in ("resolved", "conflict")]
    unresolved = [record for record in ordered if record["status"] not in ("resolved", "conflict")]
    counts = {status: sum(1 for record in ordered if record["status"] == status) for status in ("resolved", "conflict", "not_found", "invalid", "unchecked")}
    preserved = _preserve(usable, unresolved, _request_key(items))

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    sources, seen = [], set()
    for record in usable:
        key = (record.get("pmid"), record.get("pmcid"), record.get("doi"))
        if key in seen:
            continue
        seen.add(key)
        identifier = ("PMID:%s" % record["pmid"]) if record.get("pmid") else (record.get("pmcid") or "DOI:%s" % record["doi"])
        entry = {"id": identifier, "source": SOURCE_IDS[record["resolvedBy"][0]], "retrievedAt": now, "evidenceAccess": "bibliographic_only"}
        if record.get("title"):
            entry["title"] = record["title"]
        if _url_for(record):
            entry["url"] = _url_for(record)
        sources.append(entry)

    outcome = source_outcome.complete(asked=len(live), answered=len(answered)) if usable else source_outcome.no_results(
        reason="none_resolved",
        how="No source holds any of these identifiers. Check them against the paper itself; a source that holds nothing is not evidence that the paper does not exist.",
        asked=len(live),
    )
    outcome = source_outcome.with_failures(outcome, [error.entry() for error in failures])
    data = {
        "items": usable,
        "unresolved": unresolved,
        "summary": {"requested": len(items), **counts},
        "outcome": outcome,
        **({"preserved": preserved, "artifactSha256s": {preserved["path"]: preserved["sha256"]}} if preserved else {}),
    }
    warnings, actions = [], []
    if counts["not_found"]:
        warnings.append("%d identifier(s) are held by none of the sources asked; that is not evidence the paper does not exist." % counts["not_found"])
        actions.append("Check the not-found identifiers against the paper's own page, or search by title with literature_search.")
    if counts["invalid"]:
        warnings.append("%d value(s) are not a PMID, a PMCID or a DOI and were not asked of any source." % counts["invalid"])
        actions.append("Pass PMIDs as digits, PMCIDs as PMC and digits, DOIs starting 10.")
    if counts["conflict"]:
        warnings.append("%d identifier(s) are linked differently by different sources; each source's value is listed on the item." % counts["conflict"])
        actions.append("Open the records the conflicting sources name and decide which link is right before citing either.")
    if counts["unchecked"]:
        warnings.append("%d identifier(s) could not be checked because every source asked failed." % counts["unchecked"])
    for error in failures:
        warnings.append(str(error))
        actions.extend(action for action in error.next_actions() if action not in actions)
    if preserved is None:
        warnings.append("The answer could not be preserved in the workspace, so it cannot be cited by path.")
    summary = "Linked %d of %d identifier(s)%s." % (
        len(usable), len(items), (": %d not found, %d invalid" % (counts["not_found"], counts["invalid"])) if counts["not_found"] or counts["invalid"] else "",
    )
    result = {"summary": summary, "data": data, "sources": sources, "status": "warning" if warnings else "success"}
    if preserved:
        result["artifacts"] = [preserved["path"]]
    if warnings:
        result["warnings"] = warnings
        result["next_actions"] = actions or ["Go on with the identifiers that resolved."]
    return result
