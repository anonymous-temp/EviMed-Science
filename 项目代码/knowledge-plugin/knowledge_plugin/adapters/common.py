"""Helpers the read methods share: text cleaning, dates, identifiers, notices, HTTP checks.

Everything here is pure (no network, no clock) so the adapters that call it stay testable with
recorded responses. The facts behind the less obvious choices were measured on 2026-09-21/22
against the live upstreams (plan 10.1, 10.2.4; ``research/dryrun-report-2026-09-21.md``):

- **Double-escaped markup.** 中国现代应用药学's RSS (``chinjmap``) ships
  ``&lt;br/&gt;&lt;p&gt;&amp;lt;p&amp;lt;藏医药…``: HTML escaped twice, and the inner ``<p<`` is itself
  broken (no ``>``). ``clean_markup`` unescapes only while a *complete* escaped tag
  (``&lt;x…&gt;``) is left (at most three rounds) — unescaping the broken one would turn the whole
  abstract into a bogus tag name — then strips tags. What is left of the broken markup
  (``<title<目的</title<<p<…``, ``<styled-content style-type="number"<4000</styled-content<``: a tag
  name, optionally with quoted attributes, followed by ``<``) is removed as markup garbage.
- **Naive timestamps are local time.** 科学网's feeds stamp ``2026-09-22 13:31`` with no zone; it is
  China time. Read as UTC it lands eight hours in the future and the core would clamp it to the
  first sighting (plan 10.3.2, the infosechot lesson). ``parse_date`` therefore takes the zone to
  apply to naive values from the caller (``naive_zone``), and adapters derive it from the source
  (``source_zone``: ``config.timezone``, else the region).
- **Mastheads and notices are flagged, never dropped** (the platform decides). The masthead list is
  an exact whole-title list (plan 10.3.2: "Editorial Board" appears in seven journals and must not
  be fuzzy-matched); notices are Crossref ``update-to`` relations plus a closed list of notice
  title forms that must be followed by ``:``/``to``/end, so "Correction of Hyponatremia …" (an
  article) is not a notice.
- **Named failures.** A response an adapter cannot use raises ``model.FetchError`` with the fetch
  outcome vocabulary (``http-error``, ``parse-error``) and a snake_case detail, so the scheduler
  records it exactly like a transport failure — never an empty success.
"""

from __future__ import annotations

import email.utils
import hashlib
import html
import json
import re
import unicodedata
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Any, Iterable
from urllib.parse import parse_qsl, quote, urlencode, urljoin, urlsplit, urlunsplit

from dateutil import tz as dateutil_tz
from selectolax.parser import HTMLParser

from ..model import SUMMARY_MAX, TITLE_MAX, FetchError, FetchResult, NormalizedEntry

UTC = timezone.utc

# ---------------------------------------------------------------------------------------------
# HTTP results
# ---------------------------------------------------------------------------------------------


def require_status(result: FetchResult, upstream: str, *, allow: Iterable[int] = (200,)) -> None:
    """Raise ``FetchError('http-error', '<upstream>_http_<status>')`` unless the status is allowed.

    The fetcher normally raises on non-2xx itself; this is the adapter's own guard for responses
    it is handed anyway (the core passes API 404s through so openFDA's "no matches" can be read).
    """
    if result.status not in set(allow):
        raise FetchError("http-error", f"{upstream}_http_{result.status}", status=result.status)


def load_json(result: FetchResult, upstream: str) -> Any:
    """Parse a JSON body; a body that is not JSON is ``parse-error`` / ``<upstream>_not_json``."""
    try:
        return json.loads(result.body.decode("utf-8-sig", errors="replace"))
    except (ValueError, UnicodeDecodeError) as error:
        raise FetchError("parse-error", f"{upstream}_not_json", status=result.status) from error


# ---------------------------------------------------------------------------------------------
# Text
# ---------------------------------------------------------------------------------------------

