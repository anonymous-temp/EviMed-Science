"""Two refusals: a request that carries more than a task, and a harness that carries more than process.

`assert_request_clean` is the check every broker request passes before it is written: it names the keys a request may have and refuses
anything that could carry a gold answer, a rubric or a score. It is stricter than the broker's own validation (which refuses by key name
at any depth); the broker's check stays the last line, this one is the first.

`TreeGuard` is the validator behind `adapter.validate_tree`. The trees Harness2 produces are carried into later tasks of the same domain
as examples and, after the round, read by the lead when a candidate is distilled; a tree that contains a task's wording, its numbers or the
names of its data has stopped being process text. Three tests, all decidable:

  * a long verbatim stretch of any development prompt of the domain (60 squashed characters: letters and digits, case folded),
  * more numerals than a handful (list markers and step numbers excluded),
  * the name of a data set, a file, a trial, a paper or a task id that a prompt of the domain mentions. What counts as a name is
    decided in code from data, never from a list of words: a candidate is a name when it is distinctive by shape (a digit, a joined or
    dotted compound, capitals inside it) or, when it is a plain word, when it is rare in the domain's own task texts and in the
    platform's own prose (its skill library). A plain word that those texts use freely is vocabulary: "count" and "rules" are the stems
    of data files in some tasks and ordinary words everywhere, and a tree that says "count the rows" has not named a data set.

The error text names what was found, so the editor can fix it in place; it never contains anything the editor has not already been shown.
"""

from __future__ import annotations

import re
from pathlib import Path
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


# A plain word that this many task texts of the domain use (or this share of them, whichever is larger) is vocabulary there; so is
# one that this many documents of the platform's own prose (SKILL.md files) use.
ORDINARY_MIN_TASKS = 3
ORDINARY_SHARE = 0.03
ORDINARY_MIN_DOCUMENTS = 5
_JOINED = re.compile(r"[A-Za-z0-9][_\-./][A-Za-z0-9]")
_ASCII_WORD = re.compile(r"[A-Za-z]+")


def has_name_shape(candidate: str) -> bool:
    """Distinctive by shape alone: a digit, two parts joined by `_ - . /` (a file name, an accession), or two capitals (TASK, MedCalc).
    A word in capitals only at its start ("Count") and a word in no case (Chinese) have no shape."""
    text = candidate.strip()
    if any(char.isdigit() for char in text):
        return True
    if _JOINED.search(text):
        return True
    return sum(char.isupper() for char in text) >= 2


def platform_prose(openscience_root: Path) -> list[str]:
    """The platform's own prose, as reference text for what is ordinary: every SKILL.md under the skill roots of the tree. An absent
    root contributes nothing (a sparse checkout, a test), and the guard then judges by the domain's task texts alone."""
    texts: list[str] = []
    for sub in ("runtime/skills", "capability-skills", "capabilities"):
        root = Path(openscience_root) / sub
        if root.is_dir():
            for path in sorted(root.rglob("SKILL.md")):
                try:
                    texts.append(path.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError):
                    continue
    return texts


def candidate_names(tasks: Iterable) -> list[str]:
    """The names a harness must not repeat, as the tasks of a domain offer them: task ids, the files they ship (the whole name and its
    stem) and the UUIDs in their facts. A stem that is a plain word and the stem of files in two or more tasks is the generic name of a
    kind of file (counts, metadata, rules), not the name of a data set, and is left out here; whether the rest are names is
    `TreeGuard`'s decision (shape or rarity)."""
    tasks = list(tasks)
    stems: dict[str, set[str]] = {}
    names: set[str] = set()
    for task in tasks:
        if len(task.id) >= 6 and not task.id.isdigit():
            names.add(task.id)
        for entry in task.files:
            base = Path(entry["dest"]).name
            names.add(base)
            stems.setdefault(base.split(".")[0], set()).add(task.id)
        uuid = task.facts.get("uuid")
        if uuid:
            names.add(uuid)
    for stem, owners in stems.items():
        if len(owners) < 2 or has_name_shape(stem):
            names.add(stem)
    return sorted(n for n in names if len(n) >= 5)


class TreeGuard:
    def __init__(self, prompts: Iterable[str], names: Iterable[str] = (), *, max_numerals: int = 12, window: int = 60, sample: int = 3,
                 reference: Iterable[str] = ()):
        self.window, self.sample, self.max_numerals = window, sample, max_numerals
        self._hashes: set[int] = set()
        squashed_prompts: list[str] = []
        for prompt in prompts:
            squashed, _ = squash(prompt)
            squashed_prompts.append(squashed)
            for start in range(0, max(0, len(squashed) - window + 1)):
                h = hash(squashed[start:start + window])
                if h % sample == 0:
                    self._hashes.add(h)
        self.n_prompts = len(squashed_prompts)
        squashed_reference = [squash(text)[0] for text in reference]
        ordinary_at = max(ORDINARY_MIN_TASKS, ORDINARY_SHARE * self.n_prompts)
        self.names, self.vocabulary = [], []
        for name in sorted({n.strip() for n in names if len(squash(n.strip())[0]) >= 5}, key=str.lower):
            squashed_name = squash(name)[0]
            if has_name_shape(name):
                self.names.append(name)
                continue
            tasks_using = sum(1 for text in squashed_prompts if squashed_name in text)
            documents_using = sum(1 for text in squashed_reference if squashed_name in text)
            if tasks_using < ordinary_at and documents_using < ORDINARY_MIN_DOCUMENTS:
                self.names.append(name)
            else:
                self.vocabulary.append(name)  # kept for the audit: what was not taken for a name
        for name in BENCHMARK_NAMES:
            if len(squash(name)[0]) >= 5 and name not in self.names:
                self.names.append(name)
        self.names.sort(key=str.lower)
        # Shape names match squashed (any spacing or punctuation of the same letters); a plain ASCII word matches as a whole word only,
        # so a rare stem is not found inside "account" or "discount".
        self._squashed_names = [(n, squash(n)[0], None if has_name_shape(n) or not _ASCII_WORD.fullmatch(n) or n in BENCHMARK_NAMES
                                 else re.compile(rf"(?<![A-Za-z0-9]){re.escape(n)}(?![A-Za-z0-9])", re.I)) for n in self.names]

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
        found = [n for n, s, word in self._squashed_names if s and (word.search(text) if word else s in squashed)]
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
