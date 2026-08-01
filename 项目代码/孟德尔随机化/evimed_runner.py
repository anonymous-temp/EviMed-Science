"""Fixed-argument EviMed adapter for the Mendelian-randomization specialist."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import tempfile
import traceback
from pathlib import Path

from dotenv import load_dotenv

# Load environment from .env and deploy.env for API tokens
load_dotenv(Path(__file__).parent / ".env", override=False)
load_dotenv(Path(__file__).parent / "deploy.env", override=True)

ROOT = Path(__file__).resolve().parent
SECTION_ORDER = (
    "abstract", "introduction", "methods", "results", "discussion",
    "limitations", "conclusion", "data_availability", "ethics_statement",
    "table1", "table2", "references",
)


def _write_result(output_dir: Path, value: dict) -> None:
    (output_dir / "result.json").write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _paper_markdown(sections: dict, exposure: str, outcome: str) -> str:
    title = str(sections.get("title") or f"Mendelian randomization: {exposure} and {outcome}").strip()
    parts = [f"# {title}"]
    for key in SECTION_ORDER:
        content = str(sections.get(key) or "").strip()
        if content:
            parts.append(f"## {key.replace('_', ' ').title()}\n\n{content}")
    return "\n\n".join(parts)


def _parse_paper_markdown(content: str) -> dict[str, str]:
    """Parse the adapter's top-level Markdown sections for deterministic re-finalization."""
    sections: dict[str, str] = {}
    current = None
    buffer: list[str] = []
    for line in content.splitlines():
        if line.startswith("# ") and "title" not in sections:
            sections["title"] = line[2:].strip()
            continue
        if line.startswith("## "):
            if current:
                sections[current] = "\n".join(buffer).strip()
            current = line[3:].strip().casefold().replace(" ", "_")
            buffer = []
        elif current:
            buffer.append(line)
    if current:
        sections[current] = "\n".join(buffer).strip()
    return sections


def _validate_release(paper: str, results: list) -> None:
    unsupported_runtime_claims = (
        "通过phenoscanner数据库排除",
        "暴露与结局资料来自独立样本",
        "暴露与结局数据来自独立样本",
        "代码已存档于github",
        "[此处插入基金",
        "[insert fund",
        "confirmed independent cohorts",
        "phenoscanner was used to exclude",
    )
    lowered_paper = paper.casefold()
    if any(claim in lowered_paper for claim in unsupported_runtime_claims):
        raise RuntimeError("MR paper contains an unsupported method, independence, code, or funding claim")
    for result in results:
        for label, metadata in (
            ("exposure", result.exposure_metadata),
            ("outcome", result.outcome_metadata),
        ):
            required = ("gwas_id", "trait", "sample_size", "population", "year")
            missing = [key for key in required if metadata.get(key) in (None, "")]
            if missing:
                raise RuntimeError(
                    f"MR {label} metadata is incomplete: {', '.join(missing)}"
                )
            sample_size = int(metadata["sample_size"])
            if str(sample_size) not in paper and f"{sample_size:,}" not in paper:
                raise RuntimeError(f"MR paper omitted authoritative {label} sample size")
            if str(metadata["gwas_id"]) not in paper:
                raise RuntimeError(f"MR paper omitted authoritative {label} GWAS ID")
        if any(item.q_pval < 0.05 for item in result.heterogeneity):
            if "异质" not in paper and "heterogeneity" not in paper.casefold():
                raise RuntimeError("MR paper omitted significant heterogeneity")
        if result.pleiotropy and result.pleiotropy.pval < 0.05:
            if "多效" not in paper and "pleiotropy" not in paper.casefold():
                raise RuntimeError("MR paper omitted significant directional pleiotropy")
        if result.sample_overlap_warning:
            unsupported_overlap_claims = (
                "两个数据集在样本构成上不存在重叠",
                "确认两个gwas队列不重叠",
                "confirmed non-overlapping cohorts",
            )
            if any(claim in lowered_paper for claim in unsupported_overlap_claims):
                raise RuntimeError("MR paper made an unsupported non-overlap claim")
        # A sensitivity analysis that did not run must not be written up as a
        # clean result. Each of these has a value only when the analysis produced
        # one, so an absent value plus a reassuring sentence is a fabrication.
        unavailable_tests = (
            (result.presso_global_pval, r"MR-PRESSO", "MR-PRESSO global test"),
            (result.radial_pval, r"(?:radial(?:[ -]?MR)?|径向)", "radial MR test"),
            (
                result.conmix_pval,
                r"(?:contamination[ -]?mixture|conmix|污染混合)",
                "contamination-mixture test",
            ),
        )
        # Stay inside one sentence, but a period that belongs to a number is not
        # a sentence end: excluding "." outright let "p = 0.31, no evidence of
        # outliers" past the check, which is the exact sentence being guarded.
        within_sentence = r"(?:(?!\.[\s　])[^\n。])"
        for value, token, label in unavailable_tests:
            if value is not None:
                continue
            if re.search(
                rf"{token}{within_sentence}{{0,80}}(?:未发现|无证据|no evidence|negative)",
                paper,
                flags=re.IGNORECASE,
            ):
                raise RuntimeError(f"MR paper treated an unavailable {label} as negative")


