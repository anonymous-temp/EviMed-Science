"""Token-free MR inputs from the GWAS Catalog, exercised offline.

Every request goes to an in-memory catalogue: a study API, an FTP directory
listing, a streamed pre-2023 harmonised file for the exposure and a bgzip +
tabix GWAS-SSF file for the outcome read by HTTP Range. The live reading of the
real BMI and CAD studies is in the 2026-09-28 engine run, not here.
"""
from __future__ import annotations

import gzip
import io
import json
import struct
import urllib.error
import zlib

import pytest

from mr_agent.tools import open_sumstats as osm

API = osm.CATALOG_API
FTP = "https://ftp.example/pub/GCST000002"

EXPOSURE_ROWS = [
    # rsid, chrom, pos, other, effect, beta, se, eaf, p
    ("rs1", "1", 1_000_000, "G", "A", 0.08, 0.004, 0.40, 1e-80),
    ("rs2", "1", 5_000_000, "T", "C", 0.03, 0.004, 0.30, 1e-12),  # within 10 Mb of rs1: pruned
    ("rs3", "2", 3_000_000, "C", "A", 0.05, 0.005, 0.20, 1e-20),
    ("rs4", "3", 7_000_000, "A", "G", -0.04, 0.005, 0.60, 1e-14),
    ("rs5", "4", 9_000_000, "G", "T", 0.02, 0.003, 0.50, 1e-10),
    ("rs6", "5", 2_000_000, "C", "T", 0.01, 0.004, 0.50, 0.3),     # not significant
]
OUTCOME_ROWS = [
    # chromosome, position, effect, other, beta, se, eaf, p, rsid
    ("1", 1_000_000, "A", "G", 0.02, 0.005, 0.41, 1e-4, "rs1"),
    ("1", 1_000_500, "T", "C", 0.00, 0.005, 0.10, 0.9, "rs900"),
    ("2", 3_000_000, "A", "C", 0.01, 0.006, 0.19, 0.1, "rs3"),
    ("3", 7_000_000, "G", "A", -0.02, 0.006, 0.61, 1e-3, "rs4"),
    # rs5 is absent from the outcome file.
]


def _legacy_file() -> bytes:
    header = ("hm_variant_id\thm_rsid\thm_chrom\thm_pos\thm_other_allele\thm_effect_allele\thm_beta\t"
              "hm_odds_ratio\thm_ci_lower\thm_ci_upper\thm_effect_allele_frequency\thm_code\tvariant_id\t"
              "effect_allele\tother_allele\teaf_ref\tbeta\tstandard_error\tp_value\tn\n")
    lines = [header]
    for rsid, chrom, pos, other, effect, beta, se, eaf, p in EXPOSURE_ROWS:
        lines.append(f"{chrom}_{pos}_{other}_{effect}\t{rsid}\t{chrom}\t{pos}\t{other}\t{effect}\t{beta}\tNA\tNA\tNA\t"
                     f"{eaf}\t5\t{rsid}\t{effect}\t{other}\tNA\t{beta}\t{se}\t{p}\t300000\n")
    lines.append("NA\tNA\tNA\tNA\tNA\tNA\tNA\tNA\tNA\tNA\tNA\t18\trs7\tA\tG\tNA\t0.1\t0.01\t1e-9\t1\n")
    return gzip.compress("".join(lines).encode())


def _bgzf_block(data: bytes) -> bytes:
    compressor = zlib.compressobj(6, zlib.DEFLATED, -15)
    body = compressor.compress(data) + compressor.flush()
    header = b"\x1f\x8b\x08\x04\x00\x00\x00\x00\x00\xff\x06\x00BC\x02\x00" + struct.pack("<H", 18 + len(body) + 8 - 1)
    return header + body + struct.pack("<II", zlib.crc32(data), len(data))


def _reg2bin(begin: int, end: int) -> int:
    end -= 1
    for shift, offset in ((14, 4681), (17, 585), (20, 73), (23, 9), (26, 1)):
        if begin >> shift == end >> shift:
            return offset + (begin >> shift)
    return 0


