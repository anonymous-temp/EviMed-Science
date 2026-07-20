"""EviMed drug safety analysis agent (pharmacovigilance specialist).

Layout:
    core       configuration, logging, exceptions, two-level cache
    openfda    async openFDA client (drug/event.json, drug/label.json)
    normalize  drug-name and ADR-term normalization
    signals    deterministic disproportionality statistics (ROR/PRR/chi2/IC/EBGM)

All numbers in this package come from deterministic code paths; no LLM is
involved in any calculation.
"""

__version__ = "0.3.0"
