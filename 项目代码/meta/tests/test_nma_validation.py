import json
from pathlib import Path

import pytest

from new_meta.engines.nma import NMAEngine


@pytest.mark.parametrize("case_index", [0, 1])
def test_nma_matches_independent_netmeta_oracles(case_index: int) -> None:
    fixture = json.loads(
        Path("validation/corpora/netmeta_network_oracles.json").read_text(encoding="utf-8")
    )
    case = fixture["cases"][case_index]
    expected = case["expected"]
    tolerance = fixture["tolerances"]
    engine = NMAEngine(case["contrasts"], case["treatments"], reference=case["reference"])
    result = engine.fit_random_effects()
    league = {(item.treatment, item.comparator): item for item in result.league_table}
    ab = league[("A", "B")]
    ac = league[("A", "C")]
    dbt = result.diagnostics["design_by_treatment"]

    assert result.tau_squared == pytest.approx(
        expected["tau_squared"], abs=tolerance["tau_squared"]
    )
    assert ab.effect == pytest.approx(expected["a_vs_b"], abs=tolerance["effect"])
    assert (ab.ci_upper - ab.ci_lower) / (2 * 1.959963984540054) == pytest.approx(
        expected["a_vs_b_se"], abs=tolerance["standard_error"]
    )
    assert ac.effect == pytest.approx(expected["a_vs_c"], abs=tolerance["effect"])
    assert (ac.ci_upper - ac.ci_lower) / (2 * 1.959963984540054) == pytest.approx(
        expected["a_vs_c_se"], abs=tolerance["standard_error"]
    )
    assert dbt["q_inconsistency"] == pytest.approx(
        expected["q_inconsistency"], abs=tolerance["q"]
    )
    assert dbt["df"] == expected["df_inconsistency"]
    assert dbt["p_value"] == pytest.approx(expected["p_inconsistency"], abs=tolerance["p"])