def _ssf_with_index() -> tuple[bytes, bytes]:
    """A GWAS-SSF file in one BGZF block per line, and its tabix index."""
    header = "chromosome\tbase_pair_location\teffect_allele\tother_allele\tbeta\tstandard_error\t" \
             "effect_allele_frequency\tp_value\tn\trsid\n"
    lines = [header.encode()] + [
        f"{c}\t{pos}\t{ea}\t{oa}\t{beta}\t{se}\t{eaf}\t{p}\t1165570\t{rsid}\r\n".encode()
        for c, pos, ea, oa, beta, se, eaf, p, rsid in OUTCOME_ROWS
    ]
    data, offsets = b"", []
    for line in lines:
        offsets.append(len(data))
        data += _bgzf_block(line)
    data += _bgzf_block(b"")
    names = sorted({row[0] for row in OUTCOME_ROWS})
    refs = {name: {"bins": {}, "linear": {}} for name in names}
    for (chrom, pos, *_), offset in zip(OUTCOME_ROWS, offsets[1:]):
        start, stop = offset << 16, (offset << 16) + len(lines[offsets.index(offset)])
        ref = refs[chrom]
        ref["bins"].setdefault(_reg2bin(pos - 1, pos), []).append((start, stop))
        ref["linear"].setdefault((pos - 1) >> 14, start)
    names_blob = b"".join(name.encode() + b"\0" for name in names)
    index = b"TBI\x01" + struct.pack("<8i", len(names), 0, 1, 2, 2, ord("#"), 1, len(names_blob)) + names_blob
    for name in names:
        ref = refs[name]
        index += struct.pack("<i", len(ref["bins"]))
        for bin_id, chunks in sorted(ref["bins"].items()):
            index += struct.pack("<Ii", bin_id, len(chunks)) + b"".join(struct.pack("<QQ", *chunk) for chunk in chunks)
        size = max(ref["linear"]) + 1
        linear = [ref["linear"].get(position, 0) for position in range(size)]
        index += struct.pack("<i", size) + b"".join(struct.pack("<Q", value) for value in linear)
    return data, gzip.compress(index)


class _Response(io.BytesIO):
    def __init__(self, body: bytes, headers: dict[str, str] | None = None):
        super().__init__(body)
        self.headers = headers or {}


class _Catalogue:
    def __init__(self):
        self.outcome_file, self.outcome_index = _ssf_with_index()
        self.files = {
            f"{API}/studies/GCST000001": json.dumps({
                "accession_id": "GCST000001", "disease_trait": "Body mass index", "pubmed_id": "111",
                "full_summary_stats_available": True, "full_summary_stats": "https://ftp.example/pub/GCST000001",
                "discovery_ancestry": ["300000 European"], "initial_sample_size": "300,000 European ancestry individuals",
                "terms_of_license": "CC0",
            }).encode(),
            f"{API}/studies?pubmed_id=222&size=100": json.dumps({"_embedded": {"studies": [{
                "accession_id": "GCST000002", "disease_trait": "Coronary artery disease", "pubmed_id": "222",
                "full_summary_stats_available": True, "full_summary_stats": FTP,
                "discovery_ancestry": ["1165570 European"], "initial_sample_size": "181,522 cases, 984,168 controls",
            }, {"accession_id": "GCST000003", "full_summary_stats_available": False}]}}).encode(),
            "https://ftp.example/pub/GCST000001/harmonised/":
                b'<a href="111-GCST000001-EFO_1.h.tsv.gz">x</a> <a href="111-GCST000001-EFO_1.f.tsv.gz">y</a>',
            "https://ftp.example/pub/GCST000001/harmonised/111-GCST000001-EFO_1.h.tsv.gz": _legacy_file(),
            f"{FTP}/harmonised/": b'<a href="GCST000002.h.tsv.gz">a</a><a href="GCST000002.h.tsv.gz.tbi">b</a>',
            f"{FTP}/harmonised/GCST000002.h.tsv.gz": self.outcome_file,
            f"{FTP}/harmonised/GCST000002.h.tsv.gz.tbi": self.outcome_index,
        }
        self.requests: list[tuple[str, str | None]] = []

    def __call__(self, request, timeout=None):
        url = request.full_url
        ranged = request.get_header("Range")
        self.requests.append((url, ranged))
        body = self.files[url]
        if ranged:
            first, _, last = ranged.removeprefix("bytes=").partition("-")
            chunk = body[int(first):int(last) + 1]
            return _Response(chunk, {"Content-Range": f"bytes {first}-{last}/{len(body)}"})
        return _Response(body)


