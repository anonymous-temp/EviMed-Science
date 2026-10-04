"""A researcher's own connector credential reaches one MetaAgent job.

Owner ruling 2026-10-04: a data source nobody configured is the researcher's to
configure where they use it, and the job goes on in place. The other engines got
that path first (``deploy/specialist-adapter``'s ``_job_credentials``); MetaAgent
had none, so a researcher who had saved their own EviMed evidence key (or NCBI
key) in 设置 → 数据源 was served exactly like one who had not, and the result
said nothing.

How it works, in the same shape as the adapter's: at start the adapter asks the
control plane (``EVIMED_CONNECTOR_CREDENTIAL_URL``) for each connector below with
the workload token the runtime handed it, which names the researcher and proves a
runtime of theirs is live. The answer is the researcher's own key or nothing, and
it travels to the job's worker through its spawn environment only, under a prefix;
the worker maps it onto the variable the engine reads and the prefixed name does
not survive. It is never written to the job's state file and never logged. The
deployment's own key, where this container has one, wins and nothing is asked.

Standard library only, held to the connectors the control plane answers for
(``JOB_SCOPED_CONNECTORS`` in ``apps/server/src/connectorCredentials.mjs``; a test
in the control plane's suite reads this table).
"""
from __future__ import annotations

import json
import os
import re
import stat
import urllib.error
import urllib.request
from typing import Any, Callable

CREDENTIAL_URL_ENV = "EVIMED_CONNECTOR_CREDENTIAL_URL"
#: Prefix of the spawn-environment entries; the worker maps each onto `CONNECTORS[...]`.
PREFIX = "EVIMED_JOB_CREDENTIAL_"
#: connector id -> the variable the engine reads (`new_meta/config.py`).
CONNECTORS = {
    "ncbi": "PUBMED_API_KEY",
    "evimed-evidence": "EVIMED_API_KEY",
}
_SECRET_LIMIT = 8 * 1024
_RESPONSE_LIMIT = 64 * 1024


def _file_value(location: str) -> str:
    """One credential line from an absolute regular file; empty when there is none to read."""
    if not location or not os.path.isabs(location) or "\0" in location:
        return ""
    try:
        descriptor = os.open(location, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return ""
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= _SECRET_LIMIT:
            return ""
        raw = os.read(descriptor, _SECRET_LIMIT + 1).decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return ""
    finally:
        os.close(descriptor)
    value = raw[:-1] if raw.endswith("\n") else raw
    return value if value and value == value.strip() and not re.search(r"[\r\n\0]", value) else ""


def deployment_holds(env_name: str, environ: dict[str, str] | None = None) -> bool:
    """Whether this container carries a value for the engine variable: set directly, or by a readable ``<NAME>_FILE``.

    An engine reads a direct value before the file, so a researcher's key must not
    be handed over where the deployment already holds one either way.
    """
    environ = os.environ if environ is None else environ
    return bool(str(environ.get(env_name) or "").strip()) or bool(_file_value(str(environ.get(f"{env_name}_FILE") or "").strip()))


def resolve(
    workload_token: str | None,
    *,
    environ: dict[str, str] | None = None,
    opener: Callable[..., Any] | None = None,
) -> dict[str, str]:
    """The researcher's own keys for this job, as spawn-environment entries; ``{}`` when there are none.

    Never raises and never fails a job: a control plane without the endpoint, a
    connector nobody configured, a slow answer, a malformed one -- each leaves the
    engine on this container's own environment, exactly as before.
    """
    environ = os.environ if environ is None else environ
    url = str(environ.get(CREDENTIAL_URL_ENV) or "").strip()
    wanted = {connector: name for connector, name in CONNECTORS.items() if not deployment_holds(name, environ)}
    if not url or not workload_token or not wanted:
        return {}
    resolved: dict[str, str] = {}
    for connector, name in wanted.items():
        request = urllib.request.Request(
            f"{url}?connector={connector}",
            headers={"accept": "application/json", "Authorization": f"Bearer {workload_token}"},
            method="GET",
        )
        try:
            with (opener or urllib.request.urlopen)(request, timeout=10) as response:  # noqa: S310 — operator-configured internal URL
                payload = json.loads(response.read(_RESPONSE_LIMIT).decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError, TimeoutError):
            continue
        value = payload.get("data", {}).get("value") if isinstance(payload, dict) and isinstance(payload.get("data"), dict) else None
        if isinstance(value, str) and value and len(value) <= _SECRET_LIMIT and not re.search(r"[\r\n\0\s]", value):
            resolved[f"{PREFIX}{name}"] = value
    return resolved


def apply(environ: dict[str, str] | Any = None) -> None:
    """In the worker, before the engine starts: put each prefixed key where the engine reads it, and drop the prefixed name."""
    environ = os.environ if environ is None else environ
    for name in list(environ):
        if name.startswith(PREFIX):
            value = environ.pop(name)
            target = name[len(PREFIX):]
            if target in CONNECTORS.values() and value and not deployment_holds(target, environ):
                environ[target] = value
