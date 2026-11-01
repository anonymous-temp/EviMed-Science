# GEO connected journey handoff

This change connects project discovery, the workbench and the existing native conversation around one project, primary session, requested scope and next action. The eight execution steps and their result destinations remain. It introduces no new editor, model proxy or workflow database.

## Product behavior

- Project preview and workbench show the same current work and continuation target. Result and article actions open unsent, scoped drafts in the existing conversation; article revisions preserve the selected version and content digest.
- New projects offer three task intents with concrete input guidance. Empty engine descriptors do not create fake observations or charts; measured zero, partial data and unavailable reads remain distinct.
- A verified ordinary GEO primary can read/write its project in a short conversational turn. Authority comes from the authenticated original request and is revalidated before the frozen route is read. Selected-result modes retain their narrower access.
- Explicit requests drive the dependency graph. Completing or locking questions does not commission all eight steps, content, publication or recurring spend. Legacy unconfirmed requests await a new choice; accepted work and retained results remain accessible.
- Recurring measurement is a separate explicit choice tied to the selected engines and coverage. Saved contracts cannot expand that choice. Stopping and automatic confirmation creation serialize on the project row; accepted tasks may finish. Actual rounds determine running status.
- Targets are explicit project goals, not guarantees of external AI behavior. The universal 98% admission floor is removed. Current project-wide goals are not silently applied to filtered or historical comparisons.

## Private methods and future builds

The public repository contains no private method bodies. The separately delivered `geo-skills-3.1.0.zip` contains 51 named methods with preserved analytical content, active references, section/change ledgers and offline QA. It replaces standalone paid execution with platform-owned operations. Findings annotate work; readable results are not withheld by an advisory method check.

Reviewed archive SHA-256:

`1908c9553168876f37cff5af0d60f53e1c3ed1a2fbebe1e48a1efffcbf23f22e`

The public `deploy/runtime-dsh/geo-method-pack-release.json` binds version, archive digest, tree digest and exact skill names. All three runtime image recipes check it. Before a future build, place the private archive and its `SHA256SUMS` in the maintainer's private GEO dist directory, then run:

```sh
node scripts/build/vendor-geo-skills.mjs --version 3.1.0
node deploy/runtime-dsh/check-geo-method-pack.mjs runtime/skills/geo-private
```

A fresh public checkout may explicitly build without the private pack. A delta image carrying an older private pack fails the release check and requires the matching archive. Code push does not update online skills.

## Verification and limits

Focused GEO web tests (900), later native/frame/status regressions (154), domain/bridge contracts (190), private-pack refresh/binding tests (12), authorization and orchestration PostgreSQL suites, native HTTP/MUX scope regressions, types, lint, generated metadata, kernel seams and credential audit passed. These groups overlap and are not a unique-test total. The private pack passed 31 checks and 16 helper regressions, plus CRC/vendor and independent method/helper review.

A disposable local database and actual DSH + DeepSeek calls demonstrated native product write/readback, workbench and list consistency, return to the same primary frame, and a second-turn revision preserving other fields. The database retained zero measurement rounds and zero probe jobs. An independent in-app browser opened a new project without retry and restored the composer after refresh in about 1.5 seconds.

The existing Chrome automation environment repeatedly required a retry for the initial native document. The independent browser did not reproduce it; cause remains unconfirmed. Do not describe that compatibility issue as fixed. The live fixture used a local process provider, not the production container stack. Full consumer-AI/social-connector campaigns, every clinical method on a real product, CI on the pushed commit and production activation remain separate evidence. No deployment was performed.

The detailed plan and local proof index are in `docs/superpowers/plans/2026-10-31-geo-connected-journey.md` at the repository root. Private screenshots, live readback receipts and test logs are retained under the maintainer's ignored `outputs/audit/geo-connected-journey-20261031/` directory.
