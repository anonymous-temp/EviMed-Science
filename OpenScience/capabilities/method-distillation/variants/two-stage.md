## Variant: two-stage creation (`stage` in the input)

When the input carries `stage`, the lesson is distilled in two steps: the frame first, then the details. Everything above
still holds — what a method is, the evidence and scope rules, the `SKILL.md` and `method-candidate.json` formats, and that
`no_change` is a real answer. This section changes how many methods one lesson may yield and in which order they are
written. The principle is SkillPyramid's: a new skill is built on the library that exists, a lesson that a method on file
already covers reuses it instead of restating it, and only what nothing on file covers is written, each piece as its own
method at the level it belongs to.

**Step one, `stage: "frame"`.** Before any method, lay the lesson out against `relatedMethods`: which methods on file it
reuses as they stand, which sub-skills it needs that nothing on file covers, and whether it contradicts or extends one
method on file. Write `method-frame.json` and submit it under the `method-frame` contract:

```json
{"schemaVersion": 1,
 "reuses": [{"methodId": "...", "digest": "sha256:...", "why": "one line"}],
 "newSkills": [{"name": "kebab-case-name", "role": "atomic|functional|abstract", "summary": "one line", "buildsOn": ["names it builds on"]}],
 "amend": [{"methodId": "...", "digest": "sha256:...", "why": "one line: what the lesson contradicts or extends in it"}],
 "reason": "required when newSkills and amend are both empty"}
```

A sub-skill is a part of the work that a later task would do on its own, so that a method saying only it would be
loaded for it. Its `role` is where it sits: `atomic` — one operation done as a unit (inspect a container before taking
from it); `functional` — a short sequence that reaches one sub-goal and may reuse atomic methods; `abstract` — the plan of
a kind of task, its sub-goals in order and the decision points between them, naming the functional and atomic methods that
fill it. `buildsOn` names what it reuses, on file or new in this frame. Name a new sub-skill only where no method on file
already says it; a lesson that is a method on file done again reuses it, and an empty `newSkills` with a `reason` is a
common frame. List `amend` only for a method on file that this lesson contradicts or extends, never to restate it; a lesson
that merely repeats a method strengthens it and changes nothing. At most five new sub-skills; fewer is usual.

A method keeps the scope it was written for, and a level holds as many methods as there are kinds of work. An abstract
method is the plan of one kind of task; a lesson about another kind — one whose goal is reached through other sub-goals —
gets a plan of its own that reuses the functional and atomic methods the two kinds share, rather than an amendment that
widens the plan on file into one plan for several kinds. In the same way, a step that only some tasks need is a method of
its own that the plans needing it build on, not a branch added to a method every task loads. "Extends" means the same kind
of work done more completely: a missing check, a missing step or a wrong order in what the method is already for.

**Step two, `stage: "detail"`.** The input then carries the accepted `frame` and a `focus`: the one sub-skill to write now,
or the one method on file to amend. Write only that, as one candidate under the `method-candidate` contract:

- a new sub-skill is a `create` whose `name` is the focus's name and whose `metadata.role` is its role. Pin in `depends_on`
  every method it builds on that `relatedMethods` holds — the reused ones and the new ones of this frame already written,
  which are there with their digests — and put a reuse reference beside the passage that uses each. An abstract method's
  workflow is its sub-goals and decision points, each naming the method that carries it out; it does not repeat their steps.
- an amendment is an `amend` of the focus's method that adds what the lesson contradicts or extends and keeps the rest.
- written out, a sub-skill may turn out to be on file after all, or too thin to state without inventing what the run did
  not show: then `no_change`, with that reason.

For example: a lesson about turning a spreadsheet of trial sites into a weekly enrolment summary, against a library that
already holds a method for reading a sheet's header row before using its columns, gives a frame that reuses that method,
names two new sub-skills — an atomic one for checking that the enrolment counts add up to the stated total, and an
abstract one for the plan "read the sheet, check its totals, then summarise by site" that builds on both — and amends
nothing. Step two then writes the atomic method first and the abstract one after it, the abstract one pinning both.
