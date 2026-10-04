"""A trial's complete registry record, preserved as a snapshot and aligned against the ones held before it.

Hidden knowledge, from the live wire (2026-10-04) and not from the documentation:

- **The documented v2 API serves the current record only.** `GET /api/v2/studies/{nctId}`
  answers the whole record (`protocolSection`, `resultsSection` with posted results,
  `derivedSection`, `hasResults`); there is no history path in it, and the data model
  (`/studies/metadata`, 454 fields) has no version or history field. The website's
  Record History tab is served by an internal interface (`/api/int/...`, which
  robots.txt allows "to let the SPA function") that answered 403 to a programmatic
  read from this host with and without a browser's headers. So a record's history is
  what has been preserved: each read becomes a content-addressed snapshot, and a
  snapshot is compared with the one held before it. What happened before the first
  snapshot is reported as not available through the API, never reconstructed.
- **Two reads a second apart are byte-identical, but not two reads a day apart.**
  `derivedSection.miscInfoModule.versionHolder` is the date the API's copy was loaded
  (equal to the date of `/version`'s `dataTimestamp`), so it changes for every study
  on every data load. A snapshot's identity leaves that one field out (it is kept in
  the result as `registryDataVersion`), or an unchanged trial would be a "new
  version" every morning and a real change would be lost among them.
- **A registered outcome and a reported result are different lists.** Registered
  outcomes (`protocolSection.outcomesModule`) say what the sponsor committed to
  measure and when; reported results (`resultsSection.outcomeMeasuresModule`) say what
  was posted. They are joined here by the exact title (whitespace and case folded) and
  nothing else: the join says which registered outcomes have no reported result and
  which reported results were never registered under that title, and leaves it there.
  Whether a reworded title is the same endpoint is a judgment this code does not make.
- **Group ids are per-version labels** (`OG000`); groups are named by their titles.

What is preserved is the record, a quotable Markdown rendering and the alignment, in
one capture: `record.json` (the registry's record with the one volatile field moved
out), `record.md`, `alignment.json`. Bytes carry no retrieval time, so an unchanged
trial is the same capture; a changed trial is a new capture beside the old one, and
the result says what changed between them in a closed vocabulary of kinds
(`CHANGE_KINDS`), never in prose about whether it matters.
"""

from __future__ import annotations

import hashlib
import json
import re
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

import public_sources
import source_intake
import source_outcome
import source_transport as transport
import source_types
from immutable_capture import ImmutableCaptureError, managed_workspace, preserve

NCT_ID = re.compile(r"^NCT\d{8}$")
API_BASE = "https://clinicaltrials.gov/api/v2"
DEADLINE_SECONDS = 60.0
MAX_RECORD_BYTES = 12 * 1024 * 1024
MAX_MARKDOWN_CHARS = 400_000
MAX_CHANGES = 200
MAX_HELD_LISTED = 20
MAX_EVENT_ROWS = 200
CAPTURE_ROOT = Path(".evimed-sources") / "clinicaltrials"
VOLATILE = ("derivedSection", "miscInfoModule", "versionHolder")
CHANGE_KINDS = (
    "results_posted", "field_changed", "enrollment_changed", "eligibility_changed", "eligibility_text_changed",
    "arm_added", "arm_removed", "arm_changed",
    "endpoint_added", "endpoint_removed", "endpoint_role_changed", "endpoint_timeframe_changed", "endpoint_description_changed",
    "result_added", "result_removed", "result_values_changed", "result_timeframe_changed", "result_population_changed",
    "flow_changed", "baseline_changed", "adverse_event_totals_changed",
)
ROLE_OF = {"primaryOutcomes": "primary", "secondaryOutcomes": "secondary", "otherOutcomes": "other"}
RESULT_ROLE = {"PRIMARY": "primary", "SECONDARY": "secondary", "OTHER": "other"}


def _norm(value):
    return " ".join(str(value or "").split()).casefold()


def _text(value):
    return " ".join(str(value or "").split())


def _date(struct):
    if isinstance(struct, dict) and struct.get("date"):
        return {"date": struct["date"], **({"type": struct["type"]} if struct.get("type") else {})}
    return None


def _get(value, *path):
    for key in path:
        value = value.get(key) if isinstance(value, dict) else None
    return value


# ----------------------------------------------------------------------------
# The record
# ----------------------------------------------------------------------------
def split_volatile(record):
    """`(record without the load date, the load date)`: the snapshot's identity leaves the one field out."""
    copy = json.loads(json.dumps(record))
    module = _get(copy, "derivedSection", "miscInfoModule")
    holder = module.pop("versionHolder", None) if isinstance(module, dict) else None
    return copy, holder


def record_bytes(record):
    return (json.dumps(record, ensure_ascii=False, indent=1) + "\n").encode("utf-8")


def _groups(rows):
    return {row.get("id"): _text(row.get("title")) or row.get("id") for row in rows or [] if isinstance(row, dict)}


