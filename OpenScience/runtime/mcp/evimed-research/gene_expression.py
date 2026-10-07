"""NCBI Gene Expression Omnibus (GEO) series to a differential-expression table: parse, verify, compute.

This is the public data resource at ncbi.nlm.nih.gov/geo, not the platform's 循证 GEO module: every name that
belongs to it here is `gene_expression` / `ncbi_geo`, and nothing in this file reaches `geo_read`/`geo_write`.

One self-contained module on purpose. The control plane's receipt names the code that produced a result by its
path and sha-256, so the file that parses the matrix, checks the identities and computes the statistics is also
the file that is copied beside the result (`gene_expression.py`), and a recipient who runs it needs nothing of
ours: standard library, numpy and scipy, which the runtime image already ships. It reaches no network, imports no
other module of this server and writes only inside the workspace.

What it computes, and what it does not (the same words are written into every result):

- Per probe, a Welch two-sample t-test between two declared groups on log2 expression values (the platform's own
  processed values; log2 is applied only when the distribution check says they are linear, and the result says
  which), a 95% interval for the log2 fold change, and Benjamini-Hochberg adjusted p-values over the probes that
  could be tested.
- It is **not limma**. There is no empirical-Bayes moderation of the variances, so a probe's variance comes from
  its own few arrays: with small groups the variances are less stable, the t statistics and p-values are noisier,
  and the top table can differ from a limma analysis of the same series, sometimes in its order. It is a
  transparent first look at a series, not a replacement for limma, edgeR or DESeq2 where those are required.
- Nothing is random, so there is no seed: the same series bytes and the same declared groups give the same bytes.
- It reads processed matrices only. Raw reads, CEL files and re-normalisation are out of scope.

Hidden knowledge, from the live wire (2026-10-04) and not from the documentation:

- **A series matrix is one platform's file.** A series on several platforms has `GSEn-GPLm_series_matrix.txt.gz`
  files and no plain `GSEn_series_matrix.txt.gz` (that one answers 404); the platform is then a choice the caller
  makes, never a guess.
- **The matrix says its own sample and platform identities**, once per sample (`!Sample_geo_accession`,
  `!Sample_platform_id`, `!Sample_taxid_ch1`); the table header repeats the sample accessions. The platform record
  is a second file (`acc.cgi?acc=GPLn&targ=self&form=text&view=data`, content type `geo/text`, tens of MB for the
  common human platforms) whose table maps probe ids to symbols. Neither file says its genome build: a platform
  that has no build column has an unknown build, and that is what is recorded.
- **Values are whatever the submitter processed.** GSE5583 (MAS5, linear intensities) and a RMA series (log2) arrive
  in the same shape; only the values tell them apart, so the distribution is checked before a statistic is taken.
- **Missing cells are `null`, empty or `NA`.** None is zero.
- **A probe can map to several genes**: Affymetrix annotation joins them with ` /// `.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import math
import os
import re
import sys
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

ENGINE_VERSION = "1.0.0"
METHOD_ID = "welch-bh-log2"
SCHEMA_VERSION = 1
RESULTS_KIND = "gene-expression-differential"

NOT_LIMMA = (
    "This is not limma. It runs a Welch t-test per probe on log2 values with Benjamini-Hochberg adjustment and does "
    "no empirical-Bayes moderation of the variances, so with small groups the per-probe variances are less stable and "
    "the top table can differ from a limma analysis of the same series, in order as well as in p-values."
)

SOURCES_ROOT = ".evimed-sources/gene-expression"
DELIVERABLES_ROOT = "deliverables"

# The files one analysis writes into its output directory. `results` and `receipt` are last, so a directory with
# either of them is a finished analysis.
RESULT_FILES = {
    "results": "gene-expression-results.json",
    "table": "gene-expression-de-table.tsv",
    "topTable": "gene-expression-top-table.md",
    "analysedMatrix": "gene-expression-analysed-matrix.tsv.gz",
    "request": "gene-expression-request.json",
    "code": "gene_expression.py",
    "receipt": "gene-expression-receipt.json",
}

# The limits (principle 15): each is a key in the control plane's config (`OPEN_SCIENCE_GENE_EXPRESSION_*`),
# forwarded into the runtime as `EVIMED_GENE_EXPRESSION_*`. These are the values used when the environment says
# nothing; `apps/server/test/geneExpressionLimits.test.mjs` holds them equal to `@evimed/domain`'s defaults.
LIMIT_NAMES = ("matrix_bytes", "annotation_bytes", "samples", "probes", "memory", "wall_clock")
LIMIT_ENV = {
    "matrix_bytes": "EVIMED_GENE_EXPRESSION_MAX_MATRIX_BYTES",
    "annotation_bytes": "EVIMED_GENE_EXPRESSION_MAX_ANNOTATION_BYTES",
    "samples": "EVIMED_GENE_EXPRESSION_MAX_SAMPLES",
    "probes": "EVIMED_GENE_EXPRESSION_MAX_PROBES",
    "memory": "EVIMED_GENE_EXPRESSION_MAX_MEMORY_BYTES",
    "wall_clock": "EVIMED_GENE_EXPRESSION_MAX_WALL_CLOCK_SECONDS",
}
LIMIT_DEFAULTS = {
    "matrix_bytes": 64 * 1024 * 1024,
    "annotation_bytes": 128 * 1024 * 1024,
    "samples": 200,
    "probes": 100_000,
    "memory": 2 * 1024 * 1024 * 1024,
    "wall_clock": 120,
}
LIMIT_UNITS = {"matrix_bytes": "bytes", "annotation_bytes": "bytes", "samples": "samples", "probes": "probes", "memory": "bytes", "wall_clock": "seconds"}
# A compressed matrix may expand; a file that expands past this many times its compressed bound is refused, so a
# few KB of gzip cannot become a gigabyte of text.
MAX_EXPANSION = 16
# What the working set of a computation costs per cell: the parsed array, the log2 copy, the masks and one temporary.
MEMORY_BYTES_PER_CELL = 8 * 4
# The interpreter and its numerical libraries map about this much address space before any data exists; the
# address-space backstop of the child process allows it on top of the memory limit.
INTERPRETER_HEADROOM_BYTES = 1536 * 1024 * 1024

MIN_GROUP_SIZE = 3
MIN_VALUES_PER_GROUP = 2
TOP_N_DEFAULT = 20
TOP_N_MAX = 100
MISSING_TOKENS = frozenset({"", "null", "NULL", "Null", "NA", "N/A", "na", "NaN", "nan", "NAN"})

SERIES_ACCESSION = re.compile(r"^GSE[1-9][0-9]{0,8}$")
PLATFORM_ACCESSION = re.compile(r"^GPL[1-9][0-9]{0,8}$")
SAMPLE_ACCESSION = re.compile(r"^GSM[1-9][0-9]{0,9}$")

# Platform columns, by the names GEO platform tables use. A closed list: a platform whose table names its symbol
# column otherwise has no symbols here, and the result says so rather than guessing a column from its contents.
SYMBOL_COLUMNS = ("Gene Symbol", "GENE_SYMBOL", "Gene symbol", "Symbol", "SYMBOL", "gene_symbol", "GeneSymbol", "ILMN_Gene")
ENTREZ_COLUMNS = ("ENTREZ_GENE_ID", "Entrez_Gene_ID", "Entrez Gene ID", "Entrez Gene", "EntrezGeneID", "GeneID", "GENE", "ENTREZ_GENE")
TITLE_COLUMNS = ("Gene Title", "GENE_NAME", "Gene Name", "gene_name", "Definition", "DESCRIPTION", "Description")
ACCESSION_COLUMNS = ("GB_ACC", "GB_LIST", "GenBank Accession")
BUILD_COLUMNS = ("Genome Build", "GENOME_BUILD", "genome_build", "Genome_Build")
GENE_SEPARATOR = re.compile(r"\s*///\s*")
ABSENT_ANNOTATION = frozenset({"", "---", "NA", "N/A", "null"})


class GeneExpressionError(Exception):
    """A computation or a parse that is refused, with the closed code the tool answers under.

    `detail` carries the facts a caller can act on (the limit and the value that passed it, the sample that was
    not in the matrix); it holds no path outside the workspace and no upstream text.
    """

    def __init__(self, code, message, *, retryable=False, detail=None):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.detail = detail or {}


def over_limit(limit, observed, allowed, message):
    return GeneExpressionError(
        "gene_expression_input_over_limit", message, detail={"limit": limit, "observed": observed, "allowed": allowed, "unit": LIMIT_UNITS[limit]},
    )


def limits(environ=None):
    """The six limits as integers: the environment's value where it is a positive integer, else the default."""
    environ = os.environ if environ is None else environ
    found = {}
    for name in LIMIT_NAMES:
        raw = str(environ.get(LIMIT_ENV[name], "")).strip()
        try:
            value = int(raw)
        except ValueError:
            value = 0
        found[name] = value if value > 0 else LIMIT_DEFAULTS[name]
    return found


