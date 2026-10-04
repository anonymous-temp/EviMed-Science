"""The two tools of the NCBI Gene Expression Omnibus workflow: a series, preserved and identity-checked, and a differential-expression result.

`gene_expression_series` is retrieval: an accession (GSE...) to the series matrix exactly as GEO serves it, the
platform's probe annotation and the sample annotations, preserved content-addressed with the sha-256 of the
fetched bytes and the dates the files themselves state, with the identities (samples, platform, organism, genome
build, value scale) checked before any calculation can depend on them. It goes through the control plane's
public-source gateway as two named downloads and nothing else: the runtime names the accession and, when a series
has several platforms, the platform; the gateway builds the address.

`gene_expression_differential` is the computation, and it is the platform's, not the model's: the engine in
`gene_expression.py` runs in a child process under the six limits and writes its results, a rendered table and a
receipt as files. Numbers reach the report through `research_calculate` action=render from those files.

Both are named for the data resource (`gene_expression`, `ncbi_geo`); neither has anything to do with the 循证 GEO
module's `geo_read` / `geo_write`.

An input over a limit is refused for that computation with the reason (`gene_expression_input_over_limit`, with
which limit, the value that passed it and the limit), the conversation continues, and the observation is offered to
the control plane's counter best-effort (`report_limit`): a counter must never fail a researcher's work.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import gene_expression as engine
import public_sources
import source_outcome
import source_transport as transport
from immutable_capture import ImmutableCaptureError, managed_workspace, preserve

SERIES_TOOL = "gene_expression_series"
DIFFERENTIAL_TOOL = "gene_expression_differential"
TOOL_NAMES = frozenset({SERIES_TOOL, DIFFERENTIAL_TOOL})

SCOPE = "NCBI GEO"
DEADLINE_SECONDS = 140.0
RECORD_URL = "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=%s&targ=self&form=text&view=%s"
SERIES_PAGE = "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=%s"
# What NCBI states about the data in its databases (https://www.ncbi.nlm.nih.gov/home/about/policies/, read 2026-10-04; GEO's own
# disclaimer page answered a programmatic read with a reCAPTCHA page and could not be read). The capture records the sentence, not a
# licence the platform is granting.
TERMS = (
    "NCBI states that it places no restrictions on the use or distribution of the data in its databases, and that original submitters may claim "
    "patent, copyright or other rights in their contributions, which NCBI cannot assess. Cite the series accession and its publication, and read the "
    "record's own text before redistributing."
)
MAX_SAMPLES_LISTED = 40
BRIEF_BYTES = 4 * 1024 * 1024


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def series_directory_stub(accession):
    """GEO's directory for a series: its accession with the last three digits replaced by `nnn` (GSE5583 -> GSE5nnn, GSE123 -> GSEnnn)."""
    return "GSE%snnn" % accession[3:-3]


def matrix_file_name(accession, platform):
    return "%s%s_series_matrix.txt.gz" % (accession, "-" + platform if platform else "")


# ---------------------------------------------------------------------------------------------------------------
# The best-effort counter signal
# ---------------------------------------------------------------------------------------------------------------

def report_limit(limit, *, action="refused"):
    """Offer one limit observation to the control plane's counter. Never raises, never delays the answer for long."""
    try:
        gateway = public_sources._gateway_settings()  # noqa: SLF001 - one token, one owner
        if gateway is None or public_sources.fixtures.fixtures_dir():
            return False
        gateway_url, token = gateway
        request = urllib.request.Request(
            gateway_url,
            data=json.dumps({"geneExpressionLimit": {"limit": limit, "action": action}}).encode("utf-8"),
            headers={"accept": "application/json", "authorization": "Bearer %s" % token, "content-type": "application/json", "user-agent": "EviMed-Research/1.2 (runtime connector)"},
            method="POST",
        )
        with public_sources._OPENER.open(request, timeout=5) as response:  # noqa: SLF001
            return 200 <= int(getattr(response, "status", 200)) < 300
    except Exception:  # noqa: BLE001 - a counter is a label; nothing it does may fail a researcher's computation
        return False


