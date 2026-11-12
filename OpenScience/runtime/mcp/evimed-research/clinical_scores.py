"""`clinical_score`: clinical scales and multi-step clinical formulas, computed from their published definitions.

One tool, three actions. `list` finds an id by name; `describe` states a score's items, accepted values, units, what each
grade means, its source and its published versions; `compute` returns the value with, for every item, the points and the
rule applied, the exact formula and constants, the source, what is missing, and the same score under every other
published version that the inputs allow (so a reader sees a version choice instead of inheriting it).

Nothing is assumed. A missing item refuses the calculation (`clinical_score_missing_inputs`) and says what the score
could range over; only an item the caller names in `assume_absent`, and only one whose absence the definition makes
meaningful, is counted as absent, and the result says so. A wrong unit, an unknown item, a value outside any plausible
range and a patient outside the score's population are each refused with their own code.

The definitions are in `clinical_score_points.py` and `clinical_score_formulas.py`; every constant there carries its
source. A score that could not be checked against a primary definition is not in the registry.
"""
from __future__ import annotations

import difflib

import clinical_score_formulas
import clinical_score_points
from clinical_score_verification import VERIFICATION
from clinical_score_kit import (ABSENT_INVALID, MISSING_INPUTS, REQUEST_INVALID, UNKNOWN_INPUT, UNKNOWN_SCORE, UNKNOWN_VERSION, Context, ScoreError,
                                point_range)

TOOL_NAME = "clinical_score"

SCALES = {}
for _scale in (*clinical_score_points.SCALES, *clinical_score_formulas.SCALES):
    if _scale.id in SCALES:
        raise AssertionError("duplicate clinical score id " + _scale.id)
    SCALES[_scale.id] = _scale

ACTIONS = ("list", "describe", "compute")


def tool_definitions():
    return [{
        "name": TOOL_NAME,
        "description": (
            "Deterministic clinical scores and multi-step clinical formulas (risk scores, severity indices, eGFR and "
            "dosing equations, electrolyte and fluid formulas, dates) computed from their published "
            "definitions. When a question needs one, use this instead of computing by hand. list finds an id, describe "
            "gives its items, units and versions, compute returns the value with each item's points, the formula and "
            "constants, the source, and the value under other published versions. A missing item is refused, never assumed."),
        "inputSchema": {"type": "object", "additionalProperties": False, "required": ["action"], "properties": {
            "action": {"type": "string", "enum": list(ACTIONS)},
            "filter": {"type": "string", "minLength": 1, "maxLength": 80,
                       "description": "list: words to find in a score's name, id or group; omit for all."},
            "id": {"type": "string", "minLength": 1, "maxLength": 64, "description": "describe, compute: a score id from list."},
            "inputs": {"type": "object", "description": (
                "compute: item id -> value. A measurement is {\"value\": 1.2, \"unit\": \"mg/dL\"}; a finding is true or false; "
                "a category is one of the values describe lists.")},
            "version": {"type": "string", "minLength": 1, "maxLength": 48,
                        "description": "compute: a published form of the score; describe names the default. Other versions' values are returned too."},
            "assume_absent": {"type": "array", "maxItems": 60, "items": {"type": "string", "minLength": 1, "maxLength": 48},
                              "description": "compute: items to count as absent when not given (or \"all\"). Without it a missing item refuses the calculation."},
        }}}]


def call(arguments):
    """The tool's answer as a result dict, or a ScoreError the server turns into a failure."""
    if not isinstance(arguments, dict) or set(arguments) - {"action", "filter", "id", "inputs", "version", "assume_absent"}:
        raise ScoreError(REQUEST_INVALID, "Unsupported clinical_score request fields.")
    action = arguments.get("action")
    if action not in ACTIONS:
        raise ScoreError(REQUEST_INVALID, "action must be one of: %s." % ", ".join(ACTIONS))
    if action == "list":
        return _list(arguments.get("filter"))
    scale = _scale(arguments.get("id"))
    if action == "describe":
        data = scale.describe()
        checked = VERIFICATION.get(scale.id)
        if checked:
            data["verification"] = {"definition_read_from": checked[0], "worked_examples": checked[1]}
        return {"status": "success", "summary": "%s: %d items, %d version(s)." % (scale.name, len(scale.items), len(scale.versions)), "data": data}
    return _compute(scale, arguments)