# ---------------------------------------------------------------------------------------------------------------
# Small shared pieces
# ---------------------------------------------------------------------------------------------------------------

def sha256_hex(payload):
    return hashlib.sha256(payload).hexdigest()


def _numpy():
    try:
        import numpy as np  # noqa: PLC0415 - late, so the module imports where numpy is absent
    except ImportError as error:
        raise GeneExpressionError("gene_expression_engine_unavailable", "numpy is not available in this runtime, so no statistic can be computed.") from error
    return np


def _scipy_stats():
    try:
        from scipy import stats  # noqa: PLC0415
    except ImportError as error:
        raise GeneExpressionError("gene_expression_engine_unavailable", "scipy is not available in this runtime, so no p-value can be computed.") from error
    return stats


def _unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        return value[1:-1]
    return value


_DATE_FORMATS = ("%b %d %Y", "%B %d %Y", "%Y-%m-%d")


def stated_date(text):
    """A GEO date line (`Sep 19 2006`, `Public on Sep 19 2006`) as an ISO date, or None. The line itself is kept beside it."""
    value = str(text or "").strip()
    value = re.sub(r"^(?:Public|Private|Released|Submitted)\s+on\s+", "", value, flags=re.IGNORECASE)
    for pattern in _DATE_FORMATS:
        try:
            return datetime.strptime(value, pattern).date().isoformat()
        except ValueError:
            continue
    return None


def _clean_cell(value):
    """A table cell on one line: tabs and line breaks become spaces."""
    return re.sub(r"[\t\r\n]+", " ", str(value)).strip()


def _number(cell):
    text = cell.strip()
    if text in MISSING_TOKENS:
        return math.nan
    try:
        value = float(text)
    except ValueError:
        return math.nan
    return value if math.isfinite(value) else math.nan


def _first_column(columns, names):
    folded = {name.casefold(): name for name in columns}
    for name in names:
        if name in columns:
            return name
    for name in names:
        if name.casefold() in folded:
            return folded[name.casefold()]
    return None


def _decode_lines(payload):
    stream = io.TextIOWrapper(io.BytesIO(payload), encoding="utf-8", errors="replace", newline=None)
    for line in stream:
        yield line.rstrip("\n")


# ---------------------------------------------------------------------------------------------------------------
# Series matrix
# ---------------------------------------------------------------------------------------------------------------

class SeriesMatrix:
    """One parsed `*_series_matrix.txt.gz`: the series' own statements, one row of values per sample, the table."""

    def __init__(self):
        self.series = {}          # key after `!Series_` -> list of values, in file order
        self.sample_rows = []     # (key after `!Sample_`, [one value per sample])
        self.sample_ids = []      # the table header's accessions
        self.probe_ids = []
        self.values = None        # numpy float64 array, probes x samples; NaN where missing
        self.cells_missing = 0
        self.cells_nonfinite = 0
        self.decompressed_bytes = 0

    def first(self, key, default=None):
        values = self.series.get(key)
        return values[0] if values else default

    def sample_values(self, key):
        """The first `!Sample_<key>` row, one value per sample, or None."""
        for name, values in self.sample_rows:
            if name == key:
                return values
        return None

    def sample_value_rows(self, key):
        return [values for name, values in self.sample_rows if name == key]


def _decompressed_lines(gz_bytes, bound):
    """The lines of a gzip payload, refusing one that expands past `bound` bytes of text."""
    total = 0
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(gz_bytes)) as stream:
            for raw in stream:
                total += len(raw)
                if total > bound:
                    raise over_limit(
                        "matrix_bytes", total, bound,
                        "The series matrix expands to more than %d bytes of text (%d times its size limit); it is refused for this computation." % (bound, MAX_EXPANSION),
                    )
                yield raw.decode("utf-8", errors="replace").rstrip("\r\n")
    except (OSError, EOFError, zlib.error) as error:
        raise GeneExpressionError("gene_expression_matrix_unreadable", "The series matrix is not a readable gzip file.") from error


