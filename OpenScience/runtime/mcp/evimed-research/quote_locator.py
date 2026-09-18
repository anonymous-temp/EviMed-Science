"""Find a quotation inside a preserved source, the way the delivery gate reads it.

Hidden knowledge: this is the second implementation of one rule, and the rule
is not ours to change here. The delivery gate decides whether a claim's
`supportQuote` is in the preserved file it names with `quoteIsPresent` in
`packages/domain/src/clinicalEvidence.mjs`. A run that wanted to know the
answer before submitting wrote its own `verify_quotes.py` — 21 grep/sed calls
in one measured run — and got a *different* answer, because the gate forgives
smart quotes, dash widths, line wraps, case, PDF hyphenation, inline citation
markers and spaced-out CJK, and a grep forgives none of it. The run then
"fixed" quotes the gate had already accepted, or kept quotes it would refuse.

So this module ports the gate's comparison literally — every regular
expression below is the domain's, translated, with the JavaScript semantics
that differ from Python's spelled out where they matter (`\\s`, `\\d`, `trim`,
`$`, and the UTF-16 view of word boundaries). The fixture file
`packages/domain/test/fixtures/quote-normalization.json` is read by a test on
both sides; a change to the domain's normalisation that is not mirrored here
turns one of them red. The version string `evimed-quote-v1` names this
agreement, and a tool result carries it so a reader can tell which rule
answered.

What this adds over the gate is *where*: offsets into the original text, a
context window a run can copy from, and — when the quote is not there — the
nearest passages, so the repair is "copy what the source says" rather than
"search again". A near passage is a hint, never a verdict: `found` is true only
for a match the gate itself would accept.

Standard library only: the runtime image is rebuilt as a delta that copies
these sources over a base whose Python dependencies are fixed.
"""

from __future__ import annotations

import array
import bisect
import difflib
import hashlib
import os
import re
import stat
import unicodedata
from functools import lru_cache
from pathlib import PurePosixPath

import drug_label_index

NORMALIZATION = "evimed-quote-v1"
SOURCES_DIR = ".evimed-sources"
MAX_SOURCE_BYTES = 16 * 1024 * 1024
MAX_QUOTE_CHARS = 4000
DEFAULT_MAX_RESULTS = 5
MAX_RESULTS = 20
CONTEXT_CHARS = 160
MAX_MATCH_TEXT = 2000
# Below this similarity a "near" passage is noise, not a misquotation of it.
NEAR_MIN_SCORE = 0.6
# Near search compares at most this much of the quote. A claim's quotation is
# one to three sentences; a longer one is compared on its opening, which is
# where a run usually copied from.
NEAR_MAX_NEEDLE = 800
MAX_CAPTURE_VERSIONS = 8


class QuoteLocatorError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


# ---------------------------------------------------------------------------
# JavaScript's character classes, spelled out.
#
# `\s` in JavaScript is WhiteSpace plus LineTerminator: it does NOT include
# U+001C..U+001F or U+0085, which Python's `\s` and `str.strip()` do. `\d` in
# JavaScript is ASCII only, even under the `u` flag; Python's `\d` matches every
# decimal digit. Each pattern below uses these instead of the Python escapes.
# ---------------------------------------------------------------------------
_WS = r"\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_WS_CHARS = "\t\n\v\f\r \u00a0\u1680" + "".join(chr(c) for c in range(0x2000, 0x200B)) + "\u2028\u2029\u202f\u205f\u3000\ufeff"
_D = "0-9"

# `\p{Script=Han|Hiragana|Katakana|Hangul}` on the BMP, read from V8 (Node 22,
# ICU 78) rather than typed from Scripts.txt. Only the BMP matters: the gate
# tests single UTF-16 code units at a match boundary, so an astral character
# never counts as a word character there (see `_joined`).
_CONTINUOUS_RANGES = (
    (0x1100, 0x11FF), (0x2E80, 0x2E99), (0x2E9B, 0x2EF3), (0x2F00, 0x2FD5), (0x3005, 0x3005),
    (0x3007, 0x3007), (0x3021, 0x3029), (0x302E, 0x302F), (0x3038, 0x303B), (0x3041, 0x3096),
    (0x309D, 0x309F), (0x30A1, 0x30FA), (0x30FD, 0x30FF), (0x3131, 0x318E), (0x31F0, 0x321E),
    (0x3260, 0x327E), (0x32D0, 0x32FE), (0x3300, 0x3357), (0x3400, 0x4DBF), (0x4E00, 0x9FFF),
    (0xA960, 0xA97C), (0xAC00, 0xD7A3), (0xD7B0, 0xD7C6), (0xD7CB, 0xD7FB), (0xF900, 0xFA6D),
    (0xFA70, 0xFAD9), (0xFF66, 0xFF6F), (0xFF71, 0xFF9D), (0xFFA0, 0xFFBE), (0xFFC2, 0xFFC7),
    (0xFFCA, 0xFFCF), (0xFFD2, 0xFFD7), (0xFFDA, 0xFFDC),
)
_CONTINUOUS_STARTS = [start for start, _ in _CONTINUOUS_RANGES]


