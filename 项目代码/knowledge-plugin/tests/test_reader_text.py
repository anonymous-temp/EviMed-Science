"""The text the reader shows, as paragraphs (2026-10-22 audit of the 23,948 published texts).

Each test is one class of defect the audit found, with the real shape of the source that produced it:

- WeChat's ``article_detail`` light HTML (``content``) splits a paragraph at every styled run; the article's own HTML
  (``content_multi_text``) does not. Both shapes below are cut from the answer for 丁香园肿瘤时间's 2026-10-21 article
  on bepirovirsen.
- A list bullet in a block of its own belongs to the line it marks.
- Crossref's JAMA abstracts escape an entity twice inside JATS (``&amp;amp;lt;``).
- Soft hyphens (Endpoints News) are not part of a word.
- Structured abstracts keep their sections as paragraphs: JATS ``<sec><title>``, Europe PMC ``<h4>``, PubMed labels.
- A page's main text is trafilatura's, unless the container reading is several times longer.
"""

from __future__ import annotations

from knowledge_plugin.adapters.common import clean_markup, structured_abstract
from knowledge_plugin.enrich.crossref import jats_abstract
from knowledge_plugin.enrich.europepmc import result_enrichment
from knowledge_plugin.enrich.page import FALLBACK_RATIO, MIN_EXCERPT, container_text, extracted_text, main_text
from knowledge_plugin.normalize import clean_body, clean_text
from knowledge_plugin.social.wechat import body_of

# The light HTML (mode 1), as Dajiala answered it: one <p> per styled run, and the article's images between them.
WECHAT_LIGHT = (
    '<p>当地时间 10 月 20 日，GSK 宣布，其下反义寡核苷酸</p>\n<img src="https://mmbiz.qpic.cn/a/640" />\n<p>（ASO）</p>\n'
    '<p>创新药</p>\n<p>Bepirovirsen</p>\n<p>（</p>\n<p>贝</p>\n<p>普若韦生）</p>\n<p>已获得美国 FDA 正式批准上市，</p>\n'
    '<p>截图来源：GSK 官网</p>\n<p>慢性乙型肝炎是全球范围内亟待解决的重大公共卫生问题。</p>'
)
# The same paragraphs in the article's own HTML: the runs are <span>s inside one <p>; images sit in their own <section>.
WECHAT_ORIGINAL = (
    '<section style="text-align: center;" nodeleaf=""><img class="rich_pages wxw-img" data-src="https://mmbiz.qpic.cn/a/640" /></section>'
    '<p style="margin: 0px 8px;line-height: 1.75em;" data-pm-slice="0 0 []"><span leaf="" style="font-size: 15px;">'
    '当地时间 10 月 20 日，GSK 宣布，其下反义寡核苷酸<span textstyle="" style="color: rgb(178, 178, 178);">（ASO）</span>创新药 '
    '<span textstyle="" style="font-weight: bold;">Bepirovirsen </span><span textstyle="" style="color: rgb(178, 178, 178);'
    'font-weight: bold;">（</span></span><span style="display: inline !important;"><span leaf=""><span textstyle="" '
    'style="font-weight: bold;">贝</span><span textstyle="" style="font-weight: bold;">普若韦生）</span></span></span>'
    '<span leaf="">已获得美国 FDA 正式批准上市，</span></p>'
    '<p style="text-align: center;"><span leaf="">截图来源：GSK 官网</span></p>'
    '<p><span leaf="">慢性乙型肝炎是全球范围内亟待解决的重大公共卫生问题。</span></p>'
)


def paragraphs(text: str | None) -> list[str]:
    return (clean_body(text) or "").split("\n\n")


def test_a_wechat_body_is_read_from_the_article_s_own_html():
    body = body_of({"content": WECHAT_LIGHT, "content_multi_text": WECHAT_ORIGINAL})
    assert paragraphs(body) == [
        "当地时间 10 月 20 日，GSK 宣布，其下反义寡核苷酸（ASO）创新药 Bepirovirsen （贝普若韦生）已获得美国 FDA 正式批准上市，",
        "截图来源：GSK 官网",
        "慢性乙型肝炎是全球范围内亟待解决的重大公共卫生问题。",
    ]


def test_a_wechat_answer_without_the_original_html_still_has_its_light_text():
    assert paragraphs(body_of({"content": WECHAT_LIGHT}))[:3] == ["当地时间 10 月 20 日，GSK 宣布，其下反义寡核苷酸", "（ASO）", "创新药"]
    assert body_of({"content": "", "content_multi_text": "  "}) is None


