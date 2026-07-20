from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_pyproject_declares_supported_runtime_and_installable_cli() -> None:
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")

    assert 'requires-python = ">=3.10,<3.13"' in pyproject
    assert '[project.scripts]' in pyproject
    assert 'metaagent = "new_meta.main:main"' in pyproject
    assert '[project.optional-dependencies]' in pyproject
    assert 'test = [' in pyproject


def test_runtime_dependencies_do_not_pin_legacy_motor_stack() -> None:
    requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8")

    assert "motor==2.5.1" not in requirements
    assert "pymongo==3.12.3" not in requirements
    assert "motor>=3.6,<4" in requirements
    assert "pymongo>=4.9,<5" in requirements


def test_ci_validates_all_supported_python_minors() -> None:
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    assert 'python-version: ["3.10", "3.11", "3.12"]' in workflow
    assert "pip install -e .[test]" in workflow
    assert "python tests/test_deep.py" in workflow
    assert "python tests/test_e2e.py" in workflow
    assert "python -m pytest -q" in workflow


def test_reproducible_lockfile_is_tracked() -> None:
    lockfile = ROOT / "uv.lock"

    assert lockfile.exists()
    assert lockfile.stat().st_size > 1000