def _continuous(character: str) -> bool:
    point = ord(character)
    index = bisect.bisect_right(_CONTINUOUS_STARTS, point) - 1
    return index >= 0 and point <= _CONTINUOUS_RANGES[index][1]


def _word(character: str) -> bool:
    return character == "_" or unicodedata.category(character)[0] in "LMN"


def _joined(character: str) -> bool:
    """The gate's `joinedWordCharacter`, seen through JavaScript's UTF-16.

    `source[start - 1]` in JavaScript is a code unit: for an astral character
    it is half a surrogate pair, which no `\\p{...}` class matches. So an
    astral character is never a joined word character at a boundary, and
    Python — which sees the whole code point — must say the same."""
    return ord(character) <= 0xFFFF and _word(character) and not _continuous(character)


def _class_from(points) -> str:
    """A regular-expression character class over sorted code points."""
    parts = []
    run_start = previous = None
    for point in points:
        if previous is not None and point == previous + 1:
            previous = point
            continue
        if run_start is not None:
            parts.append((run_start, previous))
        run_start = previous = point
    if run_start is not None:
        parts.append((run_start, previous))
    body = "".join(
        ("\\U%08x" % start) if start == end else ("\\U%08x-\\U%08x" % (start, end))
        for start, end in parts
    )
    return "[" + body + "]"


class _Tables:
    """Unicode facts Python's `re` has no syntax for, computed once.

    `\\p{L}` has no spelling in the standard library's `re`, and the NFKC
    offset map below needs to know which characters normalisation can touch.
    Both come from one pass over the assigned planes (about 0.1 s)."""

    def __init__(self):
        letters = []
        affected = []
        trailers = set(range(0x1161, 0x1176)) | set(range(0x11A8, 0x11C3))
        category = unicodedata.category
        normalize = unicodedata.normalize
        combining = unicodedata.combining
        points = list(range(0, 0x40000)) + list(range(0xE0000, 0xE1000))
        for point in points:
            decomposition = unicodedata.decomposition(chr(point))
            if decomposition and not decomposition.startswith("<"):
                parts = decomposition.split()
                if len(parts) == 2:
                    trailers.add(int(parts[1], 16))
        self.trailers = frozenset(trailers)
        for point in points:
            character = chr(point)
            kind = category(character)
            if kind[0] == "L":
                letters.append(point)
            if kind in ("Cn", "Cs", "Co"):
                continue
            if normalize("NFKC", character) != character or not self.safe(character):
                affected.append(point)
        self.letter = _class_from(letters)
        # Most characters NFKC changes are a safe starter that becomes exactly
        # one other character (full-width punctuation, a no-break space).
        # Those go through `str.translate` with their positions unchanged; only
        # the rest — combining sequences, ligatures, compatibility expansions —
        # need the chunk-by-chunk path. Chinese full text has tens of
        # thousands of the first kind per megabyte and almost none of the second.
        self.one_to_one = {}
        rest = []
        for point in affected:
            character = chr(point)
            expanded = normalize("NFKC", character)
            if len(expanded) == 1 and self.safe(character):
                self.one_to_one[point] = expanded
            else:
                rest.append(point)
        self.affected_run = re.compile(_class_from(rest) + "+")

    def safe(self, character: str) -> bool:
        """Whether normalisation can start fresh at this character.

        A starter that composes with nothing before it, and whose own
        decomposition does not begin with a combining mark (U+0F73 does), is a
        boundary NFKC never looks across."""
        if unicodedata.combining(character) or ord(character) in self.trailers:
            return False
        expanded = unicodedata.normalize("NFKC", character)
        return not expanded or not unicodedata.combining(expanded[0])


@lru_cache(maxsize=1)
def _tables() -> _Tables:
    return _Tables()


@lru_cache(maxsize=1)
def _patterns():
    letter = _tables().letter
    # The domain writes these with a leading lookbehind. Python's engine then
    # tries the whole pattern at every position of a megabyte of text (0.13 s
    # each); starting from the literal and checking the letter behind it finds
    # the same matches in a millisecond.
    return {
        "hyphen_break": re.compile(r"-(?<=%s-)\r?\n[%s]*(?=%s)" % (letter, _WS, letter)),
        "spaced_hyphen": re.compile(r"[ \t](?<=%s[ \t])[ \t]*-[ \t]+(?=%s)" % (letter, letter)),
        "bullet": re.compile(r"(^|\r?\n)[ \t]*[-*+][ \t]+(?=%s)" % letter),
    }


@lru_cache(maxsize=1)
def _lengthening_lower():
    """Characters whose lowercase is longer than one character, from the
    running Python's own tables (U+0130 in current Unicode)."""
    return re.compile(_class_from(
        point for point in range(0x110000)
        if not 0xD800 <= point <= 0xDFFF and len(chr(point).lower()) != 1
    ))