def test_a_list_bullet_on_a_line_of_its_own_joins_the_line_it_marks():
    text = "孙良丹 教授\n•\n医学博士、主任医师\n• 华北理工大学\n1.\n已取得博士学位\n（2）\n能独立开展课题研究"
    assert paragraphs(text) == ["孙良丹 教授", "• 医学博士、主任医师", "• 华北理工大学", "1. 已取得博士学位", "（2） 能独立开展课题研究"]
    assert paragraphs("正文。\n•") == ["正文。", "•"]


def test_an_entity_escaped_twice_inside_markup_is_decoded():
    # Crossref, 10.1001/jamasurg.2026.4382: "&amp;amp;gt;" inside JATS.
    assert clean_markup("<jats:p>P for trend &amp;amp;lt;.001; reliability &amp;amp;gt; 0.70</jats:p>") == \
        "P for trend <.001; reliability > 0.70"
    assert clean_markup("R&amp;D &amp; HbA1c &lt;7%") == "R&D & HbA1c <7%"


def test_a_soft_hyphen_is_not_part_of_a_word():
    assert clean_markup("<p>Rez­era files for IPO</p>") == "Rezera files for IPO"
    assert clean_text("NL­RP3 ef­forts") == "NLRP3 efforts"


def test_structured_abstracts_keep_their_sections_as_paragraphs():
    jats = ('<jats:title>Abstract</jats:title><jats:sec><jats:title>Importance</jats:title><jats:p>Persistent '
            'misinformation impedes uptake.</jats:p></jats:sec><jats:sec><jats:title>Objective</jats:title><jats:p>To test '
            'a chatbot.</jats:p></jats:sec>')
    assert paragraphs(jats_abstract(jats)) == ["Importance: Persistent misinformation impedes uptake.", "Objective: To test a chatbot."]
    epmc = "<h4>Background</h4>Hearing loss is common.<h4>Methods:</h4>NHANES 2017–2020."
    assert paragraphs(result_enrichment({"abstractText": epmc})[0]) == ["Background: Hearing loss is common.", "Methods: NHANES 2017–2020."]
    # Without headings an abstract reads as it always did.
    assert structured_abstract("<p>One.</p><p>Two.</p>") == "One.\nTwo."
    assert result_enrichment({"abstractText": "Plain abstract."})[0] == "Plain abstract."


def article_page(article: str, *, furniture: str = "", nav: str = "") -> str:
    return (f"<html><head><title>t</title></head><body><nav>{nav}</nav><div class='content'>{furniture}"
            f"<article><h1>A headline about a trial</h1>{article}</article></div><footer>Copyright</footer></body></html>")


ARTICLE = "".join(f"<p>Paragraph {i} of the article reports what the trial found and why it matters to clinicians "
                  f"reading the feed this morning.</p>" for i in range(1, 7))


def test_a_page_s_main_text_is_trafilatura_s_without_the_page_furniture():
    furniture = ("<div class='byline'>By Tara Bannow</div><div class='bio'>Tara covers the business of health care. "
                 "You can reach Tara on Signal.</div>")
    html = article_page(ARTICLE, furniture=furniture)
    text = main_text(html, "https://example.org/a")
    assert "Paragraph 1 of the article" in text and "Paragraph 6 of the article" in text
    assert len(text.split("\n")) >= 6 and "Copyright" not in text


def test_the_container_reading_wins_only_when_trafilatura_missed_the_article(monkeypatch):
    from knowledge_plugin.enrich import page
    found = "\n".join(f"Article paragraph {i} with enough words to read as prose." for i in range(6))      # ~350 chars

    def choose(extracted: str, container: str) -> str:
        monkeypatch.setattr(page, "extracted_text", lambda html, url=None: extracted)
        monkeypatch.setattr(page, "container_text", lambda html: container)
        return page.main_text("<html></html>")

    # gov.cn: trafilatura found the language switch only (78 characters) — the container's document.
    assert choose("首页 | 简 | 繁 | EN", found) == found
    # STAT: the container is the article plus bylines and biographies, under three times as long — trafilatura's.
    assert choose(found, found + "\nBy Tara Bannow\nTara covers the business of health care.") == found
    # leiphone: the container is FALLBACK_RATIO or more times trafilatura's — trafilatura missed the article.
    longer = "\n".join([found] * FALLBACK_RATIO)
    assert choose(found, longer) == longer
    assert len(found) >= MIN_EXCERPT


def test_trafilatura_failing_on_a_page_is_a_page_without_its_text():
    assert extracted_text("") == "" and extracted_text("\x00\x01") == ""
