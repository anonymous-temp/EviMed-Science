"""NCBI Gene Expression Omnibus series to differential expression: preserved, identity-checked, computed, and checked against R.

The data are real. `fixtures/gene_expression/GSE5583_series_matrix.txt.gz` is GEO's own file, byte for byte (downloaded
2026-10-04, sha-256 in `evals/gene-expression-analysis/fixtures/source-manifest.json`): wild-type against HDAC1
knock-out mouse embryonic stem cells, three arrays each, on GPL81, MAS5 linear intensities. `GPL81_reduced.txt.gz` is
GEO's GPL81 record with its sample/series id lists and three annotation columns' worth of text removed (12,488 probe rows
kept); the manifest says what was removed and the sha-256 of the full record it came from. The reference statistics are
base R's `t.test` and `p.adjust`, computed by `evals/gene-expression-analysis/reference_gse5583.R` from the same file and
nothing of this module; the comparison below states its tolerance. Everything else is synthetic and says so.
"""

import importlib.util
import csv
import gzip
import hashlib
import io
import json
import math
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import gene_expression as engine  # noqa: E402
import gene_expression_tools as tools  # noqa: E402
import immutable_capture  # noqa: E402
import public_sources  # noqa: E402
import source_outcome  # noqa: E402
import source_transport  # noqa: E402
import wire_fixtures as wire  # noqa: E402

FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures" / "gene_expression"
EVALS = ROOT.parents[2] / "evals" / "gene-expression-analysis" / "fixtures"
MATRIX = (FIXTURES / "GSE5583_series_matrix.txt.gz").read_bytes()
PLATFORM_TEXT = gzip.decompress((FIXTURES / "GPL81_reduced.txt.gz").read_bytes())
WILD_TYPE = ["GSM130365", "GSM130366", "GSM130367"]
KNOCK_OUT = ["GSM130368", "GSM130369", "GSM130370"]
GROUPS = [{"label": "wild type", "samples": WILD_TYPE}, {"label": "HDAC1 knock out", "samples": KNOCK_OUT}]
LOG2 = "gene_expression_input_over_limit"


