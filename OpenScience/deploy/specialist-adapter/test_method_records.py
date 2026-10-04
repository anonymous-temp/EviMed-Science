"""Method records, named refusals, diagnostics and the identity a result carries (N05).

Real engines, no stand-ins: the engine roots are the worktree's own sources, as in
test_deterministic_replay.py. The published numbers belong to their sources; where a number is
asserted here its source is named beside it.
"""
from __future__ import annotations

import hashlib
import inspect
import json
import math
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evimed_specialist_adapter import deterministic_replay as replay

WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
DOMAIN_RECORDS = WORKSPACE_ROOT / "OpenScience" / "packages" / "domain" / "src" / "method-records.json"
EXECUTED = ("meta.dl", "faers.signals", "bibliometric.network")
Z_975 = 1.959963984540054


@pytest.fixture(autouse=True)
def engines(monkeypatch):
    for environment, directory in [("EVIMED_REPLAY_META_ROOT", "meta"), ("EVIMED_REPLAY_SAFETY_ROOT", "药物安全分析agent"),
                                   ("EVIMED_REPLAY_BIBLIOMETRIC_ROOT", "文献剂量分析")]:
        monkeypatch.setenv(environment, str(WORKSPACE_ROOT / "项目代码" / directory))


def recipe(method, value, parameters=None):
    # The researcher's file as written: Python's json.dump emits NaN and Infinity unless told not to.
    blob = json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8")
    manifest = replay.manifest(method)
    return {"method": method, "version": "1", "input": {"path": "input.json", "sha256": replay.digest(blob)},
            "parameters": parameters or {}, "codeDigest": manifest["codeDigest"], "environmentDigest": manifest["environmentDigest"]}, blob


def run(method, value, parameters=None):
    frozen, blob = recipe(method, value, parameters)
    return replay.execute(frozen, blob)


def studies(pairs, ids=None):
    return [{"id": (ids or range(len(pairs)))[i].__str__(), "label": f"s{i}", "yi": y, "vi": v} for i, (y, v) in enumerate(pairs)]


def meta(pairs, measure="MD", ids=None):
    return {"studies": studies(pairs, ids), "effectMeasure": measure, "outcome": "outcome"}


def codes(output):
    return {item["code"] for item in output["result"]["diagnostics"]}


# -- the record ---------------------------------------------------------------------------------------

def test_the_adapter_ships_the_domains_records_byte_for_byte():
    assert (Path(replay.__file__).with_name(replay.RECORDS_FILE)).read_bytes() == DOMAIN_RECORDS.read_bytes()


@pytest.mark.parametrize("method", EXECUTED)
def test_a_record_names_what_a_method_needs_and_what_it_may_say(method):
    record = replay.method_records()[method]
    assert record["id"] == method and re.fullmatch(r"\d+\.\d+\.\d+", record["version"])
    for field in ("title", "estimand", "assumptions", "inputs", "refusals", "diagnostics", "dependencies", "references"):
        assert record[field], (method, field)
    assert record["seeded"] is False
    # Each assumption says what, if anything, checks it, and each such check exists.
    named = {item["code"] for item in record["refusals"]} | {item["code"] for item in record["diagnostics"]}
    for assumption in record["assumptions"]:
        for check in (part.strip() for part in assumption["checkedBy"].split(",")):
            if check != "none" and not check.startswith("output:"):
                assert check.split(":", 1)[1] in named, (method, assumption["id"], check)
    # Dependencies the record names are the packages the adapter measures.
    assert {name.lower() for name in record["dependencies"]} == {name.lower() for name in replay.METHODS[method]["packages"]}
    # A record is strings, integers and booleans only: a float would not hash alike in Python and JavaScript.
    def scalars(value):
        if isinstance(value, dict):
            for item in value.values():
                yield from scalars(item)
        elif isinstance(value, list):
            for item in value:
                yield from scalars(item)
        else:
            yield value
    assert all(type(item) in (str, int, bool) for item in scalars(record)), method


def test_the_digest_is_over_the_canonical_record_and_moves_with_it():
    identity = replay.record_identity("meta.dl")
    record = replay.method_records()["meta.dl"]
    assert identity == {"id": "meta.dl", "version": record["version"], "digest": hashlib.sha256(replay.canonical(record)).hexdigest()}
    changed = {**record, "version": "9.9.9"}
    assert hashlib.sha256(replay.canonical(changed)).hexdigest() != identity["digest"]


