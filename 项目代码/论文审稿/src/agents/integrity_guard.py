"""
Integrity & Ethics Guard - Security and basic ethics compliance checks
"""
import re
from typing import List
from datetime import datetime

from ..schemas.review_state import SecurityAlert, SecurityAlertType


class IntegrityEthicsGuard:
    """
    Lightweight agent for security and basic ethics checking.
    Runs BEFORE core review process to detect malicious content and basic compliance issues.

    Design: Rules-based with optional LLM assistance for edge cases.
    """

    def __init__(self):
        # Known prompt injection patterns
        self.injection_patterns = [
            r"ignore\s+(all\s+)?previous\s+instructions?",
            r"disregard\s+(all\s+)?previous\s+instructions?",
            r"forget\s+(all\s+)?previous\s+instructions?",
            r"system\s*:\s*you\s+are",
            r"<\|im_start\|>",
            r"<\|im_end\|>",
            r"\\n\\nHuman:",
            r"\\n\\nAssistant:",
        ]

        # Zero-width and invisible characters
        self.invisible_chars = [
            '\u200B',  # Zero-width space
            '\u200C',  # Zero-width non-joiner
            '\u200D',  # Zero-width joiner
            '\uFEFF',  # Zero-width no-break space
            '\u2060',  # Word joiner
        ]

        # Required ethics keywords
        self.ethics_keywords = [
            "ethics committee",
            "ethical committee",
            "ethics approval",
            "ethical approval",
            "IRB",
            "institutional review board",
            "research ethics board",
            "informed consent",
            "written consent",
            "ethics commission"
        ]

    async def check(self, manuscript_text: str) -> List[SecurityAlert]:
        """
        Perform all security and basic ethics checks.

        Args:
            manuscript_text: Raw manuscript text

        Returns:
            List of SecurityAlerts (empty if no issues found)
        """
        alerts: List[SecurityAlert] = []

        # 1. Check for prompt injection attacks
        injection_alerts = self._check_prompt_injection(manuscript_text)
        alerts.extend(injection_alerts)

        # 2. Check for invisible/hidden text
        invisible_alerts = self._check_invisible_text(manuscript_text)
        alerts.extend(invisible_alerts)

        # 3. Check for basic ethics compliance
        ethics_alerts = self._check_ethics_compliance(manuscript_text)
        alerts.extend(ethics_alerts)

        return alerts

    def _check_prompt_injection(self, text: str) -> List[SecurityAlert]:
        """Detect known prompt injection patterns"""
        alerts = []
        text_lower = text.lower()

        for pattern in self.injection_patterns:
            matches = re.finditer(pattern, text_lower, re.IGNORECASE)
            for match in matches:
                # Extract context around the match
                start = max(0, match.start() - 50)
                end = min(len(text), match.end() + 50)
                context = text[start:end]

                alerts.append(SecurityAlert(
                    alert_type=SecurityAlertType.PROMPT_INJECTION,
                    severity="CRITICAL",
                    evidence=f"Potential prompt injection detected: '{match.group()}' in context: '{context}'",
                    location=f"character_position_{match.start()}"
                ))

        return alerts

    def _check_invisible_text(self, text: str) -> List[SecurityAlert]:
        """Detect invisible/zero-width characters"""
        alerts = []

        for char in self.invisible_chars:
            if char in text:
                count = text.count(char)
                char_name = f"U+{ord(char):04X}"

                alerts.append(SecurityAlert(
                    alert_type=SecurityAlertType.INVISIBLE_TEXT,
                    severity="WARNING",
                    evidence=f"Found {count} occurrences of invisible character {char_name}",
                    location="manuscript_text"
                ))

        return alerts

    def _check_ethics_compliance(self, text: str) -> List[SecurityAlert]:
        """Check for basic ethics compliance keywords"""
        alerts = []
        text_lower = text.lower()

        # Check if this appears to be a human subjects study
        human_study_indicators = [
            "patient", "participant", "subject", "volunteer",
            "trial", "clinical study", "human"
        ]

        is_human_study = any(indicator in text_lower for indicator in human_study_indicators)

        if is_human_study:
            # Check for ethics keywords
            has_ethics_mention = any(keyword in text_lower for keyword in self.ethics_keywords)

            if not has_ethics_mention:
                alerts.append(SecurityAlert(
                    alert_type=SecurityAlertType.ETHICS_MISSING,
                    severity="WARNING",
                    evidence="This appears to be a human subjects study, but no mention of ethics committee approval or informed consent was found.",
                    location="methods_section"
                ))

        return alerts

    def has_critical_alerts(self, alerts: List[SecurityAlert]) -> bool:
        """Check if any alerts are critical severity"""
        return any(alert.severity == "CRITICAL" for alert in alerts)

    def get_summary(self, alerts: List[SecurityAlert]) -> str:
        """Generate human-readable summary of alerts"""
        if not alerts:
            return "No security or ethics concerns detected."

        critical = [a for a in alerts if a.severity == "CRITICAL"]
        warnings = [a for a in alerts if a.severity == "WARNING"]

        summary_parts = []

        if critical:
            summary_parts.append(f"**CRITICAL ALERTS: {len(critical)}**")
            for alert in critical:
                summary_parts.append(f"- {alert.alert_type}: {alert.evidence[:100]}")

        if warnings:
            summary_parts.append(f"**WARNINGS: {len(warnings)}**")
            for alert in warnings:
                summary_parts.append(f"- {alert.alert_type}: {alert.evidence[:100]}")

        return "\n".join(summary_parts)
