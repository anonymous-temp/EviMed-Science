## Variant: a short method card with detail on demand

Write what a competent colleague would need to be told once to make a better decision next time. A method earns its
space by changing a decision, not by rehearsing everything an able colleague already knows. Keep the situation where
it helps, the few consequential decisions and their reasons, and the one or two traps the evidence actually revealed.
These are examples of useful content, not a closed inventory or a template: retain the distinctions this domain needs.
The existing required section headings and evidence, safety, scope and dependency rules still apply. A section may
be one line; do not repeat the same rule in the description, trigger, workflow, checks and constraints.

At `stage: detail`, "detail" means writing this one card, not an exhaustive explanation of the sub-skill. Start by
choosing the smallest insight that changes the next decision; do not write a long procedure and then summarise it.
Aim for roughly 100–180 words in the body and about 2 KB for the complete card including frontmatter; use less for a
simple operation. This is an authoring target, never a rejection threshold or permission to remove a necessary check.
Keep the description and trigger to a sentence each. The shared 32 KB reading budget should fit many such cards.
An abstract card gives the sub-goals and the choices between them, pointing to pinned lower-level methods rather than
copying their procedures. Follow observations and take the shortest justified next action; a search strategy is a
fallback for missing information, not a ritual to complete before using information already available.

For example, a household search lesson might say to use a visible target immediately and search likely unseen places
only while its location is unknown; a scientific measurement lesson might keep the decision about equilibration and
the unit check, with instrument-specific recovery off the card. These examples illustrate economy, not extra rules
to learn from an episode that did not establish them. Never replace a domain distinction with a vague slogan.

When a worked example, extended recovery or technical explanation is useful but not needed for the next decision,
keep it in an attached `scripts/detail.md` and link it from the card with a reason to open it, such as an unfamiliar
instrument or a failed check. Open that file only when that condition arises. This is documentation, not executable
code: the existing safe attachment directory admits Markdown, and no dummy program or test is needed. For a
distillation proposal, put its whole text in `method-candidate.json`'s `files["scripts/detail.md"]`; a separate delivered
file alone is not a method attachment. This extends the base skill's code-only attachment instruction for this
variant. Do not attach a file merely to fill a slot or invent material absent from the lesson.

For scale, a lesson about units could produce the following body. It illustrates brevity, not a mandatory form or a
rule about units to import into unrelated work; the seven headings are the existing contract's, and their wording
does not require seven explanations of the same idea:

```markdown
## Purpose
Catch unit mismatches before comparing measurements.
## When to Use
Measurements from different instruments or tables are being compared.
## Inputs
Values and their stated units.
## Workflow
Read each unit before calculating. Convert compatible units to the same basis; if the basis is unknown, keep the
values separate and name what is missing. For an unfamiliar conversion, open [detail](scripts/detail.md).
## Verification
Check that the converted value and its unit still describe the original quantity.
## Constraints
Never infer an absent unit from a neighbouring value; a conversion does not establish comparability of populations.
## Output
Comparable values with units, or the unresolved basis.
```

For a consolidation BUILD, apply the same economy to new cards and revised prose while preserving source constraints,
verification checks, evidence bonds and existing attachments under its normal revision rules. Its output remains the
method-relations format, not a method-candidate. An old long method is not a reason to rewrite it: existing methods
stay as they are until a normal evidence-backed amendment is warranted, saved as a restorable revision. Merely turning
this switch on never migrates, deletes or replaces a person's methods. If preserving the source requires a longer
card, preserve it; do not omit a check to meet the target.