# ---------------------------------------------------------------------------------------------------------------
# Failures
# ---------------------------------------------------------------------------------------------------------------

def _failure(code, message, retryable, stop_reason, next_actions, **extra):
    result = {"status": "error", "summary": message, "next_actions": next_actions,
              "error": {"code": code, "message": message, "retryable": retryable, "stopReason": stop_reason}}
    if extra:
        result["data"] = extra
    return result


def _engine_failure(error):
    """A refused computation as a tool result: what was refused, why, and what changes it."""
    detail = dict(error.detail or {})
    if error.code == "gene_expression_input_over_limit":
        limit = detail.get("limit")
        report_limit(limit)
        return _failure(
            error.code, str(error), False,
            "This input is over a limit for one computation; nothing was computed from it.",
            ["Say which limit it passed (data.limit, with the value and the allowed size) and that this computation was not done.",
             "Choose a smaller series, or fewer samples, if the question allows; every other analysis in the conversation is unaffected."],
            **{key: detail[key] for key in ("limit", "observed", "allowed", "unit", "stopped") if key in detail},
        )
    next_actions = {
        "gene_expression_groups_invalid": ["Read samples.tsv of the capture, declare two disjoint groups of at least three samples each (by accession or by an annotation value), and call again."],
        "gene_expression_input_invalid": ["Correct the named field and call again."],
        "gene_expression_identity_mismatch": ["Read the identity checks of record.json: this capture's samples or platform do not agree, so no statistic is taken from it; say so and use another series or platform."],
        "gene_expression_capture_invalid": ["Preserve the series again with gene_expression_series; a capture that no longer matches its digest ledger is not used."],
        "gene_expression_output_exists": ["Use a new outputDir for a different analysis; the earlier results are kept as they are."],
        "gene_expression_matrix_empty": ["Say that this series has no processed expression matrix here and that raw reads are not processed; choose another series."],
        "gene_expression_matrix_unreadable": ["Say that GEO's matrix could not be read; do not compute from it."],
        "gene_expression_platform_unreadable": ["Say that the platform record could not be read; probes cannot be tied to genes for this series."],
        "gene_expression_engine_unavailable": ["Say that the calculation engine is unavailable in this runtime; do not estimate the statistics yourself."],
    }.get(error.code, ["Say what was refused and continue with the rest of the work."])
    return _failure(error.code, str(error), error.retryable, "This computation was refused; nothing was computed from the input.", next_actions, **detail)


def _incomplete_download(download, limit_name, limit_value, what):
    """A download that stopped early as the failure it is: a limit, a spent deadline, or a lost connection."""
    reason = download.reason or "incomplete"
    if reason == "size_limit" or download.received >= limit_value:
        raise engine.over_limit(limit_name, max(download.declared or 0, download.received), limit_value,
                                "%s is larger than the %d-byte limit for one computation." % (what, limit_value))
    state = "timeout" if reason in ("deadline", "read_stalled") else "unavailable"
    raise source_outcome.SourceError(
        state, "%s stopped arriving after %d bytes (%s)." % (what, download.received, reason.replace("_", " ")),
        scope=SCOPE, reason=reason, retryable=True, partial={"bytesReceived": download.received},
    )


def _download(kind, params, deadline, limit_name, limit_value, what):
    try:
        download = transport.download(kind, params, deadline=deadline, scope=SCOPE, max_bytes=limit_value, attempts=2)
    except source_outcome.Truncated as error:
        raise engine.over_limit(limit_name, max(error.declared or 0, error.received, limit_value + 1), limit_value,
                                "%s is larger than the %d-byte limit for one computation." % (what, limit_value)) from error
    if not download.complete:
        _incomplete_download(download, limit_name, limit_value, what)
    return download


# ---------------------------------------------------------------------------------------------------------------
# gene_expression_series
# ---------------------------------------------------------------------------------------------------------------

def _stated(value):
    return {"stated": value, "date": engine.stated_date(value)} if value else None


