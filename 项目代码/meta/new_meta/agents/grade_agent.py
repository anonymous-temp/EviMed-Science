"""GRADE evidence assessment agent — evaluates certainty of evidence across five domains."""
from __future__ import annotations

import json
import math
import re
import traceback

from new_meta.core.agent_base import BaseAgent
from new_meta.schemas.grade import GRADEDomain, GRADEOutcome, GRADEProfile
from new_meta.schemas.meta_result import MetaAnalysisResults, PooledEffect, PublicationBiasResult
from new_meta.schemas.risk_of_bias import StudyRoB
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.schemas.study import ExtractedStudy
from new_meta.prompts import grade_prompts


# Certainty level mapping: numeric score -> label
_CERTAINTY_LEVELS = {4: "High", 3: "Moderate", 2: "Low", 1: "Very low", 0: "Very low"}


class GRADEAgent(BaseAgent):
    """Assesses certainty of evidence using the GRADE framework.

    For each outcome the agent evaluates five domains (risk of bias,
    inconsistency, indirectness, imprecision, publication bias), applies
    downgrades, and produces a GRADE evidence profile.
    """

    def __init__(self, model: str = None):
        super().__init__("grade", grade_prompts.SYSTEM_PROMPT, model=model)

    # ------------------------------------------------------------------
    # Rationale templates
    # ------------------------------------------------------------------

    @staticmethod
    def _fmt_pct(value: float | None) -> str:
        if value is None or not math.isfinite(float(value)):
            return "NR"
        return f"{float(value):.1f}%"

    @staticmethod
    def _fmt_p(value: float | None) -> str:
        if value is None or not math.isfinite(float(value)):
            return "NR"
        return f"{float(value):.3g}"

    @classmethod
    def _grade_rationale(cls, domain: str, rating: str, details: dict | None = None) -> str:
        """Render publication-facing GRADE rationale from structured fields.

        The engine keeps operational flags in ``details`` and never places
        internal markers such as parser rules, boolean debug flags, or synthetic
        RoB instructions into the rationale text saved in ``grade_profile.json``.
        """
        details = details if isinstance(details, dict) else {}
        rating_key = str(rating or "").strip().lower()
        downgraded = rating_key in {"serious", "very serious"}

        if domain == "risk_of_bias":
            assessed = int(details.get("n_assessed") or 0)
            total = int(details.get("total_contributing") or assessed or 0)
            high = int(details.get("n_high") or 0)
            some = int(details.get("n_some") or 0)
            low = int(details.get("n_low") or 0)
            unknown = int(details.get("n_unknown") or 0)
            not_formal = int(details.get("n_not_formally_assessed") or 0)
            missing = int(details.get("n_missing_assessment") or max(total - assessed, 0))
            if assessed <= 0:
                return "No formal risk-of-bias assessments were available for contributing studies; human review is required."
            parts = [
                f"Formal RoB information was available for {assessed}/{total} contributing studies",
                f"{high}/{assessed} high risk",
                f"{some}/{assessed} with some concerns",
                f"{low}/{assessed} low risk",
            ]
            if unknown:
                parts.append(f"{unknown}/{assessed} non-standard judgments requiring review")
            if not_formal:
                parts.append(f"{not_formal}/{assessed} not formally assessed")
            if missing:
                parts.append(f"{missing}/{total} contributing studies lacking formal RoB assessment")
            conclusion = "a downgrade was applied for risk of bias" if downgraded else "no downgrade was applied for risk of bias"
            return "; ".join(parts) + f"; {conclusion}."

        if domain == "inconsistency":
            n = int(details.get("n_studies") or 0)
            i2 = details.get("i_squared")
            q_p = details.get("q_p_value")
            tau2 = details.get("tau_squared")
            stat_parts = [f"I²={cls._fmt_pct(i2)}", f"Chi² p={cls._fmt_p(q_p)}"]
            if tau2 is not None and math.isfinite(float(tau2)):
                stat_parts.append(f"tau²={float(tau2):.3f}")
            if n <= 1:
                return "Only one study contributed, so statistical inconsistency was not applicable."
            conclusion = "a downgrade was applied for inconsistency" if downgraded else "no downgrade was applied for inconsistency"
            pi_note = ""
            if details.get("prediction_interval") and details.get("prediction_interval_used_for_rating") is False:
                pi_note = " The prediction interval was not used for downgrading because fewer than 3 studies contributed."
            return f"Heterogeneity was assessed across {n} studies ({'; '.join(stat_parts)}); {conclusion}.{pi_note}"

        if domain == "indirectness":
            n = int(details.get("n_contributing") or 0)
            dims = details.get("dimensions") if isinstance(details.get("dimensions"), dict) else {}
            row_label = str(details.get("source_verified_row_label") or "outcome rows")
            if bool(details.get("source_verified_direct_rows")) and not downgraded:
                return (
                    f"Source-verified {row_label} were available for {n}/{n} contributing studies "
                    "and were sufficiently direct for the review question; no indirectness downgrade was applied."
                )
            signals: list[str] = []
            for label, key in (
                ("population", "population"),
                ("intervention", "intervention"),
                ("comparator", "comparator"),
                ("outcome", "outcome"),
            ):
                item = dims.get(key) if isinstance(dims.get(key), dict) else {}
                mismatch = int(item.get("mismatch") or 0)
                unverified = int(item.get("unverified") or 0)
                if mismatch:
                    signals.append(f"{label} mismatch in {mismatch}/{int(item.get('total') or n or mismatch)} studies")
                if unverified:
                    signals.append(f"{label} information unverified in {unverified}/{int(item.get('total') or n or unverified)} studies")
            design = dims.get("design") if isinstance(dims.get("design"), dict) else {}
            non_randomized = int(design.get("non_randomized") or 0)
            design_unverified = int(design.get("unverified") or 0)
            if non_randomized:
                signals.append(f"non-randomized design in {non_randomized}/{int(design.get('total') or n or non_randomized)} studies")
            if design_unverified:
                signals.append(f"design information unverified in {design_unverified}/{int(design.get('total') or n or design_unverified)} studies")
            if bool(details.get("surrogate_outcome")):
                signals.append("surrogate-outcome concern")
            if not signals:
                if downgraded:
                    signals.append("applicability differences between the target review question and contributing evidence")
                else:
                    return "The contributing studies were sufficiently direct for the review question; no downgrade was applied for indirectness."
            conclusion = "a downgrade was applied for indirectness" if downgraded else "no downgrade was applied for indirectness"
            return "Indirectness was judged from structured population, intervention, comparator, outcome, and design fields: " + "; ".join(signals) + f"; {conclusion}."

        if domain == "imprecision":
            total_n = int(details.get("total_n") or 0)
            ois = int(details.get("ois") or 0)
            n_studies = int(details.get("n_studies") or 0)
            matched = int(details.get("matched_count") or 0)
            crosses = bool(details.get("crosses_null"))
            ci_width = details.get("ci_width")
            source = str(details.get("total_source") or "pooled rows")
            source_text = "selected pooled rows" if source == "selected_pooled_rows" else source.replace("_", " ")
            cross_text = "crossed" if crosses else "did not cross"
            width_text = f"; log-scale CI width was {float(ci_width):.3f}" if ci_width is not None and math.isfinite(float(ci_width)) else ""
            conclusion = "a downgrade was applied for imprecision" if downgraded else "no downgrade was applied for imprecision"
            matched_text = f" with participant counts from {matched}/{n_studies} studies" if matched and n_studies else ""
            return (
                f"The {source_text} included {total_n} participants{matched_text}; "
                f"the optimal information size threshold was {ois}; the confidence interval {cross_text} the null"
                f"{width_text}; {conclusion}."
            )

        if domain == "publication_bias":
            n = int(details.get("n_studies") or 0)
            if n and n < 3:
                return (
                    f"Only {n} studies contributed, so small-study-effect or non-publication could not be "
                    "meaningfully assessed; a downgrade was applied for publication-bias uncertainty."
                )
            if n and n < 10:
                return (
                    f"Fewer than 10 studies contributed (k={n}), so small-study-effect tests were not interpreted "
                    "confirmatorily; no downgrade was applied for publication bias."
                )
            signals = details.get("signals") if isinstance(details.get("signals"), list) else []
            if signals:
                conclusion = "a downgrade was applied for publication bias" if downgraded else "no downgrade was applied for publication bias"
                return "Publication-bias assessment considered " + "; ".join(str(s) for s in signals) + f"; {conclusion}."
            return "No publication-bias signal was detected in the available tests; no downgrade was applied for publication bias."

        return "This GRADE domain was assessed from structured domain fields."

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def run(
        self,
        meta_results: MetaAnalysisResults,
        rob_results: list[StudyRoB],
        pub_bias: PublicationBiasResult | None,
        studies: list[ExtractedStudy],
        protocol: ResearchProtocol,
    ) -> GRADEProfile:
        """Run the full GRADE assessment for all outcomes.

        Parameters
        ----------
        meta_results : MetaAnalysisResults
            Pooled effects for primary and secondary outcomes.
        rob_results : list[StudyRoB]
            Individual study risk-of-bias assessments.
        pub_bias : PublicationBiasResult | None
            Publication bias test results (Egger, Begg, trim-fill, etc.).
        studies : list[ExtractedStudy]
            Extracted study data with characteristics and outcomes.
        protocol : ResearchProtocol
            Research protocol containing the target PICO.

        Returns
        -------
        GRADEProfile
            Complete GRADE evidence profile for all assessed outcomes.
        """
        self.log("Starting GRADE evidence assessment...")

        outcomes_to_assess: list[PooledEffect] = [meta_results.primary_outcome]
        outcomes_to_assess.extend(meta_results.secondary_outcomes)

        grade_outcomes: list[GRADEOutcome] = []

        for pooled in outcomes_to_assess:
            try:
                outcome = self._assess_outcome(
                    pooled, rob_results, pub_bias, studies, protocol,
                )
                grade_outcomes.append(outcome)
                self.log(
                    f"  {pooled.outcome_name}: {outcome.certainty} certainty "
                    f"(n={pooled.n_studies})"
                )
            except Exception as exc:
                self.log(
                    f"GRADE assessment failed for '{pooled.outcome_name}': {exc}",
                    level="error",
                )
                self.log(traceback.format_exc(), level="debug")
                # Provide a fallback outcome so the profile is not incomplete
                grade_outcomes.append(
                    GRADEOutcome(
                        outcome_name=pooled.outcome_name,
                        n_studies=pooled.n_studies,
                        effect_summary=self._format_effect(pooled),
                        certainty="Very low",
                        domains=[],
                        footnotes=["Automatic downgrade: GRADE assessment encountered an error."],
                    )
                )

        profile = GRADEProfile(outcomes=grade_outcomes)
        self.log(f"GRADE assessment complete — {len(grade_outcomes)} outcomes assessed.")
        return profile

    # ------------------------------------------------------------------
    # Per-outcome orchestration
    # ------------------------------------------------------------------

    def _assess_outcome(
        self,
        pooled: PooledEffect,
        rob_results: list[StudyRoB],
        pub_bias: PublicationBiasResult | None,
        studies: list[ExtractedStudy],
        protocol: ResearchProtocol,
    ) -> GRADEOutcome:
        """Assess all five GRADE domains for a single outcome."""
        # Determine study IDs contributing to this outcome
        study_ids = {s.study_id for s in pooled.studies}

        # Determine initial certainty level based on study design
        initial_level = self._initial_certainty(studies, study_ids)

        # Assess each domain
        domains: list[GRADEDomain] = []
        footnotes: list[str] = []

        # 1. Risk of bias
        rob_domain = self._assess_risk_of_bias(rob_results, study_ids)
        domains.append(rob_domain)

        # 2. Inconsistency
        inconsistency_domain = self._assess_inconsistency(pooled)
        domains.append(inconsistency_domain)

        # 3. Indirectness (rule-based rating with LLM narrative)
        indirectness_domain = self._assess_indirectness(studies, protocol, study_ids, pooled.outcome_name)
        domains.append(indirectness_domain)

        # 4. Imprecision
        imprecision_domain = self._assess_imprecision(
            pooled,
            studies=studies,
            study_ids=study_ids,
            outcome_name=pooled.outcome_name,
        )
        domains.append(imprecision_domain)

        # 5. Publication bias
        pub_bias_domain = self._assess_publication_bias(pub_bias, pooled)
        domains.append(pub_bias_domain)

        # Compute final certainty
        certainty = self._compute_certainty(domains, initial_level)

        # Collect footnotes from domain rationales
        for d in domains:
            if d.rating != "no concern":
                footnotes.append(f"{d.domain}: {d.rationale}")

        return GRADEOutcome(
            outcome_name=pooled.outcome_name,
            n_studies=pooled.n_studies,
            effect_summary=self._format_effect(pooled),
            certainty=certainty,
            domains=domains,
            footnotes=footnotes,
        )

    # ------------------------------------------------------------------
    # Domain 1: Risk of bias
    # ------------------------------------------------------------------

    def _assess_risk_of_bias(
        self, rob_results: list[StudyRoB], study_ids: set[str]
    ) -> GRADEDomain:
        """Deterministic risk-of-bias assessment with LLM rationale.

        Thresholds (proportion of studies):
        - >50% high risk -> "very serious"
        - >30% high risk OR >50% some concerns -> "serious"
        - otherwise -> "no concern"
        """
        total_contributing = len(study_ids)
        relevant = [r for r in rob_results if r.study_id in study_ids]

        if not relevant:
            rating = "very serious" if total_contributing else "serious"
            details = {
                "total_contributing": total_contributing,
                "n_assessed": 0,
                "n_missing_assessment": total_contributing,
                "n_high": 0,
                "n_some": 0,
                "n_low": 0,
                "n_unknown": 0,
                "n_not_formally_assessed": 0,
            }
            return GRADEDomain(
                domain="risk_of_bias",
                rating=rating,
                rationale=self._grade_rationale("risk_of_bias", rating, details),
                details=details,
            )

        n = len(relevant)
        denominator_note = ""
        if total_contributing and n != total_contributing:
            denominator_note = (
                f" {total_contributing - n}/{total_contributing} contributing studies lacked "
                "formal RoB assessments and require human review."
            )
        n_synthetic = sum(
            1
            for r in relevant
            if getattr(r, "is_synthetic", False)
            or "not assessed" in (r.overall_judgment or "").lower()
            or "insufficient information" in (r.overall_judgment or "").lower()
        )
        if n_synthetic:
            if n_synthetic == n:
                rating = "very serious"
            else:
                rating = "serious"
            n_high = sum(1 for r in relevant if r.overall_judgment.lower().startswith("high"))
            n_some = sum(1 for r in relevant if "some" in r.overall_judgment.lower())
            n_low = sum(1 for r in relevant if "low" in r.overall_judgment.lower())
            n_unknown = n - n_high - n_some - n_low
            details = {
                "total_contributing": total_contributing or n,
                "n_assessed": n,
                "n_missing_assessment": max((total_contributing or n) - n, 0),
                "n_high": n_high,
                "n_some": n_some,
                "n_low": n_low,
                "n_unknown": max(n_unknown, 0),
                "n_not_formally_assessed": n_synthetic,
            }
            return GRADEDomain(
                domain="risk_of_bias",
                rating=rating,
                rationale=self._grade_rationale("risk_of_bias", rating, details),
                details=details,
            )

        n_high = sum(1 for r in relevant if r.overall_judgment.lower().startswith("high"))
        n_some = sum(1 for r in relevant if "some" in r.overall_judgment.lower())
        n_low = sum(1 for r in relevant if "low" in r.overall_judgment.lower())
        n_unknown = n - n_high - n_some - n_low  # non-standard judgments treated conservatively

        pct_high = n_high / n
        pct_some = n_some / n

        if pct_high > 0.50:
            rating = "very serious"
        elif pct_high > 0.30 or pct_some > 0.50:
            rating = "serious"
        else:
            rating = "no concern"
        if denominator_note and rating == "no concern":
            rating = "serious"

        details = {
            "total_contributing": total_contributing or n,
            "n_assessed": n,
            "n_missing_assessment": max((total_contributing or n) - n, 0),
            "n_high": n_high,
            "n_some": n_some,
            "n_low": n_low,
            "n_unknown": max(n_unknown, 0),
            "n_not_formally_assessed": 0,
        }

        return GRADEDomain(
            domain="risk_of_bias",
            rating=rating,
            rationale=self._grade_rationale("risk_of_bias", rating, details),
            details=details,
        )

    # ------------------------------------------------------------------
    # Domain 2: Inconsistency
    # ------------------------------------------------------------------

    def _assess_inconsistency(self, pooled: PooledEffect) -> GRADEDomain:
        """Deterministic inconsistency assessment based on heterogeneity stats.

        Criteria:
        - I-squared > 75% -> "very serious"
        - I-squared > 50% -> "serious"
        - Also upgrade concern if Q p-value < 0.10 or prediction interval
          crosses null.
        """
        i2 = pooled.i_squared
        q_p = pooled.q_p_value

        import math
        if math.isnan(i2) or math.isnan(q_p):
            details = {"n_studies": pooled.n_studies, "i_squared": None, "q_p_value": None, "tau_squared": pooled.tau_squared}
            return GRADEDomain(
                domain="inconsistency",
                rating="serious",
                rationale=self._grade_rationale("inconsistency", "serious", details),
                details=details,
            )

        if pooled.n_studies <= 1:
            details = {"n_studies": pooled.n_studies, "i_squared": i2, "q_p_value": q_p, "tau_squared": pooled.tau_squared}
            return GRADEDomain(
                domain="inconsistency",
                rating="no concern",
                rationale=self._grade_rationale("inconsistency", "no concern", details),
                details=details,
            )

        # Primary criterion: I-squared
        if i2 > 75:
            rating = "very serious"
        elif i2 > 50:
            rating = "serious"
        else:
            rating = "no concern"

        # Secondary: significant Q test can upgrade "no concern" to "serious"
        if rating == "no concern" and q_p < 0.10:
            rating = "serious"

        # Tertiary: prediction interval crossing null can upgrade, but not when
        # only two studies contribute; two-study prediction intervals are too
        # unstable to use as an inconsistency downgrade by themselves.
        prediction_interval_used_for_rating = pooled.n_studies >= 3
        if rating == "no concern" and pooled.prediction_interval is not None:
            pi_lo, pi_hi = pooled.prediction_interval
            ratio_measures = {"OR", "RR", "HR", "IRR"}
            null_val = 1.0 if pooled.effect_measure in ratio_measures else 0.0
            if prediction_interval_used_for_rating and pi_lo <= null_val <= pi_hi:
                rating = "serious"

        details = {
            "n_studies": pooled.n_studies,
            "i_squared": i2,
            "q_statistic": pooled.q_statistic,
            "q_p_value": q_p,
            "tau_squared": pooled.tau_squared,
            "prediction_interval": pooled.prediction_interval,
            "prediction_interval_used_for_rating": prediction_interval_used_for_rating,
        }

        return GRADEDomain(
            domain="inconsistency",
            rating=rating,
            rationale=self._grade_rationale("inconsistency", rating, details),
            details=details,
        )

    # ------------------------------------------------------------------
    # Domain 3: Indirectness (LLM-based)
    # ------------------------------------------------------------------

    def _assess_indirectness(
        self,
        studies: list[ExtractedStudy],
        protocol: ResearchProtocol,
        study_ids: set[str],
        outcome_name: str = "",
    ) -> GRADEDomain:
        """Indirectness assessment anchored by deterministic P/I/C/O mismatch rules."""
        target_outcome = outcome_name or protocol.pico.outcome_primary
        relevant_by_id: dict[str, ExtractedStudy] = {}
        for study in studies:
            contributing_id = self._contributing_study_id(study, study_ids)
            if not contributing_id:
                continue
            existing = relevant_by_id.get(contributing_id)
            if existing is None or self._directness_record_score(study, target_outcome) > self._directness_record_score(existing, target_outcome):
                relevant_by_id[contributing_id] = study
        relevant = list(relevant_by_id.values())
        rule_rating, rule_rationale, rule_details = self._rule_based_indirectness(
            relevant,
            protocol,
            outcome_name,
        )

        return GRADEDomain(
            domain="indirectness",
            rating=rule_rating,
            rationale=rule_rationale,
            details=rule_details,
        )

    @staticmethod
    def _contributing_study_id(study: ExtractedStudy, study_ids: set[str]) -> str:
        c = study.characteristics
        for candidate in (c.pmid, c.study_id):
            value = str(candidate or "").strip()
            if value and value in study_ids:
                return value
        return ""

    @classmethod
    def _directness_record_score(cls, study: ExtractedStudy, target_outcome: str) -> int:
        """Prefer the duplicate extracted record that best supports directness checks."""
        c = study.characteristics
        score = 0
        if cls._content_tokens(c.population_description):
            score += 1
        if cls._content_tokens(c.intervention_description):
            score += 1
        if cls._content_tokens(c.control_description):
            score += 1
        if cls._study_design_is_randomized(c.study_design) is not None:
            score += 1
        for outcome in study.outcomes:
            if getattr(outcome, "source_quote_verified", False) and str(getattr(outcome, "source_quote", "") or "").strip():
                score += 2
                if cls._pico_text_matches(target_outcome, outcome.outcome_name):
                    score += 4
                if getattr(outcome, "manual_adjudication", False):
                    score += 1
        return score

    def _rule_based_indirectness(
        self,
        relevant: list[ExtractedStudy],
        protocol: ResearchProtocol,
        outcome_name: str,
    ) -> tuple[str, str, dict]:
        """Quantify obvious P/I/C/O indirectness before any LLM rationale."""
        if not relevant:
            return (
                "serious",
                "No contributing study PICO data were available to verify directness.",
                {
                    "method": "rule_based_pico_directness_v1",
                    "n_contributing": 0,
                    "dimensions": {},
                    "source_verified_direct_rows": False,
                },
            )

        n = len(relevant)
        target_outcome = outcome_name or protocol.pico.outcome_primary
        population_mismatch = 0
        intervention_mismatch = 0
        comparator_mismatch = 0
        outcome_mismatch = 0
        non_rct = 0
        population_unverified = 0
        intervention_unverified = 0
        comparator_unverified = 0
        design_unverified = 0
        surrogate_outcome = self._looks_surrogate_outcome(target_outcome, protocol.pico.outcome_primary)
        source_verified_direct_rows = self._all_have_source_verified_primary_rows(relevant, target_outcome)
        source_verified_row_label = self._source_verified_row_label(target_outcome, protocol.pico.outcome_primary)

        for study in relevant:
            c = study.characteristics
            design_is_rct = self._study_design_is_randomized(c.study_design)
            if design_is_rct is False:
                non_rct += 1
            elif design_is_rct is None:
                design_unverified += 1

            if not self._content_tokens(c.population_description):
                population_unverified += 1
            elif not self._pico_text_matches(protocol.pico.population, c.population_description):
                population_mismatch += 1
            if not self._content_tokens(c.intervention_description):
                intervention_unverified += 1
            elif not self._pico_text_matches(protocol.pico.intervention, c.intervention_description):
                intervention_mismatch += 1
            if not self._content_tokens(c.control_description):
                comparator_unverified += 1
            elif not self._pico_text_matches(protocol.pico.comparator, c.control_description):
                comparator_mismatch += 1
            outcome_text = " ".join(outcome.outcome_name for outcome in study.outcomes)
            if target_outcome and outcome_text and not self._pico_text_matches(target_outcome, outcome_text):
                outcome_mismatch += 1

        serious_signals = []
        very_serious_signals = []
        direct_row_anchor = source_verified_direct_rows and not surrogate_outcome
        direct_row_anchor_signals = []
        if population_mismatch > 0:
            signal = f"population mismatch in {population_mismatch}/{n} contributing studies"
            if direct_row_anchor:
                direct_row_anchor_signals.append(f"population field in {population_mismatch}/{n} contributing studies")
            else:
                (very_serious_signals if population_mismatch > n / 2 else serious_signals).append(signal)
        if intervention_mismatch > 0:
            signal = f"intervention mismatch in {intervention_mismatch}/{n} contributing studies"
            if direct_row_anchor:
                direct_row_anchor_signals.append(f"intervention field in {intervention_mismatch}/{n} contributing studies")
            else:
                (very_serious_signals if intervention_mismatch > n / 2 else serious_signals).append(signal)
        if comparator_mismatch > 0:
            signal = f"comparator mismatch in {comparator_mismatch}/{n} contributing studies"
            if direct_row_anchor:
                direct_row_anchor_signals.append(f"comparator field in {comparator_mismatch}/{n} contributing studies")
            else:
                (very_serious_signals if comparator_mismatch > n / 2 else serious_signals).append(signal)
        if outcome_mismatch > 0:
            signal = f"outcome-name mismatch in {outcome_mismatch}/{n} contributing studies"
            if direct_row_anchor:
                direct_row_anchor_signals.append(f"outcome-name field in {outcome_mismatch}/{n} contributing studies")
            else:
                (very_serious_signals if outcome_mismatch > n / 2 else serious_signals).append(signal)
        if non_rct > n / 2:
            serious_signals.append(f"{non_rct}/{n} contributing studies are non-randomized designs")
        unverified_parts = []
        if population_unverified:
            unverified_parts.append(f"population unverified in {population_unverified}/{n}")
        if intervention_unverified:
            unverified_parts.append(f"intervention unverified in {intervention_unverified}/{n}")
        if comparator_unverified:
            unverified_parts.append(f"comparator unverified in {comparator_unverified}/{n}")
        if design_unverified:
            unverified_parts.append(f"design unverified in {design_unverified}/{n}")
        informational_signals = []
        if unverified_parts and source_verified_direct_rows:
            informational_signals.append(
                f"P/I/C/design fields were incomplete, but source-verified {source_verified_row_label} matched "
                f"the pooled outcome in {n}/{n} contributing studies; no indirectness downgrade was applied for missing metadata alone"
            )
        elif unverified_parts:
            serious_signals.append(
                "P/I/C/design directness could not be fully verified from extracted fields: "
                + "; ".join(unverified_parts)
            )
        if direct_row_anchor_signals:
            informational_signals.append(
                "Broad study-level P/I/C/O descriptions had metadata differences in "
                + "; ".join(direct_row_anchor_signals)
                + f", but source-verified {source_verified_row_label} were used as the directness anchor; "
                "no indirectness downgrade was applied for those study-level metadata differences"
            )
        if surrogate_outcome:
            serious_signals.append(
                f"pooled outcome '{target_outcome}' appears to be a surrogate for protocol outcome "
                f"'{protocol.pico.outcome_primary}'"
            )

        details = {
            "method": "rule_based_pico_directness_v1",
            "n_contributing": n,
            "target_outcome": target_outcome,
            "protocol_primary_outcome": protocol.pico.outcome_primary,
            "source_verified_direct_rows": source_verified_direct_rows,
            "source_verified_row_label": source_verified_row_label,
            "surrogate_outcome": surrogate_outcome,
            "signal_counts": {
                "informational": len(informational_signals),
                "serious": len(serious_signals),
                "very_serious": len(very_serious_signals),
            },
            "dimensions": {
                "population": {
                    "mismatch": population_mismatch,
                    "unverified": population_unverified,
                    "total": n,
                },
                "intervention": {
                    "mismatch": intervention_mismatch,
                    "unverified": intervention_unverified,
                    "total": n,
                },
                "comparator": {
                    "mismatch": comparator_mismatch,
                    "unverified": comparator_unverified,
                    "total": n,
                },
                "outcome": {
                    "mismatch": outcome_mismatch,
                    "unverified": 0,
                    "total": n,
                },
                "design": {
                    "non_randomized": non_rct,
                    "unverified": design_unverified,
                    "total": n,
                },
            },
        }

        if very_serious_signals:
            rating = "very serious"
        elif serious_signals:
            rating = "serious"
        else:
            rating = "no concern"

        rationale = self._grade_rationale("indirectness", rating, details)
        return rating, rationale, details

    @staticmethod
    def _more_serious_rating(first: str, second: str) -> str:
        order = {"no concern": 0, "serious": 1, "very serious": 2}
        return first if order.get(first, 0) >= order.get(second, 0) else second

    @staticmethod
    def _study_design_is_randomized(design: str) -> bool | None:
        d = (design or "").strip().lower()
        if not d:
            return None
        if re.search(r"\b(non[- ]?randomi[sz]ed|observational|cohort|case[- ]control|cross[- ]sectional)\b", d):
            return False
        if re.search(r"\b(rct|randomi[sz]ed|randomi[sz]ation|randomi[sz]ed controlled trial)\b", d):
            return True
        return None

    @classmethod
    def _pico_text_matches(cls, target: str, observed: str) -> bool:
        target_tokens = cls._content_tokens(target)
        if not target_tokens:
            return True
        observed_tokens = cls._content_tokens(observed)
        if not observed_tokens:
            return False
        target_low = (target or "").lower()
        observed_low = (observed or "").lower()
        critical_terms = {"critical", "critically", "icu", "intensive", "ventilated", "ventilation", "ards"}
        if target_tokens & critical_terms and not observed_tokens & critical_terms:
            return False
        overlap = target_tokens & observed_tokens
        if overlap:
            return True
        if "mortality" in target_tokens and "death" in observed_tokens:
            return True
        if "death" in target_tokens and "mortality" in observed_tokens:
            return True
        return target_low in observed_low or observed_low in target_low

    @classmethod
    def _all_have_source_verified_primary_rows(cls, studies: list[ExtractedStudy], target_outcome: str) -> bool:
        if not studies:
            return False
        for study in studies:
            matched = False
            for outcome in study.outcomes:
                if not getattr(outcome, "source_quote_verified", False):
                    continue
                if not str(getattr(outcome, "source_quote", "") or "").strip():
                    continue
                if cls._pico_text_matches(target_outcome, outcome.outcome_name):
                    matched = True
                    break
            if not matched:
                return False
        return True

    @staticmethod
    def _content_tokens(text: str) -> set[str]:
        stopwords = {
            "a", "an", "and", "are", "as", "for", "in", "of",
            "or", "patients", "patient", "the", "to", "with", "without",
        }
        tokens = {
            token
            for token in re.findall(r"[a-z0-9]+", (text or "").lower())
            if len(token) > 2 and token not in stopwords
        }
        synonyms = {"deaths": "death", "died": "death", "randomised": "randomized"}
        return {synonyms.get(token, token) for token in tokens}

    @classmethod
    def _looks_surrogate_outcome(cls, outcome_name: str, protocol_primary: str) -> bool:
        outcome_tokens = cls._content_tokens(outcome_name)
        primary_tokens = cls._content_tokens(protocol_primary)
        if not outcome_tokens or outcome_tokens & primary_tokens:
            return False
        surrogate_markers = {
            "biomarker", "laboratory", "marker", "score", "scale", "viral",
            "load", "imaging", "radiographic", "ct", "surrogate",
        }
        return bool(outcome_tokens & surrogate_markers)

    @classmethod
    def _source_verified_row_label(cls, outcome_name: str, protocol_primary: str) -> str:
        if cls._primary_outcome_label_matches(protocol_primary, outcome_name):
            return "primary outcome rows"
        return "outcome rows"

    @classmethod
    def _primary_outcome_label_matches(cls, primary: str, observed: str) -> bool:
        primary_low = (primary or "").strip().lower()
        observed_low = (observed or "").strip().lower()
        if not primary_low or not observed_low:
            return False
        if primary_low == observed_low or primary_low in observed_low or observed_low in primary_low:
            return True

        primary_tokens = cls._content_tokens(primary_low) - {"after", "before", "during", "treatment", "initiation", "related"}
        observed_tokens = cls._content_tokens(observed_low) - {"after", "before", "during", "treatment", "initiation", "related"}
        if not primary_tokens or not observed_tokens:
            return False

        overlap = primary_tokens & observed_tokens
        if "mortality" in primary_tokens and "death" in observed_tokens:
            overlap.add("mortality")
        if "death" in primary_tokens and "mortality" in observed_tokens:
            overlap.add("death")

        return len(overlap) >= 2 and len(overlap) / min(len(primary_tokens), len(observed_tokens)) >= 0.5

    # ------------------------------------------------------------------
    # Domain 4: Imprecision
    # ------------------------------------------------------------------

    def _assess_imprecision(
        self,
        pooled: PooledEffect,
        studies: list[ExtractedStudy] | None = None,
        study_ids: set[str] | None = None,
        outcome_name: str = "",
    ) -> GRADEDomain:
        """Deterministic imprecision assessment anchored to extracted sample sizes."""
        n_studies = pooled.n_studies
        total_n, matched_count = self._participant_total_from_extracted_studies(
            studies or [],
            study_ids or {s.study_id for s in pooled.studies},
            outcome_name or pooled.outcome_name,
        )
        total_source = "selected_pooled_rows"
        if total_n <= 0:
            total_source = "variance proxy"
            total_n = 0
            for s in pooled.studies:
                if s.vi > 0:
                    estimated_n = max(20, min(10000, 4.0 / s.vi))
                    total_n += estimated_n
                else:
                    total_n += 100
            total_n = int(total_n)

        ratio_measures = {"OR", "RR", "HR", "IRR"}
        is_ratio = pooled.effect_measure in ratio_measures
        ci_lower = pooled.ci_lower
        ci_upper = pooled.ci_upper
        null_value = 1.0 if is_ratio else 0.0
        crosses_null = ci_lower <= null_value <= ci_upper
        if is_ratio and ci_lower > 0 and ci_upper > 0:
            ci_width = math.log(ci_upper) - math.log(ci_lower)
        else:
            ci_width = ci_upper - ci_lower

        ratio_measures_ois = {"OR", "RR", "HR", "IRR"}
        if pooled.effect_measure in ratio_measures_ois:
            ois = 600
        elif pooled.effect_measure in {"SMD"}:
            ois = 800
        elif pooled.effect_measure in {"PROP"}:
            ois = 400
        else:
            ois = 800

        concerns = 0
        if total_n < ois:
            concerns += 1
        if crosses_null:
            concerns += 1
        if n_studies < 3 and ci_width > (1.0 if is_ratio else 0.5):
            concerns += 1

        if concerns >= 2:
            rating = "very serious"
        elif concerns >= 1:
            rating = "serious"
        else:
            rating = "no concern"

        details = {
            "n_studies": n_studies,
            "total_n": int(total_n),
            "matched_count": int(matched_count),
            "total_source": total_source,
            "ois": int(ois),
            "ci_width": float(ci_width),
            "crosses_null": bool(crosses_null),
            "effect_measure": pooled.effect_measure,
            "ci_lower": ci_lower,
            "ci_upper": ci_upper,
        }
        return GRADEDomain(
            domain="imprecision",
            rating=rating,
            rationale=self._grade_rationale("imprecision", rating, details),
            details=details,
        )

    @classmethod
    def _participant_total_from_extracted_studies(
        cls,
        studies: list[ExtractedStudy],
        study_ids: set[str],
        outcome_name: str,
    ) -> tuple[int, int]:
        """Return source-count participant totals for the pooled outcome."""
        if not studies or not study_ids:
            return 0, 0
        total = 0
        matched = 0
        target = cls._normalize_outcome_name(outcome_name)
        by_id: dict[str, ExtractedStudy] = {}
        for study in studies:
            contributing_id = cls._contributing_study_id(study, study_ids)
            if not contributing_id:
                continue
            existing = by_id.get(contributing_id)
            if existing is None or cls._participant_total_record_score(study, target) > cls._participant_total_record_score(existing, target):
                by_id[contributing_id] = study

        for study in by_id.values():
            row_total = 0
            best_score = -1
            for outcome in getattr(study, "outcomes", []) or []:
                candidate = cls._normalize_outcome_name(getattr(outcome, "outcome_name", ""))
                if target and not cls._outcome_names_compatible(target, candidate):
                    continue
                candidate_total = cls._outcome_participant_total(outcome)
                if candidate_total <= 0:
                    continue
                score = cls._participant_total_outcome_score(outcome, target, candidate)
                if score > best_score:
                    row_total = candidate_total
                    best_score = score
            if row_total > 0:
                total += row_total
                matched += 1
        return total, matched

    @classmethod
    def _participant_total_record_score(cls, study: ExtractedStudy, target: str) -> int:
        best = -1
        for outcome in getattr(study, "outcomes", []) or []:
            candidate = cls._normalize_outcome_name(getattr(outcome, "outcome_name", ""))
            if target and not cls._outcome_names_compatible(target, candidate):
                continue
            if cls._outcome_participant_total(outcome) <= 0:
                continue
            best = max(best, cls._participant_total_outcome_score(outcome, target, candidate))
        return best

    @classmethod
    def _participant_total_outcome_score(cls, outcome, target: str, candidate: str) -> int:
        score = 0
        if target and candidate == target:
            score += 4
        elif target and cls._outcome_names_compatible(target, candidate):
            score += 1
        accepted = cls._normalize_outcome_name(getattr(outcome, "accepted_timepoint", "") or "")
        if target and accepted and cls._outcome_names_compatible(target, accepted):
            score += 4
        if getattr(outcome, "source_quote_verified", False):
            score += 2
        if getattr(outcome, "manual_adjudication", False):
            score += 6
        return score

    @staticmethod
    def _study_identity_values(study: ExtractedStudy) -> set[str]:
        characteristics = getattr(study, "characteristics", None)
        values = set()
        for attr in ("study_id", "pmid", "doi"):
            value = str(getattr(characteristics, attr, "") or "").strip()
            if value:
                values.add(value)
        return values

    @staticmethod
    def _normalize_outcome_name(value: str) -> str:
        return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()

    @staticmethod
    def _outcome_names_compatible(target: str, candidate: str) -> bool:
        if not target or not candidate:
            return True
        return target == candidate or target in candidate or candidate in target

    @staticmethod
    def _outcome_participant_total(outcome) -> int:
        for left, right in (("total_intervention", "total_control"), ("n_intervention", "n_control")):
            a = getattr(outcome, left, None)
            b = getattr(outcome, right, None)
            if a is not None and b is not None:
                try:
                    return int(a) + int(b)
                except (TypeError, ValueError):
                    return 0
        total_n = getattr(outcome, "total_n", None)
        if total_n is not None:
            try:
                return int(total_n)
            except (TypeError, ValueError):
                return 0
        return 0

    # ------------------------------------------------------------------
    # Domain 5: Publication bias
    # ------------------------------------------------------------------

    def _assess_publication_bias(
        self, pub_bias: PublicationBiasResult | None, pooled: PooledEffect
    ) -> GRADEDomain:
        """Deterministic publication bias assessment.

        Criteria:
        - Egger p < 0.1 OR Begg p < 0.1 -> "serious"
        - Trim-and-fill changes the conclusion (effect direction or significance) -> "very serious"
        - One or two studies -> "serious" because small-study effects/non-publication cannot be assessed meaningfully
        - Three to nine studies -> note but no automatic downgrade
        """
        if pooled.n_studies < 3:
            details = {"n_studies": pooled.n_studies, "reason": "too_few_studies_for_publication_bias_assessment"}
            return GRADEDomain(
                domain="publication_bias",
                rating="serious",
                rationale=self._grade_rationale("publication_bias", "serious", details),
                details=details,
            )
        if pooled.n_studies < 10:
            details = {"n_studies": pooled.n_studies, "reason": "too_few_studies_for_small_study_effect_tests"}
            return GRADEDomain(
                domain="publication_bias",
                rating="no concern",
                rationale=self._grade_rationale("publication_bias", "no concern", details),
                details=details,
            )
        if pub_bias is None:
            details = {"n_studies": pooled.n_studies, "reason": "tests_not_performed"}
            return GRADEDomain(
                domain="publication_bias",
                rating="no concern",
                rationale=self._grade_rationale("publication_bias", "no concern", details),
                details=details,
            )

        rating = "no concern"
        signals: list[str] = []

        # Egger's test
        if pub_bias.egger_p_value is not None and not math.isnan(pub_bias.egger_p_value):
            if pub_bias.egger_p_value < 0.10:
                rating = "serious"
                signals.append(f"Egger's test significant (p={pub_bias.egger_p_value:.4f})")

        # Begg's test
        if pub_bias.begg_p_value is not None and not math.isnan(pub_bias.begg_p_value):
            if pub_bias.begg_p_value < 0.10:
                if rating == "no concern":
                    rating = "serious"
                signals.append(f"Begg's test significant (p={pub_bias.begg_p_value:.4f})")

        # Trim-and-fill: check if adjusted effect changes conclusion
        if pub_bias.trim_fill_adjusted_effect is not None and pub_bias.trim_fill_missing:
            if pub_bias.trim_fill_missing > 0:
                p_val = pooled.p_value
                original_significant = p_val is not None and math.isfinite(p_val) and p_val < 0.05
                # Check if adjusted CI crosses null
                ratio_measures = {"OR", "RR", "HR", "IRR"}
                null_val = 1.0 if pooled.effect_measure in ratio_measures else 0.0
                adj_lo = pub_bias.trim_fill_adjusted_ci_lower
                adj_hi = pub_bias.trim_fill_adjusted_ci_upper
                adjusted_crosses_null = (
                    adj_lo is not None and adj_hi is not None
                    and adj_lo <= null_val <= adj_hi
                )
                conclusion_changed = original_significant and adjusted_crosses_null

                if conclusion_changed:
                    rating = "very serious"
                    signals.append(
                        f"Trim-and-fill imputed {pub_bias.trim_fill_missing} studies; "
                        f"adjusted effect changes conclusion."
                    )
                elif pub_bias.trim_fill_missing > 0:
                    signals.append(
                        f"Trim-and-fill imputed {pub_bias.trim_fill_missing} studies."
                    )

        details = {
            "n_studies": pooled.n_studies,
            "egger_p_value": pub_bias.egger_p_value,
            "begg_p_value": pub_bias.begg_p_value,
            "trim_fill_missing": pub_bias.trim_fill_missing,
            "trim_fill_adjusted_effect": pub_bias.trim_fill_adjusted_effect,
            "signals": signals,
        }

        return GRADEDomain(
            domain="publication_bias",
            rating=rating,
            rationale=self._grade_rationale("publication_bias", rating, details),
            details=details,
        )

    # ------------------------------------------------------------------
    # Certainty computation
    # ------------------------------------------------------------------

    def _compute_certainty(self, domains: list[GRADEDomain], initial_level: int) -> str:
        """Compute overall certainty of evidence.

        Parameters
        ----------
        domains : list[GRADEDomain]
            Assessed GRADE domains.
        initial_level : int
            Starting certainty: 4 for RCTs (High), 2 for observational (Low).

        Returns
        -------
        str
            One of "High", "Moderate", "Low", "Very low".
        """
        score = initial_level
        for d in domains:
            if d.rating == "serious":
                score -= 1
            elif d.rating == "very serious":
                score -= 2

        # Clamp to valid range
        score = max(0, min(4, score))
        return _CERTAINTY_LEVELS.get(score, "Very low")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _initial_certainty(self, studies: list[ExtractedStudy], study_ids: set[str]) -> int:
        """Determine initial certainty level based on study designs.

        RCTs start at 4 (High), observational at 2 (Low).
        Mixed designs use the lower starting point.
        """
        rct_keywords = {"rct", "randomized", "randomised", "randomized controlled trial"}
        has_rct = False
        has_obs = False

        for s in studies:
            sid = s.characteristics.pmid or s.characteristics.study_id
            if sid not in study_ids:
                continue
            design_is_rct = self._study_design_is_randomized(s.characteristics.study_design)
            if design_is_rct is True:
                has_rct = True
            elif design_is_rct is False:
                has_obs = True

        if has_obs and not has_rct:
            return 2  # Low
        if has_rct and not has_obs:
            return 4  # High
        if has_rct and has_obs:
            return 2  # Mixed -> use lower starting point
        # Default to High (RCT assumption) if no design info
        return 4

    @staticmethod
    def _format_effect(pooled: PooledEffect) -> str:
        """Format a pooled effect as a human-readable string."""
        import math
        pe = pooled.pooled_effect
        if not math.isfinite(pe):
            return f"{pooled.effect_measure}: effect estimate unavailable"
        ci_lo = pooled.ci_lower
        ci_hi = pooled.ci_upper
        if not math.isfinite(ci_lo) or not math.isfinite(ci_hi):
            return f"{pooled.effect_measure} {pe:.2f} (95% CI: unavailable)"
        return (
            f"{pooled.effect_measure} {pe:.2f} "
            f"(95% CI: {ci_lo:.2f} to {ci_hi:.2f})"
        )

    @staticmethod
    def _extract_json(text: str) -> str:
        """Extract JSON from LLM response that may contain markdown fences."""
        text = text.strip()
        if text.startswith("```"):
            # Remove markdown code fences
            lines = text.split("\n")
            # Drop first line (```json or ```) and last line (```)
            start = 1
            end = len(lines) - 1 if lines[-1].strip() == "```" else len(lines)
            text = "\n".join(lines[start:end]).strip()
        return text