def _measure_rows(measure, groups):
    """The values of one measure as rows keyed by group title, class and category, never by id."""
    rows = []
    for klass in measure.get("classes") or []:
        for category in klass.get("categories") or []:
            for item in category.get("measurements") or []:
                row = {"group": groups.get(item.get("groupId"), item.get("groupId")), "value": item.get("value")}
                for source, target in (("spread", "spread"), ("lowerLimit", "lower"), ("upperLimit", "upper"), ("comment", "comment")):
                    if item.get(source) is not None:
                        row[target] = item[source]
                if _text(klass.get("title")):
                    row["class"] = _text(klass["title"])
                if _text(category.get("title")):
                    row["category"] = _text(category["title"])
                rows.append(row)
    return rows


def _denominators(measure, groups):
    rows = []
    for denom in measure.get("denoms") or []:
        for count in denom.get("counts") or []:
            rows.append({"units": denom.get("units"), "group": groups.get(count.get("groupId"), count.get("groupId")), "count": count.get("value")})
    return rows


def extract(record):
    """The record's populations, endpoints and timepoints as one aligned structure.

    Every field is read from where the registry puts it and is absent when the
    registry does not say: a missing date is not a date, an unposted result is not
    an empty one.
    """
    protocol = record.get("protocolSection") or {}
    results = record.get("resultsSection") or {}
    status = protocol.get("statusModule") or {}
    design = protocol.get("designModule") or {}
    eligibility = protocol.get("eligibilityModule") or {}
    ident = protocol.get("identificationModule") or {}
    out = {
        "nctId": ident.get("nctId"),
        "title": ident.get("briefTitle") or ident.get("officialTitle"),
        "version": {key: value for key, value in {
            "lastUpdatePosted": _get(status, "lastUpdatePostDateStruct", "date"),
            "lastUpdateSubmitted": status.get("lastUpdateSubmitDate"),
            "resultsFirstPosted": _get(status, "resultsFirstPostDateStruct", "date"),
            "statusVerified": status.get("statusVerifiedDate"),
            "hasResults": bool(record.get("hasResults")),
        }.items() if value is not None},
        "status": {key: value for key, value in {"overall": status.get("overallStatus"), "whyStopped": status.get("whyStopped")}.items() if value},
        "timepoints": {name: value for name, value in {
            "start": _date(status.get("startDateStruct")), "primaryCompletion": _date(status.get("primaryCompletionDateStruct")),
            "completion": _date(status.get("completionDateStruct")),
        }.items() if value},
    }
    arms = [
        {"label": _text(arm.get("label")), "type": arm.get("type"), "interventions": sorted(arm.get("interventionNames") or [])}
        for arm in (protocol.get("armsInterventionsModule") or {}).get("armGroups") or []
    ]
    flow_module = results.get("participantFlowModule") or {}
    flow_groups = _groups(flow_module.get("groups"))
    flow = []
    for period in flow_module.get("periods") or []:
        for milestone in period.get("milestones") or []:
            for achievement in milestone.get("achievements") or []:
                flow.append({
                    "period": _text(period.get("title")), "milestone": milestone.get("type"),
                    "group": flow_groups.get(achievement.get("groupId"), achievement.get("groupId")), "count": achievement.get("numSubjects"),
                })
    baseline_module = results.get("baselineCharacteristicsModule") or {}
    baseline_groups = _groups(baseline_module.get("groups"))
    baseline = {"denominators": _denominators(baseline_module, baseline_groups)}
    if baseline_module.get("populationDescription"):
        baseline["populationDescription"] = _text(baseline_module["populationDescription"])
    baseline["measures"] = [
        {"title": _text(measure.get("title")), "unit": measure.get("unitOfMeasure"), "paramType": measure.get("paramType"), "values": _measure_rows(measure, baseline_groups)}
        for measure in baseline_module.get("measures") or []
    ]
    out["population"] = {
        "enrollment": {key: value for key, value in {"count": _get(design, "enrollmentInfo", "count"), "type": _get(design, "enrollmentInfo", "type")}.items() if value is not None},
        "eligibility": {key: value for key, value in {
            "sex": eligibility.get("sex"), "minimumAge": eligibility.get("minimumAge"), "maximumAge": eligibility.get("maximumAge"),
            "healthyVolunteers": eligibility.get("healthyVolunteers"), "standardAges": eligibility.get("stdAges"),
            "criteriaSha256": hashlib.sha256(_text(eligibility.get("eligibilityCriteria")).encode("utf-8")).hexdigest() if eligibility.get("eligibilityCriteria") else None,
        }.items() if value is not None},
        "arms": arms, "flow": flow, "baseline": baseline,
    }
    registered = []
    outcomes_module = protocol.get("outcomesModule") or {}
    for field, role in ROLE_OF.items():
        for item in outcomes_module.get(field) or []:
            registered.append({key: value for key, value in {
                "role": role, "measure": _text(item.get("measure")), "description": _text(item.get("description")) or None, "timeFrame": _text(item.get("timeFrame")) or None,
            }.items() if value is not None})
    reported = []
    for measure in (results.get("outcomeMeasuresModule") or {}).get("outcomeMeasures") or []:
        groups = _groups(measure.get("groups"))
        analyses = []
        for analysis in measure.get("analyses") or []:
            analyses.append({key: value for key, value in {
                "groups": [groups.get(group_id, group_id) for group_id in analysis.get("groupIds") or []],
                "paramType": analysis.get("paramType"), "value": analysis.get("paramValue"), "ciPct": analysis.get("ciPctValue"),
                "ciLower": analysis.get("ciLowerLimit"), "ciUpper": analysis.get("ciUpperLimit"), "pValue": analysis.get("pValue"),
                "method": analysis.get("statisticalMethod"),
            }.items() if value not in (None, [])})
        reported.append({key: value for key, value in {
            "role": RESULT_ROLE.get(measure.get("type")), "title": _text(measure.get("title")), "description": _text(measure.get("description")) or None,
            "timeFrame": _text(measure.get("timeFrame")) or None, "population": _text(measure.get("populationDescription")) or None,
            "unit": measure.get("unitOfMeasure"), "paramType": measure.get("paramType"), "dispersion": measure.get("dispersionType"),
            "reportingStatus": measure.get("reportingStatus"), "denominators": _denominators(measure, groups), "values": _measure_rows(measure, groups),
            "analyses": analyses,
        }.items() if value not in (None, [], "")})
    out["endpoints"] = {"registered": registered, "reported": reported, "joined": _join(registered, reported)}
    adverse = results.get("adverseEventsModule") or {}
    if adverse:
        out["adverseEvents"] = {
            "timeFrame": _text(adverse.get("timeFrame")) or None,
            "groups": [
                {key: row.get(key) for key in ("title", "deathsNumAffected", "deathsNumAtRisk", "seriousNumAffected", "seriousNumAtRisk", "otherNumAffected", "otherNumAtRisk") if row.get(key) is not None}
                for row in adverse.get("eventGroups") or []
            ],
            "seriousTerms": len(adverse.get("seriousEvents") or []), "otherTerms": len(adverse.get("otherEvents") or []),
        }
    return {key: value for key, value in out.items() if value not in (None, {}, [])}