@pytest.fixture
def catalogue(monkeypatch):
    monkeypatch.delenv("EVIMED_MR_LD_BFILE", raising=False)
    # Direct, whatever the shell says: the proxied way is test_open_sumstats_egress.
    monkeypatch.delenv("EVIMED_MR_OPEN_PROXY_URL", raising=False)
    return _Catalogue()


def test_a_pair_is_read_from_the_catalogue_by_accession_and_pubmed_id(catalogue):
    http = osm._Http(opener=catalogue)
    pair = osm.build_pair(
        {"type": "gwas_catalog", "accession": "GCST000001"},
        {"type": "gwas_catalog", "pubmedId": "222"},
        http=http,
    )
    # Five significant rows, rs2 pruned within 10 Mb of the stronger rs1.
    assert [row.snp for row in pair.exposure_rows] == ["rs1", "rs3", "rs4", "rs5"]
    assert [row.snp for row in pair.outcome_rows] == ["rs1", "rs3", "rs4"]
    rs1 = pair.outcome_rows[0]
    assert (rs1.effect_allele, rs1.other_allele, rs1.beta, rs1.se, rs1.eaf, rs1.pval, rs1.n) == (
        "A", "G", 0.02, 0.005, 0.41, 1e-4, 1165570.0)
    record = pair.record
    assert record["exposure"]["accession"] == "GCST000001"
    assert record["exposure"]["read"]["mode"] == "streamed"
    assert record["exposure"]["read"]["rows"] == 7 and record["exposure"]["read"]["rowsUnreadable"] == 1
    assert record["outcome"]["accession"] == "GCST000002"
    assert record["outcome"]["read"]["mode"] == "tabix"
    assert record["outcome"]["initialSampleSize"] == "181,522 cases, 984,168 controls"
    selection = record["instrumentSelection"]
    assert (selection["genomeWideSignificantVariants"], selection["afterClumping"]) == (5, 4)
    assert selection["method"] == "distance_pruning" and selection["ldChecked"] is False
    assert record["outcomeLookup"] == {
        "instrumentsFound": 3, "instrumentsUnavailableInOutcome": 1, "unavailableVariants": ["rs5"],
        "proxies": "none — a variant absent from the outcome file is dropped, not replaced",
    }
    # The 1.3 GB-style outcome file was never downloaded: only index and ranges.
    outcome_reads = [ranged for url, ranged in catalogue.requests if url.endswith("GCST000002.h.tsv.gz")]
    assert outcome_reads and all(ranged for ranged in outcome_reads)
    sentence = osm.provenance_sentence(record)
    assert "GCST000001" in sentence and "distance pruning" in sentence and "(4 kept)" in sentence


def test_a_second_job_on_the_same_study_reuses_the_scan_and_the_index(catalogue, monkeypatch, tmp_path):
    """From Beijing ftp.ebi.ac.uk gave 38-58 KB/s (2026-09-28): an 89 MB scan
    is ~40 minutes. What it keeps is small and is reused, and the record says so."""
    monkeypatch.setenv("EVIMED_MR_OPEN_CACHE_DIR", str(tmp_path / "cache"))
    sources = ({"type": "gwas_catalog", "accession": "GCST000001"}, {"type": "gwas_catalog", "pubmedId": "222"})
    first = osm.build_pair(*sources, http=osm._Http(opener=catalogue))
    exposure_file = "https://ftp.example/pub/GCST000001/harmonised/111-GCST000001-EFO_1.h.tsv.gz"
    index_file = f"{FTP}/harmonised/GCST000002.h.tsv.gz.tbi"
    catalogue.requests.clear()
    second = osm.build_pair(*sources, http=osm._Http(opener=catalogue))
    fetched = [url for url, ranged in catalogue.requests if not ranged]
    assert exposure_file not in fetched and index_file not in fetched
    assert second.record["exposure"]["read"]["reusedFromCache"] is True
    assert second.record["exposure"]["read"]["sha256"] == first.record["exposure"]["read"]["sha256"]
    assert [row.snp for row in second.exposure_rows] == [row.snp for row in first.exposure_rows]
    assert second.outcome_rows == first.outcome_rows


