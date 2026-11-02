# Criteria-parse check

A deterministic check of how a registry trial's eligibility text is structured into criteria, run in
`apps/server/test/vcrCriteriaParseCheck.test.mjs` with no model and no network.

```bash
node evals/vcr-matching/criteria-parse/criteria_parse_check.mjs                      # the stored parses
node evals/vcr-matching/criteria-parse/criteria_parse_check.mjs --parses <file> --out report.json
cd apps/server && node --test test/vcrCriteriaParseCheck.test.mjs
```

## What is here

- `cases.json`: 36 eligibility texts (24 English in the style of a ClinicalTrials.gov eligibility module, 12 Chinese in the style of a ChiCTR
  registration, across 13 settings), each with the labelled lines: kind, the wording as written, and the requirement in the platform's own
  grammar (an exclusion written as the registry states it). 236 lines.
- `stored-parses.json`: a parse for every case. Most equal the labelled structure; 13 carry one deliberate flaw each (a line missed, a line
  invented, a split line, inclusion and exclusion swapped, a wrong number, a wrong comparator, an OR written as an AND, a wrong window, a
  wrong variable). `planted` names them.
- `criteria_parse_check.mjs`: the comparator, and the figures PRISM reports for the same step: the share of labelled lines missed, the share
  of the lines found that are malformed, and the share whose logic is right.

A line is the same line when it stands at the same characters of the text (the platform's own `locateSourceText`: case, spacing, `>=` against
`≥`, dashes and quotation marks fold; a near match is no match). Operands of `all`/`any` may come in any order, a number is a number, a
variable may be given aliases per case, and a `language` criterion is a language criterion whatever its key and words.

## What it proves

- The comparator finds each kind of parse error and no other: every planted flaw is reported as what it is, and the 23 clean cases report
  nothing.
- The labelled examples are inside the platform's grammar and are findable in their texts by the platform's own locator, so a change to the
  grammar or the locator that strands an example fails here.
- The stored figures are frozen (36 cases, 23 complete, 5 lines missed, 2 unlocated, 2 extra, 2 wrong kind, 5 wrong structure): a change to
  the comparator or to an example shows.

## What it does not prove

- **It does not measure a model.** The stored parses were written by the author of the labels, not produced by DeepSeek or by anyone else's
  parser, and the planted flaws are chosen to be easy to see. The figures it prints for them (about 2% missed, 3% malformed, 95% logic
  correct) are a property of the planted set and say nothing about how the platform's model parses. To measure one, freeze the model's parse
  of these same texts, pass it with `--parses`, and read the three figures; that run has not been made.
- **The texts are authored, not sampled.** They are realistic, but they are not records from the registries and not a random sample of
  anything: no claim about how often real eligibility text has a given form (nested conditions, tables, free-text exceptions, lines that
  mix inclusion and exclusion) follows from them. A set of 36 cannot put a confidence interval around an error rate of 1% to 3%.
- **One author labelled it.** There is no second reader and no agreement figure; the labelled structure is one careful reading, and for a
  line that two readers would structure differently (an age range as `between` or as two comparisons; a stage as `in` or as an `any`) the
  comparator will call the other reading wrong. It does not know that two structures mean the same thing unless they are the same
  structure in its canonical form.
- **It compares structure, not meaning.** A parse that chooses a variable name the case does not list as an alias is reported as wrong
  even if it names the same thing; a parse that is structurally equal to the label is right even if the variable it names is the wrong
  concept for the record that will be read. It never reads a patient and never decides whether a criterion is met.
- **It says nothing about retrieval, evidence or eligibility.** Whether the right trials are found, whether a patient's facts satisfy a
  criterion, and whether the verdicts are clinically right are separate questions (the matching evaluation in `../` and the live
  conversation checks); a perfect parse here is a necessary condition for none of them.
- It is not a release gate. It runs in the ordinary server tests as a regression check, and a failure means the comparator or an example
  changed.