def parse_series_matrix(gz_bytes, *, limit_values=None, want_values=True):
    """Parse a GEO series matrix. Raises `GeneExpressionError` for a file that is unreadable or over a limit.

    The limits are checked while reading, before the memory they protect is spent: the sample count from the
    table header, the probe count and the working-set estimate row by row.
    """
    np = _numpy() if want_values else None
    limit_values = limit_values or limits()
    matrix = SeriesMatrix()
    in_table = False
    saw_header = False
    rows = []
    bound = limit_values["matrix_bytes"] * MAX_EXPANSION
    sample_count = 0
    for line in _decompressed_lines(gz_bytes, bound):
        if not in_table:
            if line.startswith("!series_matrix_table_begin"):
                in_table = True
                continue
            if line.startswith("!Series_"):
                parts = line.split("\t")
                matrix.series.setdefault(parts[0][len("!Series_"):], []).extend(_unquote(part) for part in parts[1:])
            elif line.startswith("!Sample_"):
                parts = line.split("\t")
                matrix.sample_rows.append((parts[0][len("!Sample_"):], [_unquote(part) for part in parts[1:]]))
            continue
        if line.startswith("!series_matrix_table_end"):
            break
        if not line.strip():
            continue
        parts = line.split("\t")
        if not saw_header:
            saw_header = True
            matrix.sample_ids = [_unquote(part) for part in parts[1:]]
            sample_count = len(matrix.sample_ids)
            if sample_count > limit_values["samples"]:
                raise over_limit("samples", sample_count, limit_values["samples"],
                                 "The series matrix holds %d samples; the limit is %d for one computation." % (sample_count, limit_values["samples"]))
            continue
        if len(parts) - 1 != sample_count:
            raise GeneExpressionError(
                "gene_expression_matrix_unreadable",
                "A row of the series matrix has %d values where the table header names %d samples." % (len(parts) - 1, sample_count),
            )
        matrix.probe_ids.append(_unquote(parts[0]))
        if len(matrix.probe_ids) > limit_values["probes"]:
            raise over_limit("probes", len(matrix.probe_ids), limit_values["probes"],
                             "The series matrix holds more than %d probes; the limit is %d for one computation." % (limit_values["probes"], limit_values["probes"]))
        if len(matrix.probe_ids) * sample_count * MEMORY_BYTES_PER_CELL > limit_values["memory"]:
            raise over_limit(
                "memory", len(matrix.probe_ids) * sample_count * MEMORY_BYTES_PER_CELL, limit_values["memory"],
                "The series matrix needs more than %d bytes of working memory for one computation." % limit_values["memory"],
            )
        if want_values:
            cells = parts[1:]
            try:
                row = np.array(cells, dtype=np.float64)
            except ValueError:
                row = np.array([_number(cell) for cell in cells], dtype=np.float64)
            nonfinite = ~np.isfinite(row)
            if nonfinite.any():
                matrix.cells_missing += int(nonfinite.sum())
                row = np.where(nonfinite, np.nan, row)
            rows.append(row)
    if not matrix.sample_ids or not matrix.probe_ids:
        raise GeneExpressionError(
            "gene_expression_matrix_empty",
            "The series matrix holds no data table: GEO has no processed expression values for this series on this platform, and raw reads are not processed here.",
        )
    matrix.values = np.vstack(rows) if want_values else None
    return matrix


def _sample_table(matrix):
    """Per-sample annotations, one dict each, from the matrix's own `!Sample_*` rows.

    `characteristics` splits a `tag: value` line at its first colon, which is GEO's own convention for a
    characteristics row; a row with no colon keeps its text under `characteristics_<n>`.
    """
    count = len(matrix.sample_ids)
    table = [{"accession": accession, "characteristics": {}} for accession in matrix.sample_ids]
    simple = {"title": "title", "source_name_ch1": "sourceName", "organism_ch1": "organism", "platform_id": "platform",
              "molecule_ch1": "molecule", "type": "type", "status": "status", "submission_date": "submissionDate",
              "last_update_date": "lastUpdateDate", "taxid_ch1": "taxId", "data_processing": "dataProcessing"}
    for key, field in simple.items():
        values = matrix.sample_values(key)
        if values is None:
            continue
        for index in range(min(count, len(values))):
            table[index][field] = _clean_cell(values[index])
    for number, values in enumerate(matrix.sample_value_rows("characteristics_ch1")):
        for index in range(min(count, len(values))):
            text = _clean_cell(values[index])
            tag, separator, rest = text.partition(":")
            name, value = (tag.strip(), rest.strip()) if separator and tag.strip() else ("characteristics_%d" % (number + 1), text)
            if not name:
                continue
            existing = table[index]["characteristics"]
            existing[name] = value if name not in existing else "%s; %s" % (existing[name], value)
    return table


# ---------------------------------------------------------------------------------------------------------------
# Platform record
# ---------------------------------------------------------------------------------------------------------------

class Platform:
    def __init__(self):
        self.meta = {}              # key after `!Platform_` -> list of values
        self.columns = []
        self.rows = {}              # probe id -> {symbol, entrez, title, accession, build}
        self.row_count = 0
        self.duplicate_ids = 0
        self.symbol_column = None
        self.entrez_column = None
        self.title_column = None
        self.accession_column = None
        self.build_column = None

    def first(self, key, default=None):
        values = self.meta.get(key)
        return values[0] if values else default


def parse_platform(payload, *, limit_values=None):
    """Parse a GEO platform record (SOFT text, `view=data`): its statements and the annotation columns kept."""
    limit_values = limit_values or limits()
    if len(payload) > limit_values["annotation_bytes"]:
        raise over_limit("annotation_bytes", len(payload), limit_values["annotation_bytes"],
                         "The platform record is %d bytes; the limit is %d for one computation." % (len(payload), limit_values["annotation_bytes"]))
    platform = Platform()
    in_table = False
    header = None
    indexes = {}
    for line in _decode_lines(payload):
        if not in_table:
            if line.startswith("!platform_table_begin"):
                in_table = True
                continue
            if line.startswith("!Platform_"):
                key, _, value = line[len("!Platform_"):].partition(" = ")
                platform.meta.setdefault(key.strip(), []).append(value.strip())
            continue
        if line.startswith("!platform_table_end"):
            break
        if header is None:
            header = line.split("\t")
            platform.columns = [name.strip() for name in header]
            platform.symbol_column = _first_column(platform.columns, SYMBOL_COLUMNS)
            platform.entrez_column = _first_column(platform.columns, ENTREZ_COLUMNS)
            platform.title_column = _first_column(platform.columns, TITLE_COLUMNS)
            platform.accession_column = _first_column(platform.columns, ACCESSION_COLUMNS)
            platform.build_column = _first_column(platform.columns, BUILD_COLUMNS)
            indexes = {name: platform.columns.index(name) for name in (platform.symbol_column, platform.entrez_column, platform.title_column,
                                                                       platform.accession_column, platform.build_column) if name}
            continue
        parts = line.split("\t")
        if not parts or not parts[0].strip():
            continue
        platform.row_count += 1
        probe = parts[0].strip()
        if probe in platform.rows:
            platform.duplicate_ids += 1
            continue

        def cell(name):
            index = indexes.get(name) if name else None
            if index is None or index >= len(parts):
                return ""
            value = _clean_cell(parts[index])
            return "" if value in ABSENT_ANNOTATION else value

        platform.rows[probe] = {
            "symbol": cell(platform.symbol_column), "entrez": cell(platform.entrez_column), "title": cell(platform.title_column),
            "accession": cell(platform.accession_column), "build": cell(platform.build_column),
        }
    if header is None:
        raise GeneExpressionError("gene_expression_platform_unreadable", "The platform record holds no annotation table, so probes cannot be tied to genes.")
    return platform


def genes_of(cell):
    """The distinct symbols of an annotation cell, in order. GEO joins several with ` /// `."""
    seen = []
    for part in GENE_SEPARATOR.split(cell or ""):
        symbol = part.strip()
        if symbol and symbol not in ABSENT_ANNOTATION and symbol not in seen:
            seen.append(symbol)
    return seen


# ---------------------------------------------------------------------------------------------------------------
# Identities, checked before any calculation
# ---------------------------------------------------------------------------------------------------------------

def _check(status, detail, **facts):
    return {"status": status, "detail": detail, **facts}