def _record_listing(text):
    """The `!Series_*` statements of a SOFT brief, as {key: [values]}."""
    found = {}
    for line in text.splitlines():
        if line.startswith("!Series_"):
            key, _, value = line[len("!Series_"):].partition(" = ")
            found.setdefault(key.strip(), []).append(value.strip())
    return found


def _no_matrix(accession, platform, deadline):
    """Why a series matrix was not found: the series is unknown, has several platforms, or has no processed matrix."""
    try:
        brief = transport.download("ncbi-gene-expression-record", {"accession": accession, "view": "brief"}, deadline=deadline, scope=SCOPE, max_bytes=BRIEF_BYTES, attempts=2)
    except source_outcome.Truncated:
        brief = None
    text = brief.body.decode("utf-8", errors="replace") if brief is not None and brief.complete else ""
    listing = _record_listing(text)
    platforms = sorted(set(listing.get("platform_id", [])))
    exists = bool(listing.get("geo_accession"))
    title = (listing.get("title") or [""])[0]
    if not exists:
        return {
            "status": "warning", "summary": "GEO holds no public series %s." % accession,
            "data": {"accession": accession, "outcome": source_outcome.no_results(
                reason="series_not_found", how="Check the accession (GSE followed by digits). A private or withdrawn series is not served; this is not evidence that the study does not exist.")},
            "warnings": ["No such public series in GEO; that does not show the dataset never existed."],
            "next_actions": ["Check the accession, or search for the series with web_search or literature_search (a paper's data availability statement names it)."],
        }
    if len(platforms) > 1 and not platform:
        return {
            "status": "warning", "summary": "Series %s was run on %d platforms (%s); a series matrix is one platform's file." % (accession, len(platforms), ", ".join(platforms)),
            "data": {"accession": accession, "title": title, "platforms": platforms, "outcome": source_outcome.no_results(
                reason="multi_platform_series", how="Call again with platform set to one of data.platforms; each platform is a separate matrix and a separate analysis.")},
            "warnings": ["This series has no single matrix: choose the platform the question is about; do not pool platforms."],
            "next_actions": ["Pick the platform that matches the question, then call gene_expression_series with accession and platform."],
        }
    if platform and platforms and platform not in platforms:
        return {
            "status": "warning", "summary": "Series %s was not run on %s (its platforms: %s)." % (accession, platform, ", ".join(platforms)),
            "data": {"accession": accession, "title": title, "platforms": platforms, "outcome": source_outcome.no_results(
                reason="platform_not_in_series", how="Choose one of data.platforms.")},
            "warnings": ["The requested platform is not one of this series' platforms."],
            "next_actions": ["Call again with platform from data.platforms."],
        }
    return {
        "status": "warning", "summary": "Series %s has no processed series matrix on GEO." % accession,
        "data": {"accession": accession, "title": title, "platforms": platforms, "outcome": source_outcome.no_results(
            reason="no_series_matrix", how="GEO holds no processed matrix for this series (often a sequencing series with raw reads or supplementary counts only). Raw reads are not processed here; use the supplementary files only if they hold a processed table you can analyse with statistical-analysis.")},
        "warnings": ["No processed expression matrix: nothing was computed or preserved."],
        "next_actions": ["Say that this series offers no matrix here; if a counts table exists as a supplementary file, it is a separate dataset to bring in as a file."],
    }


def _samples_tsv(table):
    names = ["accession", "title", "sourceName", "organism", "platform", "taxId", "molecule", "type", "status", "submissionDate", "lastUpdateDate"]
    tags = []
    for entry in table:
        for tag in entry.get("characteristics", {}):
            if tag not in tags:
                tags.append(tag)
    lines = ["\t".join(names + tags)]
    for entry in table:
        lines.append("\t".join([str(entry.get(name, "")) for name in names] + [str(entry.get("characteristics", {}).get(tag, "")) for tag in tags]))
    return ("\n".join(lines) + "\n").encode("utf-8")


