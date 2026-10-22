"""What a landing page says about its article (``enrich.article_html``), on pages recorded through the landing step.

``enrich/paper-pages`` holds an NEJM original article and a PNAS research article read through the browser exit (Atypon,
and Atypon's "core" layout), a BMJ Open article (HighWire), a PLOS Medicine article and an MDPI article that refused us
(403), each named by its DOI's handle record and read as ``text/html``. The smaller cases below are the rules on a few
lines of markup each.
"""

from __future__ import annotations

import pytest

from knowledge_plugin.adapters.base import decode_body
from knowledge_plugin.adapters.common import looks_truncated
from knowledge_plugin.enrich.article_html import (ABSTRACT_MAX, fit_body, heading_key, is_back_matter, read_article_page,
                                                  same_text)
from replay import load_case

CASE = "enrich/paper-pages"


def page(key: str):
    case = load_case(CASE)
    exchange = case.exchanges[case.provenance["pages"][key]["exchange"]]
    return exchange, read_article_page(decode_body(exchange.result), exchange.result.final_url)


def paragraphs(text: str | None) -> list[str]:
    return (text or "").split("\n\n")


def test_nejm_through_the_browser_the_abstract_section_not_the_cut_description():
    exchange, article = page("nejm-original-article")
    assert exchange.meta["egress"] == "browser"
    # dc.Description is the abstract cut at 200 characters and ending "..."; the page's own abstract section is whole.
    assert article.abstract_from == "section"
    sections = article.abstract.split("\n")
    assert sections[0].startswith("Background: Immune responses leading to food allergy may develop early in life")
    assert [s.split(":")[0] for s in sections] == ["Background", "Methods", "Results", "Conclusions"]
    assert article.body_text is None and article.license_url is None       # closed: the abstract and nothing more


def test_pnas_core_layout_the_abstract_not_the_significance_statement():
    _, article = page("pnas-research-article")
    assert article.abstract.startswith("Obesity is linked to complex interactions between an organism")
    assert "Understanding why some individuals are obesity susceptible" not in article.abstract
    assert article.license_url == "https://creativecommons.org/licenses/by-nc-nd/4.0/"
    titles = [p for p in paragraphs(article.body_text) if p.startswith("## ")]
    assert titles[:3] == ["## Abstract", "## Results",
                          "## AAV Knockdown of Nova1 and Nr1i3 in Muscle and Liver Reduced HFD–Induced Obesity and "
                          "Improved Glucose Intolerance."]
    assert "## Discussion" in titles and "## Materials and Methods" in titles
    # Atypon "core" writes paragraphs as <div role="paragraph">; the bibliography and acknowledgments are its own sections.
    assert len(article.body_text) > 30_000
    assert not any(t.startswith(("## References", "## Acknowledg", "## Information & Authors")) for t in titles)


def test_bmj_open_highwire_abstract_and_its_whole_text_without_the_figure_toolbar():
    _, article = page("bmjopen-research")
    assert article.abstract_from == "meta:citation_abstract"
    assert article.abstract.startswith("Introduction: Myogenous temporomandibular disorders (mTMDs) are common")
    assert article.license_url == "https://creativecommons.org/licenses/by-nc/4.0/"
    body = paragraphs(article.body_text)
    assert "## Methods and analysis" in body and "## Discussion" in body
    for furniture in ("Download figure", "Open in new tab", "Download powerpoint", "View inline", "View popup"):
        assert furniture not in body
    assert not any(p in body for p in ("## Ethics statements", "## Patient consent for publication", "## References"))


def test_plos_whole_text_without_image_links_or_bare_addresses():
    _, article = page("plos-medicine-research")
    assert article.abstract.startswith("Background: Existing risk stratification tools inadequately identify")
    assert article.license_url == "http://creativecommons.org/licenses/by/4.0/"
    body = paragraphs(article.body_text)
    assert body[0] == "## Abstract" and "## Author summary" in body and body[-1].startswith("In conclusion")
    assert not any(p in ("PNG larger image", "TIFF original image") or p.startswith("https://doi.org/") for p in body)


def test_a_refused_page_is_recorded_as_refused():
    case = load_case(CASE)
    record = case.provenance["pages"]["mdpi-ijms-article"]
    assert record["outcome"] == "blocked:http_403"


# ------------------------------------------------------------------------------------------------ the rules, in markup

ARTICLE = """<html><head><title>{title}</title><meta name="citation_title" content="{title}">{meta}</head>
<body>{body}</body></html>"""


def html(*, title: str = "A trial of something", meta: str = "", body: str = "") -> str:
    return ARTICLE.format(title=title, meta=meta, body=body)


LONG = ("This randomized trial assessed whether an intervention reduced mortality in adults admitted with the "
        "condition, compared with usual care, across twelve hospitals over two years of follow-up. ") * 2


def test_a_cut_description_is_an_excerpt_never_an_abstract():
    text = LONG[:197] + "..."
    assert looks_truncated(text)            # "..." counts again (it was dropped by the test until 2026-10-22)
    article = read_article_page(html(meta=f'<meta name="dc.description" content="{text}">'))
    assert article.abstract is None and article.excerpt == text


def test_the_title_given_again_as_the_description_is_neither():
    title = "Climate-driven rodent demography provides a general, transferable basis for predicting arenavirus spillover"
    article = read_article_page(html(title=title, meta=f'<meta name="dc.Description" content="{title}">'))
    assert article.abstract is None and article.excerpt is None


