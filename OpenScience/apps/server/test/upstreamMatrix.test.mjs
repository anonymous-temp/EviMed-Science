// The nightly matrix tells an operator whether a pin is behind. What it says
// has to be about the product that is pinned.
import assert from "node:assert/strict";
import test from "node:test";

import { selectReleaseVersion } from "../../../scripts/ops/upstream-compat-matrix.mjs";

// Trimmed from the real MemTensor/MemOS feed, newest first. The repository
// ships two products: MemOS itself (`v2.0.30`, what `deps-version.json` pins)
// and a separate local plugin. `releases/latest` answers with whichever was
// published most recently, which was the plugin.
const memosFeed = [
  { tag_name: "memos-local-plugin-v2.0.17", published_at: "2026-08-24T07:58:35Z" },
  { tag_name: "memos-local-plugin-v2.0.17-beta.1", prerelease: true, published_at: "2026-08-24T07:03:53Z" },
  { tag_name: "memos-local-plugin-v2.0.16", published_at: "2026-08-16T05:43:54Z" },
  { tag_name: "v2.0.30", published_at: "2026-08-14T04:00:00Z" },
  { tag_name: "memos-local-plugin-v2.0.15", published_at: "2026-08-12T12:28:36Z" },
];

test("a release belonging to another product in the same repository is not read as this one's version", () => {
  // Live, this reported `memos 2.0.30 → memos-local-plugin-v2.0.16`: not a
  // version, a different product, and a downgrade — an upgrade instruction an
  // operator could have followed.
  assert.deepEqual(selectReleaseVersion(memosFeed), { latest: "2.0.30", reason: "github" });
});

test("a project whose own tags are not plain versions can say so", () => {
  assert.deepEqual(
    selectReleaseVersion(memosFeed, "^memos-local-plugin-v"),
    { latest: "memos-local-plugin-v2.0.17", reason: "github" },
  );
});

test("drafts and prereleases are not what a pin should be compared against", () => {
  const feed = [
    { tag_name: "v9.9.9", draft: true },
    { tag_name: "v9.9.8", prerelease: true },
    { tag_name: "v4.2.5" },
  ];
  assert.equal(selectReleaseVersion(feed).latest, "4.2.5");
});

test("no matching release is unknown, never silently current", () => {
  // A matrix that reports green because it could not look is a matrix that
  // reports green forever — the same rule the offline path already follows.
  const result = selectReleaseVersion([{ tag_name: "nightly-2026-08-24" }]);
  assert.equal(result.latest, null);
  assert.match(result.reason, /no release tag matched/);
  assert.equal(selectReleaseVersion([]).latest, null);
});