_WS = re.compile(r"[ \t\r\f\v\u00a0\u2000-\u200a\u202f\u205f\u3000]+")
_MANY_NEWLINES = re.compile(r"\n\s*\n+")
_ESCAPED_TAG = re.compile(r"&(?:amp;)*lt;/?[A-Za-z!][^<>&]{0,200}&(?:amp;)*gt;")
# A tag whose ">" became "<" (``<title<目的</title<<p<…``) is markup garbage, never prose.
_BROKEN_TAG = re.compile(r"</?[A-Za-z][\w:-]{0,30}(?:\s+[\w:-]+=\"[^\"<>]*\")*\s*<"
                         r"|^\s*(?:</?[A-Za-z][\w:-]{0,30}\s*)+(?=\S)")
_TAGGY = re.compile(r"<[A-Za-z!/][^>]*>")
_DROP_TAGS = ("script", "style", "noscript", "template", "svg", "iframe")
_BLOCK_TAGS = ("p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article",
               "blockquote", "table", "ul", "ol", "dd", "dt", "header", "footer")
# Crossref abstracts are JATS (``<jats:p>``, ``<jats:sec>``, ``<jats:title>``); a namespaced name is not
# a CSS selector, so JATS elements are renamed to their HTML counterparts before parsing.
_JATS_TAG = re.compile(r"<(/?)jats:([A-Za-z-]+)")
_JATS_HTML = {"p": "p", "sec": "div", "title": "h4", "list": "ul", "list-item": "li", "italic": "i", "bold": "b",
              "sup": "sup", "sub": "sub"}


def clean_markup(value: Any, *, keep_paragraphs: bool = False) -> str:
    """Markup-free, entity-free, whitespace-normalised text of an HTML/JATS/escaped fragment.

    ``keep_paragraphs`` keeps one blank-line-free newline between block elements (page excerpts);
    otherwise the result is one line (titles, summaries).
    """
    if value is None:
        return ""
    text = str(value)
    for _ in range(3):  # double-escaped feeds need two rounds; a third catches &amp;amp;lt;
        if _ESCAPED_TAG.search(text):
            text = html.unescape(text)
        else:
            break
    if "jats:" in text:
        text = _JATS_TAG.sub(lambda m: f"<{m.group(1)}{_JATS_HTML.get(m.group(2).lower(), 'span')}", text)
    if _TAGGY.search(text) or "&" in text:
        tree = HTMLParser(f"<div>{text}</div>")
        for node in tree.css(",".join(_DROP_TAGS)):
            node.decompose()
        if keep_paragraphs:
            for node in tree.css(",".join(_BLOCK_TAGS)):
                node.insert_before("\n")
        root = tree.body or tree.root
        text = root.text(separator=" " if not keep_paragraphs else "", strip=False) if root else ""
        text = html.unescape(text)  # entities selectolax leaves (e.g. inside CDATA-ish text)
    text = unicodedata.normalize("NFC", text)
    if "<" in text:
        text = _BROKEN_TAG.sub(" ", text)
    if keep_paragraphs:
        lines = [_WS.sub(" ", line).strip() for line in text.split("\n")]
        text = "\n".join(line for line in lines if line)
        return _MANY_NEWLINES.sub("\n", text).strip()
    return _WS.sub(" ", text.replace("\n", " ")).strip()


def clip_title(title: str) -> str:
    """A title within the contract bound, cut at a word boundary when it has to be cut."""
    title = title.strip()
    if len(title) <= TITLE_MAX:
        return title
    cut = title[: TITLE_MAX - 1]
    space = cut.rfind(" ")
    return (cut[:space] if space > TITLE_MAX // 2 else cut).rstrip() + "…"


# Feed summaries that end like this were cut by the publisher (plan 10.1: RSS 16.8 %, Atom 50.7 %).
TRUNCATION_MARKS = ("…", "...", "[...]", "[…]", "(...)", "read more", "continue reading", "read the full",
                    "阅读全文", "查看全文", "详情请见", "more »", "read more »", "[+]")


def looks_truncated(summary: str) -> bool:
    low = summary.strip().lower()
    stripped = low.rstrip(" .»›>)]").strip()
    return any(low.endswith(mark) or stripped.endswith(mark.rstrip(" .»›>)]")) for mark in TRUNCATION_MARKS
               if mark.rstrip(" .»›>)]"))


def summary_and_defects(summary: str | None, *, feed: bool = False) -> tuple[str | None, list[str]]:
    """Cap a summary at the contract bound and name what is wrong with it.

    ``no-summary`` when there is none; ``oversize-truncated`` when it had to be cut (the longest
    feed item measured was 79,565 characters; 2026-09-22 fharrell.com shipped 423,503); for feed
    text additionally ``truncated-summary`` when the publisher cut it (a closed list of marks).
    ``short-summary`` (< 80 characters) and ``encoding`` are the core's (normalize.py).
    """
    defects: list[str] = []
    if not summary:
        return None, ["no-summary"]
    if len(summary) > SUMMARY_MAX:
        summary = summary[: SUMMARY_MAX - 1].rstrip() + "…"
        defects.append("oversize-truncated")
    elif feed and looks_truncated(summary):
        defects.append("truncated-summary")
    return summary, defects


def cjk_share(text: str) -> float:
    letters = [c for c in text if not c.isspace()]
    if not letters:
        return 0.0
    return sum(1 for c in letters if "\u3400" <= c <= "\u9fff" or "\uf900" <= c <= "\ufaff") / len(letters)


def guess_language(text: str, default: str | None) -> str:
    """The source's language, or ``zh`` for a Chinese title from a multi-language source.

    Deterministic and deliberately coarse (script share, not language detection): the platform's
    screening model is the language judge; this only keeps an obvious Chinese title from being
    labelled English. ``und`` when the source does not say and the script does not tell.
    """
    lang = (default or "").strip()
    if lang in ("multi", "mixed", ""):
        lang = ""
    if cjk_share(text) >= 0.3:
        return "zh" if not lang.startswith("zh") else lang
    return lang or "und"


# ---------------------------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------------------------

_REGION_ZONES = {"CN": "Asia/Shanghai", "HK": "Asia/Hong_Kong", "TW": "Asia/Taipei", "JP": "Asia/Tokyo",
                 "KR": "Asia/Seoul", "SG": "Asia/Singapore"}


def zone(name: str | None) -> tzinfo:
    """A tz by IANA name; python-dateutil ships its own zone database, so slim images work too."""
    if not name or name.upper() == "UTC":
        return UTC
    found = dateutil_tz.gettz(name)
    if found is None:
        raise ValueError(f"unknown time zone {name!r}")
    return found


def source_zone(config: dict, region: str | None) -> tzinfo:
    """The zone a naive timestamp of this source is in: ``config.timezone``, else by region, else UTC.

    Only naive values use it; a timestamp that names its zone is always taken as written.
    """
    if config.get("timezone"):
        return zone(str(config["timezone"]))
    return zone(_REGION_ZONES.get((region or "").upper()))


_ISO = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$")
_SLASHED = re.compile(r"^(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$")
_COMPACT = re.compile(r"^(\d{4})(\d{2})(\d{2})$")
_US = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")
_CN = re.compile(r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2})[:：](\d{2}))?")
_EMBEDDED = re.compile(r"(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?")


def _build(parts: tuple, naive_zone: tzinfo, offset: str | None = None) -> tuple[datetime, str] | None:
    year, month, day = int(parts[0]), int(parts[1]), int(parts[2])
    has_time = len(parts) > 3 and parts[3] is not None
    hour = int(parts[3]) if has_time else 0
    minute = int(parts[4]) if has_time and parts[4] else 0
    second = int(parts[5]) if has_time and len(parts) > 5 and parts[5] else 0
    try:
        if not has_time:
            return datetime(year, month, day, tzinfo=UTC), "day"
        if offset:
            if offset == "Z":
                tz: tzinfo = UTC
            else:
                sign = 1 if offset[0] == "+" else -1
                digits = offset[1:].replace(":", "")
                tz = timezone(sign * timedelta(hours=int(digits[:2]), minutes=int(digits[2:4])))
            return datetime(year, month, day, hour, minute, second, tzinfo=tz).astimezone(UTC), "instant"
        local = datetime(year, month, day, hour, minute, second, tzinfo=naive_zone)
        return local.astimezone(UTC), "instant"
    except (ValueError, OverflowError):
        return None