def test_a_whole_text_in_the_abstract_field_is_not_an_abstract():
    text = ("A sentence of the article, not of an abstract. " * 200).strip()
    assert len(text) > ABSTRACT_MAX
    article = read_article_page(html(meta=f'<meta name="citation_abstract" content="{text}">'))
    assert article.abstract is None


def test_og_description_counts_only_when_long_and_uncut():
    article = read_article_page(html(meta=f'<meta property="og:description" content="{LONG.strip()}">'))
    assert article.abstract == LONG.strip() and article.abstract_from == "og"
    short = read_article_page(html(meta='<meta property="og:description" content="A short teaser of the piece.">'))
    assert short.abstract is None


def test_the_meta_abstract_takes_the_page_section_s_headings():
    plain = "Background " + LONG + "Methods " + LONG
    section = f"<section class='abstract'><h2>Abstract</h2><h3>Background</h3><p>{LONG}</p><h3>Methods</h3><p>{LONG}</p></section>"
    article = read_article_page(html(meta=f'<meta name="dc.description" content="{plain}">', body=section))
    assert article.abstract_from == "meta:dc.description+section"
    assert article.abstract.split("\n")[0].startswith("Background: This randomized trial")
    assert article.abstract.split("\n")[1].startswith("Methods: This randomized trial")


def test_run_in_bold_headings_are_sections():
    body = ("<div class='ArticleContent'><div id='h1'><h2>Abstract</h2><p class='TitleInline'><strong>Background: </strong>"
            f"</p><p>{LONG}</p><p class='TitleInline'><strong>Methods: </strong></p><p>{LONG}</p></div></div>")
    article = read_article_page(html(body=body))
    assert article.abstract.startswith("Background: This randomized trial") and "\nMethods: " in article.abstract


def test_back_matter_titles_and_a_methods_subsection_that_only_sounds_like_one():
    for title in ("References", "Acknowledgements", "7. Funding", "Author contributions", "Conflict of interest statement",
                  "Declaration of competing interest", "Data availability statement", "Rights and permissions",
                  "Supplementary Material", "Ethics statements", "Patient consent for publication"):
        assert is_back_matter(title), title
    for title in ("2.3 Conflict resolution and evidence management", "Funding mechanisms in low-income settings",
                  "Results", "Discussion"):
        assert not is_back_matter(title), title
    assert heading_key("3.1. Study design") == "study design"


def test_the_whole_text_needs_a_cc_licence_and_a_body():
    sections = "".join(f"<h2>Section {i}</h2><p>{LONG}</p>" for i in range(8))
    cc = '<a rel="license" href="https://creativecommons.org/licenses/by/4.0/">CC BY</a>'
    article = read_article_page(html(body=f"<div class='c-article-body'>{sections}<h2>References</h2><ol class='references'>"
                                     f"<li>Ref one</li></ol></div>{cc}"))
    assert article.license_url == "https://creativecommons.org/licenses/by/4.0/"
    titles = [p for p in paragraphs(article.body_text) if p.startswith("## ")]
    assert titles == [f"## Section {i}" for i in range(8)]
    stub = read_article_page(html(body=f"<div class='c-article-body'><h2>Introduction</h2><p>{LONG}</p></div>{cc}"))
    assert stub.body_text is None                                           # a page without the body is not the text


def test_figure_labels_join_their_captions_and_tables_keep_only_theirs():
    sections = (f"<h2>Results</h2><p>{LONG * 6}</p><figure><figcaption>Fig. 2</figcaption>"
                "<div><p>Survival by arm.</p></div></figure><table><caption>Table 1 Baseline characteristics</caption>"
                "<tr><td><p>cell text</p></td></tr></table>"
                "<ul><li><a href='/x'>Download figure</a></li><li><a href='/y'>Open in new tab</a></li></ul>")
    article = read_article_page(html(body=f"<div class='c-article-body'>{sections}</div>"))
    body = paragraphs(article.body_text)
    assert "Fig. 2 Survival by arm." in body and "Table 1 Baseline characteristics" in body
    assert "cell text" not in body and "Download figure" not in body and "Open in new tab" not in body


def test_fit_body_gives_up_the_abstract_then_the_captions_then_says_it_is_a_part():
    text = "\n\n".join(["## Abstract", "a" * 50, "## Introduction", "b" * 50, "Fig. 1 Caption text", "## End", "c" * 50])
    assert fit_body(text, limit=len(text)) == (text, True)
    no_abstract, whole = fit_body(text, limit=len(text) - 10)
    assert whole and no_abstract.startswith("## Introduction") and "Fig. 1 Caption text" in no_abstract
    no_captions, whole = fit_body(text, limit=len(no_abstract) - 5)
    assert whole and "Fig. 1" not in no_captions and no_captions.endswith("c" * 50)
    part, whole = fit_body(text, limit=80)
    assert not whole and part == "## Introduction\n\n" + "b" * 50


@pytest.mark.parametrize("a, b, same", [
    ("Background This trial assessed mortality.", "Background: This trial assessed mortality.", True),
    ("BackgroundThis trial assessed mortality in adults.", "Background: This trial assessed mortality in adults.", True),
    ("A completely different text about rodents.", "Background: This trial assessed mortality.", False),
])
def test_same_text(a, b, same):
    assert same_text(a, b) is same