def distribution_summary(values):
    """Quantiles of the finite values and GEO2R's own rule for whether they look linear (the rule GEO2R applies before it takes log2)."""
    np = _numpy()
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return {"count": 0, "quantiles": None, "looksLinear": None, "rule": "geo2r-logc"}
    qx = np.quantile(finite, [0.0, 0.25, 0.5, 0.75, 0.99, 1.0])
    looks_linear = bool((qx[4] > 100) or (qx[5] - qx[0] > 50 and qx[1] > 0))
    return {
        "count": int(finite.size),
        "quantiles": {"min": float(qx[0]), "q25": float(qx[1]), "median": float(qx[2]), "q75": float(qx[3]), "q99": float(qx[4]), "max": float(qx[5])},
        "negativeValues": int((finite < 0).sum()),
        "looksLinear": looks_linear,
        "rule": "geo2r-logc",
        "ruleText": "Values are taken as linear (not yet log-scale) when their 99th percentile is above 100, or their range is above 50 with a positive 25th percentile: the rule GEO2R applies before it takes log2.",
    }


def identity_checks(matrix, platform, *, requested_platform=None):
    """What the series says about its samples, its platform and its scale, each as ok, mismatch or unknown.

    A `mismatch` is a refusal for the computation that depends on it (`computation_ready` is False); `unknown` is a
    value, never a pass: a platform with no genome build column has an unknown build.
    """
    checks = {}
    declared = matrix.sample_values("geo_accession") or []
    ids = matrix.sample_ids
    duplicates = len(ids) - len(set(ids))
    if duplicates:
        checks["samples"] = _check("mismatch", "%d sample accession(s) appear more than once in the table header." % duplicates)
    elif declared and declared != ids:
        checks["samples"] = _check("mismatch", "The table header's samples are not the series' declared samples, in the same order.")
    elif not declared:
        checks["samples"] = _check("unknown", "The file declares no sample accessions beside its table.", count=len(ids))
    else:
        checks["samples"] = _check("ok", "The table header's %d samples are the series' declared samples." % len(ids), count=len(ids))
    platforms = sorted(set(matrix.sample_values("platform_id") or []))
    series_platforms = matrix.series.get("platform_id", [])
    wanted = requested_platform or (platforms[0] if len(platforms) == 1 else None)
    if len(platforms) > 1:
        checks["platform"] = _check("mismatch", "The matrix's samples are on %d platforms (%s); one computation uses one platform." % (len(platforms), ", ".join(platforms)), platforms=platforms)
    elif not platforms:
        checks["platform"] = _check("unknown", "The file names no platform for its samples.")
    elif requested_platform and platforms[0] != requested_platform:
        checks["platform"] = _check("mismatch", "The matrix's samples are on %s, not the %s that was asked for." % (platforms[0], requested_platform), platforms=platforms)
    elif series_platforms and platforms[0] not in series_platforms:
        checks["platform"] = _check("mismatch", "The samples' platform %s is not among the series' platforms (%s)." % (platforms[0], ", ".join(series_platforms)), platforms=platforms)
    else:
        checks["platform"] = _check("ok", "All samples are on one platform, %s." % platforms[0], platform=platforms[0])
    if platform is not None:
        record_accession = platform.first("geo_accession")
        if wanted and record_accession and record_accession != wanted:
            checks["platformRecord"] = _check("mismatch", "The platform record is %s, not %s." % (record_accession, wanted))
        else:
            present = sum(1 for probe in matrix.probe_ids if probe in platform.rows)
            if present == 0:
                checks["platformRecord"] = _check("mismatch", "None of the matrix's %d probes is in the platform record's table, so it is not the platform these arrays used." % len(matrix.probe_ids), probesFound=0)
            else:
                checks["platformRecord"] = _check("ok", "%d of %d matrix probes are in the platform record's table." % (present, len(matrix.probe_ids)), probesFound=present, probes=len(matrix.probe_ids))
    else:
        checks["platformRecord"] = _check("unknown", "No platform record was read, so probes carry no gene annotation.")
    series_tax = {value for value in (matrix.series.get("sample_taxid") or []) if value}
    sample_tax = {part.strip() for entry in (matrix.sample_values("taxid_ch1") or []) for part in re.split(r"[;,]", entry) if part.strip()}
    sample_tax = sample_tax or series_tax
    platform_tax = {part.strip() for entry in (platform.meta.get("taxid", []) if platform else []) for part in re.split(r"[;,]", entry) if part.strip()}
    if sample_tax and platform_tax:
        checks["organism"] = _check("ok" if sample_tax & platform_tax else "mismatch",
                                    "The samples' taxon (%s) %s the platform's (%s)." % (", ".join(sorted(sample_tax)), "matches" if sample_tax & platform_tax else "differs from", ", ".join(sorted(platform_tax))),
                                    sampleTaxIds=sorted(sample_tax), platformTaxIds=sorted(platform_tax))
    else:
        checks["organism"] = _check("unknown", "The samples' or the platform's taxon is not stated.", sampleTaxIds=sorted(sample_tax), platformTaxIds=sorted(platform_tax))
    builds = sorted({row["build"] for row in platform.rows.values() if row["build"]}) if platform else []
    if builds:
        checks["genomeBuild"] = _check("ok", "The platform table states its genome build (%s)." % ", ".join(builds[:3]), values=builds[:5], source="platform column %s" % platform.build_column)
    else:
        checks["genomeBuild"] = _check("unknown", "Neither the series matrix nor the platform record states a genome build; none is assumed.", values=[])
    statements = []
    for value in matrix.sample_values("data_processing") or []:
        text = _clean_cell(value)
        if text and text not in statements:
            statements.append(text[:600])
    summary = distribution_summary(matrix.values) if matrix.values is not None else {"count": 0, "quantiles": None, "looksLinear": None, "rule": "geo2r-logc"}
    checks["scale"] = _check(
        "unknown" if summary["looksLinear"] is None else "ok",
        ("The values look linear (not log-scale); a transformation is applied before any statistic." if summary["looksLinear"]
         else "The values look log-scale; they are used as they are.") if summary["looksLinear"] is not None else "No finite values to judge.",
        looksLinear=summary["looksLinear"], quantiles=summary["quantiles"], statedProcessing=statements[:5],
    )
    ready = all(entry["status"] != "mismatch" for entry in checks.values())
    return {"checks": checks, "computationReady": ready, "wantedPlatform": wanted}


# ---------------------------------------------------------------------------------------------------------------
# The computation
# ---------------------------------------------------------------------------------------------------------------

def benjamini_hochberg(p_values):
    """Benjamini-Hochberg adjusted p-values: the step-up of p * m / rank, made monotone from the largest rank down."""
    np = _numpy()
    p = np.asarray(p_values, dtype=np.float64)
    count = p.size
    if count == 0:
        return p.copy()
    order = np.argsort(p, kind="stable")
    ranked = p[order] * count / np.arange(1, count + 1)
    ranked = np.minimum.accumulate(ranked[::-1])[::-1]
    adjusted = np.empty(count, dtype=np.float64)
    adjusted[order] = np.minimum(ranked, 1.0)
    return adjusted