@pytest.mark.parametrize("method,value,parameters", [
    ("meta.dl", meta([(0, .1), (1, .1), (3, .1)]), {}),
    ("faers.signals", {"tables": [{"id": "T1", "a": 10, "b": 90, "c": 20, "d": 1880}]}, {}),
    ("bibliometric.network", {"edges": [{"source": "A", "target": "B", "weight": 2, "source_freq": 8, "target_freq": 7}]}, {"maxNodes": 5}),
])
def test_every_result_carries_its_methods_identity_no_seed_and_the_environment(method, value, parameters):
    output = run(method, value, parameters)
    identity = replay.record_identity(method)
    assert output["result"]["methodRecord"] == identity
    assert output["receipt"]["methodRecord"] == identity
    assert replay.manifest(method)["methodRecord"] == identity
    # Nothing here draws a random number, and the result says so rather than leaving a gap.
    assert output["result"]["seeded"] is False and output["result"]["seed"] is None and output["receipt"]["seed"] is None
    assert output["receipt"]["environment"]["packages"] and output["receipt"]["environment"]["python"]
    assert isinstance(output["result"]["diagnostics"], list)
    # The record is not part of the code digest: rewording a reference must not read as a changed engine.
    assert "adapter/method_records.json" not in {item["path"] for item in output["receipt"]["codeFiles"]}


def test_the_same_recipe_gives_the_same_bytes_including_its_diagnostics():
    value = meta([(0, .1), (1, .1), (3, .1)])
    first, second = run("meta.dl", value), run("meta.dl", value)
    assert first["receipt"]["outputDigest"] == second["receipt"]["outputDigest"]


# -- refusals: one calculation declined, under a name ---------------------------------------------------

REFUSALS = [
    ("meta.dl", meta([(0, .1)]), {}, "replay_single_study"),
    ("meta.dl", meta([(0, .1), (1, .1)], ids=["a", "a"]), {}, "replay_duplicate_study_ids"),
    ("meta.dl", meta([(0, .1), (1, 0)]), {}, "replay_nonpositive_variance"),
    ("meta.dl", meta([(0, .1), (1, -.2)]), {}, "replay_nonpositive_variance"),
    ("meta.dl", meta([(0, .1), (float("nan"), .1)]), {}, "replay_nonfinite_value"),
    ("meta.dl", meta([(0, .1), (1, float("inf"))]), {}, "replay_nonfinite_value"),
    ("faers.signals", {"tables": [{"id": "T", "a": 0, "b": 10, "c": 2, "d": 50}]}, {"correctZeroCells": False}, "replay_not_estimable"),
    ("faers.signals", {"tables": [{"id": "T", "a": 1, "b": 10, "c": 2, "d": 50}, {"id": "T", "a": 3, "b": 9, "c": 2, "d": 40}]}, {}, "replay_duplicate_table_ids"),
    ("faers.signals", {"tables": [{"id": "T", "a": 0, "b": 0, "c": 0, "d": 0}]}, {}, "replay_empty_table"),
    ("faers.signals", {"tables": [{"id": "T", "a": float("nan"), "b": 1, "c": 1, "d": 1}]}, {}, "replay_nonfinite_value"),
    ("bibliometric.network", {"edges": [{"source": "A", "target": "B", "weight": 1, "source_freq": 3, "target_freq": 3},
                                       {"source": "B", "target": "A", "weight": 2, "source_freq": 3, "target_freq": 3}]}, {"maxNodes": 5}, "replay_duplicate_edges"),
    ("bibliometric.network", {"edges": [{"source": "A", "target": "A", "weight": 1, "source_freq": 3, "target_freq": 3}]}, {"maxNodes": 5}, "replay_self_loop_edge"),
    ("bibliometric.network", {"edges": [{"source": "A", "target": "B", "weight": float("inf"), "source_freq": 3, "target_freq": 3}]}, {"maxNodes": 5}, "replay_nonfinite_value"),
]


@pytest.mark.parametrize("method,value,parameters,code", REFUSALS, ids=[f"{item[0]}:{item[3]}:{index}" for index, item in enumerate(REFUSALS)])
def test_a_calculation_the_data_cannot_support_is_declined_under_a_named_reason(method, value, parameters, code):
    with pytest.raises(replay.ReplayError) as refused:
        run(method, value, parameters)
    assert refused.value.code == code


def test_every_refusal_a_record_promises_is_one_the_executor_can_give_and_no_unlisted_one_is():
    promised = {method: {item["code"] for item in replay.method_records()[method]["refusals"]} for method in EXECUTED}
    reached = {}
    for method, _value, _parameters, code in REFUSALS:
        reached.setdefault(method, set()).add(code)
    for method in EXECUTED:
        assert reached[method] == promised[method], method
    # The only codes the dispatcher raises beyond a record's refusals are the generic ones about the request itself.
    generic = {"replay_input_invalid", "replay_method_unsupported", "replay_engine_unavailable", "replay_environment_unavailable"}
    raised = set(re.findall(r'ReplayError\("(replay_[a-z_]+)"\)', inspect.getsource(replay.compute))) | set(re.findall(r'nonpositive="(replay_[a-z_]+)"', inspect.getsource(replay.compute)))
    listed = set().union(*promised.values())
    assert raised - generic <= listed, raised - generic - listed
    assert {"replay_nonfinite_value"} <= set(re.findall(r'ReplayError\("(replay_[a-z_]+)"\)', inspect.getsource(replay._number)))