def _annotation_tsv(platform, probe_ids):
    lines = ["\t".join(("probe_id", "gene_symbol", "entrez_id", "gene_title", "genbank_accession", "genome_build"))]
    for probe in probe_ids:
        row = platform.rows.get(probe)
        if row is None:
            continue
        lines.append("\t".join((probe, row["symbol"], row["entrez"], row["title"], row["accession"], row["build"])))
    return ("\n".join(lines) + "\n").encode("utf-8")


def series(arguments):
    accession = str(arguments.get("accession", "")).strip().upper()
    platform = str(arguments.get("platform", "")).strip().upper() or None
    if not engine.SERIES_ACCESSION.match(accession):
        raise engine.GeneExpressionError("gene_expression_input_invalid", "accession is a GEO series accession: GSE followed by digits, such as GSE5583.")
    if platform is not None and not engine.PLATFORM_ACCESSION.match(platform):
        raise engine.GeneExpressionError("gene_expression_input_invalid", "platform is a GEO platform accession: GPL followed by digits, such as GPL81.")
    limit_values = engine.limits()
    deadline = transport.Deadline(DEADLINE_SECONDS)
    matrix_params = {"accession": accession, **({"platform": platform} if platform else {})}
    try:
        matrix_download = _download("ncbi-gene-expression-series-matrix", matrix_params, deadline, "matrix_bytes", limit_values["matrix_bytes"], "The series matrix")
    except source_outcome.SourceError as error:
        if error.reason == "not_found":
            return _no_matrix(accession, platform, deadline)
        raise
    matrix_bytes = matrix_download.body
    matrix = engine.parse_series_matrix(matrix_bytes, limit_values=limit_values)
    samples_platforms = sorted(set(matrix.sample_values("platform_id") or []))
    wanted = platform or (samples_platforms[0] if len(samples_platforms) == 1 else None)
    if not wanted:
        raise engine.GeneExpressionError(
            "gene_expression_identity_mismatch",
            "The series matrix does not name one platform for its samples (%s), so no platform record can be read for it." % (", ".join(samples_platforms) or "none stated"),
            detail={"platforms": samples_platforms},
        )
    platform_download = _download("ncbi-gene-expression-record", {"accession": wanted, "view": "full"}, deadline, "annotation_bytes", limit_values["annotation_bytes"], "The platform record")
    platform_record = engine.parse_platform(platform_download.body, limit_values=limit_values)
    identity = engine.identity_checks(matrix, platform_record, requested_platform=platform)
    sample_table = engine._sample_table(matrix)  # noqa: SLF001 - one parser for the capture and the computation
    series_title = matrix.first("title") or ""
    record = {
        "schemaVersion": engine.SCHEMA_VERSION, "kind": "gene-expression-series-capture", "engineVersion": engine.ENGINE_VERSION,
        "series": {
            "accession": matrix.first("geo_accession") or accession, "title": series_title, "type": matrix.series.get("type", []),
            "status": _stated(matrix.first("status")), "submissionDate": _stated(matrix.first("submission_date")),
            "lastUpdateDate": _stated(matrix.first("last_update_date")), "pubmedIds": matrix.series.get("pubmed_id", [])[:10],
            "sampleCount": len(matrix.sample_ids), "platforms": matrix.series.get("platform_id", []),
            "summary": " ".join(matrix.series.get("summary", []))[:1200], "overallDesign": " ".join(matrix.series.get("overall_design", []))[:800],
        },
        "platform": {
            "accession": platform_record.first("geo_accession") or wanted, "title": platform_record.first("title"),
            "organism": platform_record.first("organism"), "taxId": platform_record.first("taxid"), "technology": platform_record.first("technology"),
            "status": _stated(platform_record.first("status")), "submissionDate": _stated(platform_record.first("submission_date")),
            "lastUpdateDate": _stated(platform_record.first("last_update_date")), "rowCount": platform_record.row_count,
            "duplicateProbeIds": platform_record.duplicate_ids, "bytes": len(platform_download.body), "sha256": hashlib.sha256(platform_download.body).hexdigest(),
            "annotationColumns": {"symbol": platform_record.symbol_column, "entrez": platform_record.entrez_column, "title": platform_record.title_column,
                                  "genbank": platform_record.accession_column, "genomeBuild": platform_record.build_column},
        },
        "matrix": {
            "file": matrix_file_name(accession, platform), "sha256": hashlib.sha256(matrix_bytes).hexdigest(), "bytes": len(matrix_bytes),
            "probes": len(matrix.probe_ids), "samples": len(matrix.sample_ids), "cellsMissing": matrix.cells_missing,
        },
        "source": {"matrixUrl": "https://ftp.ncbi.nlm.nih.gov/geo/series/%s/%s/matrix/%s" % (series_directory_stub(accession), accession, matrix_file_name(accession, platform)),
                   "platformUrl": RECORD_URL % (wanted, "full"), "terms": TERMS},
        "samples": sample_table,
        "identity": identity,
    }
    # Stored bytes: the matrix exactly as served; the platform record gzipped (deterministically) because it is tens of MB of text, with the
    # digest of the bytes as served above; the harmonised sample and probe tables; and the record that ties them together.
    platform_stored = _gzip(platform_download.body)
    record["platform"]["storedFile"] = "platform.soft.txt.gz"
    record["platform"]["storedSha256"] = hashlib.sha256(platform_stored).hexdigest()
    annotation_payload = _annotation_tsv(platform_record, matrix.probe_ids)
    payloads = {
        "series_matrix.txt.gz": matrix_bytes,
        "platform.soft.txt.gz": platform_stored,
        "samples.tsv": _samples_tsv(sample_table),
        "probe-annotation.tsv": annotation_payload,
        "record.json": (json.dumps(record, ensure_ascii=False, indent=1, sort_keys=False, allow_nan=False) + "\n").encode("utf-8"),
    }
    workspace = managed_workspace()
    try:
        paths = preserve(workspace, Path(engine.SOURCES_ROOT) / ("%s-%s" % (accession, wanted)), payloads)
    except ImmutableCaptureError as error:
        raise public_sources.PublicSourceError("public_source_gene_expression_capture_failed", str(error)) from error
    capture_dir = Path(paths["record.json"]).parent.as_posix()
    checks = identity["checks"]
    warnings = []
    for name, entry in checks.items():
        if entry["status"] == "mismatch":
            warnings.append("Identity check %s failed: %s No differential expression can be computed from this capture." % (name, entry["detail"]))
        elif entry["status"] == "unknown":
            warnings.append("Identity check %s is unknown: %s" % (name, entry["detail"]))
    data = {
        "accession": record["series"]["accession"], "title": series_title,
        "series": {key: record["series"][key] for key in ("status", "submissionDate", "lastUpdateDate", "type", "pubmedIds", "sampleCount", "platforms")},
        "platform": {key: record["platform"][key] for key in ("accession", "title", "organism", "technology", "lastUpdateDate", "rowCount", "annotationColumns")},
        "matrix": record["matrix"], "captureDir": capture_dir, "paths": {name: path for name, path in paths.items()},
        "artifactSha256s": {path: hashlib.sha256(payloads[name]).hexdigest() for name, path in paths.items() if name in payloads},
        "samples": [{"accession": entry["accession"], "title": entry.get("title", ""), "characteristics": entry.get("characteristics", {})} for entry in sample_table[:MAX_SAMPLES_LISTED]],
        "sampleListing": source_outcome.complete(returned=min(len(sample_table), MAX_SAMPLES_LISTED), total=len(sample_table))
        if len(sample_table) <= MAX_SAMPLES_LISTED else source_outcome.truncated(kept=MAX_SAMPLES_LISTED, limit=MAX_SAMPLES_LISTED, unit="samples listed", how="%d samples in all; samples.tsv lists every one." % len(sample_table)),
        "identity": {name: {"status": entry["status"], "detail": entry["detail"]} for name, entry in checks.items()},
        "computationReady": identity["computationReady"],
        "valueScale": {"looksLinear": checks["scale"].get("looksLinear"), "quantiles": checks["scale"].get("quantiles"), "statedProcessing": checks["scale"].get("statedProcessing")},
        "terms": TERMS, "retrievedAt": _now(), "limits": limit_values,
        "outcome": source_outcome.complete(),
    }
    summary = "Preserved GEO series %s (%s; %d samples, %d probes on %s) with the platform's probe annotation; identities %s." % (
        data["accession"], series_title[:80] or "untitled", len(matrix.sample_ids), len(matrix.probe_ids), record["platform"]["accession"],
        "agree" if identity["computationReady"] else "do not all agree")
    result = {
        "status": "warning" if warnings else "success", "summary": summary, "data": data,
        "sources": [{"id": data["accession"], "title": series_title or None, "url": SERIES_PAGE % accession, "source": "ncbi-gene-expression-omnibus",
                     "retrievedAt": data["retrievedAt"], "evidenceAccess": "registry_record", "artifactPath": paths["record.json"]}],
        "artifacts": [paths[name] for name in payloads],
        "next_actions": [
            "Read samples.tsv to choose the two groups from the annotations, then call gene_expression_differential with captureDir.",
            "Cite the series accession and the stated last-update date; GEO series are submitter-processed, so say what the series states about its own processing.",
        ],
    }
    if warnings:
        result["warnings"] = warnings
    if not sample_table or not any(entry.get("characteristics") for entry in sample_table):
        result.setdefault("warnings", []).append("The samples carry no characteristics annotations, so groups must be declared by sample accession from the titles.")
    return result


