"""``evimed-api``: scheduled scans of the owner's EviMed evidence API (plan 12.2, 14.7 batch 2).

POST JSON to ``https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/v2/…`` with
``Authorization: Bearer <key>``; the key is the fetcher's business (``KNOWLEDGE_PLUGIN_EVIMED_API_KEY_FILE``,
injected per host) and never appears in a request built here. One registry row per scan, the
family in ``config.family``:

``chictr`` (daily)
    ``clinical-trial`` with ``registry=0`` (ChiCTR, which answers 405 to direct programs), one
    request per specialty term in ``config.queries`` (20 on the plan's list), ``startYear`` = the
    year the window starts in, ``count`` 100. New = registered within ``config.new_within_days``
    (14). Measured 2026-09-22: 20 terms → 1,418 registrations of 2026, newest registered 09-18 (the
    index lags about 4 days); answers are ranked by relevance, not date, so the window is applied
    here. Two versions answer, with different fields: ``v2/clinical-trial`` records carry ``id``
    (``ChiCTR2600122474``), a lower-cased ``registrationNo`` (``chictr2600122474``) and the
    ``interventions``, but **no sponsor**; v1 ``clinical-trial`` records carry ``primarySponsor``
    (100 of 100 filled) and the registry's own ``registrationNo``, but no interventions. The default
    endpoint is v1, because the sponsor is one of the entry's facts; a row whose ``config.url``
    names v2 is read the same way (the summary then names the interventions instead). ``url`` points
    at WHO ICTRP; ``phase`` comes lower-cased (``ii期临床试验``). Identity is event-level and the same
    for both versions: ``reg:<ChiCTR id>:registered:<date>``.
``guide`` (weekly)
    ``v2/literature-guide`` with ``type=guide``, ``startYear`` = the window's year, ``count`` 100, one
    request per term in ``config.queries``. New = an id published within ``new_within_days`` (30).
    Measured 2026-09-22: the ``publishers`` filter has no effect (the 中华医学会 group returned a
    Korean society's guideline), 30 publisher groups returned 69 distinct guidelines of 2026 and
    the newest was published 2026-03-04 — the index lags about six months, which is why the plan
    keeps the society list pages as the guideline source and this scan weekly. Some records carry
    a year-only ``publicationDate`` (``2026``): their recency is unknown, so they are not new.

Request bodies (``plan``): one POST per term of ``config.queries`` (alias ``config.terms``); the body
is ``DEFAULT_BODY`` of the family, then the top-level ``registry``/``count``/``type`` keys, then
``config.body``, then ``startYear``. For ``guide`` rows without ``queries``, one request per group
of ``config.publisher_groups`` with ``config.query`` (default "指南 共识") and ``publishers`` — the
2026-09-22 sweep's form, kept for compatibility although the filter did nothing then.

A body's ``code`` is the API's own status (it can say 401 inside an HTTP 200 —
``{"code":401,"msg":"当前api_key不存在"}`` recorded 2026-09-22): 401/403 are ``blocked`` (key missing /
balance), 429 ``http-error`` with a retry delay, anything else not 200 ``http-error``. Entries are
built from whitelisted fields only.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from typing import Any

from ..model import FetchError, FetchResult, NormalizedEntry, ParseOutput, RequestSpec, SourceConfig, SourceState
from .common import clean_markup, guess_language, load_json, make_entry, parse_date, registry_ids

API_BASE = "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/"
FAMILIES = ("chictr", "guide")
DEFAULT_NEW_WITHIN = {"chictr": 14, "guide": 30}
DEFAULT_ENDPOINT = {"chictr": API_BASE + "clinical-trial", "guide": API_BASE + "v2/literature-guide"}
DEFAULT_BODY = {"chictr": {"count": 100, "registry": 0}, "guide": {"type": "guide", "count": 100}}
# The 20 specialty terms of the 2026-09-22 freshness sweep (tools/evimed_api_freshness.py).
CHICTR_TERMS = ("肿瘤", "心血管", "糖尿病", "神经", "精神", "感染", "呼吸", "重症", "消化", "肝病", "肾脏", "风湿免疫",
                "血液", "儿科", "妇产", "老年", "外科", "麻醉", "中医药", "药物")
GUIDE_TERMS = ("指南", "专家共识", "临床实践指南", "诊疗规范")
_CHICTR_ID = re.compile(r"^chictr(-?[a-z]{2,4}-?\d{8}|\d{10})$", re.I)
API_CODES = {401: ("blocked", "evimed_unauthorized"), 403: ("blocked", "evimed_balance_or_forbidden"),
             429: ("http-error", "evimed_rate_limited"), 400: ("parse-error", "evimed_bad_request")}


def chictr_id(record: dict) -> str | None:
    """The registry's own ChiCTR number (``ChiCTR2600122474``), whichever field carries it."""
    for value in (record.get("id"), record.get("registrationNo")):
        text = str(value or "").strip()
        match = _CHICTR_ID.match(text)
        if match:
            return "ChiCTR" + match.group(1).upper()
    return None


