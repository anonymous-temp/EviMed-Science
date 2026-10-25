# Follow-up judge calibration

The follow-up judge is one small-model call in `apps/server/src/learningEvidence.mjs` (`FollowUpJudge`, instructions
`FOLLOW_UP_JUDGE_INSTRUCTIONS`, parser `followUpVerdictFrom`). It reads the first message of the next turn of a conversation and says
what it says about the work just delivered; what it decides becomes learning evidence, and a correction, a preference or a rejection
queues a distillation. Nothing measured how often it is right. This is that measurement: **129 labelled cases** (89 Chinese, 40 English)
over the five verdicts the module has and `adopt`, the sixth, that another package is adding (the person asks that the way the work was
just done be kept and reused for future work of this kind).

```bash
cd OpenScience
node evals/follow-up-judge/run.mjs --dry-run --only fj-001                    # the module's own request, no model call
node evals/follow-up-judge/run.mjs --key-file <path> [--model deepseek-flash]  # the whole set, one pass
node evals/follow-up-judge/run.mjs --key-file <path> --instructions-file my.txt --out results/my-wording.json   # try a rewording
node evals/follow-up-judge/run.mjs --list-ambiguous                            # the cases to review
node --test evals/follow-up-judge/tests/*.test.mjs                             # unit tests, no model
```

Options: `--only id,id`, `--lang zh|en`, `--samples N` (the judge runs at temperature 0, so one is nearly always enough), `--concurrency`
(default 4), `--out`. The key is read from `--key-file` or `DEEPSEEK_API_KEY`, held in memory and never printed or written.

## What the runner does

Nothing about the judge is copied. `FollowUpJudge.read` builds the request (messages, `temperature 0`, thinking off, JSON mode,
the truncations), the call is the control plane's own `callModelForControlPlane` (the production path minus the usage ledger), and the
answer is read by the module's own `followUpVerdictFrom`. A change to the instructions, the parameters or the parser in the tree is
therefore what is measured; `--instructions-file` replaces only the system message, to try a rewording before editing it in. The judge
sees `{ message, previousRequest, methods }` and **not** the one-line summary of what was delivered (`delivered` in the case file is
there for the labeller and the reviewer), so a case whose label depends on what the delivery looked like is marked ambiguous.

What the module refuses (an unknown verdict, a quotation that is not a substring of the message, a rule carrying a credential) is
`unreadable` here, as in production where it is no evidence at all, and the model's own word is kept as `rawVerdict`: a tree without
`adopt` refuses it, and the report tells that apart from a model that said something else.

## What it reports

Per-class precision, recall and F1; the confusion matrix (gold rows, predicted columns, `unreadable` last); accuracy strictly, leniently
(a prediction the label allows as a second choice) and on the unambiguous cases only; by language; quotation validity (accepted by the
module, and overlap with the gold words); the learned methods a verdict names (`concerns`, over the cases where the run opened one); and
**`adopt` on its own**: precision (strict and with the labels' second choices), recall, the cases wrongly adopted and the ones missed.
`adopt` makes a method out of one conversation, so its precision matters more than its recall: a missed adopt costs the person one more
sentence, a false one teaches the platform something they did not ask for. The near misses the set is built around are tagged in the
file (`tag`): 「这次就这样吧」 and "Fine for this time" (accept, not adopt), 「好的谢谢」, 「记住我喜欢短的」 (preference), 「格式就按这个，内容再补两条」
(correction), 「顺便帮我查一下 X」 (none), 「就按这个来吧，发出去」 (accept: this version, now), 「以后都用表格」 (a preference: it states a way, it
does not keep the one just used).

## The labelling rubric

One label per message, by the **main act of the message about the work just delivered**:

| Label | The message… | Examples |
|---|---|---|
| `correction` | says something in the delivered work is wrong, missing or not wanted, and asks for it to be changed — however short, however sarcastic | 「太长了」, 「第二个数字不对…」, "Great, another wall of text.", 「把「下周开始写方法部分」改成…」 |
| `preference` | states how they want this kind of work done (format, length, order, tools, style), as a rule that is not "keep the way just used" | 「记住我喜欢短的」, 「代码注释请用英文」, "I prefer bullet points", 「以后都用表格」 |
| `rejection` | throws the work away or asks for it to be redone from scratch in another way | 「不对，重新来，按表格的形式做」, "Scrap this and start over" |
| `accept` | approves the work, or builds on it as it is (send it, convert it, translate it) — including "for this time" and "for now" | 「好的谢谢」, 「这次就这样吧」, 「把这份转成 PDF」, "Good. Send it to Anna." |
| `none` | is about something else: a new question or task that says nothing about the work just finished | 「顺便帮我查一下阿司匹林的半衰期」, "By the way, what's the capital of Australia?" |
| `adopt` | asks that **the way it was just done** be kept and reused for future work of this kind, pointing at what was just done ("this", "that", "like this"), with a future scope ("from now on", "next time", 「以后」, 「下次」, 「存下来」) | 「以后周报都按这个来」, 「把刚才的做法存下来」, "From now on, do it like this." |

Rules for the boundaries:

* **`adopt` needs both**: it points at the way just used *and* reaches beyond this piece of work. 「就按这个来吧，发出去」 points at it but
  has no future (accept); 「以后周报都控制在三条以内」 has a future but states a new way instead of keeping this one (preference);
  「这次就这样吧」 and "Fine for this time" say outright that the scope is this time (accept).
* A message that approves and changes something small is a `correction` (「谢谢，不过第三条可以再短一点」), and one that keeps the format
  while asking for more content is a `correction` (「格式就按这个，内容再补两条」): the change is what the message asks for.
* A question about the delivered work that neither complains nor approves is `none` (ambiguous: it is `accept` if read as building on it).
* A new task of the same genre on other material is `none`; an addition to the finished work itself is a `correction` (it is missing).
* Sarcasm is read as what it complains about (「真是简洁啊，写了整整三页」 is a `correction`).
* When one message does two of these (a complaint and a standing rule; a keep-this-way and a small change) the label is the one a reader
  would name first, the other goes in `alsoAcceptable`, and the case is `ambiguous`.

## Cases the labeller hesitated over

`"ambiguous": true` with a one-line `why` (15 of 129; `--list-ambiguous` prints them). The controller reviews these: a label that
changes there changes only `class` / `alsoAcceptable`, never the message. The strict scores count the gold `class`; the lenient scores
also accept `alsoAcceptable`; `accuracyOnUnambiguous` leaves the 15 out.

## File shape

`cases.json`: `{ schemaVersion, classes, cases: [{ id, lang, class, previousRequest, delivered, message, quote, ambiguous, why?,
alsoAcceptable?, tag?, methodsOpened?, concerns? }] }`. `quote` is the gold quotation (the words of the message that carry the rule;
required for correction, preference, rejection and adopt, a substring of the message, null otherwise). `methodsOpened` lists learned
methods the run opened (`{ id, title, whenToUse }`) and `concerns` the ids the message is about (`[]` when none). Every request,
deliverable and message is invented. `score.mjs` holds the case-shape check and all the scoring; the tests pin both.