def _join(registered, reported):
    """Registered outcomes joined to reported results by exact title, and what is left on each side."""
    available = {}
    for index, item in enumerate(reported):
        available.setdefault(_norm(item["title"]), []).append(index)
    matched, registered_only = [], []
    used = set()
    for index, item in enumerate(registered):
        slot = available.get(_norm(item["measure"]))
        if slot:
            target = slot.pop(0)
            used.add(target)
            matched.append({"measure": item["measure"], "registeredRole": item["role"], "reportedRole": reported[target].get("role"), "roleAgrees": item["role"] == reported[target].get("role")})
        else:
            registered_only.append({"measure": item["measure"], "role": item["role"]})
    reported_only = [{"title": item["title"], "role": item.get("role")} for index, item in enumerate(reported) if index not in used]
    return {"matched": matched, "registeredOnly": registered_only, "reportedOnly": reported_only}


# ----------------------------------------------------------------------------
# What changed between two snapshots
# ----------------------------------------------------------------------------
def _keyed(items, key):
    """Items by (key, occurrence): two outcomes with one title are not collapsed into one."""
    seen, keyed = {}, {}
    for item in items:
        base = key(item)
        seen[base] = seen.get(base, 0) + 1
        keyed[(base, seen[base])] = item
    return keyed


def diff(before, after):
    """The changes from one alignment to the next, as `{kind, ...}` entries of `CHANGE_KINDS`."""
    changes = []

    def add(kind, **fields):
        changes.append({"kind": kind, **fields})

    for section, names in (("version", None), ("status", None), ("timepoints", None)):
        old, new = before.get(section) or {}, after.get(section) or {}
        for name in sorted(set(old) | set(new)):
            if name == "hasResults" and not old.get(name) and new.get(name):
                add("results_posted", firstPosted=(after.get("version") or {}).get("resultsFirstPosted"))
            elif old.get(name) != new.get(name) and not (section == "version" and name == "hasResults"):
                add("field_changed", path="%s.%s" % (section, name), before=old.get(name), after=new.get(name))
    old_pop, new_pop = before.get("population") or {}, after.get("population") or {}
    if old_pop.get("enrollment") != new_pop.get("enrollment"):
        add("enrollment_changed", before=old_pop.get("enrollment"), after=new_pop.get("enrollment"))
    old_el, new_el = dict(old_pop.get("eligibility") or {}), dict(new_pop.get("eligibility") or {})
    old_text, new_text = old_el.pop("criteriaSha256", None), new_el.pop("criteriaSha256", None)
    for name in sorted(set(old_el) | set(new_el)):
        if old_el.get(name) != new_el.get(name):
            add("eligibility_changed", field=name, before=old_el.get(name), after=new_el.get(name))
    if old_text != new_text:
        add("eligibility_text_changed", before=old_text, after=new_text)
    old_arms, new_arms = _keyed(old_pop.get("arms") or [], lambda arm: _norm(arm["label"])), _keyed(new_pop.get("arms") or [], lambda arm: _norm(arm["label"]))
    for key in old_arms:
        if key not in new_arms:
            add("arm_removed", label=old_arms[key]["label"])
        elif old_arms[key] != new_arms[key]:
            add("arm_changed", label=old_arms[key]["label"], before=old_arms[key], after=new_arms[key])
    for key in new_arms:
        if key not in old_arms:
            add("arm_added", label=new_arms[key]["label"])
    if old_pop.get("flow") != new_pop.get("flow"):
        add("flow_changed", before=len(old_pop.get("flow") or []), after=len(new_pop.get("flow") or []), rowsDiffer=True)
    if old_pop.get("baseline") != new_pop.get("baseline"):
        add("baseline_changed", before=(old_pop.get("baseline") or {}).get("denominators"), after=(new_pop.get("baseline") or {}).get("denominators"))
    old_endpoints, new_endpoints = before.get("endpoints") or {}, after.get("endpoints") or {}
    old_reg = _keyed(old_endpoints.get("registered") or [], lambda item: (item["role"], _norm(item["measure"])))
    new_reg = _keyed(new_endpoints.get("registered") or [], lambda item: (item["role"], _norm(item["measure"])))
    removed = [key for key in old_reg if key not in new_reg]
    added = [key for key in new_reg if key not in old_reg]
    for key in list(removed):
        # The same measure under another role: a role change, not a removal and an addition.
        twin = next((other for other in added if other[0][1] == key[0][1] and other[1] == key[1]), None)
        if twin is not None:
            add("endpoint_role_changed", measure=old_reg[key]["measure"], before=key[0][0], after=twin[0][0])
            removed.remove(key)
            added.remove(twin)
    for key in removed:
        add("endpoint_removed", role=key[0][0], measure=old_reg[key]["measure"], timeFrame=old_reg[key].get("timeFrame"))
    for key in added:
        add("endpoint_added", role=key[0][0], measure=new_reg[key]["measure"], timeFrame=new_reg[key].get("timeFrame"))
    for key in old_reg:
        if key in new_reg:
            if old_reg[key].get("timeFrame") != new_reg[key].get("timeFrame"):
                add("endpoint_timeframe_changed", role=key[0][0], measure=old_reg[key]["measure"], before=old_reg[key].get("timeFrame"), after=new_reg[key].get("timeFrame"))
            if old_reg[key].get("description") != new_reg[key].get("description"):
                add("endpoint_description_changed", role=key[0][0], measure=old_reg[key]["measure"], before=old_reg[key].get("description"), after=new_reg[key].get("description"))
    old_res = _keyed(old_endpoints.get("reported") or [], lambda item: (item.get("role"), _norm(item["title"])))
    new_res = _keyed(new_endpoints.get("reported") or [], lambda item: (item.get("role"), _norm(item["title"])))
    for key in old_res:
        if key not in new_res:
            add("result_removed", role=key[0][0], title=old_res[key]["title"])
            continue
        old_item, new_item = old_res[key], new_res[key]
        if old_item.get("values") != new_item.get("values") or old_item.get("denominators") != new_item.get("denominators") or old_item.get("analyses") != new_item.get("analyses"):
            add("result_values_changed", role=key[0][0], title=old_item["title"], before=old_item.get("values"), after=new_item.get("values"))
        if old_item.get("timeFrame") != new_item.get("timeFrame"):
            add("result_timeframe_changed", role=key[0][0], title=old_item["title"], before=old_item.get("timeFrame"), after=new_item.get("timeFrame"))
        if old_item.get("population") != new_item.get("population"):
            add("result_population_changed", role=key[0][0], title=old_item["title"], before=old_item.get("population"), after=new_item.get("population"))
    for key in new_res:
        if key not in old_res:
            add("result_added", role=key[0][0], title=new_res[key]["title"])
    if (before.get("adverseEvents") or {}) != (after.get("adverseEvents") or {}):
        add("adverse_event_totals_changed", before=(before.get("adverseEvents") or {}).get("groups"), after=(after.get("adverseEvents") or {}).get("groups"))
    return changes


