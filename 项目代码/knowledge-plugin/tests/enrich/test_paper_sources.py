"""The paper text chain's readers of record: Europe PMC's JATS (``enrich.jats``), OpenAlex (``enrich.openalex``), the
Elsevier hook (``enrich.elsevier``) and what the transport adds for them (``fetch.py``)."""

from __future__ import annotations

import json
from dataclasses import replace

import httpx
import pytest

from knowledge_plugin.budget import HostBudget, MemoryCounterStore
from knowledge_plugin.enrich import elsevier, openalex
from knowledge_plugin.enrich.common import Endpoints, Trace
from knowledge_plugin.enrich.jats import jats_text
from knowledge_plugin.fetch import ProtectedFetcher
from knowledge_plugin.model import RequestSpec
from replay import load_case


def recorded(case: str, url_start: str) -> bytes:
    exchange = next(e for e in load_case(case).exchanges if e.spec.url.startswith(url_start))
    return exchange.result.body


# ------------------------------------------------------------------------------------------------------------- JATS

def test_europe_pmc_jats_as_paragraphs_with_section_titles_and_captions():
    abstract, body = jats_text(recorded("enrich/paper-fulltext-epmc", "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC"))
    assert abstract.split("\n")[0].startswith("Background: A variety of methods exist for the analysis of longitudinal")
    assert [line.split(":")[0] for line in abstract.split("\n")] == ["Background", "Methods", "Results and conclusions"]
    paragraphs = body.split("\n\n")
    titles = [p for p in paragraphs if p.startswith("## ")]
    assert titles[:4] == ["## Abstract", "## Introduction", "## Data and methods",
                          "## The Bayesian Bernoulli-Exponential joint model formulation and likelihood specification"]
    assert paragraphs[1] == abstract.split("\n")[0]                     # the abstract leads, one section a paragraph
    assert "Fig. 1 Deviance information criterion plot for keeping sample sizes fixed at 18 and examining influence " \
           "across priors and design schemes" in paragraphs
    assert any(p.startswith("Table 1 Parameter initial value scheme for simulations") for p in paragraphs)
    assert not any("<" in p or "ns0:" in p for p in paragraphs)        # no markup, no namespace residue
    assert "α is a vector of regression parameters" in body             # an inline formula keeps its MathML text


JATS = """<article xmlns:mml="http://www.w3.org/1998/Math/MathML"><front><article-meta>
<abstract abstract-type="graphical"><p>A graphical abstract.</p></abstract>
<abstract><title>Abstract</title><sec><title>Objective</title><p>To assess X.</p></sec><sec><title>Results</title><p>Y fell.</p></sec></abstract>
</article-meta></front><body>
<sec><title>Introduction</title><p>{text}</p>
<sec><title>Background</title><p>{text} See <xref ref-type="bibr">12</xref>.</p></sec></sec>
<sec sec-type="COI-statement"><title>Competing interests</title><p>None.</p></sec>
<sec><title>Funding</title><p>Grant 1.</p></sec>
<sec><title>Methods</title><p>{text}<disp-formula><mml:math><mml:mi>x</mml:mi></mml:math></disp-formula> where x is it.</p>
<fig><label>Figure 1</label><caption><title>Flow.</title><p>Patients screened.</p></caption><graphic/></fig>
<list><list-item><p>First point.</p></list-item><list-item><p>Second point.</p></list-item></list></sec>
</body><back><ack><p>Thanks.</p></ack><ref-list><ref><mixed-citation>A ref.</mixed-citation></ref></ref-list></back></article>"""


def test_jats_rules_back_matter_out_captions_and_list_items_in():
    abstract, body = jats_text(JATS.format(text="A sentence of the article. " * 40).encode())
    assert abstract == "Objective: To assess X.\nResults: Y fell."
    paragraphs = body.split("\n\n")
    assert [p for p in paragraphs if p.startswith("## ")] == ["## Abstract", "## Introduction", "## Background", "## Methods"]
    assert "Figure 1 Flow. Patients screened." in paragraphs and "First point." in paragraphs
    assert paragraphs[-1] == "Second point."
    assert not any(word in body for word in ("None.", "Grant 1.", "Thanks.", "A ref.", "graphical"))
    assert any(p.endswith("See 12.") for p in paragraphs)


def test_a_jats_body_that_is_one_line_is_no_whole_text():
    abstract, body = jats_text(b"<article><front><article-meta><abstract><p>An abstract of a scanned article.</p>"
                               b"</abstract></article-meta></front><body><p>The full text is in the PDF.</p></body></article>")
    assert abstract == "An abstract of a scanned article." and body is None
    assert jats_text(b"not xml at all") == (None, None)


# --------------------------------------------------------------------------------------------------------- OpenAlex

def test_openalex_rebuilds_the_inverted_index_by_position():
    assert openalex.rebuild_abstract({"trial.": [3], "A": [0], "randomized": [1], "controlled": [2]}) == \
        "A randomized controlled trial."
    assert openalex.rebuild_abstract({"Abstract": [0], "Background": [1], "Text.": [2]}) == "Background Text."
    assert openalex.rebuild_abstract(None) is None and openalex.rebuild_abstract({}) is None


