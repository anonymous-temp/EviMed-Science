# runtime/skills

Scientific skills, layered:

```text
skills/
  core/      # self-authored skills specific to this app (traceability-review;
             # other dirs are roadmap placeholders until they get a SKILL.md)
  curated-scientific/ # reviewed skills with an exhaustive delivery inventory
  office/    # first-party MIT baseline Office artifact exporters
  community/ # ecosystem skills, vendored at pinned commits (sources.json)
  evimed/    # our own agent packages (agent.yaml + SKILL.md). The eleven
             # specialists reach a run as capability bodies under
             # `capability-skills/`; only `open-domain-answer` ships from here
  external/  # third-party skill packs, fetched by script — git-ignored
```

There is no `user/` tree, and the omission is the point: the runtime workspace is
where users upload files, so a skill root inside it would make an uploaded
`SKILL.md` an instruction. Skill roots are deployment-owned and read-only, and
the preset turns the kernel's own default root discovery off to keep it that way
(`packages/socket/presets/evimed-universal/agent.cordis.yml`).

Where a tree lands in the runtime image is declared once, in
`RUNTIME_SKILL_ROOTS` (`packages/domain/src/skillRoots.mjs`) — that declaration
is both what a run is told and what a test holds against the Dockerfile's `COPY`
targets. Skill bodies therefore reference their own scripts *relatively* and
name no deployment path at all — the previous convention, where each body
spelled out an absolute root, is how 45 bodies came to name a directory that no
longer existed. Directories without a `SKILL.md` are skipped.

## Default pack: ai4s-skills (bundled into the installer)

The default scientific skills come from
[ai4s-research/ai4s-skills](https://github.com/ai4s-research/ai4s-skills)
(research-explorer, literature-survey, experiment-suite, paper-writer,
integrity-auditor, mindmap-render, ai4s-agent).

How they ship, end to end:

1. `scripts/dev/fetch-skills.sh` (run locally and in CI) downloads the pack at a
   pinned commit into `external/ai4s-skills/`.
2. `tauri.conf.json` bundles that directory as an app resource (`resources/skills/`).
3. On every runtime start, `runtime.rs::deploy_bundled_skills` syncs the pack
   into the app-private profile's skills directory, which the runtime loads as a
   root regardless of which project is open. Bundled skill directories are
   replaced on app upgrade, and only bundled ones: everything else the directory
   holds is left alone.

To bump the pack version, update `AI4S_SKILLS_COMMIT` in `fetch-skills.sh`.

## Office pack: first-party exporters

The `office/` pack contains EviMed-owned MIT implementations for baseline DOCX,
PDF, PPTX, and XLSX export. Each skill has an executable standard-library script,
an explicit artifact boundary, and an independent smoke test. The restricted
Anthropic document skills under a developer's ignored `external/` cache are not
fetched, copied into images, or bundled into desktop installers.

These exporters are deliberately narrow. They establish a real cross-runtime
artifact chain without claiming full Office editing or layout fidelity.

## Curated scientific delivery tiers

`curated-scientific/inventory.json` is the delivery contract for all 38 reviewed
scientific packages. Each package now has a bounded executable baseline, pinned
dependencies, declared artifacts, and a retained execution receipt. The shared
`_runtime/` support directory is deployed with those packages but is not exposed
as a separate Skill.

These baselines make the packages operational without overstating their scope.
For example, the imaging packages accept derived numeric features rather than
decoding DICOM or whole-slide pixels, and the RNA-seq baseline performs QC rather
than a complete differential-expression workflow. Each report states its method
boundary and directs the agent to a domain implementation when the requested
analysis exceeds that boundary.

## Third-party skills

Do **not** enable large third-party collections (e.g. ~148 K-Dense skills) by
default. Use curated install, enable by domain, and always surface each skill's
license, dependencies, and risk.

Each skill directory must contain a `SKILL.md`.
