"""The runtime's side of the hand-off to source intake.

A run preserves what it reads under `.evimed-sources/`; the researcher's knowledge
base is the project's `knowledge-base/`, which the runtime cannot write. So a
supplementary spreadsheet a run fetched was readable by that run alone. This offers
preserved files to the control plane (`sourceIntake` mode of the public-source
gateway, `apps/server/src/sourceIntakeHandoff.mjs`), which re-verifies each one
against its capture manifest and registers it the way an upload is registered:
parsed, indexed, searchable, and still there when the run is gone.

Only preserved paths and a group label cross; the control plane chooses where a
file lands. A refused file (a format the knowledge base cannot read) is its own
answer and the rest go on, and every file stays preserved whatever intake says. A
hand-off that cannot be made at all (no gateway, intake not composed in this
deployment, a timeout) is reported and never fails the retrieval it came from:
the files are still on disk and the run still has them.
"""

from __future__ import annotations

import json
import urllib.request

import public_sources
import source_outcome
import source_transport as transport

MAX_FILES = 40
DEADLINE_SECONDS = 40.0


def _unavailable(reason, how):
    return {"available": False, "reason": reason, "how": how}


def hand_off(group, files, *, deadline=None):
    """Offer preserved files to source intake. Returns a dict, never raises.

    `{available: True, registered, refused, results: [...]}` where each result is
    `{path, registered, knowledgePath, sourceId, duplicate, status}` or `{path,
    registered: False, reason}`; or `{available: False, reason, how}`.
    """
    files = list(dict.fromkeys(files))[:MAX_FILES]
    if not files:
        return {"available": True, "registered": 0, "refused": 0, "results": []}
    try:
        gateway = public_sources._gateway_settings()  # noqa: SLF001 - one token, one owner
    except public_sources.PublicSourceError as error:
        return _unavailable(error.code, "Source intake needs the platform gateway, which this runtime cannot reach (%s)." % error.code)
    if gateway is None:
        return _unavailable(
            "no_gateway", "Source intake is offered through the platform gateway, which this runtime does not have; the files are preserved and can be added to the knowledge base by uploading them.",
        )
    gateway_url, token = gateway
    deadline = deadline or transport.Deadline(DEADLINE_SECONDS)

    def open_response(timeout):
        request = urllib.request.Request(
            gateway_url,
            data=json.dumps({"sourceIntake": {"group": group, "files": files}}).encode("utf-8"),
            headers={
                "accept": "application/json", "authorization": "Bearer %s" % token,
                "content-type": "application/json", "user-agent": "EviMed-Research/1.2 (runtime connector)",
            },
            method="POST",
        )
        return public_sources._OPENER.open(request, timeout=min(max(float(timeout), 1), 60))  # noqa: SLF001

    def handle(response, _attempt, _waited):
        if response is None or transport._content_type(response) != "application/json":  # noqa: SLF001
            raise source_outcome.unavailable("Source intake answered with something that is not a result list.", scope="Source intake", reason="invalid_response", retryable=False)
        return json.loads(transport.read_body(response, max_bytes=512 * 1024, deadline=deadline, scope="Source intake").decode("utf-8"))

    try:
        answer = transport._run(  # noqa: SLF001 - the shared attempt loop; a registration is not retried
            open_response, handle, deadline=deadline, scope="Source intake", per_attempt=30, attempts=1, idempotent=False,
            accept_statuses=(), sleep=None, rng=None,
        )
    except (source_outcome.SourceError, source_outcome.Truncated, public_sources.PublicSourceError, ValueError) as error:
        return _unavailable(getattr(error, "reason", None) or getattr(error, "code", None) or "failed", "Source intake could not be reached (%s); the files stay preserved in the workspace." % error)
    results = answer.get("results") if isinstance(answer, dict) and isinstance(answer.get("results"), list) else []
    registered = sum(1 for entry in results if isinstance(entry, dict) and entry.get("registered"))
    return {"available": True, "registered": registered, "refused": len(results) - registered, "results": results}
