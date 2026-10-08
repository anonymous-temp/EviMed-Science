// Which conversations used a document (N-16), against PostgreSQL and through the real routes: what a finished run recorded,
// listed newest first for the account that holds the document and nobody else.
import assert from "node:assert/strict";
import test from "node:test";
import { databaseUrl, ingestCorpus, signedIn } from "./helpers/knowledgeBaseApp.mjs";

const skip = !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured";
const GUIDELINE = "房颤抗凝指南.pdf";
const KIDNEY = "肾功能与抗凝.pdf";
const DIABETES = "糖尿病用药要点.pdf";

const use = (sourceId, kind, count, firstUsedAt, lastUsedAt) => ({ sourceId, kind, count, firstUsedAt, lastUsedAt });
/** @param {{ base: string, headers: Record<string, string> }} context @param {string} sourceId */
async function uses({ base, headers }, sourceId) {
  const response = await fetch(`${base}/api/sources/${sourceId}/uses`, { headers });
  assert.equal(response.status, 200);
  return (await response.json()).data.items;
}

test("a run's uses are recorded once, listed newest conversation first, one entry per conversation", { skip }, async () => {
  const context = await signedIn({ kbEmbedder: { configured: false, counters: {} } });
  try {
    const { app, user, project } = context;
    const [guideline, kidney] = await ingestCorpus(context, { names: [GUIDELINE, KIDNEY] });
    const t = Date.parse("2026-10-08T08:00:00Z");
    const record = (runId, sessionId, list) => app.sourceUses.record({ userId: user.id, projectId: project.id, runId, sessionId, uses: list });
    assert.equal(await uses(context, guideline.id).then((items) => items.length), 0, "nobody has used it");

    assert.equal(await record("run_a", "session_a", [use(guideline.id, "search", 2, t, t + 5_000), use(kidney.id, "read", 1, t, t)]), 2);
    // Another turn of the same conversation, and the same run's record written again: the second changes nothing.
    assert.equal(await record("run_b", "session_a", [use(guideline.id, "read", 1, t + 60_000, t + 60_000)]), 1);
    assert.equal(await record("run_a", "session_a", [use(guideline.id, "search", 2, t, t + 5_000)]), 1);
    // A later conversation.
    await record("run_c", "session_c", [use(guideline.id, "search", 1, t + 3_600_000, t + 3_600_000)]);

    const items = await uses(context, guideline.id);
    assert.deepEqual(items.map((item) => item.sessionId), ["session_c", "session_a"], "newest first");
    assert.deepEqual(items.map((item) => item.kinds), [["search"], ["read", "search"]]);
    assert.equal(items[1].runId, "run_b", "the conversation's latest run");
    assert.equal(items[1].uses, 3);
    assert.equal(items[1].firstUsedAt, "2026-10-08T08:00:00.000Z");
    assert.equal(items[1].lastUsedAt, "2026-10-08T08:01:00.000Z");
    assert.equal(items[0].projectId, project.id);
    assert.equal(items[0].title, null, "no ledger entry for the run: untitled, and still listed");
    assert.deepEqual((await uses(context, kidney.id)).map((item) => item.sessionId), ["session_a"]);

    // The row is the run's: recording it again from a fuller read widens it and never narrows it.
    await record("run_a", "session_a", [use(guideline.id, "search", 5, t - 10_000, t + 1_000)]);
    const widened = await app.store.database.query("SELECT uses, first_used_at, last_used_at FROM evimed_product.source_uses WHERE user_id=$1 AND source_id=$2 AND run_id='run_a'", [user.id, guideline.id]);
    assert.equal(widened.rows[0].uses, 5);
    assert.equal(widened.rows[0].first_used_at.toISOString(), "2026-10-08T07:59:50.000Z");
    assert.equal(widened.rows[0].last_used_at.toISOString(), "2026-10-08T08:00:05.000Z");
  } finally { await context.close(); }
});

