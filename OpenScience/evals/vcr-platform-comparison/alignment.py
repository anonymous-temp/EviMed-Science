"""Label-blind alignment of platform clauses to frozen source annotation spans.

Only literal source geometry decides alignment. Splitting a conjunction does not
license copying the parent's truth value onto its children. Unresolved mappings
remain in the coverage ledger, outside the conditional accuracy denominator.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re
import unicodedata

POLICY_PATH = Path(__file__).with_name("alignment-policy.json")
POLICY_BYTES = POLICY_PATH.read_bytes()
POLICY = json.loads(POLICY_BYTES)
POLICY_DIGEST = hashlib.sha256(POLICY_BYTES).hexdigest()
SIGNIFICANT = re.compile(
    r"[-+−]?\d+(?:[.,]\d+)*|<=|>=|[<>≤≥=−]|\b(?:and|or|not|no|without|"
    r"except|unless|either|neither|nor|before|after|within)\b", re.I
)
IDENTITY = ("patient_id", "trial_id", "criterion_type", "source_id", "source_version")
GEOMETRY = ("id", *IDENTITY, "text", "start", "end")
LABELS = {
    "inclusion": {"included", "not included", "not applicable", "not enough information"},
    "exclusion": {"excluded", "not excluded", "not applicable", "not enough information"},
}


def fingerprint(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":")).encode()).hexdigest()


def geometry(units: list[dict]) -> list[dict]:
    return sorted(({key: unit.get(key) for key in GEOMETRY} for unit in units), key=lambda row: row["id"])


def from_utf16_span(text: str, start: int, end: int) -> tuple[int, int]:
    """Convert JavaScript offsets explicitly; reject positions inside a surrogate pair."""
    encoded = text.encode("utf-16-le")
    if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(encoded) // 2:
        raise ValueError("Invalid UTF-16 source span")
    try:
        return len(encoded[:start * 2].decode("utf-16-le")), len(encoded[:end * 2].decode("utf-16-le"))
    except UnicodeDecodeError as error:
        raise ValueError("Source span bisects a surrogate pair") from error


def normalized(text: str) -> tuple[str, list[tuple[int, int]]]:
    """Preserve original offsets; normalize each character and collapse whitespace."""
    chars, offsets = [], []
    for index, raw in enumerate(text):
        for char in unicodedata.normalize("NFKC", raw):
            if char.isspace():
                if chars and chars[-1] == " ":
                    offsets[-1] = (offsets[-1][0], index + 1)
                elif chars:
                    chars.append(" ")
                    offsets.append((index, index + 1))
            else:
                chars.append(char)
                offsets.append((index, index + 1))
    if chars and chars[-1] == " ":
        chars.pop()
        offsets.pop()
    return "".join(chars), offsets


def identity(unit: dict) -> tuple:
    return tuple(unit.get(key) for key in IDENTITY)


def whole_token_edges(text: str, start: int, end: int) -> bool:
    def word(char: str) -> bool:
        return char.isalnum() or char == "_" or unicodedata.category(char).startswith("M")
    if start and word(text[start]) and word(text[start - 1]):
        return False
    if end < len(text) and word(text[end - 1]) and word(text[end]):
        return False
    # Do not cut off the prefix in non-active / non-small-cell constructions.
    def connector(char: str) -> bool:
        return unicodedata.category(char) == "Pd" or char in "−'’"
    if start >= 2 and connector(text[start - 1]) and word(text[start - 2]) and word(text[start]):
        return False
    if end + 1 < len(text) and connector(text[end]) and word(text[end - 1]) and word(text[end + 1]):
        return False
    operators = set("-+−<>=≤≥±≠~≈×*/^")
    numeric = lambda char: char.isdecimal() or unicodedata.normalize("NFKC", char) in operators
    if start and numeric(text[start]) and (connector(text[start - 1])
                                         or unicodedata.normalize("NFKC", text[start - 1]) in operators):
        return False
    if start >= 2 and text[start].isdecimal() and text[start - 1] in ".," and text[start - 2].isdecimal():
        return False
    if end < len(text) and numeric(text[end - 1]) and unicodedata.normalize("NFKC", text[end]) in operators:
        return False
    if end + 1 < len(text) and text[end - 1].isdecimal() and text[end] in ".," and text[end + 1].isdecimal():
        return False
    return True


def anchor(unit: dict, sources: dict) -> dict:
    source = sources.get((unit.get("source_id"), unit.get("source_version")))
    if source is None:
        return {"status": "source_unlocated", "reason": "source_version_missing"}
    if (source.get("trial_id"), source.get("criterion_type")) != (
        unit.get("trial_id"), unit.get("criterion_type")
    ):
        return {"status": "source_unlocated", "reason": "source_identity_mismatch"}
    quote, _ = normalized(unit["text"])
    if not quote:
        return {"status": "source_unlocated", "reason": "empty_fragment"}
    text = source["text"]
    section_start, section_end = source.get("section_start", 0), source.get("section_end", len(text))
    if (type(section_start) is not int or type(section_end) is not int
            or not 0 <= section_start <= section_end <= len(text)):
        raise ValueError("Invalid source section boundaries")
    canonical, positions = normalized(text)
    start, end = unit.get("start"), unit.get("end")
    if start is not None or end is not None:
        if (type(start) is not int or type(end) is not int
                or not 0 <= start < end <= len(text)
                or start < section_start or end > section_end
                or normalized(text[start:end])[0] != quote):
            return {"status": "source_unlocated", "reason": "invalid_locator"}
        # Canonical coordinates avoid whitespace differences changing coverage.
        selected = [i for i, (a, b) in enumerate(positions) if a >= start and b <= end]
        if not selected:
            return {"status": "source_unlocated", "reason": "empty_locator"}
        while selected and canonical[selected[0]].isspace():
            selected.pop(0)
        while selected and canonical[selected[-1]].isspace():
            selected.pop()
        if not selected:
            return {"status": "source_unlocated", "reason": "empty_locator"}
        span = (selected[0], selected[-1] + 1)
        if canonical[span[0]:span[1]] != quote:
            return {"status": "source_unlocated", "reason": "invalid_locator"}
    else:
        hits, at = [], 0
        while (at := canonical.find(quote, at)) >= 0:
            stop = at + len(quote)
            # A substring inside one NFKC expansion is not an original fragment.
            if (normalized(text[positions[at][0]:positions[stop - 1][1]])[0] == quote
                    and positions[at][0] >= section_start and positions[stop - 1][1] <= section_end
                    and whole_token_edges(text, positions[at][0], positions[stop - 1][1])):
                hits.append(at)
            at += 1
            if len(hits) > 1:
                return {"status": "ambiguous_overlap", "reason": "repeated_fragment"}
        if not hits:
            return {"status": "source_unlocated", "reason": "fragment_not_literal"}
        span = (hits[0], hits[0] + len(quote))
    if not whole_token_edges(text, positions[span[0]][0], positions[span[1] - 1][1]):
        return {"status": "source_unlocated", "reason": "fragment_cuts_word"}
    return {"status": "located", "span": span, "quote": quote,
            "original_span": (positions[span[0]][0], positions[span[1] - 1][1])}


def significant(text: str) -> tuple[str, ...]:
    return tuple(match.group().casefold() for match in SIGNIFICANT.finditer(text))


def intersection(left: tuple, right: tuple) -> int:
    return max(0, min(left[1], right[1]) - max(left[0], right[0]))


def union_length(spans: list[tuple[int, int]]) -> int:
    total, end = 0, -1
    for start, stop in sorted(spans):
        total += max(0, stop - max(start, end))
        end = max(end, stop)
    return total


def harmless_boundaries(text: str, left: tuple, right: tuple) -> bool:
    overlap_start, overlap_end = max(left[0], right[0]), min(left[1], right[1])
    residual = text[min(left[0], right[0]):overlap_start] + text[overlap_end:max(left[1], right[1])]
    return all(char.isspace() or char in ".,;:()[]{}\"'" for char in residual)


def align(payload: dict) -> dict:
    sources = {}
    for source in payload["sources"]:
        key = (source["id"], source["version"])
        if (key in sources or not isinstance(source.get("text"), str)
                or any(not isinstance(source.get(k), str) or not source[k]
                       for k in ("id", "version", "trial_id", "criterion_type"))):
            raise ValueError("Sources require unique versioned IDs and literal text")
        sources[key] = source
    gold, predicted = payload["gold_units"], payload["platform_units"]
    for units in (gold, predicted):
        if any(not isinstance(unit, dict) or not isinstance(unit.get("id"), str)
               or not unit["id"] or not isinstance(unit.get("text"), str) for unit in units):
            raise ValueError("Clause IDs and literal texts must be strings")
        if len({unit["id"] for unit in units}) != len(units):
            raise ValueError("Clause IDs must be unique within each side")
        if any(any(not isinstance(unit.get(key), str) or not unit[key] for key in IDENTITY)
               or unit["criterion_type"] not in LABELS for unit in units):
            raise ValueError("Every clause requires complete patient/trial/source ownership")
    located = [(unit, anchor(unit, sources)) for unit in predicted]
    rows = []
    for unit in gold:
        ref = anchor(unit, sources)
        row = {"gold_id": unit["id"], "status": ref["status"], "platform_ids": []}
        if ref["status"] != "located":
            rows.append({**row, "reason": ref["reason"]})
            continue
        g = ref["span"]
        source_text = normalized(sources[(unit["source_id"], unit["source_version"])]["text"])[0]
        relevant = [(p, a) for p, a in located if identity(p) == identity(unit)
                    and a["status"] == "located" and intersection(g, a["span"]) > 0]
        matches, exact = [], []
        for prediction, found in relevant:
            p = found["span"]
            overlap = intersection(g, p)
            coverage, precision = overlap / (g[1] - g[0]), overlap / (p[1] - p[0])
            if g == p:
                exact.append((prediction, found, coverage, precision))
            if (coverage >= POLICY["minimum_gold_coverage"]
                    and precision >= POLICY["minimum_prediction_precision"]
                    and harmless_boundaries(source_text, g, p)
                    and significant(ref["quote"]) == significant(found["quote"])):
                matches.append((prediction, found, coverage, precision))
        candidates = exact or matches
        if len(candidates) == 1:
            prediction, found, coverage, precision = candidates[0]
            row.update(status="aligned", platform_ids=[prediction["id"]],
                       alignment_kind="exact" if g == found["span"] else "overlap",
                       gold_span=ref["original_span"], platform_span=found["original_span"],
                       gold_coverage=coverage, prediction_precision=precision)
        elif len(candidates) > 1:
            row.update(status="ambiguous_overlap", platform_ids=[p[0]["id"] for p in candidates])
        else:
            fragments = [(max(g[0], a["span"][0]), min(g[1], a["span"][1]))
                         for _, a in relevant]
            covered = union_length(fragments) / (g[1] - g[0])
            row.update(status="no_overlap", platform_ids=[p["id"] for p, _ in relevant],
                       gold_coverage=covered)
            if any(a["span"][0] <= g[0] and a["span"][1] >= g[1] for _, a in relevant):
                row["status"] = "merged_unresolved"
            elif len(relevant) > 1 and covered >= POLICY["minimum_gold_coverage"]:
                row["status"] = "split_unresolved"
            elif relevant:
                row["status"] = "partial_overlap"
        rows.append(row)
    # Never reuse one aggregate answer as the answers to distinct gold clauses.
    owners = defaultdict(list)
    for row in rows:
        if row["status"] == "aligned":
            owners[row["platform_ids"][0]].append(row)
    for held in owners.values():
        if len(held) > 1:
            exact = [row for row in held if row["alignment_kind"] == "exact"]
            for row in held:
                if len(exact) != 1 or row is not exact[0]:
                    row["status"] = "merged_unresolved"
    counts = Counter(row["status"] for row in rows)
    platform_rows = []
    for unit, found in located:
        related = [row for row in rows if unit["id"] in row["platform_ids"]]
        platform_rows.append({"id": unit["id"], "gold_ids": [row["gold_id"] for row in related],
                              "status": "aligned" if any(row["status"] == "aligned" for row in related)
                              else "unresolved_overlap" if related else "unmatched" if found["status"] == "located"
                              else found["status"]})
    return {"policy": POLICY, "policy_sha256": POLICY_DIGEST,
            "implementation_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "sources_sha256": fingerprint(payload["sources"]),
            "gold_geometry_sha256": fingerprint(geometry(gold)),
            "platform_geometry_sha256": fingerprint(geometry(predicted)),
            "total": len(gold), "scorable": counts["aligned"],
            "coverage": counts["aligned"] / len(gold) if gold else None,
            "buckets": dict(counts), "rows": rows, "platform_rows": platform_rows,
            "platform_buckets": dict(Counter(row["status"] for row in platform_rows)),
            "unlocated_platform": [{"id": p["id"], **a} for p, a in located if a["status"] != "located"]}


def native_label(unit: dict) -> str | None:
    """Convert a final eligibility requirement; exclusion is already inverted."""
    if unit.get("applicable") is False:
        return "not applicable"
    if unit.get("applicable") is not True:
        return None
    state, kind = unit.get("state"), unit.get("criterion_type")
    if state in ("unknown", "pending_recheck"):
        return "not enough information"
    if kind not in ("inclusion", "exclusion") or state not in ("satisfied", "not_satisfied"):
        return None
    labels = ("included", "not included") if kind == "inclusion" else ("not excluded", "excluded")
    return labels[state == "not_satisfied"]


def score_aligned(report: dict, platform: list[dict], targets: dict) -> dict:
    """Gold labels enter only after geometry is frozen; missing answers still count."""
    if fingerprint(geometry(platform)) != report.get("platform_geometry_sha256"):
        raise ValueError("Prediction geometry changed after alignment")
    if POLICY_DIGEST != report.get("policy_sha256") or hashlib.sha256(POLICY_PATH.read_bytes()).hexdigest() != POLICY_DIGEST:
        raise ValueError("Alignment policy changed before scoring")
    by_id = {unit["id"]: unit for unit in platform}
    scorable = [row for row in report["rows"] if row["status"] == "aligned"]
    correct, missing = 0, 0
    for row in scorable:
        actual = targets[row["gold_id"]]
        unit = by_id[row["platform_ids"][0]]
        if not isinstance(actual, str) or actual not in LABELS[unit["criterion_type"]]:
            raise ValueError("Invalid criterion-specific reference label")
        answer = native_label(unit)
        correct += answer is not None and answer == actual
        missing += answer is None
    return {"total": report["total"], "scorable": len(scorable), "correct": correct,
            "accuracy_on_scorable": correct / len(scorable) if scorable else None,
            "alignment_coverage": report["coverage"], "missing_answers_on_aligned": missing,
            "unresolved": report["total"] - len(scorable),
            "unresolved_is_incorrect": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    output = json.dumps(align(json.loads(args.input.read_text())), ensure_ascii=False, indent=2) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as handle:
        handle.write(output)
