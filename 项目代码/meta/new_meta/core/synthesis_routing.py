"""Compile a method plan into one and only one deterministic synthesis route."""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field

from new_meta.schemas.method_policy import MethodPlan, ReviewFamily


class SynthesisRoute(str, Enum):
    PAIRWISE_AGGREGATE = "pairwise_aggregate"
    METHOD_PLUGIN = "method_plugin"
    NARRATIVE = "narrative"
    BLOCKED = "blocked"


class SynthesisRoutingDecision(BaseModel):
    schema_version: int = 1
    plan_fingerprint: str = Field(min_length=1)
    capability_id: str = Field(min_length=1)
    route: SynthesisRoute
    execution_allowed: bool
    engine_entrypoint: str = ""
    blocking_reasons: list[str] = Field(default_factory=list)


class SynthesisRouteError(RuntimeError):
    def __init__(self, decision: SynthesisRoutingDecision):
        self.decision = decision
        reasons = "; ".join(decision.blocking_reasons) or (
            f"compiled route is {decision.route.value}, not pairwise_aggregate"
        )
        super().__init__(reasons)


def compile_synthesis_route(plan: MethodPlan) -> SynthesisRoutingDecision:
    reasons = list(plan.blocking_reasons)
    if not plan.execution_allowed:
        route = SynthesisRoute.BLOCKED
    elif (
        plan.family is ReviewFamily.INTERVENTION_RCT
        and plan.capability_id == "intervention_rct.parallel.standard"
        and plan.study_designs == ["parallel_rct"]
    ):
        route = SynthesisRoute.PAIRWISE_AGGREGATE
    elif plan.family in {
        ReviewFamily.INTERVENTION_RCT,
        ReviewFamily.INTERVENTION_NRSI,
        ReviewFamily.PREVALENCE_INCIDENCE,
        ReviewFamily.DIAGNOSTIC_ACCURACY,
        ReviewFamily.PROGNOSTIC_FACTOR,
        ReviewFamily.PREDICTION_MODEL,
        ReviewFamily.NETWORK_META,
        ReviewFamily.DOSE_RESPONSE,
        ReviewFamily.IPD_META,
    }:
        route = SynthesisRoute.METHOD_PLUGIN
    elif plan.family is ReviewFamily.NARRATIVE_SYNTHESIS:
        route = SynthesisRoute.NARRATIVE
    else:
        route = SynthesisRoute.BLOCKED
        reasons.append(
            f"no production orchestration route is registered for {plan.capability_id}"
        )
    return SynthesisRoutingDecision(
        plan_fingerprint=plan.plan_fingerprint,
        capability_id=plan.capability_id or plan.family.value,
        route=route,
        execution_allowed=route is not SynthesisRoute.BLOCKED,
        engine_entrypoint=plan.engine_entrypoint,
        blocking_reasons=list(dict.fromkeys(reasons)),
    )


def persist_synthesis_route(project, plan: MethodPlan) -> SynthesisRoutingDecision:
    decision = compile_synthesis_route(plan)
    project.save_json("synthesis_route.json", decision, subdir="analysis")
    return decision


def load_synthesis_route(project) -> SynthesisRoutingDecision:
    payload = project.load_json("synthesis_route.json", subdir="analysis")
    if not payload:
        raise FileNotFoundError("analysis/synthesis_route.json is required")
    return SynthesisRoutingDecision.model_validate(payload)


def require_pairwise_aggregate_route(project) -> SynthesisRoutingDecision:
    decision = load_synthesis_route(project)
    if decision.route is not SynthesisRoute.PAIRWISE_AGGREGATE:
        raise SynthesisRouteError(decision)
    return decision