def parse_date(value: Any, *, naive_zone: tzinfo = UTC, date_format: str | None = None) -> tuple[datetime | None, str]:
    """``(UTC datetime, 'instant'|'day')`` for the date forms the P0 upstreams use, else ``(None, 'day')``.

    Handled: ISO 8601 with or without time and zone; RFC 822 (feeds); ``YYYY/MM/DD[ HH:MM]``
    (PubMed); ``YYYYMMDD`` (openFDA); ``MM/DD/YYYY`` (openFDA shortages); ``2026年9月22日``;
    an explicit ``date_format`` (strptime) first when the registry names one. A date without a
    time is returned at 00:00 UTC with precision ``day`` — the calendar day as the source wrote it.
    """
    if value is None:
        return None, "day"
    if isinstance(value, datetime):
        return (value if value.tzinfo else value.replace(tzinfo=naive_zone)).astimezone(UTC), "instant"
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=UTC), "day"
    text = str(value).strip()
    if not text:
        return None, "day"
    if date_format:
        try:
            parsed = datetime.strptime(text, date_format)
        except ValueError:
            parsed = None
        if parsed is not None:
            has_time = any(code in date_format for code in ("%H", "%M", "%S"))
            if not has_time:
                return datetime(parsed.year, parsed.month, parsed.day, tzinfo=UTC), "day"
            aware = parsed if parsed.tzinfo else parsed.replace(tzinfo=naive_zone)
            return aware.astimezone(UTC), "instant"
    match = _ISO.match(text)
    if match:
        built = _build(match.groups()[:6], naive_zone, match.group(7))
        if built:
            return built
    match = _SLASHED.match(text) or _COMPACT.match(text)
    if match:
        built = _build(match.groups(), naive_zone)
        if built:
            return built
    match = _US.match(text)
    if match:
        month, day, year = match.groups()
        built = _build((year, month, day), naive_zone)
        if built:
            return built
    if re.search(r"[A-Za-z]{3},?\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}|\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{1,2}:\d{2}", text):
        try:
            parsed = email.utils.parsedate_to_datetime(text)
        except (TypeError, ValueError, IndexError):
            parsed = None
        if parsed is not None:
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=naive_zone)
            return parsed.astimezone(UTC), "instant"
    match = _CN.search(text) or _EMBEDDED.search(text)
    if match:
        built = _build(match.groups(), naive_zone)
        if built:
            return built
    return None, "day"


def epoch_ms(value: Any) -> datetime | None:
    try:
        return datetime.fromtimestamp(int(value) / 1000, tz=UTC)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


# ---------------------------------------------------------------------------------------------
# Identifiers (closed formats; principle 5 allows format checks, never prose patterns)
# ---------------------------------------------------------------------------------------------

DOI_PATTERN = re.compile(r"10\.\d{4,9}/[^\s\"'<>{}|\\^`]+", re.I)
NCT_PATTERN = re.compile(r"\bNCT\d{8}\b")
CHICTR_PATTERN = re.compile(r"\bChiCTR(?:-[A-Z]{2,4}-\d{8}|\d{10})\b")
ISRCTN_PATTERN = re.compile(r"\bISRCTN\d{8}\b")
PREPARE_PATTERN = re.compile(r"\bPREPARE-\d{4}[A-Z]{2}\d{1,6}\b")
PMID_IN_URL = re.compile(r"pubmed\.ncbi\.nlm\.nih\.gov/(\d{1,9})/?(?:[?#]|$)")


