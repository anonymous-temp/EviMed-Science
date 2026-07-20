from bibliometric.pipeline import _search_with_fallback


class _Connector:
    def __init__(self, responses):
        self.responses = list(responses)
        self.queries = []

    def search(self, query, date_from, date_to, max_records):
        self.queries.append((query, date_from, date_to, max_records))
        return self.responses.pop(0)


def test_zero_result_formal_strategy_retries_the_original_topic():
    connector = _Connector([[], ["1", "2"]])
    pmids, fallback = _search_with_fallback(
        connector,
        '("SGLT2 inhibitors"[Title/Abstract]) AND ("chronic kidney disease"[Title/Abstract])',
        "SGLT2 inhibitors in chronic kidney disease",
        "2022",
        "2026",
        20,
    )
    assert pmids == ["1", "2"]
    assert fallback == "SGLT2 inhibitors in chronic kidney disease"
    assert connector.queries[1][0] == fallback


def test_nonempty_formal_strategy_does_not_relax():
    connector = _Connector([["1"]])
    pmids, fallback = _search_with_fallback(
        connector, "formal", "original", "", "", 20
    )
    assert pmids == ["1"]
    assert fallback is None
    assert len(connector.queries) == 1
