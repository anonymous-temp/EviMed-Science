"""Deterministic paper-aligned analysis for one pharmacological class."""

from __future__ import annotations

from datetime import date, timedelta
from statistics import median

from safety_agent.faers import DrugScope
from safety_agent.core.exceptions import NoDataError
from safety_agent.signals import (
    DEFAULT_MGPS_PRIOR,
    MGPSPrior,
    analyze,
    build_table_from_counts,
    evaluate,
)

from .models import (
    ApprovalSensitivityResult,
    ClassAnalysisResult,
    ClassSignalRow,
    TherapyStrataResult,
    TimeToOnsetResult,
)
from .registry import DrugClassDefinition, DrugClassRegistry
from .taxonomy import EventTaxonomy

_DEFAULT_PRIOR_ID = "default-gps-starting-prior-v1"


class ClassAnalysisEngine:
    """Run all class, member, comparator, stratum, and timing views."""

    def __init__(
        self,
        snapshot: object,
        *,
        registry: DrugClassRegistry | None = None,
        taxonomy: EventTaxonomy | None = None,
        prior: MGPSPrior = DEFAULT_MGPS_PRIOR,
    ) -> None:
        self.snapshot = snapshot
        self.registry = registry or DrugClassRegistry.bundled()
        self.taxonomy = taxonomy or EventTaxonomy.bundled()
        self.prior = prior

    def run(
        self,
        class_id: str,
        reactions: list[str] | tuple[str, ...] = (),
        *,
        role_codes: frozenset[str] = frozenset({"PS"}),
        date_from: date | None = None,
        date_to: date | None = None,
    ) -> ClassAnalysisResult:
        definition = self.registry.get(class_id)
        pooled = self._scope(definition.all_names, role_codes, date_from, date_to)
        total_reports = self.snapshot.overview(pooled).total_reports
        if total_reports == 0:
            raise NoDataError(
                f"frozen FAERS snapshot has no matching reports for class {definition.id}"
            )
        selected = list(
            dict.fromkeys(
                self._term(item) for item in reactions if self._term(item)
            )
        )
        if not selected:
            selected = [bucket.term for bucket in self.snapshot.top_reactions(pooled, limit=20)]
        comparisons: list[ClassSignalRow] = []
        unavailable_reactions: list[str] = []
        available_reactions: list[str] = []
        for reaction in selected:
            counts = self.snapshot.contingency(pooled, reaction)
            if counts.event_total == 0:
                unavailable_reactions.append(reaction)
                continue
            row = self._versus_all(
                definition.id, pooled, reaction, "all_faers", counts=counts
            )
            if row is None:
                raise NoDataError(
                    "frozen FAERS snapshot has no non-class background reports "
                    f"for class {definition.id}"
                )
            comparisons.append(row)
            available_reactions.append(reaction)
        selected = available_reactions
        if not selected:
            raise NoDataError(
                "none of the requested reactions occur in the frozen FAERS snapshot"
            )
        member_signal_sets: dict[str, set[str]] = {}
        member_report_counts: dict[str, int] = {}
        members_without_reports: list[str] = []
        for member in definition.members:
            target = self._scope(member.match_names, role_codes, date_from, date_to)
            member_total = self.snapshot.overview(target).total_reports
            member_report_counts[member.id] = member_total
            if member_total == 0:
                members_without_reports.append(member.id)
                continue
            rest_names = tuple(
                name
                for other in definition.members
                if other.id != member.id
                for name in other.match_names
            )
            rest = self._scope(rest_names, role_codes, date_from, date_to)
            member_signals: set[str] = set()
            for reaction in selected:
                all_row = self._versus_all(member.id, target, reaction, "all_faers")
                if all_row is not None:
                    comparisons.append(all_row)
                    if all_row.is_signal:
                        member_signals.add(reaction)
                rest_row = self._versus_comparator(
                    member.id, target, rest, reaction, "rest_of_class"
                )
                if rest_row is not None:
                    comparisons.append(rest_row)
            member_signal_sets[member.id] = member_signals
        if definition.therapeutic_comparator_names:
            therapeutic = self._scope(
                definition.therapeutic_comparator_names,
                role_codes,
                date_from,
                date_to,
            )
            for reaction in selected:
                row = self._versus_comparator(
                    definition.id,
                    pooled,
                    therapeutic,
                    reaction,
                    "therapeutic_area",
                )
                if row is not None:
                    comparisons.append(row)
        shared = (
            sorted(set.intersection(*member_signal_sets.values()))
            if member_signal_sets
            else []
        )
        unique = {
            member_id: sorted(
                signals
                - set().union(
                    *(
                        other
                        for key, other in member_signal_sets.items()
                        if key != member_id
                    )
                )
            )
            for member_id, signals in member_signal_sets.items()
        }
        taxonomy = [self.taxonomy.classify(reaction) for reaction in selected]
        mapped = sum(item.source != "unmapped" for item in taxonomy)
        strata = None
        if definition.therapeutic_comparator_names:
            raw = self.snapshot.therapy_strata(
                pooled,
                co_medication_names=definition.therapeutic_comparator_names,
            )
            strata = TherapyStrataResult(
                definition="target class without/with registry therapeutic co-medications",
                monotherapy=raw.monotherapy,
                polytherapy=raw.polytherapy,
            )
        time_to_onset_available = True
        limitations = [
            "Signals are screening associations, not incidence estimates or causal effects.",
            "Rest-of-class and therapeutic comparisons exclude reports containing both groups.",
            "Bundled SOC/SMQ/IME mappings are a regression subset, not licensed full MedDRA.",
        ]
        try:
            onset = [self._onset(pooled, reaction) for reaction in selected]
        except ValueError as error:
            if "version 3" not in str(error):
                raise
            onset = []
            time_to_onset_available = False
            limitations.append(
                "Time-to-onset was not run because this legacy snapshot lacks schema v3 temporal fields."
            )
        sensitivity = self._approval_sensitivity(
            definition, selected, role_codes, date_from, date_to
        )
        provenance = self.snapshot.provenance
        return ClassAnalysisResult(
            class_id=definition.id,
            class_name=definition.display_name,
            definition_version=definition.version,
            atc_codes=list(definition.atc_codes),
            members=[member.id for member in definition.members],
            member_report_counts=member_report_counts,
            members_without_reports=members_without_reports,
            excluded_products=list(definition.excluded_products),
            definition_sources=list(definition.sources),
            reactions=selected,
            unavailable_reactions=unavailable_reactions,
            total_reports=total_reports,
            comparisons=comparisons,
            shared_signals=shared,
            unique_signals=unique,
            taxonomy=taxonomy,
            taxonomy_coverage=mapped / len(taxonomy) if taxonomy else 0.0,
            therapy_strata=strata,
            time_to_onset=onset,
            approval_sensitivity=sensitivity,
            suspect_roles=sorted(role_codes),
            study_date_from=date_from.isoformat() if date_from else None,
            study_date_to=date_to.isoformat() if date_to else None,
            snapshot_id=provenance.snapshot_id,
            snapshot_source=provenance.source,
            snapshot_sha256=provenance.sha256,
            gps_prior_fitted=self.prior.fitted,
            gps_prior_id=self.prior.fit_id or _DEFAULT_PRIOR_ID,
            time_to_onset_available=time_to_onset_available,
            limitations=limitations,
        )

    def _versus_all(
        self,
        target_id: str,
        scope: DrugScope,
        reaction: str,
        comparator: str,
        counts=None,
    ) -> ClassSignalRow | None:
        counts = counts or self.snapshot.contingency(scope, reaction)
        if (
            counts.drug_total == 0
            or counts.grand_total - counts.drug_total == 0
            or counts.event_total == 0
            or counts.grand_total - counts.event_total == 0
        ):
            return None
        table = build_table_from_counts(
            counts.joint,
            counts.drug_total,
            counts.event_total,
            counts.grand_total,
        )
        return self._row(target_id, comparator, reaction, table, 0)

    def _versus_comparator(
        self,
        target_id: str,
        target: DrugScope,
        comparator_scope: DrugScope,
        reaction: str,
        label: str,
    ) -> ClassSignalRow | None:
        counts = self.snapshot.comparative_contingency(
            target, comparator_scope, reaction
        )
        if (
            counts.a + counts.b == 0
            or counts.c + counts.d == 0
            or counts.a + counts.c == 0
            or counts.b + counts.d == 0
        ):
            return None
        from .registry import build_exclusive_table
        table = build_exclusive_table(
            target_total=counts.a + counts.b,
            target_event=counts.a,
            comparator_total=counts.c + counts.d,
            comparator_event=counts.c,
        )
        return self._row(target_id, label, reaction, table, counts.overlap_excluded)

    def _row(
        self,
        target_id: str,
        comparator: str,
        reaction: str,
        table,
        overlap: int,
    ) -> ClassSignalRow:
        metrics = analyze(table, prior=self.prior)
        decision = evaluate(metrics)
        return ClassSignalRow(
            target_id=target_id,
            comparator=comparator,
            reaction=reaction,
            a=table.a,
            b=table.b,
            c=table.c,
            d=table.d,
            n=table.n,
            overlap_excluded=overlap,
            ror=metrics.ror.value, ror_ci95_lower=metrics.ror.ci95_lower,
            ror_ci95_upper=metrics.ror.ci95_upper, prr=metrics.prr.value,
            chi2=metrics.chi2.value, ic=metrics.ic.value, ic025=metrics.ic.ic025,
            ebgm=metrics.ebgm.value, eb05=metrics.ebgm.eb05,
            expected_count=metrics.ebgm.expected,
            gps_prior_id=metrics.ebgm.prior.fit_id or _DEFAULT_PRIOR_ID,
            haldane_anscombe_applied=metrics.haldane_anscombe_applied,
            is_signal=decision.is_signal,
        )

    def _onset(self, scope: DrugScope, reaction: str) -> TimeToOnsetResult:
        raw = self.snapshot.time_to_onset(scope, reaction)
        values = list(raw.days)
        return TimeToOnsetResult(
            reaction=reaction,
            observed=len(values),
            missing=raw.missing,
            median_days=median(values) if values else None,
            q1_days=_quantile(values, 0.25),
            q3_days=_quantile(values, 0.75),
        )

    def _approval_sensitivity(
        self, definition, reactions, roles, global_from, global_to
    ):
        rows: list[ApprovalSensitivityResult] = []
        for member in definition.members:
            if not member.approval_date:
                continue
            approval = date.fromisoformat(member.approval_date)
            start = max(filter(None, (approval, global_from)))
            end = min(filter(None, (approval + timedelta(days=364), global_to)))
            if start > end:
                continue
            scope = self._scope(member.match_names, roles, start, end)
            report_count = self.snapshot.overview(scope).total_reports
            if report_count == 0:
                continue
            sensitivity_rows = [
                self._versus_all(
                    member.id, scope, reaction, "all_faers_first_year"
                )
                for reaction in reactions
            ]
            signal_count = sum(
                row.is_signal for row in sensitivity_rows if row is not None
            )
            rows.append(ApprovalSensitivityResult(
                    member_id=member.id,
                    date_from=start.isoformat(),
                    date_to=end.isoformat(),
                    report_count=report_count,
                    signal_count=signal_count,
                )
            )
        return rows

    @staticmethod
    def _scope(names, roles, date_from, date_to):
        return DrugScope(
            names=tuple(names),
            role_codes=roles,
            date_from=date_from,
            date_to=date_to,
        )

    @staticmethod
    def _term(value: str) -> str:
        return " ".join(value.strip().casefold().split())


def _quantile(values: list[int], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight
