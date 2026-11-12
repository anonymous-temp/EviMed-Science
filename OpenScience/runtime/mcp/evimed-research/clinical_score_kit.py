"""The parts every clinical score is built from: typed inputs, units, refusals and the result a score returns.

A score here is a pure function of explicit inputs. Nothing is read from the conversation, nothing is guessed, and a
value that is missing is never replaced by a default unless the caller names the item in `assume_absent`. A unit that
is missing, unknown or of another quantity is refused with a code (`clinical_score_unit_invalid`), because a weight in
pounds read as kilograms is the commonest wrong answer a hand calculation gives.

The scales themselves are in `clinical_score_points.py` (additive point scores) and `clinical_score_formulas.py`
(multi-step formulas); `clinical_scores.py` is the tool.
"""
from __future__ import annotations

import datetime
import math
import re

# The closed vocabulary of refusals. Each is one calculation declined with a reason; nothing else is affected.
REQUEST_INVALID = "clinical_score_request_invalid"
UNKNOWN_SCORE = "clinical_score_unknown_id"
UNKNOWN_VERSION = "clinical_score_unknown_version"
UNKNOWN_INPUT = "clinical_score_unknown_input"
INPUT_INVALID = "clinical_score_input_invalid"
UNIT_INVALID = "clinical_score_unit_invalid"
OUT_OF_RANGE = "clinical_score_out_of_range"
NOT_APPLICABLE = "clinical_score_not_applicable"
MISSING_INPUTS = "clinical_score_missing_inputs"
ABSENT_INVALID = "clinical_score_assume_absent_invalid"
ERROR_CODES = (REQUEST_INVALID, UNKNOWN_SCORE, UNKNOWN_VERSION, UNKNOWN_INPUT, INPUT_INVALID, UNIT_INVALID,
               OUT_OF_RANGE, NOT_APPLICABLE, MISSING_INPUTS, ABSENT_INVALID)


class ScoreError(Exception):
    """One calculation declined. `data` carries what the caller needs to correct it (accepted units, the missing items)."""

    def __init__(self, code, message, data=None):
        super().__init__(message)
        self.code = code
        self.data = data or {}


# ---------------------------------------------------------------------------------------------------------------
# Units. A quantity has one canonical unit; every other unit converts to it by `value * scale + offset`.
# The lab factors are molar-mass ratios (mg/dL to umol/L is 10 / molar mass x 1000) and are checked against the
# atomic weights in the tests, not typed from a table.
# ---------------------------------------------------------------------------------------------------------------

_MOLAR_MASS = {"creatinine": 113.12, "bilirubin": 584.66, "glucose": 180.156, "cholesterol": 386.65, "urea_nitrogen": 28.014}

# quantity -> (canonical unit, {accepted spelling -> (unit name, scale, offset)})
def _family(canonical, *others):
    table = {canonical: (canonical, 1.0, 0.0)}
    for name, scale, offset, *spellings in others:
        table[name] = (name, scale, offset)
        for spelling in spellings:
            table[spelling] = (name, scale, offset)
    return canonical, table


