"""The writer must not name statistical software the pipeline never used."""
from new_meta.agents.writing_agent import WritingAgent


def _writer() -> WritingAgent:
    writer = WritingAgent.__new__(WritingAgent)
    writer.log = lambda *args, **kwargs: None
    return writer


def test_chinese_software_sentence_is_removed() -> None:
    text = "主要模型采用倒方差固定效应模型。所有分析在R中完成。效应量以RR表示。"
    assert _writer()._remove_fabricated_software_claims(text) == (
        "主要模型采用倒方差固定效应模型。效应量以RR表示。"
    )


def test_english_software_sentence_is_removed() -> None:
    text = "Effects were pooled with inverse-variance weights. All analyses were performed in Stata 17."
    assert "Stata" not in _writer()._remove_fabricated_software_claims(text)


def test_methods_without_a_software_claim_are_untouched() -> None:
    text = "主要模型采用倒方差固定效应模型。效应量以危险比(RR)及其95% CI表示。"
    assert _writer()._remove_fabricated_software_claims(text) == text


def test_a_gene_named_like_a_package_survives() -> None:
    text = "我们分析了RRR基因的表达。"
    assert _writer()._remove_fabricated_software_claims(text) == text
