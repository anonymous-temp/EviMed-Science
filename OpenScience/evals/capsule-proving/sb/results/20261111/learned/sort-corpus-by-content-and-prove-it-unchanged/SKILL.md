---
{"name":"sort-corpus-by-content-and-prove-it-unchanged","license":"internal","metadata":{"role":"functional","not_when":"The request is to rename, convert, edit, deduplicate or delete the files themselves; the batch is a single file; or the destinations are neither given by the task nor inferable, so placing a file would mean inventing a category.","depends_on":"","applies_when":"A task hands over a batch of documents and a list of destinations, one file belongs in exactly one destination, and the files must keep their names and contents.","derived_from":"run:run_bfa3f2f0035e8fb73aa5dc7f09abb411, feedback:feedback:learning-evidence:44d003ff628c24c3fc46eebb755d7b02","evimed_schema":"method-skill/1"},"whenToUse":"When a task hands over a batch of documents plus the named folders or subjects to sort them into, and the files must come back with their names and contents untouched.","description":"Sorts a batch of files into the destinations a task names, deciding each file's place from what the document itself says rather than from its file name, and hands the batch back byte-identical. The workspace is inventoried before anything moves and the corpus found is set beside the corpus the task describes; every destination the task named is created even when it ends empty; a content hash is compared before and after the move; per-destination counts and a total that leaves nothing outside them close the run; and the reply tables each destination with the basis for each file and states the gap between the described corpus and the present one. Use when a task hands over many documents with a list of folders or subjects to sort them into and requires names and contents to stay as they are, or when a similar batch will be triaged again later.","allowed-tools":""}
---

## Purpose

A batch of documents arrives with a list of places to put them, and the job is to hand the same
batch back, sorted. Before anything moves, find out what the workspace actually holds. Then read each
file and place it by what the document says, keep every destination the task named even when one stays
empty, and check the moves afterwards so that the claim names and bytes survived rests on a
comparison rather than on confidence. The reply accounts for where each file went, and for the part
of the described corpus that was never there.

## When to Use

Use it when documents have to be distributed over a fixed set of folders or subjects, one file to
one destination, and the task says the files are not to be changed. A handful of files and a
thousand take the same steps, and so does a second pass over a batch that was triaged before.

Not for a request to rename, convert, edit, deduplicate or delete anything: those change the files
themselves. Not for a single file, where there is nothing to count against anything. And not where
the destinations are neither named nor readable from the material — placing a file there would mean
inventing a category.

## Inputs

- the workspace as it stands, listed recursively before anything is touched;
- the destination list, in the task's own names and spelling;
- the rules the task states for placement: one destination per file, what happens to a file that
  fits none, whether any file may be left out;
- the material each file carries: slides, document body, title and opening text, whatever reading
  it takes to say in one line what the document is about;
- the constraint on the files themselves, when the task states one (names and contents unchanged);
- a content hash of every file, taken before the first move.

## Workflow

1. Take the inventory first. List every regular file under the workspace root, non-hidden and
   recursive, and resolve any host path the task names as a path inside the workspace. The count you
   get is the batch; a batch computed from the task's description is a guess.
2. Put the found count beside the count the task claims, and write down the difference. The gap is a
   finding to report, not a defect to repair: the missing part of a described corpus is not yours to
   create.
3. Read each file before placing it. The subject comes from what the document says — slides, body,
   title, abstract — rather than from its file name: where a name suggests one subject and the text
   says another, the text decides. Record, for every file, the phrase you read that puts it where it
   goes.
4. Give each file exactly one destination. When a file fits none of the named subjects, apply the
   remainder rule the task states. When the task's wording leaves that rule open, take the reading
   that leaves no file out and say which reading you took.
5. Create every destination the task named before moving anything, so the promised set exists even
   when some of it ends empty. Leave an empty destination empty: a file moved in to keep a folder
   company is a false statement about the corpus.
6. Hash, move, hash again. Take a content hash of each file in place, move the file rather than
   copying and deleting it, then hash it at its destination and compare. Equal hashes are what make
   the claim that names and contents survived; without them it is only an assertion.
7. Check the batch at the end: the number of files in each destination against the placement you
   recorded, the sum over all destinations against the inventory, and nothing belonging to the batch
   left outside them.
8. Write the reply as the record of the job: a destination table with the count and the basis for
   each file, the integrity result, and the gap between the corpus described and the corpus present.
   Name the reading taken wherever the task left a rule open.

## Verification

- The inventory count equals the sum of the per-destination counts, and no file of the batch sits
  outside a destination.
- Each destination the task named exists, whether or not it holds a file.
- Every file appears in exactly one destination, and its recorded basis is a phrase from that file's
  own content, not from its name.
- The content hash of each file equals the hash taken before the move.
- Each destination's count in the reply equals what the listing finds there now.
- A gap between the described corpus and the present one is stated in the reply wherever the two
  differ.

## Constraints

- Never change a file's name or its content: no renaming, no re-saving, no metadata rewrite, no
  "cleanup" while moving.
- Never create a file to fill an empty destination, and never split a described corpus into files it
  did not arrive as.
- Classify only the material the task handed over; the workspace's own bookkeeping directories are
  not part of the batch.
- The destinations and their names come from the task. This method invents no subject, no folder
  name and no taxonomy of its own.
- Where a document cannot be read, say so and record the gap rather than placing it by its file name
  and calling the placement a reading.
- A limitation that the task's description meets in reality goes into the reply in plain words; it
  is never quietly dropped to make the result look complete.

## Output

- the destinations the task named, each holding the files placed in it, with every name and content
  byte unchanged;
- a reply carrying the destination table (count plus the content basis per file), the statement that
  the batch survived intact with the hash comparison behind it, and the difference between the
  corpus the task described and the corpus the workspace held.

