// A run that failed because a data source had no credential says which one,
// and the account says how many are waiting (2026-09-18, S4's asks).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentRunStore } from "../src/agentRuns.mjs";
import { runFinishedNotice } from "../src/notificationService.mjs";
import { createWebApiApp } from "../src/server.mjs";

/** @param {string | null} code */
function failedCall(code) {
  return {
    type: "tool",
    tool: "evimed-research_evimed_biomedical_source_search",
    state: { status: "error", error: JSON.stringify({ status: "error", error: code ? { code } : {} }) },
  };
}

async function finishedWith(parts) {
  const root = await mkdtemp(path.join(tmpdir(), "os-run-credential-"));
  try {
    const project = { id: "p1", userId: "u1", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = { sessionId: "ses_credential", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    let history = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-flash", readSessionHistory: async () => history, readSessionStatus: async () => "idle",
    });
    store.scheduleMonitor = () => {};
    await store.start(project, { sessionId: binding.sessionId });
    history = [{
      info: { id: "msg_credential", role: "assistant", time: { completed: Date.now() + 10 } },
      parts: [...parts, { type: "text", text: "没能完成。" }],
    }];
    const result = await store.reconcileSession(project, binding.sessionId);
    const [listed] = await store.list(project);
    await store.closeAll();
    return { result, listed };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a run failed for a missing connector credential names the connector, as the sub-code and as its own field", async () => {
  const opengwas = await finishedWith([failedCall("public_source_opengwas_credential_missing")]);
  assert.equal(opengwas.result.status, "failed");
  assert.equal(opengwas.result.errorCode, "runtime_tool_error", "the stable code other readers key on stays");
  assert.equal(opengwas.result.errorSubCode, "opengwas");
  assert.equal(opengwas.result.missingCredential, "opengwas");
  assert.equal(opengwas.listed.missingCredential, "opengwas", "read back from the ledger, not only returned");
  assert.equal(opengwas.listed.errorSubCode, "opengwas");

  // A hyphenated connector: the gateway writes its id with underscores.
  const scholar = await finishedWith([failedCall("public_source_semantic_scholar_credential_missing")]);
  assert.equal(scholar.result.missingCredential, "semantic-scholar");

  // Any other failure names no credential; a code that only looks like one
  // names none either.
  for (const code of ["invalid_input", "public_source_nonexistent_credential_missing", null]) {
    const other = await finishedWith([failedCall(code)]);
    assert.equal(other.result.status, "failed", String(code));
    assert.equal(other.result.missingCredential, undefined, String(code));
    assert.equal(other.result.errorSubCode, undefined, String(code));
  }
});

test("the inbox tells the researcher which credential to add, not that a tool failed", () => {
  const notice = runFinishedNotice({ status: "failed", errorCode: "runtime_tool_error", missingCredential: "opengwas", qualityNotices: [], artifacts: [] });
  assert.equal(notice.title, "一项研究 未完成");
  assert.match(notice.body, /缺少 OpenGWAS 的访问凭据/);
  // Where the page is now (plan 2026-09-23 §5.9), not 「账户与额度 → 数据源凭据」.
  assert.match(notice.body, /「设置 → 数据源」/);
  assert.equal(notice.severity, "attention");
  const plain = runFinishedNotice({ status: "failed", errorCode: "runtime_tool_error", qualityNotices: [], artifacts: [] });
  assert.doesNotMatch(plain.body, /凭据/);
});

test("the account payload counts the data sources waiting for a credential", async () => {
  const run = async (overrides, check) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "os-me-credentials-"));
    const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, ...overrides });
    const address = await app.listen(0, "127.0.0.1");
    try {
      const me = (await (await fetch(`http://127.0.0.1:${address.port}/api/me`)).json()).data;
      await check(me);
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
  await run({}, (me) => assert.equal(me.missingConnectorCredentials, 0, "a deployment that keeps no personal credentials has nothing to ask for"));
  await run({
    connectorCredentials: {
      async migrate() {},
      async status() {
        return [
          { id: "opengwas", source: "none", needsAttention: true },
          { id: "unpaywall", source: "deployment", needsAttention: false },
          { id: "core", source: "user", needsAttention: false },
          { id: "omim", source: "none", needsAttention: true },
        ];
      },
    },
  }, (me) => assert.equal(me.missingConnectorCredentials, 2));
  await run({
    connectorCredentials: { async migrate() {}, async status() { throw new Error("database down"); } },
  }, (me) => assert.equal(me.missingConnectorCredentials, 0, "the shell renders whatever the store says"));
});