def welch(values, left, right):
    """Welch's t-test for every row of `values` between the columns `right` and `left` (difference = right - left).

    Returns a dict of arrays over all rows, with NaN where a row cannot be tested (fewer than two values in a
    group, or no variance in either), plus the reasons as counts.
    """
    np = _numpy()
    stats = _scipy_stats()
    a = values[:, left]
    b = values[:, right]
    n_a = np.sum(~np.isnan(a), axis=1)
    n_b = np.sum(~np.isnan(b), axis=1)
    rows = values.shape[0]
    enough = (n_a >= MIN_VALUES_PER_GROUP) & (n_b >= MIN_VALUES_PER_GROUP)
    out = {name: np.full(rows, np.nan) for name in ("mean_a", "mean_b", "diff", "t", "df", "p", "ci_low", "ci_high")}
    out["n_a"], out["n_b"] = n_a, n_b
    index = np.flatnonzero(enough)
    var_a = np.full(rows, np.nan)
    var_b = np.full(rows, np.nan)
    if index.size:
        sub_a, sub_b = a[index], b[index]
        out["mean_a"][index] = np.nanmean(sub_a, axis=1)
        out["mean_b"][index] = np.nanmean(sub_b, axis=1)
        var_a[index] = np.nanvar(sub_a, axis=1, ddof=1)
        var_b[index] = np.nanvar(sub_b, axis=1, ddof=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        se_a = var_a / n_a
        se_b = var_b / n_b
        se2 = se_a + se_b
    testable = enough & np.isfinite(se2) & (se2 > 0)
    zero_variance = int((enough & np.isfinite(se2) & ~(se2 > 0)).sum())
    index = np.flatnonzero(testable)
    if index.size:
        diff = out["mean_b"][index] - out["mean_a"][index]
        se = np.sqrt(se2[index])
        t = diff / se
        df = se2[index] ** 2 / (se_a[index] ** 2 / (n_a[index] - 1) + se_b[index] ** 2 / (n_b[index] - 1))
        out["diff"][index] = diff
        out["t"][index] = t
        out["df"][index] = df
        out["p"][index] = 2.0 * stats.t.sf(np.abs(t), df)
        margin = stats.t.ppf(0.975, df) * se
        out["ci_low"][index] = diff - margin
        out["ci_high"][index] = diff + margin
    out["tested"] = testable
    out["too_few"] = int((~enough).sum())
    out["zero_variance"] = zero_variance
    return out


def _group_columns(matrix, groups, reference):
    """Resolve the declared groups to column indexes, refusing a declaration that cannot be analysed.

    Each group is `{label, samples: [GSM...]}` or `{label, where: {field, equals}}`, where `field` is a column of
    the sample table (`title`, `sourceName`, a characteristics tag ...) and `equals` an exact, case-sensitive
    value. Exactly two groups; each at least three samples; no sample in both; every sample in the matrix.
    """
    if not isinstance(groups, list) or len(groups) != 2:
        raise GeneExpressionError("gene_expression_groups_invalid", "Declare exactly two groups: a reference and a comparison.")
    table = _sample_table(matrix)
    index_of = {accession: position for position, accession in enumerate(matrix.sample_ids)}
    resolved = []
    labels = []
    for group in groups:
        if not isinstance(group, dict) or set(group) - {"label", "samples", "where"}:
            raise GeneExpressionError("gene_expression_groups_invalid", "A group is {label, samples} or {label, where: {field, equals}}.")
        label = group.get("label")
        if not isinstance(label, str) or not label.strip() or len(label) > 80 or label != label.strip():
            raise GeneExpressionError("gene_expression_groups_invalid", "Each group needs a short label.")
        if label in labels:
            raise GeneExpressionError("gene_expression_groups_invalid", "The two groups need different labels.")
        labels.append(label)
        if ("samples" in group) == ("where" in group):
            raise GeneExpressionError("gene_expression_groups_invalid", "Group %r names its samples either by accession (samples) or by an annotation value (where), not both." % label)
        if "samples" in group:
            wanted = group["samples"]
            if not isinstance(wanted, list) or not all(isinstance(item, str) and SAMPLE_ACCESSION.match(item) for item in wanted):
                raise GeneExpressionError("gene_expression_groups_invalid", "Group %r: samples are GEO sample accessions such as GSM130365." % label)
        else:
            clause = group["where"]
            if not isinstance(clause, dict) or set(clause) != {"field", "equals"} or not all(isinstance(clause[key], str) and clause[key] for key in clause):
                raise GeneExpressionError("gene_expression_groups_invalid", "Group %r: where is {field, equals}, both text." % label)
            field, equals = clause["field"], clause["equals"]
            wanted = []
            for entry in table:
                found = entry.get("characteristics", {}).get(field) if field not in entry else entry.get(field)
                if found == equals:
                    wanted.append(entry["accession"])
        if len(set(wanted)) != len(wanted):
            raise GeneExpressionError("gene_expression_groups_invalid", "Group %r lists a sample more than once." % label)
        missing = [item for item in wanted if item not in index_of]
        if missing:
            raise GeneExpressionError(
                "gene_expression_groups_invalid", "Group %r names sample(s) that are not in this series matrix: %s." % (label, ", ".join(missing[:5])),
                detail={"label": label, "notInMatrix": missing[:20]},
            )
        resolved.append({"label": label, "samples": list(wanted)})
    for group in resolved:
        if len(group["samples"]) < MIN_GROUP_SIZE:
            raise GeneExpressionError(
                "gene_expression_groups_invalid",
                "Group %r has %d sample(s); a group needs at least %d for a variance to be estimated and tested." % (group["label"], len(group["samples"]), MIN_GROUP_SIZE),
                detail={"label": group["label"], "samples": len(group["samples"]), "minimum": MIN_GROUP_SIZE},
            )
    overlap = sorted(set(resolved[0]["samples"]) & set(resolved[1]["samples"]))
    if overlap:
        raise GeneExpressionError("gene_expression_groups_invalid", "The groups share sample(s) %s; a sample belongs to one group." % ", ".join(overlap[:5]), detail={"overlap": overlap[:20]})
    names = [group["label"] for group in resolved]
    if reference is None:
        reference = names[0]
    if reference not in names:
        raise GeneExpressionError("gene_expression_groups_invalid", "reference must be one of the group labels (%s)." % ", ".join(names))
    ordered = sorted(resolved, key=lambda group: group["label"] != reference)
    return ordered[0], ordered[1], index_of


def _format(value, spec):
    return "" if value is None or (isinstance(value, float) and not math.isfinite(value)) else spec % value


def _json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False, allow_nan=False) + "\n").encode("utf-8")


def _gzip_bytes(payload):
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0, compresslevel=6) as stream:
        stream.write(payload)
    return buffer.getvalue()


def _file_entry(path, payload):
    return {"path": path, "sha256": sha256_hex(payload), "bytes": len(payload)}


def _safe_directory(value, root, what):
    """A workspace-relative directory strictly under `root`, or a refusal. No absolute path, no `..`, no backslash, no control character."""
    text = value if isinstance(value, str) else ""
    parts = text.split("/")
    if (not text or len(text) > 400 or "\\" in text or any(ord(char) < 32 for char in text) or any(part in ("", ".", "..") for part in parts)
            or not text.startswith(root + "/")):
        raise GeneExpressionError("gene_expression_input_invalid", "%s must be a workspace-relative directory under %s/." % (what, root))
    return text


