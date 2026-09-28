"""A whole harmonised file fetched as parallel byte ranges, exercised offline.

On 2026-09-28 (Beijing host, China evening) one long stream of GCST005195's
388 MB file through the Tokyo node fell to ~30 KB/s while a fresh range through
the same node moved 150-710 KB/s. ``read_whole_file`` fetches such a file as
parallel ranges into a spool and parses the spool with the stream's own parser;
these tests hold it to the same variants and bytes as the stream, and to its
failure rules: a range retried alone, a range that cannot be read fails the
read with no spool left behind, a size that does not match is refused, and no
room or no range support means the old stream.
"""
from __future__ import annotations

import collections
import errno
import gzip
import hashlib
import io
import math
import random
import threading
import time
import urllib.error

import pytest

from mr_agent.tools import open_sumstats as osm
from test_open_sumstats import _Catalogue, _Response

URL = "https://ftp.example/pub/GCST000009/harmonised/999-GCST000009-EFO_9.h.tsv.gz"
CHUNK = 64 * 1024
WORKERS = 4


def big_legacy_file(rows: int = 8000) -> bytes:
    """A pre-2023 harmonised file large enough for several 64 KiB ranges (~600 KB)."""
    rng = random.Random(20260928)
    lines = [
        "hm_variant_id\thm_rsid\thm_chrom\thm_pos\thm_other_allele\thm_effect_allele\thm_beta\t"
        "hm_odds_ratio\thm_ci_lower\thm_ci_upper\thm_effect_allele_frequency\thm_code\tvariant_id\t"
        "effect_allele\tother_allele\teaf_ref\tbeta\tstandard_error\tp_value\tn\n"
    ]
    for index in range(rows):
        chrom, pos = str(1 + index % 22), 10_000 + index * 997
        beta, se, eaf = rng.gauss(0, 0.05), rng.uniform(0.003, 0.02), rng.random()
        p = 10 ** -rng.uniform(0, 12)
        rsid = f"rs{100_000 + index}"
        lines.append(f"{chrom}_{pos}_G_A\t{rsid}\t{chrom}\t{pos}\tG\tA\t{beta!r}\tNA\tNA\tNA\t{eaf!r}\t5\t{rsid}\t"
                     f"A\tG\tNA\t{beta!r}\t{se!r}\t{p!r}\t300000\n")
    return gzip.compress("".join(lines).encode(), mtime=0)


BIG = big_legacy_file()
SPANS = [(start, min(start + CHUNK, len(BIG)) - 1) for start in range(0, len(BIG), CHUNK)]


def significant(variant: osm.Variant) -> bool:
    return variant.pval < osm.GENOME_WIDE_P


class _Dropping(io.BytesIO):
    """A range answer whose connection drops after the bytes it was given."""

    def __init__(self, body: bytes, headers: dict[str, str]):
        super().__init__(body)
        self.headers = headers

    def read(self, size=-1):
        data = super().read(size)
        if not data:
            raise ConnectionResetError("the connection dropped mid-range")
        return data


