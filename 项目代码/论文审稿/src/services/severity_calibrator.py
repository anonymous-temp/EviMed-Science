"""
Severity Calibrator Service - Calibrate severity levels based on rules and context

This service implements severity calibration for the Plan-Retrieve-Argue architecture:
1. Rule-based severity determination (CRITICAL/MAJOR/MINOR)
2. Prior adjustments (e.g., high-tier journal → lower false positive tolerance)
3. Context-aware calibration based on study type
"""

from typing import Dict, List, Optional
from enum import Enum

from ..schemas.rubric import SeverityLevel
from ..schemas.plan_retrieve_argue import SeverityCalibrationResult


class SeverityPrior(str, Enum):
    """Priors that can adjust severity levels"""
    HIGH_TIER_JOURNAL = "high_tier_journal"
    LOW_TIER_JOURNAL = "low_tier_journal"
    CLINICAL_TRIAL = "clinical_trial"
    EXPLORATORY_STUDY = "exploratory_study"
    REPLICATION_STUDY = "replication_study"


class SeverityCalibratorService:
    """
    Service for calibrating severity levels of findings.

    Provides rule-based severity determination and prior adjustments
    to reduce false positives and improve calibration accuracy.
    """

    # Severity rules based on finding type
    SEVERITY_RULES = {
        # CRITICAL: Fatal flaws that invalidate study
        "CRITICAL": [
            "missing_ethics_approval",
            "fabricated_data_indicator",
            "invalid_randomization",
            "fundamental_statistical_error",
            "undisclosed_conflict_of_interest",
            "missing_primary_outcome_definition",
            "no_sample_size_justification",
            "missing_protocol_registration",
        ],
        # MAJOR: Significant concerns affecting interpretation
        "MAJOR": [
            "incomplete_randomization_description",
            "inadequate_blinding",
            "missing_power_calculation",
            "unclear_inclusion_exclusion",
            "incomplete_outcome_reporting",
            "missing_confidence_intervals",
            "unclear_statistical_methods",
            "missing_adverse_events",
            "incomplete_flow_diagram",
        ],
        # MINOR: Issues that should be addressed but don't affect validity
        "MINOR": [
            "missing_trial_registration_number",
            "unclear_funding_disclosure",
            "incomplete_author_contributions",
            "missing_data_availability_statement",
            "formatting_inconsistencies",
            "incomplete_references",
        ],
    }

    # Prior adjustments: negative = downgrade, positive = upgrade
    PRIOR_ADJUSTMENTS = {
        SeverityPrior.HIGH_TIER_JOURNAL: {
            # High-tier journals: be more strict
            "MINOR_to_MAJOR": ["incomplete_outcome_reporting", "missing_confidence_intervals"],
            "MAJOR_to_CRITICAL": ["missing_power_calculation", "invalid_randomization"],
        },
        SeverityPrior.LOW_TIER_JOURNAL: {
            # Low-tier journals: be more lenient
            "CRITICAL_to_MAJOR": ["missing_protocol_registration"],
            "MAJOR_to_MINOR": ["missing_trial_registration_number"],
        },
        SeverityPrior.CLINICAL_TRIAL: {
            # Clinical trials: be very strict on safety
            "MAJOR_to_CRITICAL": ["missing_adverse_events", "incomplete_flow_diagram"],
        },
        SeverityPrior.EXPLORATORY_STUDY: {
            # Exploratory studies: be more lenient on power
            "CRITICAL_to_MAJOR": ["no_sample_size_justification"],
            "MAJOR_to_MINOR": ["missing_power_calculation"],
        },
    }

    # Study type to finding category mapping
    STUDY_TYPE_WEIGHTS = {
        "RCT": {
            "randomization": 1.5,  # More important for RCTs
            "blinding": 1.5,
            "sample_size": 1.2,
        },
        "Meta-Analysis": {
            "search_strategy": 1.5,
            "publication_bias": 1.5,
            "heterogeneity": 1.3,
        },
        "Cohort Study": {
            "confounding": 1.5,
            "follow_up": 1.3,
        },
        "Diagnostic Study": {
            "reference_standard": 1.5,
            "spectrum_bias": 1.3,
        },
    }

    def __init__(self):
        self._build_finding_to_severity_map()

    def _build_finding_to_severity_map(self):
        """Build reverse lookup from finding type to severity"""
        self.finding_to_severity = {}
        for severity, findings in self.SEVERITY_RULES.items():
            for finding in findings:
                self.finding_to_severity[finding] = severity

    def calibrate(
        self,
        finding_type: str,
        original_severity: SeverityLevel,
        study_types: List[str],
        priors: Optional[List[SeverityPrior]] = None,
        confidence: float = 1.0
    ) -> SeverityCalibrationResult:
        """
        Calibrate severity level for a finding.

        Args:
            finding_type: Type of finding (e.g., "missing_randomization_description")
            original_severity: Original severity from LLM
            study_types: List of study types
            priors: List of priors to apply
            confidence: Confidence in the original finding (0-1)

        Returns:
            SeverityCalibrationResult with calibrated severity
        """
        priors = priors or []

        # Step 1: Determine rule-based severity
        rule_severity = self._get_rule_based_severity(finding_type)

        # Step 2: Apply study type weights
        weighted_severity = self._apply_study_type_weights(
            rule_severity or original_severity.value,
            finding_type,
            study_types
        )

        # Step 3: Apply priors
        final_severity, adjustment_reason = self._apply_priors(
            weighted_severity,
            finding_type,
            priors
        )

        # Step 4: Apply confidence adjustment
        if confidence < 0.5:
            # Low confidence findings should be downgraded
            final_severity = self._downgrade_severity(final_severity)
            adjustment_reason = f"{adjustment_reason or ''} [Low confidence: downgraded]"

        # Build result
        calibrated_level = SeverityLevel[final_severity] if final_severity in ["CRITICAL", "MAJOR", "MINOR", "NONE"] else original_severity
        was_calibrated = calibrated_level != original_severity

        return SeverityCalibrationResult(
            original_severity=original_severity.value,
            calibrated_severity=final_severity,
            was_calibrated=was_calibrated,
            calibration_reason=adjustment_reason if was_calibrated else None,
            prior_applied=priors[0].value if priors else None,
            confidence_in_calibration=confidence
        )

    def _get_rule_based_severity(self, finding_type: str) -> Optional[str]:
        """Get rule-based severity for a finding type"""
        # Normalize finding type
        normalized = finding_type.lower().replace(" ", "_").replace("-", "_")

        # Direct lookup
        if normalized in self.finding_to_severity:
            return self.finding_to_severity[normalized]

        # Fuzzy match
        for severity, findings in self.SEVERITY_RULES.items():
            for finding in findings:
                if finding in normalized or normalized in finding:
                    return severity

        return None

    def _apply_study_type_weights(
        self,
        severity: str,
        finding_type: str,
        study_types: List[str]
    ) -> str:
        """Apply study type weights to adjust severity"""
        normalized_finding = finding_type.lower()

        for study_type in study_types:
            if study_type in self.STUDY_TYPE_WEIGHTS:
                weights = self.STUDY_TYPE_WEIGHTS[study_type]
                for category, weight in weights.items():
                    if category in normalized_finding:
                        if weight >= 1.5 and severity == "MAJOR":
                            return "CRITICAL"
                        elif weight >= 1.3 and severity == "MINOR":
                            return "MAJOR"

        return severity

    def _apply_priors(
        self,
        severity: str,
        finding_type: str,
        priors: List[SeverityPrior]
    ) -> tuple[str, Optional[str]]:
        """Apply priors to adjust severity"""
        normalized_finding = finding_type.lower().replace(" ", "_")

        for prior in priors:
            if prior in self.PRIOR_ADJUSTMENTS:
                adjustments = self.PRIOR_ADJUSTMENTS[prior]

                # Check for upgrades
                upgrade_key = f"{severity}_to_CRITICAL" if severity != "CRITICAL" else None
                if upgrade_key and upgrade_key in adjustments:
                    if normalized_finding in adjustments[upgrade_key]:
                        return "CRITICAL", f"Upgraded due to {prior.value}"

                # Check for downgrades
                downgrade_key = f"{severity}_to_MAJOR" if severity == "CRITICAL" else (f"{severity}_to_MINOR" if severity == "MAJOR" else None)
                if downgrade_key and downgrade_key in adjustments:
                    if normalized_finding in adjustments[downgrade_key]:
                        new_severity = downgrade_key.split("_to_")[1]
                        return new_severity, f"Downgraded due to {prior.value}"

        return severity, None

    def _downgrade_severity(self, severity: str) -> str:
        """Downgrade severity by one level"""
        if severity == "CRITICAL":
            return "MAJOR"
        elif severity == "MAJOR":
            return "MINOR"
        elif severity == "MINOR":
            return "NONE"
        return severity

    def calibrate_batch(
        self,
        findings: List[Dict],
        study_types: List[str],
        priors: Optional[List[SeverityPrior]] = None
    ) -> List[SeverityCalibrationResult]:
        """
        Calibrate severity for multiple findings.

        Args:
            findings: List of dicts with finding_type, original_severity, confidence
            study_types: List of study types
            priors: List of priors to apply

        Returns:
            List of SeverityCalibrationResult
        """
        results = []

        for finding in findings:
            result = self.calibrate(
                finding_type=finding.get("finding_type", "unknown"),
                original_severity=finding.get("original_severity", SeverityLevel.MAJOR),
                study_types=study_types,
                priors=priors,
                confidence=finding.get("confidence", 1.0)
            )
            results.append(result)

        return results

    def get_severity_distribution(
        self,
        calibration_results: List[SeverityCalibrationResult]
    ) -> Dict[str, int]:
        """Get distribution of calibrated severities"""
        distribution = {
            "CRITICAL": 0,
            "MAJOR": 0,
            "MINOR": 0,
            "NONE": 0,
        }

        for result in calibration_results:
            severity = result.calibrated_severity
            if severity in distribution:
                distribution[severity] += 1

        return distribution

    def generate_calibration_report(
        self,
        calibration_results: List[SeverityCalibrationResult]
    ) -> str:
        """Generate a human-readable calibration report"""
        total = len(calibration_results)
        calibrated = sum(1 for r in calibration_results if r.was_calibrated)
        distribution = self.get_severity_distribution(calibration_results)

        report = f"""
## Severity Calibration Report

**Total Findings:** {total}
**Calibrated:** {calibrated} ({100*calibrated/total:.1f}%)

### Severity Distribution (After Calibration)
- CRITICAL: {distribution['CRITICAL']}
- MAJOR: {distribution['MAJOR']}
- MINOR: {distribution['MINOR']}
- NONE: {distribution['NONE']}

### Calibration Details
"""

        for result in calibration_results:
            if result.was_calibrated:
                report += f"- {result.original_severity} → {result.calibrated_severity}: {result.calibration_reason}\n"

        return report
