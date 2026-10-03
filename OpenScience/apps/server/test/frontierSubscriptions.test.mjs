import assert from "node:assert/strict";
import { test } from "node:test";
import { FrontierSubscriptions } from "../src/frontierSubscriptions.mjs";
import {
  frontierVocabularyView,
  normalizeItemsQuery,
} from "../src/frontierService.mjs";
import { TEST_VOCABULARY } from "./helpers/frontierFixtures.mjs";

test("follow query accepts the combined view and rejects malformed ownership keys", () => {
  const vocabulary = frontierVocabularyView(TEST_VOCABULARY);
  assert.equal(
    normalizeItemsQuery(new URLSearchParams({ follow: "all" }), vocabulary)
      .follow,
    "all",
  );
  for (const follow of ["ALL", "-1", "all,1", "../1"]) {
    assert.throws(
      () => normalizeItemsQuery(new URLSearchParams({ follow }), vocabulary),
      { code: "frontier_query_invalid" },
    );
  }
});

test("combined subscription reads only the authenticated user's rows and preserves mutes", async () => {
  const calls = [];
  const subscriptions = new FrontierSubscriptions({
    database: {
      async query(sql, values) {
        calls.push({ sql, values });
        return {
          rows: [
            {
              id: 1,
              kind: "topic",
              key: "trial",
              label: "Trial",
              muted: false,
              created_at: "2026-10-01",
            },
            {
              id: 2,
              kind: "specialty",
              key: "cardiology",
              label: "Cardiology",
              muted: true,
              created_at: "2026-10-01",
            },
          ],
        };
      },
    },
    glossary: {
      async current() {
        return {
          entityKey() {
            return null;
          },
        };
      },
    },
  });
  const result = await subscriptions.read("alice", "all");
  assert.equal(result.selected, null);
  assert.equal(result.follows.length, 2);
  assert.equal(result.muted[0].id, "2");
  assert.match(calls[0].sql, /WHERE user_id=\$1/);
  assert.deepEqual(calls[0].values, ["alice"]);
  await assert.rejects(subscriptions.read("alice", "3"), {
    code: "frontier_follow_not_found",
  });
});
