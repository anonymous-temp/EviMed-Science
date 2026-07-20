import inspect
from pathlib import Path

import new_meta.main as main_module
import start


def test_cli_validation_methods_are_opt_in_not_hardcoded() -> None:
    source = inspect.getsource(main_module.main)

    assert "--allow-validating-methods" in source
    assert "args.allow_validating_methods" in source
    assert "allow_validating=True" not in source


def test_web_phase1_does_not_silently_enable_validating_methods() -> None:
    source = inspect.getsource(start._run_phase1_inner)

    assert "allow_validating=True" not in source
    assert "compile_project_method_plan(" in source


def test_repository_has_no_ordinary_entrypoint_validation_bypass() -> None:
    main_source = Path("new_meta/main.py").read_text(encoding="utf-8")
    web_source = Path("start.py").read_text(encoding="utf-8")

    # The single remaining True is confined to the explicitly benchmark-only
    # known-source recovery helper, never the ordinary CLI/Web orchestration.
    assert main_source.count("allow_validating=True") == 1
    assert web_source.count("allow_validating=True") == 0
