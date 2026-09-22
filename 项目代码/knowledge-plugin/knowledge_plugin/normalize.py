"""Normalisation: what an adapter emitted becomes a deliverable entry (plan 10.3.2, 10.3.3).

Two steps, deliberately separate:

``prepare(entry, source)`` is pure in the adapter's output. It cleans text, derives a missing link
from identifiers, canonicalises the URL, climbs the identity ladder, whitelists the facts, flags
mastheads and correction notices, records the content defects, and hashes the result. The hash
covers the *adapter's* dates, not the dates normalisation infers — so the second sighting of an
undated item, or of one dated in the future, hashes the same as the first and is a no-op instead
of a new revision every poll.

``resolve_dates(prepared, first_seen_at)`` then applies the date rules against the first sighting:
no date → ``first_seen_at`` with precision ``inferred`` and the ``no-date`` defect; **any** future
timestamp → clamped to ``first_seen_at``, ``inferred``, ``future-date``. Only blocking "more than
24 h ahead" is not enough: a Chinese feed that labels Beijing time as GMT is exactly 8 h ahead and
would sit on top of "today" for 8 hours (infosechot learned this; plan 10.3.2). A ``day``-precision
date is a calendar day in the source's own zone, so it counts as future only when it is later
than the current day at UTC+14, the earliest zone on Earth.

The identity ladder (contract rule 3): ``doi:`` > ``pmid:`` > ``wx:<biz>:<mid>:<idx>`` >
``reg:<id>:<event>:<date>`` > ``fda:<application>:<supplement>`` > ``url:<sha256(canonical)>``.
The ``wx:``/``reg:``/``fda:`` rungs come from the adapter's ``identity_hint`` (registry and database
sources key the *event*, not the object: "results posted" is news again years after
"registered"); a malformed hint is ignored with a note, never trusted.

Mastheads (editorial board, table of contents …) and correction notices are FLAGGED in ``facts``,
never dropped here: dropping is the platform's decision (``is_masthead``, ``is_correction_notice``).
Both are exact closed-list matches on the title — a format check, not language judgement.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, quote, unquote, urlsplit, urlunsplit

from .model import (
    DEFECTS, EXTERNAL_KEY_MAX, FACT_TYPES, LANES, SHORT_SUMMARY_MIN, SUMMARY_MAX, TITLE_MAX,
    TRIAL_EVENTS, UPDATE_TO_KEYS, URL_MAX, NormalizedEntry, SourceConfig,
)

# ------------------------------------------------------------------------------------ text

_CONTROL = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b\u2060\ufeff]")
_SPACE = re.compile(r"\s+")


def clean_text(text: str | None) -> str:
    """NFC, control and zero-width characters removed, whitespace collapsed."""
    if not text:
        return ""
    text = unicodedata.normalize("NFC", str(text))
    text = _CONTROL.sub("", text)
    return _SPACE.sub(" ", text).strip()


def cut(text: str, limit: int) -> str:
    """Cut to at most ``limit`` characters, ending with an ellipsis when cut."""
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


TRUNCATION_MARKS = ("…", "...", "[...]", "[…]", "(...)", "read more", "continue reading", "read the full",
                    "more »", "阅读全文", "查看全文", "详情请见", "点击查看")


def looks_truncated(summary: str) -> bool:
    low = summary.strip().lower().rstrip(" »›>")
    return any(low.endswith(mark) for mark in TRUNCATION_MARKS)


# ------------------------------------------------------------------------------------ URLs

# Query parameters that only track the reader; dropping them never changes the document.
TRACKING_PARAMS = frozenset({
    "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "mc_cid", "mc_eid", "_hsenc",
    "_hsmi", "__hstc", "__hssc", "__hsfp", "hsctatracking", "mkt_tok", "igshid", "spm", "scm", "_ga", "_gl",
    "trk", "trkcampaign", "wt.mc_id", "wt_mc", "cmpid", "icid", "ncid", "sr_share",
})


def _is_tracking(key: str) -> bool:
    low = key.lower()
    return low.startswith("utm_") or low in TRACKING_PARAMS


def canonical_url(url: str) -> str:
    """The comparison form of a link (plan 10.3.3): https, lower-case host without default port,
    no fragment, no tracking parameters, remaining parameters sorted. ``url`` itself is delivered
    unchanged; this form only keys identity."""
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    if scheme == "http":
        scheme = "https"
    host = (parts.hostname or "").lower().rstrip(".")
    try:
        host = host.encode("idna").decode("ascii") if host and not host.isascii() else host
    except UnicodeError:
        pass
    port = parts.port
    if port and not ((scheme == "https" and port in (443, 80)) or (scheme == "http" and port == 80)):
        host = f"{host}:{port}"
    path = quote(unquote(parts.path or "/"), safe="/:@!$&'()*+,;=-._~")
    query = sorted((k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not _is_tracking(k))
    query_text = "&".join(f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in query)
    return urlunsplit((scheme, host, path, query_text, ""))


def _valid_http_url(url: str) -> bool:
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and bool(parts.hostname) and "@" not in (parts.netloc or "")


# ------------------------------------------------------------------------------------ identifiers

_DOI = re.compile(r"^10\.\d{4,9}/\S+$")
_DOI_PREFIX = re.compile(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", re.I)
_PMID = re.compile(r"^\d{1,10}$")
_REGISTRY_ID = re.compile(r"^[A-Z][A-Z0-9]{1,15}[-/]?[A-Z0-9][A-Z0-9./-]{2,40}$")
_HINT = {
    "wx": re.compile(r"^wx:[^:\s]{1,100}:[^:\s]{1,100}:[^:\s]{1,20}$"),
    "reg": re.compile(r"^reg:[A-Za-z0-9./-]{3,60}:(?:%s):\d{4}-\d{2}-\d{2}$" % "|".join(TRIAL_EVENTS)),
    "fda": re.compile(r"^fda:[A-Za-z0-9-]{2,40}:[A-Za-z0-9-]{1,40}$"),
}


def normalize_doi(value: str | None) -> str | None:
    if not value:
        return None
    doi = _DOI_PREFIX.sub("", unquote(str(value).strip())).strip().rstrip(".,;)").lower()
    return doi if _DOI.match(doi) and len(doi) <= 300 else None


def normalize_pmid(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text if _PMID.match(text) and text != "0" else None


# Registry prefixes whose canonical spelling is not all capitals (ChiCTR writes its ids
# "ChiCTR2600132031"); every other registry id is upper case (NCT…, ISRCTN…, EUCTR…, ACTRN…).
_REGISTRY_CASE = {"CHICTR": "ChiCTR"}


def normalize_registry_ids(values) -> list[str]:
    out: list[str] = []
    for value in values or []:
        text = clean_text(str(value)).upper()
        if not _REGISTRY_ID.match(text):
            continue
        for upper, canonical in _REGISTRY_CASE.items():
            if text.startswith(upper):
                text = canonical + text[len(upper):]
        if text not in out:
            out.append(text)
    return out[:20]


def entry_id_for(source_id: str, external_key: str) -> str:
    """``<source_id>:<sha256(external_key)[0:32]>`` (contract Entry.entry_id)."""
    return f"{source_id}:{hashlib.sha256(external_key.encode('utf-8')).hexdigest()[:32]}"


def key_sha256(external_key: str) -> str:
    return hashlib.sha256(external_key.encode("utf-8")).hexdigest()


def identity_key(doi: str | None, pmid: str | None, hint: str | None, canonical: str) -> str:
    if doi:
        return f"doi:{doi}"
    if pmid:
        return f"pmid:{pmid}"
    if hint:
        for rung in ("wx", "reg", "fda"):
            if hint.startswith(rung + ":"):
                return hint
    return "url:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def valid_hint(hint: str | None) -> str | None:
    if not hint:
        return None
    rung = hint.split(":", 1)[0]
    pattern = _HINT.get(rung)
    return hint if pattern and pattern.match(hint) else None


# ------------------------------------------------------------------------------------ facts

def _norm_title(title: str) -> str:
    folded = unicodedata.normalize("NFKC", title).lower()
    folded = _SPACE.sub(" ", folded).strip()
    return folded.rstrip(" .:：;")


# The fixed pages of a journal issue, matched on the whole title (plan 10.3.2: "一张很短的整标题精确匹配表").
MASTHEAD_TITLES = frozenset(_norm_title(t) for t in (
    "Editorial Board", "Editorial board and contents", "Table of Contents", "Contents", "Issue Information",
    "Issue Information - Editorial Board", "Issue Information - Table of Contents", "Cover", "Front Cover",
    "Back Cover", "Inside Front Cover", "Inside Back Cover", "Cover Image", "Cover Picture", "Front Cover Image",
    "Masthead", "Masthead and Table of Contents", "Front Matter", "Back Matter", "Frontmatter", "Backmatter",
    "In This Issue", "This Issue", "Issue Highlights", "Information for Authors", "Instructions for Authors",
    "Author Index", "Subject Index", "Title Page", "Copyright Page", "Advertisement", "Reviewer Acknowledgement",
    "Reviewer Acknowledgment", "Acknowledgement to Reviewers", "Acknowledgment to Reviewers",
    "Thank You to Our Reviewers", "Reviewers", "目录", "目次", "封面", "封底", "编委会", "本期导读", "期刊目录",
))

# Notices that point at another publication (plan 10.3.2 "更正、勘误、撤稿声明": kept, flagged). A closed
# list of notice phrases, each followed by the end, a colon, or "to/in/on" — so "Correction of
# adolescent scoliosis" (a surgical paper) is not a notice. "for" counts only with an "et al"
# reference after it: PNAS titles its notices "Correction for Smith et al., …", while "Correction for
# multiple testing in …" is a methods paper. "RETRACTED:" is deliberately absent: that is the
# retracted article itself, not a notice.
_CORRECTION_NOTICE = re.compile(
    r"^(?:editorial expression of concern|expression of concern|notice of retraction|notice of correction|"
    r"retraction notice|retraction note|author correction|publisher correction|corrigend(?:um|a)|errat(?:um|a)|"
    r"corrections?|retraction|更正|勘误|撤稿声明)(?:$|\s*[:：]|\s+(?:to|in|on)\b|\s+for\b.*\bet al\b)"
)


def is_masthead_title(title: str) -> bool:
    return _norm_title(title) in MASTHEAD_TITLES


def is_correction_title(title: str) -> bool:
    return _CORRECTION_NOTICE.match(_norm_title(title)) is not None


def whitelist_facts(facts: dict | None) -> tuple[dict, list[str]]:
    """Keep only contract ``Entry.facts`` keys with the right JSON types; report what was dropped."""
    kept: dict = {}
    dropped: list[str] = []
    for key, value in (facts or {}).items():
        expected = FACT_TYPES.get(key)
        if expected is None:
            dropped.append(key)
            continue
        if expected is bool:
            if isinstance(value, bool):
                kept[key] = value
            else:
                dropped.append(key)
        elif expected is int:
            if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 1_000_000:
                kept[key] = value
            else:
                dropped.append(key)
        elif expected is str:
            text = clean_text(value) if isinstance(value, str) else ""
            if text and (key != "trial_event" or text in TRIAL_EVENTS):
                kept[key] = cut(text, 500)
            else:
                dropped.append(key)
        elif key == "update_to":
            items = []
            for item in value if isinstance(value, list) else []:
                if isinstance(item, dict):
                    clean = {k: clean_text(item[k])[:300] for k in UPDATE_TO_KEYS if isinstance(item.get(k), str) and item[k].strip()}
                    if clean:
                        items.append(clean)
            if items:
                kept[key] = items[:20]
            else:
                dropped.append(key)
    return kept, dropped


# ------------------------------------------------------------------------------------ prepare

@dataclass
class Prepared:
    """An entry ready for the store, before its dates are resolved against the first sighting."""

    source_id: str
    external_key: str
    entry_id: str
    key_sha256: str
    identity_key: str
    url: str
    canonical_url: str
    doi: str | None
    pmid: str | None
    registry_ids: list[str]
    title: str
    summary: str | None
    language: str
    lane_hint: str | None
    raw_published_at: datetime | None
    raw_precision: str
    facts: dict
    defects: list[str]
    content_sha256: str
    notes: list[str] = field(default_factory=list)


class Rejected(ValueError):
    """The adapter emitted something that cannot become an entry (no title, no usable link)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


