import { METHOD_SKILL_SCHEMA } from "@evimed/domain";

/**
 * One valid learned-method skill, body and frontmatter, for the suites that write methods straight into the product ledger (the shared GEO
 * context suites). It was the handbook fixture's until the handbook arm was deleted (2026-10-25); a learned method is the same skill file.
 */
export const BODY = ["## Purpose", "Keep denominators tied to the preserved source.", "## When to Use", "When summarizing study results.", "## Inputs", "The preserved study and its population.", "## Workflow", "1. Check each denominator against the source.", "## Verification", "- Every number names its population.", "## Constraints", "- Never infer absent counts.", "## Output", "A source-linked account of the results."].join("\n");
export const frontmatter = { name: "denominator-check", description: "Check study denominators when summarizing preserved research results.", whenToUse: "When summarizing results.", metadata: { role: "functional", applies_when: "Summarizing study results.", not_when: "No numerical results.", derived_from: "run:source-run", evimed_schema: METHOD_SKILL_SCHEMA } };
