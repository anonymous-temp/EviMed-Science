"""Evidence cross-checks: FDA label sections + EviMed evidence retrieval."""

from .evimed import EviMedEvidenceClient
from .label_check import LabelCheckReport, LabelCheckResult, LabelQuote, check_label_coverage
from .models import EvidenceItem, EvidenceLayerResult

__all__ = [
    "EvidenceItem",
    "EvidenceLayerResult",
    "EviMedEvidenceClient",
    "LabelCheckReport",
    "LabelCheckResult",
    "LabelQuote",
    "check_label_coverage",
]
