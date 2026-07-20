"""Shared authentication and file-backed secret handling for EviMed adapters."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import stat
import time
from typing import Any

from fastapi import HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer


_BEARER = HTTPBearer(auto_error=False, scheme_name="EviMedWorkloadBearer")
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_SECRET_LIMIT = 8 * 1024


def _b64url_decode(value: str) -> bytes:
    if not value or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError("invalid base64url")
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if base64.urlsafe_b64encode(decoded).decode().rstrip("=") != value:
        raise ValueError("non-canonical base64url")
    return decoded


def _read_secret(path_value: str, *, minimum_bytes: int = 1) -> str:
    if not path_value or not os.path.isabs(path_value) or "\0" in path_value:
        raise RuntimeError("invalid secret file")
    descriptor = os.open(path_value, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > _SECRET_LIMIT:
            raise RuntimeError("invalid secret file")
        value = os.read(descriptor, _SECRET_LIMIT + 1).decode("utf-8")
    finally:
        os.close(descriptor)
    value = value[:-1] if value.endswith("\n") else value
    if (
        value != value.strip()
        or any(character in value for character in "\r\n\0")
        or len(value.encode("utf-8")) < minimum_bytes
    ):
        raise RuntimeError("invalid secret value")
    return value


def _signing_secret() -> str:
    return _read_secret(
        os.getenv("EVIMED_WORKLOAD_SIGNING_SECRET_FILE", "").strip(),
        minimum_bytes=32,
    )


def verify_workload_token(token: str, *, now_seconds: int | None = None) -> dict[str, Any]:
    try:
        if not isinstance(token, str) or len(token) > _SECRET_LIMIT:
            raise ValueError("invalid token")
        header_part, body_part, signature_part = token.split(".")
        signed = f"{header_part}.{body_part}"
        expected = base64.urlsafe_b64encode(
            hmac.new(_signing_secret().encode(), signed.encode(), hashlib.sha256).digest()
        ).decode().rstrip("=")
        if not hmac.compare_digest(signature_part, expected):
            raise ValueError("invalid signature")
        header = json.loads(_b64url_decode(header_part))
        payload = json.loads(_b64url_decode(body_part))
        if header != {"alg": "HS256", "typ": "JWT"}:
            raise ValueError("invalid header")
        if not isinstance(payload, dict) or set(payload) != {
            "v", "aud", "userId", "projectId", "iat", "exp", "jti"
        }:
            raise ValueError("invalid claims")
        now = int(time.time()) if now_seconds is None else int(now_seconds)
        if (
            payload["v"] != 1
            or payload["aud"] != "evimed-adapter"
            or not _SAFE_ID.fullmatch(payload["userId"])
            or not _SAFE_ID.fullmatch(payload["projectId"])
            or type(payload["iat"]) is not int
            or type(payload["exp"]) is not int
            or payload["iat"] > now + 30
            or payload["exp"] <= now
            or payload["exp"] <= payload["iat"]
            or payload["exp"] - payload["iat"] > 900
            or not isinstance(payload["jti"], str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{3,256}", payload["jti"])
        ):
            raise ValueError("invalid claims")
        return payload
    except (KeyError, TypeError, ValueError, json.JSONDecodeError, UnicodeDecodeError, RuntimeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Valid EviMed workload token required",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


def _authorized_claims(
    credentials: HTTPAuthorizationCredentials | None = Security(_BEARER),
) -> dict[str, Any]:
    if credentials is None or credentials.scheme.casefold() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Valid EviMed workload token required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return verify_workload_token(credentials.credentials)
