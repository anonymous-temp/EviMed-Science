---
{"name":"answer-question-set-from-supplied-corpus","license":"internal","metadata":{"role":"functional","not_when":"The record has to be found on the open web rather than in the supplied corpus; the answer is one free-text response with no file; the corpus or the question set is missing, so the answers could only be guessed.","depends_on":"","applies_when":"A task hands over a data corpus together with a set of questions and asks for the answers in a machine-readable file whose keys, value types and per-entry fields the task states.","derived_from":"run:run_b497951a11a6a9861930578c2d11328e, feedback:feedback:learning-evidence:175e07a4273b3b68ea1d29ef9e760ae0","evimed_schema":"method-skill/1"},"whenToUse":"When a task hands over a corpus and a list of questions and wants the answers written to a file in a shape it states.","description":"Answers a set of retrieval questions out of a corpus handed over with them and returns a machine-readable answer file built to the shape the task states. Each item in an answer is tied to the record and the field that supports it, the criterion for including a record comes from a field the corpus itself carries, near-matches that belong to another referent are excluded and named, and a question whose scope is open is reported with what each reading would add instead of being narrowed silently. The saved file is parsed back and checked against the stated keys and field types before it is handed over. Use when a task supplies a data corpus plus a question set and asks for the answers in a file another program will read; not when the records have to be found on the open web, and not for a single free-text question.","allowed-tools":""}
---

## Purpose

A corpus arrives with a list of questions and a file to fill. The answers are
read out of the records: each item in an answer points to the record and the
field that put it there, and a candidate that only looks like the answer is named
and left out with its reason. Where a question can be read two ways, both readings
come back with what the wider one would add. The saved file is parsed again and
checked against the shape the task gave, so the next program that opens it finds
the keys and the types it expects.

## When to Use

Use it when a data corpus and a question set arrive together and the answers must
leave as a file with a stated shape: one key per question, a list-valued answer,
a per-entry field or two the task names.

Not for a question that has to be answered from the open web, for a single
free-text answer with no file behind it, or for a corpus that is missing. Where the
question set or the corpus is absent, the gap is stated; the answers are not
reconstructed from what a likely corpus would have held.

## Inputs

- the corpus and its layout: which files, which record types, the ids that link
  records across files, and which field holds the final or accepted state rather
  than a draft, a proposal or a thread comment;
- the question set, with the entity type and the relation each question asks for;
- the output contract the task states: the key per question, the value type, the
  per-entry fields, the path and the format;
- the identifiers the corpus itself uses, on hand for the case where two entities
  carry the same display name.

## Workflow

1. Read the questions and the file's shape before opening the corpus: the key each
   answer goes under, the value type, the fields every entry carries, the path and
   the format. Write that down. The shape decides what the corpus has to yield,
   so settling it first saves a rewrite.
2. Inventory the corpus: the record types, the ids that join one file's records to
   another's, and which field carries the accepted state as against a draft or a
   comment.
3. For each question, settle the entity type and the relation it asks for, then follow
   the relation across records: which record names the entity, which field ties it
   to the question's condition. That field is the inclusion criterion, and
   plausibility is not.
4. Decide the near-misses one at a time: a record whose words match while its
   entity is not the one asked about, a person who spoke in a thread whose point
   was never taken up, a document still carrying an older name for the thing asked
   about. Keep each on an exclusion list with its reason.
5. Enter each item under the identifier the corpus itself uses, one entry per item,
   in a list even when there is only one.
6. Reread every answer against its question: all the items of the type asked for,
   and nothing that is there on a keyword alone.
7. Save the file to the path the task names, with the keys and the fields it states.
   A field the shape requires that nothing at hand can measure goes in as the
   estimate it is.
8. Parse the saved file. Every question keyed, every answer a list, every stated
   field present and of its stated type. Repair and reparse until the check passes.
9. Write the reply: the questions in order, each with its items, their identifiers
   and the record and field behind each; the near-misses left out and why; each
   question read two ways with what the wider reading would add.

## Verification

- Every item in the file resolves to a record and a field that support it. An item
  that resolves to nothing is removed rather than explained.
- Every question in the set has a key in the file, and the file carries no key the
  question set did not ask for.
- The file parses, every answer is a list, and each stated per-entry field is
  present with the type the task gave it.
- Every candidate the reply names as excluded is absent from the file, and nothing
  in the file rests on a candidate the reply never mentions.
- The reading of a question given in the reply matches what the file holds:
  whatever the wider reading would add is not sitting in the answer.
- A number nothing at hand measured is marked as an estimate wherever it appears.

## Constraints

- Answers come out of the corpus. A question the corpus cannot answer gets an empty
  or short entry and a stated gap, never a plausible guess.
- The inclusion criterion is one the corpus carries. This method sets no threshold
  or count of its own.
- Nothing is dropped silently. A candidate considered and left out is named with its
  reason in the reply.
- The reply points at the file and names the path that is the deliverable; a second
  copy is a convenience, not the answer.
- The corpus is left as it stands. A stale name, a contradictory field or a record
  that disagrees with its own manifest is reported, not repaired to make an answer
  work.
- Nothing here decides which entities, which relation or which reading belongs to a
  particular question. That comes from the question set and from the corpus.

## Output

- the answer file at the path the task names, parsing clean and in the shape it
  stated;
- a reply that walks the questions in order, names each item with its identifier
  and the record and field behind it, lists the near-misses left out with their
  reasons, and states each scope reading and each gap or estimate.