QUANTITIES = {
    "age": _family("years", ("months", 1 / 12, 0.0)),
    "weight": _family("kg", ("lb", 0.45359237, 0.0, "lbs", "pound", "pounds")),
    "height": _family("cm", ("in", 2.54, 0.0, "inch", "inches"), ("m", 100.0, 0.0)),
    "temperature": _family("C", ("F", 5 / 9, -32 * 5 / 9)),
    "creatinine": _family("mg/dL", ("umol/L", 1 / 88.4, 0.0)),
    "bilirubin": _family("mg/dL", ("umol/L", 1 / 17.1, 0.0)),
    "albumin": _family("g/dL", ("g/L", 0.1, 0.0)),
    "glucose": _family("mg/dL", ("mmol/L", 18.0182, 0.0)),
    "urea_nitrogen": _family("mg/dL", ("mmol/L", 2.8014, 0.0)),
    "cholesterol": _family("mg/dL", ("mmol/L", 38.67, 0.0)),
    "triglycerides": _family("mg/dL", ("mmol/L", 88.57, 0.0)),
    "hemoglobin": _family("g/dL", ("g/L", 0.1, 0.0)),
    "calcium": _family("mg/dL", ("mmol/L", 4.008, 0.0)),
    "enzyme": _family("U/L", ("IU/L", 1.0, 0.0), ("ukat/L", 60.0, 0.0, "µkat/L", "μkat/L")),
    "insulin": _family("uIU/mL", ("pmol/L", 1 / 6.945, 0.0), ("mIU/L", 1.0, 0.0, "uU/mL", "mU/L")),
    "bmi": _family("kg/m2"),
    "electrolyte": _family("mmol/L", ("mEq/L", 1.0, 0.0)),
    "count": _family("10^9/L", ("/uL", 1e-3, 0.0, "cells/uL", "/mm3", "cells/mm3"), ("K/uL", 1.0, 0.0, "10^3/uL", "x10^3/uL")),
    "pressure": _family("mmHg", ("kPa", 7.50062, 0.0)),
    "rate": _family("/min", ("bpm", 1.0, 0.0, "beats/min", "breaths/min")),
    "dose_rate_mass": _family("ug/kg/min", ("mcg/kg/min", 1.0, 0.0)),
    "urine_volume": _family("mL/day", ("mL/24h", 1.0, 0.0)),
    "ratio": _family("ratio"),
    "number": _family("number"),
    "percent": _family("%"),
    "fraction": _family("fraction", ("%", 0.01, 0.0, "percent")),
    "interval": _family("ms", ("s", 1000.0, 0.0)),
    "mass_dose": _family("mg"),
    "days": _family("days", ("weeks", 7.0, 0.0)),
    "iu_ratio": _family("x_ULN"),
}

_SPELLINGS = {
    "µmol/l": "umol/L", "μmol/l": "umol/L", "umol/l": "umol/L", "micromol/l": "umol/L",
    "mg/dl": "mg/dL", "g/dl": "g/dL", "g/l": "g/L", "mmol/l": "mmol/L", "meq/l": "mEq/L",
    "mmhg": "mmHg", "kpa": "kPa", "ug/kg/min": "ug/kg/min", "µg/kg/min": "ug/kg/min", "μg/kg/min": "ug/kg/min",
    "mcg/kg/min": "mcg/kg/min", "years": "years", "year": "years", "yr": "years", "yrs": "years", "y": "years",
    "months": "months", "month": "months", "kg": "kg", "lb": "lb", "lbs": "lb", "pound": "lb", "pounds": "lb",
    "cm": "cm", "in": "in", "inch": "in", "inches": "in", "m": "m", "c": "C", "°c": "C", "degc": "C", "celsius": "C",
    "f": "F", "°f": "F", "degf": "F", "fahrenheit": "F", "/min": "/min", "bpm": "bpm", "beats/min": "bpm",
    "breaths/min": "breaths/min", "/ul": "/uL", "cells/ul": "cells/uL", "/mm3": "/mm3", "cells/mm3": "cells/mm3",
    "10^9/l": "10^9/L", "x10^9/l": "10^9/L", "10*9/l": "10^9/L", "k/ul": "K/uL", "10^3/ul": "10^3/uL", "x10^3/ul": "x10^3/uL",
    "u/l": "U/L", "iu/l": "IU/L", "ukat/l": "ukat/L", "µkat/l": "ukat/L", "μkat/l": "ukat/L", "uiu/ml": "uIU/mL", "µiu/ml": "uIU/mL", "μiu/ml": "uIU/mL",
    "miu/l": "mIU/L", "mu/l": "mIU/L", "uu/ml": "uU/mL", "µu/ml": "uU/mL", "μu/ml": "uU/mL", "pmol/l": "pmol/L", "kg/m2": "kg/m2", "kg/m^2": "kg/m2",
    "g": "g", "ml/day": "mL/day", "ml/24h": "mL/24h", "mg": "mg", "%": "%", "percent": "percent", "fraction": "fraction",
    "ratio": "ratio", "ms": "ms", "s": "s", "days": "days", "weeks": "weeks", "x_uln": "x_ULN", "xuln": "x_ULN",
    "x uln": "x_ULN", "number": "number", "day": "days", "d": "days", "week": "weeks", "wk": "weeks", "wks": "weeks", "sec": "s", "second": "s", "seconds": "s",
    "msec": "ms", "millisecond": "ms", "milliseconds": "ms", "mm hg": "mmHg", "mg/100ml": "mg/dL", "mg/100 ml": "mg/dL", "g/100ml": "g/dL", "g/100 ml": "g/dL",
}