def test_a_refusal_never_changes_what_another_calculation_gets():
    good = meta([(0, .1), (1, .1), (3, .1)])
    before = run("meta.dl", good)["receipt"]["outputDigest"]
    with pytest.raises(replay.ReplayError):
        run("meta.dl", meta([(0, .1)]))
    assert run("meta.dl", good)["receipt"]["outputDigest"] == before


# -- diagnostics ----------------------------------------------------------------------------------------------

HINE = [(2.8026, 17.7575), (0.0, 37.5657), (1.9711, 8.1323), (1.7961, 10.8998), (3.5334, 8.0114), (4.4031, 6.1320)]
BCG_LIKE = [(-.89, .33), (-1.59, .19), (-1.35, .42), (-1.44, .020), (-.22, .051), (-.79, .0069), (-1.62, .22), (.012, .0040), (-.47, .056)]


def test_pooling_diagnostics_name_what_the_data_earned():
    two = run("meta.dl", meta([(0, .1), (1, .1)]))
    assert {"two_studies_fixed_effect_fallback", "prediction_interval_unavailable", "small_study_tests_not_run"} <= codes(two)
    three = run("meta.dl", meta([(0, .1), (1, .1), (3, .1)]))
    assert "few_studies" in codes(three) and "two_studies_fixed_effect_fallback" not in codes(three)
    homogeneous = run("meta.dl", meta(HINE, "RD"))
    assert "tau_squared_at_boundary" in codes(homogeneous) and "few_studies" not in codes(homogeneous)
    heterogeneous = run("meta.dl", meta(BCG_LIKE, "MD"))
    assert "heterogeneity_considerable" in codes(heterogeneous)
    dominated = run("meta.dl", meta([(0, 1), (1, 1), (.5, 1), (.4, 1e-4), (.6, 1)]))
    assert "dominant_study" in codes(dominated)
    twins = run("meta.dl", meta([(.5, .1), (.5, .1), (1, .2), (.2, .3), (.4, .25)]))
    assert "duplicate_effects" in codes(twins)
    raw = run("meta.dl", meta([(15, .1), (14, .1), (13, .2)], "OR"))
    assert "ratio_effect_on_raw_scale_suspected" in codes(raw)
    assert "ratio_effect_on_raw_scale_suspected" not in codes(run("meta.dl", meta([(15, .1), (14, .1), (13, .2)], "MD")))
    for output in (two, three, homogeneous, heterogeneous, dominated, twins, raw):
        listed = {item["code"] for item in replay.method_records()["meta.dl"]["diagnostics"]}
        assert codes(output) <= listed


def test_signal_diagnostics_name_what_the_table_earned():
    zero = run("faers.signals", {"tables": [{"id": "Z", "a": 0, "b": 50, "c": 10, "d": 940}]})
    assert {"zero_cell_corrected", "small_case_count"} <= codes(zero)
    small = run("faers.signals", {"tables": [{"id": "S", "a": 2, "b": 48, "c": 5, "d": 145}]})
    assert {"small_case_count", "chi_square_expected_count_below_5"} <= codes(small) and "zero_cell_corrected" not in codes(small)
    large = run("faers.signals", {"tables": [{"id": "L", "a": 189, "b": 10845, "c": 104, "d": 10933}]})
    assert codes(large) == set()
    several = run("faers.signals", {"tables": [{"id": "L", "a": 189, "b": 10845, "c": 104, "d": 10933}, {"id": "M", "a": 50, "b": 1000, "c": 200, "d": 50000}]})
    assert codes(several) == {"multiplicity_unadjusted"}
    listed = {item["code"] for item in replay.method_records()["faers.signals"]["diagnostics"]}
    assert codes(zero) | codes(small) | codes(several) <= listed
    assert {item["detail"]["tableId"] for item in zero["result"]["diagnostics"] if "detail" in item and "tableId" in item["detail"]} == {"Z"}


