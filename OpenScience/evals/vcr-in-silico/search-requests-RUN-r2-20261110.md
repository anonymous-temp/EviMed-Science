# R10 re-measure (round 2, stream L1): does the root conversation start a design search when asked

Frozen set and grader: `search-requests.json`, `search_live.py` (commits 925854281, 97410b924; unchanged). 20 conversations, 1 sample each, run alone and in sequence on the real DSH kernel with deepseek-v4-flash, one throwaway account each (deleted), turn limit 420 s as in the baseline. Revision under test **89d4311b7** (the baseline was 19b86b84a). Raw grade: `search-requests-RUN-r2-20261110.json`; transcripts under `vcrfix-handoff/isl2/LIVE-R2/transcripts/r10b-*`. Spend CNY 3.50.

| class | baseline (19b86b84a) | re-measure (89d4311b7) | plan target |
|---|---|---|---|
| explicit search requests (8) | 2 of 8 started | **1 of 8 started** (S05), 2 attempted (S07 refused by the form) | at least 80% |
| implicit (4) | 0 of 4 | 0 of 4 | - |
| single-design questions (8) | 0 of 8 | **0 of 8** | at most 10% |
| cut at the turn limit | 6 of 20 | 4 of 20 | - |

What the transcripts say (counted from the tool calls): 9 of the 12 search requests read the form (`vcr_simulate shape kind=search`), 2 started a search call, and of those one was refused (S07, `vary` with a range on `design.nTreat+design.nControl`, the reason not shown to the model) and one accepted (S05). The others, having read the form, answered with `design_analytic` / `design_grid` / their own arithmetic. The target of 80% is not met by this revision. Two defects found on the way are fixed in 2d98513f2 (the refusal now carries the domain's reason; a range on joined paths is accepted) and were NOT re-measured (no budget left): the expected effect is on S07-type refusals only.
