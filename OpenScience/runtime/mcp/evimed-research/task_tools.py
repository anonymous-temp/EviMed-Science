#!/usr/bin/env python3
"""Make and change a scheduled task from a conversation, through the control plane's own task service.

Two tools, one responsibility each (`schedule_task` makes a task and starts it, `update_task` changes one), and nothing else: neither
decides *whether* the researcher wants a task, plans what it should do, or asks the researcher to confirm. A conversation that is
told "每个工作日早上 9 点给我一份昨天的行业要闻" calls the first once; "改到每周一 8 点" or "先停一停" calls the second. The model chooses to call them
(principle 12); no turn is forced into either.

The runtime never says whose task it is. It posts to the server's own route with the same runtime token as every other gateway, and the
token names the account and the project — a task of another project, or of another account, is simply not found. A task is made the way
the task form makes one: the platform's default budget and stopping rules, started at once, nothing to approve (the owner's rulings of
2026-09-19 and 2026-09-20). The answer is facts only — the task's id, title, schedule in words, time zone, next run and state — and the
rules (what a valid schedule is, how many tasks a project may hold, that an execution may not make tasks) live in the control plane and
in `@evimed/domain`, once: this module checks the *shape* of a call so a malformed one fails here with a sentence, and leaves every rule to
the gateway.

With the feature off (or no product ledger) the runtime is given no route and the tools are not offered at all; a call that still arrives
answers `task_tools_disabled` without a request.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request

import public_sources

# `@evimed/domain`'s `TASK_INSTRUCTION_MAX_CHARS` / `TASK_TITLE_MAX_CHARS`; `test_task_tools.py` holds these equal to the domain's.
MAX_INSTRUCTION = 20_000
MAX_TITLE = 200
MAX_RESPONSE_BYTES = 256 * 1024
TIMEOUT_SECONDS = 30
KINDS = ("once", "daily", "weekly")
TIME = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# A task is named by its own id (`agenda-…`), or by an execution of it (`episode-…`): a scheduled execution's conversation carries the
# execution's id and not the task's, and "this task" there means the one that execution belongs to.
TASK_ID = re.compile(r"^(?:agenda|episode)-[A-Za-z0-9-]{1,160}$")
# The gateway's own codes, and the task service's where it refused the call itself (`autopilot_episode_budget_too_small`, say).
GATEWAY_CODE = re.compile(r"^(?:task|autopilot)_[a-z0-9_]{1,60}$")
TOOL_NAMES = ("schedule_task", "update_task")
# What the gateway answers a failure with, and what each means for the call (`@evimed/domain` `TASK_TOOL_ERROR_CODES`).
RUN_FIXES = (
    "task_tools_request_invalid", "task_tools_request_too_large", "task_instruction_invalid", "task_title_invalid",
    "task_schedule_invalid", "task_schedule_in_past", "task_materials_invalid", "task_id_invalid", "task_not_found", "task_update_empty", "task_paused_invalid",
)
RETRYABLE_STATUSES = (429, 502, 503, 504)
# The task moved under the call (edited on the page at the same moment): the call, made again, reads where it now stands.
RETRYABLE_CODES = ("task_revision_conflict",)
ABSENT_CODES = ("task_tools_disabled", "task_tools_not_in_conversation")

_SCHEDULE_PROPERTIES = {
    "kind": {"type": "string", "enum": list(KINDS)},
    "time": {"type": "string", "pattern": TIME.pattern, "description": "HH:MM, 24-hour, the clock in timeZone"},
    "weekdays": {
        "type": "array", "minItems": 1, "maxItems": 7,
        "items": {"type": "integer", "minimum": 1, "maximum": 7},
        "description": "weekly only: ISO weekdays, 1 = Monday … 7 = Sunday",
    },
    "date": {"type": "string", "pattern": DATE.pattern, "description": "once only: YYYY-MM-DD in timeZone, not in the past"},
    "timeZone": {"type": "string", "maxLength": 80, "description": "IANA zone; default Asia/Shanghai (中国标准时间)"},
}


_SOURCE_IDS_PROPERTY = {
    "type": "array", "minItems": 1, "maxItems": 10,
    "items": {"type": "string", "pattern": r"^src_[a-f0-9]{32}$"},
    "description": "Add durable knowledge-base materials from this project; omitted references stay attached.",
}


class TaskToolError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False, tasks: list | None = None):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        # The project's tasks, when the gateway sent them with a refusal that named none of them (facts: id, title, schedule in words).
        self.tasks = tasks or []

    def stop_reason(self) -> str:
        if self.code in RUN_FIXES:
            return "invalid_input"
        return "retry" if self.retryable else "unsupported"

    def next_action(self) -> str:
        if self.code in RUN_FIXES:
            hint = "Correct the named field and call again; nothing was changed."
            if self.tasks:
                hint += " The project's tasks are: " + "; ".join(
                    "%s (%s, %s)" % (task.get("taskId"), task.get("title"), task.get("scheduleText")) for task in self.tasks[:10]
                ) + "."
            return hint
        if self.retryable:
            return "Retry the same request once; if it still fails, say the saved state could not be confirmed and inspect the task on the 定时任务 page before creating another."
        return "Tell the researcher why the request could not finish; do not claim nothing changed unless the saved state confirms it. Inspect the task on the 定时任务 page."


def tool_definitions():
    return [
        {
            "name": "schedule_task",
            "description": (
                "Schedule work the user asks to repeat or run once (「每个工作日早上 9 点汇总行业要闻」「每周一汇总销售表」「下周五提醒交周报」). "
                "Any kind of work is supported. New tasks start with the platform defaults; nothing to confirm. "
                "instruction must stand alone: subject, output format and needed context. sourceIds optionally binds up to ten "
                "knowledge-base files from this project; a filename or chat mention alone does not save a material reference. "
                "schedule.time is HH:MM in timeZone (default Asia/Shanghai); weekly needs weekdays 1=Monday…7=Sunday, once needs a date. "
                "Tell the user the returned schedule, zone, next run and actual state. An existing paused duplicate stays paused. "
                "Unavailable inside unattended executions."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "instruction": {"type": "string", "minLength": 1, "maxLength": MAX_INSTRUCTION},
                    "schedule": {"type": "object", "properties": _SCHEDULE_PROPERTIES, "required": ["kind", "time"], "additionalProperties": False},
                    "title": {"type": "string", "minLength": 1, "maxLength": MAX_TITLE, "description": "optional; default is the instruction's opening"},
                    "sourceIds": _SOURCE_IDS_PROPERTY,
                },
                "required": ["instruction", "schedule"],
                "additionalProperties": False,
            },
        },
        {
            "name": "update_task",
            "description": (
                "Change a scheduled task the user names (「改到每周一 8 点」「只要五条以内」「先停一停」): what it does, when it runs, "
                "its title, add sourceIds from this project, or pause/re-enable it with paused. Pass only what changes; schedule fields left out keep their values. Pausing "
                "also cancels the task's work in flight (results already made stay). taskId is the id schedule_task answered with, or the "
                "Episode ID of a scheduled execution you are in; a wrong id answers with the project's tasks. Answers with the task as it now stands."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": {"type": "string", "pattern": TASK_ID.pattern, "maxLength": 200},
                    "instruction": {"type": "string", "minLength": 1, "maxLength": MAX_INSTRUCTION},
                    "schedule": {"type": "object", "properties": _SCHEDULE_PROPERTIES, "additionalProperties": False},
                    "title": {"type": "string", "minLength": 1, "maxLength": MAX_TITLE},
                    "paused": {"type": "boolean"},
                    "sourceIds": _SOURCE_IDS_PROPERTY,
                },
                "required": ["taskId"],
                "additionalProperties": False,
            },
        },
    ]


def _gateway(operation: str):
    base = os.environ.get("EVIMED_TASKS_GATEWAY_URL", "").strip().rstrip("/")
    if not base:
        raise TaskToolError(
            "task_tools_disabled",
            "Scheduling a task from a conversation is not available on this deployment: the researcher can add it on the 定时任务 page.",
        )
    try:
        settings = public_sources._gateway_settings()  # noqa: SLF001 - one token, one owner
    except public_sources.PublicSourceError as error:
        raise TaskToolError("task_tools_unconfigured", "The managed gateway token is unavailable.") from error
    if settings is None:
        raise TaskToolError("task_tools_unconfigured", "The managed gateway token is unavailable.")
    return "%s/%s" % (base, operation), settings[1]


def _text(value, field: str, maximum: int, code: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise TaskToolError(code, "%s must be a non-empty string of at most %d characters." % (field, maximum))
    return value


def _schedule(value, *, partial: bool) -> dict:
    """The shape of a schedule, never its meaning: whether a date exists, a zone is real or a moment has passed is the gateway's."""
    if not isinstance(value, dict):
        raise TaskToolError("task_schedule_invalid", "schedule must be an object with kind and time.")
    unknown = sorted(set(value) - set(_SCHEDULE_PROPERTIES))
    if unknown:
        raise TaskToolError("task_schedule_invalid", "schedule has unsupported fields: %s." % ", ".join(unknown))
    if not partial and not {"kind", "time"} <= set(value):
        raise TaskToolError("task_schedule_invalid", "schedule needs kind (once, daily or weekly) and time (HH:MM).")
    if "kind" in value and value["kind"] not in KINDS:
        raise TaskToolError("task_schedule_invalid", "schedule.kind must be one of: %s." % ", ".join(KINDS))
    if "time" in value and not (isinstance(value["time"], str) and TIME.match(value["time"])):
        raise TaskToolError("task_schedule_invalid", "schedule.time must be HH:MM on a 24-hour clock.")
    if "date" in value and not (isinstance(value["date"], str) and DATE.match(value["date"])):
        raise TaskToolError("task_schedule_invalid", "schedule.date must be YYYY-MM-DD.")
    if "weekdays" in value:
        days = value["weekdays"]
        if not isinstance(days, list) or not 1 <= len(days) <= 7 or not all(isinstance(day, int) and not isinstance(day, bool) and 1 <= day <= 7 for day in days):
            raise TaskToolError("task_schedule_invalid", "schedule.weekdays must be 1 to 7 ISO weekdays, 1 = Monday … 7 = Sunday.")
    if "timeZone" in value and not (isinstance(value["timeZone"], str) and 0 < len(value["timeZone"]) <= 80):
        raise TaskToolError("task_schedule_invalid", "schedule.timeZone must be an IANA time zone name.")
    return dict(value)