def _spelling(unit):
    text = " ".join(str(unit).strip().split())
    return _SPELLINGS.get(text.lower(), text)


def accepted_units(quantity):
    canonical, table = QUANTITIES[quantity]
    return [canonical, *sorted(name for name in {entry[0] for entry in table.values()} if name != canonical)]


def convert(quantity, value, unit):
    """`value` in `unit` as the quantity's canonical unit, or ScoreError(unit_invalid) when the unit is not one of its."""
    canonical, table = QUANTITIES[quantity]
    entry = table.get(_spelling(unit))
    if entry is None:
        raise ScoreError(UNIT_INVALID, "%r is not a unit of this quantity; accepted: %s." % (unit, ", ".join(accepted_units(quantity))),
                         {"accepted_units": accepted_units(quantity)})
    name, scale, offset = entry
    # rounded so that a cut-off written in another unit (100.4 F for 38 C) lands on the cut-off and not a rounding error beside it
    return name, round(value * scale + offset, 9)


_NUMBER_WITH_UNIT = re.compile(r"^\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*(.*?)\s*$")


# ---------------------------------------------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------------------------------------------

class Parsed:
    """One input as read: what the caller sent, and the value the score uses."""

    forced_points = None

    def __init__(self, item, sent, value, unit=None, converted=None, native=None):
        self.item = item
        self.sent = sent          # echoed back as `input`
        self.value = value        # the canonical number, the boolean, or the choice key
        self.unit = unit          # the unit the caller used (numbers)
        self.converted = converted  # a short note when the unit was converted
        self.native = native      # the number as the caller wrote it, in `unit`


class Item:
    kind = "item"

    def __init__(self, id, label, *, required=True, note=None):
        self.id = id
        self.label = label
        self.required = required
        self.note = note

    def describe(self):
        entry = {"id": self.id, "label": self.label, "type": self.kind}
        if not self.required:
            entry["optional"] = True
        if self.note:
            entry["note"] = self.note
        return entry

    def absent(self):
        """What `assume_absent` makes of this item, or None when absence is not defined for it."""
        return None

    def possible_points(self):
        return []

    def brief(self):
        """The shape of a value for this item in a few words, for a refusal that lists what the score takes."""
        return self.kind


class Bool(Item):
    """A finding that is present or absent. Present earns `points`."""
    kind = "boolean"

    def __init__(self, id, label, points=1, *, rule=None, note=None, required=True):
        super().__init__(id, label, required=required, note=note)
        self.points = points
        self.rule = rule or label

    def parse(self, raw):
        if isinstance(raw, bool):
            return Parsed(self, raw, raw)
        if isinstance(raw, int) and raw in (0, 1):
            return Parsed(self, raw, bool(raw))
        if isinstance(raw, str) and raw.strip().lower() in ("true", "yes", "y", "present"):
            return Parsed(self, raw, True)
        if isinstance(raw, str) and raw.strip().lower() in ("false", "no", "n", "absent"):
            return Parsed(self, raw, False)
        raise ScoreError(INPUT_INVALID, "%s must be true or false." % self.id, {"item": self.id})

    def absent(self):
        return Parsed(self, "assumed absent", False)

    def brief(self):
        return "true or false"

    def points_of(self, parsed):
        pts = self.points if parsed.value else 0
        return pts, ("present: %s" % _signed(self.points)) if parsed.value else "absent: 0"

    def possible_points(self):
        return [0, self.points]

    def describe(self):
        return {**super().describe(), "accepts": [True, False], "points_if_present": self.points}


