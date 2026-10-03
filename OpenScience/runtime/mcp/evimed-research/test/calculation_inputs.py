"""The inputs research_calculate's description promises, and what an executor says of them.

Shared by the calculation tests here, the control plane's contract test and the
replay adapter's tests. Every case is generated from `METHOD_INPUTS`, the table
the tool description is rendered from: an input the table describes must run,
and each one-step departure from it -- a required key dropped, an unread key
added, a value outside a key's alternatives -- must be refused.

`verdict` asks the replay adapter's own `compute` with the three numeric engines
replaced by stand-ins. The adapter checks an input before it hands it over, so
its checks decide alone and this suite needs none of the engines' dependencies;
what an engine refuses by itself (one study) is the adapter suite's to hold."""

from __future__ import annotations

import copy
import dataclasses
import json
import os
import pathlib
import sys
import tempfile
import types
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
ADAPTER = ROOT.parents[2] / "deploy" / "specialist-adapter"
for entry in (ROOT, ADAPTER):
    if str(entry) not in sys.path:
        sys.path.insert(0, str(entry))

import research_calculate  # noqa: E402
from evimed_specialist_adapter import deterministic_replay  # noqa: E402

PARAMETERS = {"maxNodes": 50, "yates": True, "correctZeroCells": True}
UNLISTED = "unlisted"


def _expand(shape, optional, stray=False):
    """The inputs a shape describes: its first alternatives, then each other alternative once.

    `optional` keeps the keys marked `?`; `stray` offers every closed vocabulary
    one value it does not list."""
    if isinstance(shape, tuple):
        values = [value for item in shape for value in _expand(item, optional, stray)]
        return values + [UNLISTED] if stray and all(isinstance(item, str) for item in shape) else values
    if isinstance(shape, list):
        rows = [_expand(item, optional, stray) for item in shape]
        first = [options[0] for options in rows]
        return [first] + [first[:index] + [value] + first[index + 1:]
                          for index, options in enumerate(rows) for value in options[1:]]
    if isinstance(shape, dict):
        fields = {key.removesuffix("?"): _expand(item, optional, stray)
                  for key, item in shape.items() if optional or not key.endswith("?")}
        first = {name: options[0] for name, options in fields.items()}
        return [first] + [{**first, name: value} for name, options in fields.items() for value in options[1:]]
    return [shape]


def _departures(value):
    """Each copy of an input with one key dropped or one unread key added, at every object in it."""
    if isinstance(value, dict):
        for key in value:
            yield {name: item for name, item in value.items() if name != key}
            for changed in _departures(value[key]):
                yield {**value, key: changed}
        yield {**value, "unexpected": 1}
    elif isinstance(value, list) and value:
        for changed in _departures(value[0]):
            yield [changed, *value[1:]]


def _unique(values):
    seen = {}
    for value in values:
        seen.setdefault(json.dumps(value, sort_keys=True), value)
    return list(seen.values())


def cases(method):
    """`admitted`: every input the method's description covers. `refused`: one step away from each."""
    spec = research_calculate.METHOD_INPUTS[method]
    required = _expand(spec["input"], optional=False)
    admitted = _unique([*required, *_expand(spec["input"], optional=True), *spec.get("also", ())])
    listed = {json.dumps(value, sort_keys=True) for value in admitted}
    refused = [value for value in _unique([
        *(changed for value in required for changed in _departures(value)),
        *_expand(spec["input"], optional=True, stray=True),
    ]) if json.dumps(value, sort_keys=True) not in listed]
    return {"admitted": admitted, "refused": refused}


def parameter_cases(method):
    """The parameter sets the description allows a method, and one step away from each."""
    accepted = research_calculate.METHOD_INPUTS[method].get("parameters", {})
    required = {name: PARAMETERS[name] for name in accepted.get("required", ())}
    full = {**required, **{name: PARAMETERS[name] for name in accepted.get("optional", ())}}
    return {"admitted": _unique([required, full]),
            "refused": [*({key: value for key, value in required.items() if key != name} for name in required),
                        {**full, "unexpected": 1}]}


@dataclasses.dataclass
class _Table:
    a: float
    b: float
    c: float
    d: float
    needs_correction = False


@dataclasses.dataclass
class _Statistic:
    value: float = 0.0


class _Pooled:
    def model_dump(self, mode=None):
        return {}

    def execution_metadata(self):
        return self


class _Graph:
    def number_of_nodes(self):
        return 0

    def number_of_edges(self):
        return 0


def _module(name, **members):
    module = types.ModuleType(name)
    module.__dict__.update(members)
    return module


def _stand_ins():
    """The engine modules `compute` imports, each returning something well-formed and empty."""
    def statistic(*_args, **_kwargs):
        return _Statistic()
    return {
        "new_meta.engines.meta_engine": _module("new_meta.engines.meta_engine", random_effects_dl=lambda *_args: _Pooled()),
        "new_meta.schemas.meta_result": _module("new_meta.schemas.meta_result", StudyEffect=dict),
        "safety_agent.signals.tables": _module("safety_agent.signals.tables", ContingencyTable2x2=_Table),
        "safety_agent.signals.disproportionality": _module(
            "safety_agent.signals.disproportionality", ror=statistic, prr=statistic, chi_square=statistic,
            information_component=statistic),
        "pandas": _module("pandas", DataFrame=list),
        "bibliometric.analysis.network_analyzer": _module(
            "bibliometric.analysis.network_analyzer", _build_graph=lambda *_args: _Graph(), _compute_centrality=dict),
    }


def verdict(method, value, parameters=None):
    """`admitted`, or the code the replay adapter's own validation refuses this input with."""
    with tempfile.TemporaryDirectory() as root, \
            mock.patch.dict(os.environ, {deterministic_replay.METHODS[method]["environment"]: root}), \
            mock.patch.dict(sys.modules, _stand_ins()), mock.patch.object(sys, "path", list(sys.path)):
        try:
            deterministic_replay.compute(method, copy.deepcopy(value), dict(parameters or {}))
        except deterministic_replay.ReplayError as error:
            return error.code
    return "admitted"
