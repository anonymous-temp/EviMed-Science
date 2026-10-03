import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createResultGateway } from "../src/resultGateway.mjs";

test("child calculations use the authenticated durable parent address and retain their root run and fork identity", async t => {
  const project = { id: "p", userId: "owner" };
  const request = { method: "meta.dl", inputPath: "data.json", parameters: {}, requestId: "compute" };
  const context = { v: 1, sessionId: "child", callId: "call" };
  let captured; let reads = 0;
  const handler = createResultGateway({ store: { userById: async () => ({ id: "owner" }), requireProject: async () => project },
    agentRuns: { activeRuns: async () => [{ id: "run", sessionId: "fork" }] },
    resolveSession: (owned, sessionId) => {
      assert.equal(owned, project); assert.equal(sessionId, "child");
      return { runId: "run", child: true, parentSessionId: "fork", branchId: "fork" };
    },
    runtimeManager: { assertActiveModelGatewayToken: () => ({ userId: "owner", projectId: "p" }),
      sessionTranscript: async (_project, sessionId, options) => {
        reads++; assert.equal(options.parentSessionId, "fork"); assert.equal(options.wake, false);
        return { sessionId, truncated: false, turns: [{ startSeq: 1, end: null }], messages: [{ turnStartSeq: 1,
          parts: [{ type: "tool", callId: "call", tool: "mcp__evimed__research_calculate", status: "pending",
            input: { ...request, action: "start" } }] }] };
      } },
    service: { calculate: async (_actor, _project, _input, producer, revalidate) => {
      await revalidate(); captured = producer; return { id: "replay_" + "1".repeat(64), state: "queued" };
    } },
  });
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/internal/results/v1/start`, { method: "POST",
    headers: { authorization: "Bearer owned-workload", "content-type": "application/json", "x-evimed-execution-context": JSON.stringify(context) },
    body: JSON.stringify(request) });
  assert.equal(response.status, 202); await response.json();
  assert.equal(reads, 2);
  assert.deepEqual(captured, { kind: "engine", sessionId: "child", callId: "call", runId: "run", parentSessionId: "fork", branchId: "fork" });
});