def _gzip(payload):
    import io  # noqa: PLC0415

    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0, compresslevel=6) as stream:
        stream.write(payload)
    return buffer.getvalue()


# ---------------------------------------------------------------------------------------------------------------
# gene_expression_differential
# ---------------------------------------------------------------------------------------------------------------

def differential(arguments):
    limit_values = engine.limits()
    workspace = managed_workspace()
    request = {key: arguments[key] for key in ("captureDir", "outputDir", "groups", "reference", "transform", "topN") if key in arguments}
    request["workspace"] = str(workspace)
    # The cheap refusals come before a process is spent on them: a declaration or a path that cannot work is the same refusal here and in the child.
    engine._safe_directory(arguments.get("captureDir"), engine.SOURCES_ROOT, "captureDir")  # noqa: SLF001
    engine._safe_directory(arguments.get("outputDir"), engine.DELIVERABLES_ROOT, "outputDir")  # noqa: SLF001
    script = Path(engine.__file__).resolve()
    try:
        completed = subprocess.run(
            [sys.executable or "python3", str(script), "differential"], input=json.dumps(request).encode("utf-8"),
            capture_output=True, timeout=limit_values["wall_clock"], env=_child_environment(), cwd=str(workspace), check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise engine.GeneExpressionError(
            "gene_expression_input_over_limit", "The computation was stopped after %d seconds, the limit for one computation; nothing was written." % limit_values["wall_clock"],
            detail={"limit": "wall_clock", "allowed": limit_values["wall_clock"], "unit": "seconds", "stopped": True},
        ) from error
    except OSError as error:
        raise engine.GeneExpressionError("gene_expression_engine_unavailable", "The calculation engine could not be started in this runtime.") from error
    try:
        answer = json.loads(completed.stdout.decode("utf-8")[:8 * 1024 * 1024])
    except (ValueError, UnicodeDecodeError) as error:
        if completed.returncode != 0:
            # A child killed by the address-space backstop dies without an answer.
            raise engine.GeneExpressionError(
                "gene_expression_input_over_limit", "The computation needed more memory than the %d-byte limit allows and was stopped; nothing was written." % limit_values["memory"],
                detail={"limit": "memory", "allowed": limit_values["memory"], "unit": "bytes", "stopped": True},
            ) from error
        raise engine.GeneExpressionError("gene_expression_engine_unavailable", "The calculation engine answered with something unreadable.") from error
    if not answer.get("ok"):
        raise engine.GeneExpressionError(str(answer.get("code") or "gene_expression_input_invalid"), str(answer.get("message") or "The computation was refused."),
                                         retryable=bool(answer.get("retryable")), detail=answer.get("detail") if isinstance(answer.get("detail"), dict) else None)
    payload = answer["answer"]
    results = payload["results"]
    files = payload["files"]
    top = results["top"]
    diagnostics = results["diagnostics"]
    warnings = list(results["transformation"].get("warnings", []))
    if diagnostics["probesTested"] == 0:
        warnings.append("No probe could be tested (each had fewer than two values in a group, or no variance); there is no top table.")
    glance = [{key: row[key] for key in ("rank", "probe", "geneSymbols", "multiGene")} for row in top[:10]]
    data = {
        "resultsPath": files["results"]["path"], "receiptPath": files["receipt"]["path"], "tablePath": files["table"]["path"],
        "topTablePath": files["topTable"]["path"], "analysedMatrixPath": files["analysedMatrix"]["path"], "codePath": files["code"]["path"],
        "files": files, "method": {key: results["method"][key] for key in ("id", "isLimma", "statement", "contrast", "randomness")},
        "series": {key: results["series"][key] for key in ("accession", "platform", "lastUpdateDate", "matrixSha256")},
        "design": results["design"], "transformation": {key: results["transformation"][key] for key in ("requested", "applied", "reason", "valuesSetMissing", "warnings")},
        "diagnostics": diagnostics, "topGenes": glance,
        "renderKeys": ["top[0].logFC", "top[0].pValue", "top[0].adjPValue", "diagnostics.probesTested", "diagnostics.probesSignificantAtFdr05", "diagnostics.groupSizes.reference"],
        "outcome": source_outcome.complete(),
    }
    result = {
        "status": "warning" if warnings else "success",
        "summary": "Welch t-test per probe on %s values between %s and %s: %d probes tested, results and a rendered top table written (not limma)." % (
            results["transformation"]["applied"], results["design"]["reference"], results["design"]["comparison"], diagnostics["probesTested"]),
        "data": data, "artifacts": [files[name]["path"] for name in ("results", "table", "topTable", "analysedMatrix", "request", "code", "receipt")],
        "next_actions": [
            "Write the report as a template whose numbers are {{n:alias.key|format}} references (keys such as top[0].logFC, diagnostics.probesTested) and call research_calculate action=render "
            "with calculations {alias: {resultsPath, receiptPath}} from data; do not type a statistic.",
            "Paste gene-expression-top-table.md into the report as it is, and say in the Methods that this is a Welch test with Benjamini-Hochberg adjustment and not limma.",
        ],
    }
    if warnings:
        result["warnings"] = warnings
    return result


def _child_environment():
    """The child's environment: only what the interpreter and the limits need, so no key or gateway address reaches it."""
    import os  # noqa: PLC0415

    keep = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "HOME", "VIRTUAL_ENV") if name in os.environ}
    keep.update({name: os.environ[name] for name in engine.LIMIT_ENV.values() if name in os.environ})
    keep["OPENBLAS_NUM_THREADS"] = "1"
    keep["OMP_NUM_THREADS"] = "1"
    keep["PYTHONHASHSEED"] = "0"
    return keep


