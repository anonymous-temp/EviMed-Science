"""What the editors are told about the work of each domain: one short, process-level description per family.

`BenchPrompts` refuses the words that name a measurement (see upstream spec.py), and these texts keep to that: they say what the person
who asked needs. They hold no fact about any task, answer or scale. The levers say what the surface can and cannot do, once, here.
"""

from __future__ import annotations

SURFACE_NOTE = (
    "This surface has two components only: `guidance.md` (short, always on, at most 4,000 characters in total) and `skills/<name>/SKILL.md` "
    "(on demand). It has no scripts, sub-agents, plugins, hooks or tool-loop lever: ignore every mention of them above. Write the text in "
    "English. Never write a number you cannot justify as a rule, a name of a data set, file, trial, paper or person, or any wording copied from "
    "the task or its sources: a harness that does is refused."
)

INV_LEVERS = (
    "- Which step did the earliest divergence or loss come from: reading the request, choosing a method, using a tool, checking a result, or "
    "stating the answer?\n"
    "- Tell the agent WHEN to stop and hand back, what a finished answer looks like, and what to do when a tool fails or returns nothing.\n"
    "- Make sure the answer is in the form the request names, as the last thing written.\n" + SURFACE_NOTE
)
DOM_LEVERS = (
    "- Which professional habit would a practitioner apply that the agent skipped: a definition to look up, a unit to convert, a cross-check, "
    "a source hierarchy, a limit of the data?\n"
    "- Say how to verify and what to do when sources disagree or are silent, never what the answer is.\n" + SURFACE_NOTE
)


def _bp(prompts_cls, *, work: str, deliverable: str, yardstick: str, lens: str):
    return prompts_cls(
        work=work, domain_word="task family", inv_levers=INV_LEVERS, dom_levers=DOM_LEVERS, yardstick=yardstick,
        deliverable_word=deliverable, domain_guidance=lens, prompt_pack="tts",
    )


def for_domain(domain: str, prompts_cls):
    table = {
        "medcalc": dict(
            work=("Clinical calculation for a clinician: from one patient note, compute exactly one requested quantity (a clinical index, "
                  "equation, unit conversion or date) and state it in the requested form. The note controls which values count; the published "
                  "definition of the calculator controls how they are combined."),
            deliverable="answer",
            yardstick=("Did the run identify the exact calculator and version, take each input from the note as it stood at the stated time, "
                       "do the arithmetic in code, state the unit and rounding the request names, and end with the requested final line?"),
            lens="Short question, short answer: the work is correct extraction and exact arithmetic, not a long essay.",
        ),
        "arb-deep": dict(
            work=("Literature identification: find the single paper that satisfies a long list of conditions stated in a question, using "
                  "literature search and reading tools, and name it with its identifier in the requested form, or say that none exists."),
            deliverable="answer",
            yardstick=("Did the run split the conditions, search along the most selective one first, verify every condition against the "
                       "paper's own text before naming it, and say so when none matched instead of guessing?"),
            lens="A confident wrong paper is worse than an honest 'none'. Verify before answering; stop when the budget is spent and answer with what is verified.",
        ),
        "arb-wide": dict(
            work=("Literature enumeration: find every paper that satisfies the conditions stated in a question and list them in the requested "
                  "form, or say that none does."),
            deliverable="answer",
            yardstick=("Did the run cover the space with several differently-worded searches, check each candidate against the conditions, "
                       "keep a running list, and hand back the list in the requested form before the budget ran out?"),
            lens="Recall and precision both matter. Write the list early and refine it; do not hold the whole answer until the end.",
        ),
        "bixbench": dict(
            work=("Data analysis on supplied files: answer several numbered questions about a data set in the workspace inputs folder by "
                  "running analyses, and give each answer in the requested form."),
            deliverable="answer",
            yardstick=("Did the run inspect the files before analysing, choose a method that fits the data's structure, run it in code, "
                       "check assumptions, answer every numbered question, and end with the requested final section?"),
            lens="Every numbered question needs an answer, even a provisional one. Deliver the section early, then improve it.",
        ),
        "mbc": dict(
            work=("Medical lookup: answer one factual question about a clinical trial or a drug (for example an ingredient, an applicant, or a "
                  "date from a regulatory record) from public registries and drug databases, with one short answer in the requested form, "
                  "or say it is unknown."),
            deliverable="answer",
            yardstick=("Did the run go to the authoritative record, read the exact field the question names, apply the question's own "
                       "qualifier (first, latest, by letter), and answer only with the requested value or 'unknown'?"),
            lens="The answer is one value. Prefer the primary record over secondary pages, and say unknown rather than infer.",
        ),
        "drb": dict(
            work=("Deep research report: an open-ended research question answered with a thorough, well-structured, sourced written report, "
                  "in the language of the question."),
            deliverable="report",
            yardstick=("Did the run plan the report's structure from the question, gather sources broadly, cover each facet the question "
                       "names, reason across sources instead of listing them, cite what it used, and deliver the report as a file and in the reply?"),
            lens="Depth, coverage and insight, in the question's language. Deliver a complete first version early, then extend it.",
        ),
        "rcb": dict(
            work=("Research project: carry a scientific research task end to end from the supplied data and related papers, writing code, "
                  "running analyses, and producing a final written research report with figures."),
            deliverable="report",
            yardstick=("Did the run read the task and the data first, plan the analyses the task names, run them, check their outputs, "
                       "write the report early and revise it, and stop cleanly with the report in the named place?"),
            lens="A finished report in the named place beats an unfinished perfect analysis. Write the report incrementally.",
        ),
    }
    return _bp(prompts_cls, **table[domain])