def normalize_doi(value: Any) -> str | None:
    """Lower-case bare DOI (``10.x/…``) from a DOI, ``doi:`` form or doi.org URL; else ``None``."""
    if not value:
        return None
    match = DOI_PATTERN.search(str(value))
    if not match:
        return None
    doi = match.group(0).rstrip(".,;:)]}")
    if doi.count("(") < doi.count(")"):
        doi = doi.rstrip(")")
    return doi.lower()


def registry_ids(*texts: Any) -> list[str]:
    """Trial and guideline registry ids found in the texts (NCT, ChiCTR, ISRCTN, PREPARE), in order."""
    found: list[str] = []
    for text in texts:
        if not text:
            continue
        for pattern in (NCT_PATTERN, CHICTR_PATTERN, ISRCTN_PATTERN, PREPARE_PATTERN):
            for match in pattern.findall(str(text)):
                if match not in found:
                    found.append(match)
    return found


def key_hash(*parts: Any) -> str:
    """A stable short key for records that have no id of their own (sha256 of the joined parts)."""
    return hashlib.sha256("\u0000".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:40]


# ---------------------------------------------------------------------------------------------
# Mastheads and notices (flagged, never dropped)
# ---------------------------------------------------------------------------------------------

# Whole titles of a journal's fixed pages, compared after casefolding and punctuation folding.
MASTHEAD_TITLES = frozenset({
    "editorial board", "editorial boards", "editorial board and contents", "editorial board page",
    "table of contents", "contents", "contents list", "issue information", "issue information page",
    "cover", "cover image", "cover picture", "front cover", "back cover", "inside front cover",
    "inside back cover", "outside front cover", "outside back cover", "cover and editorial board",
    "masthead", "front matter", "back matter", "full issue", "full issue pdf", "title page",
    "information for authors", "instructions for authors", "guide for authors", "author index",
    "subject index", "index", "in this issue", "this issue", "journal information", "copyright page",
    "advertisement", "advertisements", "subscription information", "ifc", "ibc", "obc",
    "reviewer acknowledgement", "reviewer acknowledgements", "reviewer acknowledgment",
    "acknowledgement to reviewers", "acknowledgment to reviewers", "acknowledgement of reviewers",
    "thank you to our reviewers", "list of reviewers", "reviewers", "announcements",
})

_FOLD_PUNCT = re.compile(r"[\s\u3000.,:;!?'\"“”‘’()\[\]{}\-–—_/\\|*·•]+")


def fold_title(title: str) -> str:
    return _FOLD_PUNCT.sub(" ", unicodedata.normalize("NFKC", title).casefold()).strip()


def is_masthead_title(title: str) -> bool:
    return fold_title(title) in MASTHEAD_TITLES


# Notice forms: the word(s), then ':' / '：' / 'to' / a quote / end of title. Not "of" or "for":
# "Correction of Hyponatremia …" and "Correction for multiple testing …" are articles.
_NOTICE_TITLE = re.compile(
    r"^(?:(?:author|publisher|editorial|editor'?s?)\s+)?"
    r"(?:correction|corrections|corrigendum|corrigenda|erratum|errata|retraction|retraction note|"
    r"retraction notice|notice of retraction|partial retraction|withdrawal|notice of withdrawal|"
    r"expression of concern|editorial expression of concern|notice of concern|addendum|"
    r"retracted article|retracted)"
    r"(?:\s*[:：]|\s+to\b|\s*[\"“‘']|\s*$)",
    re.I,
)
NOTICE_UPDATE_TYPES = frozenset({
    "correction", "corrigendum", "erratum", "retraction", "partial_retraction", "removal", "withdrawal",
    "expression_of_concern", "clarification", "addendum",
})


def is_notice_title(title: str) -> bool:
    return bool(_NOTICE_TITLE.match(unicodedata.normalize("NFKC", title).strip()))


# ---------------------------------------------------------------------------------------------
# URLs
# ---------------------------------------------------------------------------------------------


