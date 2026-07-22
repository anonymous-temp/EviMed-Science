import assert from "node:assert/strict";
import test from "node:test";
import { MemoryIntelligence } from "../src/memoryIntelligence.mjs";

class MemoryStoreDouble {
  constructor() {
    this.records = new Map();
    this.nextId = 1;
  }

  async listRecords() {
    return [...this.records.values()];
  }

  async upsertRecord(_userId, input, evidence, options = {}) {
    const key = [input.scope, input.scopeId ?? "", input.kind, input.key].join("\u0000");
    const existing = this.records.get(key);
    if (existing && options.expectedVersion > 0 && options.expectedVersion !== existing.version) {
      const error = new Error("conflict");
      error.code = "memory_conflict";
      error.status = 409;
      throw error;
    }
    const proofs = [...(existing?.evidence ?? [])];
    if (evidence && !proofs.some((item) => item.sourceRef === evidence.sourceRef && item.quote === evidence.quote)) {
      proofs.push({ ...evidence, fingerprint: `proof_${proofs.length + 1}` });
    }
    const changed = existing && (existing.value !== input.value || existing.summary !== input.summary || existing.status !== input.status);
    const record = {
      ...existing,
      ...input,
      id: existing?.id ?? `record_${this.nextId++}`,
      version: existing ? existing.version + 1 : 1,
      evidence: proofs,
      evidenceCount: proofs.length,
      revisions: changed ? [...(existing.revisions ?? []), { version: existing.version }] : (existing?.revisions ?? []),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(key, record);
    return record;
  }
}

const config = {
  deepseekProviderEnabled: true,
  deepseekApiKey: "unit-test-key",
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-pro",
  memoryExtractionEnabled: true,
  memoryExtractionTimeoutMs: 1_000,
};

function project() {
  return { id: "project_1", userId: "user_1" };
}

function run(id = "run_1") {
  return {
    id,
    sessionId: "session_1",
    mode: "open-domain",
    agentId: null,
    agentVersion: null,
    effectiveAgentId: "clinical-evidence-synthesis",
    effectiveAgentVersion: "1.0.0",
    effectiveRuntimeAgent: "research",
    model: "deepseek/deepseek-v4-pro",
    status: "succeeded",
    errorCode: null,
    artifacts: ["reports/result.md"],
    startedAt: "2026-07-22T01:00:00.000Z",
    finishedAt: "2026-07-22T01:01:00.000Z",
    durationMs: 60_000,
  };
}

function message(id, text) {
  return { info: { id, role: "user" }, parts: [{ type: "text", text }] };
}

function modelFetch(candidateFactory) {
  return async (_input, init) => {
    assert.match(init.headers.Authorization, /^Bearer /);
    const request = JSON.parse(String(init.body));
    const payload = JSON.parse(request.messages[1].content);
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ candidates: candidateFactory(payload.sources) }) } }],
    });
  };
}

test("memory extraction accepts only candidates backed by an exact source quote", async () => {
  const store = new MemoryStoreDouble();
  const text = "以后回答请优先引用原始研究，并明确说明证据不确定性。";
  const intelligence = new MemoryIntelligence(config, store, {
    fetchImpl: modelFetch((sources) => [{
      scope: "user",
      kind: "preference",
      key: "response.primary_evidence",
      value: "Prefer primary studies and explicit uncertainty.",
      summary: "Primary evidence first; preserve uncertainty.",
      origin: "explicit",
      confidence: 1,
      importance: 0.9,
      sensitive: false,
      sourceRef: sources[0].sourceRef,
      evidenceQuote: text,
    }]),
  });
  const result = await intelligence.recordRun(project(), run(), [message("user_1", text)]);
  assert.equal(result.extracted, 1);
  const conversation = [...store.records.values()].find((record) => record.kind === "run_summary");
  assert.equal(JSON.parse(conversation.value).question, text);
  assert.equal(JSON.parse(conversation.value).effectiveAgentId, "clinical-evidence-synthesis");
  assert.equal(JSON.parse(conversation.value).effectiveRuntimeAgent, "research");
  const preference = [...store.records.values()].find((record) => record.kind === "preference");
  assert.equal(preference.status, "active");
  assert.equal(preference.evidence[0].quote, text);
});

test("memory extraction rejects a plausible but unsupported model claim", async () => {
  const store = new MemoryStoreDouble();
  const intelligence = new MemoryIntelligence(config, store, {
    fetchImpl: modelFetch((sources) => [{
      scope: "user",
      kind: "profile",
      key: "profile.employer",
      value: "Works at a university hospital.",
      summary: "University hospital employee.",
      origin: "inferred",
      confidence: 0.9,
      importance: 0.7,
      sensitive: false,
      sourceRef: sources[0].sourceRef,
      evidenceQuote: "I work at a university hospital.",
    }]),
  });
  const result = await intelligence.recordRun(project(), run(), [message("user_1", "请分析这个研究方案。")]);
  assert.equal(result.extracted, 0);
  assert.equal([...store.records.values()].filter((record) => record.kind === "profile").length, 0);
  assert.equal([...store.records.values()].filter((record) => record.kind === "run_summary").length, 1);
});

test("inferred memory remains pending until three independent exact observations", async () => {
  const store = new MemoryStoreDouble();
  const intelligence = new MemoryIntelligence(config, store, {
    fetchImpl: modelFetch((sources) => [{
      scope: "user",
      kind: "behavior",
      key: "workflow.requests_reproducibility",
      value: "Frequently requests reproducible analysis outputs.",
      summary: "Prefers reproducible analysis workflows.",
      origin: "inferred",
      confidence: 0.7,
      importance: 0.7,
      sensitive: false,
      sourceRef: sources[0].sourceRef,
      evidenceQuote: sources[0].text,
    }]),
  });

  for (let index = 1; index <= 3; index += 1) {
    await intelligence.recordRun(project(), run(`run_${index}`), [
      message(`user_${index}`, `第${index}次：请保留分析脚本、参数和可复现步骤。`),
    ]);
    const behavior = [...store.records.values()].find((record) => record.kind === "behavior");
    assert.equal(behavior.status, index < 3 ? "pending" : "active");
  }
  const behavior = [...store.records.values()].find((record) => record.kind === "behavior");
  assert.equal(behavior.evidenceCount, 3);
});