# ----------------------------------------------------------------------------
# The quotable rendering
# ----------------------------------------------------------------------------
def render_markdown(record, alignment):
    """A deterministic Markdown reading of the record: every number as the registry wrote it."""
    protocol = record.get("protocolSection") or {}
    results = record.get("resultsSection") or {}
    ident = protocol.get("identificationModule") or {}
    status = protocol.get("statusModule") or {}
    design = protocol.get("designModule") or {}
    nct = ident.get("nctId")
    lines = ["# %s" % (ident.get("briefTitle") or nct), "", "- NCT ID: %s" % nct]
    if ident.get("officialTitle"):
        lines.append("- Official title: %s" % _text(ident["officialTitle"]))
    sponsor = _get(protocol, "sponsorCollaboratorsModule", "leadSponsor", "name")
    if sponsor:
        lines.append("- Lead sponsor: %s" % sponsor)
    lines.append("- Overall status: %s%s%s" % (
        status.get("overallStatus") or "not stated", (" (verified %s)" % status["statusVerifiedDate"]) if status.get("statusVerifiedDate") else "",
        (" - why stopped: %s" % _text(status["whyStopped"])) if status.get("whyStopped") else "",
    ))
    design_bits = [design.get("studyType"), ", ".join(design.get("phases") or []), _get(design, "designInfo", "allocation"), _get(design, "designInfo", "primaryPurpose"), _get(design, "designInfo", "maskingInfo", "masking")]
    lines.append("- Design: %s" % "; ".join(str(bit) for bit in design_bits if bit))
    enrollment = alignment.get("population", {}).get("enrollment") or {}
    if enrollment:
        lines.append("- Enrollment: %s (%s)" % (enrollment.get("count"), enrollment.get("type") or "type not stated"))
    for label, name in (("Start", "start"), ("Primary completion", "primaryCompletion"), ("Completion", "completion")):
        point = alignment.get("timepoints", {}).get(name)
        if point:
            lines.append("- %s: %s (%s)" % (label, point["date"], point.get("type") or "type not stated"))
    version = alignment.get("version") or {}
    lines.append("- Record versions: last update posted %s; results first posted %s; has results: %s" % (
        version.get("lastUpdatePosted") or "not stated", version.get("resultsFirstPosted") or "not stated", "yes" if version.get("hasResults") else "no"))
    lines.append("- Registry page: https://clinicaltrials.gov/study/%s" % nct)
    arms = protocol.get("armsInterventionsModule") or {}
    if arms.get("armGroups"):
        lines.extend(["", "## Arms and interventions", ""])
        for arm in arms["armGroups"]:
            lines.append("- **%s** (%s): %s Interventions: %s." % (_text(arm.get("label")), arm.get("type") or "type not stated", _text(arm.get("description")) or "No description.", "; ".join(arm.get("interventionNames") or []) or "none listed"))
    eligibility = protocol.get("eligibilityModule") or {}
    if eligibility:
        lines.extend(["", "## Eligibility", ""])
        lines.append("- Sex: %s; minimum age: %s; maximum age: %s; healthy volunteers: %s" % (
            eligibility.get("sex") or "not stated", eligibility.get("minimumAge") or "not stated", eligibility.get("maximumAge") or "not stated", eligibility.get("healthyVolunteers", "not stated")))
        if eligibility.get("eligibilityCriteria"):
            lines.extend(["", eligibility["eligibilityCriteria"].strip()])
    registered = alignment.get("endpoints", {}).get("registered") or []
    if registered:
        lines.extend(["", "## Registered outcomes", ""])
        for role in ("primary", "secondary", "other"):
            rows = [item for item in registered if item["role"] == role]
            if rows:
                lines.extend(["### %s" % role.capitalize(), ""])
                for item in rows:
                    lines.append("- **%s**%s Time frame: %s" % (item["measure"], (" - %s." % item["description"].rstrip(".")) if item.get("description") else ".", item.get("timeFrame") or "not stated"))
    if results:
        lines.extend(["", "## Posted results", "", "- Results first posted: %s" % (version.get("resultsFirstPosted") or "not stated")])
        flow = alignment.get("population", {}).get("flow") or []
        if flow:
            lines.extend(["", "### Participant flow", "", "| Period | Milestone | Group | Participants |", "| --- | --- | --- | --- |"])
            lines.extend("| %s | %s | %s | %s |" % (row["period"], row["milestone"], row["group"], row["count"]) for row in flow)
        baseline = alignment.get("population", {}).get("baseline") or {}
        if baseline.get("denominators"):
            lines.extend(["", "### Baseline population", ""])
            if baseline.get("populationDescription"):
                lines.append(baseline["populationDescription"])
            lines.extend(["", "| Group | Units | Count |", "| --- | --- | --- |"])
            lines.extend("| %s | %s | %s |" % (row["group"], row["units"], row["count"]) for row in baseline["denominators"])
        for measure in baseline.get("measures") or []:
            lines.extend(["", "#### Baseline: %s%s" % (measure["title"], (" (%s)" % measure["unit"]) if measure.get("unit") else ""), ""])
            lines.extend(_value_table(measure["values"]))
        reported = alignment.get("endpoints", {}).get("reported") or []
        if reported:
            lines.extend(["", "### Outcome measures"])
        for item in reported:
            lines.extend(["", "#### %s (%s)" % (item["title"], (item.get("role") or "role not stated").upper()), ""])
            for label, name in (("Description", "description"), ("Population", "population"), ("Time frame", "timeFrame"), ("Unit", "unit"), ("Parameter", "paramType"), ("Dispersion", "dispersion")):
                if item.get(name):
                    lines.append("- %s: %s" % (label, item[name]))
            if item.get("denominators"):
                lines.append("- Analyzed: %s" % "; ".join("%s %s %s" % (row["group"], row["count"], row.get("units") or "") for row in item["denominators"]))
            lines.append("")
            lines.extend(_value_table(item.get("values") or []))
            for analysis in item.get("analyses") or []:
                lines.append("")
                lines.append("- Analysis (%s): %s %s%s%s%s" % (
                    ", ".join(analysis.get("groups") or []), analysis.get("paramType") or "estimate", analysis.get("value") or "",
                    (" with %s%% CI %s to %s" % (analysis.get("ciPct"), analysis.get("ciLower"), analysis.get("ciUpper"))) if analysis.get("ciLower") is not None else "",
                    ("; p = %s" % analysis["pValue"]) if analysis.get("pValue") else "", ("; %s" % analysis["method"]) if analysis.get("method") else ""))
        adverse = results.get("adverseEventsModule") or {}
        if adverse:
            lines.extend(["", "### Adverse events", ""])
            if adverse.get("timeFrame"):
                lines.append("- Time frame: %s" % _text(adverse["timeFrame"]))
            if adverse.get("frequencyThreshold") is not None:
                lines.append("- Reporting threshold for other events: %s%%" % adverse["frequencyThreshold"])
            lines.extend(["", "| Group | Deaths affected/at risk | Serious affected/at risk | Other affected/at risk |", "| --- | --- | --- | --- |"])
            for row in adverse.get("eventGroups") or []:
                lines.append("| %s | %s/%s | %s/%s | %s/%s |" % (
                    _text(row.get("title")), row.get("deathsNumAffected"), row.get("deathsNumAtRisk"), row.get("seriousNumAffected"),
                    row.get("seriousNumAtRisk"), row.get("otherNumAffected"), row.get("otherNumAtRisk")))
            groups = _groups(adverse.get("eventGroups"))
            for label, field in (("Serious", "seriousEvents"), ("Other", "otherEvents")):
                events = adverse.get(field) or []
                if events:
                    lines.extend(["", "#### %s events (%d terms%s)" % (label, len(events), ", first %d listed" % MAX_EVENT_ROWS if len(events) > MAX_EVENT_ROWS else ""), "", "| Organ system | Term | Group | Affected/at risk | Events |", "| --- | --- | --- | --- | --- |"])
                    for event in events[:MAX_EVENT_ROWS]:
                        for stat in event.get("stats") or []:
                            lines.append("| %s | %s | %s | %s/%s | %s |" % (event.get("organSystem"), event.get("term"), groups.get(stat.get("groupId"), stat.get("groupId")), stat.get("numAffected"), stat.get("numAtRisk"), stat.get("numEvents")))
    markdown = "\n".join(lines).rstrip() + "\n"
    if len(markdown) > MAX_MARKDOWN_CHARS:
        markdown = markdown[:MAX_MARKDOWN_CHARS].rsplit("\n", 1)[0] + "\n\n_(The rest of the record is in record.json.)_\n"
    return markdown


