// A data source nobody configured for this researcher is not a failed run
// (2026-10-04 ruling): the run goes on with the sources it has, the ledger keeps
// which ones it left out, and the conversation offers the form for them. What
// the account says about how many are waiting (2026-09-18, S4's asks) is
// unchanged.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CONNECTOR_CREDENTIALS, connectorMissingCode } from "@evimed/domain";

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

/** A research call that answered with a result and says which source it went without. */
function carriedOn(notConfigured) {
  return {
    type: "tool",
    tool: "evimed-research_evimed_literature_search",
    state: { status: "completed", output: JSON.stringify({ status: "warning", summary: "PubMed records.", data: { items: [], notConfigured }, warnings: ["EviMed 证据库 is not configured."], next_actions: ["Tell the user."] }) },
  };
}

test("a run whose research call met an unconfigured data source is answered, and the ledger names what it left out", async () => {
  const opengwas = await finishedWith([failedCall("public_source_opengwas_credential_missing")]);
  assert.equal(opengwas.result.status, "succeeded", "a missing credential is a recoverable result, never a failed run");
  assert.equal(opengwas.result.errorCode, null);
  assert.deepEqual(opengwas.result.connectorNeeds, ["opengwas"]);
  assert.equal(opengwas.listed.status, "succeeded");
  assert.deepEqual(opengwas.listed.connectorNeeds, ["opengwas"], "read back from the ledger, not only returned");
  assert.equal(opengwas.listed.missingCredential, undefined, "the failed-run field this replaced is gone");

  // A hyphenated connector: the gateway writes its id with underscores. And the
  // platform's own evidence API, which is a connector since 2026-10-04.
  const scholar = await finishedWith([failedCall("public_source_semantic_scholar_credential_missing")]);
  assert.equal(scholar.result.status, "succeeded");
  assert.deepEqual(scholar.result.connectorNeeds, ["semantic-scholar"]);
  const evidence = await finishedWith([failedCall("public_source_evimed_evidence_credential_missing")]);
  assert.deepEqual(evidence.result.connectorNeeds, ["evimed-evidence"]);

  // Every connector the registry names, none exempted: the set is derived.
  for (const spec of CONNECTOR_CREDENTIALS) {
    const one = await finishedWith([failedCall(connectorMissingCode(spec.id))]);
    assert.equal(one.result.status, "succeeded", spec.id);
    assert.deepEqual(one.result.connectorNeeds, [spec.id], spec.id);
  }

  // The MR engine's own refusal names the same need.
  const engine = await finishedWith([failedCall("mr_input_remote_auth_required")]);
  assert.equal(engine.result.status, "succeeded");
  assert.deepEqual(engine.result.connectorNeeds, ["opengwas"]);

  // A tool that went on without a source says so in its result, and that counts
  // the same; the sources are listed once each, in the order they were met.
  const fallback = await finishedWith([
    failedCall("public_source_core_credential_missing"),
    carriedOn(["evimed-evidence", "core", "not-a-connector"]),
    failedCall("public_source_core_credential_missing"),
  ]);
  assert.equal(fallback.result.status, "succeeded");
  assert.deepEqual(fallback.result.connectorNeeds, ["core", "evimed-evidence"]);

  // A run with no such call has no such need, and the field is absent rather than empty.
  const plain = await finishedWith([]);
  assert.equal(plain.result.status, "succeeded");
  assert.equal(plain.result.connectorNeeds, undefined);
  assert.equal(plain.listed.connectorNeeds, undefined);
});

test("every other tool failure still fails the run, and a code that only looks like a connector's names none", async () => {
  for (const code of ["invalid_input", "public_source_nonexistent_credential_missing", null]) {
    const other = await finishedWith([failedCall(code)]);
    assert.equal(other.result.status, "failed", String(code));
    assert.equal(other.result.errorCode, "runtime_tool_error", String(code));
    assert.equal(other.result.connectorNeeds, undefined, String(code));
  }
  // Left out one source and failed on another: the failure is still the verdict,
  // and nothing is recorded as "left out" on a run that did not finish.
  const both = await finishedWith([failedCall("public_source_umls_credential_missing"), failedCall("invalid_input")]);
  assert.equal(both.result.status, "failed");
  assert.equal(both.listed.connectorNeeds, undefined);
});

test("the inbox says a finished run left a source out and where to add it, and says nothing when it did not", () => {
  const notice = runFinishedNotice({ status: "succeeded", connectorNeeds: ["opengwas"], title: "孟德尔随机化分析", qualityNotices: [], artifacts: [] });
  assert.equal(notice.title, "孟德尔随机化分析 已完成", "the run finished; a source it went without does not make it 未完成");
  assert.match(notice.body, /OpenGWAS未配置，相关部分已跳过/);
  // Where the page is now (plan 2026-09-23 §5.9), not 「账户与额度 → 数据源凭据」.
  assert.match(notice.body, /「设置 → 数据源」/);
  assert.equal(notice.severity, "attention", "a source the researcher can add is theirs to act on");
  const several = runFinishedNotice({ status: "succeeded", connectorNeeds: ["umls", "core"], qualityNotices: [], artifacts: [] });
  assert.match(several.body, /UMLS、CORE未配置/);
  const plain = runFinishedNotice({ status: "succeeded", qualityNotices: [], artifacts: [] });
  assert.doesNotMatch(plain.body, /未配置|数据源/);
  assert.equal(plain.severity, "info");
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
