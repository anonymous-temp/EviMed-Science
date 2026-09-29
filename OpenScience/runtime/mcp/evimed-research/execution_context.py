"""Nonsecret context carried by the trusted native specialist tool wrapper."""
import re


def validate_context(value):
    fields = {"v", "sessionId", "callId", "rootCallId", "provider", "model", "reasoningEffort"}
    if (not isinstance(value, dict) or set(value) - fields or value.get("v") != 1
            or value.get("provider") != "deepseek-official"
            or value.get("model") not in {"deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"}
            or not isinstance(value.get("sessionId"), str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", value["sessionId"])
            or any(not isinstance(value.get(key), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}", value[key]) for key in ("callId", "rootCallId"))
            or ("reasoningEffort" in value and value["reasoningEffort"] not in {"off", "low", "high", "max"})):
        raise ValueError("invalid engine execution context")
    return dict(value)


def model_environment(context=None):
    """A per-call choice; never modify the runtime's shared environment."""
    import os
    selected = validate_context(context).get("reasoningEffort") if context is not None else None
    effort = selected or os.environ.get("EVIMED_MODEL_GATEWAY_REASONING_EFFORT", "high")
    if effort not in {"off", "low", "high", "max"}:
        raise ValueError("invalid managed reasoning effort")
    return {"LLM_ENABLE_THINKING": "false" if effort == "off" else "true",
            "LLM_REASONING_EFFORT": effort,
            "EVIMED_MODEL_GATEWAY_POLICY": "high-thinking" if effort in {"high", "max"} else "managed-thinking"}
