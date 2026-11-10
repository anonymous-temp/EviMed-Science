## Variant: a training-camp lesson (`trigger: camp`)

A `camp` lesson comes from the platform's training camp, never from a person's account: the platform ran a task whose
outcome a checker decided in code, and every finished run is a lesson, a failed one as much as one that succeeded.
Nobody corrected it, so `signal` is `run` and the evidence is what the run did. `camp.outcome` says what the checker
decided: `success`, the `score` where the task has one, and the checker's own `verdict`. `transcriptExcerpts` hold the
steps around the run's decisive actions (`anchor.kind: "decisive"`: where the checker's score moved, or where the task was
won) and, for a run that failed, its last steps (`anchor.kind: "closing"`). Each excerpt message is one step: what the run
reasoned, the action it took (a tool call, its `input`) and what came back (`output`). The excerpts are bounded; a step
left out is a gap, not something to reconstruct.

Read the run the way a coach reads a match: which actions carried it to its outcome, and would the same actions carry
another task of the same kind there. Everything above still applies — a method is a way of doing a kind of work, it is
stated for the kind and never for this one task's names and numbers, and the related methods come first.

- A run that succeeded teaches the way of working that won it, where that way would recur: the order of the sub-goals,
  the check that found what the task needed, the step that is easy to skip and cost the run nothing because it did not.
  What was specific to this task (its objects, rooms, files, values) becomes a variable, as section 1 says of a routine.
- A run that failed teaches a method only when you can say what to do instead — the action, the order or the check that
  would have avoided the dead end — and that rule would recur. "It failed here" is not a method, and nor is an account of
  what went wrong with no alternative. When the failure shows that a method on file misled the run in this situation, the
  answer is an `amend` of that method that names the situation in `counterexamples` and narrows `not_when` to exclude it,
  its body unchanged unless the evidence also says what to do instead. When it shows nothing that would recur, the answer
  is `no_change`, and `reason` says what you set aside.
- Quote the run's own reasoning or the request in `evidence`. The checker's verdict and a tool's output are what the
  world said, not what the run did; read them, do not quote them as the run's words.

For example: a run asked to merge two tables failed when the join silently matched nothing, because one key column held
numbers and the other the same numbers as text, and the checker found the merged table empty. The method is not "merging
failed"; it is what to do instead — before joining, compare the key columns' types and normalise them to one type — stated
for any join of two tables, with the failed run quoted where it reasoned about the join.
