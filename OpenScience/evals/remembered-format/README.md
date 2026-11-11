# Remembered format, paired

Does a remembered layout make the model invent the content of a place it was never given? On 2026-10-24 production wrote a weekly
report in the format a person had set in an earlier conversation (「先给结论再给依据」) and filled the basis they never gave. One
sentence of guidance cut the invented statements per report from 3.6 to 0.75 on that one genre; this instrument asks the same question
over thirty genres, as **pairs**: the same remembered layout (a memory and/or a learned method naming places such as 依据 / 数字 / 日期 /
原因 / 下一步) with every place's content given (`full`) and with some places' content not given (`partial`).

| Cell | What it measures | How |
|---|---|---|
| `full` | what the guidance must not cost: every given item appears | deterministic: each given item has alternative anchors (a number, a date, a name), found with spaces and commas ignored |
| `partial` | the incident: statements the person never gave | a body-only model judge, **every quotation re-checked as a substring of the reply** (a verdict that fails the check is dropped and counted, not softened) + the general-task judges' `numbers_in` over numbers neither the ask nor the person's own remembered words hold |
| `partial` | what the reply did with each place that had no source | the judge says `omitted` / `marked` / `asked` / `filled_without_source` per place |
| both | the layout's own limits where a case states them | `chk_report_format` of `evals/general-tasks/judges/checks.py` (items, length, bold) — reused, not copied |

A pair is **right** when its `full` reply has every given item and its `partial` reply invents nothing and fills no place. A model that
answers the incident by leaving everything out fails `full`; a model that fills everything fails `partial`.

## The request

Built as the runtime builds it: the preset's persona row and `buildGuidanceText` (read from the checkout by `texts.mjs`, so the
`current` arm is the tree under test), the injected `<openviking-context>` memory block, the learned method's catalogue line, and the
method's text as a `read` tool exchange (DeepSeek thinking mode needs `reasoning_content` on that assistant message), sent straight to
DeepSeek. Thirty pairs, 25% English; about two thirds carry a learned method, the rest only a remembered preference. Every name, number
and date is invented (`cases.json`, written by hand; `case_issues` refuses a pair whose given items are not in its own ask).

## Commands

```bash
cd OpenScience
python3 evals/remembered-format/run.py --dry-run --only weekly-report            # the first request, no model call
python3 evals/remembered-format/run.py --key-file <path> --samples 3             # the tree as it is (arm: current)
python3 evals/remembered-format/run.py --key-file <path> --samples 3 \
  --arms current,pre-1024 --variant-file evals/remembered-format/variants/pre-2026-10-24.json   # the sentence's effect, per genre
python3 -m unittest discover -s evals/remembered-format/tests -p 'test_*.py'     # unit tests, no model
```

Options: `--model deepseek-flash` (also the judge unless `--judge-model`), `--only id,id`, `--workers 6`, `--out <file>`,
`--tree <checkout>` (texts of another checkout), `--texts-file` (a JSON `{persona, guidance}` for an offline run). The key is read from
`--key-file` or `DEEPSEEK_API_KEY` and is never printed or written. Results: `results/<date>-<arms>-<model>.json` (every reply, every
judgement) and a table on stdout.

## Variant files