def _copy_release_artifacts(output_dir: Path, state, results: list) -> list[str]:
    """Copy the real analysis package out of the temporary runtime directory.

    Only known report/data/figure formats are published.  Paths in the
    structured result are rewritten to output-relative paths so provenance does
    not point at a disposable macOS temporary directory.
    """
    copied: list[str] = []
    runtime_dir = Path(state.output_dir).resolve() if state.output_dir else None
    if runtime_dir and runtime_dir.is_dir():
        for name in ("paper.docx", "mr_report.pdf", "paper.txt"):
            source = runtime_dir / name
            if source.is_file() and not source.is_symlink() and source.stat().st_size <= 50_000_000:
                target_name = {
                    "paper.docx": "mendelian-randomization-report.docx",
                    "mr_report.pdf": "mendelian-randomization-report.pdf",
                    "paper.txt": "mendelian-randomization-report.txt",
                }[name]
                shutil.copy2(source, output_dir / target_name)
                copied.append(target_name)

    allowed_suffixes = {".csv", ".json", ".png", ".pdf"}
    for index, result in enumerate(results, start=1):
        raw = Path(result.raw_data_path).resolve() if result.raw_data_path else None
        pair_name = re.sub(
            r"[^A-Za-z0-9._-]+", "-", f"{index}-{result.exposure_id}-{result.outcome_id}"
        ).strip("-")
        target_dir = output_dir / "analysis-data" / pair_name
        if raw and raw.is_dir():
            target_dir.mkdir(parents=True, exist_ok=True)
            for source in sorted(raw.iterdir()):
                if (
                    source.is_file()
                    and not source.is_symlink()
                    and source.suffix.casefold() in allowed_suffixes
                    and source.stat().st_size <= 50_000_000
                ):
                    target = target_dir / source.name
                    if source.resolve() != target.resolve():
                        shutil.copy2(source, target)
                    copied.append(target.relative_to(output_dir).as_posix())
            result.raw_data_path = Path("analysis-data") / pair_name
        rewritten_plots = {}
        for label, path in result.plots.items():
            source = Path(path)
            target = target_dir / source.name
            if target.is_file():
                rewritten_plots[label] = target.relative_to(output_dir)
        result.plots = rewritten_plots
    return copied


