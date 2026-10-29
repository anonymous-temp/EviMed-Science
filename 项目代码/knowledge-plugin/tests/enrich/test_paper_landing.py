"""The landing page's exit ladder and the chain's choices (``enrich.landing``, ``enrich._article``), on a scripted fetcher.

The pages themselves are recorded elsewhere (``test_paper_pages``, ``test_paper_chain``); what is tested here is which
requests are made, through which exit and in what order: the handle record first, ``Accept: text/html``, the source's
exit then the relay then the browser, a challenge or a refusal remembered per host, robots.txt and a 404 ending the
read, the browser not started without the time it needs, Elsevier's linkinghub forward, and the whole text taken only
under a Creative Commons licence.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from knowledge_plugin import enrich
from knowledge_plugin.enrich import landing
from knowledge_plugin.enrich.common import Endpoints, Trace
from knowledge_plugin.model import FetchError, FetchResult

NOW = datetime(2026, 10, 22, 8, 0, tzinfo=timezone.utc)
DOI = "10.1234/example.2026.1"
PAGE = "https://journal.example.org/article/10.1234/example.2026.1"
LONG = ("This randomized trial assessed whether an intervention reduced mortality in adults admitted with the "
        "condition, compared with usual care, across twelve hospitals over two years of follow-up. ") * 2


def article_html(*, abstract: str | None = LONG, body: bool = False, cc: bool = False) -> bytes:
    meta = f'<meta name="citation_abstract" content="{abstract}">' if abstract else ""
    sections = "".join(f"<h2>Section {i}</h2><p>{LONG}</p>" for i in range(8)) if body else ""
    licence = '<a rel="license" href="https://creativecommons.org/licenses/by/4.0/">CC BY</a>' if cc else ""
    return (f'<html><head><meta name="citation_title" content="A trial">{meta}</head><body>'
            f'<div class="c-article-body">{sections}</div>{licence}</body></html>').encode()


class Scripted:
    """Answers by (url, exit): a body (200 HTML), a ``FetchError``, or a JSON payload; records every request."""

    def __init__(self, answers: dict, exits=("direct", "relay", "browser")) -> None:
        self.answers = answers
        self.exits = set(exits)
        self.calls: list[dict] = []

    def egress_configured(self, egress: str) -> bool:
        return egress in self.exits

    async def fetch(self, spec, *, source_id=None, egress="direct", allowed_hosts=None, wait_for=None):
        self.calls.append({"url": spec.url, "egress": egress, "api": spec.api, "accept": spec.headers.get("Accept"),
                           "allowed": allowed_hosts})
        answer = self.answers.get((spec.url, egress), self.answers.get(spec.url))
        if answer is None and spec.api:      # the fetcher hands an API's 404 with a body to the caller (Crossref, OpenAlex)
            return FetchResult(request=spec, final_url=spec.url, status=404, headers={"content-type": "application/json"},
                               body=b'{"status": "not found"}', fetched_at=NOW)
        if answer is None:
            raise FetchError("http-error", "http_404", status=404)
        if isinstance(answer, FetchError):
            raise answer
        if isinstance(answer, dict):
            body, content_type, final = json.dumps(answer).encode(), "application/json", spec.url
        else:
            body, content_type, final = answer, "text/html; charset=utf-8", spec.url
        return FetchResult(request=spec, final_url=final, status=200, headers={"content-type": content_type},
                           body=body, fetched_at=NOW)


def handle(url: str) -> dict:
    return {"responseCode": 1, "values": [{"type": "URL", "data": {"value": url}}]}


HANDLE = landing.handle_url(Endpoints(), DOI)


async def read(fetcher, **kwargs):
    trace = Trace()
    result = await landing.read_landing(fetcher, Endpoints(), DOI, egress=kwargs.pop("egress", "direct"), trace=trace,
                                        verdicts=kwargs.pop("verdicts", landing.HostVerdicts()), **kwargs)
    return result, trace


async def test_the_handle_names_the_page_and_the_page_is_asked_as_html():
    fetcher = Scripted({HANDLE: handle(PAGE), PAGE: article_html()})
    result, _ = await read(fetcher)
    assert result.outcome == "read" and result.page.abstract == LONG.strip() and result.egress == "direct"
    assert [(c["url"], c["api"]) for c in fetcher.calls] == [(HANDLE, True), (PAGE, False)]
    assert fetcher.calls[1]["accept"].startswith("text/html")


async def test_without_a_handle_record_the_doi_resolver_is_asked():
    fetcher = Scripted({f"https://doi.org/{DOI}": article_html()})
    result, trace = await read(fetcher)
    assert result.outcome == "read" and fetcher.calls[-1]["url"] == f"https://doi.org/{DOI}"
    assert trace.notes == ["doi_handle_http_404"]


async def test_a_challenge_moves_to_the_relay_then_the_browser_with_the_site_s_hosts():
    challenge = FetchError("challenge", "cloudflare", status=403)
    fetcher = Scripted({HANDLE: handle(PAGE), (PAGE, "direct"): challenge,
                        (PAGE, "relay"): FetchError("blocked", "http_403", status=403), (PAGE, "browser"): article_html()})
    verdicts = landing.HostVerdicts()
    result, trace = await read(fetcher, verdicts=verdicts)
    assert result.outcome == "read" and result.egress == "browser"
    assert [c["egress"] for c in fetcher.calls[1:]] == ["direct", "relay", "browser"]
    assert fetcher.calls[-1]["allowed"] == ["example.org"]
    assert trace.notes == ["landing_challenge:direct", "landing_blocked:relay"]
    # Remembered for the host: the next article of the same journal goes straight to the browser.
    again = Scripted({HANDLE: handle(PAGE), (PAGE, "browser"): article_html()})
    result, _ = await read(again, verdicts=verdicts)
    assert result.outcome == "read" and [c["egress"] for c in again.calls[1:]] == ["browser"]


async def test_an_exit_that_fails_is_passed_over_not_the_end_of_the_read():
    fetcher = Scripted({HANDLE: handle(PAGE), (PAGE, "direct"): FetchError("challenge", "cloudflare", status=403),
                        (PAGE, "relay"): FetchError("blocked", "edge_proxy_unreachable"), (PAGE, "browser"): article_html()})
    result, trace = await read(fetcher)
    assert result.outcome == "read" and result.egress == "browser"
    assert trace.notes == ["landing_challenge:direct", "landing_exit_failed:relay:edge_proxy_unreachable"]


async def test_a_challenge_on_every_exit_is_the_answer():
    challenge = FetchError("challenge", "cloudflare", status=403)
    fetcher = Scripted({HANDLE: handle(PAGE), PAGE: challenge})
    verdicts = landing.HostVerdicts()
    result, trace = await read(fetcher, verdicts=verdicts)
    assert result.outcome == "challenge" and trace.notes[-1] == "landing_challenge"
    cached = Scripted({HANDLE: handle(PAGE), PAGE: challenge})
    result, trace = await read(cached, verdicts=verdicts)
    assert result.outcome == "challenge" and [c["url"] for c in cached.calls] == [HANDLE]
    assert trace.notes == ["landing_challenge_cached"]


async def test_a_verdict_expires():
    clock = [0.0]
    verdicts = landing.HostVerdicts(clock=lambda: clock[0])
    verdicts.record("journal.example.org", "direct")
    assert verdicts.refused("journal.example.org", "direct")
    clock[0] += landing.VERDICT_TTL_S + 1
    assert not verdicts.refused("journal.example.org", "direct")


@pytest.mark.parametrize("error, outcome, note", [
    (FetchError("robots-denied", "robots_disallow"), "robots", "landing_robots"),
    (FetchError("http-error", "http_404", status=404), "not_found", "landing_http-error:http_404"),
    (FetchError("timeout", "timeout"), "transient", "landing_transient:timeout"),
])
async def test_robots_a_404_or_a_timeout_end_the_read(error, outcome, note):
    fetcher = Scripted({HANDLE: handle(PAGE), PAGE: error})
    result, trace = await read(fetcher)
    assert result.outcome == outcome and trace.notes == [note]
    assert [c["egress"] for c in fetcher.calls[1:]] == ["direct"]           # no other exit is tried


async def test_a_shell_without_article_metadata_moves_on_an_article_page_without_an_abstract_does_not():
    shell = b"<html><head><title>Loading</title></head><body><div id='app'></div></body></html>"
    fetcher = Scripted({HANDLE: handle(PAGE), (PAGE, "direct"): shell, (PAGE, "relay"): article_html()})
    result, trace = await read(fetcher)
    assert result.outcome == "read" and result.egress == "relay" and trace.notes == ["landing_shell:direct"]
    bare = Scripted({HANDLE: handle(PAGE), PAGE: article_html(abstract=None)})
    result, _ = await read(bare)
    assert result.outcome == "read" and result.page.abstract is None and len(bare.calls) == 2


async def test_the_browser_is_not_started_without_the_time_a_render_needs():
    challenge = FetchError("challenge", "cloudflare", status=403)
    fetcher = Scripted({HANDLE: handle(PAGE), (PAGE, "direct"): challenge, (PAGE, "relay"): challenge,
                        (PAGE, "browser"): article_html()})
    result, trace = await read(fetcher, deadline=100.0, clock=lambda: 50.0)
    assert result.outcome == "deferred" and trace.notes[-1] == "landing_deferred:browser"
    assert [c["egress"] for c in fetcher.calls[1:]] == ["direct", "relay"]


async def test_a_fetcher_that_names_no_exits_reads_through_its_own_and_api_is_direct():
    class OneExit(Scripted):
        egress_configured = None

    fetcher = OneExit({HANDLE: handle(PAGE), PAGE: FetchError("challenge", "cloudflare", status=403)})
    result, _ = await read(fetcher, egress="api")
    assert result.outcome == "challenge" and [c["egress"] for c in fetcher.calls[1:]] == ["direct"]


async def test_elsevier_s_linkinghub_page_forwards_to_its_target():
    hub = "https://linkinghub.elsevier.com/retrieve/pii/S0000000000000001"
    target = "https://www.journal.example.org/article/S0000000000000001/fulltext"
    forward = (f'<html><body><form><input type="hidden" name="redirectURL" value="'
               f'{target.replace(":", "%3A").replace("/", "%2F")}"></form></body></html>').encode()
    fetcher = Scripted({HANDLE: handle(hub), hub: forward, target: article_html()})
    result, _ = await read(fetcher)
    assert result.outcome == "read" and result.url == target
    assert [c["url"] for c in fetcher.calls] == [HANDLE, hub, target]


def test_site_hosts():
    assert landing.site_hosts("https://academic.oup.com/cid/x", "https://www.nature.com/a") == ["oup.com", "nature.com"]
    assert landing.site_hosts("https://www.bmj.co.uk/x") == ["bmj.co.uk"]
    assert landing.site_hosts(None, "not a url") == []


# ------------------------------------------------------------------------------------------- the chain's choices

def entry(**over) -> dict:
    row = {"entry_id": "e1", "revision": 1, "source_id": "j-test", "doi": DOI, "pmid": None, "url": f"https://doi.org/{DOI}",
           "summary": None, "title": "A trial", "registry_ids": [], "first_seen_at": NOW, "attempts": 0,
           "source_access": "crossref-issn", "source_egress": "direct", "source_type": "journal", "source_config": {}}
    row.update(over)
    return row


class ChainFetcher(Scripted):
    """Every index answers nothing (PubMed, Europe PMC, Crossref 404s, OpenAlex 404); the page is scripted."""

    async def fetch(self, spec, **kwargs):
        if spec.url.startswith("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"):
            return FetchResult(request=spec, final_url=spec.url, status=200, headers={"content-type": "application/json"},
                               body=b'{"esearchresult": {"idlist": []}}', fetched_at=NOW)
        if spec.url.startswith("https://www.ebi.ac.uk/europepmc/webservices/rest/search"):
            return FetchResult(request=spec, final_url=spec.url, status=200, headers={"content-type": "application/json"},
                               body=b'{"hitCount": 0, "resultList": {"result": []}}', fetched_at=NOW)
        return await super().fetch(spec, **kwargs)


async def test_a_closed_page_s_body_is_never_taken_an_open_cc_one_is():
    closed = ChainFetcher({HANDLE: handle(PAGE), PAGE: article_html(body=True, cc=False)})
    (result,) = await enrich.enrich_batch([entry()], closed, None, now=NOW)
    assert (result.status, result.text_kind, result.fetched_from) == ("available", "abstract", "landing")
    assert result.body_text is None
    open_ = ChainFetcher({HANDLE: handle(PAGE), PAGE: article_html(body=True, cc=True)})
    (result,) = await enrich.enrich_batch([entry()], open_, None, now=NOW)
    assert (result.status, result.text_kind, result.fetched_from) == ("available", "full", "landing")
    assert result.body_text.startswith("## Abstract\n\n") and "\n\n## Section 7\n\n" in result.body_text


async def test_without_an_abstract_the_page_is_read_on_the_first_attempt_and_every_fourth():
    for attempts, reads in ((0, True), (1, False), (2, False), (3, False), (4, True)):
        fetcher = ChainFetcher({HANDLE: handle(PAGE), PAGE: article_html(abstract=None)})
        (result,) = await enrich.enrich_batch([entry(attempts=attempts)], fetcher, None, now=NOW)
        assert any(c["url"] == PAGE for c in fetcher.calls) is reads, attempts
        assert result.status == "pending" and result.retry_after_s == 12 * 3600


async def test_a_landing_read_without_time_left_is_asked_again_within_the_hour(monkeypatch):
    ticks = iter([0.0] + [1_000.0] * 50)
    monkeypatch.setattr(enrich, "monotonic", lambda: next(ticks))
    fetcher = ChainFetcher({HANDLE: handle(PAGE), PAGE: article_html()})
    (result,) = await enrich.enrich_batch([entry()], fetcher, None, now=NOW)
    assert result.status == "pending" and result.retry_after_s == 3600
    assert "landing_deferred:direct" in result.notes and not any(c["url"] == PAGE for c in fetcher.calls)


async def test_a_provisional_text_is_upgraded_by_an_index_s_abstract_only():
    fetcher = ChainFetcher({HANDLE: handle(PAGE), PAGE: article_html(abstract=None)})
    (result,) = await enrich.enrich_batch([entry(upgrade=True, text_status="available")], fetcher, None, now=NOW)
    # Nothing new in the indexes: the stored text stays (no text in the answer), asked again in 12 hours.
    assert result.status == "available" and result.abstract is None and result.retry_after_s == 12 * 3600
    assert "upgrade_not_yet" in result.notes and not any(c["url"] == PAGE for c in fetcher.calls)
    late = entry(upgrade=True, text_status="available", first_seen_at=NOW.replace(day=1))
    (result,) = await enrich.enrich_batch([late], ChainFetcher({}), None, now=NOW)
    assert result.status == "available" and result.retry_after_s is None      # past the horizon: no more asking
