# Packed install probes (R18): run of 2026-11-09

Question answered: does each VCR bundle, built the way a release is built (`pnpm pack`), install into a DSH profile that has never seen this
repository, register its tools, accept a call, and leave cleanly, alone and together, standalone and inside the hosted composition?

Driver: `OpenScience/scripts/ops/vcr-packed-install-probe.mjs` (with `vcr-packed-install-probe/{packed-checks,hosted,absent}.mjs`); the
kernel-free half also runs in CI as `packages/research-plugin-runtime/test/packed-release.test.mjs`.

Setup of this run
- Source: `--source-ref HEAD` of branch `codex/vcr-in-silico-r2-20261108` at `c6f5ea298` (a committed export; the working tree held another
  stream's unfinished domain edit that did not parse, `Duplicate export of 'vcrModelRisk'`, so the working tree itself could not be packed).
- Kernel: DSH 0.2.2-rc.1 (the pin), the CLI and `@deepseek-ai/*` modules of F2's seeded profile `/tmp/isl2live/dsh-seed` (read only). Standalone
  profiles are created by the release's own `install.mjs` (`--from-default-profile headless`, `--offline`) in a private store; the hosted
  composition is a byte copy of F2's sealed seed (all five bundles, the socket, LoopX, the memory plugin), never the original.
- Engine: the isl2 tree's `vcr-engine`, R 4.3.3 library `/home/coder/R/vcr-4.3`; standalone calls run real R jobs.
- Result: **144 of 144 cases pass** (62 pack-time checks, 50 standalone, 32 hosted); about 8 minutes.

What each group proves
- Pack (62): nine tarballs by `pnpm pack` with a SHA-256 manifest; per tarball no `workspace:`/`file:` range survives, no `node_modules` or
  test file is packed; per bundle the `cordis.patch.yml` named in `dsh.bundle.patch` is in the tarball and names the plugin and its row,
  `./plugin` is exported, SKILL.md and examples are packed (the suite has none by design); the manifest names the DSH pin.
- Standalone, each of the five alone (7 cases each) and all five together: install from the packed artifact; the dumped config has exactly the
  installed rows; tools register and a call is accepted by the kernel's own `ToolRuntime` (trial `design.analytic` returns 331 required
  events, cohort `population.scenario`, patient `patients.binary`, control `comparator.evalue` each run a real engine job to `succeeded` and a
  report; the suite reports no tools alone and the trial's tool when the trial is installed with it); `dsh plugin remove` of each; the config
  has no VCR row afterwards; the profile manifest keeps no `@evimed` entry; `import('@evimed/<id>/plugin')` no longer resolves.
- Hosted composition on the copy: for each bundle, remove it (the config still builds and has no such row), install the packed tarball back
  (the config equals the original byte for byte), then mount the installed bundle alone beside a stand-in `evimedResearchAdapter` (the socket's
  provider in the real composition): its tools register, `verifyResearchAgent` (the control plane's own probe) accepts exactly that set, a call
  reaches the adapter, the other four bundles' tools are not visible, and everything leaves when the provider is disposed. Then all five removed
  in one command (no row, entries unresolvable), all five installed from the packed artifacts in one command (config again byte-equal), and
  all five mounted together (each call accepted, the suite sees the four, everything leaves with the provider).
- The hosted calls are stand-in adapter calls: they prove registration, routing and disposal of the packed bundles, not that a hosted
  control-plane adapter runs the engine (that is the live harness's and `composition.test.mjs`'s ground).

Found on the way (fixed where it was mine)
1. The in-repo installed probes were stale for DSH 0.2.2: a call now runs through the composition's selected executor as a batch, and a bare
   context without `@deepseek-ai/dsh-tool-executor-native` throws `ToolExecutorUnavailableError`. `packages/research-plugin-runtime/test/installed-native.mjs`
   and `packages/virtual-research-suite/installed-native.mjs` mount the executor and call with a batch now (the same pattern as
   `composition.test.mjs`). `test/dsh-cli-probe.sh` is the older, single-bundle shell form of this probe; it needs `dsh` on PATH and the kernel
   modules path and was not rerun, the new driver covers its cases.
2. `pnpm pack` refuses to run under a host pnpm whose major differs from the pinned `packageManager` (here 12 against 9.4.0) unless
   `pm-on-fail=ignore`; the driver and the CI test set it.
3. Root cause outside this stream: while this ran, `packages/domain/index.mjs` and `src/vcrModelUse.mjs` carried an uncommitted duplicate
   export of `vcrModelRisk` (another stream's work in progress): every bundle's import of `@evimed/domain` failed with a SyntaxError. A packed
   release of that tree would have shipped it; that is why the run packs a committed ref.
4. `dsh plugin remove` re-resolves the whole profile and needs registry metadata (`--offline` fails with a missing mirror); `add` of a
   tarball does not. A pnpm store other than the one the profile was linked from is refused, so the driver passes the profile's own store.

Not covered: Windows/macOS, the container image build itself (`deploy/runtime-dsh`, whose `research-bundles.mjs` uses the same pack and
install commands with the image's paths), a hosted adapter with a real engine behind it, and the hosted composition on an upgraded kernel.

Rerun
```
source isl2/env.sh; export pnpm_config_cache_dir=<a pnpm cache that holds the kernel closure's metadata>
node OpenScience/scripts/ops/vcr-packed-install-probe.mjs --work <new empty dir> --source-ref HEAD \
  --kernel-profile <seeded profile dir> --engine <vcr-engine root> --hosted-home <sealed DSH home> --results <file.json>
node OpenScience/scripts/ops/vcr-packed-install-probe.mjs --work <new dir> --pack-only     # kernel-free, seconds
```

## Rerun on the final revision (X2, wave 6)

Run at `a71830fa0` (branch `codex/vcr-in-silico-r2-20261108`, `--source-ref HEAD`, a committed export, so the later research-plugin catalogue
commit `fbabcb714`, the domain and manifest changes since `c6f5ea298`, and the removal of the explicit `studyId` from all research-plugin tool
schemas are in what was packed). Same kernel, seeded profile, hosted-home copy and engine as above. **144 of 144 cases pass** (the same 62 / 50 / 32).
The run answers the review's finding that the first run predated the catalogue changes; the 22 research-plugin tools now register without a
`studyId` property, and every call the probe makes is accepted without it.