def _value_table(rows):
    if not rows:
        return ["_No values posted._"]
    has_class = any(row.get("class") or row.get("category") for row in rows)
    head = "| Group |%s Value | Spread / range |" % (" Class / category |" if has_class else "")
    lines = [head, "| --- |%s --- | --- |" % (" --- |" if has_class else "")]
    for row in rows:
        spread = row.get("spread") or ("%s to %s" % (row.get("lower"), row.get("upper")) if row.get("lower") is not None else "")
        label = " / ".join(part for part in (row.get("class"), row.get("category")) if part)
        lines.append("| %s |%s %s | %s |" % (row["group"], (" %s |" % label) if has_class else "", row.get("value"), spread))
    return lines


# ----------------------------------------------------------------------------
# Snapshots held in the workspace
# ----------------------------------------------------------------------------
def held_snapshots(workspace, nct_id):
    """The snapshots already preserved for this trial, oldest first by what the registry says."""
    root = workspace / CAPTURE_ROOT / nct_id
    held = []
    try:
        names = sorted(entry.name for entry in root.iterdir() if entry.is_dir() and not entry.is_symlink() and re.fullmatch(r"[0-9a-f]{64}", entry.name))
    except OSError:
        return []
    for name in names[:200]:
        path = root / name / "alignment.json"
        try:
            if path.is_symlink() or not path.is_file():
                continue
            alignment = json.loads(path.read_text(encoding="utf-8"))
            observed = path.stat().st_mtime
        except (OSError, ValueError):
            continue
        version = alignment.get("version") or {}
        held.append({
            "directory": name, "alignment": alignment, "observedAt": observed,
            "markers": {key: version.get(key) for key in ("lastUpdatePosted", "resultsFirstPosted", "statusVerified", "hasResults") if version.get(key) is not None},
        })
    held.sort(key=lambda item: (item["markers"].get("lastUpdatePosted") or "", item["observedAt"]))
    return held


