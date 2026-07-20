"""Sprint 0 repository hygiene checks.

These checks guard the highest-risk operational failures:
- secrets becoming accidentally trackable;
- requirements.txt regressing to a local `pip freeze` dump;
- the example environment file containing real-looking credentials.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_secret_and_runtime_paths_are_gitignored() -> None:
    paths = [".env", ".env.local", "deploy.env", "output/example.log"]
    result = subprocess.run(
        ["git", "check-ignore", *paths],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    ignored = set(result.stdout.splitlines())
    assert set(paths).issubset(ignored), result.stdout + result.stderr


def test_requirements_do_not_contain_local_freeze_paths() -> None:
    text = _read("requirements.txt")
    forbidden = [
        "file:///",
        "/conda-bld/",
        "C:/",
        "\\Users\\",
        "anaconda-",
        "conda ",
    ]
    for pattern in forbidden:
        assert pattern not in text


def test_env_example_is_present_and_sanitized() -> None:
    text = _read(".env.example")
    assert "LLM_API_KEY=" in text
    assert "MONGO_URI=" in text
    assert "OSS_ACCESS_KEY_SECRET=" in text

    secret_patterns = [
        r"sk-[A-Za-z0-9_-]{16,}",
        r"OSS_ACCESS_KEY_SECRET=.+\S",
        r"MONGO_URI=mongodb(?:\+srv)?://[^:\s]+:[^@\s]+@",
    ]
    for pattern in secret_patterns:
        assert not re.search(pattern, text)


def test_pubmed_config_does_not_ship_fake_contact_email() -> None:
    text = _read("new_meta/config.py")
    assert "metaagent@research.ai" not in text
