import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  readDeepSeekKeyFile,
  runDeepSeekCompatibility,
} from "../../../scripts/ops/deepseek-compatibility-preflight.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, "scripts/ops/deepseek-compatibility-preflight.mjs");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function keyFixture(t, value = "fake-provider-key") {
  const root = await mkdtemp(path.join(tmpdir(), "deepseek-compatibility-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "deepseek.key");
  await writeFile(file, `${value}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return { root, file };
}

test("DeepSeek compatibility preflight proves baseline, SSE, long tool loop, and structured output", async (t) => {
  const { file } = await keyFixture(t);
  const requests = [];
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ authorization: req.headers.authorization, body });
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n");
      return;
    }
    let message = { role: "assistant", content: "ok" };
    if (body.response_format?.type === "json_object") {
      message = { role: "assistant", content: "{\"compatible\":true}" };
    } else if (body.tools) {
      const completed = body.messages.filter((item) => item.role === "tool").length;
      if (completed < 2) {
        message = {
          role: "assistant",
          content: null,
          reasoning_content: "The compatibility probe needs two independent results.",
          tool_calls: [1, 2].map((number) => ({
            id: `call-${number}`,
            type: "function",
            function: { name: "compatibility_probe", arguments: "{}" },
          })),
        };
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  const baseUrl = await listen(provider);
  t.after(() => close(provider));

  const result = await runDeepSeekCompatibility({
    keyFile: file,
    baseUrl,
    model: "deepseek-v4-pro",
    allowNonOfficialBaseForTests: true,
    timeoutMs: 1_000,
  });

  assert.deepEqual(result, {
    ok: true,
    capabilities: ["baseline", "streaming", "tool_loop", "structured_output"],
  });
  assert.equal(requests.length, 5);
  assert.equal(requests.every((item) => item.authorization === "Bearer fake-provider-key"), true);
  assert.equal(requests.every((item) => item.body.model === "deepseek-v4-pro"), true);
  assert.equal(requests.every((item) => item.body.thinking?.type === "enabled"), true);
  assert.equal(requests.every((item) => item.body.reasoning_effort === "high"), true);
  assert.equal(requests.filter((item) => item.body.tools).length, 2);
  const completedToolRequest = requests.find((item) => (
    item.body.tools && item.body.messages.filter((message) => message.role === "tool").length === 2
  ));
  assert.ok(completedToolRequest);
  assert.deepEqual(
    completedToolRequest.body.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
    ["call-1", "call-2"],
  );
  assert.equal(
    completedToolRequest.body.messages.some((message) => (
      message.role === "assistant" && message.reasoning_content === "The compatibility probe needs two independent results."
    )),
    true,
  );
  assert.equal(requests.some((item) => item.body.stream === true), true);
  assert.equal(requests.some((item) => item.body.response_format?.type === "json_object"), true);
});

test("DeepSeek compatibility preflight reads only a private no-follow key file", async (t) => {
  const { root, file } = await keyFixture(t, "private-key-value");
  assert.equal(readDeepSeekKeyFile(file), "private-key-value");
  await chmod(file, 0o644);
  assert.throws(() => readDeepSeekKeyFile(file), (error) => error?.code === "deepseek_key_file_permissions");
  const link = path.join(root, "linked.key");
  await symlink(file, link);
  assert.throws(() => readDeepSeekKeyFile(link), (error) => error?.code === "deepseek_key_file_symlink");

  const cli = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      OPEN_SCIENCE_DEEPSEEK_API_KEY: "must-be-ignored",
      OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE: "",
    },
  });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /deepseek_key_file_missing/);
  assert.doesNotMatch(`${cli.stdout}${cli.stderr}`, /must-be-ignored/);
});

test("DeepSeek compatibility failures expose only stable redacted capability codes", async (t) => {
  const { file } = await keyFixture(t, "secret-that-must-not-leak");
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "secret-that-must-not-leak and prompt body" } }));
  });
  const baseUrl = await listen(provider);
  t.after(() => close(provider));

  await assert.rejects(
    () => runDeepSeekCompatibility({
      keyFile: file,
      baseUrl,
      model: "deepseek-v4-pro",
      allowNonOfficialBaseForTests: true,
      timeoutMs: 1_000,
    }),
    (error) => {
      assert.equal(error.code, "deepseek_baseline_upstream_error");
      assert.doesNotMatch(error.message, /secret-that-must-not-leak|prompt body/);
      return true;
    },
  );
});
