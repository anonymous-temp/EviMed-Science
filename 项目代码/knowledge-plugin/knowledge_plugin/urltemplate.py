"""URL templates of the runtime registry: the grammar, the values, and the literal-date check.

The probe registry the plan shipped had 163 endpoints with the check day baked in — openFDA's
recall query read ``report_date:[20260801 TO 20260930]`` and would have returned nothing new from
1 October on, without an error (plan 10.2.9, review finding 13 #7). Every runtime URL is therefore
a template, rendered at plan time, and the registry load test refuses a literal date.

Grammar: ``{name}`` or ``{name:format}``; ``name`` is one of ``TEMPLATE_FIELDS``. Date fields take
a ``strftime`` format (default ``%Y-%m-%d``) and are inserted as formatted (the formats allowed are
URL-safe); string fields are percent-encoded except ``*-._~:``. Anything that is not a lower-case
name in braces is literal text (OData's ``$top``, Europe PMC's ``[a TO b]`` ranges).

Values (``template_values``):

- ``since``  — start of the read window: ``now - lookback_days`` (default 7) on first contact and
  on the scheduler's daily full rescan, else ``last_ok_at - overlap_days`` (default 1) but never
  before ``now - lookback_days``. Incremental reads re-cover one day, so a registration that lands
  late in Crossref or PubMed is not lost, and the idempotent store makes the overlap free.
- ``until`` / ``now`` / ``today`` — the poll time (``today`` reads naturally with ``%Y%m%d``).
- ``issn`` — ``config.issn``; ``cursor`` — ``state.cursor['cursor']`` or ``config.cursor_start``
  (Crossref and Europe PMC deep paging start from ``*``); ``lookback_days`` — the integer.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Mapping
from urllib.parse import quote, unquote

from .model import SourceConfig, SourceState

DATE_FIELDS = frozenset({"since", "until", "now", "today"})
STRING_FIELDS = frozenset({"issn", "cursor", "lookback_days"})
TEMPLATE_FIELDS = DATE_FIELDS | STRING_FIELDS

DEFAULT_LOOKBACK_DAYS = 7
DEFAULT_OVERLAP_DAYS = 1

_PLACEHOLDER = re.compile(r"\{([a-z_]+)(?::([^{}]*))?\}")
# strftime directives that can appear in a URL-safe date: digits and a few separators only.
_SAFE_DATE_FORMAT = re.compile(r"^(?:%[YmdHMSjz]|[-/:T. Z0-9])*$")


class TemplateError(ValueError):
    """A template names a field this build does not know, or a format that is not URL-safe."""


def placeholders(template: str) -> list[tuple[str, str | None]]:
    """Every ``(name, format)`` pair in a template, in order."""
    return [(m.group(1), m.group(2)) for m in _PLACEHOLDER.finditer(template)]


def validate_template(template: str) -> None:
    """Raise ``TemplateError`` for an unknown field or an unsafe date format."""
    for name, fmt in placeholders(template):
        if name not in TEMPLATE_FIELDS:
            raise TemplateError(f"unknown template field {{{name}}}")
        if name in DATE_FIELDS and fmt is not None and not _SAFE_DATE_FORMAT.match(fmt):
            raise TemplateError(f"unsafe date format {{{name}:{fmt}}}")
        if name in STRING_FIELDS and fmt:
            raise TemplateError(f"string field {{{name}}} takes no format")


def window_since(source: SourceConfig, state: SourceState, now: datetime) -> datetime:
    """Start of the read window (see module docstring)."""
    config = source.config or {}
    lookback = timedelta(days=int(config.get("lookback_days", DEFAULT_LOOKBACK_DAYS)))
    overlap = timedelta(days=int(config.get("overlap_days", DEFAULT_OVERLAP_DAYS)))
    floor = now - lookback
    if state.last_ok_at is None:
        return floor
    return max(floor, state.last_ok_at - overlap)


def template_values(source: SourceConfig, state: SourceState, now: datetime) -> dict[str, Any]:
    """The values a template of this source renders with at ``now``."""
    config = source.config or {}
    cursor = (state.cursor or {}).get("cursor") or config.get("cursor_start") or "*"
    return {
        "since": window_since(source, state, now),
        "until": now,
        "now": now,
        "today": now,
        "issn": config.get("issn") or "",
        "cursor": str(cursor),
        "lookback_days": str(int(config.get("lookback_days", DEFAULT_LOOKBACK_DAYS))),
    }


def render_template(template: str, values: Mapping[str, Any]) -> str:
    """Render ``template`` with ``values``; unknown fields raise ``TemplateError``."""

    def replace(match: re.Match[str]) -> str:
        name, fmt = match.group(1), match.group(2)
        if name not in TEMPLATE_FIELDS:
            raise TemplateError(f"unknown template field {{{name}}}")
        if name not in values:
            raise TemplateError(f"no value for template field {{{name}}}")
        value = values[name]
        if isinstance(value, (datetime, date)):
            text_format = fmt or "%Y-%m-%d"
            if not _SAFE_DATE_FORMAT.match(text_format):
                raise TemplateError(f"unsafe date format {{{name}:{text_format}}}")
            if isinstance(value, datetime) and value.tzinfo is not None:
                value = value.astimezone(timezone.utc)
            return value.strftime(text_format)
        return quote(str(value), safe="*-._~:")

    return _PLACEHOLDER.sub(replace, template)


# A literal calendar date in a URL: 2026-09-14, 2026/09/14, 20260914 (as a whole digit run),
# 2026-09 / 202609 when followed by a non-digit, and the percent-encoded range forms.
_LITERAL_DATE_PATTERNS = (
    re.compile(r"(?<!\d)20\d{2}[-/.](?:0[1-9]|1[0-2])[-/.](?:0[1-9]|[12]\d|3[01])(?!\d)"),
    re.compile(r"(?<!\d)20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?!\d)"),
    re.compile(r"(?<![\d-])20\d{2}-(?:0[1-9]|1[0-2])(?![\d-])"),
)
# A bare year of the probe season as a whole path/query token (novel-drug-approvals-2026).
_LITERAL_YEAR = re.compile(r"(?<![\d.])(?:2025|2026|2027)(?![\d.])")


def literal_dates(url: str) -> list[str]:
    """Date-like literals left in a URL once its placeholders are blanked out.

    Checked on the raw and the percent-decoded text: ISRCTN's ``q=lastEdited%20GE%202026-09-14``
    hides its date behind ``%20`` (the ``0`` of the escape defeats a digit boundary).
    """
    blanked = _PLACEHOLDER.sub("", url)
    found: list[str] = []
    for text in (blanked, unquote(blanked)):
        for pattern in _LITERAL_DATE_PATTERNS:
            found.extend(pattern.findall(text))
        found.extend(_LITERAL_YEAR.findall(text))
    return sorted(set(found))
