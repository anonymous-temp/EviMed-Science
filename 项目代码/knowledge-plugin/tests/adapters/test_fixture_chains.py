"""Every recorded adapter case is the answer to what the adapter itself asks.

For each case recorded through ``record.py``: ``plan()`` with the recorded registry row, state and
``now`` reproduces the first recorded request byte for byte, and ``parse()`` of each answer plans
exactly the next recorded request (or repeats it once when it named a short retry delay — the
scheduler's single same-poll retry). A fixture that drifted from the code, or code that drifted
from what was recorded, fails here first.
"""

from __future__ import annotations

import json
from collections import deque

import pytest

from knowledge_plugin.adapters import REGISTRY
from knowledge_plugin.model import FetchError
from replay import FIXTURES, load_case

NEGATIVE_CASES = {"crossref-issn/select-refused", "eutils-query/datetype-misspelled", "json-api/openfda-no-matches",
                  "europepmc/hitcount-probe", "evimed-api/no-key", "browser-list/cde-guidance-principles-refused"}
ADAPTER_CASES = sorted(
    str(path.parent.relative_to(FIXTURES)) for path in FIXTURES.rglob("provenance.json")
    if not str(path.parent.relative_to(FIXTURES)).startswith("enrich/")
    and str(path.parent.relative_to(FIXTURES)) not in NEGATIVE_CASES
)


def test_the_suite_found_the_recorded_cases():
    # A broken walk would make every parametrised test below vanish and the suite pass empty.
    assert len(ADAPTER_CASES) >= 40
    groups = {name.split("/")[0] for name in ADAPTER_CASES}
    assert groups >= {"crossref-issn", "eutils-query", "europepmc", "json-api", "rss", "atom", "html-list",
                      "browser-list", "evimed-api"}


def same_request(a, b):
    return (a.url, a.method.upper(), a.body or None, a.api) == (b.url, b.method.upper(), b.body or None, b.api)


@pytest.mark.parametrize("name", ADAPTER_CASES)
def test_plan_and_parse_reproduce_the_recorded_chain(name):
    """Replay the scheduler's order (FIFO queue of planned requests, ``next`` appended, one retry
    at the front) and require each recorded request to be exactly the one due next."""
    case = load_case(name)
    adapter = REGISTRY[case.source.access]
    queue = deque(adapter.plan(case.source, case.state, case.now))
    for index, exchange in enumerate(case.exchanges):
        assert queue, f"{name}: nothing was due before recorded exchange {index + 1}"
        due = queue.popleft()
        assert same_request(due, exchange.spec), f"{name}: exchange {index + 1} is not the request due"
        try:
            output = adapter.parse(exchange.result, case.source, case.now)
        except FetchError as error:
            assert error.retry_after_s is not None and error.retry_after_s <= 30
            queue.appendleft(due)  # the same request, retried once
            continue
        if output.next is not None:
            queue.append(output.next)


@pytest.mark.parametrize("name", ADAPTER_CASES)
def test_recorded_urls_carry_no_credentials(name):
    provenance = json.loads((FIXTURES / name / "provenance.json").read_text(encoding="utf-8"))
    for exchange in provenance["exchanges"]:
        for marker in ("api_key=", "email=", "mailto=", "tool="):
            assert marker not in exchange["url"]