def _resolve_target(held, current_directory, compare_to):
    """`(snapshot to compare against or None, why none)`."""
    candidates = [item for item in held if item["directory"] != current_directory]
    if compare_to == "none":
        return None, "not_requested"
    if compare_to in (None, "", "previous"):
        return (candidates[-1], None) if candidates else (None, "no_earlier_snapshot")
    matches = [item for item in candidates if item["directory"].startswith(compare_to.casefold())]
    if len(matches) == 1:
        return matches[0], None
    if len(matches) > 1:
        return None, "compare_target_ambiguous"
    return None, "compare_target_not_held"


# ----------------------------------------------------------------------------
# The tool
# ----------------------------------------------------------------------------
def _fetch(nct_id, deadline):
    scope = "ClinicalTrials.gov"
    url = "%s/studies/%s?format=json" % (API_BASE, nct_id)
    value, response = transport.fetch_json(url, deadline=deadline, scope=scope, max_bytes=MAX_RECORD_BYTES, accept_statuses=(404,))
    if response.status == 404:
        return None
    if not isinstance(value, dict) or not isinstance(value.get("protocolSection"), dict):
        raise source_outcome.SourceError(
            "unavailable", "ClinicalTrials.gov answered with something that is not a study record.",
            scope=scope, reason="invalid_response", retryable=False,
        )
    if (value["protocolSection"].get("identificationModule") or {}).get("nctId") not in (nct_id, None):
        raise source_outcome.SourceError(
            "unavailable", "ClinicalTrials.gov answered with the record of another trial.", scope=scope, reason="identity_mismatch", retryable=False,
        )
    return value


