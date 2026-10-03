"""Nonsecret context carried by the trusted native specialist tool wrapper."""
import re

# The models a session can have run on are the ones the control plane's
# gateway certifies (`supportedDeepSeekModels`, apps/server/src/modelGateway.mjs)
# and its efforts are `MODEL_REASONING_EFFORTS`. A copy that named only the
# Flash ids refused every engine tool, the deterministic calculator included,
# on a deployment certified for deepseek-v4-pro. The check bounds caller
# metadata and nothing more: the control plane holds the model to the owning
# session, and an engine's own model is its launcher's setting, never read from
# here. apps/server/test/engineToolContract.test.mjs holds both sets to the
# control plane's, by name.
SUPPORTED_MODELS = frozenset({"deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro"})
REASONING_EFFORTS = frozenset({"off", "low", "high", "max"})
_FIELDS = {"v", "sessionId", "callId", "rootCallId", "provider", "model", "reasoningEffort"}
_SESSION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
_CALL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}")


class InvalidContext(ValueError):
    """Names the field that failed, so a refusal says what drifted."""

    def __init__(self, field):
        super().__init__("invalid engine execution context: " + field)
        self.field = field


def validate_context(value):
    if not isinstance(value, dict) or set(value) - _FIELDS:
        raise InvalidContext("fields")
    checks = {
        "v": type(value.get("v")) is int and value["v"] == 1,
        "provider": value.get("provider") == "deepseek-official",
        "model": isinstance(value.get("model"), str) and value["model"] in SUPPORTED_MODELS,
        "sessionId": isinstance(value.get("sessionId"), str) and _SESSION_ID.fullmatch(value["sessionId"]),
        "callId": isinstance(value.get("callId"), str) and _CALL_ID.fullmatch(value["callId"]),
        "rootCallId": isinstance(value.get("rootCallId"), str) and _CALL_ID.fullmatch(value["rootCallId"]),
        "reasoningEffort": "reasoningEffort" not in value or (
            isinstance(value["reasoningEffort"], str) and value["reasoningEffort"] in REASONING_EFFORTS),
    }
    for field, passed in checks.items():
        if not passed:
            raise InvalidContext(field)
    return dict(value)


def model_environment(context=None):
    """A per-call choice; never modify the runtime's shared environment."""
    import os
    selected = validate_context(context).get("reasoningEffort") if context is not None else None
    effort = selected or os.environ.get("EVIMED_MODEL_GATEWAY_REASONING_EFFORT", "high")
    if effort not in REASONING_EFFORTS:
        raise ValueError("invalid managed reasoning effort")
    return {"LLM_ENABLE_THINKING": "false" if effort == "off" else "true",
            "LLM_REASONING_EFFORT": effort,
            "EVIMED_MODEL_GATEWAY_POLICY": "high-thinking" if effort in {"high", "max"} else "managed-thinking"}