def synthetic_matrix(samples, rows, *, platform="GPL999", taxid="9606", processing="synthetic", accession="GSE999001", extra_series=()):
    """A series matrix in GEO's format: `rows` is [(probe, [values])]; None is a missing cell."""
    lines = ['!Series_title\t"Synthetic series"', '!Series_geo_accession\t"%s"' % accession, '!Series_status\t"Public on Jan 02 2020"',
             '!Series_submission_date\t"Jan 01 2020"', '!Series_last_update_date\t"Mar 03 2021"', '!Series_platform_id\t"%s"' % platform,
             '!Series_sample_taxid\t"%s"' % taxid, *extra_series]
    quoted = lambda items: "\t".join('"%s"' % item for item in items)  # noqa: E731
    lines += ['!Sample_title\t' + quoted("array %d" % n for n in range(len(samples))), '!Sample_geo_accession\t' + quoted(samples),
              '!Sample_platform_id\t' + quoted([platform] * len(samples)), '!Sample_taxid_ch1\t' + quoted([taxid] * len(samples)),
              '!Sample_data_processing\t' + quoted([processing] * len(samples)),
              '!Sample_characteristics_ch1\t' + quoted(["arm: %s" % ("a" if n < len(samples) // 2 else "b") for n in range(len(samples))])]
    lines.append("!series_matrix_table_begin")
    lines.append("\t".join(['"ID_REF"'] + ['"%s"' % sample for sample in samples]))
    for probe, values in rows:
        lines.append("\t".join(['"%s"' % probe] + ["null" if value is None else repr(float(value)) for value in values]))
    lines.append("!series_matrix_table_end")
    return gzip.compress(("\n".join(lines) + "\n").encode("utf-8"), mtime=0)


def synthetic_platform(probes, *, accession="GPL999", taxid="9606", symbols=None, build=None):
    lines = ["^PLATFORM = %s" % accession, "!Platform_title = Synthetic platform", "!Platform_geo_accession = %s" % accession, "!Platform_taxid = %s" % taxid,
             "!Platform_organism = Synthetic sapiens", "!Platform_last_update_date = Feb 02 2019", "!platform_table_begin",
             "\t".join(["ID", "Gene Symbol", "ENTREZ_GENE_ID", "Gene Title"] + (["Genome Build"] if build else []))]
    for probe in probes:
        symbol = (symbols or {}).get(probe, "")
        lines.append("\t".join([probe, symbol, "", ("title of %s" % symbol) if symbol else ""] + ([build] if build else [])))
    lines.append("!platform_table_end")
    return ("\n".join(lines) + "\n").encode("utf-8")


def http_error(status):
    import urllib.error
    from email.message import Message

    return urllib.error.HTTPError("https://gateway.invalid/internal/sources/v1/fetch", status, "refused", Message(), io.BytesIO(b'{"error":{"code":"public_source_gateway_upstream_error"}}'))


def not_found():
    return http_error(404)


class Door:
    """GEO as a door: the matrix, the platform record and the series brief, or what a test says they are."""

    def __init__(self, matrix=MATRIX, platform=PLATFORM_TEXT, brief=b"", matrix_status=200, platform_status=200, matrix_route=None):
        self.matrix, self.platform, self.brief, self.matrix_status, self.platform_status = matrix, platform, brief, matrix_status, platform_status
        self.matrix_route = matrix_route
        self.calls = []

    def __call__(self, url, accepted, **options):
        self.calls.append(url)
        if "series_matrix.txt.gz" in url:
            if self.matrix_status == 404:
                raise not_found()
            if self.matrix_status == 403:
                raise wire.through_gateway("ncbi_geo__series_matrix_403.html")
            if self.matrix_route:
                # The gateway says which way it got the file when it had to ask again (`x-evimed-download-route`).
                return wire.Response(self.matrix, "application/x-gzip", 200, x_evimed_download_route=self.matrix_route)
            return wire.derived(self.matrix, "application/x-gzip")
        if "view=full" in url:
            if self.platform_status != 200:
                raise http_error(self.platform_status)
            return wire.derived(self.platform, "geo/text")
        if "view=brief" in url:
            return wire.derived(self.brief, "geo/text")
        raise AssertionError("no GEO answer for %s" % url)


class Workspace(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.workspace = pathlib.Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        patch = mock.patch.dict(os.environ, {"OPEN_SCIENCE_WORKSPACE_DIR": str(self.workspace)})
        patch.start()
        self.addCleanup(patch.stop)
        for name in ("EVIMED_PUBLIC_SOURCE_GATEWAY_URL", "EVIMED_MCP_FIXTURES", *engine.LIMIT_ENV.values()):
            os.environ.pop(name, None)
        sleep = mock.patch.object(source_transport.time, "sleep")
        sleep.start()
        self.addCleanup(sleep.stop)

    def preserve(self, accession="GSE5583", platform=None, door=None):
        self.door = door or Door()
        with mock.patch.object(public_sources, "_open_remote", self.door), mock.patch.object(public_sources, "_gateway_settings", return_value=None):
            return tools.call("gene_expression_series", {"accession": accession, **({"platform": platform} if platform else {})})

    def compute(self, capture, **arguments):
        arguments = {"captureDir": capture, "outputDir": "deliverables/hdac1", "groups": GROUPS, **arguments}
        return tools.call("gene_expression_differential", arguments)

    def read_json(self, relative):
        return json.loads((self.workspace / relative).read_text(encoding="utf-8"))


class ParseTests(unittest.TestCase):
    def test_the_real_series_matrix_is_read_in_full(self):
        matrix = engine.parse_series_matrix(MATRIX)
        self.assertEqual(matrix.first("geo_accession"), "GSE5583")
        self.assertEqual((len(matrix.sample_ids), len(matrix.probe_ids), matrix.values.shape), (6, 12488, (12488, 6)))
        self.assertEqual(matrix.sample_ids, WILD_TYPE + KNOCK_OUT)
        self.assertEqual(matrix.first("submission_date"), "Aug 23 2006")
        self.assertEqual(matrix.first("last_update_date"), "Feb 18 2018")
        table = engine._sample_table(matrix)  # noqa: SLF001
        self.assertEqual(table[0]["characteristics"]["Genotype"], "wild type")
        self.assertEqual(table[3]["characteristics"]["Genotype"], "HDAC1 knock out")
        self.assertEqual(table[3]["platform"], "GPL81")

    def test_dates_are_the_files_own_words_and_an_iso_reading(self):
        self.assertEqual(engine.stated_date("Public on Sep 19 2006"), "2006-09-19")
        self.assertEqual(engine.stated_date("Feb 18 2018"), "2018-02-18")
        self.assertIsNone(engine.stated_date("sometime in 2006"))

    def test_the_platform_record_gives_symbols_and_several_genes_for_one_probe(self):
        platform = engine.parse_platform(PLATFORM_TEXT)
        self.assertEqual(platform.first("geo_accession"), "GPL81")
        self.assertEqual(platform.row_count, 12488)
        self.assertEqual((platform.symbol_column, platform.entrez_column), ("Gene Symbol", "ENTREZ_GENE_ID"))
        self.assertEqual(platform.rows["100001_at"]["symbol"], "Cd3g")
        self.assertIsNone(platform.build_column, "GPL81 states no genome build, and none is assumed")
        self.assertEqual(engine.genes_of("Abc /// Def /// Abc"), ["Abc", "Def"])
        self.assertEqual(engine.genes_of("---"), [])

    def test_the_distribution_check_reads_the_real_values_as_linear(self):
        summary = engine.distribution_summary(engine.parse_series_matrix(MATRIX).values)
        self.assertTrue(summary["looksLinear"])
        self.assertGreater(summary["quantiles"]["q99"], 100)

    def test_a_file_that_is_not_a_matrix_is_named(self):
        with self.assertRaises(engine.GeneExpressionError) as caught:
            engine.parse_series_matrix(b"not gzip at all")
        self.assertEqual(caught.exception.code, "gene_expression_matrix_unreadable")
        with self.assertRaises(engine.GeneExpressionError) as caught:
            engine.parse_series_matrix(gzip.compress(b'!Series_title\t"x"\n'))
        self.assertEqual(caught.exception.code, "gene_expression_matrix_empty")
        ragged = gzip.compress(b'!series_matrix_table_begin\n"ID_REF"\t"GSM1"\t"GSM2"\n"p"\t1.0\n!series_matrix_table_end\n')
        with self.assertRaises(engine.GeneExpressionError) as caught:
            engine.parse_series_matrix(ragged)
        self.assertEqual(caught.exception.code, "gene_expression_matrix_unreadable")

    def test_a_missing_cell_is_not_a_zero(self):
        data = synthetic_matrix(["GSM1", "GSM2", "GSM3"], [("p", [1.0, None, 3.0])])
        matrix = engine.parse_series_matrix(data)
        self.assertTrue(math.isnan(matrix.values[0][1]))
        self.assertEqual(matrix.cells_missing, 1)


class StatisticsTests(unittest.TestCase):
    # statsmodels is in the runtime image and in CI's test environment at the image's pin; a machine without it
    # skips this one cross-check by name (the base-R reference table and the scipy comparison still run).
    @unittest.skipUnless(importlib.util.find_spec("statsmodels"), "statsmodels is not installed here")
    def test_benjamini_hochberg_equals_statsmodels(self):
        import numpy as np
        from statsmodels.stats.multitest import multipletests

        rng = np.random.default_rng(20261004)
        p = np.concatenate([rng.uniform(size=500) ** 3, np.array([0.5, 0.5, 1.0, 1.0])])
        ours = engine.benjamini_hochberg(p)
        self.assertTrue(np.allclose(ours, multipletests(p, method="fdr_bh")[1], rtol=0, atol=1e-15))

    def test_welch_equals_scipy_probe_by_probe_with_missing_cells(self):
        import numpy as np
        from scipy import stats

        rng = np.random.default_rng(7)
        values = rng.normal(8, 2, size=(300, 9))
        values[5, 1] = np.nan
        values[6, :3] = np.nan      # one value left in the reference group: untestable
        values[7, :] = 4.0          # no variance anywhere: untestable
        result = engine.welch(values, [0, 1, 2, 3], [4, 5, 6, 7, 8])
        self.assertFalse(result["tested"][6] or result["tested"][7])
        self.assertEqual((result["too_few"], result["zero_variance"]), (1, 1))
        for row in (0, 1, 5, 299):
            reference = stats.ttest_ind(values[row, 4:][~np.isnan(values[row, 4:])], values[row, :4][~np.isnan(values[row, :4])], equal_var=False)
            self.assertAlmostEqual(result["t"][row], reference.statistic, places=10)
            self.assertAlmostEqual(result["p"][row] / reference.pvalue, 1.0, places=10)
            self.assertAlmostEqual(result["df"][row], reference.df, places=9)


class SeriesTests(Workspace):
    def test_a_series_is_preserved_with_its_hashes_dates_and_identities(self):
        result = self.preserve()
        self.assertIn(result["status"], ("success", "warning"), result)
        data = result["data"]
        self.assertEqual((data["accession"], data["platform"]["accession"], data["matrix"]["samples"], data["matrix"]["probes"]), ("GSE5583", "GPL81", 6, 12488))
        self.assertEqual(data["matrix"]["sha256"], hashlib.sha256(MATRIX).hexdigest(), "the hash is of the bytes GEO served")
        self.assertEqual(data["series"]["lastUpdateDate"], {"stated": "Feb 18 2018", "date": "2018-02-18"})
        self.assertEqual(data["series"]["status"]["date"], "2006-09-19")
        self.assertTrue(data["computationReady"])
        self.assertEqual({name: entry["status"] for name, entry in data["identity"].items()},
                         {"samples": "ok", "platform": "ok", "platformRecord": "ok", "organism": "ok", "genomeBuild": "unknown", "scale": "ok"})
        self.assertTrue(data["valueScale"]["looksLinear"])
        capture = self.workspace / data["captureDir"]
        self.assertEqual((capture / "series_matrix.txt.gz").read_bytes(), MATRIX, "the matrix is preserved exactly as served")
        self.assertEqual(immutable_capture.verify_capture(self.workspace, pathlib.Path(data["captureDir"])), [])
        self.assertEqual(sorted(path.name for path in capture.iterdir()), ["capture.json", "platform.soft.txt.gz", "probe-annotation.tsv", "record.json", "samples.tsv", "series_matrix.txt.gz"])
        record = self.read_json(data["paths"]["record.json"])
        self.assertEqual(record["platform"]["sha256"], hashlib.sha256(PLATFORM_TEXT).hexdigest())
        self.assertEqual(hashlib.sha256((capture / "platform.soft.txt.gz").read_bytes()).hexdigest(), record["platform"]["storedSha256"])
        self.assertEqual(gzip.decompress((capture / "platform.soft.txt.gz").read_bytes()), PLATFORM_TEXT)
        self.assertIn("places no restrictions", record["source"]["terms"])
        samples = (capture / "samples.tsv").read_text(encoding="utf-8").splitlines()
        self.assertEqual(samples[0].split("\t")[-2:], ["Genotype", "characteristics_2"])
        self.assertEqual(len(samples), 7)

    def test_the_route_a_file_came_by_is_in_the_result_and_never_in_the_capture(self):
        # The gateway asks again before it believes NCBI's refusal of a public file, and says which way the bytes arrived.
        direct = self.preserve()
        self.assertNotIn("downloadRoutes", direct["data"], "a gateway that said nothing is not described")
        routed = self.preserve(door=Door(matrix_route="edge"))
        self.assertEqual(routed["data"]["downloadRoutes"], {"matrix": "edge"})
        self.assertEqual(routed["data"]["captureDir"], direct["data"]["captureDir"], "the same bytes are the same capture whichever way they came")
        retried = self.preserve(door=Door(matrix_route="direct-retry"))
        self.assertEqual(retried["data"]["downloadRoutes"], {"matrix": "direct-retry"})
        # A route this side does not know is not recorded under a made-up name.
        odd = self.preserve(door=Door(matrix_route="tunnel-of-love"))
        self.assertNotIn("downloadRoutes", odd["data"])

    def test_a_refusal_of_the_matrix_by_the_file_server_is_not_called_a_400_nor_an_item_held_back(self):
        # Production, 2026-10-05: NCBI's file server answered 403 and the tool said "refused this request (HTTP 400)" and
        # "do not retry: it holds the item and does not serve it to an unauthenticated client".
        result = self.preserve(door=Door(matrix_status=403))
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "source_access_denied")
        self.assertIn("(HTTP 403)", result["summary"])
        self.assertNotIn("HTTP 400", result["summary"])
        actions = " ".join(result["next_actions"])
        self.assertNotIn("unauthenticated", actions)
        self.assertIn("refusal of this server's address", actions)
        self.assertIn("a later call may be served", actions)

    def test_preserving_again_is_the_same_capture(self):
        first = self.preserve()["data"]["captureDir"]
        second = self.preserve()["data"]["captureDir"]
        self.assertEqual(first, second)

    def test_a_series_on_several_platforms_is_a_choice_not_a_guess(self):
        brief = b'^SERIES = GSE123\n!Series_title = Two platforms\n!Series_geo_accession = GSE123\n!Series_platform_id = GPL96\n!Series_platform_id = GPL97\n'
        result = self.preserve("GSE123", door=Door(matrix_status=404, brief=brief))
        self.assertEqual(result["data"]["outcome"]["reason"], "multi_platform_series")
        self.assertEqual(result["data"]["platforms"], ["GPL96", "GPL97"])
        self.assertIn("GSEnnn/GSE123/matrix/GSE123_series_matrix.txt.gz", self.door.calls[0], "GSE123's directory is GSEnnn")
        chosen = self.preserve("GSE123", platform="GPL96", door=Door(matrix_status=404, brief=brief))
        self.assertEqual(chosen["data"]["outcome"]["reason"], "no_series_matrix")
        self.assertIn("GSE123/matrix/GSE123-GPL96_series_matrix.txt.gz", self.door.calls[0])
        wrong = self.preserve("GSE123", platform="GPL1", door=Door(matrix_status=404, brief=brief))
        self.assertEqual(wrong["data"]["outcome"]["reason"], "platform_not_in_series")

    def test_an_unknown_series_is_not_found_not_an_outage(self):
        result = self.preserve("GSE99999999", door=Door(matrix_status=404, brief=b"No public or private accession matched.\n"))
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["outcome"]["reason"], "series_not_found")

    def test_the_directory_of_a_series_follows_geos_rule(self):
        self.assertEqual(tools.series_directory_stub("GSE5583"), "GSE5nnn")
        self.assertEqual(tools.series_directory_stub("GSE123"), "GSEnnn")
        self.assertEqual(tools.series_directory_stub("GSE123456"), "GSE123nnn")

    def test_a_bad_accession_is_refused_with_the_field_named(self):
        result = tools.call("gene_expression_series", {"accession": "5583"})
        self.assertEqual(result["error"]["code"], "gene_expression_input_invalid")

    def test_a_platform_that_is_not_the_arrays_platform_is_a_mismatch_and_computes_nothing(self):
        wrong = synthetic_platform(["not_a_probe_%d" % n for n in range(20)], accession="GPL81")
        result = self.preserve(door=Door(platform=wrong))
        self.assertFalse(result["data"]["computationReady"])
        self.assertEqual(result["data"]["identity"]["platformRecord"]["status"], "mismatch")
        refused = self.compute(result["data"]["captureDir"])
        self.assertEqual(refused["error"]["code"], "gene_expression_identity_mismatch")
        self.assertFalse((self.workspace / "deliverables").exists(), "a refused computation writes nothing")

    def test_a_platform_record_that_cannot_be_fetched_does_not_take_the_series_with_it(self):
        result = self.preserve(door=Door(platform_status=503))
        self.assertEqual(result["status"], "warning", result)
        data = result["data"]
        self.assertFalse(data["platform"]["record"]["available"])
        self.assertEqual(data["platform"]["record"]["state"], "unavailable")
        self.assertEqual({name: entry["status"] for name, entry in data["identity"].items()}["platformRecord"], "unknown")
        self.assertTrue(data["computationReady"], "no mismatch, so the matrix's own identities stand")
        self.assertTrue(any("WITHOUT the platform's probe annotation" in text for text in [result["summary"]]))
        capture = self.workspace / data["captureDir"]
        self.assertFalse((capture / "platform.soft.txt.gz").exists())
        self.assertEqual(len((capture / "probe-annotation.tsv").read_text().splitlines()), 1, "a header and no rows: no probe is annotated")
        computed = self.compute(data["captureDir"])
        self.assertIn(computed["status"], ("success", "warning"), computed)
        results = self.read_json(computed["data"]["resultsPath"])
        self.assertEqual(results["diagnostics"]["unannotatedProbes"], 12488)
        self.assertEqual(results["top"][0]["probe"], "101451_at", "the statistics do not depend on the annotation")
        self.assertEqual(results["top"][0]["geneSymbols"], [])

    def test_a_platform_record_over_its_limit_is_still_a_refusal_not_a_degrade(self):
        with mock.patch.dict(os.environ, {"EVIMED_GENE_EXPRESSION_MAX_ANNOTATION_BYTES": "100000"}):
            result = self.preserve()
        self.assertEqual(result["error"]["code"], LOG2)
        self.assertEqual(result["data"]["limit"], "annotation_bytes")

    def test_samples_on_two_platforms_are_a_mismatch(self):
        samples = ["GSM1", "GSM2", "GSM3", "GSM4"]
        data = synthetic_matrix(samples, [("p1", [1, 2, 3, 4])])
        lines = gzip.decompress(data).decode().replace('"GPL999"\t"GPL999"\t"GPL999"\t"GPL999"', '"GPL999"\t"GPL999"\t"GPL998"\t"GPL998"')
        matrix = engine.parse_series_matrix(gzip.compress(lines.encode()))
        checks = engine.identity_checks(matrix, None)
        self.assertEqual(checks["checks"]["platform"]["status"], "mismatch")
        self.assertFalse(checks["computationReady"])

    def test_an_organism_that_differs_from_the_platforms_is_a_mismatch(self):
        samples = ["GSM%d" % n for n in range(1, 7)]
        rows = [("p%d" % n, [float(n + k) for k in range(6)]) for n in range(5)]
        data = synthetic_matrix(samples, rows, taxid="10090")
        result = self.preserve(door=Door(matrix=data, platform=synthetic_platform([row[0] for row in rows], taxid="9606")))
        self.assertEqual(result["data"]["identity"]["organism"]["status"], "mismatch")
        self.assertFalse(result["data"]["computationReady"])

    def test_a_platform_that_states_a_genome_build_has_it_recorded(self):
        samples = ["GSM%d" % n for n in range(1, 7)]
        rows = [("p%d" % n, [float(n + k) for k in range(6)]) for n in range(5)]
        platform = synthetic_platform([row[0] for row in rows], symbols={"p1": "AAA"}, build="GRCh38")
        result = self.preserve(door=Door(matrix=synthetic_matrix(samples, rows), platform=platform))
        self.assertEqual(result["data"]["identity"]["genomeBuild"]["status"], "ok")
        self.assertIn("GRCh38", result["data"]["identity"]["genomeBuild"]["detail"])


class LimitsTests(Workspace):
    def test_every_limit_has_a_default_and_an_environment_name(self):
        self.assertEqual(sorted(engine.LIMIT_ENV), sorted(engine.LIMIT_NAMES))
        self.assertEqual(sorted(engine.LIMIT_DEFAULTS), sorted(engine.LIMIT_NAMES))
        self.assertEqual(engine.limits({}), engine.LIMIT_DEFAULTS)
        self.assertEqual(engine.limits({"EVIMED_GENE_EXPRESSION_MAX_SAMPLES": "5", "EVIMED_GENE_EXPRESSION_MAX_PROBES": "nonsense"})["samples"], 5)
        self.assertEqual(engine.limits({"EVIMED_GENE_EXPRESSION_MAX_PROBES": "nonsense"})["probes"], engine.LIMIT_DEFAULTS["probes"])

    def refused(self, result, limit):
        self.assertEqual(result["error"]["code"], LOG2, result)
        self.assertEqual(result["data"]["limit"], limit)
        self.assertIn("unit", result["data"])
        if limit == "wall_clock":
            self.assertEqual(result["data"]["allowed"], engine.LIMIT_DEFAULTS["wall_clock"], "a stopped computation reports the limit, not a measurement")
        else:
            self.assertGreater(result["data"]["observed"], result["data"]["allowed"])

    def test_too_many_samples_refuse_the_series_and_preserve_nothing(self):
        with mock.patch.dict(os.environ, {"EVIMED_GENE_EXPRESSION_MAX_SAMPLES": "5"}):
            self.refused(self.preserve(), "samples")
        self.assertFalse((self.workspace / ".evimed-sources").exists())

    def test_too_many_probes_refuse_the_series(self):
        with mock.patch.dict(os.environ, {"EVIMED_GENE_EXPRESSION_MAX_PROBES": "1000"}):
            self.refused(self.preserve(), "probes")

    def test_a_matrix_over_its_byte_limit_is_refused_before_it_is_read(self):
        with mock.patch.dict(os.environ, {"EVIMED_GENE_EXPRESSION_MAX_MATRIX_BYTES": "100000"}):
            self.refused(self.preserve(), "matrix_bytes")

    def test_a_platform_record_over_its_byte_limit_is_refused(self):
        with mock.patch.dict(os.environ, {"EVIMED_GENE_EXPRESSION_MAX_ANNOTATION_BYTES": "100000"}):
            self.refused(self.preserve(), "annotation_bytes")

    def test_a_working_set_over_the_memory_limit_is_refused(self):
        with mock.patch.dict(os.environ, {"EVIMED_GENE_EXPRESSION_MAX_MEMORY_BYTES": "100000"}):
            self.refused(self.preserve(), "memory")

    def test_a_computation_over_the_wall_clock_is_stopped_and_writes_nothing(self):
        capture = self.preserve()["data"]["captureDir"]
        with mock.patch.object(tools.subprocess, "run", side_effect=subprocess.TimeoutExpired("python3", 1)):
            result = self.compute(capture)
        self.refused(result, "wall_clock")
        self.assertFalse((self.workspace / "deliverables").exists())

    def test_the_computation_checks_the_limits_again_for_a_capture_it_is_handed(self):
        capture = self.preserve()["data"]["captureDir"]
        with mock.patch.dict(os.environ, {"EVIMED_GENE_EXPRESSION_MAX_SAMPLES": "5"}):
            self.refused(self.compute(capture), "samples")

    def test_an_over_limit_refusal_is_offered_to_the_counter_and_a_failing_counter_changes_nothing(self):
        capture = self.preserve()["data"]["captureDir"]
        seen = []
        with mock.patch.object(tools, "report_limit", side_effect=lambda limit, **_: seen.append(limit)), mock.patch.dict(os.environ, {"EVIMED_GENE_EXPRESSION_MAX_SAMPLES": "5"}):
            self.refused(self.compute(capture), "samples")
        self.assertEqual(seen, ["samples"])
        with mock.patch.object(public_sources, "_gateway_settings", side_effect=RuntimeError("down")):
            self.assertFalse(tools.report_limit("samples"))

    def test_a_gzip_that_expands_past_its_bound_is_refused(self):
        bomb = gzip.compress(b"!Series_title\t\"x\"\n" + b"#" * (5 * 1024 * 1024))
        with self.assertRaises(engine.GeneExpressionError) as caught:
            engine.parse_series_matrix(bomb, limit_values={**engine.LIMIT_DEFAULTS, "matrix_bytes": 1024})
        self.assertEqual((caught.exception.code, caught.exception.detail["limit"]), (LOG2, "matrix_bytes"))


class DifferentialTests(Workspace):
    def setUp(self):
        super().setUp()
        self.capture = self.preserve()["data"]["captureDir"]

    def test_the_top_table_agrees_with_base_r(self):
        """The reference is `evals/gene-expression-analysis/fixtures/reference_top_table.tsv`: R 4.3.3 `t.test` (Welch) and `p.adjust(BH)`
        on the same file, written by `reference_gse5583.R`. Tolerance: relative 1e-8 on every statistic (the two implementations
        differ only in how the t distribution is evaluated); the order of the top 50 must be identical."""
        result = self.compute(self.capture, topN=50)
        self.assertIn(result["status"], ("success", "warning"), result)
        results = self.read_json(result["data"]["resultsPath"])
        reference = list(csv.DictReader((EVALS / "reference_top_table.tsv").read_text(encoding="utf-8").splitlines(), delimiter="\t"))
        summary = dict(line.split("\t") for line in (EVALS / "reference_top_table.tsv.summary").read_text().strip().splitlines())
        self.assertEqual([row["probe"] for row in results["top"]], [row["probe_id"] for row in reference])
        names = {"mean_reference": "meanReference", "mean_comparison": "meanComparison", "log2_fold_change": "logFC", "t": "t", "df": "df", "p_value": "pValue",
                 "adj_p_value": "adjPValue", "ci95_low": "ciLow"}
        for ours, theirs in zip(results["top"], reference):
            for reference_name, our_name in names.items():
                self.assertAlmostEqual(ours[our_name] / float(theirs[reference_name]), 1.0, places=8, msg="%s %s" % (ours["probe"], our_name))
        diagnostics = results["diagnostics"]
        self.assertEqual(diagnostics["probesTested"], int(summary["probes_tested"]))
        self.assertEqual(diagnostics["probesSignificantAtFdr05"], int(summary["adj_lt_0.05"]))
        self.assertEqual(diagnostics["probesSignificantAtFdr01"], int(summary["adj_lt_0.01"]))
        self.assertEqual(results["transformation"]["applied"], "log2" if summary["logc"] == "TRUE" else "none")

    def test_the_full_table_is_every_tested_probe_in_the_same_order(self):
        result = self.compute(self.capture)
        rows = list(csv.DictReader((self.workspace / result["data"]["tablePath"]).read_text(encoding="utf-8").splitlines(), delimiter="\t"))
        self.assertEqual(len(rows), 12488)
        adjusted = [float(row["adj_p_value"]) for row in rows]
        self.assertEqual(adjusted, sorted(adjusted), "BH adjusted p-values are monotone in the p order")
        self.assertTrue(all(float(row["adj_p_value"]) >= float(row["p_value"]) for row in rows))

    def test_the_result_states_what_it_is_and_is_not(self):
        result = self.compute(self.capture)
        results = self.read_json(result["data"]["resultsPath"])
        self.assertIs(results["method"]["isLimma"], False)
        self.assertIn("not limma", results["method"]["statement"].lower())
        self.assertIn("empirical-Bayes", results["method"]["statement"])
        self.assertEqual((results["method"]["randomness"], results["method"]["seed"]), ("none", None))
        self.assertEqual(results["method"]["contrast"], "HDAC1 knock out minus wild type")
        self.assertIn("not limma", (self.workspace / result["data"]["topTablePath"]).read_text(encoding="utf-8"))
        self.assertIn("not limma", result["data"]["method"]["statement"].lower())

    def test_the_diagnostics_say_what_was_checked_and_done(self):
        results = self.read_json(self.compute(self.capture)["data"]["resultsPath"])
        diagnostics = results["diagnostics"]
        self.assertEqual(diagnostics["groupSizes"], {"reference": 3, "comparison": 3})
        self.assertEqual((diagnostics["probesInMatrix"], diagnostics["probesDroppedTotal"]), (12488, 0))
        self.assertGreater(diagnostics["multiGeneProbes"], 0, "GPL81 annotates some probes with several genes")
        self.assertIn("not copied to each gene", diagnostics["multiGeneHandling"])
        transformation = results["transformation"]
        self.assertEqual((transformation["requested"], transformation["applied"], transformation["distribution"]["looksLinear"]), ("auto", "log2", True))
        self.assertIn("MAS 5.0", transformation["statedProcessing"][0])
        self.assertEqual(results["identity"]["genomeBuild"]["status"], "unknown")
        self.assertEqual(results["series"]["matrixSha256"], hashlib.sha256(MATRIX).hexdigest())
        multi = [row for row in self.read_json(self.compute(self.capture, outputDir="deliverables/again")["data"]["resultsPath"])["top"] if row["multiGene"]]
        self.assertTrue(all(len(row["geneSymbols"]) > 1 for row in multi))

    def test_a_transformation_is_stated_and_a_mismatch_with_the_distribution_is_labelled(self):
        forced_none = self.read_json(self.compute(self.capture, transform="none", outputDir="deliverables/none")["data"]["resultsPath"])
        self.assertEqual(forced_none["transformation"]["applied"], "none")
        self.assertTrue(any("look linear" in warning for warning in forced_none["transformation"]["warnings"]))

    def test_the_files_carry_receipts_the_platform_can_check(self):
        result = self.compute(self.capture)
        data = result["data"]
        receipt = self.read_json(data["receiptPath"])
        execution = receipt["executions"][-1]
        self.assertEqual(receipt["schemaVersion"], 1)
        results_bytes = (self.workspace / data["resultsPath"]).read_bytes()
        self.assertEqual((execution["output"]["after"]["path"], execution["output"]["after"]["sha256"], execution["output"]["observedWrite"]),
                         (data["resultsPath"], hashlib.sha256(results_bytes).hexdigest(), True))
        script = (self.workspace / execution["script"]["path"]).read_bytes()
        self.assertEqual(hashlib.sha256(script).hexdigest(), execution["script"]["sha256"])
        self.assertEqual(script, pathlib.Path(engine.__file__).read_bytes(), "the code beside the result is the code that ran")
        for entry in execution["inputs"]:
            self.assertEqual(hashlib.sha256((self.workspace / entry["path"]).read_bytes()).hexdigest(), entry["sha256"], entry["path"])
        self.assertEqual({"numpy", "scipy"}, set(execution["versions"]["libraries"]))
        self.assertTrue(all(file["sha256"] and file["bytes"] for file in data["files"].values()))

    def test_machine_values_are_what_the_report_renders_from(self):
        results = self.read_json(self.compute(self.capture)["data"]["resultsPath"])
        self.assertIsInstance(results["top"][0]["logFC"], float)
        self.assertIsInstance(results["diagnostics"]["probesTested"], int)
        self.assertEqual(len(results["top"]), 20)
        self.assertEqual(results["top"][0]["rank"], 1)

    def test_the_same_analysis_asked_again_is_the_same_files_and_a_different_one_does_not_overwrite(self):
        first = self.compute(self.capture)
        before = {name: (self.workspace / entry["path"]).read_bytes() for name, entry in first["data"]["files"].items()}
        second = self.compute(self.capture)
        self.assertEqual({name: (self.workspace / entry["path"]).read_bytes() for name, entry in second["data"]["files"].items()}, before)
        other = self.compute(self.capture, topN=5)
        self.assertEqual(other["error"]["code"], "gene_expression_output_exists")
        self.assertEqual((self.workspace / first["data"]["resultsPath"]).read_bytes(), before["results"], "the earlier results are kept")

    def test_a_group_that_cannot_be_analysed_is_refused_with_its_reason(self):
        cases = [
            ([{"label": "a", "samples": WILD_TYPE[:2]}, {"label": "b", "samples": KNOCK_OUT}], "has 2 sample"),
            ([{"label": "a", "samples": WILD_TYPE}, {"label": "b", "samples": [WILD_TYPE[0], *KNOCK_OUT[:2]]}], "share sample"),
            ([{"label": "a", "samples": WILD_TYPE}, {"label": "b", "samples": ["GSM999999", *KNOCK_OUT[:2]]}], "not in this series matrix"),
            ([{"label": "a", "samples": WILD_TYPE}], "exactly two groups"),
            ([{"label": "a", "samples": WILD_TYPE}, {"label": "a", "samples": KNOCK_OUT}], "different labels"),
            ([{"label": "a", "samples": WILD_TYPE + WILD_TYPE[:1]}, {"label": "b", "samples": KNOCK_OUT}], "more than once"),
        ]
        for index, (groups, expected) in enumerate(cases):
            result = self.compute(self.capture, groups=groups, outputDir="deliverables/refused%d" % index)
            self.assertEqual(result["error"]["code"], "gene_expression_groups_invalid", result)
            self.assertIn(expected, result["error"]["message"])
        self.assertFalse((self.workspace / "deliverables").exists(), "a refused computation writes nothing")

    def test_groups_can_be_declared_by_an_annotation_value(self):
        groups = [{"label": "wt", "where": {"field": "Genotype", "equals": "wild type"}}, {"label": "ko", "where": {"field": "Genotype", "equals": "HDAC1 knock out"}}]
        by_value = self.read_json(self.compute(self.capture, groups=groups, outputDir="deliverables/by-value")["data"]["resultsPath"])
        self.assertEqual([group["samples"] for group in by_value["design"]["groups"]], [WILD_TYPE, KNOCK_OUT])
        none = self.compute(self.capture, groups=[{"label": "wt", "where": {"field": "Genotype", "equals": "nothing like it"}}, groups[1]], outputDir="deliverables/none-match")
        self.assertIn("has 0 sample", none["error"]["message"])

    def test_the_reference_group_decides_the_sign(self):
        forward = self.read_json(self.compute(self.capture, outputDir="deliverables/forward")["data"]["resultsPath"])["top"][0]
        reverse = self.read_json(self.compute(self.capture, outputDir="deliverables/reverse", reference="HDAC1 knock out")["data"]["resultsPath"])["top"][0]
        self.assertEqual(forward["probe"], reverse["probe"])
        self.assertAlmostEqual(forward["logFC"], -reverse["logFC"], places=12)
        self.assertEqual(forward["pValue"], reverse["pValue"])

    def test_an_edited_capture_is_not_computed_from(self):
        path = self.workspace / self.capture / "samples.tsv"
        path.write_bytes(path.read_bytes() + b"edited\n")
        result = self.compute(self.capture)
        self.assertEqual(result["error"]["code"], "gene_expression_capture_invalid")
        self.assertIn("samples.tsv was edited", result["error"]["message"])
        self.assertEqual(immutable_capture.verify_capture(self.workspace, pathlib.Path(self.capture))[0].split(" was edited")[0].split("/")[-1], "samples.tsv")

    def test_paths_outside_their_roots_are_refused(self):
        for arguments in ({"captureDir": "../etc"}, {"captureDir": "/etc/passwd"}, {"outputDir": "reports/x"}, {"outputDir": "deliverables/../x"}, {"outputDir": "deliverables"}, {"captureDir": ".evimed-sources/gene-expression"}):
            result = self.compute(arguments.get("captureDir", self.capture), **{key: value for key, value in arguments.items() if key != "captureDir"})
            self.assertEqual(result["error"]["code"], "gene_expression_input_invalid", arguments)

    def test_the_code_beside_a_result_runs_alone(self):
        """A recipient needs the copied file, numpy and scipy, and nothing else of this server."""
        result = self.compute(self.capture)
        copy = self.workspace / result["data"]["codePath"]
        with tempfile.TemporaryDirectory() as bare:
            local = pathlib.Path(bare) / "gene_expression.py"
            local.write_bytes(copy.read_bytes())
            request = {"workspace": str(self.workspace), "captureDir": self.capture, "outputDir": "deliverables/alone", "groups": GROUPS}
            completed = subprocess.run([sys.executable, str(local), "differential"], input=json.dumps(request).encode(), capture_output=True, cwd=bare, check=False)
        answer = json.loads(completed.stdout)
        self.assertTrue(answer["ok"], answer)
        self.assertEqual(answer["answer"]["files"]["results"]["sha256"].__class__, str)

    def test_the_capabilitys_independent_verifier_agrees_and_notices_an_edit(self):
        """`capabilities/gene-expression-analysis/scripts/verify_result.py` recomputes every probe with scipy.stats.ttest_ind and statsmodels
        and checks the receipt's hashes, needing nothing of this server; it is what a recipient runs."""
        result = self.compute(self.capture)
        verifier = ROOT.parents[2] / "capabilities" / "gene-expression-analysis" / "scripts" / "verify_result.py"
        directory = self.workspace / "deliverables" / "hdac1"
        command = [sys.executable, str(verifier), str(directory), "--workspace", str(self.workspace)]
        completed = subprocess.run(command, capture_output=True, check=False)
        report = json.loads(completed.stdout)
        self.assertEqual((completed.returncode, report["ok"], report["findings"]), (0, True, []), report)
        self.assertEqual(report["checked"]["probes"], 12488)
        self.assertEqual(report["checked"]["statisticsDiffering"], 0)
        self.assertEqual((report["checked"]["receiptHashes"]["differing"], report["checked"]["receiptHashes"]["missing"]), (0, 0))
        self.assertIn("not limma", report["method"])
        table = directory / "gene-expression-de-table.tsv"
        lines = table.read_text(encoding="utf-8").splitlines()
        parts = lines[1].split("\t")
        parts[15] = repr(float(parts[15]) * 1.001)   # the p value of the top probe, edited
        lines[1] = "\t".join(parts)
        table.write_text("\n".join(lines) + "\n", encoding="utf-8")
        edited = subprocess.run(command, capture_output=True, check=False)
        report = json.loads(edited.stdout)
        self.assertEqual((edited.returncode, report["ok"]), (1, False))
        self.assertTrue(any("p_value" in finding for finding in report["findings"]), report["findings"])
        self.assertEqual(result["status"] in ("success", "warning"), True)

    def test_a_series_of_linear_and_of_log_values_is_judged_by_its_values(self):
        samples = ["GSM%d" % n for n in range(1, 9)]
        import random

        rng = random.Random(5)
        log_rows = [("p%03d" % n, [rng.gauss(8, 1) + (1.5 if k >= 4 and n < 10 else 0) for k in range(8)]) for n in range(200)]
        linear_rows = [(probe, [2 ** value for value in values]) for probe, values in log_rows]
        outcomes = {}
        for name, rows in (("log", log_rows), ("linear", linear_rows)):
            data = synthetic_matrix(samples, rows, accession="GSE9990%d" % len(name))
            platform = synthetic_platform([row[0] for row in rows], symbols={"p000": "GENE0"})
            capture = self.preserve("GSE9990%d" % len(name), door=Door(matrix=data, platform=platform))["data"]["captureDir"]
            groups = [{"label": "a", "samples": samples[:4]}, {"label": "b", "samples": samples[4:]}]
            outcomes[name] = self.read_json(self.compute(capture, groups=groups, outputDir="deliverables/" + name)["data"]["resultsPath"])
        self.assertEqual((outcomes["log"]["transformation"]["applied"], outcomes["linear"]["transformation"]["applied"]), ("none", "log2"))
        # The same measurements on either scale give the same test: log2(2**x) = x.
        for ours, theirs in zip(outcomes["log"]["top"][:5], outcomes["linear"]["top"][:5]):
            self.assertEqual(ours["probe"], theirs["probe"])
            self.assertAlmostEqual(ours["t"], theirs["t"], places=8)

    def test_missing_cells_drop_only_the_probes_they_make_untestable(self):
        samples = ["GSM%d" % n for n in range(1, 9)]
        rows = [("p%d" % n, [float(10 + n + (k % 3) * 0.1 * (n + 1) + (2 if k >= 4 else 0)) for k in range(8)]) for n in range(30)]
        rows[3] = ("p3", [None, None, None, 11.0, 12.0, 13.0, 14.0, 15.0])      # one value left in the reference group
        rows[4] = ("p4", [10.0, None, 11.0, 12.0, 13.0, None, 14.0, 15.0])     # still testable
        rows[5] = ("p5", [5.0] * 8)                                             # no variance
        data = synthetic_matrix(samples, rows, accession="GSE999005")
        capture = self.preserve("GSE999005", door=Door(matrix=data, platform=synthetic_platform([row[0] for row in rows])))["data"]["captureDir"]
        groups = [{"label": "a", "samples": samples[:4]}, {"label": "b", "samples": samples[4:]}]
        diagnostics = self.read_json(self.compute(capture, groups=groups, outputDir="deliverables/missing")["data"]["resultsPath"])["diagnostics"]
        self.assertEqual(diagnostics["probesDropped"], {"tooFewValues": 1, "zeroVariance": 1})
        self.assertEqual((diagnostics["probesTested"], diagnostics["missingValueCells"]), (28, 5))


if __name__ == "__main__":
    unittest.main()
