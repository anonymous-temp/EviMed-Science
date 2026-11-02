"""Two refusals: a request that carries more than a task, and a harness that carries more than process.

`assert_request_clean` is the check every broker request passes before it is written: it names the keys a request may have and refuses
anything that could carry a gold answer, a rubric or a score. It is stricter than the broker's own validation (which refuses by key name
at any depth); the broker's check stays the last line, this one is the first.

`TreeGuard` is the validator behind `adapter.validate_tree`. The trees Harness2 produces are carried into later tasks of the same domain
as examples and, after the round, read by the lead when a candidate is distilled; a tree that contains a task's wording, its numbers or the
names of its data has stopped being process text. Three tests, all decidable:

  * a long verbatim stretch of any development prompt of the domain (60 squashed characters: letters and digits, case folded),
  * more numerals than a handful (list markers and step numbers excluded),
  * the name of a data set, a file, a trial, a paper or a task id that a prompt of the domain mentions.

The error text names what was found, so the editor can fix it in place; it never contains anything the editor has not already been shown.
"""

from __future__ import annotations

import re
from typing import Iterable, Mapping

from .errors import ContaminationRefused

REQUEST_KEYS = {"rid", "image", "item", "probe"}
ITEM_KEYS = {
    "key", "bench", "id", "group", "prompt", "line", "timeoutMin", "files", "deleteGroupAfter", "keepRuntime", "collect",
    "groupSkill", "settleSeconds", "timeBudgetMinutes",
}
PROBE_KEYS = {"preamble", "line"}
FILE_KEYS = {"src", "dest"}
SKILL_KEYS = {"title", "description", "instructions"}

# The same names the broker refuses, compared the same way (lower-cased, letters and digits only).
FORBIDDEN_KEY_PARTS = ("gold", "rubric", "answerkey", "idealanswer", "groundtruth", "criteria", "checklist", "reference", "verdict", "judge")
FORBIDDEN_KEYS_EXACT = {"ideal", "score", "scores", "scoring", "scorer", "answer", "expectinanswer", "expected", "label", "labels"}
FORBIDDEN_PATH_PARTS = ("rcb_judge", "heldout", "held_out", "criteria", "checklist", "target_study", "capsulenotebook", "ground_truth", "gold")

# Upstream's own tripwire strings (harness2.core.context.GRADER_VERDICT_MARKERS), repeated so this module needs no upstream import.
GRADER_MARKERS = (
    "deterministic_eval_summary", "deterministic_eval_result", "judge_scope_and_deterministic_status",
    "Judge findings on the rendered result", '"passed_count"', '"pass_rate"', '"test_pass_rate"',
)


def _norm(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(key).lower())


def _walk_keys(value, path="$"):
    if isinstance(value, dict):
        for key, inner in value.items():
            yield f"{path}.{key}", key
            yield from _walk_keys(inner, f"{path}.{key}")
    elif isinstance(value, list):
        for index, inner in enumerate(value):
            yield from _walk_keys(inner, f"{path}[{index}]")


def _walk_strings(value, path="$"):
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, dict):
        for key, inner in value.items():
            yield from _walk_strings(inner, f"{path}.{key}")
    elif isinstance(value, list):
        for index, inner in enumerate(value):
            yield from _walk_strings(inner, f"{path}[{index}]")


def assert_request_clean(request: Mapping) -> None:
    """Raise ContaminationRefused unless the request is exactly a task, a route and (for a probe) a harness."""
    if not isinstance(request, Mapping):
        raise ContaminationRefused("a request is an object")
    extra = set(request) - REQUEST_KEYS
    if extra:
        raise ContaminationRefused(f"request has keys a request may not have: {sorted(extra)}")
    item = request.get("item")
    if not isinstance(item, Mapping):
        raise ContaminationRefused("request has no item")
    extra = set(item) - ITEM_KEYS
    if extra:
        raise ContaminationRefused(f"item has keys that are not part of the queue line: {sorted(extra)}")
    probe = request.get("probe")
    if probe is not None:
        if not isinstance(probe, Mapping) or set(probe) - PROBE_KEYS:
            raise ContaminationRefused(f"probe has keys other than {sorted(PROBE_KEYS)}")
    for entry in item.get("files") or []:
        if not isinstance(entry, Mapping) or set(entry) - FILE_KEYS:
            raise ContaminationRefused("item.files entries are {src, dest} only")
        src = str(entry.get("src", "")).lower()
        for part in FORBIDDEN_PATH_PARTS:
            if part in src:
                raise ContaminationRefused(f"item.files names a path that holds grading material ({part})")
    skill = item.get("groupSkill")
    if skill is not None and (not isinstance(skill, Mapping) or set(skill) != SKILL_KEYS):
        raise ContaminationRefused("groupSkill is {title, description, instructions}")
    for path, key in _walk_keys(request):
        norm = _norm(key)
        if norm in FORBIDDEN_KEYS_EXACT or any(part in norm for part in FORBIDDEN_KEY_PARTS):
            raise ContaminationRefused(f"a request must not carry an answer, a rubric or a score ({path})")
    for path, text in _walk_strings(request):
        for marker in GRADER_MARKERS:
            if marker in text:
                raise ContaminationRefused(f"grader output would enter a request ({path} contains {marker!r})")