def _signed(points):
    return "%+g" % points if points else "0"


class Choice(Item):
    """One of a closed set. `options` is a list of (key, label, points); `aliases` maps other spellings to a key."""
    kind = "choice"

    def __init__(self, id, label, options, *, aliases=None, absent_key=None, required=True, note=None, unscorable=None):
        super().__init__(id, label, required=required, note=note)
        self.options = list(options)
        self.aliases = dict(aliases or {})
        if [key for key, _l, _p in self.options] == ["male", "female"]:
            self.aliases = {"m": "male", "man": "male", "men": "male", "f": "female", "woman": "female", "women": "female", **self.aliases}
        self.absent_key = absent_key
        self.unscorable = dict(unscorable or {})   # key -> why no total can be given when this is the answer

    def brief(self):
        return "one of " + ", ".join(repr(key) for key, _l, _p in self.options)

    def _key(self, raw):
        for key, _label, _points in self.options:
            if raw == key or (isinstance(key, str) and isinstance(raw, str) and raw.strip().lower() == key.lower()):
                return key
            if isinstance(key, int) and not isinstance(key, bool) and isinstance(raw, str) and raw.strip().lstrip("+").isdigit() and int(raw) == key:
                return key
        if isinstance(raw, str) and raw.strip().lower() in {name.lower() for name in self.aliases}:
            lowered = {name.lower(): key for name, key in self.aliases.items()}
            return lowered[raw.strip().lower()]
        return None

    def parse(self, raw):
        if isinstance(raw, float) and raw.is_integer():
            raw = int(raw)
        key = None if isinstance(raw, (dict, list, float)) or isinstance(raw, bool) and not self._allows_bool() else self._key(raw)
        if key is None:
            raise ScoreError(INPUT_INVALID, "%s must be one of %s." % (self.id, ", ".join(repr(k) for k, _l, _p in self.options)),
                             {"item": self.id, "accepted": [k for k, _l, _p in self.options]})
        return Parsed(self, raw, key)

    def _allows_bool(self):
        return any(isinstance(key, bool) for key, _l, _p in self.options)

    def absent(self):
        return None if self.absent_key is None else Parsed(self, "assumed absent", self.absent_key)

    def points_of(self, parsed):
        if parsed.value in self.unscorable:
            raise ScoreError(NOT_APPLICABLE, "%s is %r: %s" % (self.id, parsed.value, self.unscorable[parsed.value]), {"item": self.id})
        for key, label, points in self.options:
            if key == parsed.value:
                return points, "%s: %s" % (label, _signed(points))
        raise AssertionError(parsed.value)

    def possible_points(self):
        return [points for _k, _l, points in self.options if points is not None]

    def describe(self):
        scored = any(points for _k, _l, points in self.options)
        return {**super().describe(), "options": [{"value": k, "meaning": label, **({"points": points} if scored else {})} for k, label, points in self.options],
                **({"also_accepted": sorted(self.aliases)} if self.aliases else {})}


