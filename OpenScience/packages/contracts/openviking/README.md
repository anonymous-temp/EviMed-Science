# OpenViking

The assertions that must pass before `deps-version.json`'s `openviking` pin may move.

OpenViking is the base stack's **recall index** — it ranks research memory and
capsule facts alike — and it is not a record store. The record stays in the
control-plane PostgreSQL because `POST /api/v1/content/write` offers `replace`,
`append` and `create` and no compare-and-swap: the `expectedVersion` that keeps
two concurrent edits of one record from silently losing one has no equivalent
here.

`fixtures/` was recorded off a running `v0.4.19`, never authored. `provenance.json`
says which server, when, how it was configured, and lists what the wire disagreed
with the documentation about — most importantly that trusted mode requires the API
key on every request once a root key is set, not only when asserting a role.

Run: `pnpm test:contracts`.
