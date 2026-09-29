"""Tabix positions are read several at a time, and the answer is the same."""
import threading
import time

from mr_agent.tools import open_sumstats as osm


class _Reader:
    """A RemoteTabix stand-in: each position takes a while, like a Range request over the node."""

    def __init__(self, rows):
        self.rows = rows
        self.columns = None
        self.header_reads = 0
        self.active = 0
        self.peak = 0
        self._lock = threading.Lock()

    def _read_header(self):
        self.header_reads += 1
        self.columns = object()

    def fetch(self, chrom, pos):
        with self._lock:
            self.active += 1
            self.peak = max(self.peak, self.active)
        time.sleep(0.05)
        with self._lock:
            self.active -= 1
        return list(self.rows.get((chrom, pos), []))


def _variant(snp, chrom, pos):
    return osm.Variant(snp=snp, chrom=chrom, pos=pos, effect_allele="A", other_allele="G",
                       beta=0.1, se=0.01, pval=1e-9, eaf=0.3, n=None)


def _wanted(n):
    return [(f"rs{i}", "1", 1000 + i) for i in range(n)]


def test_positions_are_read_in_parallel_and_collected_in_the_order_asked(monkeypatch):
    monkeypatch.setenv("EVIMED_MR_OPEN_FETCH_WORKERS", "6")
    rows = {("1", 1000 + i): [_variant(f"rs{i}", "1", 1000 + i)] for i in range(0, 12, 2)}
    reader = _Reader(rows)
    started = time.monotonic()
    found = osm._fetch_many(reader, _wanted(12))
    elapsed = time.monotonic() - started
    assert list(found) == [f"rs{i}" for i in range(0, 12, 2)]
    assert reader.header_reads == 1, "the header is read once, before the workers share the reader"
    assert reader.peak > 1, "the reads overlapped"
    assert elapsed < 12 * 0.05, "twelve reads did not take twelve round trips"


def test_one_worker_reads_one_position_at_a_time_with_the_same_answer(monkeypatch):
    monkeypatch.setenv("EVIMED_MR_OPEN_FETCH_WORKERS", "1")
    rows = {("1", 1003): [_variant("rs9", "1", 1003), _variant("rs3", "1", 1003)]}
    reader = _Reader(rows)
    found = osm._fetch_many(reader, _wanted(5))
    assert list(found) == ["rs3"], "only the rsid asked for at that position"
    assert reader.peak == 1


def test_nothing_wanted_reads_nothing():
    reader = _Reader({})
    assert osm._fetch_many(reader, []) == {}
    assert reader.header_reads == 0
