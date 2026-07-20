"""Shared non-pairwise synthesis and manuscript delivery seam."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from typing import Callable

from new_meta.core.method_manuscript import build_method_manuscript
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.schemas.phase_result import PhaseResult


@dataclass(frozen=True)
class MethodDelivery:
    phase: PhaseResult
    manuscript: str = ""
    decisions: list[dict[str, Any]] = field(default_factory=list)


class MethodDeliveryBlocked(RuntimeError):
    def __init__(self, phase: PhaseResult):
        self.phase = phase
        super().__init__(phase.summary)


def run_method_delivery(
    *,
    project,
    protocol,
    extracted_studies: list,
    rob_results: list,
    prisma_data: dict,
    search_query: str,
    lang: str,
    options: dict[str, Any] | None = None,
    auto_resolve_uncertainty: bool = False,
    prepare_result_rob: Callable[[list[str]], Any] | None = None,
) -> MethodDelivery:
    phase = PipelineRunner(project).run_compiled_method_synthesis(
        options=options,
        auto_select_ambiguous=auto_resolve_uncertainty,
    )
    if phase.status.value != "succeeded":
        return MethodDelivery(phase=phase)
    if prepare_result_rob is not None:
        synthesis = project.load_json("synthesis_result.json", subdir="analysis") or {}
        prepare_result_rob([str(item) for item in synthesis.get("input_result_ids") or []])
    from new_meta.core.method_certainty import (
        build_method_certainty_draft,
        complete_method_certainty_conservatively,
    )

    certainty = build_method_certainty_draft(project)
    if auto_resolve_uncertainty:
        certainty = complete_method_certainty_conservatively(project, certainty)
    decisions = []
    if certainty.status.value != "completed":
        from new_meta.core.method_certainty import build_method_certainty_option_payload

        decisions.append(build_method_certainty_option_payload(certainty))
    manuscript = build_method_manuscript(
        project=project,
        protocol=protocol,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        prisma_data=prisma_data,
        search_query=search_query,
        lang=lang,
    )
    project.save_checkpoint("manuscript")
    return MethodDelivery(phase=phase, manuscript=manuscript, decisions=decisions)