_SUPERSCRIPT_RUN = re.compile("[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+")
_INVISIBLE = re.compile("\u00ad|\u200b|\u200c|\u200d|\ufeff")
_UNIT_MARKS = re.compile("(?<=[%s])[‘’'′“”\"″]+" % _D)
_QUOTE_MARKS = re.compile("[‘’“”\"'＂＇]")
_FRACTION_SLASH = re.compile("[⁄∕]")
_DASH = re.compile("[–—]")
_SPACE_RUN = re.compile("[%s]+" % _WS)
# The same replacement, but only where it changes something: a single ASCII
# space already is what `\s+ -> " "` produces, and a long text has one per word.
_SPACE_RUN_CHANGING = re.compile("[%s]{2,}|[%s]" % (_WS, _WS.replace(" ", "")))
_CJK = "\u3000-\u303f\u4e00-\u9fff\uff00-\uffef"
_CJK_SPACING = re.compile("(?<=[%s])[%s]+(?=[%s])" % (_CJK, _WS, _CJK))
_SPACE_BEFORE_PUNCTUATION = re.compile("[%s]+([.,;:!?。！？])" % _WS)
_QUOTE_ELISION = re.compile(r"[%s]*(?:\.{3,}|…)+[%s]*" % (_WS, _WS))
# A superscript citation rendered inline ("...patients.23 Li et al"). JavaScript's
# `$` without the `m` flag is the end of input; Python's `$` would also match
# before a final newline, so `\Z` it is.
_INLINE_REFERENCE_MARKER = re.compile(r"(?<=[^%s%s][.。!?])[%s]{1,3}(?=[%s]|\Z)" % (_D, _WS, _D, _WS))

_NUMBER_ATOM = (
    r"(?:(?:[<>]=?|!=|[≤≥≠≈≃≅~])[{ws}]*)?"
    r"(?:(?:\+[{ws}]*/[{ws}]*[-−]|[+\-−±])[{ws}]*)?"
    r"(?:[{d}]+(?:[.,][{d}]+)*|[.,][{d}]+)"
    r"(?:e[+\-−]?[{d}]+)?"
    r"(?:[{ws}]*(?:\^|\*\*)[{ws}]*[+\-−]?[{d}]+)?"
    r"(?:[{ws}]*[%‰])?"
    r"(?:[′″]+(?:[{ws}]*[{d}]+(?:[.,][{d}]+)?[′″]+)?)?"
).format(ws=_WS, d=_D)
_NUMBER_TOKEN = re.compile(
    _NUMBER_ATOM
    + r"(?:[{ws}]*(?:\+[{ws}]*/[{ws}]*[-−]|[/–—−:×·*±-]|x(?=[{ws}]*[{d}]))[{ws}]*".format(ws=_WS, d=_D)
    + _NUMBER_ATOM
    + ")*"
)


def _js_trim(value: str) -> str:
    return value.strip(_WS_CHARS)


def _superscript(match) -> str:
    return "^" + unicodedata.normalize("NFKC", match.group(0)).replace("−", "-")


def _unit_marks(marks: str) -> str:
    return "".join("′′" if mark in "“”\"″" else "′" for mark in marks)


def normalize_passage(value) -> str:
    """The domain's `normalizedPassage`, step for step."""
    text = "" if value is None else str(value)
    text = _SUPERSCRIPT_RUN.sub(_superscript, text)
    text = unicodedata.normalize("NFKC", text)
    text = _INVISIBLE.sub("", text)
    text = _UNIT_MARKS.sub(lambda match: _unit_marks(match.group(0)), text)
    text = _QUOTE_MARKS.sub("", text)
    text = _FRACTION_SLASH.sub("/", text)
    text = _DASH.sub("-", text)
    text = _SPACE_RUN.sub(" ", text)
    text = _CJK_SPACING.sub("", text)
    return _js_trim(text).lower()


def _extraction_layout(value: str) -> str:
    patterns = _patterns()
    text = patterns["hyphen_break"].sub("", value)
    text = patterns["spaced_hyphen"].sub("", text)
    return patterns["bullet"].sub(lambda match: match.group(1), text)


def normalize_extraction_passage(value) -> str:
    """The domain's `normalizedExtractionPassage`: layout repair, then the same."""
    text = "" if value is None else str(value)
    return _SPACE_BEFORE_PUNCTUATION.sub(lambda match: match.group(1), normalize_passage(_extraction_layout(text)))


def quote_segments(quote) -> list[str]:
    """A quote split at its marked elisions (… or ...), as the gate splits it."""
    text = "" if quote is None else str(quote)
    return [part for part in (_js_trim(piece) for piece in _QUOTE_ELISION.split(text)) if part]


class _NumericSpans:
    """Where the numbers are, computed only if a candidate match needs a
    boundary checked: a quote that occurs nowhere never pays for the scan."""

    __slots__ = ("haystack", "_starts", "_spans")

    def __init__(self, haystack: str):
        self.haystack = haystack
        self._starts = None
        self._spans = None

    def spans(self):
        if self._spans is None:
            self._spans = [(match.start(), match.end()) for match in _NUMBER_TOKEN.finditer(self.haystack)]
            self._starts = [start for start, _ in self._spans]
        return self._starts, self._spans


