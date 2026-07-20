import inspect

import new_meta.main as main_module
import start


def test_cli_dispatches_compiled_method_route_before_pairwise_selector() -> None:
    source = inspect.getsource(main_module.main)

    route_index = source.index("SynthesisRoute.METHOD_PLUGIN")
    delivery_index = source.index("run_method_delivery(")
    pairwise_index = source.index("_compute_cli_primary_effect_selection(")
    assert route_index < delivery_index < pairwise_index
    assert "method_delivery.phase.status" in source
    assert "auto_resolve_uncertainty=args.skip_confirm" in source


def test_web_dispatches_compiled_method_route_before_pairwise_selector() -> None:
    source = inspect.getsource(start._run_phase2_inner)

    route_index = source.index("SynthesisRoute.METHOD_PLUGIN")
    delivery_index = source.index("run_method_delivery(")
    pairwise_index = source.index("assess_risk_and_select_primary_effects(")
    assert route_index < delivery_index < pairwise_index
    assert "method_delivery.phase.status" in source


def test_shared_method_delivery_is_used_by_both_entrypoints() -> None:
    main_source = inspect.getsource(main_module.main)
    web_source = inspect.getsource(start._run_phase2_inner)

    assert "from new_meta.core.method_delivery import run_method_delivery" in main_source
    assert "from new_meta.core.method_delivery import run_method_delivery" in web_source