def test_the_standard_csv_is_what_the_local_engine_reads(catalogue):
    pair = osm.build_pair(
        {"type": "gwas_catalog", "accession": "GCST000001"}, {"type": "gwas_catalog", "pubmedId": "222"},
        http=osm._Http(opener=catalogue),
    )
    lines = osm.csv_bytes(pair.exposure_rows).decode().splitlines()
    assert lines[0] == "SNP,beta,se,effect_allele,other_allele,eaf,pval,samplesize,chr,pos"
    assert lines[1] == "rs1,0.08,0.004,A,G,0.4,1e-80,300000.0,1,1000000"


def test_a_pubmed_id_with_several_summary_statistics_studies_is_refused_with_the_choices(catalogue):
    catalogue.files[f"{API}/studies?pubmed_id=333&size=100"] = json.dumps({"_embedded": {"studies": [
        {"accession_id": "GCST000004", "disease_trait": "CAD", "initial_sample_size": "A",
         "full_summary_stats_available": True},
        {"accession_id": "GCST000005", "disease_trait": "CAD (UKB)", "initial_sample_size": "B",
         "full_summary_stats_available": True},
    ]}}).encode()
    with pytest.raises(osm.OpenSourceError) as caught:
        osm.resolve_study({"pubmedId": "333"}, osm._Http(opener=catalogue))
    assert caught.value.code == "mr_open_source_ambiguous"
    assert "GCST000004" in str(caught.value) and "GCST000005" in str(caught.value)


def test_an_unknown_or_unharmonised_study_is_an_error_never_a_guess(catalogue):
    http = osm._Http(opener=catalogue)
    catalogue.files[f"{API}/studies/GCST000009"] = json.dumps({
        "accession_id": "GCST000009", "full_summary_stats_available": False}).encode()
    with pytest.raises(osm.OpenSourceError) as caught:
        osm.resolve_study({"accession": "GCST000009"}, http)
    assert caught.value.code == "mr_open_source_not_found"
    study = osm.resolve_study({"accession": "GCST000001"}, http)
    catalogue.files["https://ftp.example/pub/GCST000001/harmonised/"] = b"<html>no files</html>"
    with pytest.raises(osm.OpenSourceError) as caught:
        osm.locate_harmonised_file(study, http)
    assert caught.value.code == "mr_open_source_unharmonised"


def test_a_study_without_a_harmonised_directory_is_unharmonised_not_an_outage(catalogue, monkeypatch):
    # GCST006900 on 2026-09-28: the catalogue lists full summary statistics,
    # EBI answers 404 for its harmonised/ directory. Reported as "unavailable",
    # the run was told to wait for an outage that was a fact about the study.
    listing = "https://ftp.example/pub/GCST000001/harmonised/"
    answers = {"status": 404}

    def opener(request, timeout=None):
        if request.full_url == listing:
            raise urllib.error.HTTPError(listing, answers["status"], "refused", {}, None)
        return catalogue(request, timeout)

    monkeypatch.setattr(osm.time, "sleep", lambda seconds: None)
    http = osm._Http(opener=opener)
    study = osm.resolve_study({"accession": "GCST000001"}, http)
    with pytest.raises(osm.OpenSourceError) as caught:
        osm.locate_harmonised_file(study, http)
    assert caught.value.code == "mr_open_source_unharmonised"
    assert "GCST000001" in str(caught.value) and "HTTP 404" in str(caught.value)
    # A server error on the same listing is still an outage, retried and named so.
    answers["status"] = 503
    with pytest.raises(osm.OpenSourceError) as caught:
        osm.locate_harmonised_file(study, http)
    assert caught.value.code == "mr_open_source_unavailable" and caught.value.status == 503


