#!/usr/bin/env python3
"""「循证 GEO」's platform data and its social channel, through the server's
gateway (build spec 2026-09-25 §4).

Three tools a GEO capability's run uses; none is ever forced into a turn.

- ``geo_read`` reads the project's products and measurements in the shapes the
  project's pages show: numbers come as cells with numerator, denominator,
  interval and status, and a cell that is ``absent`` (not measured) or
  ``insufficient`` (under 30 valid answers) is not a zero.
- ``geo_write`` writes the run's products -- product identity, claims, a
  question set and its lock, journey, strategy and sources, three-tier targets,
  registered articles, placement preferences, links the brand published
  itself (checked after publication as a placement is), a step's status. The server
  checks every item against closed vocabularies and refuses invalid items one
  by one; what was refused comes back in ``issues``, everything else is
  written. Measuring, placing orders and spending money are the platform's,
  never a run's: there is no tool for them.
- ``social_posts_search`` asks six Chinese social platforms how real people
  phrase a question. What comes back is minimised by the server before it
  leaves: an excerpt, the post's address, its engagement and when it was
  collected -- never an author. A status other than ``collected`` or
  ``partial_collected`` is 「无信号」, never zero.

The runtime does not know where the project's data lives. It posts to the
server's own route with the same runtime token as the public-source gateway;
the token names the account and the project, and the project names the GEO
project -- there is no id a run could point elsewhere. With the module off, or
not open to this account, the runtime is given no route and the tools answer
``geo_disabled`` without a request.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request

import public_sources

# The closed vocabularies, as `packages/domain/src/geoVocabulary.mjs` defines
# them. `apps/server/test/evimedMcp.test.mjs` asks this server for the schemas
# and holds these copies equal to the domain's.
READ_WHATS = (
    "analysis",
    "signal",
    "diagnosis_progress",
    "project", "claims", "questions", "journey", "diagnosis", "metrics", "snapshots", "errors", "sources",
    "strategy", "targets", "articles", "orders", "owned_links", "monitoring", "cards", "value", "research",
    "clusters", "actions",
)
WRITE_WHATS = (
    "product", "claims", "questions", "preview_questions", "start_diagnosis", "recover_diagnosis", "lock_questions", "journey", "strategy", "sources", "targets",
    "articles", "placement_plan", "owned_links", "step", "value", "research", "actions",
)
ENGINES = ("doubao", "qianwen", "deepseek", "yuanbao", "kimi", "baidu")
POOLS = ("P1", "P2", "P3", "P4")
SOCIAL_PLATFORMS = ("xhs", "douyin", "zhihu", "weibo", "bilibili", "wechat_channels")
SOCIAL_SORTS = ("hot", "latest")
OWNED_SOURCE_METRIC_IDS = ("M-08", "M-08S")
# Keep analysis resource admission closed before crossing the HTTP boundary.
ANALYSIS_SCOPE_FIELDS = frozenset((
    "round", "from", "to", "compareFrom", "compareTo", "comparisonMode", "engines", "questionVersion",
    "groupIds", "pools", "clientTags", "timeZone", "timezone", "engine", "version", "pool", "groupId", "selectionRef",
))
ANALYSIS_VIEW_FIELDS = frozenset((
    "viewId", "metricId", "dimension", "categoryMode", "timeGrain", "entityKind", "entityKey", "sourceType",
    "sourceSearch", "sourceRelationship", "sourceLevel", "sourceFacet", "topN", "ownedMetricId", "evidenceKind",
    "errorFacet", "errorView", "publicationFacet", "financeFacet", "strategyVersion", "targetVersion", "rowKey", "columnKey", "expectedDigest", "limit", "offset",
))
FROZEN_ANALYSIS_FIELDS = frozenset(("planContextRef", "limit", "offset", "rowKey", "columnKey"))
READ_MAX_LIMIT = 50
# An action's key (`kind:group:ref`), as the domain's `parseGeoActionKey` bounds it.
ACTION_KEY_MAX = 240
WRITE_MAX_ITEMS = 200
SOCIAL_MAX_LIMIT = 50
SOCIAL_DEFAULT_LIMIT = 20
SOCIAL_MAX_QUERY = 256
JOB_ID = re.compile(r"^[A-Fa-f0-9]{32}$")
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
# Reads and writes answer within ten seconds; a social crawl within the
# channel's own timeout (at most 140 s), under the kernel's 180 s ceiling.
TIMEOUT_SECONDS = 30
SOCIAL_TIMEOUT_SECONDS = 160
GATEWAY_CODE = re.compile(r"^(?:geo|social_posts)_[a-z0-9_]{1,60}$")
# The credential's refusals are the deployment's to fix, never a field the run got wrong (they end in `_invalid` too).
AUTH_CODES = ("geo_gateway_token_invalid", "geo_gateway_token_missing", "geo_unconfigured")
# A write the store refused by one of its constraints, or one too large to read: the run corrects it -- or sends it in smaller
# writes -- and writes again; it is neither an outage nor data to give up on (2026-10-25: both were told "go on without").
CORRECTABLE_CODES = ("geo_write_rejected", "geo_request_too_large", "geo_request_key_conflict")
# A diagnosis start's and recovery's refusals with their own next step (2026-10-25: the gateway folded them into an invalid
# payload, so a run could not tell that a recovery waits for the person's acceptance of a possible second charge).
NEXT_ACTIONS = {
    "geo_request_key_conflict": "Use a new requestKey for a new start or recovery; reuse a key only to retry that same call.",
    "geo_recovery_exhausted": "These cells have had their recovery; read diagnosis_progress and report the cells still missing as not measured.",
    "geo_recovery_acknowledgment_required": (
        "Ask the user whether another, possibly billed, call for these cells is acceptable; "
        "recover with acknowledgeUnknown:true only after they agree."
    ),
    "social_posts_job_unknown": "That job is not readable (more than a day old, or not this project's): search again, and write 无信号 if it cannot be collected.",
}
ID = {"type": "string", "minLength": 1, "maxLength": 80, "pattern": r"^[A-Za-z0-9_-]+$"}


class GeoPlatformError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable

    def stop_reason(self) -> str:
        """What the run should do next: fix the call, retry, or go on without -- by the code, as vcr_platform.py decides its own."""
        if self.code in AUTH_CODES:
            return "unsupported"
        if self.code == "geo_recovery_acknowledgment_required":
            return "needs_user"
        if self.code in CORRECTABLE_CODES or self.code.endswith("_invalid"):
            return "invalid_input"
        return "retry" if self.retryable else "unsupported"

    def next_action(self):
        """The code's own next step, or None where the stop reason's general one says it."""
        return NEXT_ACTIONS.get(self.code)


def tool_definitions():
    return [
        {
            "name": "geo_read",
            "description": (
                "循证 GEO pages: counts and unknowns. "
                "Filters: inclusive dates (Asia/Shanghai), engines, questionVersion, groups, pools. "
                "Reuse selectionRef and members.metric for exact snapshots. Comparisons are observational. "
                "analysis gives exact tables/members. planContextRef pages frozen input. "
                "signal reads bound inputs; targetKey pages 4000-character material parts. "
                "Actions give lean rows; filter.key or groupId reads one whole. version reads old value."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "what": {"type": "string", "enum": list(READ_WHATS)},
                    "filter": {
                        "type": "object",
                        "properties": {
                            "version": {"type": "integer", "minimum": 1},
                            "questionVersion": {"type": "integer", "minimum": 1},
                            "from": {"type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"},
                            "to": {"type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"},
                            "compareFrom": {"type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"},
                            "compareTo": {"type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"},
                            "comparisonMode": {"type": "string", "enum": ["common", "separate"]},
                            "timeZone": {"type": "string", "maxLength": 80},
                            "timezone": {"type": "string", "maxLength": 80},
                            "engines": {"type": "array", "items": {"type": "string", "enum": list(ENGINES)}, "maxItems": 100},
                            "pools": {"type": "array", "items": {"type": "string", "enum": list(POOLS)}, "maxItems": 100},
                            "groupIds": {"type": "array", "items": ID, "maxItems": 100},
                            "clientTags": {"type": "array", "items": {"type": "string", "maxLength": 120}, "maxItems": 100},
                            "selectionRef": ID,
                            "viewId": {"type": "string", "enum": ["V01", "V02", "V03", "V04", "V05", "V06", "V07", "V08", "V09", "V10", "V11", "V12", "V13", "V14", "V15", "V16", "V17", "V18", "V19", "V20", "V21", "V22", "V23", "V24", "V25", "V26", "V27"]},
                            "financeFacet": {"type": "string", "enum": ["ledger", "group"], "description": "V25 only: ledger entries or explicit pinned group attribution, in CNY."},
                            "targetVersion": {"type": "integer", "minimum": 1, "description": "V26 only: assert the target version preserved by the exact strategy basis."},
                            "publicationFacet": {"type": "string", "enum": ["group", "audience", "channel"], "description": "V23 only: exact need groups, intended audience or intended channel; actual publication platform remains separate."},
                            "errorFacet": {"type": "string", "enum": ["type", "severity"], "description": "V13 only: group distinct preserved error records by type or severity."},
                            "errorView": {"type": "string", "enum": ["active", "withdrawn", "all"], "description": "V13 only: current judgment state, separate from business handling."},
                            "errorFingerprint": {"type": "string", "minLength": 1, "maxLength": 240, "description": "Diagnosis only: exact canonical error group, independent of list pagination."},
                            "evidenceKind": {"type": "string", "enum": ["claims", "findings"], "description": "V16 only: exact claim/source support or separately counted finding-expression observations."},
                            "metricId": {"type": "string", "pattern": "^M-[0-9]{2}[A-Z]?$"},
                            "ownedMetricId": {"type": "string", "enum": list(OWNED_SOURCE_METRIC_IDS), "description": "V21 only: existing registered-owned metric; manual source annotations remain separate."},
                            "dimension": {"type": "string", "enum": ["project", "engine", "group"]},
                            "categoryMode": {"type": "string", "enum": ["original_group", "client_tags"]},
                            "timeGrain": {"type": "string", "enum": ["day", "round"]},
                            "entityKind": {"type": "string", "enum": ["brand", "generic"]},
                            "entityKey": {"type": "string", "minLength": 1, "maxLength": 300},
                            "sourceType": {"type": "string", "minLength": 1, "maxLength": 100},
                            "sourceSearch": {"type": "string", "minLength": 1, "maxLength": 300},
                            "sourceRelationship": {"type": "string", "enum": ["all", "wrong", "mentions"]},
                            "sourceLevel": {"type": "string", "enum": ["domain", "page"]},
                            "sourceFacet": {"type": "string", "enum": ["engine", "group"]},
                            "topN": {"type": "integer", "minimum": 1, "maximum": 50},
                            "rowKey": {"type": "string", "maxLength": 160},
                            "columnKey": {"type": "string", "maxLength": 160},
                            "expectedDigest": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                            "planContextRef": {"type": "string", "pattern": "^gpc_[a-f0-9]{64}$"},
                            "targetKey": {"type": "string", "maxLength": 160},
                            "strategyVersion": {"type": "integer", "minimum": 1},
                            "url": {"type": "string", "maxLength": 2000},
                            "sourceId": ID,
                            "answerLimit": {"type": "integer", "minimum": 1, "maximum": 500},
                            "answerOffset": {"type": "integer", "minimum": 0, "maximum": 20000},
                            "errorTrace": {"type":"string","enum":["traced","unattributable","noRetrieval"]},
                            "errorJudgmentState": {"type":"string","enum":["active","withdrawn"]},
                            "errorStatuses": {"type": "array", "items": {"type": "string", "enum": ["open", "acting", "awaiting_remeasure", "closed"]}},
                            "errorSeverities": {"type": "array", "items": {"type": "string", "enum": ["S0", "S1", "S2", "S3", "S4"]}},
                            "errorTypes": {"type": "array", "items": {"type": "string", "enum": ["label_conflict", "number", "dropped_condition", "unfounded", "attribute_swap"]}},
                            "errorSearch": {"type": "string", "maxLength": 240},
                            "errorLimit": {"type": "integer", "minimum": 1, "maximum": 500},
                            "errorOffset": {"type": "integer", "minimum": 0, "maximum": 100000},
                            "member": {
                                "type": "object", "description": "Copy members.metric from a cell to page its exact contributing snapshots.",
                                "properties": {"metricId": {"type": "string"}, "scope": {"type": "string", "enum": ["project", "pool", "engine", "pool_engine", "group", "arm"]},
                                               "observationRound": ID,
                                    "observationDate": {"type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"},
                                               **{key: {"type": ["string", "null"]} for key in ["engine", "pool", "groupId", "arm", "variant", "rival"]}},
                                "required": ["metricId", "scope"], "additionalProperties": False,
                            },

                            "audience": {"type": "string", "maxLength": 120},
                            "round": ID,
                            "engine": {"type": "string", "enum": list(ENGINES)},
                            "pool": {"type": "string", "enum": list(POOLS)},
                            "groupId": ID,
                            "questionId": ID,
                            "key": {"type": "string", "minLength": 1, "maxLength": ACTION_KEY_MAX},
                            "limit": {"type": "integer", "minimum": 1, "maximum": READ_MAX_LIMIT, "default": 20},
                            "offset": {"type": "integer", "minimum": 0, "maximum": 20000},
                        },
                        "additionalProperties": False,
                    },
                },
                "required": ["what"],
                "additionalProperties": False,
            },
        },
        {
            "name": "geo_write",
            "description": (
                "Write this 循证 GEO project. questions: groups merge into the map by name+pool (data.replace:true = whole map); "
                "rows+requestKey save original rows under a measurement contract. "
                "start_diagnosis measures a saved version; recover_diagnosis retries failed cells "
                "under a new requestKey (reuse one only to retry that call); acknowledgeUnknown only if the user accepts a possible "
                "billed duplicate. value merges by id; research runs after this run."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "what": {"type": "string", "enum": list(WRITE_WHATS)},
                    "items": {"type": "array", "minItems": 1, "maxItems": WRITE_MAX_ITEMS, "items": {"type": "object"}},
                    "data": {"type": "object", "description": (
                        "Imported questions: rows[{text,originalId?,originalGroup?,clientTags?,kind?,sourceUrl?,collectedAt?,pool?,journeyStage?,audience?,isMeasured?,classificationStatus?}], "
                        "contract{samplingMode:one_shot|recurring,engines,repeats(one_shot=1),metricIds,reportPresentation:summary|detailed,sourceBasis:answers|answers_and_project_sources},requestKey. "
                        "Preserve original text; kind defaults client; real requires URL and date; classificationStatus is unclassified|suggested|confirmed. "
                        "start_diagnosis:{version,requestKey}; recover_diagnosis:{roundId,requestKey,jobIds,acknowledgeUnknown?} for failed calls. "
                        "Read diagnosis_progress with filter.round before recovery. Never default acknowledgeUnknown to true; keep a requestKey only when retrying the same call."
                    )},
                },
                "required": ["what"],
                "additionalProperties": False,
            },
        },
        {
            "name": "social_posts_search",
            "description": (
                "Collect how real people phrase a health question on Chinese social platforms "
                "(xhs 小红书, douyin 抖音, zhihu 知乎, weibo 微博, bilibili B站, wechat_channels 视频号): excerpts with "
                "link, engagement, time. Name one or two platforms (30-120 s each); one asynchronous job. "
                "Partial = usable excerpts, not full coverage; failure = no signal (无信号), never zero. "
                "pending = still running, with a jobId: do not search again; call with only that jobId to read on."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "minLength": 1, "maxLength": SOCIAL_MAX_QUERY},
                    "platform": {"type": "string", "enum": list(SOCIAL_PLATFORMS)},
                    "platforms": {"type": "array", "items": {"type": "string", "enum": list(SOCIAL_PLATFORMS)}, "minItems": 1, "maxItems": 6, "uniqueItems": True},
                    "sort": {"type": "string", "enum": list(SOCIAL_SORTS), "default": "hot"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": SOCIAL_MAX_LIMIT, "default": SOCIAL_DEFAULT_LIMIT},
                    "jobId": {"type": "string", "pattern": "^[A-Fa-f0-9]{32}$", "description": "The id a pending search returned; alone."},
                },
                "oneOf": [{"type": "object", "required": ["query", "platform"]}, {"type": "object", "required": ["query", "platforms"]},
                          {"type": "object", "required": ["jobId"]}],
                "additionalProperties": False,
            },
        },
    ]


def _gateway():
    base = os.environ.get("EVIMED_GEO_GATEWAY_URL", "").strip().rstrip("/")
    if not base:
        raise GeoPlatformError(
            "geo_disabled",
            "循证 GEO is not available in this conversation: the deployment has it switched off or has not opened it "
            "to this account. Go on without the platform's GEO data.",
        )
    try:
        settings = public_sources._gateway_settings()  # noqa: SLF001 - one token, one owner
    except public_sources.PublicSourceError as error:
        raise GeoPlatformError("geo_unconfigured", "The managed gateway token is unavailable.") from error
    if settings is None:
        raise GeoPlatformError("geo_unconfigured", "The managed gateway token is unavailable.")
    return base, settings[1]


def _post(operation: str, payload: dict, timeout: int) -> dict:
    base, token = _gateway()
    request = urllib.request.Request(
        "%s/%s" % (base, operation),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "accept": "application/json",
            "authorization": "Bearer %s" % token,
            "content-type": "application/json",
            "user-agent": "EviMed-Research/1.2 (runtime geo platform)",
        },
        method="POST",
    )
    try:
        with public_sources._OPENER.open(request, timeout=timeout) as response:  # noqa: SLF001
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        code = ""
        message = ""
        try:
            parsed_error = json.loads(error.read(64 * 1024).decode("utf-8", "replace"))
            code = parsed_error.get("code", "") if isinstance(parsed_error, dict) else ""
            message = parsed_error.get("error", "") if isinstance(parsed_error, dict) else ""
        except Exception:  # noqa: BLE001 - the status is the finding, not the parse
            code = ""
        # Only the gateway's own words reach the run: a code from anything else
        # on the path is not one the run's verdict knows how to read.
        if not isinstance(code, str) or not GATEWAY_CODE.match(code):
            code = "geo_upstream_error"
        if not isinstance(message, str) or not message.strip() or len(message) > 400:
            message = "The 循证 GEO gateway returned HTTP %d." % error.code
        raise GeoPlatformError(
            code,
            message,
            retryable=error.code in (429, 502, 503, 504) and code not in ("geo_disabled", "social_posts_unconfigured"),
        ) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise GeoPlatformError("geo_gateway_unreachable", "The 循证 GEO gateway is unreachable.", retryable=True) from error
    if len(body) > MAX_RESPONSE_BYTES:
        raise GeoPlatformError("geo_response_too_large", "The 循证 GEO answer exceeded the client limit.")
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GeoPlatformError("geo_response_invalid", "The 循证 GEO gateway returned a non-JSON answer.") from error
    data = parsed.get("data") if isinstance(parsed, dict) else None
    if not isinstance(data, dict):
        raise GeoPlatformError("geo_response_invalid", "The 循证 GEO gateway returned no data.")
    return data


def _outside_a_project(error: GeoPlatformError, what: str, verb: str) -> dict:
    """A conversation outside a GEO project: the tool worked, there is simply
    no project data here -- a warning the run reads and moves on from, never
    a failure it has to explain."""
    return {
        "status": "warning",
        "summary": "This conversation is not in a 循证 GEO project, so there is no %s to %s." % (what, verb),
        "data": {"what": what, "code": error.code},
        "warnings": [str(error)],
        "next_actions": ["Go on without the platform's GEO data, or work in the GEO project's own conversation."],
    }


def read(arguments: dict) -> dict:
    what = arguments.get("what")
    if what not in READ_WHATS:
        raise GeoPlatformError("geo_read_what_invalid", "what must be one of: %s." % ", ".join(READ_WHATS))
    selector = arguments.get("filter")
    if isinstance(selector, dict):
        if "targetVersion" in selector and what != "analysis":
            raise GeoPlatformError("geo_read_filter_invalid", "targetVersion requires a direct V26 analysis.")
        if "publicationFacet" in selector and (what != "analysis" or selector.get("viewId") != "V23"
                or selector["publicationFacet"] not in ("group", "audience", "channel") or "planContextRef" in selector):
            raise GeoPlatformError("geo_read_filter_invalid", "publicationFacet requires a direct V23 analysis.")
        if "financeFacet" in selector and (what != "analysis" or selector.get("viewId") != "V25" or selector["financeFacet"] not in ("ledger", "group")):
            raise GeoPlatformError("geo_read_filter_invalid", "financeFacet requires a direct V25 analysis.")
        if what == "analysis":
            if selector.get("viewId") in ("V15", "V27"):
                history_fields = ANALYSIS_SCOPE_FIELDS | frozenset((
                    "viewId", "metricId", "dimension", "rowKey", "columnKey", "expectedDigest", "limit", "offset",
                ))
                if (not selector.keys() <= history_fields or selector.get("dimension", "project") != "project"
                        or selector.get("viewId") == "V15" and "metricId" in selector
                        or selector.get("viewId") == "V27" and selector.get("metricId") in ("M-16", "M-17", "M-18", "M-21")):
                    raise GeoPlatformError("geo_read_filter_invalid", "Use the history view's exact observation scope and supported project metric.")
            for key in ("strategyVersion", "targetVersion"):
                value = selector.get(key)
                if key in selector and (selector.get("viewId") != "V26" or type(value) is not int or value < 1):
                    raise GeoPlatformError("geo_read_filter_invalid", "Plan version selectors require a direct V26 analysis.")
            allowed = FROZEN_ANALYSIS_FIELDS if "planContextRef" in selector else ANALYSIS_SCOPE_FIELDS | ANALYSIS_VIEW_FIELDS
            if not selector.keys() <= allowed:
                raise GeoPlatformError("geo_read_filter_invalid", "Use only the selected analysis resource's supported fields.")
            if "planContextRef" in selector and ("rowKey" in selector or "columnKey" in selector):
                row_key = selector.get("rowKey")
                if not isinstance(row_key, str) or not row_key or len(row_key) > 160 or selector.get("columnKey") != "objects":
                    raise GeoPlatformError("geo_read_filter_invalid", "Choose an exact frozen object page.")
        for field, choices in (("errorFacet", ("type", "severity")), ("errorView", ("active", "withdrawn", "all"))):
            if field in selector and (what != "analysis" or selector.get("viewId") != "V13"
                                      or selector[field] not in choices or "planContextRef" in selector):
                raise GeoPlatformError("geo_read_filter_invalid", field + " requires a direct V13 analysis.")
        if "errorFingerprint" in selector and (what != "diagnosis" or "planContextRef" in selector
                or not isinstance(selector["errorFingerprint"], str)
                or not selector["errorFingerprint"].strip() or len(selector["errorFingerprint"]) > 240
                or any(ord(char) < 32 or ord(char) == 127 for char in selector["errorFingerprint"])):
            raise GeoPlatformError("geo_read_filter_invalid", "errorFingerprint requires an exact diagnosis group.")
    if isinstance(selector, dict) and "evidenceKind" in selector:
        if (what != "analysis" or selector.get("viewId") != "V16"
                or selector["evidenceKind"] not in ("claims", "findings") or "planContextRef" in selector):
            raise GeoPlatformError("geo_read_filter_invalid", "evidenceKind requires a direct V16 analysis; frozen input cannot be replaced.")
    if isinstance(selector, dict) and "ownedMetricId" in selector:
        if (what != "analysis" or selector.get("viewId") != "V21"
                or selector["ownedMetricId"] not in OWNED_SOURCE_METRIC_IDS or "planContextRef" in selector):
            raise GeoPlatformError(
                "geo_read_filter_invalid",
                "ownedMetricId requires a direct V21 analysis with M-08 or M-08S; frozen input cannot be replaced.",
            )
    payload = {"what": what}
    for field in ("planContextRef", "promptRequestId"):
        if arguments.get(field) is not None:
            payload[field] = arguments[field]
    if isinstance(arguments.get("filter"), dict) and arguments["filter"]:
        payload["filter"] = arguments["filter"]
    try:
        data = _post("read", payload, TIMEOUT_SECONDS)
    except GeoPlatformError as error:
        if error.code == "geo_no_project":
            return _outside_a_project(error, what, "read")
        raise
    warnings = []
    next_actions = []
    page, offset_field = data, "offset"
    page_key = {"errors": "page", "diagnosis": "errorPage", "sources": "answerPage", "diagnosis_progress": "page"}.get(what)
    if page_key and isinstance(data.get(page_key), dict):
        page = data[page_key]
        offset_field = {"errors": "errorOffset", "diagnosis": "errorOffset", "sources": "answerOffset"}.get(what, "offset")
    if page.get("more") is True:
        warnings.append("More items exist than this answer holds.")
        next_offset = page.get("nextOffset")
        if isinstance(next_offset, int) and not isinstance(next_offset, bool):
            next_actions.append("Call again with filter.%s=%d to read the next page, or narrow the filter." % (offset_field, next_offset))
        else:
            next_actions.append("Call again with filter.%s to read the next page, or narrow the filter." % offset_field)
    if what == "actions" and data.get("detail") == "lean":
        next_actions.append("Rows are lean; filter.key (or filter.groupId) reads an action whole: its judgment, expected points, why each source.")
    return {
        "status": "success",
        "summary": "Read %s of this 循证 GEO project." % what,
        "data": data,
        "warnings": warnings,
        "next_actions": next_actions,
    }


def write(arguments: dict) -> dict:
    what = arguments.get("what")
    if what not in WRITE_WHATS:
        raise GeoPlatformError("geo_write_what_invalid", "what must be one of: %s." % ", ".join(WRITE_WHATS))
    if "items" in arguments and "data" in arguments:
        raise GeoPlatformError("geo_write_payload_invalid", "A write carries items or data, not both.")
    payload = {"what": what}
    # A plan context is never a write's: the gateway refuses it (a project token cannot attest a native call's origin), so the
    # tool neither offers nor forwards it.
    for key in ("items", "data"):
        if key in arguments:
            payload[key] = arguments[key]
    try:
        data = _post("write", payload, TIMEOUT_SECONDS)
    except GeoPlatformError as error:
        if error.code == "geo_no_project":
            return _outside_a_project(error, what, "write")
        raise
    issues = [issue for issue in data.get("issues") or [] if isinstance(issue, dict)]
    # An ignored field is a notice: the item was written, and the field is kept only in the file. Counting it as a refusal told a run
    # that 72 items were refused when one object had been written with names of its own.
    notices = [issue for issue in issues if issue.get("code") in ("notice", "ignored_fields")]
    refused = [issue for issue in issues if issue.get("code") not in ("notice", "ignored_fields")]
    ids = data.get("ids") if isinstance(data.get("ids"), list) else []
    if not data.get("ok"):
        return {
            "status": "warning",
            "summary": "Nothing was written to %s: %d issue(s)." % (what, len(refused)),
            "data": data,
            "warnings": [_issue_line(issue) for issue in refused[:20]],
            "next_actions": ["Correct the named items and write them again; nothing else changed."],
        }
    warnings = [_issue_line(issue) for issue in (refused + notices)[:20]]
    ignored = [issue for issue in notices if issue.get("code") == "ignored_fields"]
    next_actions = []
    if refused:
        next_actions.append("Correct the refused items and write only those again.")
    if ignored:
        next_actions.append("Fields kept only in the file are not on the page: write them under the names each notice lists.")
    return {
        "status": "warning" if refused or ignored else "success",
        "summary": "Wrote %s: %d written%s%s." % (what, len(ids), ", %d refused" % len(refused) if refused else "",
                                                 ", %d field name(s) not kept" % len(ignored) if ignored else ""),
        "data": data,
        "warnings": warnings,
        "next_actions": next_actions,
    }


def _issue_line(issue: dict) -> str:
    where = []
    if isinstance(issue.get("group"), int):
        where.append("group %d" % issue["group"])
    if isinstance(issue.get("index"), int):
        where.append("item %d" % issue["index"])
    if issue.get("field"):
        where.append(str(issue["field"]))
    prefix = "%s: " % ", ".join(where) if where else ""
    return "%s%s" % (prefix, str(issue.get("message") or issue.get("code") or "refused"))


def social_search(arguments: dict) -> dict:
    if "jobId" in arguments:
        return _social_read_on(arguments)
    query = arguments.get("query")
    text = " ".join(query.split()) if isinstance(query, str) else ""
    if not text or len(text) > SOCIAL_MAX_QUERY:
        raise GeoPlatformError("social_posts_query_invalid", "query must be text of 1 to %d characters." % SOCIAL_MAX_QUERY)
    payload = {"query": text}
    if "platform" in arguments and "platforms" in arguments:
        raise GeoPlatformError("social_posts_platform_invalid", "Choose platform or platforms, not both.")
    platforms = arguments.get("platforms") if "platforms" in arguments else [arguments.get("platform")]
    if (not isinstance(platforms, list) or not 1 <= len(platforms) <= len(SOCIAL_PLATFORMS)
            or any(not isinstance(value, str) or value not in SOCIAL_PLATFORMS for value in platforms)
            or len(set(platforms)) != len(platforms)):
        raise GeoPlatformError("social_posts_platform_invalid", "Select one or a few distinct supported platforms.")
    payload["platforms"] = platforms
    sort = arguments.get("sort")
    if sort is not None:
        if sort not in SOCIAL_SORTS:
            raise GeoPlatformError("social_posts_sort_invalid", "sort must be one of: %s." % ", ".join(SOCIAL_SORTS))
        payload["sort"] = sort
    limit = arguments.get("limit")
    if limit is not None:
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= SOCIAL_MAX_LIMIT:
            raise GeoPlatformError("social_posts_limit_invalid", "limit must be an integer between 1 and %d." % SOCIAL_MAX_LIMIT)
        payload["limit"] = limit
    return _social_result(_post("social", payload, SOCIAL_TIMEOUT_SECONDS), text)


def _social_read_on(arguments: dict) -> dict:
    """Read on a pending search by its job id, alone: the gateway answers only for a job this project started."""
    job_id = arguments.get("jobId")
    if set(arguments) != {"jobId"} or not isinstance(job_id, str) or not JOB_ID.match(job_id):
        raise GeoPlatformError("social_posts_job_invalid", "Read on with only the 32-character jobId a pending search returned.")
    data = _post("social_job", {"jobId": job_id}, SOCIAL_TIMEOUT_SECONDS)
    query = data.get("query")
    return _social_result(data, " ".join(query.split()) if isinstance(query, str) else "")


def _social_result(data: dict, text: str) -> dict:
    posts = [post for post in data.get("posts") or [] if isinstance(post, dict)]
    status = (data.get("status") if data.get("status") in ("collected", "partial_collected", "no_results", "request_failed", "pending")
              else "request_failed")
    body = {"status": status, "query": text, "platforms": data.get("platforms") or [], "posts": posts}
    if status == "collected":
        return {"status": "success", "summary": "Collected %d post(s) for \"%s\"." % (len(posts), text), "data": body,
                "warnings": [], "next_actions": []}
    if status == "pending":
        job_id = data.get("jobId") if isinstance(data.get("jobId"), str) and JOB_ID.match(data["jobId"]) else None
        if job_id:
            body["jobId"] = job_id
        return {
            "status": "warning",
            "summary": "The collection for \"%s\" is still running (%d post(s) so far)." % (text, len(posts)),
            "data": body,
            "warnings": ["Still running, not failed: a platform marked pending is not collected yet -- do not write it as 无信号 or as nobody asking."],
            "next_actions": [
                ("Do not search again. Read on with social_posts_search {\"jobId\": \"%s\"} in a minute." % job_id) if job_id
                else "Repeat the identical search in a minute: it joins the running job instead of starting another.",
            ],
        }
    if status == "partial_collected":
        failed = [entry.get("platform") for entry in body["platforms"] if isinstance(entry, dict) and entry.get("status") == "request_failed"]
        return {
            "status": "warning",
            "summary": "Collected %d post(s) for \"%s\"; some platforms did not answer." % (len(posts), text),
            "data": body,
            "warnings": ["Not collected: %s -- record them as 无信号, not as nobody asking." % ", ".join(failed)] if failed else [],
            "next_actions": [],
        }
    return {
        "status": "warning",
        "summary": ("No post matched \"%s\" on the platforms asked." % text) if status == "no_results"
        else "The social channel did not answer for \"%s\"." % text,
        "data": body,
        "warnings": [
            "Write 无信号 for this phrasing; never read it as zero people asking."
            if status == "request_failed"
            else "Nobody was found asking it this way; try the everyday words a patient would use."
        ],
        "next_actions": ["Try a shorter or more colloquial query, or another platform."],
    }
