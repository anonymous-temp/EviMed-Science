# HaluMem concise-answer review, 2026-11-11

The only answer change is one ordinary-language instruction appended to the
user's question: answer in one or two sentences, only what was asked. The
question and its date remain unchanged in the saved record. Thinking stays
high, and the official HaluMem grading prompt stays pinned; Qwen is the judge.

| Arm | Correct / n | Accuracy | Wilson 95% |
| --- | --- | --- | --- |
| Keyword | 13 / 58 | 22.4% | 13.6–34.7% |
| No memory | 11 / 58 | 19.0% | 10.9–30.9% |
| Product | Not a complete replay | Not reported | Not reported |

The live product engine is beyond 50 of the 58 questions' checkpoints. Its
`--answers-only` guard rejects those questions; eight final-checkpoint concise
answers were saved. No guard was bypassed, checkpoint rewritten, or memory
re-ingested. Replaying retained evidence would be a different, explicitly
labelled measurement and is pending clarification. The original answer files
are preserved. Baseline concise results are in their original run directories
under `scores.concise`, and have append-only ledger rows.

Manual review: the first eight keyword failures and first seven no-memory
failures in saved score-row order. This is a diagnostic sample, not a random
estimate of the failure population. Every answer and its official judgement
was read; the categories below are the reviewer's, not a keyword classifier.
"Reference scope" means the core answer agrees but the judge penalizes detail
outside its selected key points. It does not independently establish that the
extra detail is true in the full conversation.

| Arm | Case prefix / question | Manual classification | Observation |
| --- | --- | --- | --- |
| Keyword | 8ece194a / s2:q0 | Reference scope | Correct snakes and cats; adds that he likes dogs. |
| Keyword | 8ece194a / s38:q10 | Reference scope | Correctly cannot name a sibling; adds parents and partner. |
| Keyword | 8ece194a / s41:q0 | Reference scope | Correctly reports no middle name recorded; judge rejects the statement that the recorded name is Johnson Joseph. |
| Keyword | 8ece194a / s46:q0 | Reference scope | Correct retirement status; adds B&B and mentoring context. |
| Keyword | 8ece194a / s63:q2 | Reference scope | Includes security and comfort; adds pet-friendly accommodation suggestions. |
| Keyword | 8ece194a / s76:q4 | Reference scope | Correct sibling abstention; adds relatives' birthdays. |
| Keyword | ed9b924b / s26:q1 | Missing/replaced key content | Omits playfulness; substitutes nature/countryside. |
| Keyword | ed9b924b / s40:q4 | Reference scope | Correct Poor → Good change; adds a causal attribution. |
| No memory | 8ece194a / s15:q2 | Omission | Abstains instead of recalling AI-generated social content. |
| No memory | 8ece194a / s2:q0 | Omission | Cannot name disliked pets. |
| No memory | 8ece194a / s46:q0 | Omission | Cannot recall retirement status. |
| No memory | 8ece194a / s63:q2 | Missing/replaced key content | Invents a plausible dog-friendly plan; omits security and comfort. |
| No memory | ed9b924b / s26:q1 | Missing/replaced key content | Generic creativity advice replaces playful/calm personal context. |
| No memory | ed9b924b / s2:q0 | Omission | Cannot recall the expressed dislike of marathon running. |
| No memory | ed9b924b / s40:q4 | Omission, plus name drift | Abstains and changes Donna to Donatella. |

Counts: reference scope 7/15; missing/replaced key content 3/15; omission 5/15.
All 15 answers fit one or two sentences, including the answers with reference
scope failures. Sentence count therefore does not guarantee reference-only
content. The baseline intervals overlap. The benchmark is still unsuitable
as an unqualified memory-accuracy comparison; the three-arm concise comparison
is additionally incomplete until the historical product-checkpoint issue is
resolved. No product score is inferred from its eight completed questions.
