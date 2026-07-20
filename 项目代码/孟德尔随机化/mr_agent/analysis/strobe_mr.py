# [IN] paper sections, llm/client.py
# [OUT] STROBE-MR compliance report
# [POS] mr_agent/analysis/strobe_mr.py - STROBE-MR checklist compliance
"""STROBE-MR compliance checker for MR study papers."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from mr_agent.llm.client import LLMClient
from mr_agent.llm.prompts import SYSTEM_MR_SCIENTIST

logger = logging.getLogger(__name__)

STROBE_MR_ITEMS = {
    "1a": "Indicate MR as the study's design in the title or abstract",
    "1b": "Provide an informative and balanced summary",
    "2": "Explain the scientific background and rationale",
    "3": "State specific objectives, including pre-specified hypotheses",
    "4": "Present key elements of study design early in the paper",
    "5": "Describe the setting, locations, and relevant dates",
    "6a": "Define all exposures, outcomes, and effect modifiers",
    "6b": "Report the assumptions of the MR design",
    "7": "Describe instrument selection and validation criteria",
    "8": "Describe data sources for each variable",
    "9": "Explain how quantitative variables were handled",
    "10": "Describe all statistical methods used",
    "11": "Address how missing data were handled",
    "12a": "Report numbers of IVs at each stage of selection",
    "12b": "Report summary data of IVs used",
    "13a": "Give unadjusted estimates and adjusted estimates",
    "13b": "Report category boundaries when continuous variables were categorized",
    "14": "Report results of all sensitivity analyses",
    "15": "Report the magnitude and direction of any potential bias",
    "16": "Summarize key results with reference to objectives",
    "17": "Discuss limitations including potential biases",
    "18": "Give a cautious interpretation of results",
    "19": "Discuss generalizability of findings",
    "20": "State the source of funding and role of funders",
    "21": "Report MR-specific sensitivity analyses (Egger, PRESSO, etc.)",
}


@dataclass
class StrobeItem:
    """A single STROBE-MR checklist item evaluation."""
    item_id: str
    description: str
    addressed: bool = False
    location: str = ""
    comment: str = ""


@dataclass
class StrobeReport:
    """Complete STROBE-MR compliance report."""
    items: list[StrobeItem] = field(default_factory=list)
    total_items: int = 0
    addressed_count: int = 0
    compliance_pct: float = 0.0
    suggestions: list[str] = field(default_factory=list)


def check_strobe_compliance(
    paper_sections: dict[str, str],
    llm: LLMClient,
) -> StrobeReport:
    """Evaluate paper against STROBE-MR checklist using LLM."""
    report = StrobeReport()
    report.total_items = len(STROBE_MR_ITEMS)
    sections_text = _prepare_sections_text(paper_sections)
    evaluated = _evaluate_items(sections_text, llm)
    report.items = evaluated
    report.addressed_count = sum(1 for item in evaluated if item.addressed)
    if report.total_items > 0:
        report.compliance_pct = report.addressed_count / report.total_items * 100
    report.suggestions = _generate_suggestions(evaluated)
    return report


def _prepare_sections_text(paper_sections: dict[str, str]) -> str:
    """Prepare paper sections text for LLM evaluation."""
    parts = []
    for key in ["abstract", "introduction", "methods", "results",
                 "discussion", "limitations", "conclusion"]:
        text = paper_sections.get(key, "")
        if text:
            parts.append(f"## {key.upper()}\n{text[:1000]}")
    return "\n\n".join(parts)


def _evaluate_items(
    sections_text: str, llm: LLMClient,
) -> list[StrobeItem]:
    """Evaluate each STROBE-MR item against the paper."""
    checklist = "\n".join(
        f"- {k}: {v}" for k, v in STROBE_MR_ITEMS.items()
    )
    prompt = (
        f"Evaluate this MR paper against the STROBE-MR checklist.\n\n"
        f"Paper:\n{sections_text}\n\n"
        f"Checklist:\n{checklist}\n\n"
        f"For each item, respond with the item ID, whether it is "
        f"addressed (YES/NO), and which section addresses it. "
        f"Format: ITEM_ID | YES/NO | SECTION | COMMENT"
    )
    response = llm.chat(
        messages=[{"role": "user", "content": prompt}],
        system=SYSTEM_MR_SCIENTIST,
        max_tokens=2000,
    )
    return _parse_evaluation(response)


def _parse_evaluation(response: str) -> list[StrobeItem]:
    """Parse LLM evaluation response into StrobeItems."""
    items = []
    for item_id, desc in STROBE_MR_ITEMS.items():
        addressed, location, comment = _find_item_in_response(item_id, response)
        items.append(StrobeItem(
            item_id=item_id, description=desc,
            addressed=addressed, location=location, comment=comment,
        ))
    return items


def _find_item_in_response(item_id: str, response: str) -> tuple[bool, str, str]:
    """Find a specific STROBE item evaluation in the LLM response."""
    for line in response.split("\n"):
        if "|" not in line:
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 2:
            continue
        if parts[0] == item_id or parts[0].rstrip(". ") == item_id:
            addressed = "YES" in parts[1].upper()
            location = parts[2] if len(parts) >= 3 else ""
            comment = parts[3] if len(parts) >= 4 else ""
            return addressed, location, comment
    return False, "", ""


def _generate_suggestions(items: list[StrobeItem]) -> list[str]:
    """Generate improvement suggestions for unaddressed items."""
    suggestions = []
    for item in items:
        if not item.addressed:
            suggestions.append(
                f"Item {item.item_id}: {item.description} — "
                f"Consider adding this to your paper."
            )
    return suggestions


def format_strobe_report(report: StrobeReport, lang: str = "zh") -> str:
    """Format STROBE-MR report for display."""
    if lang == "zh":
        lines = [
            f"STROBE-MR合规性检查: {report.compliance_pct:.0f}% "
            f"({report.addressed_count}/{report.total_items})",
        ]
    else:
        lines = [
            f"STROBE-MR Compliance: {report.compliance_pct:.0f}% "
            f"({report.addressed_count}/{report.total_items})",
        ]
    unaddressed = [i for i in report.items if not i.addressed]
    if unaddressed:
        header = "未满足项目:" if lang == "zh" else "Unaddressed items:"
        lines.append(f"\n{header}")
        for item in unaddressed[:10]:
            lines.append(f"  [{item.item_id}] {item.description}")
    if report.suggestions:
        header = "改进建议:" if lang == "zh" else "Suggestions:"
        lines.append(f"\n{header}")
        for s in report.suggestions[:5]:
            lines.append(f"  - {s}")
    return "\n".join(lines)