def _scale(raw):
    if not isinstance(raw, str) or not raw.strip():
        raise ScoreError(REQUEST_INVALID, "id is required; use action=list to find it.")
    key = raw.strip().lower().replace("-", "_").replace(" ", "_")
    if key in SCALES:
        return SCALES[key]
    for scale in SCALES.values():
        if key == scale.name.lower().replace("-", "_").replace(" ", "_") or key in (a.lower().replace("-", "_").replace(" ", "_") for a in scale.aliases):
            return scale
    near = difflib.get_close_matches(key, list(SCALES), n=4, cutoff=0.5)
    raise ScoreError(UNKNOWN_SCORE, "No score with id %r%s." % (raw, "; did you mean " + ", ".join(near) if near else ""),
                     {"did_you_mean": near})


def _list(text):
    words = [word for word in (text or "").lower().replace("-", " ").replace("_", " ").split() if word]
    rows = []
    for scale in SCALES.values():
        haystack = " ".join([scale.id, scale.name, scale.group, *scale.aliases]).lower().replace("-", " ").replace("_", " ")
        if all(word in haystack for word in words):
            rows.append({"id": scale.id, "name": scale.name, "group": scale.group})
    summary = "%d score(s)%s. describe an id for its items, units and versions." % (len(rows), " matching %r" % text if text else "")
    return {"status": "success", "summary": summary, "data": {"count": len(rows), "scores": rows}}


def _need(scale, name):
    """Whether the default version reads an item: it is the first thing a caller correcting a call wants to know."""
    if name in scale.versions[scale.default].requires:
        return ""
    return " (another version reads it)" if any(name in v.requires for v in scale.versions.values()) else " (optional)"


def _nearest(name, candidates):
    return difflib.get_close_matches(name, list(candidates), n=3, cutoff=0.5)


def _compute(scale, arguments):
    version_id = arguments.get("version") or scale.default
    if version_id not in scale.versions:
        raise ScoreError(UNKNOWN_VERSION, "%s has no version %r; versions: %s." % (scale.id, version_id, ", ".join(scale.versions)),
                         {"versions": list(scale.versions), "default": scale.default})
    version = scale.versions[version_id]
    inputs = arguments.get("inputs")
    if inputs is None:
        inputs = {}
    if not isinstance(inputs, dict):
        raise ScoreError(REQUEST_INVALID, "inputs must be an object of item id -> value.")
    unknown = [key for key in inputs if key not in scale.items]
    if unknown:
        raise ScoreError(UNKNOWN_INPUT, "%s has no item %s; its items are: %s." % (
            scale.id, ", ".join(repr(key) for key in unknown), ", ".join(scale.item_order)),
            {"unknown": unknown, "did_you_mean": {key: _nearest(key, scale.items) for key in unknown}, "items": list(scale.item_order),
             "expects": {name: scale.items[name].brief() + _need(scale, name) for name in scale.item_order}})
    assume = arguments.get("assume_absent") or []
    if not isinstance(assume, list) or not all(isinstance(name, str) for name in assume):
        raise ScoreError(REQUEST_INVALID, "assume_absent is a list of item ids.")
    assume_all = "all" in assume
    named = [name for name in assume if name != "all"]
    stray = [name for name in named if name not in scale.items]
    if stray:
        raise ScoreError(UNKNOWN_INPUT, "assume_absent names %s, which %s has no item of." % (", ".join(repr(s) for s in stray), scale.id),
                         {"unknown": stray, "items": list(scale.item_order)})

    parsed, problems = {}, []
    for key, raw in inputs.items():
        if raw is None:
            continue
        try:
            parsed[key] = scale.items[key].parse(raw)
        except ScoreError as error:
            problems.append(error)
    if problems:
        first = problems[0]
        data = {**first.data, "all_problems": [{"code": p.code, "message": str(p), **p.data} for p in problems]}
        raise ScoreError(first.code, "; ".join(str(p) for p in problems), data)

    assumed = []
    missing = [item for item in version.requires if item not in parsed]
    for item in list(missing):
        if item in named or assume_all:
            absent = scale.items[item].absent()
            if absent is None:
                if item in named:
                    raise ScoreError(ABSENT_INVALID, "%s cannot be counted as absent: %s" % (item, _why_not_absent(scale.items[item])),
                                     {"item": item})
                continue
            parsed[item] = absent
            assumed.append(item)
            missing.remove(item)
    if missing:
        raise ScoreError(MISSING_INPUTS, "%s needs %s." % (scale.name, ", ".join(missing)), _missing_data(scale, version, inputs, parsed, missing, arguments))

    ctx = Context(scale, parsed, set(assumed))
    ctx.requested_absent = set(scale.items) if assume_all else set(named)
    outcome = version.compute(ctx)
    # an assumption a version made itself (a laboratory item that only some patients need) is reported like the engine's own
    assumed = assumed + [row["item"] for row in outcome.rows if row.get("assumed_absent") and row["item"] not in assumed]
    unused = [key for key in inputs if inputs[key] is not None and key not in version.requires and key not in ctx.touched]
    alternatives = []
    for other in scale.versions.values():
        if other.id == version.id:
            continue
        lacking = [item for item in other.requires if item not in parsed]
        if lacking:
            alternatives.append({"version": other.id, "label": other.label, "not_computed": "missing " + ", ".join(lacking)})
            continue
        try:
            alt_ctx = Context(scale, parsed, set(assumed))
            alt_ctx.requested_absent = ctx.requested_absent
            alt = other.compute(alt_ctx)
        except ScoreError as error:
            alternatives.append({"version": other.id, "label": other.label, "not_computed": str(error), "code": error.code})
            continue
        alternatives.append({"version": other.id, "label": other.label, "value": alt.value, "unit": alt.unit,
                             **({"category": alt.category} if alt.category is not None else {}), **({"note": other.note} if other.note else {}), "source": other.source})
    result = {"value": outcome.value, "unit": outcome.unit}
    if outcome.category is not None:
        result["category"] = outcome.category
    if outcome.unrounded is not None:
        result["unrounded"] = outcome.unrounded
    if outcome.rounding:
        result["rounding"] = outcome.rounding
    data = {"id": scale.id, "name": scale.name, "version": version.id, "version_label": version.label,
            "default_version": version.id == scale.default, "result": result, "items": outcome.rows,
            "formula": outcome.formula, "constants": outcome.constants, "source": version.source, "missing": [],
            "assumed_absent": assumed, "alternatives": alternatives, "scope": scale.scope}
    if outcome.steps:
        data["steps"] = outcome.steps
    if outcome.notes:
        data["notes"] = outcome.notes
    if version.note:
        data.setdefault("notes", []).append(version.note)
    if unused:
        data["unused_inputs"] = unused
    data.update(outcome.extra)
    if isinstance(outcome.value, dict):
        value_text = "%d values in %s (see result.value)" % (len(outcome.value), outcome.unit)
    else:
        value_text = "%s %s" % (outcome.value, outcome.unit) if outcome.unit else str(outcome.value)
    summary = "%s%s = %s%s." % (scale.name, "" if version.id == scale.default else " (%s)" % version.id, value_text,
                                " (%s)" % outcome.category if isinstance(outcome.category, str) else "")
    reply = {"status": "success", "summary": summary, "data": data}
    if assumed:
        reply["status"] = "warning"
        reply["warnings"] = ["Counted as absent at the caller's request, not measured: %s." % ", ".join(assumed)]
        reply["next_actions"] = ["Say in the answer that these were assumed absent, not observed."]
    return reply


