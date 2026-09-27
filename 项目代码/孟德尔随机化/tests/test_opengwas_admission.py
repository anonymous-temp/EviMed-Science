"""OpenGWAS readiness is decided before a job is accepted, not inside it.

Production ran for weeks with no OpenGWAS JWT while the adapter reported the
engine ready and accepted remote requests that could only fail. The helper the
adapter loads decides, without calling OpenGWAS, whether a token is usable and
whether a request needs one.
"""

from __future__ import annotations

import base64
import json

import pytest

import evimed_local_inputs as inputs

NOW = 1_790_000_000  # 2026-09-21


def jwt(claims: dict) -> str:
    def part(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return f"{part({'alg': 'RS256', 'typ': 'JWT'})}.{part(claims)}.signature"


def local(path: str, *, clumped: bool = True) -> dict:
    return {
        "type": "local_file",
        "path": path,
        "columnMapping": dict(inputs.STANDARD_MAPPING),
        "instrumentsPreclumped": clumped,
        **({"clumpingProvenance": "Provider declaration, r2 < 0.001."} if clumped else {}),
    }


LEGACY = {"exposure": "BMI", "outcome": "coronary heart disease"}
MIXED = {
    "exposure": "BMI",
    "outcome": "CHD",
    "exposureSource": local("data/bmi.csv"),
    "outcomeSource": {"type": "opengwas", "gwasId": "ieu-a-7"},
}
LOCAL_PRECLUMPED = {
    "exposure": "BMI",
    "outcome": "CHD",
    "exposureSource": local("data/bmi.csv"),
    "outcomeSource": local("data/chd.csv", clumped=False),
}


def test_a_missing_token_is_not_ready():
    for token in (None, "", "   "):
        assert inputs.opengwas_credential_state(token, now=NOW) == {
            "ready": False, "reason": "opengwas_token_missing", "expiresAt": None,
        }


def test_an_expired_token_is_the_same_outage_as_a_missing_one():
    state = inputs.opengwas_credential_state(jwt({"exp": NOW - 1}), now=NOW)
    assert state["ready"] is False
    assert state["reason"] == "opengwas_token_expired"
    assert state["expiresAt"].endswith("Z")


def test_a_live_token_is_ready_and_never_echoed():
    token = jwt({"exp": NOW + 14 * 86400, "sub": "researcher"})
    state = inputs.opengwas_credential_state(token, now=NOW)
    assert state["ready"] is True and state["reason"] is None
    assert token not in json.dumps(state)


def test_an_unreadable_token_is_left_for_opengwas_to_judge():
    assert inputs.opengwas_credential_state("not-a-jwt", now=NOW) == {
        "ready": True, "reason": None, "expiresAt": None,
    }


@pytest.mark.parametrize("request_", [LEGACY, MIXED], ids=["legacy-text", "opengwas-source"])
def test_a_request_that_reads_opengwas_is_blocked_by_name_without_a_token(request_):
    with pytest.raises(inputs.MRInputError) as blocked:
        inputs.require_admission_credential(
            request_, inputs.opengwas_credential_state(None, now=NOW)
        )
    assert blocked.value.code == "mr_input_remote_auth_required"
    assert str(blocked.value).startswith("blocked: OpenGWAS token missing.")


def test_an_expired_token_is_named_as_expired():
    with pytest.raises(inputs.MRInputError) as blocked:
        inputs.require_admission_credential(
            LEGACY, inputs.opengwas_credential_state(jwt({"exp": NOW - 60}), now=NOW)
        )
    assert str(blocked.value).startswith("blocked: OpenGWAS token expired (")


def test_two_preclumped_local_files_run_without_a_token():
    inputs.require_admission_credential(
        LOCAL_PRECLUMPED, inputs.opengwas_credential_state(None, now=NOW)
    )


def test_local_files_without_preclumping_still_name_the_missing_clumping():
    request_ = {**LOCAL_PRECLUMPED, "exposureSource": local("data/bmi.csv", clumped=False)}
    with pytest.raises(inputs.MRInputError) as refused:
        inputs.require_admission_credential(
            request_, inputs.opengwas_credential_state(None, now=NOW)
        )
    assert refused.value.code == "mr_input_clumping_required"


def test_a_usable_token_admits_every_shape():
    ready = inputs.opengwas_credential_state(jwt({"exp": NOW + 3600}), now=NOW)
    for request_ in (LEGACY, MIXED, LOCAL_PRECLUMPED):
        inputs.require_admission_credential(request_, ready)
