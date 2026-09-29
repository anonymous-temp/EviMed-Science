"""Figures a topic report states carry their display strings beside the raw values.

evidence-stats.json held clinical_ratio 0.25210084033613445 and keyword
diversity 0.4394951744617669, and the M2 keyword centralities were raw floats;
the skill told the writer to copy job figures "at the precision you state it".
"""

from models.schemas import EvidenceStats, LiteratureRecord
from modules.new_analysis_modules import M2_ResearchEcosystemModule


def test_evidence_stats_carry_display_strings():
    stats = EvidenceStats(evidence_count=119, clinical_ratio=0.25210084033613445, year_span=5,
                          keyword_diversity=0.4394951744617669)
    dumped = stats.model_dump(mode="json")
    assert dumped["clinical_ratio"] == 0.25210084033613445
    assert dumped["display"] == {
        "evidence_count": "119", "clinical_ratio": "25%", "year_span": "5", "keyword_diversity": "0.439",
    }
    assert EvidenceStats.model_validate(dumped).display == dumped["display"]


def test_keyword_centrality_carries_display_strings():
    records = [
        LiteratureRecord(id=str(index), title="t", keywords=keywords)
        for index, keywords in enumerate([["a", "b", "c"], ["a", "c"], ["a", "d"]])
    ]
    module = M2_ResearchEcosystemModule.__new__(M2_ResearchEcosystemModule)
    network = module._build_keyword_network(records)
    assert network["centrality"]["a"] == 1.0
    assert network["display"]["centrality"] == {
        term: f"{value:.3f}" if value < 1 else "1.00" for term, value in network["centrality"].items()
    }