def _ascii_upper(text: str) -> str:
    return "".join(c.upper() if c.isascii() else c for c in text)


def api_payload(result: FetchResult) -> Any:
    """The ``data`` of an EviMed answer; the body's own ``code`` decides success (see module docstring)."""
    payload = load_json(result, "evimed")
    if not isinstance(payload, dict):
        raise FetchError("parse-error", "evimed_unexpected_shape", status=result.status)
    code = payload.get("code")
    if code != 200 or result.status != 200:
        outcome, detail = API_CODES.get(code if isinstance(code, int) else result.status,
                                        ("http-error", f"evimed_code_{code}"))
        raise FetchError(outcome, detail[:80], status=result.status, retry_after_s=60 if code == 429 else None)
    return payload.get("data")


def _within(published: datetime | None, now: datetime, days: int) -> bool:
    return published is not None and now - timedelta(days=days) <= published <= now + timedelta(days=1)


def chictr_entry(record: dict, *, source: SourceConfig, now: datetime, days: int) -> NormalizedEntry | None:
    registration = chictr_id(record)
    title = clean_markup(record.get("title"))
    registered, _ = parse_date(record.get("registrationDate"))
    if not registration or not title or not _within(registered, now, days):
        return None
    day = registered.date().isoformat()
    conditions = "、".join(clean_markup(c) for c in record.get("conditions") or [] if clean_markup(c))
    interventions = "；".join(clean_markup(i) for i in record.get("interventions") or [] if clean_markup(i))
    phase = _ascii_upper(clean_markup(record.get("phase"))) or None
    status = clean_markup(record.get("status")) or None
    sponsor = clean_markup(record.get("primarySponsor")) or None
    parts = [f"疾病：{conditions}。" if conditions else None,
             f"干预：{interventions[:1500]}。" if interventions else None,
             f"研究类型：{clean_markup(record.get('studyType'))}。" if record.get("studyType") else None,
             f"分期：{phase}。" if phase else None,
             f"样本量：{clean_markup(record.get('sampleSize'))}。" if record.get("sampleSize") else None,
             f"状态：{status}。" if status else None,
             f"申办方：{sponsor}。" if sponsor else None]
    url = str(record.get("url") or "").strip()
    defects = []
    if not url.startswith(("https://", "http://")):
        url = f"https://trialsearch.who.int/Trial2.aspx?TrialID={registration}"
        defects.append("link-derived")
    return make_entry(
        external_key=f"{registration}:registered:{day}", url=url, title=title,
        summary=" ".join(p for p in parts if p) or None, published_at=registered, precision="day",
        language=guess_language(title, source.language or "zh"), registry=[registration],
        identity_hint=f"reg:{registration}:registered:{day}", defects=defects,
        facts={"trial_phase": phase, "trial_status": status, "trial_event": "registered", "sponsor": sponsor},
    )


