# Tool-lead scout (operator's Claude session)

You find tools EviMed Science lacks and write them down as lead cards. Sonnet reads the sources in bulk and drafts cards; Opus decides which cards are worth writing and signs off the ranking decision. A lead is a hypothesis and proves nothing: it goes to a tool-patch or capability-skill round, and that round's registration and statistics decide. Nothing here is a verdict, a promise or a build.

## What a good lead is

- A research method or data connector that researchers use often in the last 24 months of primary literature, that the platform does not ship, and that a tool (code beside the text that tells the model about it: `tool-patch`) or an instruction (a skill: `capability-skill`) could supply. A faithful standard-library or already-shipped-library implementation beats a new dependency; between two paths take the simpler.
- One that existing benchmark rows would exercise. This is the test the online scout failed: all 37 of its paper-scouting runs ended "waiting for material", on cards nobody could act on. Name the benchmark family and the scorer a candidate would be measured on (`medcalc-bench`/`medcalc`, `bixbench`/`bixbench-deterministic`, `deepresearchbench`/`judged-verdicts`, ... the lab's scorer table, `evals/rsi-campaigns/harness_scorers.mjs`). A public dataset is a plan only once it is a registered benchmark family (`evals/public-benchmarks/tools/register_pools.py`); otherwise there is no lead yet. Track `X` (needs new data to show anything) is refused.
- Not a duplicate. Read what ships before you write: `evals/tool-graph/`, `packages/domain/src/toolNames.mjs`, `capabilities/*/capability.yaml`, `packages/domain/src/method-records.json`, `VCR_ENGINE_METHODS` (`packages/domain/src/vcrEngineJob.mjs`). The check reports the names that matched; `already_shipped` is a refusal and `related` is the variant to look at.
- Not an engine. A new specialist engine (R, a Python agent) is a note to the owner, not a lead.

## What to read

Primary literature (PubMed/Europe PMC, preprints that have a paper), method papers and their software; the platform's own demand if the operator gives you `signals.json` (`scripts/ops/rsi-signals-export.mjs`: closed codes and counts of what accounts asked and was not served, withheld below 5 accounts). Read the paper, not a summary of it: a summary is a platform inference, not evidence. Never open evaluator assets, benchmark gold or any tenant data; none is offered to you.

## The card

`cards.json` is `{"schema": "rsi-tool-lead-cards/1", "observedAt": "YYYY-MM-DD", "cards": [...]}`; each card:

```json
{
  "method": {"id": "hksj-correction", "name": "Hartung-Knapp-Sidik-Jonkman variance correction", "aliases": ["HKSJ", "Hartung-Knapp"]},
  "track": "M",                       // E P M U X T, as the online scout used them; X is refused
  "toolKind": "calculation",          // calculation | workflow | connector
  "surface": "tool-patch",            // the round it goes on to: tool-patch | capability-skill
  "summary": "one or two sentences: what the tool does and why it is missing",
  "sources": [{"pmid": "24548571", "quote": "a contiguous passage of the title or abstract, 24 to 600 characters"},
              {"doi": "10.1186/s12874-015-0091-1", "quote": "..."}],
  "literatureQuery": "TITLE_ABS:\"Hartung-Knapp\" AND \"meta-analysis\"",
  "developmentPlan": {"benchmark": "medcalc-bench", "scorer": "medcalc"},
  "demand": {"operations": ["meta-analysis"], "dataShapes": ["table"]}      // optional: the signal groups you say it answers (printed, never scored)
}
```

The comments in the card are for you; the file is plain JSON. At least two sources of different papers, each by PMID or DOI, each with a quote copied character for character from the title or abstract Europe PMC holds (one passage, no ellipsis). `literatureQuery` is held to a closed syntax: clauses joined by ` OR `, each clause terms joined by ` AND `, each term a quoted phrase, optionally `TITLE_ABS:"..."`; no parenthesis, NOT or other field. Every clause must contain a `TITLE_ABS:"phrase"` whose phrase is the method's id, name or one of its aliases, so the count is of papers about the method and not about a topic (unfenced, "Hartung-Knapp" AND meta-analysis counted 2426 papers in 24 months, fenced 727). Otherwise the card is refused `tool_lead_card_invalid` before any request. The tool adds the 24-month window. `demand` only selects groups in `signals.json`; nothing ties those groups to the method, so the tool prints them beside the score, marked as your claim, and the score does not read them.

Do not write counts, scores, costs, priorities or "published examples". The tool ignores any it finds and records the measured ones beside what you said.

## Run it

```
node evals/rsi-campaigns/tool_leads.mjs check --cards cards.json --signals signals.json --pools $BENCH_ROOT/pools \
  --literature-record literature.json --out leads.json
```

It calls no model. It asks Europe PMC (one fixed index, no URL from a card) unless `--literature-fixture literature.json` replays a recorded run, which gives the same bytes. Read `refused` first and repair what is repairable. A refusal is one of: `tool_lead_card_invalid`, `_duplicate_method`, `_new_data_required`, `_already_shipped`, `_no_measurable_development`, `_source_unavailable`, `_quote_not_found`, `_too_few_sources`, `_literature_unavailable`, `_no_literature_demand`. Do not rewrite a card to slip past one: a quote that is not there means the source was not read.

## Hand over

Keep `cards.json`, `literature.json` and `leads.json` together. Opus reads `leads.json` top down (score, its breakdown, the matched names in `coverage`, the demand as your claim) and chooses which leads go on, as a tool-patch or capability-skill round with its own registration. The ranking is a starting order; the decision and its reasons are Opus's and are written down with the leads file's digest.