def _registry_data_version(deadline):
    """The API's own data version (`/version`), or None: the read does not depend on it."""
    try:
        value, _ = transport.fetch_json("%s/version" % API_BASE, deadline=deadline, scope="ClinicalTrials.gov", attempts=1, per_attempt=10)
    except (source_outcome.SourceError, public_sources.PublicSourceError):
        return None
    return {key: value[key] for key in ("apiVersion", "dataTimestamp") if isinstance(value, dict) and key in value}


def snapshot(arguments):
    """`clinical_trial_snapshot`: the complete record, preserved, aligned and compared with the one held before it."""
    nct_id = str(arguments.get("nctId") or "").strip().upper()
    if not NCT_ID.match(nct_id):
        raise public_sources.PublicSourceError("public_source_trial_id_invalid", "nctId is a ClinicalTrials.gov id: NCT and eight digits.")
    compare_to = str(arguments.get("compareTo") or "previous").strip()
    if compare_to not in ("previous", "none") and not re.fullmatch(r"[0-9a-fA-F]{8,64}", compare_to):
        raise public_sources.PublicSourceError("public_source_trial_id_invalid", "compareTo is previous, none, or the leading 8 to 64 hex characters of a held snapshot's directory name.")
    deadline = transport.Deadline(DEADLINE_SECONDS)
    try:
        record = _fetch(nct_id, deadline)
    except source_outcome.Truncated as error:
        return {
            "status": "warning",
            "summary": "The record of %s is larger than the %d MiB this tool reads; nothing was preserved from a cut body." % (nct_id, MAX_RECORD_BYTES // (1024 * 1024)),
            "data": {"items": [], "nctId": nct_id, "outcome": source_outcome.truncated(
                kept=0, limit=MAX_RECORD_BYTES, unit="bytes of record", received=error.received,
                how="Open the study page https://clinicaltrials.gov/study/%s for the record, and add the parts you need to the knowledge base." % nct_id)},
            "warnings": ["A record this large was not read; a partial body is never preserved as the record."],
            "next_actions": ["Read the study page with web_read, or use search with a narrower field list."],
        }
    registry_version = _registry_data_version(deadline)
    if record is None:
        return {
            "status": "warning",
            "summary": "ClinicalTrials.gov holds no record %s." % nct_id,
            "data": {"items": [], "nctId": nct_id, "outcome": source_outcome.no_results(
                reason="not_found", how="Check the registration number; a registry that holds no such record says nothing about whether the trial exists in another registry.")},
            "warnings": ["The registry has no record under this id; that is not evidence that the trial does not exist."],
            "next_actions": ["Check the number against the paper or the sponsor, or search the other registries (ChiCTR, ISRCTN, EU CTR) with clinical_trial_search."],
        }
    stable, load_date = split_volatile(record)
    alignment = extract(stable)
    markdown = render_markdown(stable, alignment)
    payloads = {
        "record.json": record_bytes(stable), "record.md": markdown.encode("utf-8"),
        "alignment.json": (json.dumps(alignment, ensure_ascii=False, indent=1, sort_keys=True) + "\n").encode("utf-8"),
    }
    title = alignment.get("title") or nct_id
    sidecar = source_types.sidecar({"id": nct_id, "title": title, "url": "https://clinicaltrials.gov/study/%s" % nct_id, "tool": "clinical_trial_snapshot", "source": "clinicaltrials.gov"})
    if sidecar:
        payloads[sidecar[0]] = sidecar[1]
    warnings = []
    try:
        workspace = managed_workspace()
        earlier = held_snapshots(workspace, nct_id)
        paths = preserve(workspace, CAPTURE_ROOT / nct_id, payloads)
    except ImmutableCaptureError as error:
        raise public_sources.PublicSourceError("public_source_trial_snapshot_failed", str(error)) from error
    directory = Path(paths["record.md"]).parent.name
    is_new = directory not in {item["directory"] for item in earlier}
    held = held_snapshots(workspace, nct_id)
    target, why_none = _resolve_target(held, directory, compare_to)
    comparison = None
    if target is not None:
        changes = diff(target["alignment"], alignment)
        counts = {}
        for change in changes:
            counts[change["kind"]] = counts.get(change["kind"], 0) + 1
        comparison = {
            "against": {"directory": target["directory"], **target["markers"], "alignmentPath": "%s/alignment.json" % (CAPTURE_ROOT / nct_id / target["directory"]).as_posix()},
            "this": {"directory": directory, **(alignment.get("version") or {})},
            "unchanged": not changes, "counts": counts, "changes": changes[:MAX_CHANGES],
        }
        if len(changes) > MAX_CHANGES:
            comparison["outcome"] = source_outcome.truncated(
                kept=MAX_CHANGES, limit=MAX_CHANGES, unit="changes listed", how="%d changes in all; the two alignment.json files hold both versions in full." % len(changes))
    elif why_none in ("compare_target_not_held", "compare_target_ambiguous"):
        warnings.append("The snapshot named in compareTo is %s; no comparison was made. The held snapshots are listed in data.history.held." % ("not held in this workspace" if why_none == "compare_target_not_held" else "ambiguous"))
    held_view = [
        {"directory": item["directory"], **item["markers"], "current": item["directory"] == directory, "alignmentPath": "%s/alignment.json" % (CAPTURE_ROOT / nct_id / item["directory"]).as_posix()}
        for item in held
    ][-MAX_HELD_LISTED:]
    history = {
        "source": "snapshots preserved by this tool in this project",
        "snapshotsHeld": len(held), "held": held_view, "thisSnapshotIsNew": is_new,
        "comparison": "made" if comparison else why_none,
        "beforeFirstSnapshot": {
            "available": False, "reason": "not_in_documented_api",
            "how": "ClinicalTrials.gov publishes a record's earlier versions on the study page's Record History tab, not in its documented API, and its internal history interface refused a programmatic read. Open https://clinicaltrials.gov/study/%s in a browser to see versions older than the first snapshot." % nct_id,
        },
    }
    if len(held) > MAX_HELD_LISTED:
        history["outcome"] = source_outcome.more_available(
            returned=len(held_view), total=len(held), next_arguments={"compareTo": "<directory prefix>"},
            how="Older snapshots are named by directory under %s; pass the leading hex of one as compareTo." % (CAPTURE_ROOT / nct_id).as_posix(),
        )
    results_posted = bool(record.get("hasResults"))
    markdown_path, record_path, alignment_path = paths["record.md"], paths["record.json"], paths["alignment.json"]
    sha256s = {path: hashlib.sha256(payloads[name]).hexdigest() for name, path in paths.items() if name in payloads}
    data = {
        "nctId": nct_id, "title": title, "contentLevel": "registry_record_with_results" if results_posted else "registry_record",
        "status": (alignment.get("status") or {}).get("overall"), "version": alignment.get("version"),
        "results": {"posted": results_posted, **({"firstPosted": alignment["version"].get("resultsFirstPosted"), "outcomeMeasures": len(alignment["endpoints"]["reported"])} if results_posted else {})},
        "markdownPath": markdown_path, "recordPath": record_path, "alignmentPath": alignment_path, "artifactSha256s": sha256s,
        "registryDataVersion": {**(registry_version or {}), **({"recordLoadedOn": load_date} if load_date else {})} or None,
        "endpoints": {"registered": len(alignment["endpoints"]["registered"]), "reported": len(alignment["endpoints"]["reported"]), **alignment["endpoints"]["joined"]},
        "history": history, "outcome": source_outcome.complete(),
    }
    if not results_posted:
        data["results"]["outcome"] = source_outcome.no_results(
            reason="results_not_posted", how="The registry holds this record without posted results; results may exist in a publication.")
    if comparison is not None:
        data["comparison"] = comparison
    data = {key: value for key, value in data.items() if value is not None}
    if arguments.get("intake") is True:
        data["intake"] = source_intake.hand_off("clinicaltrials-%s" % nct_id, [markdown_path], deadline=deadline)
        if not data["intake"].get("available"):
            warnings.append(data["intake"].get("how") or "Source intake was not available.")
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    summary = "Preserved the %s record of %s%s." % (
        "complete" if results_posted else "complete (no posted results)", nct_id,
        (" and compared it with the snapshot held before it: %s" % ("nothing changed" if comparison["unchanged"] else "%d change(s)" % len(comparison["changes"]) + (" or more" if len(comparison["changes"]) >= MAX_CHANGES else ""))) if comparison else "",
    )
    result = {
        "status": "warning" if warnings else "success",
        "summary": summary,
        "data": data,
        "sources": [{
            "id": nct_id, "title": title, "url": "https://clinicaltrials.gov/study/%s" % urllib.parse.quote(nct_id),
            "source": "clinicaltrials.gov", "retrievedAt": now, "evidenceAccess": "registry_record", "artifactPath": markdown_path,
        }],
        "artifacts": [markdown_path, record_path, alignment_path],
    }
    if warnings:
        result["warnings"] = warnings
        result["next_actions"] = ["Go on with the preserved record; the warnings name what was not done."]
    return result
