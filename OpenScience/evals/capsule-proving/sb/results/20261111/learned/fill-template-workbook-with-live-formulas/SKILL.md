---
{"name":"fill-template-workbook-with-live-formulas","license":"internal","metadata":{"role":"functional","not_when":"The task wants a single number or a prose answer with no workbook; the spreadsheet is only an untracked scratch pad; or the source series cannot be obtained and the cells could only be filled by guessing.","depends_on":"","applies_when":"A task asks for a spreadsheet deliverable whose inputs come from a published or externally downloaded data file and whose cells must be computed (returns, rolling windows, conversions, lookups, ratios), and the file is expected to be opened and checked afterwards.","derived_from":"run:run_198888c2e6e0f7b79465b5a141f85a47, feedback:feedback:learning-evidence:46e2666e89f97934e733086ae0a4f24c","evimed_schema":"method-skill/1"},"whenToUse":"When a task asks for a workbook to be filled or computed from a downloaded data file, and the numbers in it have to stay traceable and re-computable after delivery.","description":"Builds a requested workbook from an externally downloaded data series so it stays auditable after it leaves the workspace: every cell that computes something holds a formula over data staged inside the file rather than a typed number, the saved workbook is reopened and its cached values are compared with an independent recomputation, and the reply names the exact series and column it came from, every row dropped under the task's own rules and every choice the task left open. Use when the deliverable is a spreadsheet to fill from a template and a downloaded dataset, or when a metric has to be derived from an external series and a later reader is expected to be able to check it.","allowed-tools":""}
---

## Purpose

Hand back a workbook that a reader can still take apart. The cells that compute
something hold formulas over data that sits inside the same file, so the sheet
reproduces itself without the script that built it. The delivered file has been
opened again and its values checked against a separate recomputation. The reply
says where the data came from, which rows the task's rules removed, and which
choices the task left to the builder.

## When to Use

Use it when a template comes with named sheets and blank cells, the numbers have
to come from a published or downloaded dataset, and somebody will open the file
afterwards to see how a figure was reached.

Not for a one-off figure in a message or for a working file nobody will reopen.
And not where the source series is missing: an empty cell with the gap stated
is better than one that looks plausible.

## Inputs

- the template workbook, or the layout the task describes: sheet names, the
  column letters each computed item goes in, which cells are the blanks, where
  the final file is saved;
- the dataset the task points at, and the column or series the template names;
- the task's rules: what to compute, which rows to include, which rows to drop,
  which convention it states, and the unit or frequency it expects.

## Workflow

1. Read the template before computing anything: which sheet takes the answer,
   which column each item occupies, which cells are blank, which existing sheets
   hold the input tables. Write the mapping down. An item placed one column off
   passes every later check and is still wrong.
2. Fetch the dataset from the page the task names and keep the downloaded file
   beside the deliverable under a name that says what it is. Match the template's
   named series to the source's own description of its column, not to the
   column's position, and note the unit and the frequency.
3. Stage the source values on their own sheet inside the workbook, so every later
   formula reads from inside the file. A workbook whose numbers live only in the
   build script cannot be audited once it leaves.
4. Write each blank as a formula over those cells: return against the previous
   row, a rolling window over the last n cells, a conversion at a stated average,
   a lookup against another sheet's header row. Do not type a computed number
   anywhere, even one you already know and even as a placeholder to be replaced.
5. Carry the convention the sheet states into the formula itself (percent as a
   percent, the annualisation asked for, the sample or population form of a
   standard deviation) instead of pre-scaling the staged data, so the sheet shows
   what was done.
6. Apply each inclusion rule to the full candidate list before the final columns
   are computed, through the formula-driven lookup the task asks for. A row the
   task removes leaves the table only after its name and the reason are written
   down.
7. Where the task's wording leaves a choice, take the one the sheet's own
   structure implies, apply the same choice to every row, and put it in one cell
   so it can be reversed in one place.
8. Save to the path the task names, then open the saved file twice, once for the
   formulas and once for the stored values, and list every filled item with its
   formula and its value.
9. Recompute the same quantities on their own and compare them with what the
   reopened file holds. A mismatch is a range off by a row or a stored value left
   over from an earlier save; both are found here and nowhere else.
10. Look at the populated sheets as a reader will: headers that fit, columns wide
    enough for their numbers, each sheet's content visible without being cut off
    or spilled onto another page.
11. Delete the scratch downloads, temporary profiles and caches; keep the
    deliverable, the downloaded source, and the build and verification scripts.
12. Write the reply: the source and the exact series used, a table of each filled
    item with its formula and value, every row left out with its reason, and the
    judgement calls with the one-cell change that would reverse each.

## Verification

- Every cell that was asked to be computed holds a formula: count them against
  the number of items the template asked for, and look for a constant typed
  into those columns.
- The stored values in the saved file equal an independent recomputation of the
  same quantity, item by item.
- Formulas read from sheets inside the delivered workbook, not from the
  downloaded file and not from an absolute path.
- Each row named as dropped in the reply is absent from the table it was dropped
  from, and no other row is missing.
- The figures in the reply are read back from the reopened file, not from the
  build script's output.
- Each judgement call names the alternative and the cell that would change it.

## Constraints

- No computed value typed into a cell; no figure copied from a script's stdout
  into the sheet.
- No row removed silently, and no narrowing of scope to the rows that happened to
  have data.
- No convention invented where the sheet states one; where it states none, say
  which one was used and where to change it.
- Source data are read from the file they came in; nothing is rebuilt from
  memory. If a series or a year is missing, say so and leave the cell empty
  rather than filling it from a hint.
- Nothing in this method decides which series, which entity, which window or
  which threshold applies. That comes from the task and from the data.

## Output

- the workbook at the path the task names, formulas live;
- the downloaded source file beside it, as provenance;
- the build and verification scripts, so the file can be rebuilt and rechecked;
- a reply carrying the source and series, the item table, the dropped rows and
  the judgement calls.

