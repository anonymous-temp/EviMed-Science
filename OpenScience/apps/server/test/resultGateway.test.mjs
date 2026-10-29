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

test('terminal aggregate status is acknowledged only by its verified pending native call',async t=>{
 const project={id:'p',userId:'owner'},jobId='replay_'+'2'.repeat(64);let actualJobId=jobId,acknowledged=0;
 const handler=createResultGateway({store:{userById:async()=>({id:'owner'}),requireProject:async()=>project},agentRuns:{activeRuns:async()=>[{id:'root_run',sessionId:'root'}]},
  runtimeManager:{assertActiveModelGatewayToken:()=>({userId:'owner',projectId:'p'}),sessionTranscript:async(_project,sessionId,options)=>{assert.equal(options.currentTurn,true);return{sessionId,truncated:false,turns:[{startSeq:1,end:null}],messages:[{turnStartSeq:1,parts:[{type:'tool',callId:'status_call',tool:'research_calculate',status:'pending',input:{action:'status',jobId:actualJobId}}]}]};}},
  service:{status:async()=>({id:jobId,state:'succeeded',outputVersionId:'result_generation'}),observeTerminal:async(_user,_project,id,origin,answer)=>{assert.equal(id,jobId);assert.deepEqual(origin,{runId:'root_run',rootSessionId:'root',callId:'status_call'});assert.equal(answer.outputVersionId,'result_generation');acknowledged++;}}});
 const server=createServer((req,res)=>{void handler(req,res);});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const send=()=>fetch(`http://127.0.0.1:${server.address().port}/internal/results/v1/status`,{method:'POST',headers:{authorization:'Bearer owned','content-type':'application/json','x-evimed-execution-context':JSON.stringify({v:1,sessionId:'root',callId:'status_call'})},body:JSON.stringify({jobId})});
 const observed=await send();assert.equal(observed.status,200);await observed.json();assert.equal(acknowledged,1);
 actualJobId='replay_'+'3'.repeat(64);const forged=await send();assert.equal(forged.status,403);await forged.json();assert.equal(acknowledged,1);
});
