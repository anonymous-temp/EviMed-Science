from types import SimpleNamespace

from mr_agent.models import SessionState
from mr_agent.paper.generator import PaperGenerator
from mr_agent.tools.gwas import _parse_dict_response


def test_gwas_search_rejects_generic_disease_only_matches_and_ranks_exact_traits():
    data = {
        "generic": {
            "trait": "Cardiovascular disease",
            "sample_size": 999999,
            "year": 2025,
        },
        "small-exact": {
            "trait": "Coronary heart disease",
            "sample_size": 50000,
            "year": 2020,
        },
        "large-exact": {
            "trait": "Coronary heart disease",
            "sample_size": 180000,
            "year": 2018,
        },
    }

    results = _parse_dict_response(data, "coronary heart disease", 50)

    assert [item.gwas_id for item in results] == ["large-exact", "small-exact"]


def test_gwas_search_prefers_large_exact_population_studies():
    data = {
        "african-small": {
            "trait": "Low density lipoprotein cholesterol levels",
            "population": "Sub-Saharan African",
            "sample_size": 24515,
            "year": 2022,
        },
        "european-large": {
            "trait": "Low density lipoprotein cholesterol levels",
            "population": "European",
            "sample_size": 437068,
            "year": 2021,
        },
    }

    results = _parse_dict_response(data, "low density lipoprotein cholesterol", 50)

    assert results[0].gwas_id == "european-large"


def test_paper_title_is_neutral_about_effect_direction():
    state = SessionState()
    generator = PaperGenerator(SimpleNamespace(), state, language="zh")

    title = generator._generate_title("LDL cholesterol", "coronary heart disease")

    assert title == "LDL cholesterol与coronary heart disease：两样本孟德尔随机化分析"
    assert "风险增加" not in title
    assert "风险降低" not in title