def _validated(name: str, arguments) -> dict:
    if not isinstance(arguments, dict):
        raise TaskToolError("task_tools_request_invalid", "The call's arguments must be an object.")
    allowed = {"instruction", "schedule", "title", "sourceIds"} if name == "schedule_task" else {"taskId", "instruction", "schedule", "title", "paused", "sourceIds"}
    unknown = sorted(set(arguments) - allowed)
    if unknown:
        raise TaskToolError("task_tools_request_invalid", "%s takes: %s." % (name, ", ".join(sorted(allowed))))
    payload: dict = {}
    if name == "schedule_task":
        payload["instruction"] = _text(arguments.get("instruction"), "instruction", MAX_INSTRUCTION, "task_instruction_invalid")
        payload["schedule"] = _schedule(arguments.get("schedule"), partial=False)
    else:
        task_id = arguments.get("taskId")
        if not isinstance(task_id, str) or not TASK_ID.match(task_id):
            raise TaskToolError("task_id_invalid", "taskId must be the id schedule_task answered with (agenda-…), or an Episode ID (episode-…).")
        payload["taskId"] = task_id
        if "instruction" in arguments:
            payload["instruction"] = _text(arguments["instruction"], "instruction", MAX_INSTRUCTION, "task_instruction_invalid")
        if "schedule" in arguments:
            payload["schedule"] = _schedule(arguments["schedule"], partial=True)
        if "paused" in arguments:
            if not isinstance(arguments["paused"], bool):
                raise TaskToolError("task_paused_invalid", "paused must be true (pause) or false (re-enable).")
            payload["paused"] = arguments["paused"]
    if "sourceIds" in arguments:
        ids = arguments["sourceIds"]
        if not isinstance(ids, list) or not 1 <= len(ids) <= 10 or not all(isinstance(item, str) and re.fullmatch(r"src_[a-f0-9]{32}", item) for item in ids):
            raise TaskToolError("task_materials_invalid", "sourceIds must name between one and ten sources (src_…) from this project's knowledge base.")
        payload["sourceIds"] = sorted(set(ids))
    if "title" in arguments:
        payload["title"] = _text(arguments["title"], "title", MAX_TITLE, "task_title_invalid")
    return payload


