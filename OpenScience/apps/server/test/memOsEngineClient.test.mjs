import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { MemOsClient, memOsNamespace } from "../src/memOsEngineClient.mjs";
import { addResponse, deleteResponse, exampleRecord, healthResponse, searchResponse } from "../../../packages/contracts/memos/fixtures/wire.mjs";

async function harness(t, responder, config = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const call = { path: req.url, method: req.method, headers: req.headers, body: body ? JSON.parse(body) : null };
    calls.push(call);
    const reply = await responder(call, calls.length);
    if (reply === undefined) return;
    res.writeHead(reply.httpStatus ?? 200, { "content-type": "application/json", ...reply.headers });
    res.end(reply.raw ?? JSON.stringify(reply.json ?? reply));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new MemOsClient({ memOsBaseUrl: `http://127.0.0.1:${server.address().port}`, ...config });
  return { client, calls };
}
const scope = memOsNamespace("account-one", "project-one");

test("namespaces distinguish account, project, and delimiter collisions", () => {
  const scopes = [["a", "b:c"], ["a:b", "c"], ["a"], ["a", ""], ["a", "b"], ["b", "b"]];
  assert.throws(() => memOsNamespace("a", ""), { code: "mem_os_payload_invalid" });
  assert.equal(new Set(scopes.filter(([,p]) => p !== "").map(([u,p]) => memOsNamespace(u,p).cubeId)).size, 5);
  assert.notEqual(scope.userId, "account-one");
  assert.equal(memOsNamespace("account-one", "other").userId, scope.userId);
});

test("health validates service identity and labels schema version honestly", async t => {
  const {client,calls} = await harness(t, () => healthResponse);
  assert.deepEqual(await client.health(), { status: "healthy", service: "memos", apiVersion: "1.0.1" });
  assert.equal(calls[0].path, "/health");
  assert.equal(calls[0].headers.authorization, undefined);
});

test("add stores one record per request with server scope and provenance", async t => {
  const {client,calls} = await harness(t, () => addResponse(scope.cubeId));
  const receipt = await client.add("account-one", [exampleRecord], {projectId:"project-one"});
  assert.deepEqual(calls[0].body, {
    user_id: scope.userId, writable_cube_ids: [scope.cubeId], async_mode: "async", task_id: calls[0].body.task_id,
    messages: [{role:"user",content:exampleRecord.content}], chat_history: [],
    info: {evimed_entry_id:exampleRecord.entryId, evimed_provenance_ids:exampleRecord.provenanceIds},
  });
  assert.equal(calls[0].path, "/product/add");
  assert.match(receipt.records[0].taskId, /^evimed-task-/);
  assert.deepEqual(receipt, {status:"stored",processingStatus:"unverified",records:[{entryId:"entry-one",memoryIds:["memory-one"],taskId:calls[0].body.task_id}]});
});

test("add validates the whole batch before writing and refuses tenant payload fields", async t => {
  const {client,calls} = await harness(t, () => assert.fail("must not request"));
  for (const extra of [{user_id:"foreign"},{writable_cube_ids:["foreign"]},{info:{user_id:"foreign"}},{doc_path:"/etc/passwd"}]) {
    await assert.rejects(client.add("account-one",[{...exampleRecord,...extra}]),{code:"mem_os_payload_invalid"});
  }
  await assert.rejects(client.add("account-one",[exampleRecord,{entryId:"other",content:""}]),{code:"mem_os_payload_invalid"});
  await assert.rejects(client.search("account-one","query",{projectId:"project-one",filter:{}}),{code:"mem_os_payload_invalid"});
  assert.equal(calls.length,0);
});

test("partial write failure retains successful identifiers without retrying", async t => {
  const {client,calls} = await harness(t, (_, n) => n === 1 ? addResponse(scope.cubeId) : {httpStatus:503,json:{message:"private upstream body"}});
  await assert.rejects(client.add("account-one",[exampleRecord,{...exampleRecord,entryId:"entry-two"}],{projectId:"project-one"}), error => {
    assert.equal(error.code,"mem_os_partial_write");
    assert.deepEqual(error.completed,[{entryId:"entry-one",memoryIds:["memory-one"],taskId:calls[0].body.task_id}]);
    assert.equal(error.failedEntryId,"entry-two");
    assert.equal(error.causeCode,"mem_os_unavailable");
    assert.doesNotMatch(error.message,/private/);
    return true;
  });
  assert.equal(calls.length,2);
});

test("search scopes reads and preserves product provenance", async t => {
  const {client,calls} = await harness(t, () => searchResponse(scope.userId,scope.cubeId));
  const records = await client.search("account-one","methods",{projectId:"project-one",limit:3});
  assert.equal(records[0].id,"memory-one");
  assert.equal(records[0].entryId,"entry-one");
  assert.deepEqual(records[0].provenanceIds,exampleRecord.provenanceIds);
  assert.equal(calls[0].body.user_id,scope.userId);
  assert.deepEqual(calls[0].body.readable_cube_ids,[scope.cubeId]);
  assert.deepEqual(calls[0].body.filter,{user_id:scope.userId});
  assert.equal(calls[0].body.top_k,3);
  assert.equal(calls[0].body.internet_search,false);
});

test("foreign bucket and mismatched owner responses fail closed", async t => {
  for (const [user,cube] of [[scope.userId,"foreign"],["foreign",scope.cubeId],[null,scope.cubeId]]) {
    const {client}=await harness(t,()=>searchResponse(user,cube));
    await assert.rejects(client.search("account-one","x",{projectId:"project-one"}),{code:"mem_os_scope_mismatch"});
  }
});