def set_query_param(url: str, name: str, value: str | None) -> str:
    """``url`` with ``name`` set to ``value`` (``None`` removes it); other parameters keep order and bytes."""
    parts = urlsplit(url)
    pairs = [p for p in parts.query.split("&") if p] if parts.query else []
    encoded_name = quote(name, safe="[]._-~")
    kept = [p for p in pairs if p.split("=", 1)[0] != encoded_name and p.split("=", 1)[0] != name]
    if value is not None:
        kept.append(f"{encoded_name}={quote(str(value), safe='*-._~:,')}")
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "&".join(kept), parts.fragment))


def query_param(url: str, name: str) -> str | None:
    for key, value in parse_qsl(urlsplit(url).query, keep_blank_values=True):
        if key == name:
            return value
    return None


def absolute_url(link: Any, base: str) -> str | None:
    """An absolute http(s) URL for ``link`` resolved against ``base``; ``None`` for anything else."""
    if not link:
        return None
    text = html.unescape(str(link)).strip()
    if not text or text.startswith(("#", "javascript:", "mailto:", "tel:", "data:")):
        return None
    resolved = urljoin(base, text)
    parts = urlsplit(resolved)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    return resolved


def host_allowed(url: str, allowed_hosts: Iterable[str] | None) -> bool:
    """True when the URL's host is one of ``allowed_hosts`` (or a subdomain of one); no list = any."""
    hosts = [h.lower().lstrip(".") for h in (allowed_hosts or []) if h]
    if not hosts:
        return True
    host = (urlsplit(url).hostname or "").lower()
    return any(host == h or host.endswith("." + h) for h in hosts)


def strip_params(url: str, names: Iterable[str]) -> str:
    """Drop the named query parameters (feed-tracking tags like medRxiv's ``?rss=1``)."""
    drop = set(names)
    parts = urlsplit(url)
    if not parts.query or not drop:
        return url
    kept = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k not in drop]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(kept, safe=":/"), parts.fragment))


# ---------------------------------------------------------------------------------------------
# Entry assembly
# ---------------------------------------------------------------------------------------------


def make_entry(*, external_key: str, url: str, title: str, summary: str | None = None,
               published_at: datetime | None = None, precision: str = "instant", language: str = "und",
               doi: str | None = None, pmid: str | None = None, registry: list[str] | None = None,
               facts: dict | None = None, defects: Iterable[str] = (), identity_hint: str | None = None,
               lane_hint: str | None = None, feed_summary: bool = False) -> NormalizedEntry:
    """One ``NormalizedEntry`` with the adapter-side defects filled in (see ``summary_and_defects``)."""
    capped, summary_defects = summary_and_defects(summary or None, feed=feed_summary)
    all_defects: list[str] = []
    for defect in [*defects, *summary_defects]:
        if defect not in all_defects:
            all_defects.append(defect)
    clean_facts = {k: v for k, v in (facts or {}).items() if v is not None and v != "" and v != []}
    return NormalizedEntry(
        external_key=external_key[:512],
        url=url,
        title=clip_title(title),
        summary=capped,
        published_at=published_at,
        date_precision=precision if published_at is not None else "instant",
        language=language or "und",
        doi=doi,
        pmid=pmid,
        registry_ids=list(registry or []),
        lane_hint=lane_hint,
        facts=clean_facts,
        defects=all_defects,
        identity_hint=identity_hint,
    )


def dig(record: Any, path: str) -> Any:
    """``record['a']['b']…`` for the dotted ``path``; a string holding JSON is entered as JSON.

    NDCPA's list carries ``"aU": "{\\"common\\": \\"/jbkzzx/…\\"}"`` — a JSON document inside a JSON
    string — so ``aU.common`` has to parse the inner document.
    """
    current = record
    for key in path.split("."):
        if isinstance(current, str) and current.strip().startswith(("{", "[")):
            try:
                current = json.loads(current)
            except ValueError:
                return None
        if isinstance(current, dict):
            current = current.get(key)
        elif isinstance(current, list) and key.isdigit():
            index = int(key)
            current = current[index] if index < len(current) else None
        else:
            return None
        if current is None:
            return None
    return current
