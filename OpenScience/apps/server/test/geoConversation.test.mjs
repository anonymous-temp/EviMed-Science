// A GEO project's own conversation (owner ruling B6, 2026-10-20): a project made before its conversation was recorded on it opens the
// oldest conversation no programme run opened — the one it was made with — never whichever of its conversations was touched last.
import assert from "node:assert/strict";
import test from "node:test";
import { oldestPersonalConversation } from "../src/geoService.mjs";

test("the fallback conversation is the oldest one of the person's, whatever order the list is in and whichever was touched last", () => {
  // The session list comes newest-touched first; the project's research conversation was made first and touched least recently.
  const sessions = [
    { sessionId: "sibling-touched-now", createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-25T08:00:00.000Z" },
    { sessionId: "step-run", createdAt: "2026-10-10T08:00:00.000Z", updatedAt: "2026-10-24T08:00:00.000Z" },
    { sessionId: "geo-research", createdAt: "2026-10-12T08:00:00.000Z", updatedAt: "2026-10-12T08:00:00.000Z" },
  ];
  assert.equal(oldestPersonalConversation(sessions, new Set(["step-run"])), "geo-research", "a programme step's session is never the person's");
  assert.equal(oldestPersonalConversation(sessions, new Set()), "step-run");
  assert.equal(oldestPersonalConversation([], new Set()), null);
  assert.equal(oldestPersonalConversation([{ sessionId: "only-step", createdAt: null }], new Set(["only-step"])), null);
});