def test_a_stream_over_the_byte_limit_is_refused_by_name(catalogue, monkeypatch):
    monkeypatch.setenv("EVIMED_MR_OPEN_STREAM_MAX_BYTES", "64")
    with pytest.raises(osm.OpenSourceError) as caught:
        osm.stream_variants(
            "https://ftp.example/pub/GCST000001/harmonised/111-GCST000001-EFO_1.h.tsv.gz",
            osm._Http(opener=catalogue), lambda variant: True,
        )
    assert caught.value.code == "mr_open_source_too_large"


def test_distance_pruning_keeps_the_most_significant_variant_per_window():
    def variant(snp, chrom, pos, p):
        return osm.Variant(snp, chrom, pos, "A", "G", 0.1, 0.01, p, 0.5, None)

    kept = osm.distance_clump([
        variant("a", "1", 100, 1e-10), variant("b", "1", 9_999_000, 1e-20),
        variant("c", "1", 20_000_001, 1e-9), variant("d", "2", 100, 1e-8),
    ])
    assert [item.snp for item in kept] == ["b", "c", "d"]


def test_a_binary_trait_in_the_legacy_layout_reads_log_odds_and_its_standard_error():
    columns = osm._Columns(["hm_rsid", "hm_chrom", "hm_pos", "hm_other_allele", "hm_effect_allele", "hm_beta",
                            "hm_odds_ratio", "hm_ci_lower", "hm_ci_upper", "hm_effect_allele_frequency",
                            "p_value"])
    variant = columns.variant(["rs9", "9", "22096056", "A", "G", "NA", "1.20", "1.10", "1.31", "0.48", "1e-30"])
    assert variant is not None
    assert variant.beta == pytest.approx(0.18232, rel=1e-4)
    assert variant.se == pytest.approx((0.27003 - 0.09531) / 3.919928, rel=1e-3)


# --- sample size as numbers (GWAS-SSF metadata beside the harmonised file) ---

_CASE_CONTROL_META = b"""# Study meta-data
gwas_id: GCST000001
samples:
  - sample_ancestry_category:
      - European
    sample_size: 141217
    case_control_study: true
  - sample_ancestry_category:
      - South Asian
    sample_size: 25557
    case_control_study: true
"""


def test_rows_without_their_own_n_take_the_study_sample_size_from_the_metadata_file(catalogue):
    """mr-001: the CAD file has no per-variant n, so Steiger had no outcome
    sample size and failed ("replacement has length zero"); the catalogue's
    metadata file states the study's sample size as numbers."""
    listing = "https://ftp.example/pub/GCST000001/harmonised/"
    data = f"{listing}111-GCST000001-EFO_1.h.tsv.gz"
    # This exposure file, like the CAD file in mr-001, states no per-variant n.
    catalogue.files[data] = gzip.compress(gzip.decompress(catalogue.files[data]).replace(b"\t300000\n", b"\tNA\n"))
    catalogue.files[listing] += b' <a href="111-GCST000001-EFO_1.h.tsv.gz-meta.yaml">m</a>'
    catalogue.files[f"{listing}111-GCST000001-EFO_1.h.tsv.gz-meta.yaml"] = _CASE_CONTROL_META
    pair = osm.build_pair(
        {"type": "gwas_catalog", "accession": "GCST000001"},
        {"type": "gwas_catalog", "pubmedId": "222"},
        http=osm._Http(opener=catalogue),
    )
    exposure = pair.record["exposure"]
    assert exposure["sampleMetadata"] == {
        "source": f"{listing}111-GCST000001-EFO_1.h.tsv.gz-meta.yaml", "samples": 2,
        "sampleSize": 166774, "caseControlStudy": True, "caseCount": None, "controlCount": None,
        "ancestrySamples": [["European"], ["South Asian"]],
    }
    assert exposure["sampleSize"] == {
        "rowsWithOwnSampleSize": 0, "rowsGivenStudySampleSize": 4, "studySampleSize": 166774,
    }
    assert [row.n for row in pair.exposure_rows] == [166774.0] * 4
    assert b",166774.0," in osm.csv_bytes(pair.exposure_rows)
    # The outcome publishes no metadata file: its rows keep their own n and the record says why.
    outcome = pair.record["outcome"]
    assert outcome["sampleMetadata"]["reason"] == "the catalogue publishes no metadata file beside the harmonised file"
    assert outcome["sampleSize"]["rowsGivenStudySampleSize"] == 0
    assert [row.n for row in pair.outcome_rows] == [1165570.0] * len(pair.outcome_rows)


