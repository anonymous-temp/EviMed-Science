"""``json-api``: open data APIs, one field mapping per upstream family (``config.family``).

The read method is the same for all of them — render the registry's URL template, read JSON,
follow the upstream's own paging — and each family maps records to entries. New sources of an
existing family are registry data; a new upstream is one mapping here. Families and the facts
measured against each on 2026-09-21/22:

``openfda-enforcement`` / ``openfda-shortages`` / ``openfda-drugsfda`` / ``openfda-event``
    No record carries a link: links are built from the recall event, the application number or
    the shortage ingredient (``link-derived``). Dates are ``YYYYMMDD`` except shortages
    (``MM/DD/YYYY``, where a ``search`` on ``update_date`` answers 404). A search with no match is
    **HTTP 404** ``{"error":{"code":"NOT_FOUND"}}`` — zero entries, not a failure. Record dates lag
    publication (drugsfda ``last_updated`` 2026-09-16 carried approvals dated up to 09-14), so
    these families always read the whole look-back window, whatever ``last_ok_at`` says.
    Drugs@FDA emits one entry per *submission* inside the window with the event-level identity
    ``fda:<application>:<type>-<number>`` (a supplement is news separate from the approval).
    Shortages: 18 of the latest 20 records on 2026-09-22 were "Reverified" updates of shortages
    first posted 2017–2023, so a shortage is dated by its event (first posting, discontinuation,
    resolution) and only events inside the window are emitted. FAERS (``drug/event``) is polled
    for ``meta.last_updated`` only: one "data updated" entry per value (it moves quarterly).
``ctgov`` (ClinicalTrials.gov v2)
    The date that makes a record news depends on the query (``config.date_field``): the results
    stream sorts on ResultsFirstPostDate while the record's first date field is its years-old
    registration. Identity is event-level: ``reg:<NCT>:<event>:<date>``. ``fields=`` limits the
    answer to what is used — the full record carries central-contact names, phones and e-mails.
``crossref-works``
    Crossref ``/works`` streams (retractions, corrections): the journal adapter's mapping.
``who-odata``
    WHO's undocumented OData: title and date, a body only on outbreak news, and a half link
    (``/21-09-2026-…``) completed per endpoint (news → ``/news/item``, outbreak news →
    ``/emergencies/disease-outbreak-news/item/``, publications → ``/publications/i/item/``;
    verified 200 on 2026-09-22).
``biorxiv`` (medRxiv / bioRxiv ``/details``)
    ``messages[0]`` says ``cursor``/``count``/``total``; 100 records per call on 2026-09-22 (the
    30 of the probe notes is outdated), so the next cursor is ``cursor + count``. One entry per
    DOI (the newest version in the page); corresponding-author names are not kept.
``federalregister``, ``arxiv``, ``medhelm``, ``prepare-registry``, ``star-rating``
    See the functions below. PREPARE records carry contact name, e-mail, phone, address and
    WeChat id and include unsubmitted drafts; only whitelisted fields leave, drafts are skipped.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from typing import Any, Callable
from urllib.parse import quote, quote_plus, urlsplit, urlunsplit

from ..model import FetchError, FetchResult, ParseOutput, RequestSpec, SourceConfig, SourceState
from ..urltemplate import render_template, template_values
from .common import (
    absolute_url,
    clean_markup,
    dig,
    guess_language,
    load_json,
    make_entry,
    normalize_doi,
    parse_date,
    query_param,
    registry_ids,
    set_query_param,
    source_zone,
)
from .crossref import parse_crossref_works

OPENFDA_FAMILIES = frozenset({"openfda-enforcement", "openfda-shortages", "openfda-drugsfda", "openfda-event"})
DEFAULT_OPENFDA_LOOKBACK_DAYS = 30

ENFORCEMENT_LINK = "https://www.accessdata.fda.gov/scripts/ires/index.cfm?Event={event_id}"
# Format copied from the links on FDA's own list page https://www.accessdata.fda.gov/scripts/drugshortages/
# (2026-09-22): dsp_ActiveIngredientDetails.cfm?AI=<name>&st=<c current | d discontinued | r resolved>.
SHORTAGE_LINK = "https://www.accessdata.fda.gov/scripts/drugshortages/dsp_ActiveIngredientDetails.cfm?AI={ai}&st={st}&tab=tabs-1"
DRUGSFDA_LINK = "https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo={appl_no}"
FAERS_LINK = "https://open.fda.gov/data/faers/?last_updated={date}"
SHORTAGE_STATUS_CODES = {"current": "c", "to be discontinued": "d", "resolved": "r"}

CTGOV_FIELDS = ("NCTId,BriefTitle,OfficialTitle,Acronym,OverallStatus,WhyStopped,Phase,StudyType,LeadSponsorName,"
                "StudyFirstPostDate,ResultsFirstPostDate,LastUpdatePostDate,BriefSummary,EnrollmentCount,"
                "Condition,InterventionName,HasResults")
CTGOV_DATE_FIELDS = {
    "StudyFirstPostDate": "studyFirstPostDateStruct",
    "ResultsFirstPostDate": "resultsFirstPostDateStruct",
    "LastUpdatePostDate": "lastUpdatePostDateStruct",
}
CTGOV_STATUS_EVENTS = {"TERMINATED": "terminated", "SUSPENDED": "suspended"}
CTGOV_EVENT_PREFIX = {"results-posted": "Results posted", "terminated": "Terminated", "suspended": "Suspended",
                      "updated": "Status updated"}

WHO_LINKS = (
    ("/api/news/newsitems", "https://www.who.int/news/item{ItemDefaultUrl}"),
    ("/api/news/diseaseoutbreaknews", "https://www.who.int/emergencies/disease-outbreak-news/item/{UrlName}"),
    ("/api/emergencies/diseaseoutbreaknews", "https://www.who.int/emergencies/disease-outbreak-news/item/{UrlName}"),
    ("/api/hubs/publications", "https://www.who.int/publications/i/item/{UrlName}"),
)

MEDHELM_CONFIG_JS = "https://crfm.stanford.edu/helm/medhelm/latest/config.js"
MEDHELM_PAGE = "https://crfm.stanford.edu/helm/medhelm/latest/"
PREPARE_LINK = "https://www.guidelines-registry.cn/guide/{id}"

_RECORD_FIELD = re.compile(r"\{([A-Za-z_][A-Za-z0-9_.]*)\}")
_OPENFDA_WINDOW = re.compile(r"\[(\d{8})\+?(?:%20|\s)*TO(?:%20|\s|\+)*(\d{8})\]|%5B(\d{8})\+TO\+(\d{8})%5D", re.I)


def record_link(template: str, record: dict) -> str:
    """Fill ``{Field}`` / ``{a.b}`` placeholders of a record-level link template (``config.link_template``).

    A different grammar from the URL templates of ``urltemplate`` (those are rendered at plan time
    from the poll's window; these at parse time from one record's own fields). Values are
    percent-encoded as path segments; a missing field leaves the link empty.
    """
    missing = False

    def replace(match: re.Match[str]) -> str:
        nonlocal missing
        value = dig(record, match.group(1))
        if value in (None, ""):
            missing = True
            return ""
        text = str(value)
        return text if text.startswith("/") else quote(text, safe="-._~")

    link = _RECORD_FIELD.sub(replace, template)
    return "" if missing else link


def _first(values: Any) -> Any:
    if isinstance(values, list):
        return values[0] if values else None
    return values


def _openfda_date(value: Any, date_format: str | None) -> datetime | None:
    parsed, _ = parse_date(value, date_format=date_format)
    return parsed


def _join(*parts: str | None, sep: str = " ") -> str:
    return sep.join(p.strip() for p in parts if p and p.strip())


def _same_host_next(next_url: Any, request_url: str) -> RequestSpec | None:
    """Follow an upstream-supplied next link only when it stays on the request's own origin.

    PREPARE's paging link on 2026-09-22 was ``http://10.0.24.8:8011/registration/guide/?page=2``
    (the upstream's internal address and path): an absolute next link is data from the upstream
    and is not trusted to point anywhere the plugin should go.
    """
    if not isinstance(next_url, str) or not next_url:
        return None
    wanted, given = urlsplit(request_url), urlsplit(next_url)
    if (given.scheme, given.netloc) != (wanted.scheme, wanted.netloc):
        return None
    return RequestSpec(url=next_url, conditional=False, api=True)


def _labelled(label: str, value: Any) -> str | None:
    """``"Label: value."`` — one full stop even when the upstream text already ends with one."""
    text = clean_markup(value)
    return f"{label}: {text.rstrip('.').rstrip()}." if text else None


# ---------------------------------------------------------------------------------------------
# openFDA
# ---------------------------------------------------------------------------------------------

def _openfda_payload(result: FetchResult) -> dict | None:
    """The JSON payload, or ``None`` for openFDA's "no matches" 404 (zero entries, not a failure)."""
    payload = load_json(result, "openfda")
    if result.status == 404 and isinstance(payload, dict) and (payload.get("error") or {}).get("code") == "NOT_FOUND":
        return None
    if result.status != 200:
        code = (payload.get("error") or {}).get("code") if isinstance(payload, dict) else None
        detail = f"openfda_{str(code).lower()}" if code else f"openfda_http_{result.status}"
        raise FetchError("http-error", detail[:80], status=result.status)
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), (list, type(None))):
        raise FetchError("parse-error", "openfda_unexpected_shape", status=result.status)
    return payload