# --------------------------------------------------------------------------------------------------------------------------------


def squash(text: str) -> tuple[str, list[int]]:
    """Case-folded letters and digits only, with the offset of every kept character in the original."""
    kept, where = [], []
    for index, char in enumerate(text):
        if char.isalnum():
            kept.append(char.lower())
            where.append(index)
    return "".join(kept), where


_LIST_MARKER = re.compile(r"^[ \t]*(?:[-*+][ \t]+)?(?:\(?\d{1,2}[.):])[ \t]+", re.M)
_NUMERAL = re.compile(r"(?<![A-Za-z_])\d+(?:[.,]\d+)*")
_PATTERNS = {
    "a trial id": re.compile(r"NCT\d{8}", re.I),
    "an arXiv id": re.compile(r"\b\d{4}\.\d{4,5}(?:v\d+)?\b"),
    "a task id": re.compile(r"\b(?:bix-\d+|deep-\d+|wide-\d+|[A-Z][a-z]+_\d{3})\b"),
    "a UUID": re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"),
}
BENCHMARK_NAMES = (
    "MedCalc-Bench", "BixBench", "ResearchClawBench", "DeepResearch Bench", "AutoResearchBench", "MedBrowseComp",
    "BioXArena", "HuggingFace datasets", "Row Number", "Ground Truth",
)


class TreeGuard:
    def __init__(self, prompts: Iterable[str], names: Iterable[str] = (), *, max_numerals: int = 12, window: int = 60, sample: int = 3):
        self.window, self.sample, self.max_numerals = window, sample, max_numerals
        self._hashes: set[int] = set()
        n_prompts = 0
        for prompt in prompts:
            n_prompts += 1
            squashed, _ = squash(prompt)
            for start in range(0, max(0, len(squashed) - window + 1)):
                h = hash(squashed[start:start + window])
                if h % sample == 0:
                    self._hashes.add(h)
        self.n_prompts = n_prompts
        self.names = sorted({n.strip() for n in list(names) + list(BENCHMARK_NAMES) if len(squash(n.strip())[0]) >= 5}, key=str.lower)
        self._squashed_names = [(n, squash(n)[0]) for n in self.names]

    def long_matches(self, text: str) -> list[str]:
        squashed, where = squash(text)
        spans: list[tuple[int, int]] = []
        for start in range(0, max(0, len(squashed) - self.window + 1)):
            h = hash(squashed[start:start + self.window])
            if h % self.sample == 0 and h in self._hashes:
                if spans and start <= spans[-1][1]:
                    spans[-1] = (spans[-1][0], start + self.window)
                else:
                    spans.append((start, start + self.window))
        out = []
        for lo, hi in spans[:3]:
            a, b = where[lo], where[min(hi, len(where)) - 1] + 1
            out.append(" ".join(text[a:b].split())[:100])
        return out

    def numerals(self, text: str) -> list[str]:
        body = _LIST_MARKER.sub("", text)
        body = re.sub(r"^---\n.*?\n---\n", "", body, flags=re.S)  # frontmatter
        return _NUMERAL.findall(body)

    def named(self, text: str) -> list[str]:
        squashed, _ = squash(text)
        found = [n for n, s in self._squashed_names if s and s in squashed]
        for label, pattern in _PATTERNS.items():
            hit = pattern.search(text)
            if hit:
                found.append(f"{label} ({hit.group(0)})")
        return found

    def problems(self, tree: Mapping[str, str]) -> list[str]:
        out: list[str] = []
        all_numerals: list[str] = []
        for rel in sorted(tree):
            text = str(tree[rel])
            for snippet in self.long_matches(text):
                out.append(f"{rel} repeats a stretch of a task's own wording (\"{snippet}…\"); describe the procedure in your own words instead")
            for name in self.named(text):
                out.append(f"{rel} names {name}; a harness must not name a data set, file, trial, paper or task")
            all_numerals += self.numerals(text)
        if len(all_numerals) > self.max_numerals:
            shown = ", ".join(all_numerals[:8])
            out.append(
                f"the harness has {len(all_numerals)} numerals ({shown} …), over the allowance of {self.max_numerals}; "
                f"keep numbers out of process text unless a rule truly needs one (list markers do not count)"
            )
        return out

    def check(self, tree: Mapping[str, str]) -> None:
        found = self.problems(tree)
        if found:
            raise ValueError(" | ".join(found))