# ---------------------------------------------------------------------------------------------------------------
# The tools as the MCP server publishes and calls them
# ---------------------------------------------------------------------------------------------------------------

def _object(properties, required=()):
    schema = {"type": "object", "properties": properties, "additionalProperties": False}
    if required:
        schema["required"] = list(required)
    return schema


_GROUP = {
    "oneOf": [
        _object({"label": {"type": "string", "minLength": 1, "maxLength": 80},
                 "samples": {"type": "array", "minItems": 1, "maxItems": 200, "items": {"type": "string", "pattern": r"^GSM[1-9][0-9]{0,9}$"}}}, ("label", "samples")),
        _object({"label": {"type": "string", "minLength": 1, "maxLength": 80},
                 "where": _object({"field": {"type": "string", "minLength": 1, "maxLength": 120}, "equals": {"type": "string", "minLength": 1, "maxLength": 240}}, ("field", "equals"))},
                ("label", "where")),
    ],
}


def tool_definitions():
    return [
        {
            "name": SERIES_TOOL,
            "description": (
                "NCBI Gene Expression Omnibus (the public GEO data resource, not the platform's pharma GEO module). accession=GSE... preserves "
                "the series matrix exactly as served, the platform's probe annotation and the sample annotations, content-addressed, with the "
                "sha-256 of the fetched bytes and the dates the files state, and checks the samples, platform, organism, genome build and value "
                "scale before any calculation depends on them (unknown stays unknown). A series on several platforms needs platform=GPL...; "
                "one platform per analysis. Processed matrices only: no raw reads. Returns captureDir (for gene_expression_differential) and "
                "samples.tsv (read the groups from it). A series over a limit is refused with the reason."
            ),
            "inputSchema": _object(
                {"accession": {"type": "string", "pattern": r"^[Gg][Ss][Ee][1-9][0-9]{0,8}$", "description": "GEO series accession, such as GSE5583."},
                 "platform": {"type": "string", "pattern": r"^[Gg][Pp][Ll][1-9][0-9]{0,8}$", "description": "GEO platform accession; needed only when the series has several platforms."}},
                ("accession",),
            ),
        },
        {
            "name": DIFFERENTIAL_TOOL,
            "description": (
                "Differential expression between two declared groups of one preserved series, computed by the platform's deterministic engine, "
                "never by you: Welch t-test per probe on log2 values (log2 is applied only if the values look linear, and the result says so) "
                "with Benjamini-Hochberg adjustment, 95% intervals, diagnostics (group sizes, probes dropped, distribution check, probes that map "
                "to several genes). It is NOT limma: no empirical-Bayes variance moderation, so with small groups the variances are less stable "
                "and the top table can differ from limma's; say so. Each group has at least three samples, the groups are disjoint, and one "
                "platform. Writes results, the full table, a rendered top table, the analysed matrix, the code and a receipt under outputDir "
                "(deliverables/...). Report numbers through research_calculate action=render from resultsPath and receiptPath; never type them. "
                "An input over a limit is refused for this computation only."
            ),
            "inputSchema": _object(
                {"captureDir": {"type": "string", "minLength": 1, "maxLength": 400, "description": "data.captureDir of gene_expression_series."},
                 "outputDir": {"type": "string", "minLength": 1, "maxLength": 400, "description": "A new directory under deliverables/ for this analysis's files."},
                 "groups": {"type": "array", "minItems": 2, "maxItems": 2, "items": _GROUP,
                            "description": "Two groups, each {label, samples:[GSM...]} or {label, where:{field, equals}} (an exact value of a samples.tsv column)."},
                 "reference": {"type": "string", "minLength": 1, "maxLength": 80, "description": "The reference group's label; default the first. The contrast is comparison minus reference."},
                 "transform": {"type": "string", "enum": ["auto", "none", "log2"], "description": "Default auto: log2 only if the values look linear."},
                 "topN": {"type": "integer", "minimum": 1, "maximum": engine.TOP_N_MAX, "description": "Rows of the top table; default %d." % engine.TOP_N_DEFAULT}},
                ("captureDir", "outputDir", "groups"),
            ),
        },
    ]


def call(name, arguments):
    """Run one of the two tools. Returns a tool result and never raises."""
    try:
        if name == SERIES_TOOL:
            if not public_sources.enabled():
                return _failure("public_source_unsupported", "GEO retrieval needs the public connectors, which are disabled in this deployment.", False,
                                "Stop and obtain the series another way.", ["Ask the researcher to upload the series matrix file."])
            return series(arguments)
        return differential(arguments)
    except engine.GeneExpressionError as error:
        return _engine_failure(error)
    except source_outcome.SourceError as error:
        return source_outcome.error_result(error)
    except public_sources.SourceNotConfigured as error:
        return _failure(error.code, str(error), False, error.STOP_REASON, error.next_actions())
    except public_sources.PublicSourceError as error:
        return _failure(error.code, str(error), bool(error.retryable), "The public source could not be used.", ["Retry once after a short wait; if it fails again go on without it."])
    except ImmutableCaptureError as error:
        return _failure("public_source_gene_expression_capture_failed", str(error), False, "The preservation failed.", ["Say that the series could not be preserved; do not compute from an unpreserved copy."])