test("export is paginated and never labels a partial page complete", async t => {
  const {client,calls}=await harness(t,()=>searchResponse(scope.userId,scope.cubeId,{total:2}));
  const page=await client.export("account-one",{projectId:"project-one",page:1,pageSize:1});
  assert.equal(page.complete,false); assert.equal(page.nextPage,2); assert.equal(page.total,2);
  assert.equal(calls[0].path,"/product/get_memory");
  assert.deepEqual(calls[0].body,{mem_cube_id:scope.cubeId,user_id:scope.userId,include_preference:false,include_tool_memory:false,include_skill_memory:false,page:1,page_size:1});
});

test("deleteRecord uses a scoped filter, never upstream unscoped memory_ids", async t => {
  const {client,calls}=await harness(t,()=>deleteResponse);
  assert.deepEqual(await client.deleteRecord("account-one","memory-one",{projectId:"project-one"}),{status:"deleted",verified:false});
  assert.equal(calls[0].path,"/product/delete_memory");
  assert.deepEqual(calls[0].body,{user_id:scope.userId,writable_cube_ids:[scope.cubeId],filter:{and:[{id:"memory-one"},{user_name:scope.cubeId}]}});
});

test("deleteUser selects only the account across its project cubes", async t => {
  const {client,calls}=await harness(t,()=>deleteResponse);
  await client.deleteUser("account-one");
  assert.deepEqual(calls[0].body,{user_id:scope.userId});
});

test("HTTP 200 with deletion failure or empty add is not success", async t => {
  const {client}=await harness(t,()=>({code:200,message:"ignored",data:{status:"failure"}}));
  await assert.rejects(client.deleteUser("account-one"),{code:"mem_os_operation_failed"});
  const {client:empty}=await harness(t,()=>({code:200,message:"ignored",data:[]}));
  await assert.rejects(empty.add("account-one",[exampleRecord]),{code:"mem_os_response_invalid"});
});

test("HTTP, JSON, envelope, health and response size failures are named and sanitized", async t => {
  for (const [reply,code,config] of [
    [{httpStatus:401,json:{message:"secret"}},"mem_os_auth_failed"],
    [{httpStatus:429,json:{}},"mem_os_rate_limited"],
    [{httpStatus:500,json:{}},"mem_os_unavailable"],
    [{raw:"invalid secret"},"mem_os_response_invalid"],
    [{json:{status:"healthy",service:"usememos",version:"1.0.1"}},"mem_os_response_invalid"],
    [{raw:" ".repeat(300)},"mem_os_response_too_large",{memOsMaxResponseBytes:128}],
    [{httpStatus:302,headers:{location:"http://example.com"},json:{}},"mem_os_redirect_refused"],
  ]) {
    const {client}=await harness(t,()=>reply,config);
    await assert.rejects(client.health(),error=>{ assert.equal(error.code,code);assert.doesNotMatch(error.message,/secret/);return true; });
  }
});

test("timeout bounds the whole response and request sizes are checked before send", async t => {
  const {client}=await harness(t,()=>undefined,{memOsTimeoutMs:30});
  await assert.rejects(client.health(),{code:"mem_os_timeout"});
  const {client:bounded,calls}=await harness(t,()=>assert.fail("not sent"),{memOsMaxRequestBytes:128});
  await assert.rejects(bounded.add("account-one",[exampleRecord]),{code:"mem_os_request_too_large"});
  assert.equal(calls.length,0);
});

test("URL, config and limits validation fails before network access", async () => {
  for(const url of ["file:///tmp/memory","http://test-only-user:test-only-placeholder@localhost","http://localhost/a","http://localhost?secret=x","http://localhost/#x"]) {
    assert.throws(()=>new MemOsClient({memOsBaseUrl:url}),{code:"mem_os_config_invalid"});
  }
  assert.throws(()=>new MemOsClient({memOsBaseUrl:"http://localhost",memOsTimeoutMs:0}),{code:"mem_os_config_invalid"});
  const client=new MemOsClient({memOsBaseUrl:"http://127.0.0.1:1"});
  await assert.rejects(client.search("account-one","x",{limit:0}),{code:"mem_os_payload_invalid"});
  await assert.rejects(client.health(),{code:"mem_os_unavailable"});
});


test("scheduler status is scoped and missing task remains unverified", async t => {
  let savedTaskId;
  const {client,calls}=await harness(t,call=> {
    if(call.path === "/product/add") { savedTaskId=call.body.task_id; return addResponse(scope.cubeId); }
    return {code:200,message:"Memory get status successfully",data:[{task_id:savedTaskId,status:"completed"}]};
  });
  const added=await client.add("account-one",[exampleRecord],{projectId:"project-one"});
  const taskId=added.records[0].taskId;
  assert.deepEqual(await client.getTaskStatus("account-one",taskId,{projectId:"project-one"}),{taskId,status:"completed"});
  assert.equal(new URL(calls[1].path,"http://localhost").searchParams.get("user_id"),scope.userId);
  await assert.rejects(client.getTaskStatus("another-account",taskId,{projectId:"project-one"}),{code:"mem_os_payload_invalid"});
  const {client:missing}=await harness(t,()=>({httpStatus:404,json:{detail:"not found"}}));
  await assert.rejects(missing.getTaskStatus("account-one",taskId,{projectId:"project-one"}),{code:"mem_os_not_found"});
});