def guide_entry(record: dict, *, source: SourceConfig, now: datetime, days: int) -> NormalizedEntry | None:
    record_id, title = str(record.get("id") or "").strip(), clean_markup(record.get("title"))
    published, precision = parse_date(record.get("publicationDate"))
    if not record_id or not title or precision != "day" or not _within(published, now, days):
        return None  # a year-only date says nothing about recency
    url = str(record.get("url") or "").strip()
    defects = []
    if not url.startswith(("https://", "http://")):
        url = f"https://www.evimed.com/guide-details?id={record_id}"
        defects.append("link-derived")
    publisher = clean_markup(record.get("publisher")) or None
    kind = clean_markup(record.get("docType")) or None
    summary = " ".join(p for p in (f"{publisher}。" if publisher else None, f"类型：{kind}。" if kind else None,
                                   clean_markup(record.get("summary")) or None) if p)
    return make_entry(
        external_key=f"evimed-guide:{record_id}", url=url, title=title, summary=summary or None,
        published_at=published, precision="day", language=guess_language(title, source.language or "zh"),
        registry=registry_ids(title, record.get("summary")), defects=defects, facts={"sponsor": publisher},
    )


class EvimedApiAdapter:
    """Scheduled EviMed API scans by family (see module docstring)."""

    access = "evimed-api"

    def _family(self, source: SourceConfig) -> str:
        return str((source.config or {}).get("family") or "")

    def _bodies(self, source: SourceConfig, now: datetime) -> list[dict]:
        config = source.config or {}
        family = self._family(source)
        days = int(config.get("new_within_days") or DEFAULT_NEW_WITHIN[family])
        base = dict(DEFAULT_BODY[family])
        base.update({k: config[k] for k in ("registry", "count", "type") if k in config})
        base.update(config.get("body") or {})
        base["startYear"] = (now - timedelta(days=days)).year
        queries = config.get("queries") or config.get("terms")
        if not queries and family == "guide" and config.get("publisher_groups"):
            query = str(config.get("query") or "指南 共识")
            return [{"query": query, **base, "publishers": list(group)} for group in config["publisher_groups"]]
        queries = queries or (CHICTR_TERMS if family == "chictr" else GUIDE_TERMS)
        return [{"query": str(q), **base} for q in queries]

    def validate_config(self, source: SourceConfig) -> list[str]:
        config = source.config or {}
        family = self._family(source)
        problems = []
        if family not in FAMILIES:
            return [f"evimed-api family must be one of {FAMILIES}"]
        planned = len(self._bodies(source, datetime.now().astimezone()))
        if int(config.get("max_pages", 5)) < planned:
            problems.append(f"max_pages {config.get('max_pages', 5)} < {planned} planned requests")
        url = config.get("url") or DEFAULT_ENDPOINT[family]
        if not url.startswith(API_BASE):
            problems.append("url is not an EviMed evidence API endpoint")
        body = config.get("body") or {}
        for secret_key in ("key", "api_key", "apiKey", "token", "authorization"):
            if secret_key in body or secret_key in url:
                problems.append("credentials never belong in the registry (the fetcher injects the key)")
        return problems

    def plan(self, source: SourceConfig, state: SourceState, now: datetime) -> list[RequestSpec]:
        config = source.config or {}
        family = self._family(source)
        if family not in FAMILIES:
            raise ValueError(f"evimed_family_unknown: {family!r}")
        url = config.get("url") or DEFAULT_ENDPOINT[family]
        return [RequestSpec(url=url, method="POST", body=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                            headers={"Content-Type": "application/json"}, conditional=False, api=True)
                for body in self._bodies(source, now)]

    def parse(self, result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
        config = source.config or {}
        family = self._family(source)
        days = int(config.get("new_within_days") or DEFAULT_NEW_WITHIN.get(family, 14))
        data = api_payload(result)
        if family == "chictr":
            records = (data or {}).get("list") if isinstance(data, dict) else None
            build = chictr_entry
        else:
            records = ((data or {}).get("guide") or {}).get("list") if isinstance(data, dict) else None
            build = guide_entry
        if not isinstance(records, list):
            raise FetchError("parse-error", f"evimed_{family}_list_missing", status=result.status)
        entries = [e for e in (build(r, source=source, now=now, days=days) for r in records if isinstance(r, dict)) if e]
        old = len(records) - len(entries)
        return ParseOutput(entries=entries, notes=[f"evimed_{family}_outside_window={old}"] if old else [])
