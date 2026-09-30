"""Ordinary specialist jobs need no signing secret or privilege-raising overlay."""
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
#: Every service built from this adapter records completed work the same way.
ADAPTER_SERVICES = {
    "evimed-mr-agent",
    "evimed-bibliometric-agent",
    "evimed-research-topic-agent",
    "evimed-peer-review-agent",
    "evimed-drug-safety-agent",
}


def test_worker_records_do_not_require_signing_keys_or_added_capabilities():
    assert not (ROOT / "deploy/web/docker-compose.specialist-audit.yml").exists()
    base = yaml.safe_load((ROOT / "deploy/web/docker-compose.yml").read_text())
    built_here = {name for name, service in base["services"].items()
                  if (service.get("build") or {}).get("dockerfile") == "OpenScience/deploy/specialist-adapter/Dockerfile"}
    assert built_here == ADAPTER_SERVICES
    for name in ADAPTER_SERVICES:
        assert base["services"][name]["cap_drop"] == ["ALL"]
        assert base["services"][name]["security_opt"] == ["no-new-privileges:true"]
    for service in base["services"].values():
        assert "EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE" not in service.get("environment", {})
    example = (ROOT / "deploy/web/.env.example").read_text()
    assert "OPEN_SCIENCE_SPECIALIST_AUDIT_SIGNING_KEY_HOST_FILE" not in example
    assert "BEGIN PRIVATE KEY" not in example


def test_adapter_image_ships_the_public_fixture_and_pinned_security_dependencies():
    dockerfile = (ROOT / "deploy/specialist-adapter/Dockerfile").read_text()
    assert "COPY OpenScience/evals/capability-audit/fixtures/public_mr.json /adapter/fixtures/public_mr.json" in dockerfile
    assert "cryptography==49.0.0" in (ROOT / "deploy/specialist-adapter/requirements.txt").read_text().splitlines()


def test_both_images_pin_full_adapter_deployment_manifest():
    for name in ("Dockerfile", "Dockerfile.evidence"):
        source = (ROOT / "deploy/specialist-adapter" / name).read_text()
        assert "COPY OpenScience/deploy/specialist-adapter/Dockerfile OpenScience/deploy/specialist-adapter/Dockerfile.evidence OpenScience/deploy/specialist-adapter/requirements.txt /adapter/" in source
        assert "--write-adapter-manifest /adapter/adapter-evidence.json" in source