def test_openalex_work_from_the_recorded_answer():
    payload = json.loads(recorded("enrich/paper-openalex", "https://api.openalex.org/works/"))
    work = openalex.parse_work(payload)
    assert work.abstract.startswith("Objective To study the reliability and validity") and len(work.abstract) == 1643
    assert work.oa_status == "diamond" and work.work_type == "article"       # the chain reads diamond as gold
    short = openalex.parse_work({"abstract_inverted_index": {"Short.": [0]}, "ids": {"pmcid": "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123"},
                                 "best_oa_location": {"license": "cc-by", "pdf_url": "https://x.example/a.pdf"}})
    assert short.abstract is None and short.pmcid == "PMC123" and short.license == "cc-by"
    assert short.pdf_url == "https://x.example/a.pdf"


def test_the_openalex_request_carries_no_identifier():
    url = openalex.work_url(Endpoints(), "10.1016/s1001-9294(22)00007-4")
    assert url.startswith("https://api.openalex.org/works/doi:10.1016/s1001-9294(22)00007-4?select=")
    assert "mailto" not in url and "@" not in url and "api_key" not in url


# --------------------------------------------------------------------------------------------------- the transport

PUBLIC = {"api.openalex.org": ["104.20.1.1"], "api.elsevier.com": ["104.20.1.2"], "www.example.org": ["93.184.216.34"]}


async def fake_resolver(host, port):
    return PUBLIC[host]


class NoSleep:
    async def __call__(self, seconds):
        return None


def fetcher_for(settings, requests: list, **overrides) -> ProtectedFetcher:
    def answer(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"ok": True})
    return ProtectedFetcher(replace(settings, **overrides), HostBudget(MemoryCounterStore(), {}, sleep=NoSleep()),
                            resolver=fake_resolver, transport_factory=lambda: httpx.MockTransport(answer))


async def test_openalex_gets_no_contact_address_even_when_one_is_configured(plain_settings):
    requests: list = []
    fetcher = fetcher_for(plain_settings, requests)
    await fetcher.fetch(RequestSpec(url="https://api.openalex.org/works/doi:10.1/x?select=id", api=True))
    sent = requests[-1]
    assert "mailto" not in sent.url.params and "crawler-contact" not in str(sent.url)
    await fetcher.aclose()


async def test_the_elsevier_key_goes_in_its_header_on_its_host_only(plain_settings, tmp_path):
    key = tmp_path / "elsevier.key"
    key.write_text("fake-elsevier-key-for-tests\n")
    requests: list = []
    fetcher = fetcher_for(plain_settings, requests, elsevier_key_file=str(key))
    await fetcher.fetch(RequestSpec(url=elsevier.article_url(Endpoints(), "10.1016/j.x.2026.1"), api=True,
                                    headers={"X-ELS-APIKey": "adapter-must-not-set-this"}))
    assert requests[-1].headers["x-els-apikey"] == "fake-elsevier-key-for-tests"
    await fetcher.fetch(RequestSpec(url="https://www.example.org/", api=True, headers={"X-ELS-APIKey": "nope"}))
    assert "x-els-apikey" not in requests[-1].headers
    await fetcher.aclose()


# ---------------------------------------------------------------------------------------------- the Elsevier hook

class Refusing:
    async def fetch(self, *args, **kwargs):
        raise AssertionError("no request without a key")


async def test_the_elsevier_hook_asks_nothing_without_a_key(plain_settings):
    assert not elsevier.configured(plain_settings)
    assert await elsevier.abstract_for(Refusing(), Endpoints(), "10.1016/j.x.2026.1", Trace(), plain_settings) is None


@pytest.mark.parametrize("doi, asked", [("10.1016/j.x.2026.1", True), ("10.1053/j.gastro.2026.1", True),
                                        ("10.1038/s41586-026-1", False)])
async def test_the_elsevier_hook_asks_only_for_its_prefixes(plain_settings, tmp_path, doi, asked):
    key = tmp_path / "elsevier.key"
    key.write_text("fake\n")
    settings = replace(plain_settings, elsevier_key_file=str(key))
    calls: list = []

    class Answering:
        async def fetch(self, spec, **kwargs):
            from knowledge_plugin.model import FetchResult
            calls.append(spec.url)
            body = json.dumps({"full-text-retrieval-response": {"coredata": {"dc:description": "Abstract " + "Text. " * 60}}})
            return FetchResult(request=spec, final_url=spec.url, status=200, headers={}, body=body.encode(), fetched_at=None)

    found = await elsevier.abstract_for(Answering(), Endpoints(), doi, Trace(), settings)
    assert bool(calls) is asked and (found is not None) is asked
    if asked:
        assert calls[0].endswith("?view=META_ABS&httpAccept=application/json")