def _numeric_spans(haystack: str) -> _NumericSpans:
    return _NumericSpans(haystack)


def _complete_match(source: str, needle: str, start: int, numeric) -> bool:
    """The gate's `completePassageMatch`: no match starts or ends mid-word, and
    none cuts a number in half ("25" is not in "0.25")."""
    end = start + len(needle)
    if start > 0 and _joined(needle[0]) and (
        _joined(source[start - 1])
        or (start > 1 and source[start - 1] == "-" and _joined(source[start - 2]))
    ):
        return False
    if end < len(source) and _joined(needle[-1]) and (
        _joined(source[end])
        or (end + 1 < len(source) and source[end] == "-" and _joined(source[end + 1]))
    ):
        return False
    starts, spans = numeric.spans()
    for boundary in (start, end):
        index = bisect.bisect_right(starts, boundary)
        if index > 0 and spans[index - 1][0] < boundary < spans[index - 1][1]:
            return False
    return True


def _chain_from(haystack: str, needles: list[str], begin: int, numeric):
    """One in-order chain of segment matches whose first segment starts at or
    after `begin`, found the way the gate finds one; None when there is none."""
    positions = []
    cursor = begin
    for needle in needles:
        at = haystack.find(needle, cursor)
        while at >= 0 and not _complete_match(haystack, needle, at, numeric):
            at = haystack.find(needle, at + 1)
        if at < 0:
            return None
        positions.append((at, at + len(needle)))
        cursor = at + len(needle)
    return positions


# The four readings of a preserved text the gate tries, in its order: as
# preserved and with inline citation markers removed, each under the plain and
# the extraction-repair normalisation.
READINGS = ((False, False), (False, True), (True, False), (True, True))


class _Prepared:
    """One preserved text and its readings, computed as they are first needed.

    A run checks many claims against the same full text, so the readings of
    the last texts are kept (`_prepared`) rather than recomputed per call."""

    def __init__(self, source: str):
        self.source = source
        self._stripped = None
        self._haystacks = {}
        self._mapped = {}

    def text(self, marker_free: bool) -> str:
        if not marker_free:
            return self.source
        if self._stripped is None:
            self._stripped = _INLINE_REFERENCE_MARKER.sub("", self.source)
        return self._stripped

    def haystack(self, marker_free: bool, extraction: bool) -> str:
        key = (marker_free, extraction)
        if key not in self._haystacks:
            project = normalize_extraction_passage if extraction else normalize_passage
            self._haystacks[key] = project(self.text(marker_free))
        return self._haystacks[key]

    def mapped(self, marker_free: bool, extraction: bool):
        key = (marker_free, extraction)
        if key not in self._mapped:
            self._mapped[key] = _mapped_pipeline(self.source, marker_free, extraction, self.haystack(marker_free, extraction))
        return self._mapped[key]


# Two, because a megabyte of CJK text with its readings and one offset map is
# about 25 MB, and a run works one source at a time.
@lru_cache(maxsize=2)
def _prepared(source: str) -> _Prepared:
    return _Prepared(source)


def quote_is_present(artifact, quote) -> bool:
    """The domain's `quoteIsPresent`: the verdict the delivery gate reaches."""
    source = "" if artifact is None else str(artifact)
    segments = quote_segments(quote)
    if not source or not segments:
        return False
    prepared = _prepared(source)
    for marker_free, extraction in READINGS:
        project = normalize_extraction_passage if extraction else normalize_passage
        needles = [project(segment) for segment in segments]
        # An empty projected segment fails this reading, not the whole check.
        if not all(needles):
            continue
        haystack = prepared.haystack(marker_free, extraction)
        if _chain_from(haystack, needles, 0, _numeric_spans(haystack)) is not None:
            return True
    return False


# ---------------------------------------------------------------------------
# The same pipeline, carrying a map from every output character back to the
# original text. Kept separate from `normalize_passage` so the verdict stays a
# chain of whole-string substitutions the domain can be read against line by
# line; `_mapped_pipeline` checks at the end that both produced the same text.
# ---------------------------------------------------------------------------
class _Mapped:
    __slots__ = ("text", "starts", "ends")

    def __init__(self, text: str, starts, ends):
        self.text = text
        self.starts = starts
        self.ends = ends

    @classmethod
    def identity(cls, text: str) -> "_Mapped":
        return cls(text, array.array("i", range(len(text))), array.array("i", range(1, len(text) + 1)))


