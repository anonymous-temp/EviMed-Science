# OpenViking

The assertions that must pass before `deps-version.json`'s `openviking` pin may move.

OpenViking is evaluated as the **recall index** behind `memorySubstrate`, not as a
record store. The record stays in the research-memory service because
`POST /api/v1/content/write` offers `replace`, `append` and `create` and no
compare-and-swap: the `expectedVersion` that keeps two concurrent edits of one
record from silently losing one has no equivalent here.

`fixtures/` was recorded off a running `v0.4.19`, never authored. `provenance.json`
says which server, when, how it was configured, and lists what the wire disagreed
with the documentation about — most importantly that trusted mode requires the API
key on every request once a root key is set, not only when asserting a role.

Run: `pnpm test:contracts`.
