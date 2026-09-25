# geo-private — the private GEO method pack root

This directory is a skill root the runtime image ships (`/opt/evimed/skills/geo-private`, and the preset's
`skills/geo-private`, whose `skills/` is one of the preset's skill directories). It holds the owner's GEO method
pack — `skills/<name>/SKILL.md` and `shared/` (what those skills call `$GEO_LIB`) — which is proprietary.

**Nothing here but this README is in git**, and nothing may be: the repository is public. `.gitignore` ignores
everything under this directory except this file.

To populate it on a build machine:

```bash
node scripts/build/vendor-geo-skills.mjs            # verifies the archive's sha256 against SHA256SUMS, then unpacks
node scripts/build/vendor-geo-skills.mjs --check    # verify only
```

The archives and their `SHA256SUMS` live outside the repository (`.evimed-local/geo/dist/` by default; `--dist` or
`EVIMED_GEO_SKILLS_DIST` to point elsewhere). The script takes the newest `geo-skills-<version>.zip` that
`SHA256SUMS` lists and the directory holds (`--version x.y.z` pins one), is idempotent, and writes `VENDORED.json`
naming the archive and its digest.

With only this README present — a fresh clone — the image still builds, the four 「循证 GEO」 capabilities
(`geo-insight`, `geo-strategy`, `geo-content`, `geo-proposal`) still load, and a run that cannot find a `geo-*`
skill says the method pack is not installed and continues with the capability's own short method.
