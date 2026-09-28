# Revision notes — method relations, action `decide`

## What was read

The frozen input carries one population: two methods, `claim-verdict-audit`
(sha256:8bd4e4a2da0b5a92b4bfcaa8b68464bb4fffa542682848afafef1cd6d33f6e98) and
`reporting-checklist-addressability`
(sha256:67d7856648287eb0cfeedfbd04c067c88ade5e4e2ccc38ae079ae740a9f1e6ad). Both
were read in full, front to back, as a single group: 150 lines and 239 lines of body text,
seven sections each in the same order — Purpose, When to Use, Inputs, Workflow,
Verification, Constraints, Output. No method outside the input was fetched, and
no run, document or external source was consulted.

## Decision

**No assignment.** The action's own rules make this a finding rather than an
omission: a group may yield several assignments, one, or none, and none means
the population does not relate. `assignments` is therefore empty and the reasons
for each declined relation sit in `notices`, split by relation type so a reader
can check each one against the bodies.

The two methods are differently aimed and differently scoped. `claim-verdict-audit`
works on a pack that has already been delivered and accepted, walks it claim
instance by instance, and by its own constraint never rewrites it; its output is
a verdict list. `reporting-checklist-addressability` works on a deliverable
still before its first submission, and its whole point is to write into the
document under review so that every checklist row and every acceptance item
points at something a reader can open. One preserves a frozen artefact, the
other adds to a living one.

## Why each relation type was declined

| relation | the check that failed |
| --- | --- |
| `shared_part` | Every candidate shared operation turned out to be generic hygiene or a differently-shaped operation. Both re-derive counts from the artefact rather than from the sentence stating the total, but that is one clause of a count rule and names no operation narrower than both methods. The pointer work differs: `claim-verdict-audit` resolves a citation mark onward to a reference entry and then to the identifier that entry carries, while `reporting-checklist-addressability` carries a checklist row's address to a heading written into the document under review. Different pointer, different target, different consequence. |
| `subset` | Neither contains the other. The audit builds no checklist, writes nothing into the document under review and resolves no acceptance item; the checklist method places no verdict, retrieves no record and hunts no contradiction. Each adds what the other lacks, which is exactly what rules this type out. |
| `merge` | Triggers do not coincide — after acceptance versus before first submission — and inputs and outputs differ in kind, an artefact set and reference list against a study type, its item table and an acceptance list; a verdict list against a checklist file with an acceptance mapping. |
| `abstract_pattern` | The type needs three or more peers and the input carries two. |
| `conflicts_with` | The nearest pair is `claim-verdict-audit` Constraints, "The audit never rewrites the pack, and it states no clinical conclusion, dose, indication or recommendation of its own", against `reporting-checklist-addressability` Workflow step 3, "write that substance into the document under review at a heading of its own and address the row there". Read with each method's When to Use these are an ordered pair, not two opposite answers to one question: the first governs a pack that is already accepted, the second a document still in front of its first submission or back in repair. Nothing was ranked, reconciled or chosen, because there was nothing opposed to rank. |
| `supersedes` | Each method carries what the other lacks — the audit's instance inventory, double resolution, four-word verdicts, tier rule and contradiction hunt; the checklist method's item table copied row for row, item substance written in, acceptance mapping and protected-content re-verification. |

## What does relate them, and why it is not one of the six

The two are linked by a reference, not by a shared part. Inside
`reporting-checklist-addressability`, the last bullet of `## Verification` reads

> resolving a row's address to the passage that carries the item is the same
> routing check as pack-level claim verification [reuse method:
> claim-verdict-audit | when: a delivered pack must be re-checked instance by
> instance against the material its own pointers name | provides: routing-chain
> resolution for every pointer in the pack, with one verdict per instance].

The same link is declared downward outside the body, as a `depends_on` entry on
`claim-verdict-audit` carrying the digest
sha256:8bd4e4a2da0b5a92b4bfcaa8b68464bb4fffa542682848afafef1cd6d33f6e98: the
narrower method already depends on the wider one. A reference plus a dependency
is a relation of use, and the six types do not include it: `shared_part` would
extract an operation that is already a whole method being cited, and would cost
both methods work they still do on their own. That dependency declaration is not
part of the two bodies supplied here, so it is recorded as incoming context and
grounds no decision.

## Anchor review

Done before the file was finalised, against the frozen input only.

- 26 candidate passages were located word for word in the two bodies, and every
  passage quoted inside a notice was re-resolved the same way: 8 of 8 resolve,
  0 failures. Each quote names its method and its section, step number or
  bullet, so a reader can find it without searching.
- One quote failed the first pass and was repaired: a sentence had been trimmed
  to "The audit never rewrites the pack." The source sentence runs on, so the
  quote now carries it whole.
- Every method named anywhere in the file is one of the two in the population;
  a scan for name-like tokens outside it returns nothing.
- No clinical claim, effect estimate or recommendation appears in the file, and
  nothing in it asserts an approval or an evaluation verdict.

## Wording pass

The deliverable's prose was written in one register from the start and read back
against the two thinking-pattern passes at the end. Phrasing that named an
internal apparatus was removed; the one remaining filename is the output the
contract itself requires, and no tool, script or path from this run appears.
Every quoted passage, method name and relation type name was left exactly as it
stands, and the byte comparison after the rebuild touched none of them.

## What this decision does not do

No revision is emitted, because `decide` does not build: `revisions` is empty
and no method body was altered. Nothing was retired, and nothing was superseded.
If the population is later read as relating, the direction to look is downward —
the narrower method already leans on the wider one — not sideways.