class Num(Item):
    """A measurement in a named quantity. `lo`/`hi` are the plausible bounds in the canonical unit, not a clinical judgement:
    a value outside them is almost always a unit slip and is refused with `clinical_score_out_of_range`.

    `bands` is a list of (rule text, predicate on the value in `band_unit`, points) for point scores; `alt_bands` holds a
    second table for another unit where the source prints cut-offs in both (they are compared natively, never through a
    rounded conversion). `bare` allows a plain number for an item whose unit cannot be mistaken (an age in years)."""
    kind = "number"

    def __init__(self, id, label, quantity, *, lo=None, hi=None, bands=None, band_unit=None, alt_bands=None, bare=False,
                 absent_points=None, absent_value=None, required=True, note=None, integer=False):
        super().__init__(id, label, required=required, note=note)
        self.quantity = quantity
        self.lo = lo
        self.hi = hi
        self.bands = bands
        self.band_unit = band_unit or QUANTITIES[quantity][0]
        self.alt_bands = alt_bands or {}
        self.bare = bare
        self.absent_points = absent_points   # a score that scores a missing measurement as normal says so
        self.absent_value = absent_value     # a dose or finding whose absence is a real value (no vasopressor: 0)
        self.integer = integer

    @property
    def canonical(self):
        return QUANTITIES[self.quantity][0]

    def brief(self):
        if self.quantity in ("ratio", "number"):
            return "a plain number"
        return "number with unit (%s)%s" % (" | ".join(accepted_units(self.quantity)), "; a plain number is read as " + self.canonical if self.bare else "")

    def parse(self, raw):
        value, unit = None, None
        if isinstance(raw, dict):
            if set(raw) - {"value", "unit"} or "value" not in raw:
                raise ScoreError(INPUT_INVALID, "%s takes {value, unit}." % self.id, {"item": self.id})
            value, unit = raw["value"], raw.get("unit")
        elif isinstance(raw, str):
            match = _NUMBER_WITH_UNIT.match(raw)
            if not match:
                raise ScoreError(INPUT_INVALID, "%s must be a number with its unit, for example \"%s\"." % (self.id, self._example()), {"item": self.id})
            value, unit = float(match.group(1)), (match.group(2) or None)
        else:
            value = raw
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ScoreError(INPUT_INVALID, "%s must be a finite number." % self.id, {"item": self.id})
        if unit is None:
            if not self.bare:
                raise ScoreError(UNIT_INVALID, "%s needs its unit; accepted: %s." % (self.id, ", ".join(accepted_units(self.quantity))),
                                 {"item": self.id, "accepted_units": accepted_units(self.quantity)})
            unit = self.canonical
        try:
            name, canonical_value = convert(self.quantity, float(value), unit)
        except ScoreError as error:
            error.data = {**error.data, "item": self.id}
            raise ScoreError(error.code, "%s: %s" % (self.id, error), error.data) from None
        if self.integer and not float(value).is_integer():
            raise ScoreError(INPUT_INVALID, "%s must be a whole number." % self.id, {"item": self.id})
        if (self.lo is not None and canonical_value < self.lo) or (self.hi is not None and canonical_value > self.hi):
            raise ScoreError(OUT_OF_RANGE, "%s = %g %s is outside the plausible range %s to %s %s; check the unit." % (
                self.id, value, name, _bound(self.lo), _bound(self.hi), self.canonical), {"item": self.id, "range": [self.lo, self.hi], "unit": self.canonical})
        note = None if name == self.canonical else "%g %s = %.6g %s" % (value, name, canonical_value, self.canonical)
        return Parsed(self, {"value": value, "unit": name}, canonical_value, name, note, float(value))

    def _example(self):
        return "%s %s" % ("65" if self.quantity == "age" else "1.0", self.canonical)

    def _table(self, parsed):
        """The band table and the value to read it with: the caller's own unit when the source prints cut-offs in it."""
        if parsed.unit in self.alt_bands:
            return self.alt_bands[parsed.unit], parsed.native, parsed.unit
        if parsed.unit == self.band_unit:
            return self.bands, parsed.native, parsed.unit
        if self.band_unit != self.canonical:
            raise AssertionError("a band unit that is not canonical needs an explicit table")
        return self.bands, parsed.value, self.band_unit

    def points_of(self, parsed):
        table, value, unit = self._table(parsed)
        for rule, predicate, points in table:
            if predicate(value):
                return points, "%s%s: %s" % (rule, "" if self.quantity in ("ratio", "number") else " " + unit, _signed(points))
        raise AssertionError("bands of %s do not cover %r" % (self.id, value))

    def absent(self):
        if self.absent_value is not None:
            return Parsed(self, "assumed absent", self.absent_value, self.canonical, native=self.absent_value)
        if self.absent_points is None:
            return None
        parsed = Parsed(self, "assumed absent", None, self.canonical)
        parsed.forced_points = self.absent_points
        return parsed

    def possible_points(self):
        return sorted({points for _r, _p, points in (self.bands or [])})

    def describe(self):
        entry = super().describe()
        if self.quantity in ("ratio", "number"):
            entry["accepts"] = "a plain number"
        else:
            entry.update({"unit": self.canonical, "accepted_units": accepted_units(self.quantity)})
            if self.bare:
                entry["bare_number"] = "a plain number is read as %s" % self.canonical
        if self.lo is not None or self.hi is not None:
            entry["accepted_range"] = ("%s to %s %s" % (_bound(self.lo), _bound(self.hi), self.canonical)).rstrip(" ").removesuffix(" ratio").removesuffix(" number")
        if self.bands:
            entry["points"] = ["%s%s = %s" % (rule, "" if self.quantity in ("ratio", "number") else " " + self.band_unit, _signed(points)) for rule, _p, points in self.bands]
        for unit, table in self.alt_bands.items():
            entry.setdefault("points_in_%s" % unit.replace("/", "_per_"), ["%s %s = %s" % (rule, unit, _signed(points)) for rule, _p, points in table])
        return entry