def test_network_diagnostics_name_what_the_graph_earned():
    def edge(a, b, w, fa, fb):
        return {"source": a, "target": b, "weight": w, "source_freq": fa, "target_freq": fb}
    impossible = run("bibliometric.network", {"edges": [edge("A", "B", 9, 3, 3)]}, {"maxNodes": 5})
    assert "cooccurrence_exceeds_frequency" in codes(impossible)
    tied = run("bibliometric.network", {"edges": [edge("A", "B", 1, 5, 5), edge("B", "C", 1, 5, 5), edge("C", "D", 1, 5, 5)]}, {"maxNodes": 3})
    assert "node_limit_cutoff_tie" in codes(tied)
    split = run("bibliometric.network", {"edges": [edge("A", "B", 2, 8, 7), edge("C", "D", 2, 6, 5)]}, {"maxNodes": 4})
    assert "disconnected_graph" in codes(split)
    empty = run("bibliometric.network", {"edges": [edge("A", "B", 1, 8, 1), edge("C", "D", 1, 8, 1)]}, {"maxNodes": 2})
    assert "no_edges_between_kept_nodes" in codes(empty) and empty["result"]["values"]["edgeCount"] == 0
    clean = run("bibliometric.network", {"edges": [edge("A", "B", 2, 8, 7), edge("B", "C", 3, 7, 6)]}, {"maxNodes": 5})
    assert codes(clean) == set()
    listed = {item["code"] for item in replay.method_records()["bibliometric.network"]["diagnostics"]}
    assert codes(impossible) | codes(tied) | codes(split) | codes(empty) <= listed


# -- reference cases through the adapter ----------------------------------------------------------------------

def test_dersimonian_laird_on_the_raudenbush_trials_matches_the_published_row():
    # Raudenbush (2009), Table 16.3, row DL: tau-squared 0.0259, mean 0.0893, SE 0.0558, z 1.6009, interval (-0.0200, 0.1987).
    # yi and vi are printed to four decimals, so the pooled values are good to about 1.5e-4.
    corpus = json.loads((WORKSPACE_ROOT / "项目代码" / "meta" / "validation" / "corpora" / "published_worked_examples.json").read_text(encoding="utf-8"))
    rows = next(case for case in corpus["cases"] if case["case_id"] == "raudenbush1985_expectancy")["studies"]
    output = run("meta.dl", meta([(row["yi"], row["vi"]) for row in rows], "MD"))
    values = output["result"]["values"]
    assert values["tau_squared"] == pytest.approx(0.0259, abs=1.5e-4)
    assert values["pooled_effect"] == pytest.approx(0.0893, abs=1.5e-4)
    assert (values["ci_lower"], values["ci_upper"]) == pytest.approx((-0.0200, 0.1987), abs=1.5e-4)
    assert values["pooled_effect"] / ((values["ci_upper"] - values["ci_lower"]) / (2 * Z_975)) == pytest.approx(1.6009, abs=1.5e-3)
    assert {item["key"] for item in output["machineValues"]} >= {"values.pooled_effect", "values.tau_squared"}


def test_signals_on_the_physicians_health_study_table_match_the_published_row():
    # Agresti, Categorical Data Analysis: odds ratio 1.832 (1.440, 2.331), Pearson chi-square 25.01.
    output = run("faers.signals", {"tables": [{"id": "PHS", "a": 189, "b": 10845, "c": 104, "d": 10933}]})
    row = output["result"]["values"][0]
    assert row["ror"]["value"] == pytest.approx(1.832, abs=5e-4)
    assert (row["ror"]["ci95_lower"], row["ror"]["ci95_upper"]) == pytest.approx((1.440, 2.331), abs=5e-4)
    assert row["chi2"]["value"] == pytest.approx(25.01, abs=5e-3)
    assert row["haldaneAnscombeApplied"] is False


def test_network_centralities_on_a_weighted_path_match_the_hand_derivation():
    # A-B weight 2, B-C weight 4, so distances (1/weight) are 0.5 and 0.25.
    # closeness = (n-1)/sum of distances: A 2/1.25, B 2/0.75, C 2/1.0; betweenness: only B lies between A and C;
    # degree centrality = degree/(n-1); weighted degree is the sum of weights. The engine rounds to four decimals.
    output = run("bibliometric.network", {"edges": [{"source": "A", "target": "B", "weight": 2, "source_freq": 5, "target_freq": 9},
                                                    {"source": "B", "target": "C", "weight": 4, "source_freq": 9, "target_freq": 6}]}, {"maxNodes": 3})
    centrality = output["result"]["values"]["centrality"]
    assert centrality["A"] == {"degree": 0.5, "betweenness": 0.0, "closeness": pytest.approx(1.6, abs=1e-4), "weighted_degree": 2}
    assert centrality["B"] == {"degree": 1.0, "betweenness": 1.0, "closeness": pytest.approx(2 / 0.75, abs=1e-4), "weighted_degree": 6}
    assert centrality["C"] == {"degree": 0.5, "betweenness": 0.0, "closeness": pytest.approx(2.0, abs=1e-4), "weighted_degree": 4}
