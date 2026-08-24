# Skills shipped with the preset

`skill-filesystem` resolves `customSkillDirs` relative to the preset directory,
so the three general skill libraries are copied here at image-build time:

- `core/` — general research skills
- `curated-scientific/` — the vendored scientific skill packs
- `office/` — document production skills

Capability bodies are deliberately **not** here. A capability's SKILL.md is
pre-injected into the delegated child by `evimed_delegate`, which is what makes
`skillsLoaded` true by construction; leaving it loadable from the general root
would let a root agent read it and do the work itself, bypassing the contract
that delegation attaches.

Capsule methods are not here either — they are registered at runtime by the
`evimed-capsule` plugin from a deployment-owned read-only directory, so a
user's methods never travel through the workspace.