def _bound(value):
    return "-inf" if value is None else "%g" % value


class Date(Item):
    """A calendar date, YYYY-MM-DD."""
    kind = "date"

    def brief(self):
        return "date YYYY-MM-DD"

    def __init__(self, id, label, *, required=True, note=None):
        super().__init__(id, label, required=required, note=note)

    def parse(self, raw):
        try:
            if not isinstance(raw, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw.strip()):
                raise ValueError
            day = datetime.date.fromisoformat(raw.strip())
        except ValueError:
            raise ScoreError(INPUT_INVALID, "%s must be a calendar date written YYYY-MM-DD." % self.id, {"item": self.id}) from None
        return Parsed(self, raw.strip(), day)

    def describe(self):
        return {**super().describe(), "accepts": "YYYY-MM-DD"}


# ---------------------------------------------------------------------------------------------------------------
# What a score returns
# ---------------------------------------------------------------------------------------------------------------

class Outcome:
    """The result of one version of one score: the value, how it was reached and what it assumed."""

    def __init__(self, value, unit, *, category=None, formula=None, constants=None, steps=None, rows=None, rounding=None,
                 unrounded=None, notes=None, extra=None):
        self.value = int(value) if isinstance(value, float) and unit == "points" and value.is_integer() else value
        self.unit = unit
        self.category = category
        self.formula = formula
        self.constants = constants or []
        self.steps = steps or {}
        self.rows = rows or []
        self.rounding = rounding
        self.unrounded = unrounded
        self.notes = notes or []
        self.extra = extra or {}


def constant(name, value, source):
    return {"name": name, "value": value, "source": source}


class Version:
    """One published form of a score. `requires` are the item ids it reads; `compute(ctx)` returns an Outcome."""

    def __init__(self, id, label, source, compute, requires, *, note=None, additive=False):
        self.additive = additive   # the total is a sum of item points, so a missing item has a range
        self.id = id
        self.label = label
        self.source = source
        self.compute = compute
        self.requires = tuple(requires)
        self.note = note


