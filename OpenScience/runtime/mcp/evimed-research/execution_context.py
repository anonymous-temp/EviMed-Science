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
