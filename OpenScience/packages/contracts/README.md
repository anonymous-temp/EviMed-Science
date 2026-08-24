# Upstream contract tests

One directory per tracked dependency, named in `deps-version.json`. Each holds
the assertions that must pass before that dependency's pin may move, and the
golden fixtures those assertions replay.

The rule that produced this layout: **we do not promise "zero changes" on an
upgrade, we promise "the change is locatable, revertible, and one PR"**. A
contract test that fails must name the seam it failed on, so the upgrade PR
starts from a location rather than from a search.

There is one nightly job, and it loops over the keys in `deps-version.json`.
Four copies of the same four-part discipline was the thing v3.5 removed.