_LANGUAGE = re.compile(r"^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _derived_link(doi: str | None, pmid: str | None, registry_ids: list[str]) -> str | None:
    if doi:
        return f"https://doi.org/{doi}"
    if pmid:
        return f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"
    for rid in registry_ids:
        if rid.startswith("NCT"):
            return f"https://clinicaltrials.gov/study/{rid}"
    return None


def prepare(entry: NormalizedEntry, source: SourceConfig) -> Prepared:
    """Finish an adapter's entry; raises ``Rejected`` when it cannot be delivered."""
    notes: list[str] = []
    defects = [d for d in dict.fromkeys(entry.defects or []) if d in DEFECTS and d not in ("no-date", "future-date")]
    unknown = [d for d in entry.defects or [] if d not in DEFECTS]
    if unknown:
        notes.append("dropped_defects:" + ",".join(sorted(set(unknown)))[:120])

    title = clean_text(entry.title)
    if not title:
        raise Rejected("no_title")
    if len(title) > TITLE_MAX:
        title = cut(title, TITLE_MAX)
        defects.append("oversize-truncated")

    doi = normalize_doi(entry.doi)
    if entry.doi and not doi:
        notes.append("invalid_doi")
    pmid = normalize_pmid(entry.pmid)
    registry_ids = normalize_registry_ids(entry.registry_ids)

    url = (entry.url or "").strip()
    if not _valid_http_url(url):
        derived = _derived_link(doi, pmid, registry_ids)
        if not derived:
            raise Rejected("no_link")
        url = derived
        defects.append("link-derived")
    if len(url) > URL_MAX:
        raise Rejected("url_too_long")
    canonical = canonical_url(url)
    if len(canonical) > URL_MAX:
        raise Rejected("url_too_long")

    external_key = clean_text(entry.external_key) or canonical
    if len(external_key) > EXTERNAL_KEY_MAX:
        external_key = "sha256:" + key_sha256(external_key)

    summary = clean_text(entry.summary) or None
    if summary is None:
        defects.append("no-summary")
    else:
        if len(summary) > SUMMARY_MAX:
            summary = cut(summary, SUMMARY_MAX)
            defects.append("oversize-truncated")
        elif looks_truncated(summary):
            defects.append("truncated-summary")
        if len(summary) < SHORT_SUMMARY_MIN:
            defects.append("short-summary")
    if "�" in title or (summary and "�" in summary):
        defects.append("encoding")

    language = (entry.language or "und").strip()
    if language == "und" or not _LANGUAGE.match(language):
        language = source.language if source.language and _LANGUAGE.match(source.language) and source.language != "mul" else "und"

    lane_hint = entry.lane_hint if entry.lane_hint in LANES else None
    if entry.lane_hint and not lane_hint:
        notes.append("invalid_lane_hint")

    facts, dropped = whitelist_facts(entry.facts)
    if dropped:
        notes.append("dropped_facts:" + ",".join(sorted(set(dropped)))[:120])
    if is_masthead_title(title):
        facts["is_masthead"] = True
    if facts.get("update_to") or is_correction_title(title):
        facts["is_correction_notice"] = True

    hint = valid_hint(entry.identity_hint)
    if entry.identity_hint and not hint:
        notes.append("invalid_identity_hint")
    identity = identity_key(doi, pmid, hint, canonical)

    precision = entry.date_precision if entry.date_precision in ("instant", "day") else "instant"
    raw_published = _as_utc(entry.published_at)
    defects = list(dict.fromkeys(defects))

    hashed = {
        "canonical_url": canonical,
        "identity_key": identity,
        "doi": doi,
        "pmid": pmid,
        "registry_ids": registry_ids,
        "title": title,
        "summary": summary,
        "language": language,
        "lane_hint": lane_hint,
        "published_at": raw_published.isoformat() if raw_published else None,
        "date_precision": precision if raw_published else None,
        "facts": facts,
        "defects": sorted(defects),
    }
    content = hashlib.sha256(json.dumps(hashed, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    return Prepared(
        source_id=source.id,
        external_key=external_key,
        entry_id=entry_id_for(source.id, external_key),
        key_sha256=key_sha256(external_key),
        identity_key=identity,
        url=url,
        canonical_url=canonical,
        doi=doi,
        pmid=pmid,
        registry_ids=registry_ids,
        title=title,
        summary=summary,
        language=language,
        lane_hint=lane_hint,
        raw_published_at=raw_published,
        raw_precision=precision,
        facts=facts,
        defects=defects,
        content_sha256=content,
        notes=notes,
    )


# ------------------------------------------------------------------------------------ dates

EARLIEST_ZONE = timedelta(hours=14)
BACKFILL_WINDOW = timedelta(days=7)


def resolve_dates(prepared: Prepared, first_seen_at: datetime) -> tuple[datetime, str, list[str]]:
    """(published_at, date_precision, date defects) for delivery, per the module docstring."""
    raw = prepared.raw_published_at
    if raw is None:
        return first_seen_at, "inferred", ["no-date"]
    if prepared.raw_precision == "day":
        if raw.date() > (first_seen_at + EARLIEST_ZONE).date():
            return first_seen_at, "inferred", ["future-date"]
        return raw, "day", []
    if raw > first_seen_at:
        return first_seen_at, "inferred", ["future-date"]
    return raw, "instant", []


def is_backfill(prepared: Prepared, first_seen_at: datetime, first_contact: bool) -> bool:
    """Contract rule 5: on a source's first successful poll only the last 7 days are new.

    Undated entries cannot prove they are recent and count as old; a future date (a mislabelled
    zone) is recent by definition. Outside first contact nothing is backfill.
    """
    if not first_contact:
        return False
    raw = prepared.raw_published_at
    if raw is None:
        return True
    horizon = first_seen_at - BACKFILL_WINDOW
    if prepared.raw_precision == "day":
        return raw.date() < horizon.date()
    return raw < horizon
