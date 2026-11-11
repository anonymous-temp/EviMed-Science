---
{"name":"check-fixed-form-text-against-its-grid","license":"internal","metadata":{"role":"functional","not_when":"Prose whose shape is a matter of style; a request only to comment on an existing text; or a form whose rules are neither stated nor inferable, so the check could only run by inventing them.","depends_on":"","applies_when":"A task fixes the form of the text it asks for (metre, rhyme, line or character counts, required fields in order) and the text is delivered as a file that will be inspected.","derived_from":"run:run_57ca3752e63a56dbcf6da60a18b9b126, feedback:feedback:learning-evidence:7f178c2f0c103a0900597bd1e1de2b0f","evimed_schema":"method-skill/1"},"whenToUse":"When a task asks for text that must obey formal rules it states — metre, rhyme, line or character counts, a fixed sequence of fields — and the result is handed over as a file.","description":"Composes text whose form the task fixes — a classical Chinese poem to a named metre, rhyme and tonal grid, a text with a fixed line or character count, a form with required fields in a required order — and checks it against that pattern before it is written out. The pattern is laid out as an explicit grid first, every unit is compared with it from a pronunciation or counting source rather than from memory, the joins and the repeated units are checked, the written file is read back for its layout, and the reply maps each stated requirement to the place in the text that meets it. Use when a deliverable has to satisfy stated formal rules and somebody will inspect it afterwards; not for prose whose shape is a matter of taste.","allowed-tools":""}
---

## Purpose

Some requests fix the shape of a text before the words exist: how many lines,
how long each one, where the rhyme falls, which unit takes which tone, which
fields come in which order. The text that goes back has been checked against
that pattern unit by unit before the file was written, the file has been read
back from disk in the layout the task asked for, and the reply points at the
place in the text where each stated requirement holds. That account lets a
reader see the form is satisfied without working it out again, and see which
tolerances were used and where.

## When to Use

Use it when the task states formal rules the delivered text must satisfy and the
text leaves as a file somebody will open: a poem to a named metre and rhyme, a
text with a fixed count of lines or characters, a form whose fields must appear
in order.

Not for prose whose shape is a matter of taste, and not for a request only to
comment on an existing text. Not where the rules are absent and cannot be read
off the genre: say which rule could not be established rather than checking
against one you invented. Where the task wants the text in the conversation
only, the check still applies but there is no file to read back.

## Inputs

- the formal rules the task states: the genre or form, the number of lines and
  their length, the rhyme system and which pronunciation standard it means, the
  strictness asked for;
- the content constraints: theme, viewpoint, what must or must not appear;
- the file's path and layout: which line is the title, how many lines follow,
  the encoding, any trailing newline the layout implies;
- a source for the units the check turns on, such as a pronunciation or pinyin
  library for tones, a character table, or a counter written against the stated
  rule.

## Workflow

1. Write the pattern down before drafting a line: the form variant the genre or
   the task implies (which position of the first line fixes the pattern, whether
   the first line carries a rhyme), the rhyme category taken from the system the
   task names, the positions held strict, and the positions the rules leave
   tolerant. A grid kept in your head drifts from the draft two lines later, and
   nothing on the page shows it.
2. Draft whole couplets against that grid rather than one line at a time. Rhyme,
   join and parallelism all span more than one line, so a line written on its
   own is usually thrown away once the couplet is finished.
3. Compare every unit with its slot mechanically: read each character's tone
   from the pronunciation source and match it to the slot, keeping the strict
   positions apart from the tolerant ones. Scoring a line as pass or fail hides
   which position failed.
4. Check what the units do not show on their own: the joins between couplets
   and the opposition within a pair, the endings the form forbids, the parallel
   structure the middle couplets owe, and any unit used twice.
5. Repair what failed, then rerun the whole check, not the failed line. A
   changed character moves a join and sometimes the rhyme.
6. Where a unit has more than one reading, take the reading the text intends and
   write down which one was taken.
7. Write the file where the task's own wording points, in the layout it asks
   for: title line where it asked, the counted lines after it, the encoding.
8. Read the written file back: its lines, the length of each, the encoding, the
   trailing newline, and that the text on disk is the text that was checked. A
   second copy is a convenience, not a deliverable, and the reply says which
   path is the one being handed over.
9. Write the reply as an account of the requirements: each stated requirement,
   and for each the place in the text that meets it. For a metre that means the
   strict positions, the tolerant ones that deviate, the rhyme words with their
   readings, and the couplets carrying the parallelism. Fill each line from what
   the task asked and what the check returned; a requirement the task did not
   state has no row.

## Verification

- Every tone came from the pronunciation source and was compared with its slot;
  the tolerant positions that deviate are named individually rather than
  folded into a pass.
- The file read back from disk has the lines, line lengths, ordering and
  encoding the task asked for, and its text equals the checked text.
- Each row of the reply's account resolves to a place in the delivered text, and
  each rhyme word appears in the rhyme category named.
- No line was edited after the last check without the check rerun.

## Constraints

- The pattern comes from the task and the genre's own rules. This method chooses
  no theme, no rhyme word, no line and no category; those are the task's and the
  writer's.
- A tolerance is used only where the rules allow it, and each use is stated in
  the reply rather than left for the reader to find.
- Do not claim a check that was not run. If no pronunciation source is to hand,
  say which checks are unverified instead of asserting them.
- Cap the account to the requirements the task stated, and leave out the
  checking script itself; the reader wants the text and the reason it holds.
- Where two paths were written, say which one is the deliverable; two silent
  copies make a later reader guess.

## Output

- the text at the path the task named, in the layout it asked for;
- a reply that states the form and the rhyme system used, then walks the
  task's requirements one by one with the place that meets each, naming the
  tolerated positions and the readings taken for polyphones, and naming the
  path that is the deliverable.