def _msub(mapped: _Mapped, pattern, replace) -> _Mapped:
    """`pattern.sub` over a mapped text. `replace(match)` returns pieces
    `(text, i, j)`: `text` stands for the current characters `[i, j)`."""
    text = mapped.text
    pieces = []
    starts = array.array("i")
    ends = array.array("i")
    last = 0
    changed = False
    for match in pattern.finditer(text):
        changed = True
        a, b = match.span()
        if a > last:
            pieces.append(text[last:a])
            starts.extend(mapped.starts[last:a])
            ends.extend(mapped.ends[last:a])
        for piece, i, j in replace(match):
            if not piece:
                continue
            pieces.append(piece)
            starts.extend([mapped.starts[i]] * len(piece))
            ends.extend([mapped.ends[j - 1]] * len(piece))
        last = b
    if not changed:
        return mapped
    if last < len(text):
        pieces.append(text[last:])
        starts.extend(mapped.starts[last:])
        ends.extend(mapped.ends[last:])
    return _Mapped("".join(pieces), starts, ends)


def _whole(value):
    return lambda match: [(value, match.start(), match.end())]


def _delete(_match):
    return []


def _per_character(convert):
    return lambda match: [(convert(character), match.start() + offset, match.start() + offset + 1)
                          for offset, character in enumerate(match.group(0))]


def _group_one(match):
    return [(match.group(1), match.start(1), match.end(1))] if match.group(1) else []


def _nfkc_mapped(mapped: _Mapped) -> _Mapped:
    if unicodedata.is_normalized("NFKC", mapped.text):
        return mapped
    tables = _tables()
    # Composing `NFKC(x)` with what follows gives `NFKC(x + y)` for a safe
    # starter x, so translating the one-to-one characters first changes no
    # result the chunks below produce.
    text = mapped.text.translate(tables.one_to_one)

    def chunks(match):
        a, b = match.span()
        # A run that opens with a combining mark or a composition trailer
        # composes with the character before it, so that character joins it.
        if a > 0 and not tables.safe(text[a]):
            a -= 1
        output = []
        begin = a
        for index in range(a + 1, b):
            if tables.safe(text[index]):
                output.append((unicodedata.normalize("NFKC", text[begin:index]), begin, index))
                begin = index
        output.append((unicodedata.normalize("NFKC", text[begin:b]), begin, b))
        return output

    # Not `_msub`: a run that composes with the character before it takes that
    # character into its chunk, and that character lies outside the match.
    pieces = []
    starts = array.array("i")
    ends = array.array("i")
    last = 0
    for match in tables.affected_run.finditer(text):
        output = chunks(match)
        first = output[0][1]
        if first > last:
            pieces.append(text[last:first])
            starts.extend(mapped.starts[last:first])
            ends.extend(mapped.ends[last:first])
        for piece, i, j in output:
            if not piece:
                continue
            pieces.append(piece)
            starts.extend([mapped.starts[i]] * len(piece))
            ends.extend([mapped.ends[j - 1]] * len(piece))
        last = match.end()
    if last < len(text):
        pieces.append(text[last:])
        starts.extend(mapped.starts[last:])
        ends.extend(mapped.ends[last:])
    return _Mapped("".join(pieces), starts, ends)


def _lower_mapped(mapped: _Mapped) -> _Mapped:
    lowered = mapped.text.lower()
    if len(lowered) == len(mapped.text):
        return _Mapped(lowered, mapped.starts, mapped.ends)
    # A few characters lengthen when lowercased (U+0130 is the one in current
    # Unicode). The string is still lowered whole — a word-final sigma after
    # one of them depends on it — and only the map steps over the expansions.
    text = mapped.text
    starts = array.array("i")
    ends = array.array("i")
    last = 0
    for match in _lengthening_lower().finditer(text):
        at = match.start()
        starts.extend(mapped.starts[last:at])
        ends.extend(mapped.ends[last:at])
        width = len(text[at].lower())
        starts.extend([mapped.starts[at]] * width)
        ends.extend([mapped.ends[at]] * width)
        last = at + 1
    starts.extend(mapped.starts[last:])
    ends.extend(mapped.ends[last:])
    return _Mapped(lowered, starts, ends)


def _trim_mapped(mapped: _Mapped) -> _Mapped:
    text = mapped.text
    left = len(text) - len(text.lstrip(_WS_CHARS))
    right = len(text.rstrip(_WS_CHARS))
    if left == 0 and right == len(text):
        return mapped
    right = max(right, left)
    return _Mapped(text[left:right], mapped.starts[left:right], mapped.ends[left:right])


def _normalize_mapped(mapped: _Mapped) -> _Mapped:
    mapped = _msub(mapped, _SUPERSCRIPT_RUN, lambda match: [(_superscript(match), match.start(), match.end())])
    mapped = _nfkc_mapped(mapped)
    mapped = _msub(mapped, _INVISIBLE, _delete)
    mapped = _msub(mapped, _UNIT_MARKS, _per_character(lambda mark: _unit_marks(mark)))
    mapped = _msub(mapped, _QUOTE_MARKS, _delete)
    mapped = _msub(mapped, _FRACTION_SLASH, _per_character(lambda _mark: "/"))
    mapped = _msub(mapped, _DASH, _per_character(lambda _mark: "-"))
    mapped = _msub(mapped, _SPACE_RUN_CHANGING, _whole(" "))
    mapped = _msub(mapped, _CJK_SPACING, _delete)
    return _lower_mapped(_trim_mapped(mapped))