test("only the account's own documents are recorded, and only the account that holds a document is told its uses", { skip }, async () => {
  const mine = await signedIn({ kbEmbedder: { configured: false, counters: {} } });
  const theirs = await signedIn({ kbEmbedder: { configured: false, counters: {} } });
  try {
    // The two accounts hold the same file (one source id, content-addressed), and the other holds one more of its own.
    const [mineDoc] = await ingestCorpus(mine, { names: [GUIDELINE] });
    const [sharedBytes, theirOwn] = await ingestCorpus(theirs, { names: [GUIDELINE, DIABETES] });
    assert.equal(sharedBytes.id, mineDoc.id);
    const t = Date.now();
    // A path in a transcript is text the model wrote: naming a document the account does not hold records nothing, and a
    // made-up id too.
    const written = await mine.app.sourceUses.record({ userId: mine.user.id, projectId: mine.project.id, runId: "run_x", sessionId: "session_x",
      uses: [use(theirOwn.id, "read", 1, t, t), use(`src_${"9".repeat(32)}`, "read", 1, t, t), use(mineDoc.id, "read", 1, t, t), use(mineDoc.id, "read", 2, t + 1, t + 2)] });
    assert.equal(written, 1, "and the same document and kind named twice is one row");
    assert.equal((await mine.app.store.database.query("SELECT uses FROM evimed_product.source_uses WHERE user_id=$1", [mine.user.id])).rows[0].uses, 3);
    assert.deepEqual(await uses(theirs, theirOwn.id), [], "their document has no use of mine");
    // The other account is told nothing of mine even where the bytes — and the id — are the same: each account's rows are its own.
    assert.deepEqual(await uses(theirs, mineDoc.id), []);
    assert.equal((await fetch(`${mine.base}/api/sources/${theirOwn.id}/uses`, { headers: mine.headers })).status, 404, "a document I do not hold is not mine to ask about");
    assert.equal((await fetch(`${mine.base}/api/sources/${mineDoc.id}/uses`, { headers: { ...mine.headers, cookie: "" } })).status, 401);
    await theirs.app.sourceUses.record({ userId: theirs.user.id, projectId: theirs.project.id, runId: "run_y", sessionId: "session_y", uses: [use(mineDoc.id, "search", 1, t, t)] });
    assert.deepEqual((await uses(mine, mineDoc.id)).map((item) => item.sessionId), ["session_x"]);
    assert.deepEqual((await uses(theirs, mineDoc.id)).map((item) => item.sessionId), ["session_y"]);
    // Nothing to record is nothing.
    assert.equal(await mine.app.sourceUses.record({ userId: mine.user.id, projectId: mine.project.id, runId: "r", sessionId: "s", uses: [] }), 0);
  } finally { await mine.close(); await theirs.close(); }
});

test("a document's deletion takes its uses with it, and so does its project's", { skip }, async () => {
  const context = await signedIn({ kbEmbedder: { configured: false, counters: {} } });
  try {
    const { app, user, project, base, headers } = context;
    const owner = await app.store.userById(user.id);
    await app.store.createProject(owner, "papers-b", "资料 B");
    const [guideline, kidney] = await ingestCorpus(context, { names: [GUIDELINE, KIDNEY] });
    const [other] = await ingestCorpus(context, { names: [GUIDELINE], projectId: "papers-b" });
    const t = Date.now();
    await app.sourceUses.record({ userId: user.id, projectId: project.id, runId: "run_a", sessionId: "session_a", uses: [use(guideline.id, "read", 1, t, t), use(kidney.id, "read", 1, t, t)] });
    await app.sourceUses.record({ userId: user.id, projectId: "papers-b", runId: "run_b", sessionId: "session_b", uses: [use(other.id, "search", 1, t, t)] });
    const count = async () => (await app.store.database.query("SELECT count(*)::integer AS n FROM evimed_product.source_uses WHERE user_id=$1", [user.id])).rows[0].n;
    assert.equal(await count(), 3);
    const removed = await fetch(`${base}/api/sources/${guideline.id}`, { method: "DELETE", headers, body: JSON.stringify({ expectedRevision: guideline.revision }) });
    assert.equal(removed.status, 200);
    assert.equal(await count(), 2, "the deleted document's rows are gone, its neighbours' are not");
    assert.equal((await fetch(`${base}/api/sources/${guideline.id}/uses`, { headers })).status, 404);
    const dropped = await fetch(`${base}/api/projects/papers-b`, { method: "DELETE", headers, body: JSON.stringify({ confirm: "papers-b" }) });
    assert.equal(dropped.status, 200);
    assert.equal(await count(), 1, "a project's rows go with the project");
    assert.deepEqual((await uses(context, kidney.id)).map((item) => item.sessionId), ["session_a"]);
  } finally { await context.close(); }
});
