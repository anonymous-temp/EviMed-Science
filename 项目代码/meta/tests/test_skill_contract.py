from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills" / "meta-analysis-agent" / "SKILL.md"
OPENAI_YAML = ROOT / "skills" / "meta-analysis-agent" / "agents" / "openai.yaml"


def test_repository_contains_thin_topic_to_article_skill() -> None:
    text = SKILL.read_text(encoding="utf-8")

    assert "name: meta-analysis-agent" in text
    assert "[TODO" not in text
    assert "/Users/wangzeyuan/Desktop/meta" in text
    assert '.venv/bin/metaagent --topic "<topic>"' in text
    assert "multiple clinically distinct analysis sets" in text
    assert "context-dependent certainty domains" in text
    assert "Never enable benchmark mode" in text
    assert "permissions, principals, signatures, or release approvals" in text


def test_skill_ui_metadata_invokes_the_named_skill() -> None:
    text = OPENAI_YAML.read_text(encoding="utf-8")

    assert 'display_name: "Meta-Analysis Agent"' in text
    assert "$meta-analysis-agent" in text