class _Server:
    """EBI's file server in process: whole files, byte ranges, and the faults a test asks for."""

    def __init__(self, files: dict[str, bytes]):
        self.files = files
        self.requests: list[tuple[str, str | None]] = []
        self.honour_ranges = True
        #: first byte of a range -> faults for its next attempts ("drop", "503", "404")
        self.faults: dict[int, list[str]] = {}
        self.hold = None  # called before a range is answered
        self._lock = threading.Lock()

    def __call__(self, request, timeout=None):
        url, ranged = request.full_url, request.get_header("Range")
        with self._lock:
            self.requests.append((url, ranged))
        body = self.files[url]
        if not ranged or not self.honour_ranges:
            return _Response(body)
        if self.hold is not None:
            self.hold(ranged)
        first, last = (int(value) for value in ranged.removeprefix("bytes=").split("-"))
        with self._lock:
            pending = self.faults.get(first) or []
            fault = pending.pop(0) if pending else None
        headers = {"Content-Range": f"bytes {first}-{last}/{len(body)}"}
        if fault in ("503", "404"):
            raise urllib.error.HTTPError(url, int(fault), "fault", {}, None)
        if fault == "drop":
            return _Dropping(body[first:first + (last - first + 1) // 2], headers)
        return _Response(body[first:last + 1], headers)

    def ranges(self) -> collections.Counter:
        return collections.Counter(ranged for url, ranged in self.requests if ranged)


@pytest.fixture
def server(monkeypatch, tmp_path):
    monkeypatch.delenv("EVIMED_MR_OPEN_PROXY_URL", raising=False)
    monkeypatch.delenv("EVIMED_MR_LD_BFILE", raising=False)
    monkeypatch.setenv("EVIMED_MR_OPEN_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("EVIMED_MR_OPEN_FETCH_CHUNK_BYTES", str(CHUNK))
    monkeypatch.setenv("EVIMED_MR_OPEN_FETCH_WORKERS", str(WORKERS))
    waits: list[float] = []
    monkeypatch.setattr(osm, "_sleep", waits.append)
    server = _Server({URL: BIG})
    server.waits = waits
    server.cache = tmp_path / "cache"
    return server


def _spools(directory) -> list[str]:
    """Spool copies and part files left in ``directory`` (lock files are empty and stay)."""
    if not directory.exists():
        return []
    return sorted(path.name for path in directory.iterdir() if path.name.endswith((".spool", ".part")))


def _streamed() -> tuple[list[osm.Variant], dict]:
    return osm.stream_variants(URL, osm._Http(opener=_Server({URL: BIG})), significant)


def test_parallel_ranges_assemble_the_exact_bytes_and_parse_like_the_stream(server):
    http = osm._Http(opener=server)
    kept, read = osm.read_whole_file(URL, http, significant, size=len(BIG))
    streamed, stream_read = _streamed()

    assert len(kept) > 100 and kept == streamed
    assert read["sha256"] == stream_read["sha256"] == hashlib.sha256(BIG).hexdigest()
    assert (read["rows"], read["bytes"], http.bytes) == (8000, len(BIG), len(BIG))
    assert read["mode"] == "ranged" and "rangedSkipped" not in read
    ranged = dict(read["ranged"])
    assert ranged.pop("fetchSeconds") >= 0
    assert ranged == {
        "spool": "cache_volume", "spoolReused": False, "workers": WORKERS, "chunkBytes": CHUNK,
        "chunks": len(SPANS), "rangeRequests": len(SPANS), "rangeRetries": 0, "bytesFetched": len(BIG),
    }
    assert read["egress"] == {"direct": len(SPANS)}
    # Every byte asked for exactly once, and never the whole file.
    assert server.ranges() == collections.Counter(f"bytes={a}-{b}" for a, b in SPANS)
    assert all(ranged for _, ranged in server.requests)
    assert _spools(server.cache) == []


def test_a_range_that_fails_passingly_is_retried_alone(server):
    server.faults = {CHUNK: ["drop"], 3 * CHUNK: ["503"]}
    kept, read = osm.read_whole_file(URL, osm._Http(opener=server), significant, size=len(BIG))

    assert kept == _streamed()[0] and read["sha256"] == hashlib.sha256(BIG).hexdigest()
    counts = server.ranges()
    for first, last in SPANS:
        assert counts[f"bytes={first}-{last}"] == (2 if first in (CHUNK, 3 * CHUNK) else 1)
    assert read["ranged"]["rangeRequests"] == len(SPANS) + 2 and read["ranged"]["rangeRetries"] == 2
    assert server.waits == [1, 1]
    assert _spools(server.cache) == []


@pytest.mark.parametrize(("faults", "message"), [
    (["drop", "drop", "drop"], "could not be read in 3 attempts (ConnectionResetError"),
    (["404"], "HTTP 404"),
])
def test_a_range_that_cannot_be_read_fails_the_read_and_leaves_no_spool(server, faults, message):
    server.faults = {2 * CHUNK: list(faults)}
    with pytest.raises(osm.OpenSourceError) as caught:
        osm.read_whole_file(URL, osm._Http(opener=server), significant, size=len(BIG))
    assert caught.value.code == "mr_open_source_unavailable"
    assert message in str(caught.value)
    # A 404 is an answer, not a passing failure: asked once.
    assert server.ranges()[f"bytes={2 * CHUNK}-{3 * CHUNK - 1}"] == len(faults)
    assert _spools(server.cache) == []


def test_a_file_whose_size_does_not_match_what_was_stated_is_refused(server):
    with pytest.raises(osm.OpenSourceError) as caught:
        osm.read_whole_file(URL, osm._Http(opener=server), significant, size=len(BIG) + 5000)
    assert caught.value.code == "mr_open_source_unavailable"
    assert f"not the {len(BIG) + 5000} first stated" in str(caught.value)
    assert _spools(server.cache) == []


@pytest.mark.parametrize("cache", [True, False], ids=["cache-volume", "temp-dir"])
def test_no_room_for_the_spool_means_the_stream(server, monkeypatch, tmp_path, cache):
    if not cache:
        monkeypatch.delenv("EVIMED_MR_OPEN_CACHE_DIR")
        monkeypatch.setattr(osm.tempfile, "gettempdir", lambda: str(tmp_path))
    usage = collections.namedtuple("usage", "total used free")
    asked = []

    def small(path):
        asked.append(str(path))
        return usage(512 * 1024 * 1024, 512 * 1024 * 1024 - 1000, 1000)  # a full 512 MB tmpfs

    monkeypatch.setattr(osm.shutil, "disk_usage", small)
    kept, read = osm.read_whole_file(URL, osm._Http(opener=server), significant, size=len(BIG))
    assert asked and (read["mode"], read["rangedSkipped"]) == ("streamed", "no_room")
    assert kept == _streamed()[0]
    assert server.requests == [(URL, None)]  # one plain stream, no range
    assert _spools(server.cache) == [] and _spools(tmp_path) == []


def test_a_file_system_that_cannot_reserve_the_room_means_the_stream(server, monkeypatch):
    def full(descriptor, offset, length):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(osm.os, "posix_fallocate", full)
    kept, read = osm.read_whole_file(URL, osm._Http(opener=server), significant, size=len(BIG))
    assert (read["mode"], read["rangedSkipped"]) == ("streamed", "no_room")
    assert kept == _streamed()[0] and _spools(server.cache) == []


def test_a_server_without_ranges_is_streamed(server, monkeypatch):
    # The probe found no stated size: the old stream, and the record says why.
    kept, read = osm.read_whole_file(URL, osm._Http(opener=server), significant, size=None)
    assert (read["mode"], read["rangedSkipped"]) == ("streamed", "size_unknown")
    assert kept == _streamed()[0]

    # A size was stated but a range comes back as the whole file: dropped, streamed.
    server.requests.clear()
    server.honour_ranges = False
    kept, read = osm.read_whole_file(URL, osm._Http(opener=server), significant, size=len(BIG))
    assert (read["mode"], read["rangedSkipped"]) == ("streamed", "range_not_honoured")
    assert kept == _streamed()[0] and read["sha256"] == hashlib.sha256(BIG).hexdigest()
    assert server.requests[-1] == (URL, None)
    assert _spools(server.cache) == []

    # A file of one chunk or less gains nothing from ranges.
    monkeypatch.setenv("EVIMED_MR_OPEN_FETCH_CHUNK_BYTES", str(len(BIG)))
    _, read = osm.read_whole_file(URL, osm._Http(opener=server), significant, size=len(BIG))
    assert (read["mode"], read["rangedSkipped"]) == ("streamed", "single_chunk")


def test_a_size_over_the_stream_limit_is_refused_before_anything_is_read(server, monkeypatch):
    monkeypatch.setenv("EVIMED_MR_OPEN_STREAM_MAX_BYTES", str(len(BIG) - 1))
    with pytest.raises(osm.OpenSourceError) as caught:
        osm.read_whole_file(URL, osm._Http(opener=server), significant, size=len(BIG))
    assert caught.value.code == "mr_open_source_too_large" and server.requests == []


def test_two_jobs_that_need_one_file_at_once_download_it_once(server, monkeypatch):
    first_range, release = threading.Event(), threading.Event()
    second_waiting = threading.Event()

    def hold(ranged):
        first_range.set()
        assert release.wait(10), "the second job never came"

    server.hold = hold
    real_flock = osm._flock

    def watched(path, wait):
        if threading.current_thread().name == "job-b" and str(path).endswith(".spool.lock"):
            second_waiting.set()  # job B holds its interest in the copy and waits for the lock
        return real_flock(path, wait)

    monkeypatch.setattr(osm, "_flock", watched)
    results: dict[str, tuple] = {}

    def job(name):
        results[name] = osm.read_whole_file(URL, osm._Http(opener=server), significant, size=len(BIG))

    a = threading.Thread(target=job, args=("a",), name="job-a")
    a.start()
    assert first_range.wait(10)
    b = threading.Thread(target=job, args=("b",), name="job-b")
    b.start()
    assert second_waiting.wait(10)
    time.sleep(3 * osm._SPOOL_POLL_SECONDS)  # B is polling the lock A holds
    release.set()
    a.join(30)
    b.join(30)

    (kept_a, read_a), (kept_b, read_b) = results["a"], results["b"]
    assert kept_a == kept_b == _streamed()[0]
    assert read_a["sha256"] == read_b["sha256"] == hashlib.sha256(BIG).hexdigest()
    # Downloaded once: every range asked for once, by A; B read A's copy.
    assert server.ranges() == collections.Counter(f"bytes={a}-{b}" for a, b in SPANS)
    assert (read_a["ranged"]["spoolReused"], read_b["ranged"]["spoolReused"]) == (False, True)
    assert read_b["ranged"]["bytesFetched"] == 0 and read_b["egress"] == {}
    # The last one out deleted the copy.
    assert _spools(server.cache) == []


def test_a_complete_copy_left_by_a_crashed_job_is_read_and_then_deleted(server):
    key = osm._cache_key("spool", URL, len(BIG))
    server.cache.mkdir(parents=True)
    (server.cache / f"{key}.spool").write_bytes(BIG)
    (server.cache / f".{key}.4242.1.part").write_bytes(BIG[:1000])  # a crashed writer's part
    kept, read = osm.read_whole_file(URL, osm._Http(opener=server), significant, size=len(BIG))
    assert kept == _streamed()[0] and read["ranged"]["spoolReused"] is True
    assert server.requests == []
    assert _spools(server.cache) == [f".{key}.4242.1.part"]  # only a writer clears parts
    osm.read_whole_file(URL, osm._Http(opener=server), significant, size=len(BIG))
    assert _spools(server.cache) == []


def test_a_catalogue_study_is_read_by_ranges_end_to_end(server):
    catalogue = _Catalogue()
    exposure = "https://ftp.example/pub/GCST000001/harmonised/111-GCST000001-EFO_1.h.tsv.gz"
    catalogue.files[exposure] = BIG
    pair = osm.build_pair(
        {"type": "gwas_catalog", "accession": "GCST000001"}, {"type": "gwas_catalog", "pubmedId": "222"},
        http=osm._Http(opener=catalogue),
    )
    record = pair.record["exposure"]
    assert record["harmonisedBytes"] == len(BIG)
    assert record["read"]["mode"] == "ranged" and record["read"]["ranged"]["chunks"] == len(SPANS)
    assert record["read"]["sha256"] == hashlib.sha256(BIG).hexdigest()
    assert pair.record["instrumentSelection"]["genomeWideSignificantVariants"] == len(
        {variant.snp for variant in _streamed()[0]})
    assert math.isclose(len(BIG) / CHUNK, len(SPANS), abs_tol=1)


def test_parallel_failures_of_one_outage_count_once_toward_turning_the_node_off():
    egress = osm._Egress(osm.EdgeProxy("203.0.113.7", 443, "Basic eA=="), state="configured")
    blip = osm._ProxyFailure("edge_proxy_unreachable")
    under_way = time.monotonic()
    for _ in range(6):  # six range requests in flight meet one outage
        egress.failed(blip, "ftp.ebi.ac.uk", under_way)
    assert (egress.failure_count, egress.consecutive_failures, egress.off) == (6, 1, False)
    egress.succeeded()
    assert egress.consecutive_failures == 0
    # Attempts begun after the last counted failure are new evidence, one each:
    # with one request at a time this is the old count.
    for _ in range(osm._PROXY_FAILURES_BEFORE_OFF):
        egress.failed(blip, "ftp.ebi.ac.uk", time.monotonic())
    assert egress.off and egress.consecutive_failures == osm._PROXY_FAILURES_BEFORE_OFF
    # A refusal a retry cannot change turns it off at once, however it overlaps.
    refused = osm._Egress(osm.EdgeProxy("203.0.113.7", 443, "Basic eA=="), state="configured")
    refused.failed(osm._ProxyFailure("edge_proxy_refused", 407), "ftp.ebi.ac.uk", float("-inf"))
    assert refused.off