def run(request_path: Path, output_dir: Path) -> int:
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
        exposure = str(request.get("exposure") or "").strip()
        outcome = str(request.get("outcome") or "").strip()
        if not exposure or not outcome:
            raise ValueError("exposure and outcome are required")

        from mr_agent.core.engine import MRAgent

        language = str(request.get("outputLanguage") or "zh")
        agent = MRAgent(language=language)
        agent.state.slots.exposure = exposure
        agent.state.slots.outcome = outcome
        agent.state.slots.bidirectional = request.get("analysisDirection") == "bidirectional"
        token = os.environ.get("OPENGWAS_JWT", "").strip()
        if token:
            agent.state.slots.gwas_token = token
        analysis_message = agent._run_analysis()
        valid_results = [result for result in agent.state.analysis_results if result.n_instruments > 0]
        if not valid_results:
            detail = agent.state.errors[-1] if agent.state.errors else analysis_message
            raise RuntimeError("MR analysis produced no valid instruments: %s" % detail)
        agent._run_paper_generation()
        paper = _paper_markdown(agent.state.paper_sections, exposure, outcome)
        if len(paper.strip()) < 500:
            raise RuntimeError("MR paper generation produced an incomplete manuscript")
        _validate_release(paper, valid_results)
        report_path = output_dir / "mendelian-randomization-report.md"
        report_path.write_text(paper, encoding="utf-8")
        copied_artifacts = _copy_release_artifacts(output_dir, agent.state, valid_results)
        analysis_path = output_dir / "mendelian-randomization-run.json"
        analysis_path.write_text(
            json.dumps(
                [result.model_dump(mode="json") for result in valid_results],
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        _write_result(output_dir, {
            "status": "succeeded",
            "exposure": exposure,
            "outcome": outcome,
            "analysisPairs": len(valid_results),
            "instruments": sum(result.n_instruments for result in valid_results),
            "report": report_path.name,
            "artifacts": [report_path.name, analysis_path.name, *copied_artifacts],
        })
        return 0
    except Exception as error:
        traceback.print_exc()
        _write_result(output_dir, {"status": "failed", "error": str(error)})
        return 1


def finalize_existing(request_path: Path, output_dir: Path) -> int:
    """Re-finalize a completed real run after release-grounding upgrades."""
    try:
        from mr_agent.models import MRAnalysisResult, SessionState
        from mr_agent.output.report import generate_pdf_report
        from mr_agent.paper.generator import PaperGenerator

        request = json.loads(request_path.read_text(encoding="utf-8"))
        result_path = output_dir / "mendelian-randomization-run.json"
        report_path = output_dir / "mendelian-randomization-report.md"
        results = [MRAnalysisResult.model_validate(item) for item in json.loads(result_path.read_text(encoding="utf-8"))]
        state = SessionState(analysis_results=results)
        state.slots.exposure = str(request.get("exposure") or "")
        state.slots.outcome = str(request.get("outcome") or "")
        state.slots.bidirectional = request.get("analysisDirection") == "bidirectional"
        for result in results:
            if result.raw_data_path:
                raw = Path(result.raw_data_path)
                result.raw_data_path = raw if raw.is_absolute() else (output_dir / raw).resolve()
            result.plots = {
                label: path if Path(path).is_absolute() else (output_dir / Path(path)).resolve()
                for label, path in result.plots.items()
            }
        generator = PaperGenerator(object(), state, language=str(request.get("outputLanguage") or "zh"))
        sections = _parse_paper_markdown(report_path.read_text(encoding="utf-8"))
        sections = generator._enforce_structured_grounding(sections)
        state.paper_sections = sections
        paper = _paper_markdown(sections, state.slots.exposure, state.slots.outcome)
        _validate_release(paper, results)
        report_path.write_text(paper, encoding="utf-8")
        with tempfile.TemporaryDirectory(prefix="evimed-mr-finalize-") as temporary:
            state.output_dir = Path(temporary)
            generator.save_paper(state.output_dir)
            generator.save_paper_docx(state.output_dir)
            generate_pdf_report(state, state.output_dir)
            copied = _copy_release_artifacts(output_dir, state, results)
        result_path.write_text(
            json.dumps([result.model_dump(mode="json") for result in results], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        _write_result(output_dir, {
            "status": "succeeded",
            "exposure": state.slots.exposure,
            "outcome": state.slots.outcome,
            "analysisPairs": len(results),
            "instruments": sum(result.n_instruments for result in results),
            "report": report_path.name,
            "artifacts": [report_path.name, result_path.name, *copied],
            "refinalized": True,
        })
        return 0
    except Exception as error:
        traceback.print_exc()
        _write_result(output_dir, {"status": "failed", "error": str(error)})
        return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--finalize-existing", action="store_true")
    args = parser.parse_args()
    if args.finalize_existing:
        return finalize_existing(args.request, args.output_dir)
    return run(args.request, args.output_dir)


if __name__ == "__main__":
    raise SystemExit(main())
