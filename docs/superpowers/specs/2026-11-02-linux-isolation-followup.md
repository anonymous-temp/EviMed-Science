# Linux isolation follow-up, 2026-11-02

## Observed boundary

The DSH runtime is per project. Concurrent sessions currently share its project workspace, runtime filesystem, `/tmp`, and `/dev/shm`. `deploy/runtime-dsh/evimed-landlock-run.sh` grants tools read access to `/` and write access to the bound workspace and those temporary locations. A separate session cwd does not make another run's data inaccessible, and replacing it without resolving native workspace registration, attachments, follow-up state and output import would not be a safe implementation of run isolation.

The production runtime image was not present in the local Docker image inventory. The host data volume had approximately 16 GiB available and reported 99% used. A full image build installs R, Chromium and substantial scientific Python dependencies, with intermediate build layers. No existing user images, volumes or caches were removed and the full build was not attempted on that volume. A production-like candidate still needs a suitably sized isolated Linux build host or an independently obtained matching runtime image, then a separate local control plane and database. Provider keys must remain in the control plane, never the runtime. Neither the product nor production was deployed or modified.

## Executed Linux checks

The existing local `evimed-analysis-replay:20261026` image was used for an offline analysis-script check, not as a DSH runtime or platform candidate. The container ran as UID/GID 65534, with no network, a read-only root, a bounded temporary filesystem, all Linux capabilities dropped, no-new-privileges, and memory/process limits. Only the statistical capability, its mirrored skill, evaluation files and a temporary Python test runner were mounted, all read-only. No production data or provider keys were mounted.

On Python 3.12, `test_analysis_checks.py`, `test_analysis_session.py` and `test_run_analysis.py` reported **96 passed, 2 skipped and 24 subtests passed**. This checks the deterministic analysis helpers and session records under Linux; it does not establish model behavior, browser upload, DSH isolation, full engine execution or the skipped cases. An earlier attempt without a test dependency and mirrored skill mount failed during setup; it was corrected before this result.

## Remaining acceptance

- Implement a per-run execution boundary covering filesystem reads and writes, scratch locations, child processes and runtime services, with explicit safe input snapshots and output promotion; handle simultaneous edits, cancellation, retries, session continuation and provenance without overwriting project files. Test the native workspace/session and upload contracts against the pinned kernel before enabling it.
- Build or obtain a verified matching Linux DSH image in an isolated environment with sufficient disk; validate the actual Landlock and network boundaries and ensure no provider key enters the runtime.
- Run the candidate through browser upload and actual DeepSeek/DSH turns for data analysis, managed bibliometrics, Meta literature retrieval and manuscript upload. Independently check scientific results and artifact provenance; retain failures and raw evidence.
- Fix and retest any defects found, including the native Markdown link rendering issue recorded in the preceding live findings. Passing the offline Python suite is not a substitute for these gates.