def _verify_capture_directory(directory):
    """What no longer matches in a preserved capture (the same ledger `immutable_capture.preserve` writes). Empty means intact.

    Re-implemented here, in a few lines, so this file stays self-contained: the capture's directory name is the
    sha-256 of its artifacts' digests, and `capture.json` lists them, so an edited artifact and a manifest rewritten
    to describe the edit are both visible.
    """
    manifest_path = directory / "capture.json"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        return ["the capture has no capture.json"]
    try:
        recorded = json.loads(manifest_path.read_bytes().decode("utf-8")).get("artifacts")
    except (ValueError, UnicodeDecodeError, AttributeError):
        return ["capture.json is not readable JSON"]
    if not isinstance(recorded, dict) or not recorded:
        return ["capture.json records no artifact digests"]
    findings = []
    for name, digest in sorted(recorded.items()):
        artifact = directory / name
        if not artifact.is_file() or artifact.is_symlink():
            findings.append("%s is recorded in the capture and is not on disk" % name)
        elif sha256_hex(artifact.read_bytes()) != digest:
            findings.append("%s was edited after capture" % name)
    expected = hashlib.sha256(json.dumps({key: str(value) for key, value in recorded.items()}, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    if directory.name != expected:
        findings.append("the capture directory does not match the digests its manifest records")
    return findings


def _open_directory(workspace, relative, create):
    """A descriptor for a directory under the workspace, walked one component at a time without following a link."""
    descriptor = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in Path(relative).parts:
            if create:
                try:
                    os.mkdir(component, 0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _existing_bytes(directory, name):
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor, "rb") as source:
        return source.read()


def _publish_files(workspace, relative_directory, files, last):
    """Write `files` ({name: bytes}) into a workspace directory, `last` names (in order) after the rest.

    A file that exists with the same bytes is left as it is; one that exists with other bytes is never replaced
    (`FileExistsError`): the earlier analysis keeps its results. Each file is written whole to a sibling and linked
    into place, so a reader never sees half of one.
    """
    import secrets  # noqa: PLC0415

    directory = _open_directory(workspace, relative_directory, create=True)
    try:
        for name in [*(name for name in files if name not in last), *last]:
            payload = files[name]
            held = _existing_bytes(directory, name)
            if held is not None:
                if held != payload:
                    raise FileExistsError(name)
                continue
            temporary = ".%s.%s.tmp" % (name, secrets.token_hex(8))
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            try:
                with os.fdopen(descriptor, "wb") as target:
                    target.write(payload)
                    target.flush()
                    os.fsync(target.fileno())
                try:
                    os.link(temporary, name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
                except FileExistsError:
                    if _existing_bytes(directory, name) != payload:
                        raise
            finally:
                os.unlink(temporary, dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(directory)


def differential(request, *, workspace, environ=None, clock=time.time):
    """Run one analysis from a preserved capture and write its files. Returns the result dict (also written as JSON).

    `request` = {captureDir, outputDir, groups, reference?, transform?, topN?}; `workspace` is the managed project
    workspace. Everything it reads is verified first (the capture's own digest ledger), and nothing it writes
    replaces a file with different bytes.
    """
    started = clock()
    np = _numpy()
    limit_values = limits(environ)
    capture_dir = _safe_directory(request.get("captureDir"), SOURCES_ROOT, "captureDir")
    output_dir = _safe_directory(request.get("outputDir"), DELIVERABLES_ROOT, "outputDir")
    transform = request.get("transform", "auto")
    if transform not in ("auto", "none", "log2"):
        raise GeneExpressionError("gene_expression_input_invalid", "transform is auto, none or log2.")
    top_n = request.get("topN", TOP_N_DEFAULT)
    if not isinstance(top_n, int) or isinstance(top_n, bool) or not 1 <= top_n <= TOP_N_MAX:
        raise GeneExpressionError("gene_expression_input_invalid", "topN is a whole number from 1 to %d." % TOP_N_MAX)

    capture_root = workspace / capture_dir
    findings = _verify_capture_directory(capture_root)
    if findings:
        raise GeneExpressionError(
            "gene_expression_capture_invalid",
            "The preserved series capture does not match its own digest ledger, so no statistic is taken from it: %s." % findings[0],
            detail={"findings": findings[:5]},
        )
    try:
        record = json.loads((capture_root / "record.json").read_bytes().decode("utf-8"))
        matrix_bytes = (capture_root / "series_matrix.txt.gz").read_bytes()
        annotation_text = (capture_root / "probe-annotation.tsv").read_bytes().decode("utf-8")
    except (OSError, ValueError) as error:
        raise GeneExpressionError("gene_expression_capture_invalid", "The preserved series capture is missing a file a calculation needs (record.json, series_matrix.txt.gz or probe-annotation.tsv).") from error
    if not isinstance(record, dict) or record.get("schemaVersion") != SCHEMA_VERSION or record.get("kind") != "gene-expression-series-capture":
        raise GeneExpressionError("gene_expression_capture_invalid", "record.json is not a gene-expression series capture of this schema.")
    if len(matrix_bytes) > limit_values["matrix_bytes"]:
        raise over_limit("matrix_bytes", len(matrix_bytes), limit_values["matrix_bytes"],
                         "The series matrix is %d bytes; the limit is %d for one computation." % (len(matrix_bytes), limit_values["matrix_bytes"]))

    matrix = parse_series_matrix(matrix_bytes, limit_values=limit_values)
    identity = record.get("identity") or {}
    if not identity.get("computationReady", False):
        problems = [entry["detail"] for entry in (identity.get("checks") or {}).values() if entry.get("status") == "mismatch"]
        raise GeneExpressionError("gene_expression_identity_mismatch", "The series' identities do not agree, so no statistic is taken: %s" % (problems[0] if problems else "see record.json identity."), detail={"problems": problems[:5]})

    reference_group, comparison_group, index_of = _group_columns(matrix, request.get("groups"), request.get("reference"))
    ref_columns = [index_of[item] for item in reference_group["samples"]]
    cmp_columns = [index_of[item] for item in comparison_group["samples"]]
    selected = ref_columns + cmp_columns
    values = matrix.values[:, selected].copy()
    left = list(range(len(ref_columns)))
    right = list(range(len(ref_columns), len(selected)))

    # Unit identity: judged on every value the matrix holds (the series' own processing), applied to the arrays analysed.
    whole = distribution_summary(matrix.values)
    looks_linear = whole["looksLinear"]
    if transform == "auto":
        applied = "log2" if looks_linear else "none"
        reason = "auto: the values look %s by GEO2R's rule." % ("linear" if looks_linear else "log-scale")
    else:
        applied = transform
        reason = "requested: transform=%s." % transform
    transformation_warnings = []
    if applied == "none" and looks_linear:
        transformation_warnings.append("The values look linear but no log2 was applied; fold changes are differences of linear intensities, and a Welch test on them is dominated by the brightest probes.")
    if applied == "log2" and looks_linear is False:
        transformation_warnings.append("The values already look log-scale and log2 was applied to them again; fold changes and p-values describe log-of-log values.")
    set_missing = 0
    if applied == "log2":
        nonpositive = np.isfinite(values) & (values <= 0)
        set_missing = int(nonpositive.sum())
        values = np.where(nonpositive, np.nan, values)
        with np.errstate(invalid="ignore", divide="ignore"):
            values = np.log2(values)

    result = welch(values, left, right)
    tested = result["tested"]
    probes = matrix.probe_ids
    adjusted = np.full(len(probes), np.nan)
    tested_index = np.flatnonzero(tested)
    adjusted[tested_index] = benjamini_hochberg(result["p"][tested_index])

    annotation = {}
    header = None
    for line in annotation_text.splitlines():
        parts = line.split("\t")
        if header is None:
            header = parts
            continue
        if len(parts) == len(header):
            annotation[parts[0]] = dict(zip(header, parts))
    symbols_of = {probe: genes_of(annotation.get(probe, {}).get("gene_symbol", "")) for probe in probes}
    multi_gene = {probe for probe, genes in symbols_of.items() if len(genes) > 1}
    unannotated = [probe for probe in probes if not symbols_of[probe]]

    order = sorted(
        tested_index.tolist(),
        key=lambda i: (result["p"][i], -abs(result["t"][i]), probes[i]),
    )
    rank_of = {position: rank + 1 for rank, position in enumerate(order)}
    significant_05 = int((adjusted[tested_index] < 0.05).sum())
    significant_01 = int((adjusted[tested_index] < 0.01).sum())
    genes_with_several = {}
    for position in tested_index.tolist():
        for gene in symbols_of[probes[position]]:
            genes_with_several[gene] = genes_with_several.get(gene, 0) + 1
    several_probe_genes = sum(1 for count in genes_with_several.values() if count > 1)
    medians = [float(value) for value in np.nanmedian(values, axis=0) if math.isfinite(float(value))] if values.size else []

    def row(position):
        probe = probes[position]
        info = annotation.get(probe, {})
        return {
            "rank": rank_of[position], "probe": probe, "geneSymbols": symbols_of[probe], "entrezIds": [part for part in GENE_SEPARATOR.split(info.get("entrez_id", "")) if part],
            "geneTitle": info.get("gene_title", ""), "multiGene": probe in multi_gene,
            "nReference": int(result["n_a"][position]), "nComparison": int(result["n_b"][position]),
            "meanReference": float(result["mean_a"][position]), "meanComparison": float(result["mean_b"][position]),
            "logFC": float(result["diff"][position]), "ciLow": float(result["ci_low"][position]), "ciHigh": float(result["ci_high"][position]),
            "t": float(result["t"][position]), "df": float(result["df"][position]),
            "pValue": float(result["p"][position]), "adjPValue": float(adjusted[position]),
        }

    top = [row(position) for position in order[:top_n]]
    delivered = {name: "%s/%s" % (output_dir, filename) for name, filename in RESULT_FILES.items()}

    # --- the files ---
    table_lines = ["\t".join(("rank", "probe_id", "gene_symbol", "entrez_id", "gene_title", "multi_gene", "n_reference", "n_comparison", "mean_reference",
                              "mean_comparison", "log2_fold_change", "ci95_low", "ci95_high", "t", "df", "p_value", "adj_p_value"))]
    for position in order:
        info = annotation.get(probes[position], {})
        table_lines.append("\t".join((
            str(rank_of[position]), probes[position], "///".join(symbols_of[probes[position]]), info.get("entrez_id", ""), info.get("gene_title", ""),
            "yes" if probes[position] in multi_gene else "no", str(int(result["n_a"][position])), str(int(result["n_b"][position])),
            repr(float(result["mean_a"][position])), repr(float(result["mean_b"][position])), repr(float(result["diff"][position])),
            repr(float(result["ci_low"][position])), repr(float(result["ci_high"][position])), repr(float(result["t"][position])),
            repr(float(result["df"][position])), repr(float(result["p"][position])), repr(float(adjusted[position])),
        )))
    table_payload = ("\n".join(table_lines) + "\n").encode("utf-8")

    matrix_lines = ["\t".join(["probe_id", "gene_symbol"] + ["%s|%s" % (matrix.sample_ids[column], reference_group["label"]) for column in ref_columns]
                              + ["%s|%s" % (matrix.sample_ids[column], comparison_group["label"]) for column in cmp_columns])]
    for position, probe in enumerate(probes):
        matrix_lines.append("\t".join([probe, "///".join(symbols_of[probe])] + [("" if np.isnan(value) else repr(float(value))) for value in values[position]]))
    matrix_payload = _gzip_bytes(("\n".join(matrix_lines) + "\n").encode("utf-8"))

    top_lines = [
        "| Rank | Probe | Gene | log2 fold change (%s minus %s) | p value | BH adjusted p |" % (comparison_group["label"], reference_group["label"]),
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for entry in top:
        gene = "/".join(entry["geneSymbols"]) or "(no symbol)"
        top_lines.append("| %d | %s | %s%s | %s | %s | %s |" % (
            entry["rank"], entry["probe"], gene, " (probe maps to several genes)" if entry["multiGene"] else "",
            _format(entry["logFC"], "%.3f"), _format(entry["pValue"], "%.2e"), _format(entry["adjPValue"], "%.2e"),
        ))
    top_payload = ("\n".join(top_lines) + "\n\nWelch t-test per probe on log2 values with Benjamini-Hochberg adjustment over %d tested probes; not limma (no empirical-Bayes moderation of the variances).\n" % int(tested.sum())).encode("utf-8")

    code_payload = Path(__file__).resolve().read_bytes()
    request_payload = _json_bytes({
        "schemaVersion": SCHEMA_VERSION, "capture": {"directory": capture_dir, "matrixSha256": record.get("matrix", {}).get("sha256")},
        "groups": [{"label": group["label"], "samples": group["samples"]} for group in (reference_group, comparison_group)],
        "reference": reference_group["label"], "transform": transform, "topN": top_n, "outputDirectory": output_dir,
    })

    probes_tested = int(tested.sum())
    results = {
        "schemaVersion": SCHEMA_VERSION,
        "kind": RESULTS_KIND,
        "engineVersion": ENGINE_VERSION,
        "method": {
            "id": METHOD_ID,
            "name": "Welch two-sample t-test per probe on log2 expression values with Benjamini-Hochberg adjustment",
            "isLimma": False,
            "statement": NOT_LIMMA,
            "contrast": "%s minus %s" % (comparison_group["label"], reference_group["label"]),
            "randomness": "none",
            "seed": None,
            "interval": "95% confidence interval of the difference in log2 means, Welch-Satterthwaite degrees of freedom",
            "multipleTesting": "Benjamini-Hochberg over the %d probes that could be tested" % probes_tested,
        },
        "series": {
            "accession": record.get("series", {}).get("accession"), "title": record.get("series", {}).get("title"),
            "status": record.get("series", {}).get("status"), "submissionDate": record.get("series", {}).get("submissionDate"),
            "lastUpdateDate": record.get("series", {}).get("lastUpdateDate"),
            "platform": record.get("platform", {}).get("accession"), "platformTitle": record.get("platform", {}).get("title"),
            "organism": record.get("platform", {}).get("organism"),
            "captureDirectory": capture_dir, "matrixSha256": record.get("matrix", {}).get("sha256"), "matrixBytes": record.get("matrix", {}).get("bytes"),
            "platformSha256": record.get("platform", {}).get("sha256"),
        },
        "design": {
            "reference": reference_group["label"], "comparison": comparison_group["label"],
            "groups": [{"label": group["label"], "n": len(group["samples"]), "samples": group["samples"]} for group in (reference_group, comparison_group)],
        },
        "transformation": {
            "requested": transform, "applied": applied, "reason": reason, "valuesSetMissing": set_missing,
            "distribution": {key: whole[key] for key in ("count", "quantiles", "looksLinear", "rule", "ruleText") if key in whole},
            "statedProcessing": identity.get("checks", {}).get("scale", {}).get("statedProcessing", []),
            "warnings": transformation_warnings,
        },
        "identity": {name: {"status": entry["status"], "detail": entry["detail"]} for name, entry in (identity.get("checks") or {}).items()},
        "diagnostics": {
            "groupSizes": {"reference": len(ref_columns), "comparison": len(cmp_columns)},
            "probesInMatrix": len(probes), "probesTested": probes_tested,
            "probesDropped": {"tooFewValues": result["too_few"], "zeroVariance": result["zero_variance"]},
            "probesDroppedTotal": len(probes) - probes_tested,
            "missingValueCells": int(np.isnan(values).sum()),
            "multiGeneProbes": len(multi_gene),
            "multiGeneHandling": "A probe annotated with several genes stays one row, listed with all its symbols and flagged; it is not copied to each gene, and nothing is collapsed to a gene level, so a gene with several probes has several rows.",
            "unannotatedProbes": len(unannotated),
            "genesWithSeveralProbes": several_probe_genes,
            "probesSignificantAtFdr05": significant_05, "probesSignificantAtFdr01": significant_01,
            "probesPBelow05": int((result["p"][tested_index] < 0.05).sum()),
            "sampleMedians": {"min": min(medians), "max": max(medians), "range": max(medians) - min(medians)} if medians else None,
            "limits": {name: limit_values[name] for name in LIMIT_NAMES},
        },
        "top": top,
        "files": {name: path for name, path in delivered.items() if name not in ("results",)},
    }
    results_payload = _json_bytes(results)

    artifacts = {
        RESULT_FILES["table"]: table_payload, RESULT_FILES["topTable"]: top_payload, RESULT_FILES["analysedMatrix"]: matrix_payload,
        RESULT_FILES["request"]: request_payload, RESULT_FILES["code"]: code_payload,
    }
    input_files = [
        _file_entry("%s/series_matrix.txt.gz" % capture_dir, matrix_bytes),
        _file_entry("%s/probe-annotation.tsv" % capture_dir, annotation_text.encode("utf-8")),
        _file_entry("%s/%s" % (output_dir, RESULT_FILES["request"]), request_payload),
    ]
    ended = clock()
    receipt_execution = {
        "id": hashlib.sha256(results_payload + code_payload).hexdigest()[:32],
        "parent": None,
        "argv": [sys.executable or "python3", RESULT_FILES["code"], "differential"],
        "script": _file_entry("%s/%s" % (output_dir, RESULT_FILES["code"]), code_payload),
        "inputs": input_files,
        "transforms": [],
        "startedAt": datetime.fromtimestamp(started, timezone.utc).isoformat(),
        "versions": _versions(),
        "exitCode": 0,
        "endedAt": datetime.fromtimestamp(ended, timezone.utc).isoformat(),
        "output": {"before": None, "after": _file_entry("%s/%s" % (output_dir, RESULT_FILES["results"]), results_payload), "observation": "created", "observedWrite": True},
        "sourcesUnchanged": True,
        "warnings": [],
        "engine": {"id": "gene_expression", "version": ENGINE_VERSION, "method": METHOD_ID, "isLimma": False},
    }
    receipt_payload = _json_bytes({"schemaVersion": 1, "executions": [receipt_execution]})
    # The same analysis asked again is the analysis already there: its results are byte-identical (nothing in them
    # is a time or a random draw), so its receipt and files are left as they are and returned.
    directory = None
    try:
        directory = _open_directory(workspace, output_dir, create=False)
    except OSError:
        directory = None
    if directory is not None:
        try:
            held_results = _existing_bytes(directory, RESULT_FILES["results"])
            held_receipt = _existing_bytes(directory, RESULT_FILES["receipt"])
        finally:
            os.close(directory)
        if held_results == results_payload and held_receipt is not None:
            receipt_payload = held_receipt
    try:
        _publish_files(workspace, output_dir, {**artifacts, RESULT_FILES["results"]: results_payload, RESULT_FILES["receipt"]: receipt_payload},
                       last=(RESULT_FILES["results"], RESULT_FILES["receipt"]))
    except FileExistsError as error:
        raise GeneExpressionError(
            "gene_expression_output_exists",
            "%s already holds different results; choose a new outputDir for a different analysis (the earlier results are kept)." % output_dir,
        ) from error
    return {
        "results": results,
        "files": {name: _file_entry(delivered[name], payload) for name, payload in (
            ("results", results_payload), ("table", table_payload), ("topTable", top_payload), ("analysedMatrix", matrix_payload),
            ("request", request_payload), ("code", code_payload), ("receipt", receipt_payload))},
        "elapsedSeconds": round(ended - started, 3),
    }


def _versions():
    from importlib import metadata  # noqa: PLC0415

    libraries = {}
    for name in ("numpy", "scipy"):
        try:
            libraries[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            continue
    return {"interpreter": sys.version, "libraries": libraries}


# ---------------------------------------------------------------------------------------------------------------
# The child process: one request on stdin, one JSON answer on stdout, never more than the limits allow
# ---------------------------------------------------------------------------------------------------------------

def _apply_address_space_limit(memory_limit):
    try:
        import resource  # noqa: PLC0415 - POSIX only; the limit is a backstop, the estimate above is the check
    except ImportError:
        return
    ceiling = int(memory_limit) + INTERPRETER_HEADROOM_BYTES
    try:
        _soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        resource.setrlimit(resource.RLIMIT_AS, (ceiling if hard in (-1, resource.RLIM_INFINITY) else min(ceiling, hard), hard))
    except (ValueError, OSError):
        return


def _child_main(stream_in, stream_out):
    try:
        request = json.loads(stream_in.read())
        workspace = Path(request.pop("workspace"))
        _apply_address_space_limit(limits()["memory"])
        answer = differential(request, workspace=workspace)
        stream_out.write(json.dumps({"ok": True, "answer": {"files": answer["files"], "elapsedSeconds": answer["elapsedSeconds"], "results": answer["results"]}}, allow_nan=False))
        return 0
    except GeneExpressionError as error:
        stream_out.write(json.dumps({"ok": False, "code": error.code, "message": str(error), "detail": error.detail, "retryable": error.retryable}))
        return 0
    except MemoryError:
        stream_out.write(json.dumps({"ok": False, "code": "gene_expression_input_over_limit", "message": "The computation needed more memory than the limit allows and was stopped.",
                                     "detail": {"limit": "memory", "unit": "bytes", "allowed": limits()["memory"]}, "retryable": False}))
        return 0
    except (ValueError, TypeError, KeyError, OSError) as error:
        stream_out.write(json.dumps({"ok": False, "code": "gene_expression_input_invalid", "message": "The request could not be read (%s)." % type(error).__name__, "detail": {}, "retryable": False}))
        return 0


if __name__ == "__main__":
    # `python3 gene_expression.py differential` reads a request from stdin: {workspace, captureDir, outputDir, groups, ...}.
    if len(sys.argv) == 2 and sys.argv[1] == "differential":
        sys.exit(_child_main(sys.stdin, sys.stdout))
    sys.stderr.write("usage: gene_expression.py differential < request.json\n")
    sys.exit(2)