An arm is the production texts with a variant's edits: `{"name": "...", "guidanceReplace": [[old, new]], "personaReplace": [...],
"methodReplace": [[old, new]], "methodAppend": "...", "guidance": "<whole text>", "persona": "<whole text>"}`, or `{"arms": [...]}`.
A replacement that matches nothing is an error (an arm silently equal to `current` would report a difference that is not there);
`methodReplace` must match at least one case's method. `variants/pre-2026-10-24.json` reproduces the guidance before the fix (the arm
the sentence is measured against); `variants/example-method-conditional.json` shows the method-edit shape.

## Measurements

DeepSeek Flash, judge Flash at temperature 0, thirty pairs; "invented" counts partial replies with at least one statement or number the
person never gave, "filled" the places filled without a source, "right" the pairs right on both sides.

| Date | Arm | Samples | full all-given | partial invented | filled | pairs right |
|---|---|---|---|---|---|---|
| 2026-10-25 | guidance before 2026-10-24 (`pre-1024`) | 3 | 80/90 | 81/90 | 38 | 7/90 |
| 2026-10-25 | guidance of 2026-10-24 (`pre-1025`) | 3 | 80/90 | 72/90 | 32 | 16/90 |
| 2026-10-25 | guidance of 2026-10-25 (`current`) | 3 | 81/90 | 58/90 | 16 | 27/90 |
| 2026-10-25 | `current` + methods with conditional places (`conditional-method`) | 3 | 81/90 | 47/90 | 11 | 39/90 |

The 2026-10-25 wording names the person's own facts widely (what was done, progress, results, decisions, reasons, scope, people,
dates) and says that a reason, background, significance or conclusion added to look complete is filling in for them; four rewordings
were tried on two samples first (none of the always-on sentences moved it further). The cases' methods keep the incident's unconditional
wording ("每条先写结论，再写依据"); a method written by `method-distillation` 1.4.1 or later states its places as conditional, which the
`conditional-method` arm stands in for. What still gets invented is mostly genre boilerplate stated as the person's fact (a cover letter's
"not published elsewhere", a review's "the clinic work went as planned", an abstract's cohort size).

## Limits

Samples are small (a direction, not a significance: repeat with `--samples`). The deterministic number check reads the whole reply, not
only the body, and ignores single-digit numbers. The judge is one Flash call at temperature 0 and is itself a model: its additions are
verified as quotations, not as truth. One genre per pair, one turn: this is the model's step after it has read the method, not the
platform's whole path (that is `evals/capsule-longitudinal`, scenario S1).


## P32 causal controls and scoring correction (2026-11-11)

The historical `58/90` reference above is the October 25 **current simulated-memory arm**, not a no-memory control. Neither that
comparison nor the later GX `54/90` identifies memory as the cause. The GX script copies the current persona and guidance but forces
an older fixture format and method-read exchange; it does not reproduce native extraction, recall, the full kernel prompt, tool use,
or the unattended-turn instruction.

Use [P32's receipt](../capsule-proving/p32/results.json) for the concurrent controls: the same thirty partial-input fixtures, three
samples each, with no memory/format, context and format pasted into the request, or simulated recall. The capsule red line is:
**memory must not increase fabrication relative to the same request with the format supplied by the person**. Similar point estimates
are not proof of equivalence; the receipt includes the paired comparison and a fixture-cluster bootstrap interval.

The historical scorer's unfamiliar-number count is not a fabrication verdict. It reads examples after the draft and even leaked tool
syntax, and its same-family judge sometimes rejects correct arithmetic or explicitly marked alternatives. P32 preserves these historical
results and supplies a separate cross-family Qwen instrument. Code gathers numerical candidates and exposes text outside square-bracket
spans without assigning meaning. The judge assesses support for factual assertions, including assertions around blanks; strict JSON and
exact evidence-substring checks validate its output. Invalid evidence is retried, then remains unjudged, never a clean pass. Failed
protocol-only responses are separately unusable. The manual audit and its disagreements with Qwen are preserved; calibration is not an
independent validation set, and a lower rescored rate is **not** a product improvement.

P32's product runner uses the existing control-plane/kernel harness, explicit memory-page seeding with native extraction, and automated
answer turns. It requires `OPEN_SCIENCE_MEMORY_RUNTIME_LOCK_ISOLATION_ENABLED=true`, waits for memory tools, records target opening
requests and reads, and scores delivered document text as well as the final reply. The first automated-seeding attempt was excluded:
automated turns correctly cannot teach long-term memory. These are disposable lab fixtures, never production accounts.

Lab commands (no dependency installation required):

```bash
python3 evals/capsule-proving/p32/measure.py --out /srv/evimed/runs/p32-controls --workers 6
bash evals/capsule-proving/p32/product.sh
python3 evals/capsule-proving/p32/collect_product.py /srv/evimed/runs/p32-product-v2 /srv/evimed/runs/p32-product-v2/answers.jsonl
python3 evals/capsule-proving/p32/measure.py --input /srv/evimed/runs/p32-product-v2/answers.jsonl --out /srv/evimed/runs/p32-product-grounded
python3 -m unittest discover -s evals/capsule-proving/p32 -p test_measure.py
```

Run the product script in its documented free lab slot; long runs use `setsid nohup` as specified by the campaign brief. The instrument
records source/rubric hashes and a resumable status. Do not mix rubric versions in one output directory; use a new directory to rescore.
