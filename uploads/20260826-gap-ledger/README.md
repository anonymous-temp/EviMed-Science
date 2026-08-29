# 已核实缺口台账 2026-08-26

30 条。每条自带 verdict / verifiedBy / fixLocation / testLocation，
testLocation 为逐字测试标题（可 grep）。

| # | verdict | 验证方式 | 标题 |
|---|---|---|---|
| 0 | FIXED | mutation | syncRuntimeDshProfile's tests never set runtimeKernel:"dsh", so the ne |
| 1 | FIXED | mutation | Readiness compares `opencodeVersion` against a DSH manifest that no lo |
| 2 | FIXED | mutation | Both image-provenance readers require the `io.open-science.opencode.ve |
| 3 | FIXED | mutation | The server delivery gate looks for deliverables at the workspace root; |
| 4 | FIXED | mutation | evimed_submit_deliverable never supplies sourceArtifacts, so every quo |
| 5 | FIXED | mutation | The skillsLoaded completion check cannot be satisfied under DSH, becau |
| 6 | FIXED | mutation | The DSH→ledger projection hides every tool call from the delivery gate |
| 7 | DUPLICATE | mutation | The delivery gate reads required deliverables at the workspace root; t |
| 8 | FIXED | self-check+negative-control | `skillsLoaded` is unsatisfiable under DSH: the four agents' own skills |
| 9 | FIXED | self-check+negative-control | No test asserts the controller actually returns the container's captur |
| 10 | FIXED | self-check+negative-control | Nothing checks the include's "patch: entry … not found" warning, the e |
| 11 | FIXED | mutation | OPEN_SCIENCE_RUNTIME_ASK_USER and OPEN_SCIENCE_RUNTIME_REVIEW_ENABLED  |
| 12 | FIXED | mutation | The "patch only names rows the composition has" test is checked agains |
| 13 | FIXED | self-check+negative-control | The release manifest binds no DSH runtime source at all, and the compl |
| 14 | FIXED | mutation | Vendored community skills ship as model-facing instructions but are bo |
| 15 | FIXED | self-check+negative-control | The two dsh_build_smoke compliance checks pass even when the Dockerfil |
| 16 | FIXED | mutation | `turn/end` is dropped by the ledger projection, so a turn the kernel e |
| 17 | FIXED | mutation | `artifactCandidates` reads `filePath`/`path`; DSH's fs tools take `fil |
| 18 | FIXED | mutation | The run-mirror projection is read from the container path on the host, |
| 19 | FIXED | self-check+negative-control | No build step or test ever runs the runtime image under a single produ |
| 20 | FIXED | mutation | Production /tmp is a 64 MB tmpfs; the kernel spills subprocess and too |
| 21 | FIXED | mutation | coverageJudgeTimeoutMs is clamped to 300 s by its reader, silently dis |
| 22 | FIXED | mutation | delegatedDocumentReads still matches OpenCode's `task` tool, so under  |
| 23 | FIXED | mutation | An unreadable or empty capabilities directory empties the catalogue si |
| 24 | FIXED | self-check+negative-control | web.yml, the only gate on PRs and main, runs no ESLint and skips five  |
| 25 | FIXED | self-check+negative-control | The clinical repair prompt orders the run to execute a preflight scrip |
| 26 | FIXED | unverified | The preset's four skill roots are relative paths, which DSH resolves a |
| 27 | FIXED | unverified | compactRuntimeOutput's line filters cannot fire on controller-reported |
| 28 | FIXED | unverified | appendCappedOutput keeps the first 4096 bytes, but both new call sites |
| 29 | FIXED | golden-fixture+negative-control | A malformed deliverable is reported as two dozen content problems, nev |