class Scale:
    def __init__(self, id, name, group, items, versions, *, source, scope, aliases=(), default=None, bands=None, example=None):
        self.id = id
        self.name = name
        self.group = group
        self.items = {item.id: item for item in items}
        self.item_order = [item.id for item in items]
        self.versions = {version.id: version for version in versions}
        self.default = default or versions[0].id
        self.source = source
        self.scope = scope
        self.aliases = tuple(aliases)
        self.bands = bands          # {value-range text: meaning}, for describe
        self.example = example      # a worked input, shown by describe

    def describe(self):
        entry = {"id": self.id, "name": self.name, "group": self.group,
                 "items": [self.items[i].describe() for i in self.item_order],
                 "versions": [{"id": v.id, "label": v.label, "default": v.id == self.default, "reads": list(v.requires),
                               "source": v.source, **({"note": v.note} if v.note else {})} for v in self.versions.values()],
                 "source": self.source, "scope": self.scope}
        if self.bands:
            entry["interpretation"] = self.bands
        if self.example:
            entry["example_inputs"] = self.example
        return entry


class _Reads(dict):
    """The parsed inputs, noting each one a computation reads."""

    def __init__(self, parsed, touched):
        super().__init__(parsed)
        self._touched = touched

    def __getitem__(self, item):
        self._touched.add(item)
        return super().__getitem__(item)


class Context:
    """The parsed inputs of one calculation, read by the version being computed."""

    requested_absent = frozenset()   # items the caller named in assume_absent ("all" names every item)

    def __init__(self, scale, parsed, assumed):
        self.scale = scale
        self.touched = set()      # the items a computation read, so a result can say which given inputs it did not use
        self.parsed = _Reads(parsed, self.touched)
        self.assumed = assumed

    def has(self, item):
        if item in self.parsed:
            self.touched.add(item)
            return True
        return False

    def value(self, item):
        return self.parsed[item].value

    def row(self, item, rule=None, points=None):
        parsed = self.parsed[item]
        row = {"item": item, "input": parsed.sent}
        if parsed.converted:
            row["converted"] = parsed.converted
        if item in self.assumed:
            row["assumed_absent"] = True
        if points is not None:
            row["points"] = points
        if rule is not None:
            row["rule"] = rule
        return row

    def scored_row(self, item):
        parsed = self.parsed[item]
        item_def = self.scale.items[item]
        if parsed.forced_points is not None:
            return self.row(item, "not measured, scored as normal: +0", parsed.forced_points)
        points, rule = item_def.points_of(parsed)
        return self.row(item, rule, points)


def points_total(ctx, version, interpret, *, formula="sum of the item points", maximum=None, unit="points", constants=None, extra=None):
    """The additive score: every item the version reads is scored, summed and read against `interpret(total)`."""
    rows = [ctx.scored_row(item) for item in version.requires]
    total = sum(row["points"] for row in rows)
    category = interpret(total)
    return Outcome(total, unit, category=category, formula=formula + (" (maximum %s)" % maximum if maximum is not None else ""),
                   rows=rows, constants=constants, extra=extra)


def point_range(scale, version, ctx_parsed, missing):
    """The lowest and highest total the missing items could add, for an additive scale (None when an item has no points)."""
    low = high = 0.0
    for item in version.requires:
        if item in missing:
            options = scale.items[item].possible_points()
            if not options:
                return None
            low, high = low + min(options), high + max(options)
        else:
            parsed = ctx_parsed[item]
            if parsed.forced_points is not None:
                points = parsed.forced_points
            else:
                points, _rule = scale.items[item].points_of(parsed)
            low, high = low + points, high + points
    return low, high


def round_half_up(value, digits=0):
    """Rounding as a person does it by hand (0.5 goes up); Python's round() sends 0.5 to the even neighbour."""
    factor = 10 ** digits
    rounded = math.floor(value * factor + 0.5) if value >= 0 else -math.floor(-value * factor + 0.5)
    return rounded if digits == 0 else rounded / factor
