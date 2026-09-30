"""``html-list``: a server-rendered list page read with the source's own selectors.

Every list page is data: ``config.selectors`` names CSS selectors for ``item`` and, inside an
item, ``title``, ``link``, ``date`` and optionally ``summary`` and ``doi``. A selector may end with
``@attribute`` to read an attribute instead of the text (``a.docsum-title@href``,
``time@datetime``); ``@attr`` alone reads the item node itself and ``.`` is the item's own text.
Dates are read with ``config.date_format`` when given, else by the forms ``common.parse_date``
knows (``2026-09-20``, ``2026年9月20日``, a date inside ``[…]``); naive times are the source's zone.

Three page shapes met on the P0 and named P1 lists (2026-09-22), hence ``config.mode``:

- ``html`` (default): the list is in the markup (中国政府网, 药品不良反应监测中心, EMA, PubMed).
- ``script-cdata``: Hanweb-CMS sites (国家医保局) ship the list inside
  ``<script type="text/xml"><datastore><recordset><record><![CDATA[<li>…</li>]]></record>``,
  invisible to an HTML parser; the CDATA records are unwrapped and parsed as markup.
- ``script-json``: the list is a JavaScript array literal rendered client-side (国家疾控局:
  ``var itemObj = [{"aT": title, "aPd": "2026-09-21 17:00", "aU": "{\\"common\\": \\"/jbkzzx/…\\"}"}]``);
  ``config.script_var`` names the variable and ``config.fields`` maps ``title``/``link``/``date``/
  ``summary``/``id`` to dotted record paths (a JSON-in-a-string value is entered, see ``common.dig``).

Table rows without a link of their own (药审中心's breakthrough-therapy publicity opens details
through ``ondblclick`` JavaScript, and its detail script answered 403 to this box on 2026-09-22)
use ``selectors.id`` for the row's own key (the acceptance number) and ``config.link_template`` —
``{id}`` / ``{date}`` / ``{title}`` / ``{summary}`` placeholders, percent-encoded — for a link that
tells the rows apart (``link-derived``; a query parameter, since a ``#fragment`` is dropped from the
canonical URL and every row would share one identity). Such a link is also the row's key: one
acceptance number can be listed twice (药审中心 listed CXSL2300094 on 2026-08-31 and again on
2026-09-14, one inclusion per indication), so the template names the date as well. ``config.title_template`` and
``config.summary_template`` give bare table cells their context
(``纳入突破性治疗品种名单：{title}（{id}）``, ``注册申请人：{summary}``); a template naming an empty
cell falls back to the cell itself.

A page whose selectors match nothing returns no entries and the note ``html_list_no_items``; the
core turns zero items on a previously productive list into the ``drifted`` health state
(plan 10.2.8) — it is not an exception. Item links outside ``config.link_hosts`` (default: the
source's ``allowed_hosts``) are dropped: 药品不良反应监测中心's safety column lists NMPA
announcements on ``www.nmpa.gov.cn`` beside its own pages, so that row names both hosts. A list
item has no stable id of its own, so the external key is its link (or ``fields.id``).
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import replace
from datetime import datetime
from typing import Any
from urllib.parse import quote, urlsplit

from selectolax.parser import HTMLParser, Node

from ..fetch import detect_challenge
from ..model import FetchError, FetchResult, NormalizedEntry, ParseOutput, RequestSpec, SourceConfig, SourceState
from ..normalize import canonical_url
from .base import decode_body, plan_from_template
from .common import (
    PMID_IN_URL,
    absolute_url,
    clean_markup,
    dig,
    guess_language,
    host_allowed,
    make_entry,
    normalize_doi,
    parse_date,
    registry_ids,
    source_zone,
)

MODES = ("html", "script-cdata", "script-json")
DEFAULT_MAX_ITEMS = 60
DEFAULT_MIN_TITLE = 4
MAX_SELECTOR_FALLBACKS = 3
MAX_DATE_FORMATS = 4
_CDATA = re.compile(r"<!\[CDATA\[(.*?)\]\]>", re.S)
_XML_SCRIPT = re.compile(r"<script[^>]*type=[\"']text/xml[\"'][^>]*>(.*?)</script>", re.S | re.I)


def _select(node: Node, spec: str | None) -> str | None:
    """Text or attribute of the first match of ``spec`` inside ``node`` (see module docstring)."""
    if not spec:
        return None
    selector, _, attribute = spec.partition("@")
    selector = selector.strip()
    target = node if selector in ("", ".") else node.css_first(selector)
    if target is None:
        return None
    if attribute:
        value = target.attributes.get(attribute.strip())
        return value.strip() if value else None
    text = target.text(separator=" ", strip=True)
    return text or None


def _date_text(raw: str | None, config: dict) -> str | None:
    if not raw:
        return None
    pattern = config.get("date_regex")
    if pattern:
        match = re.search(pattern, raw)
        return (match.group(1) if match.groups() else match.group(0)) if match else None
    return raw


def _html_items(text: str, config: dict) -> list[dict[str, Any]]:
    selectors = config.get("selectors") or {}
    if config.get("mode") == "script-cdata":
        blocks = _XML_SCRIPT.findall(text) or [text]
        text = "\n".join(chunk for block in blocks for chunk in _CDATA.findall(block))
    tree = HTMLParser(text)
    for hidden in tree.css('script, style, noscript, template'):
        hidden.decompose()
    items = []
    for node in tree.css(selectors["item"]):
        title, date = _select(node, selectors.get("title")), _select(node, selectors.get("date"))
        if title and date and title.endswith(date) and len(title) > len(date):
            title = title[: -len(date)].rstrip()  # the date cell sits inside the title link (中国疾控中心)
        items.append({
            "title": title,
            "link": _select(node, selectors.get("link")),
            "date": date,
            "summary": _select(node, selectors.get("summary")),
            "doi": _select(node, selectors.get("doi")),
            "id": _select(node, selectors.get("id")),
        })
    return items


def _fill(template: str, item: dict, *, encode: bool) -> str | None:
    """Fill ``{id}``/``{date}``/``{title}``/``{summary}`` from an item; ``None`` when a named value is missing."""
    missing = False

    def value(match: re.Match[str]) -> str:
        nonlocal missing
        text = clean_markup(item.get(match.group(1)))
        if not text:
            missing = True
            return ""
        return quote(text, safe="") if encode else text

    filled = re.sub(r"\{(id|date|title|summary)\}", value, template)
    return None if missing else filled


def _script_items(text: str, config: dict) -> list[dict[str, Any]]:
    name = config.get("script_var")
    if not name or not re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", name):
        raise FetchError("parse-error", "html_list_script_var_invalid")
    match = re.search(r"\bvar\s+" + re.escape(name) + r"\s*=\s*", text)
    if not match:
        return []
    try:
        records, _ = json.JSONDecoder().raw_decode(text, match.end())
    except ValueError as error:
        raise FetchError("parse-error", "html_list_script_json_unreadable") from error
    if not isinstance(records, list):
        raise FetchError("parse-error", "html_list_script_json_not_a_list")
    fields = config.get("fields") or {}
    items = []
    for record in records:
        if not isinstance(record, dict):
            continue
        items.append({key: (None if fields.get(key) is None else dig(record, fields[key]))
                      for key in ("title", "link", "date", "summary", "doi", "id")})
    return items


def list_entries(text: str, *, source: SourceConfig, base: str) -> tuple[list[NormalizedEntry], list[str]]:
    """The entries of one list page (pure; ``text`` is the decoded page)."""
    config = source.config or {}
    mode = config.get("mode") or "html"
    raw_items = _script_items(text, config) if mode == "script-json" else _html_items(text, config)
    naive_zone = source_zone(config, source.region)
    min_title = int(config.get("min_title_chars") or DEFAULT_MIN_TITLE)
    allowed = list(config.get("link_hosts") or config.get("allowed_hosts") or [])
    link_prefix = config.get("link_base") or base
    entries: list[NormalizedEntry] = []
    seen: set[str] = set()
    dropped = {"title": 0, "link": 0, "host": 0, "id": 0}
    page_links = 0
    for item in raw_items:
        title = clean_markup(item.get("title"))
        if len(title) < min_title:
            dropped["title"] += 1
            continue
        link = absolute_url(item.get("link"), link_prefix)
        derived = False
        source_page_link = config.get("link_to_source_page") is True
        row_id = clean_markup(item.get("id"))
        if source_page_link:
            # Some regulator tables publish stable records without detail URLs.
            # Link to the real fetched page and retain each row's own identity.
            if not row_id:
                dropped["id"] += 1
                continue
            link = canonical_url(base)
            derived = True
        if not link and config.get("link_template"):
            link = absolute_url(_fill(config["link_template"], item, encode=True), link_prefix)
            derived = bool(link)
        if not link:
            dropped["link"] += 1
            continue
        summary = clean_markup(item.get("summary")) or None
        if config.get("summary_template"):
            summary = _fill(config["summary_template"], {**item, "title": title}, encode=False) or summary
        if config.get("title_template"):
            title = _fill(config["title_template"], {**item, "title": title}, encode=False) or title
        if allowed and not host_allowed(link, allowed):
            dropped["host"] += 1
            continue
        key = f"{canonical_url(base)}::{row_id}" if source_page_link else (
            link if derived else str(item.get("id") or link))
        if key in seen:
            continue
        seen.add(key)
        date_text = _date_text(clean_markup(item.get("date")) or None, config)
        for date_format in config.get("date_formats") or [config.get("date_format")]:
            published_at, precision = parse_date(date_text, naive_zone=naive_zone, date_format=date_format)
            if published_at is not None:
                break
        if summary == title:
            summary = None
        found = PMID_IN_URL.search(link)
        entries.append(make_entry(
            external_key=key,
            url=link,
            title=title,
            summary=summary,
            published_at=published_at,
            precision=precision,
            language=guess_language(title, source.language),
            doi=normalize_doi(item.get("doi")),
            pmid=found.group(1) if found else None,
            registry=registry_ids(title, summary),
            defects=["link-derived"] if derived else [],
            identity_hint=(f"{config['identity_prefix']}:{hashlib.sha256(key.encode('utf-8')).hexdigest()[:40]}"
                           if source_page_link else None),
            feed_summary=True,
        ))
        if source_page_link:
            page_links += 1
        if len(entries) >= int(config.get("max_items") or DEFAULT_MAX_ITEMS):
            break
    notes = [f"html_list_dropped_{reason}={count}" for reason, count in dropped.items() if count]
    if page_links:
        notes.append(f"html_list_source_page_links={page_links}")
    if not raw_items:
        notes.append("html_list_no_items")
    elif entries and all(e.published_at is None for e in entries) and (config.get("selectors") or config.get("fields") or {}).get("date"):
        notes.append("html_list_dates_empty")
    return entries, notes


class HtmlListAdapter:
    """A list page read by the source's selectors (see module docstring).

    ``browser-list`` is the same reading of a page the core's headless browser rendered (the
    Ruishu-protected regulators answer plain requests with a 412/202 script page); only the
    egress differs, and that is the fetcher's business.
    """

    def __init__(self, access: str = "html-list") -> None:
        self.access = access

    def validate_config(self, source: SourceConfig) -> list[str]:
        config = source.config or {}
        mode = config.get("mode") or "html"
        problems = []
        if mode not in MODES:
            return [f"mode must be one of {MODES}"]
        date_formats = config.get("date_formats")
        if date_formats is not None and (not isinstance(date_formats, list) or not 1 <= len(date_formats) <= MAX_DATE_FORMATS
                                         or any(not isinstance(value, str) or not value.strip() for value in date_formats)):
            problems.append(f"date_formats must contain one to {MAX_DATE_FORMATS} explicit date formats")
        if mode == "script-json":
            fields = config.get("fields") or {}
            if not config.get("script_var"):
                problems.append("script-json needs config.script_var")
            for key in ("title", "link"):
                if not fields.get(key):
                    problems.append(f"script-json needs fields.{key}")
        else:
            selectors = config.get("selectors") or {}
            source_page_link = config.get("link_to_source_page") is True
            if source_page_link and not selectors.get("id"):
                problems.append("link_to_source_page requires selectors.id for stable record identity")
            if source_page_link and not re.fullmatch(r"fda:[A-Za-z0-9-]{2,40}", str(config.get("identity_prefix") or "")):
                problems.append("link_to_source_page requires an FDA event identity_prefix (fda:<namespace>)")
            page_host = urlsplit(config.get("url") or "").hostname or ""
            if source_page_link and (source.source_type != "regulator" or not host_allowed(f"https://{page_host}/", ["fda.gov", "*.fda.gov"])):
                problems.append("FDA page-linked identities are restricted to FDA regulator sources")
            for key in ("item", "title", "link"):
                if not selectors.get(key) and not (key == "link" and (config.get("link_template") or source_page_link)):
                    problems.append(f"selectors.{key} missing")
            if config.get("link_template") and "{" not in str(config["link_template"]):
                problems.append("link_template names no {id}/{date}/{title}/{summary}: every row would share one link")
            if selectors.get("item"):
                try:
                    HTMLParser("<div></div>").css(selectors["item"])
                except Exception as error:  # selectolax raises its own error types for a bad selector
                    problems.append(f"selectors.item does not parse: {type(error).__name__}")
        fallbacks = config.get("selector_fallbacks", [])
        if not isinstance(fallbacks, list) or len(fallbacks) > MAX_SELECTOR_FALLBACKS:
            problems.append("selector_fallbacks must be a list of at most three vetted candidates")
        elif fallbacks:
            if mode != "html":
                problems.append("selector recovery only supports ordinary HTML lists")
            for candidate in fallbacks:
                if not isinstance(candidate, dict) or any(not isinstance(candidate.get(key), str) or not candidate[key].strip() for key in ("item", "title", "link", "date")):
                    problems.append("each selector fallback needs item, title, link and date selectors")
                    continue
                for spec in candidate.values():
                    if not isinstance(spec, str):
                        problems.append("fallback selector values must be strings")
                        continue
                    selector = spec.partition("@")[0].strip()
                    if selector not in ("", "."):
                        try:
                            HTMLParser("<div></div>").css(selector)
                        except Exception as error:
                            problems.append(f"fallback selector does not parse: {type(error).__name__}")
        if not config.get("allowed_hosts"):
            problems.append("allowed_hosts missing (links outside the site must be refused)")
        return problems

    def plan(self, source: SourceConfig, state: SourceState, now: datetime) -> list[RequestSpec]:
        return plan_from_template(source, state, now, api=False, conditional=True)

    def parse(self, result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
        if result.not_modified:
            return ParseOutput(entries=[], notes=["html_list_not_modified"])
        if result.status != 200:
            raise FetchError("http-error", f"html_list_http_{result.status}", status=result.status)
        text = decode_body(result)
        base = result.final_url or result.request.url
        entries, notes = list_entries(text, source=source, base=base)
        # Recovery reads the same permitted page only. Candidates are vetted
        # registry data; the working primary selector is never changed.
        if not entries and (source.config.get("mode") or "html") == "html":
            # The transport already rejects challenges. Recheck before trying
            # recovery, without reclassifying a successfully rendered primary
            # list merely because its markup still contains bootstrap scripts.
            challenge = detect_challenge(result.status, result.headers.get("content-type", "text/html"), result.body, api=False)
            if challenge:
                raise FetchError("challenge", challenge, status=result.status)
            for index, candidate in enumerate((source.config.get("selector_fallbacks") or [])[:MAX_SELECTOR_FALLBACKS]):
                recovered_source = replace(source, config={**source.config, "selectors": candidate})
                recovered, recovered_notes = list_entries(text, source=recovered_source, base=base)
                if recovered and all(entry.published_at is not None for entry in recovered):
                    return ParseOutput(entries=recovered, notes=[*recovered_notes, f"html_list_recovered_selector={index}"])
        return ParseOutput(entries=entries, notes=notes)