def _post(operation: str, payload: dict) -> dict:
    url, token = _gateway(operation)
    request = urllib.request.Request(
        url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"accept": "application/json", "authorization": "Bearer %s" % token, "content-type": "application/json",
                 "user-agent": "EviMed-Research/1.2 (runtime scheduled tasks)"},
        method="POST",
    )
    try:
        with public_sources._OPENER.open(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: SLF001
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        code, message, tasks = "", "", []
        try:
            parsed = json.loads(error.read(64 * 1024).decode("utf-8", "replace"))
            if isinstance(parsed, dict):
                code = parsed.get("code", "")
                message = parsed.get("error", "")
                tasks = parsed.get("tasks") if isinstance(parsed.get("tasks"), list) else []
        except Exception:  # noqa: BLE001 - the status is the finding, not the parse
            code = ""
        # Only the gateway's own words reach the run.
        if not isinstance(code, str) or not GATEWAY_CODE.match(code):
            code = "task_tools_upstream_error"
        if not isinstance(message, str) or not message.strip() or len(message) > 400:
            message = "The scheduled-task gateway returned HTTP %d." % error.code
        facts = [
            {key: task.get(key) for key in ("taskId", "title", "scheduleText", "state") if isinstance(task.get(key), str)}
            for task in tasks[:20] if isinstance(task, dict)
        ]
        raise TaskToolError(code, message, retryable=(error.code in RETRYABLE_STATUSES or code in RETRYABLE_CODES) and code not in ABSENT_CODES, tasks=facts) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise TaskToolError("task_tools_gateway_unreachable", "The scheduled-task gateway is unreachable.", retryable=True) from error
    if len(body) > MAX_RESPONSE_BYTES:
        raise TaskToolError("task_tools_response_too_large", "The answer exceeded the client limit.")
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TaskToolError("task_tools_response_invalid", "The gateway returned a non-JSON answer.") from error
    data = parsed.get("data") if isinstance(parsed, dict) else None
    if not isinstance(data, dict) or not isinstance(data.get("taskId"), str):
        raise TaskToolError("task_tools_response_invalid", "The gateway returned no task.")
    return data


def _facts(data: dict) -> str:
    zone = data.get("timeZoneName") or data.get("timeZone")
    when = "%s（%s）" % (data.get("scheduleText"), zone) if zone else str(data.get("scheduleText"))
    if data.get("state") == "paused":
        return "%s, paused" % when
    if data.get("nextRunText"):
        return "%s, next run %s" % (when, data["nextRunText"])
    return "%s, no run left" % when if data.get("state") == "completed" else when


def _answer(name: str, data: dict) -> dict:
    title = data.get("title")
    if name == "schedule_task":
        if data.get("created") is False:
            summary = "A task with the same instruction and schedule already exists, so nothing was created: “%s” — %s." % (title, _facts(data))
        else:
            summary = "Scheduled “%s” — %s." % (title, _facts(data))
        actions = ["Tell the researcher the task, its schedule and the time zone in words; they can open it from the task card."]
    else:
        changed = data.get("changed") or []
        summary = ("Updated “%s” (%s) — %s." % (title, ", ".join(changed), _facts(data))) if changed else (
            "“%s” already was as asked — %s." % (title, _facts(data)))
        actions = ["Tell the researcher what changed and how the task stands now, in words."]
    warnings = []
    if data.get("outcome") == "partial":
        changed = ", ".join(data.get("changed") or [])
        summary = "Saved %s for “%s”; the remaining change could not finish — %s." % (changed, title, _facts(data))
        warnings.append("The saved changes remain in place. The requested operation is only partly complete.")
        actions = ["Tell the user exactly what was saved and the current state. Retry only the fields in data.recovery using update_task; omit its operation metadata."]
    elif name == "schedule_task" and data.get("created") is False and data.get("state") == "paused":
        warnings.append("This existing task remains paused and has no scheduled run until re-enabled.")
        actions.append("Explain that it remains paused. If the user wants it running, use update_task with this taskId and paused: false.")
    if data.get("state") == "completed":
        warnings.append("This task has no run left on its schedule; it is listed as done until its schedule gives it one.")
    incomplete = data.get("outcome") == "partial"
    paused_duplicate = name == "schedule_task" and data.get("created") is False and data.get("state") == "paused"
    return {"status": "warning" if incomplete or paused_duplicate else "success",
            "summary": summary, "data": data, "warnings": warnings, "next_actions": actions}


def call(name: str, arguments: dict) -> dict:
    if name not in TOOL_NAMES:
        raise TaskToolError("task_tools_request_invalid", "Unknown task tool: %s." % name)
    payload = _validated(name, arguments)
    return _answer(name, _post("schedule" if name == "schedule_task" else "update", payload))