def _why_not_absent(item):
    if item.kind == "number":
        return "a measurement has no 'absent' value; ask for it or leave the score uncomputed."
    return "the definition has no absent grade for it."


def _missing_data(scale, version, inputs, parsed, missing, arguments):
    data = {"missing": missing,
            "missing_detail": [{"item": item, "label": scale.items[item].label, **{k: v for k, v in scale.items[item].describe().items()
                                                                                 if k in ("unit", "accepted_units", "options", "accepts")},
                                "can_assume_absent": scale.items[item].absent() is not None} for item in missing],
            "provided": sorted(parsed), "computed": False}
    additive = getattr(version, "additive", False)
    if additive:
        bounds = point_range(scale, version, parsed, set(missing))
        if bounds is not None:
            low, high = bounds
            data["possible_range"] = {"min": low, "max": high, "note": "the lowest and highest total the missing items could add to the items given"}
    assumable = [item for item in missing if scale.items[item].absent() is not None]
    if assumable and len(assumable) == len(missing):
        trial = dict(parsed)
        for item in missing:
            trial[item] = scale.items[item].absent()
        try:
            outcome = version.compute(Context(scale, trial, set(missing)))
            data["if_assume_absent"] = {"value": outcome.value, "unit": outcome.unit,
                                        **({"category": outcome.category} if outcome.category is not None else {}),
                                        "note": "what the score would be if assume_absent named %s; nothing was assumed in this reply" % ", ".join(missing)}
        except ScoreError:
            pass
    return data


def next_action(error):
    """What a caller does after this refusal."""
    if error.code == MISSING_INPUTS:
        action = "Ask for the missing item(s), or, if the case really says they are absent, call again with assume_absent naming them."
    elif error.code in (UNKNOWN_SCORE, UNKNOWN_VERSION, UNKNOWN_INPUT):
        action = "Use list or describe to find the id, version or item names, then call again."
    else:
        action = "Correct the named item and call again; nothing was computed."
    return action
