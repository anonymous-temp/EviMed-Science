// The native memory pieces over a real PostgreSQL and a stub engine, as the integration tests of the native path build them:
// a user, the engine stub, the sessions client, the overlay, the research-memory store, the page's store and the worker.
//
// Call `nativeIntegration()` once at module level; it registers the database's `before` / `after` hooks and returns the
// `skip` options and the `fixture` factory. The stub records what reached the engine, so "the engine was not asked" is
// asserted on its side.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before } from "node:test";

import { ControlPlaneDatabase } from "../../src/controlPlaneDatabase.mjs";
import { NativeMemoryOverlay } from "../../src/nativeMemoryOverlay.mjs";
import { NativeMemoryStore } from "../../src/nativeMemoryStore.mjs";
import { NativeMemoryWorker } from "../../src/nativeMemoryWorker.mjs";
import { OpenVikingClient } from "../../src/openVikingClient.mjs";
import { OpenVikingSessions } from "../../src/openVikingSessions.mjs";
import { ResearchMemoryStore } from "../../src/researchMemory.mjs";
import { migrateResearchMemory } from "../../src/researchMemoryPersistence.mjs";
import { resetNativeMemoryMetrics } from "../../src/nativeMemoryMetrics.mjs";
import { startOpenVikingStub } from "./openVikingStub.mjs";

/** @param {{ config?: Record<string, any> }} [settings] */
export function nativeIntegration({ config: settings = {} } = {}) {
  const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
  if (url) { const parsed = new URL(url); assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
  const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
  const config = { ovNativeMemoryEnabled: true, memoryContextLimit: 8, memoryContextMaxChars: 20_000, nativeMemoryReplayAttempts: 3, ...settings };
  /** @type {ControlPlaneDatabase} */
  let database;
  /** @type {string[]} */
  const users = [];

  before(async () => {
    if (!url) return;
    database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
    await migrateResearchMemory(database);
  });
  after(async () => {
    if (!url) return;
    for (const id of users) await database.query("DELETE FROM evimed_control.users WHERE id=$1", [id]);
    await database.close();
  });

  /**
   * A user, an engine stub, and the native pieces over them.
   * @param {import("node:test").TestContext} t
   * @param {{ extract?: (input: any) => any, config?: Record<string, any>, conversationTitles?: import("../../src/nativeMemoryStore.mjs").ConversationTitles | null }} [override]
   */
  async function fixture(t, { extract = () => ({}), config: extra = {}, conversationTitles = null } = {}) {
    resetNativeMemoryMetrics();
    const userId = `nm_${randomUUID().slice(0, 8)}`;
    users.push(userId);
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Native memory test','development')", [userId]);
    const stub = await startOpenVikingStub(t, { extract });
    const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" });
    const sessions = new OpenVikingSessions(client, { timeoutMs: 2_000, fastTimeoutMs: 1_000 });
    const overlay = new NativeMemoryOverlay({ database });
    const merged = { ...config, ...extra };
    const researchMemory = new ResearchMemoryStore(merged, { database });
    let clock = new Date("2026-10-13T08:00:00.000Z");
    const store = new NativeMemoryStore({ sessions, overlay, now: () => clock, conversationTitles });
    const worker = new NativeMemoryWorker({ config: merged, researchMemory, sessions, overlay, now: () => clock });
    const root = sessions.memoryRoot(userId);
    const engineUser = sessions.engineUser(userId);
    /** @param {string} relPath @param {string} text @param {{ type?: string, tags?: string[] }} [how] */
    const seed = (relPath, text, { type, tags = [] } = {}) => stub.seedMemory(engineUser, relPath, text, { type, tags });
    await sessions.register(userId);
    await overlay.noteRegistered(userId);
    /**
     * Put a conversation in the engine as the plugin would and commit it, entering the commit in the ledger as the gateway does.
     * @param {string} name the session's suffix @param {Array<{ role: string, text: string }>} messages
     * @param {{ projectId?: string | null, origin?: string, engineSession?: string }} [how] `engineSession`: the whole engine session name, for one the plugin did not derive from a conversation
     */
    async function commitConversation(name, messages, { projectId = null, origin = "gateway", engineSession = "" } = {}) {
      const session = engineSession || `dsh-session_${name}`;
      stub.sessions.set(`${engineUser}/${session}`, { id: session, user: engineUser, archives: 0, commitCount: 0,
        messages: messages.map((message) => ({ role: message.role, parts: [{ type: "text", text: message.text }] })) });
      const committed = stub.commitSession(engineUser, session);
      await overlay.recordCommit({ userId, archiveUri: committed.archive_uri, engineSession: session, projectId, origin, taskId: committed.task_id });
      return { session, ...committed };
    }
    return {
      userId, stub, sessions, overlay, researchMemory, store, worker, root, engineUser, seed, commitConversation,
      database, config: merged, advance: (/** @type {number} */ ms) => { clock = new Date(clock.getTime() + ms); }, now: () => clock,
    };
  }

  return { options, fixture, database: () => database };
}