def _mapped_pipeline(source: str, marker_free: bool, extraction: bool, expected: str) -> _Mapped | None:
    mapped = _Mapped.identity(source)
    if marker_free:
        mapped = _msub(mapped, _INLINE_REFERENCE_MARKER, _delete)
    if extraction:
        patterns = _patterns()
        mapped = _msub(mapped, patterns["hyphen_break"], _delete)
        mapped = _msub(mapped, patterns["spaced_hyphen"], _delete)
        mapped = _msub(mapped, patterns["bullet"], _group_one)
    mapped = _normalize_mapped(mapped)
    if extraction:
        mapped = _msub(mapped, _SPACE_BEFORE_PUNCTUATION, _group_one)
    # Two implementations of one pipeline must agree, or the offsets describe
    # a different text than the verdict. They are held equal by tests; this is
    # what keeps a disagreement nobody tested from reporting wrong positions.
    return mapped if mapped.text == expected and len(mapped.starts) == len(expected) else None


def _proportional(haystack_length: int, source_length: int):
    """Offsets when the mapped pipeline cannot be trusted: monotone, and
    honest about being approximate (callers widen the context)."""
    scale = source_length / max(haystack_length, 1)
    return lambda position: min(source_length, int(round(position * scale)))


# ---------------------------------------------------------------------------
# Near passages
# ---------------------------------------------------------------------------
def _anchors(needle: str):
    cjk = sum(1 for character in needle if _continuous(character))
    size = 4 if cjk * 2 >= len(needle) else 8
    size = max(3, min(size, len(needle)))
    count = max(1, len(needle) - size + 1)
    stride = max(1, count // 32)
    return size, [(offset, needle[offset:offset + size]) for offset in range(0, count, stride)][:48]


def _near_candidates(haystack: str, needle: str, limit: int):
    """Where in the normalised text the quote most nearly occurs.

    Anchors (short substrings of the quote) vote for an alignment; the few
    alignments with the most votes are scored with difflib. Bounded on both
    sides: at most 48 anchors, at most 64 occurrences of each (an anchor that
    occurs more often than that says nothing about where), at most eight
    windows scored. A 1 MB text is searched in well under a second."""
    if not needle or not haystack:
        return []
    size, anchors = _anchors(needle)
    votes = {}
    for offset, anchor in anchors:
        found = []
        at = haystack.find(anchor)
        while at >= 0 and len(found) <= 64:
            found.append(at)
            at = haystack.find(anchor, at + 1)
        if not found or len(found) > 64:
            continue
        for position in found:
            bucket = (position - offset) // 16
            votes[bucket] = votes.get(bucket, 0) + 1
    if not votes:
        return []
    minimum = 1 if len(anchors) <= 2 else 2
    ranked = sorted((count, bucket) for bucket, count in votes.items() if count >= minimum)[::-1][:8]
    candidates = []
    slack = min(200, max(16, len(needle) // 2))
    for _count, bucket in ranked:
        origin = bucket * 16
        low = max(0, origin - slack)
        high = min(len(haystack), origin + len(needle) + slack)
        window = haystack[low:high]
        matcher = difflib.SequenceMatcher(None, needle, window, autojunk=False)
        blocks = [block for block in matcher.get_matching_blocks() if block.size]
        if not blocks:
            continue
        begin = blocks[0].b
        finish = blocks[-1].b + blocks[-1].size
        matched = sum(block.size for block in blocks)
        score = 2.0 * matched / (len(needle) + (finish - begin))
        if score < NEAR_MIN_SCORE:
            continue
        span = (low + begin, low + finish)
        if any(not (span[1] <= other[0] or span[0] >= other[1]) for _score, other in candidates):
            continue
        candidates.append((round(score, 3), span))
    candidates.sort(key=lambda item: (-item[0], item[1][0]))
    return candidates[:limit]


# ---------------------------------------------------------------------------
# The preserved files
# ---------------------------------------------------------------------------
def _read_workspace_file(workspace: str, relative: str) -> str:
    """Read one file under the workspace without following a link anywhere on
    the path — the same discipline `immutable_capture` publishes with."""
    parts = PurePosixPath(relative).parts
    directory = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in parts[:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except OSError as error:
        raise QuoteLocatorError("quote_source_not_found", "No preserved source exists at %s." % relative) from error
    finally:
        os.close(directory)
    with os.fdopen(descriptor, "rb") as handle:
        metadata = os.fstat(handle.fileno())
        if not stat.S_ISREG(metadata.st_mode):
            raise QuoteLocatorError("quote_source_not_found", "%s is not a preserved file." % relative)
        if metadata.st_size > MAX_SOURCE_BYTES:
            raise QuoteLocatorError("quote_source_too_large", "%s exceeds the %d MiB bound." % (relative, MAX_SOURCE_BYTES // (1024 * 1024)))
        payload = handle.read(MAX_SOURCE_BYTES + 1)
    if b"\0" in payload[:8192]:
        raise QuoteLocatorError("quote_source_unreadable", "%s is not a text artifact; quote from its Markdown rendering." % relative)
    # The gate reads with Node's utf8 decoder, which replaces invalid bytes.
    return payload.decode("utf-8", errors="replace")


def _safe_relative(value: str) -> str | None:
    text = value.strip().replace("\\", "/")
    if text.startswith("./"):
        text = text[2:]
    if not text.startswith(SOURCES_DIR + "/"):
        return None
    parts = text.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    return text


def _listing(workspace: str, relative: str) -> list[str]:
    """Entries of one directory under the workspace, or none. Symlinks are
    not followed and not listed."""
    try:
        directory = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        return []
    try:
        for component in PurePosixPath(relative).parts:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        return sorted(entry for entry in os.listdir(directory) if not entry.startswith("."))
    except OSError:
        return []
    finally:
        os.close(directory)


def _doi_slug(doi: str) -> str:
    # The directory name `open_access_fulltext` gives a DOI's capture. Written
    # out rather than imported: importing that module would pull in the whole
    # retrieval stack for a path rule.
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", doi).strip("-.")[:96]
    return slug or "open-access-article"


def _capture_roots(source_id: str) -> list[tuple[str, tuple[str, ...]]]:
    """Capture directories (and the text artifacts in them) a source id names.

    The preserving tools file each capture under a path derived from the id
    they report, so the id is enough to find it again: PMCID, DOI,
    `official-page:<digest>`, `label:<approval number>#<section>`, and the
    guideline ids `guideline_search` reports."""
    value = source_id.strip()
    pmcid = re.fullmatch(r"(?:PMCID\s*:\s*)?(PMC)?(\d{3,12})", value, re.I)
    if pmcid and pmcid.group(1):
        return [("%s/PMC%s" % (SOURCES_DIR, pmcid.group(2)), ("fulltext.md",))]
    doi = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", value, flags=re.I)
    if doi.startswith("10.") and not any(character.isspace() for character in doi):
        return [("%s/%s" % (SOURCES_DIR, _doi_slug(doi.casefold())), ("fulltext.md",))]
    page = re.fullmatch(r"official-page:([0-9a-f]{16})", value)
    if page:
        return [("%s/official-pages/%s" % (SOURCES_DIR, page.group(1)), ("page.md",))]
    guide = re.fullmatch(r"EVIMED-GUIDE:(.{1,256})", value)
    if guide:
        digest = hashlib.sha256(("evimed-guide:%s" % guide.group(1)).encode("utf-8")).hexdigest()[:16]
        return [("%s/evimed-guidelines/%s" % (SOURCES_DIR, digest), ("guideline.md",))]
    if value.startswith("label:"):
        # The drug-label index files a label under the digest of its approval
        # number; one section is one file, and a bare label id means all of
        # them. Parsed by the module that writes the capture, so a label id
        # that tool would accept -- a Chinese section heading, full-width
        # digits -- resolves here too.
        try:
            approval, section = drug_label_index.parse_label_id(value)
        except drug_label_index.DrugLabelIndexError:
            return []
        names = (section,) if section else tuple(slug for slug, _title in drug_label_index.SECTIONS)
        return [(drug_label_index.capture_root(approval), tuple("%s.md" % name for name in names))]
    digest = hashlib.sha256(("evimed-guide:%s" % value).encode("utf-8")).hexdigest()[:16]
    return [("%s/evimed-guidelines/%s" % (SOURCES_DIR, digest), ("guideline.md",))]


def resolve_artifacts(workspace: str, source_id: str) -> list[str]:
    """The preserved text files a `sourceId` refers to, workspace-relative."""
    relative = _safe_relative(source_id)
    if relative is not None:
        return [relative]
    # A DOI has slashes of its own; what is refused is anything shaped like a
    # path that did not pass as one: absolute, relative, or climbing out.
    shaped = source_id.strip().replace("\\", "/")
    if shaped.startswith((SOURCES_DIR, "/", "./", "../")) or ".." in shaped.split("/"):
        raise QuoteLocatorError(
            "quote_source_invalid",
            "sourceId must be a %s/... path a preserving tool returned, or a source id it reported." % SOURCES_DIR,
        )
    found = []
    for root, names in _capture_roots(source_id):
        versions = [entry for entry in _listing(workspace, root) if re.fullmatch(r"[0-9a-f]{64}", entry)]
        for version in versions[:MAX_CAPTURE_VERSIONS]:
            present = set(_listing(workspace, "%s/%s" % (root, version)))
            found.extend("%s/%s/%s" % (root, version, name) for name in names if name in present)
    if not found:
        raise QuoteLocatorError(
            "quote_source_not_found",
            "No preserved source was found for %s in this workspace. Pass the exact %s/... path the preserving tool returned."
            % (source_id, SOURCES_DIR),
        )
    return found


# ---------------------------------------------------------------------------
# The tool
# ---------------------------------------------------------------------------
def _match_record(source: str, artifact: str, kind: str, start: int, end: int, score: float, approximate: bool):
    before = max(0, start - CONTEXT_CHARS - (CONTEXT_CHARS if approximate else 0))
    after = min(len(source), end + CONTEXT_CHARS + (CONTEXT_CHARS if approximate else 0))
    record = {
        "match": kind,
        "start": start,
        "end": end,
        "line": source.count("\n", 0, start) + 1,
        "score": score,
        "context": source[before:after],
        "text": source[start:end][:MAX_MATCH_TEXT],
        "artifactPath": artifact,
    }
    if approximate:
        record["approximate"] = True
    return record


def _exact_kind(source: str, start: int, end: int, segments: list[str]) -> str:
    """`exact` when the matched stretch holds the quote's own characters, in
    order; otherwise the gate accepted it only after normalisation."""
    stretch = source[start:end]
    cursor = 0
    for segment in segments:
        at = stretch.find(segment, cursor)
        if at < 0:
            return "normalized"
        cursor = at + len(segment)
    return "exact"


def locate_in_text(source: str, quote: str, artifact: str, max_results: int = DEFAULT_MAX_RESULTS):
    """Matches of `quote` in one preserved text, and whether the gate would
    accept it there."""
    segments = quote_segments(quote)
    if not segments or not source:
        return False, []
    matches = []
    prepared = _prepared(source)
    for marker_free, extraction in READINGS:
        project = normalize_extraction_passage if extraction else normalize_passage
        needles = [project(segment) for segment in segments]
        if not all(needles):
            continue
        haystack = prepared.haystack(marker_free, extraction)
        numeric = _numeric_spans(haystack)
        chains = []
        begin = 0
        while len(chains) < max_results:
            chain = _chain_from(haystack, needles, begin, numeric)
            if chain is None:
                break
            chains.append(chain)
            # Occurrences are reported without overlapping, the way a reader
            # counts them; the gate needs only the first.
            begin = chain[-1][1]
        if not chains:
            continue
        mapped = prepared.mapped(marker_free, extraction)
        position = _proportional(len(haystack), len(source)) if mapped is None else None
        for chain in chains:
            first, last = chain[0][0], chain[-1][1]
            if mapped is not None:
                start, end = mapped.starts[first], mapped.ends[last - 1]
            else:
                start, end = position(first), max(position(first) + 1, position(last))
            kind = _exact_kind(source, start, end, segments)
            matches.append(_match_record(source, artifact, kind, start, end, 1.0, mapped is None))
        return True, matches
    return False, matches


def near_in_text(source: str, quote: str, artifact: str, limit: int):
    """The passages most like the quote, when the gate would accept none."""
    prepared = _prepared(source)
    haystack = prepared.haystack(False, False)
    needle = normalize_passage(" ".join(quote_segments(quote)))[:NEAR_MAX_NEEDLE]
    candidates = _near_candidates(haystack, needle, limit)
    if not candidates:
        return []
    mapped = prepared.mapped(False, False)
    position = _proportional(len(haystack), len(source)) if mapped is None else None
    records = []
    for score, (first, last) in candidates:
        if mapped is not None:
            start, end = mapped.starts[first], mapped.ends[last - 1]
        else:
            start, end = position(first), max(position(first) + 1, position(last))
        records.append(_match_record(source, artifact, "near", start, end, score, mapped is None))
    return records


def locate(arguments: dict, workspace: str) -> dict:
    """`locate_quote`: the C7 payload for one source and one quote."""
    source_id = str(arguments.get("sourceId") or "").strip()
    quote = str(arguments.get("quote") or "")
    max_results = arguments.get("maxResults", DEFAULT_MAX_RESULTS)
    if not source_id:
        raise QuoteLocatorError("quote_source_invalid", "sourceId must not be empty.")
    if not quote_segments(quote):
        raise QuoteLocatorError("quote_invalid", "quote must contain text to look for.")
    if len(quote) > MAX_QUOTE_CHARS:
        raise QuoteLocatorError("quote_invalid", "quote exceeds %d characters; quote the passage that carries the claim." % MAX_QUOTE_CHARS)
    max_results = max(1, min(int(max_results), MAX_RESULTS))
    artifacts = resolve_artifacts(workspace, source_id)
    found = False
    matches = []
    texts = []
    for artifact in artifacts:
        text = _read_workspace_file(workspace, artifact)
        texts.append((artifact, text))
        hit, located = locate_in_text(text, quote, artifact, max_results - len(matches))
        if hit:
            found = True
            matches.extend(located)
        if len(matches) >= max_results:
            break
    if not found:
        for artifact, text in texts:
            matches.extend(near_in_text(text, quote, artifact, max_results))
        matches.sort(key=lambda item: -item["score"])
        matches = matches[:max_results]
    return {
        "sourceId": source_id,
        "found": found,
        "matches": matches,
        "normalization": NORMALIZATION,
        "artifactPaths": [artifact for artifact, _text in texts],
    }
