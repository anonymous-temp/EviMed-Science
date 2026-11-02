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

## Follow-up candidate image

After the owner authorized safe cleanup, disposable files from the previous candidate and unused Docker build cache were removed. A full arm64 Linux candidate runtime was built locally as `evimed-research-candidate:20261102`, image ID `sha256:cf9592a43274c9fe43346fc9fbce5a770167dfa58974442d6a8eb40e7b575e27`. The candidate base was derived from the locally present Node Debian 12 image with inherited image configuration removed; it is not the production Dockerfile's default base. The existing exact version and hash checks remained enabled. DSH reports `0.2.1-rc.5` in a network-disabled, read-only container.

The first full build was stopped when the Docker VM filesystem reached 383 MiB free; its own intermediate layers were removed and only unused build cache was pruned. Containers, data volumes and tagged images belonging to other work were not removed. The replacement build completed after VM free space recovered. This shows why host filesystem free space alone is not a Docker VM capacity check.

The candidate passed `deploy/runtime-dsh/check-tool-sandbox.sh` after a syntax error in that script was fixed. The real offline image check exercised Landlock write restrictions, `/tmp` and `/dev/shm`, cancellation, the memory guard, Python parallel execution, and the specified R and Python analysis libraries. A separate offline probe started two independent analysis-image containers concurrently, with read-only roots, no network and separate workspace and `/tmp` mounts; same-named results and temporary files remained separate and each container could not see the other's sentinel. The latter proves only that this container arrangement isolates those test files. Neither check integrates per-run containers into EviMed or tests DSH tool calls across concurrent product runs.

The candidate is an image, not an independently running candidate control plane with the managed specialist services and model gateway. No candidate-model or browser workflow is asserted. Per-run product isolation, safe input/output promotion and continuity, real managed bibliometrics, Meta retrieval, peer-review upload and natural-language analysis replays remain open.
