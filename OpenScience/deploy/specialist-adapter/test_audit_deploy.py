"""The optional audit signing secret is confined to the adapter services that sign."""
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
#: Every service built from this adapter; each signs the same way (gap E9).
ADAPTER_SERVICES = {
    "evimed-mr-agent",
    "evimed-bibliometric-agent",
    "evimed-research-topic-agent",
    "evimed-peer-review-agent",
    "evimed-drug-safety-agent",
}


def test_optional_audit_overlay_mounts_only_a_readonly_operator_file_into_every_adapter():
    overlay = yaml.safe_load((ROOT / "deploy/web/docker-compose.specialist-audit.yml").read_text())
    assert set(overlay["services"]) == ADAPTER_SERVICES
    base = yaml.safe_load((ROOT / "deploy/web/docker-compose.yml").read_text())
    built_here = {name for name, service in base["services"].items()
                  if (service.get("build") or {}).get("dockerfile") == "OpenScience/deploy/specialist-adapter/Dockerfile"}
    assert built_here == ADAPTER_SERVICES, "a new adapter service must sign like the others"
    for name in ADAPTER_SERVICES:
        service = overlay["services"][name]
        assert service["user"] == "0:0"
        assert set(service["cap_add"]) == {"SETUID", "SETGID"}
        assert service["environment"] == {
            "EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE": "/run/secrets/specialist-audit-signing-key"}
        assert service["volumes"] == [{"type": "bind",
            "source": "${OPEN_SCIENCE_SPECIALIST_AUDIT_SIGNING_KEY_HOST_FILE:?set a protected audit signing key file}",
            "target": "/run/secrets/specialist-audit-signing-key", "read_only": True,
            "bind": {"create_host_path": False}}]
        assert base["services"][name]["cap_drop"] == ["ALL"]
        assert base["services"][name]["security_opt"] == ["no-new-privileges:true"]
    for service in base["services"].values():
        assert "EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE" not in service.get("environment", {})
    example = (ROOT / "deploy/web/.env.example").read_text()
    assert "\nOPEN_SCIENCE_SPECIALIST_AUDIT_SIGNING_KEY_HOST_FILE=\n" in example
    assert "BEGIN PRIVATE KEY" not in example


def test_adapter_image_ships_public_fixture_and_pinned_signing_library():
    dockerfile = (ROOT / "deploy/specialist-adapter/Dockerfile").read_text()
    assert "COPY OpenScience/evals/capability-audit/fixtures/public_mr.json /adapter/fixtures/public_mr.json" in dockerfile
    assert "cryptography==49.0.0" in (ROOT / "deploy/specialist-adapter/requirements.txt").read_text().splitlines()


def test_both_images_pin_full_adapter_deployment_manifest():
    for name in ("Dockerfile", "Dockerfile.evidence"):
        source = (ROOT / "deploy/specialist-adapter" / name).read_text()
        assert "COPY OpenScience/deploy/specialist-adapter/Dockerfile OpenScience/deploy/specialist-adapter/Dockerfile.evidence OpenScience/deploy/specialist-adapter/requirements.txt /adapter/" in source
        assert "--write-adapter-manifest /adapter/adapter-evidence.json" in source