def _openfda_next(result: FetchResult, payload: dict) -> RequestSpec | None:
    """The next page by ``skip`` while pages come back full (openFDA caps skip at 25,000)."""
    meta = (payload.get("meta") or {}).get("results") or {}
    skip, limit, total = meta.get("skip"), meta.get("limit"), meta.get("total")
    results = payload.get("results") or []
    if not all(isinstance(v, int) for v in (skip, limit, total)) or len(results) < limit:
        return None
    following = skip + limit
    if following >= total or following + limit > 25_000:
        return None
    return RequestSpec(url=set_query_param(result.request.url, "skip", str(following)), conditional=False, api=True)


def _openfda_window(url: str) -> tuple[datetime | None, datetime | None]:
    match = _OPENFDA_WINDOW.search(url)
    if not match:
        return None, None
    low, high = (match.group(1), match.group(2)) if match.group(1) else (match.group(3), match.group(4))
    return _openfda_date(low, "%Y%m%d"), _openfda_date(high, "%Y%m%d")


def parse_openfda_enforcement(result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
    payload = _openfda_payload(result)
    if payload is None:
        return ParseOutput(entries=[], notes=["openfda_no_matches"])
    config = source.config or {}
    template = config.get("link_template") or ENFORCEMENT_LINK
    entries = []
    for record in payload.get("results") or []:
        recall_number = str(record.get(config.get("id_field") or "recall_number") or "").strip()
        if not recall_number:
            continue
        product = clean_markup(record.get("product_description"))
        name = product.split(",")[0].strip()[:160] if product else ""
        name = name or clean_markup(_first((record.get("openfda") or {}).get("brand_name"))) or recall_number
        classification = clean_markup(record.get("classification")) or "Unclassified"
        firm = clean_markup(record.get("recalling_firm"))
        title = f"{classification} drug recall: {name}" + (f" ({firm})" if firm else "")
        summary = _join(
            product,
            _labelled("Reason", record.get("reason_for_recall")),
            _labelled("Status", record.get("status")),
            _labelled("Distribution", record.get("distribution_pattern")),
            _labelled(f"Recall {recall_number}", record.get("voluntary_mandated")),
        )
        link = record_link(template, record)
        if not link:
            continue
        reported = _openfda_date(record.get(config.get("date_field") or "report_date"), config.get("date_format") or "%Y%m%d")
        entries.append(make_entry(
            external_key=recall_number, url=link, title=title, summary=summary, published_at=reported,
            precision="day", language="en", defects=["link-derived"],
            facts={"recall_class": classification if record.get("classification") else None,
                   "fda_application": _first((record.get("openfda") or {}).get("application_number")),
                   "sponsor": firm or None},
        ))
    return ParseOutput(entries=entries, next=_openfda_next(result, payload))


def _shortage_event(record: dict) -> tuple[str, datetime | None]:
    status = clean_markup(record.get("status")) or "Unknown"
    low = status.lower()
    if low == "current":
        raw = record.get("initial_posting_date")
    elif low == "to be discontinued":
        raw = record.get("discontinued_date") or record.get("initial_posting_date")
    else:
        raw = record.get("update_date")
    return status, _openfda_date(raw, "%m/%d/%Y")


def parse_openfda_shortages(result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
    payload = _openfda_payload(result)
    if payload is None:
        return ParseOutput(entries=[], notes=["openfda_no_matches"])
    config = source.config or {}
    lookback = int(config.get("lookback_days") or DEFAULT_OPENFDA_LOOKBACK_DAYS)
    floor = now - timedelta(days=lookback)
    entries, old = [], 0
    for record in payload.get("results") or []:
        status, event_date = _shortage_event(record)
        ndc = str(record.get("package_ndc") or "").strip()
        generic = clean_markup(record.get("generic_name"))
        if not ndc or not generic or event_date is None:
            continue
        if event_date < floor:
            old += 1  # a reverified or long-standing shortage: not an event of this window
            continue
        company = clean_markup(record.get("company_name"))
        code = SHORTAGE_STATUS_CODES.get(status.lower(), "c")
        link = SHORTAGE_LINK.format(ai=quote_plus(generic), st=code)
        reason = clean_markup(record.get("shortage_reason")) or clean_markup(record.get("related_info"))
        summary = _join(
            clean_markup(record.get("presentation")),
            f"Status: {status}." if status else None,
            f"Therapeutic category: {', '.join(clean_markup(c) for c in record.get('therapeutic_category') or [])}."
            if record.get("therapeutic_category") else None,
            _labelled("Reason", reason),
            _labelled("Availability", record.get("availability")),
        )
        title = f"Drug shortage ({status}): {generic}" + (f" — {company}" if company else "")
        entries.append(make_entry(
            external_key=f"{ndc}:{status.lower()}:{event_date.date().isoformat()}", url=link, title=title,
            summary=summary, published_at=event_date, precision="day", language="en", defects=["link-derived"],
            facts={"fda_application": _first((record.get("openfda") or {}).get("application_number")),
                   "sponsor": company or None},
        ))
    notes = [f"openfda_shortages_outside_window={old}"] if old else []
    # Sorted by update date: once a page reaches updates older than the window, later pages are older still.
    updates = [_openfda_date(r.get("update_date"), "%m/%d/%Y") for r in payload.get("results") or []]
    reached_floor = any(u is not None and u < floor for u in updates)
    return ParseOutput(entries=entries, next=None if reached_floor else _openfda_next(result, payload), notes=notes)


def parse_openfda_drugsfda(result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
    payload = _openfda_payload(result)
    if payload is None:
        return ParseOutput(entries=[], notes=["openfda_no_matches"])
    config = source.config or {}
    low, high = _openfda_window(result.request.url)
    template = config.get("link_template") or DRUGSFDA_LINK
    entries = []
    for record in payload.get("results") or []:
        application = str(record.get(config.get("id_field") or "application_number") or "").strip()
        if not application:
            continue
        products = record.get("products") or []
        brands = sorted({clean_markup(p.get("brand_name")) for p in products if p.get("brand_name")})
        ingredients = sorted({clean_markup(i.get("name")) for p in products for i in (p.get("active_ingredients") or [])
                              if i.get("name")})
        sponsor = clean_markup(record.get("sponsor_name"))
        digits = re.sub(r"\D", "", application)
        link = template.format(appl_no=digits, application_number=application)
        product_line = "; ".join(
            _join(clean_markup(p.get("brand_name")), clean_markup(p.get("dosage_form")), clean_markup(p.get("route")),
                  ", ".join(f"{clean_markup(i.get('name'))} {clean_markup(i.get('strength'))}".strip()
                            for i in (p.get("active_ingredients") or [])))
            for p in products[:6])
        for submission in record.get("submissions") or []:
            when = _openfda_date(submission.get("submission_status_date"), "%Y%m%d")
            if when is None or (low and when < low) or (high and when > high + timedelta(days=1)):
                continue
            kind = str(submission.get("submission_type") or "").strip()
            number = str(submission.get("submission_number") or "").strip()
            supplement = f"{kind}-{number}" if kind and number else kind or number or "unknown"
            status = str(submission.get("submission_status") or "").strip()
            label = {"AP": "approval", "TA": "tentative approval"}.get(status, f"action ({status or 'unknown'})")
            what = clean_markup(submission.get("submission_class_code_description"))
            name = " / ".join(brands) or " / ".join(ingredients) or application
            title = f"FDA {label}: {name} — {application} {supplement}" + (f" ({what})" if what else "")
            documents = "; ".join(f"{clean_markup(d.get('type'))}: {d.get('url')}" for d in submission.get("application_docs") or []
                                  if d.get("url"))
            summary = _join(
                f"Sponsor: {sponsor}." if sponsor else None,
                f"Products: {product_line}." if product_line else None,
                f"Review priority: {clean_markup(submission.get('review_priority'))}." if submission.get("review_priority") else None,
                f"Documents: {documents}." if documents else None,
            )
            entries.append(make_entry(
                external_key=f"{application}:{supplement}", url=link, title=title, summary=summary,
                published_at=when, precision="day", language="en", defects=["link-derived"],
                identity_hint=f"fda:{application}:{supplement}",
                facts={"fda_application": application, "fda_supplement": supplement, "sponsor": sponsor or None},
            ))
    return ParseOutput(entries=entries, next=_openfda_next(result, payload))


def parse_openfda_event(result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
    payload = _openfda_payload(result)
    if payload is None:
        return ParseOutput(entries=[], notes=["openfda_no_matches"])
    meta = payload.get("meta") or {}
    updated = _openfda_date(meta.get("last_updated"), "%Y-%m-%d")
    if updated is None:
        raise FetchError("parse-error", "openfda_last_updated_missing", status=result.status)
    day = updated.date().isoformat()
    total = (meta.get("results") or {}).get("total")
    endpoint = urlsplit(result.request.url).path.rsplit(".", 1)[0].strip("/")  # "drug/event"
    title = f"openFDA adverse event reports (FAERS) data updated {day}"
    summary = (f"The openFDA {endpoint} dataset was refreshed on {day}"
               + (f"; it now holds {total:,} reports." if isinstance(total, int) else ".")
               + " FAERS is released quarterly and lags the reports by three months or more.")
    entry = make_entry(
        external_key=f"{endpoint}:last_updated:{day}", url=FAERS_LINK.format(date=day), title=title,
        summary=summary, published_at=updated, precision="day", language="en", defects=["link-derived"],
        identity_hint=f"fda:faers:{day}",
    )
    return ParseOutput(entries=[entry])


# ---------------------------------------------------------------------------------------------
# ClinicalTrials.gov
# ---------------------------------------------------------------------------------------------

def parse_ctgov(result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
    payload = load_json(result, "ctgov")
    if result.status != 200:
        raise FetchError("http-error", f"ctgov_http_{result.status}", status=result.status)
    studies = payload.get("studies") if isinstance(payload, dict) else None
    if not isinstance(studies, list):
        raise FetchError("parse-error", "ctgov_unexpected_shape", status=result.status)
    config = source.config or {}
    date_field = config.get("date_field") or "StudyFirstPostDate"
    struct = CTGOV_DATE_FIELDS.get(date_field)
    if struct is None:
        raise FetchError("parse-error", "ctgov_date_field_unknown")
    configured_event = config.get("trial_event") or "registered"
    entries, undated = [], 0
    for study in studies:
        protocol = (study or {}).get("protocolSection") or {}
        ident = protocol.get("identificationModule") or {}
        status = protocol.get("statusModule") or {}
        nct = str(ident.get("nctId") or "").strip()
        title = clean_markup(ident.get("briefTitle") or ident.get("officialTitle"))
        if not nct or not title:
            continue
        when, _ = parse_date((status.get(struct) or {}).get("date"))
        if when is None:
            undated += 1
            continue
        overall = str(status.get("overallStatus") or "").strip()
        event = configured_event
        if configured_event == "status":
            event = CTGOV_STATUS_EVENTS.get(overall, "updated")
        day = when.date().isoformat()
        design = protocol.get("designModule") or {}
        phases = "/".join(design.get("phases") or []) or None
        sponsor = clean_markup(((protocol.get("sponsorCollaboratorsModule") or {}).get("leadSponsor") or {}).get("name"))
        description = protocol.get("descriptionModule") or {}
        conditions = ", ".join(clean_markup(c) for c in (protocol.get("conditionsModule") or {}).get("conditions") or [])
        interventions = ", ".join(clean_markup(i.get("name")) for i in
                                  (protocol.get("armsInterventionsModule") or {}).get("interventions") or [] if i.get("name"))
        enrollment = (design.get("enrollmentInfo") or {}).get("count")
        summary = _join(
            _labelled("Why stopped", status.get("whyStopped")),
            clean_markup(description.get("briefSummary")),
            f"Conditions: {conditions}." if conditions else None,
            f"Interventions: {interventions}." if interventions else None,
            f"Enrollment: {enrollment}." if isinstance(enrollment, int) else None,
        )
        prefix = CTGOV_EVENT_PREFIX.get(event)
        entries.append(make_entry(
            external_key=f"{nct}:{event}:{day}", url=f"https://clinicaltrials.gov/study/{nct}",
            title=f"{prefix}: {title}" if prefix else title, summary=summary, published_at=when, precision="day",
            language="en", registry=[nct], defects=["link-derived"], identity_hint=f"reg:{nct}:{event}:{day}",
            facts={"trial_phase": phases, "trial_status": overall or None, "trial_event": event,
                   "sponsor": sponsor or None},
        ))
    token = payload.get("nextPageToken")
    next_request = (RequestSpec(url=set_query_param(result.request.url, "pageToken", str(token)), conditional=False, api=True)
                    if token else None)
    return ParseOutput(entries=entries, next=next_request, notes=[f"ctgov_undated={undated}"] if undated else [])


# ---------------------------------------------------------------------------------------------
# WHO OData, medRxiv/bioRxiv, Federal Register, MedHELM, PREPARE, STAR
# ---------------------------------------------------------------------------------------------

def parse_who_odata(result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
    payload = load_json(result, "who")
    if result.status != 200:
        raise FetchError("http-error", f"who_http_{result.status}", status=result.status)
    values = payload.get("value") if isinstance(payload, dict) else None
    if not isinstance(values, list):
        raise FetchError("parse-error", "who_unexpected_shape", status=result.status)
    config = source.config or {}
    template = config.get("link_template")
    if not template:
        path = urlsplit(result.request.url).path
        template = next((t for prefix, t in WHO_LINKS if path.startswith(prefix)), None)
    if not template:
        raise FetchError("parse-error", "who_link_template_unknown")
    entries = []
    for record in values:
        title = clean_markup(record.get("OverrideTitle") if record.get("UseOverrideTitle") else record.get("Title"))
        link = record_link(template, record)
        if not title or not link or not record.get("Id"):
            continue
        when, precision = parse_date(record.get("PublicationDateAndTime") or record.get("PublicationDate"))
        body = next((clean_markup(record.get(k)) for k in ("Summary", "Overview", "Highlight", "MetaDescription")
                     if clean_markup(record.get(k))), None)
        entries.append(make_entry(
            external_key=str(record["Id"]), url=link, title=title, summary=body, published_at=when,
            precision=precision, language=guess_language(title, source.language or "en"), defects=["link-derived"],
        ))
    return ParseOutput(entries=entries, next=_same_host_next(payload.get("@odata.nextLink"), result.request.url))


def parse_biorxiv(result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
    payload = load_json(result, "biorxiv")
    if result.status != 200:
        raise FetchError("http-error", f"biorxiv_http_{result.status}", status=result.status)
    messages = payload.get("messages") if isinstance(payload, dict) else None
    message = messages[0] if isinstance(messages, list) and messages and isinstance(messages[0], dict) else {}
    collection = payload.get("collection") if isinstance(payload, dict) else None
    if collection is None and str(message.get("status", "")).lower().startswith("no posts"):
        return ParseOutput(entries=[])
    if not isinstance(collection, list):
        raise FetchError("parse-error", "biorxiv_unexpected_shape", status=result.status)
    newest: dict[str, dict] = {}
    for record in collection:
        doi = normalize_doi(record.get("doi"))
        if not doi:
            continue
        try:
            version = int(record.get("version") or 1)
        except (TypeError, ValueError):
            version = 1
        if doi not in newest or version >= int(newest[doi].get("version") or 1):
            newest[doi] = record
    server = (urlsplit(result.request.url).path.strip("/").split("/") + ["", ""])[1] or "medrxiv"
    host = {"medrxiv": "www.medrxiv.org", "biorxiv": "www.biorxiv.org"}.get(server, "www.medrxiv.org")
    entries = []
    for doi, record in newest.items():
        title = clean_markup(record.get("title"))
        if not title:
            continue
        when, _ = parse_date(record.get("date"))
        authors = [a for a in str(record.get("authors") or "").split(";") if a.strip()]
        version = str(record.get("version") or "1")
        entries.append(make_entry(
            external_key=doi, url=f"https://{host}/content/{doi}v{version}", title=title,
            summary=clean_markup(record.get("abstract")) or None, published_at=when, precision="day",
            language="en", doi=doi, registry=registry_ids(title, record.get("abstract")),
            facts={"author_count": len(authors) or None, "journal": {"medrxiv": "medRxiv", "biorxiv": "bioRxiv"}.get(server)},
        ))
    next_request = None
    try:
        cursor, count, total = int(message.get("cursor")), int(message.get("count")), int(message.get("total"))
    except (TypeError, ValueError):
        cursor = count = total = None
    if cursor is not None and count and cursor + count < total:
        parts = urlsplit(result.request.url)
        segments = parts.path.split("/")
        # /details/<server>/<from>/<to>/<cursor>/json
        if len(segments) >= 7 and segments[-1] == "json" and segments[-2].isdigit():
            segments[-2] = str(cursor + count)
            next_request = RequestSpec(url=urlunsplit(parts._replace(path="/".join(segments))),
                                       conditional=False, api=True)
    return ParseOutput(entries=entries, next=next_request)


def parse_federalregister(result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
    payload = load_json(result, "federalregister")
    if result.status != 200:
        raise FetchError("http-error", f"federalregister_http_{result.status}", status=result.status)
    results = payload.get("results") if isinstance(payload, dict) else None
    if results is None and isinstance(payload, dict) and payload.get("count") == 0:
        return ParseOutput(entries=[])
    if not isinstance(results, list):
        raise FetchError("parse-error", "federalregister_unexpected_shape", status=result.status)
    entries = []
    for record in results:
        number, title, link = record.get("document_number"), clean_markup(record.get("title")), record.get("html_url")
        if not number or not title or not link:
            continue
        when, _ = parse_date(record.get("publication_date"))
        agencies = ", ".join(clean_markup(a.get("name") or a.get("raw_name")) for a in record.get("agencies") or []
                             if isinstance(a, dict) and (a.get("name") or a.get("raw_name")))
        summary = _join(clean_markup(record.get("abstract")) or None,
                        f"Type: {clean_markup(record.get('type'))}." if record.get("type") else None,
                        f"Agencies: {agencies}." if agencies else None)
        entries.append(make_entry(external_key=str(number), url=link, title=title, summary=summary,
                                  published_at=when, precision="day", language="en"))
    return ParseOutput(entries=entries, next=_same_host_next(payload.get("next_page_url"), result.request.url))


_MEDHELM_RELEASE = re.compile(r"window\.RELEASE\s*=\s*[\"']([A-Za-z0-9._-]{1,40})[\"']")
_MEDHELM_BASE = re.compile(r"window\.BENCHMARK_OUTPUT_BASE_URL\s*=\s*[\"'](https://[^\"']{1,300})[\"']")


def parse_medhelm(result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
    """Two steps: ``config.js`` names the current release; its ``summary.json`` dates it.

    A new MedHELM leaderboard is a new ``window.RELEASE`` (``v4.0.0`` on 2026-09-22, dated
    2026-01-19); one entry per release, keyed on the release name.
    """
    if result.status != 200:
        raise FetchError("http-error", f"medhelm_http_{result.status}", status=result.status)
    path = urlsplit(result.request.url).path
    if path.endswith(".js"):
        text = result.body.decode("utf-8", errors="replace")
        release, base = _MEDHELM_RELEASE.search(text), _MEDHELM_BASE.search(text)
        if not release or not base:
            raise FetchError("parse-error", "medhelm_release_missing")
        summary_url = base.group(1).rstrip("/") + f"/releases/{release.group(1)}/summary.json"
        return ParseOutput(entries=[], next=RequestSpec(url=summary_url, conditional=False, api=True))
    payload = load_json(result, "medhelm")
    release = payload.get("release") if isinstance(payload, dict) else None
    if not release:
        raise FetchError("parse-error", "medhelm_summary_unexpected_shape")
    when, precision = parse_date(payload.get("date"))
    suites = ", ".join(str(s) for s in payload.get("suites") or [])
    entry = make_entry(
        external_key=f"medhelm:{release}", url=MEDHELM_PAGE, title=f"Stanford MedHELM leaderboard release {release}",
        summary=f"Stanford CRFM published MedHELM release {release}" + (f" (suites: {suites})" if suites else "")
        + (f", dated {when.date().isoformat()}." if when else "."),
        published_at=when, precision=precision, language="en",
    )
    return ParseOutput(entries=[entry])


def parse_prepare_registry(result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
    payload = load_json(result, "prepare")
    if result.status != 200:
        raise FetchError("http-error", f"prepare_http_{result.status}", status=result.status)
    records = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(records, list):
        raise FetchError("parse-error", "prepare_unexpected_shape", status=result.status)
    config = source.config or {}
    skip_stages = set(config.get("exclude_stages") or ["draft"])
    china = source_zone(config, source.region or "CN")
    entries, skipped = [], 0
    for record in records:
        if record.get("stage") in skip_stages:
            skipped += 1
            continue
        record_id = str(record.get("id") or "").strip()
        title = clean_markup(record.get("title")) or clean_markup(record.get("title_en"))
        if not record_id or not title:
            continue
        when, precision = parse_date(record.get("submitted_at") or record.get("created"), naive_zone=china)
        code = clean_markup(record.get("code")) or None
        developer = clean_markup(record.get("developer")) or clean_markup(record.get("developer_en"))
        version = str(record.get("version") or "original")
        event = "updated" if version == "updated" else "registered"
        summary = _join(
            f"{developer}." if developer else None,
            clean_markup(record.get("aim")) or clean_markup(record.get("aim_en")) or None,
            f"Type: {clean_markup(record.get('type'))}; stage: {clean_markup(record.get('stage'))}; version: {version}"
            + (f"; registration number {code}." if code else "."),
        )
        language = "zh" if str(record.get("language") or "").lower().startswith("zh") else guess_language(title, "en")
        entries.append(make_entry(
            external_key=record_id, url=PREPARE_LINK.format(id=quote(record_id, safe="-")), title=title,
            summary=summary, published_at=when, precision=precision, language=language, defects=["link-derived"],
            registry=[code] if code else [], identity_hint=f"reg:prepare-{record_id}:{event}:{when.date().isoformat()}"
            if when else None, facts={"sponsor": developer or None},
        ))
    next_request = None
    if payload.get("next"):  # its absolute link is internal (see _same_host_next): page on our own URL
        page = int(query_param(result.request.url, "page") or 1)
        next_request = RequestSpec(url=set_query_param(result.request.url, "page", str(page + 1)),
                                   conditional=False, api=True)
    return ParseOutput(entries=entries, next=next_request, notes=[f"prepare_skipped_stage={skipped}"] if skipped else [])


def parse_star_rating(result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
    """STAR guideline ratings: POST ``{"page": n}``; 40 per page whatever ``limit`` says, ordered by star.

    The list is not ordered by date (page 1 on 2026-09-22 held 5-star ratings created 2022–2026),
    so new ratings are only found by walking the pages; the next page is planned from the request
    body until ``data.pages``.
    """
    payload = load_json(result, "star")
    if result.status != 200:
        raise FetchError("http-error", f"star_http_{result.status}", status=result.status)
    if not isinstance(payload, dict) or payload.get("code") != 0 or not isinstance(payload.get("data"), dict):
        raise FetchError("parse-error", "star_unexpected_shape", status=result.status)
    data = payload["data"]
    records = data.get("list") or []
    entries = []
    for record in records:
        record_id, title = record.get("id"), clean_markup(record.get("name"))
        link = absolute_url(record.get("url"), "https://www.star-guidelines.cn/")
        if record_id is None or not title or not link:
            continue
        when, precision = parse_date(record.get("createdDate"))
        organizations = "、".join(clean_markup(o.get("name")) for o in record.get("organizeList") or [] if o.get("name"))
        journals = "、".join(clean_markup(m.get("name")) for m in record.get("magazineList") or [] if m.get("name"))
        content = clean_markup(record.get("content"))
        summary = _join(
            f"STAR {record.get('star')} 星（{record.get('score')} 分），{clean_markup(record.get('typeName'))}，{record.get('year')}。"
            if record.get("star") is not None else None,
            f"制订机构：{organizations}。" if organizations else None,
            f"发表期刊：{journals}。" if journals else None,
            content or None,
        )
        entries.append(make_entry(
            external_key=f"star:{record_id}", url=link, title=title, summary=summary, published_at=when,
            precision=precision, language=guess_language(title, "zh"),
            registry=registry_ids(content, record.get("serialNumber")),
        ))
    next_request = None
    try:
        body = json.loads((result.request.body or b"{}").decode("utf-8"))
        page, pages = int(body.get("page") or 1), int(data.get("pages") or 0)
    except (ValueError, TypeError, AttributeError):
        page, pages = 1, 0
    if page < pages:
        body["page"] = page + 1
        next_request = RequestSpec(url=result.request.url, method="POST", body=json.dumps(body).encode("utf-8"),
                                   headers={"Content-Type": "application/json"}, conditional=False, api=True)
    return ParseOutput(entries=entries, next=next_request)


def parse_arxiv(result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
    from .feed import parse_feed  # arXiv's API answers Atom; the feed reader knows its quirks

    return parse_feed(result, source, now)


def parse_crossref_family(result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
    return parse_crossref_works(result, source)


FAMILIES: dict[str, Callable[[FetchResult, SourceConfig, datetime], ParseOutput]] = {
    "openfda-enforcement": parse_openfda_enforcement,
    "openfda-shortages": parse_openfda_shortages,
    "openfda-drugsfda": parse_openfda_drugsfda,
    "openfda-event": parse_openfda_event,
    "ctgov": parse_ctgov,
    "crossref-works": parse_crossref_family,
    "who-odata": parse_who_odata,
    "biorxiv": parse_biorxiv,
    "federalregister": parse_federalregister,
    "arxiv": parse_arxiv,
    "medhelm": parse_medhelm,
    "prepare-registry": parse_prepare_registry,
    "star-rating": parse_star_rating,
}

# Rows the registry still labels ``generic`` are recognised by host (the three P0 ones).
_GENERIC_BY_HOST = (
    ("guidelines-registry.", "prepare-registry"),
    ("star-guidelines.cn", "star-rating"),
    ("crfm-helm-public/medhelm", "medhelm"),
    ("crfm.stanford.edu/helm/medhelm", "medhelm"),
    ("federalregister.gov/api", "federalregister"),
    ("export.arxiv.org/api", "arxiv"),
)


def family_for(config: dict | None) -> str:
    """The mapping a json-api config selects: ``config.family``, else recognised by URL host."""
    config = config or {}
    family = str(config.get("family") or "generic")
    if family in FAMILIES:
        return family
    url = config.get("url") or ""
    for needle, name in _GENERIC_BY_HOST:
        if needle in url:
            return name
    return family


def family_of(source: SourceConfig) -> str:
    return family_for(source.config)


class JsonApiAdapter:
    """Open data APIs by family (see module docstring)."""

    access = "json-api"

    def validate_config(self, source: SourceConfig) -> list[str]:
        config = source.config or {}
        family = family_of(source)
        problems = []
        if family not in FAMILIES:
            problems.append(f"no json-api mapping for family {config.get('family')!r}")
        if family == "ctgov" and config.get("date_field") not in CTGOV_DATE_FIELDS:
            problems.append(f"ctgov date_field must be one of {sorted(CTGOV_DATE_FIELDS)}")
        if family == "ctgov" and config.get("trial_event") not in ("registered", "results-posted", "status", "updated"):
            problems.append("ctgov trial_event must be registered | results-posted | status | updated")
        if family == "star-rating" and str(config.get("method") or "").upper() != "POST":
            problems.append("the STAR list API answers POST only (GET: code -20001)")
        return problems

    def plan(self, source: SourceConfig, state: SourceState, now: datetime) -> list[RequestSpec]:
        config = source.config or {}
        family = family_of(source)
        if family in OPENFDA_FAMILIES or config.get("incremental") is False:
            state = SourceState(etag=state.etag, last_modified=state.last_modified,
                                last_content_sha256=state.last_content_sha256, last_ok_at=None,
                                first_contact_at=state.first_contact_at, cursor=state.cursor)
        values = template_values(source, state, now)
        values["cursor"] = str(config.get("cursor_start") or values["cursor"])
        url = render_template(config.get("url") or (MEDHELM_CONFIG_JS if family == "medhelm" else ""), values)
        if family == "medhelm" and not url.endswith(".js"):
            url = MEDHELM_CONFIG_JS  # the release file names the current summary; a pinned one never changes
        if family == "ctgov" and query_param(url, "fields") is None:
            url = set_query_param(url, "fields", CTGOV_FIELDS)
        method = str(config.get("method") or "GET").upper()
        body = None
        headers: dict = {}
        if family == "star-rating":
            method = "POST"
        if method == "POST":
            body = json.dumps(config.get("body") or {"page": 1, "limit": 40}, ensure_ascii=False).encode("utf-8")
            headers = {"Content-Type": "application/json"}
        return [RequestSpec(url=url, method=method, body=body, headers=headers, conditional=False, api=True)]

    def parse(self, result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
        family = family_of(source)
        parser = FAMILIES.get(family)
        if parser is None:
            raise FetchError("parse-error", f"json_api_family_unmapped_{family}"[:80])
        return parser(result, source, now)