@pytest.mark.parametrize("body, reason", [
    (b"samples: []\n", "the metadata file lists no samples"),
    (b"samples:\n  - sample_size: 10\n  - sample_ancestry: [x]\n",
     "not every sample in the metadata file states its sample_size"),
    (b"samples: [unclosed\n", "the metadata file is not readable YAML"),
])
def test_an_unusable_metadata_file_gives_no_total_and_says_why(body, reason):
    class _Fixed:
        def read(self, url, limit=0):
            return body

    study = osm.CatalogStudy(
        accession="GCST000009", trait="", pubmed_id="", ancestry=[], initial_sample_size="",
        efo_traits=[], summary_stats_url="", licence="", metadata_url="https://ftp.example/m.yaml",
    )
    record = osm.read_sample_metadata(study, _Fixed())
    assert record.get("sampleSize") is None
    assert record["reason"] == reason
    rows = [osm.Variant("rs1", "1", 1, "A", "G", 0.1, 0.01, 1e-9, 0.2, None)]
    filled, sizes = osm.with_study_sample_size(rows, record)
    assert filled[0].n is None and sizes["rowsGivenStudySampleSize"] == 0


def test_ld_reference_selection_uses_exposure_metadata_before_clumping(catalogue, monkeypatch):
    from types import SimpleNamespace

    seen = []
    metadata = {"ancestrySamples": [["European"]], "source": "https://example.org/exposure.yaml"}
    monkeypatch.setattr(osm, "read_sample_metadata", lambda study, http: metadata if study.accession == "GCST000001" else
                        {"ancestrySamples": [["European"], ["South Asian"]], "source": "https://example.org/outcome.yaml"})
    reference = SimpleNamespace(plink="/test/plink", bfile="/test/EUR", population="EUR", assert_current=lambda: None, record=lambda: {"population": "EUR", "manifestSha256": "a" * 64})
    monkeypatch.setattr(osm, "ld_reference", lambda choice: (seen.append(choice) or reference, None))
    monkeypatch.setattr(osm, "plink_clump", lambda variants, *_: (osm.distance_clump(variants), 0))
    pair = osm.build_pair({"type": "gwas_catalog", "accession": "GCST000001"},
                          {"type": "gwas_catalog", "pubmedId": "222"}, http=osm._Http(opener=catalogue))
    assert seen[0]["population"] == "EUR"
    selected = pair.record["instrumentSelection"]
    assert selected["method"] == "plink_ld_clumping" and selected["ldChecked"]
    assert selected["referenceReceipt"]["population"] == "EUR"
    assert pair.record["outcome"]["referencePopulation"]["status"] == "mixed"
    assert osm.selection_record(pair.record)["referenceReceipt"] == selected["referenceReceipt"]


def test_plink_failure_preserves_distance_approximation_and_explicit_reason(catalogue, monkeypatch):
    from types import SimpleNamespace

    reference = SimpleNamespace(plink="/test/plink", bfile="/test/EUR", population="EUR", assert_current=lambda: None, record=lambda: {"population": "EUR"})
    monkeypatch.setattr(osm, "ld_reference", lambda choice: (reference, None))

    def failed(*args):
        raise osm.OpenSourceError("mr_open_clumping_failed", "PLINK unavailable")

    monkeypatch.setattr(osm, "plink_clump", failed)
    pair = osm.build_pair({"type": "gwas_catalog", "accession": "GCST000001"},
                          {"type": "gwas_catalog", "pubmedId": "222"}, http=osm._Http(opener=catalogue))
    selected = pair.record["instrumentSelection"]
    assert selected["method"] == "distance_pruning" and selected["ldChecked"] is False
    assert selected["fallbackReason"] == "mr_open_clumping_failed"
    assert selected["attemptedReference"]["population"] == "EUR"
    assert len(pair.exposure_rows) >= 3 and pair.outcome_rows
    assert "stricter" not in selected["note"]
