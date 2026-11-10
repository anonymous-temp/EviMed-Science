import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, mkdir, rm, access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answerQuestion } from "../run/answerer.mjs";
import { buildProfileBlock, buildSystemPrompt, buildTimeContext, buildSkillCatalog, SKILL_TOOL, loadSkill,
  catalogDescription, renderCatalogMessage, renderCatalogEntries, renderSkillContent, escapeText, isModelInvocable } from "../run/openingBlock.mjs";
import { createDeepSeekClient, firstLine } from "../run/deepseek.mjs";
import { createTranscriptIndex, KEYWORD_SEARCH_TOOL, tokenize } from "../run/baselines.mjs";
import { MEMORY_GATEWAY_TOOLS } from "../../../apps/server/src/memoryGateway.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const providedArchive = process.env.CAPSULE_PROVING_PLUGIN_TGZ;
const archive = providedArchive ?? path.resolve(root, "../..", "memrun-brief/dsh-memory-plugin-0.5.31.tgz");
let hasArchive = true;
try { await access(archive); } catch { hasArchive = false; }
if (hasArchive) process.env.CAPSULE_PROVING_PLUGIN_TGZ = archive;
const productTest = (name, fn) => test(name, { skip: !hasArchive && "Set CAPSULE_PROVING_PLUGIN_TGZ to run the real pinned-plugin tests" }, fn);
const options = { question: "What do I prefer?", asOf: "2026-03-23T03:41:24.000Z", arm: "product", caseId: "test-case", qid: "q1" };
const tool = (name, args, id = name) => ({ id, type: "function", function: { name: `mcp__openviking__${name}`, arguments: JSON.stringify(args) } });
const skillCall = (name) => ({ id: "load_skill", type: "function", function: { name: "skill", arguments: JSON.stringify({ name }) } });
const skillTool = { type: "function", function: { name: SKILL_TOOL.name, description: SKILL_TOOL.description, parameters: SKILL_TOOL.inputSchema } };
const catalogSummary = (catalog) => ({ entries: catalog.entries.length, sha256: createHash("sha256").update(catalog.text).digest("hex") });
const reply = (content, calls = []) => ({ message: { role: "assistant", content, ...(calls.length ? { tool_calls: calls, reasoning_content: "Look up the prior preference." } : {}) }, usage: { promptTokens: 10, completionTokens: 3, cachedTokens: 2 } });

function fakeClient(replies) {
  const requests = [];
  return { model: "deepseek-flash", thinking: "disabled", requests, async complete(request) {
    requests.push(structuredClone(request));
    const next = replies.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, "Unexpected extra model call");
    return next;
  } };
}

function fakeMemory({ space = "test-user", profile = "# Profile\nPrefers concise replies.", resident = "Project card", empty = false } = {}) {
  const calls = [];
  const paths = [];
  return { tools: Object.entries(MEMORY_GATEWAY_TOOLS).map(([name, value]) => ({ name, ...value })), calls, paths,
    async fetchJSON(url) {
      paths.push(url);
      const parsed = new URL(url, "http://memory.invalid");
      const uri = parsed.searchParams.get("uri");
      if (parsed.pathname === "/api/v1/system/status") return { ok: true, result: { user: space } };
      if (uri === "viking://user") return { ok: true, result: [{ name: space, isDir: true }] };
      assert.ok(uri.startsWith(`viking://user/${space}/`), "Profile imports must not share a user's namespace cache");
      if (parsed.pathname === "/api/v1/content/read") return { ok: true, result: empty ? "" : profile };
      return { ok: true, result: empty ? [] : [{ rel_path: "self/style.md", name: "style.md", isDir: false }] };
    },
    async residentBlock() { return resident; },
    async callTool(name, args) { calls.push({ name, args }); return { blocks: ["memory result", "historical excerpt"], isError: false }; },
  };
}

async function credential(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "capsule-proving-client-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = path.join(directory, "key");
  const secret = "test-private-credential-do-not-display";
  await writeFile(keyFile, secret, { mode: 0o600 });
  return { keyFile, secret };
}
const httpReply = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, async json() { return data; } });

// Internal renderers are not exported by DSH. Evaluate their unmodified function declarations
// with only createUserMessage stubbed to expose text; never import a kernel package at runtime.
function kernelFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Kernel function ${name} exists`);
  const end = source.indexOf("\n}", start);
  assert.ok(end > start);
  return source.slice(start, end + 2);
}

test("pure catalogue, content and tool definitions match the installed pinned kernel when present", async (t) => {
  const directory = "/home/coder/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";
  let toolSource, skillSource;
  try {
    [toolSource, skillSource] = await Promise.all([
      readFile(path.join(directory, "dsh-tool-skill/lib/index.js"), "utf8"),
      readFile(path.join(directory, "dsh-skill/lib/index.js"), "utf8"),
    ]);
  } catch (error) {
    if (error.code === "ENOENT") return t.skip("Pinned kernel is not installed on this host");
    throw error;
  }
  const toolNames = ["catalogDescription", "renderCatalogEntries", "renderCatalogMessage", "incompleteCatalogNotice", "apply"];
  const skillNames = ["escapeText", "escapeAttr", "isModelInvocable", "renderSkillContent", "renderResourceHint"];
  const declarations = [...toolNames.map((name) => kernelFunction(toolSource, name)), ...skillNames.map((name) => kernelFunction(skillSource, name))].join("\n");
  let definition;
  const kernel = new Function("createUserMessage", "defineTool", "assertPositiveInteger", `${declarations}\nreturn { ${[...toolNames, ...skillNames].join(", ")} };`)(
    (message) => message, (tool) => tool, () => {},
  );
  const sample = [
    { name: "alpha", description: "  Read\n\tfiles with <tags> & details.  " },
    { name: "long-description", description: `Multi-line\n description ${"x".repeat(600)}` },
    { name: "unicode", description: "Sample \u4e2d\u6587 text with > and &amp;." },
  ];
  const entries = sample.map(({ name, description }) => ({ name, description: catalogDescription(description) }));
  assert.deepEqual(entries, sample.map(({ name, description }) => ({ name, description: kernel.catalogDescription(description, 500) })));
  assert.equal(entries[1].description.length, 500);
  assert.ok(entries[1].description.endsWith("..."));
  assert.equal(escapeText("< & >"), kernel.escapeText("< & >"));
  assert.deepEqual(renderCatalogEntries(entries), kernel.renderCatalogEntries(entries));
  for (const list of [entries, []]) assert.equal(renderCatalogMessage(list), kernel.renderCatalogMessage(list, false).content[0].text);
  for (const modelInvocable of [true, false]) {
    const skill = { invocation: { modelInvocable } };
    assert.equal(isModelInvocable(skill), kernel.isModelInvocable(skill));
  }
  const skill = { body: "# Instructions\n\nUse <verbatim> content.\nPreserve whitespace.", path: "/local/<skills>&/sample/SKILL.md" };
  assert.equal(renderSkillContent("sample", skill), kernel.renderSkillContent({ name: "sample", provider: "filesystem",
    content: skill.body, resourceBase: { kind: "directory", path: path.dirname(skill.path) } }));
  kernel.apply({ tools: { register(tool) { definition = tool; } }, on() {} }, { catalogDescriptionMaxLength: 500 });
  const properties = Object.fromEntries(Object.entries(definition.parameters).map(([name, value]) => {
    const { required, ...schema } = value;
    assert.equal(required, true);
    return [name, schema];
  }));
  assert.deepEqual(SKILL_TOOL, { name: definition.name, description: definition.description,
    inputSchema: { type: "object", properties, required: ["name"] } });
  assert.equal(renderSkillContent("sample", skill), definition.output.render({}, { name: "sample", provider: "filesystem",
    content: skill.body, resourceBase: { kind: "directory", path: path.dirname(skill.path) } })[0].text);
});

productTest("catalogue uses only shipped conversation roots, native name order, and the visible plugin skill", async () => {
  const product = await buildSkillCatalog({ pluginTgz: archive });
  const baseline = await buildSkillCatalog({ includeMemory: false, pluginTgz: "/missing/plugin.tgz" });
  assert.deepEqual(product.entries.filter(({ name }) => name !== "openviking-memory"), baseline.entries);
  assert.deepEqual(product.entries.map(({ name }) => name), [...product.skills.keys()].sort());
  assert.equal(product.skills.size, baseline.skills.size + 1);
  assert.ok(product.skills.has("openviking-memory"));
  assert.ok(product.skills.has("open-domain-answer"));
  assert.ok(product.skills.has("docx"));
  assert.ok(product.skills.has("domain-check"));
  for (const name of ["openviking-skills", "ov-experience-memory", "clinical-evidence-synthesis", "comprehensive-drug-evaluation"]) assert.ok(!product.skills.has(name), name);
  for (const [name, skill] of product.skills) {
    assert.ok(!skill.path.includes("/capabilities/"));
    const source = await readFile(skill.path, "utf8");
    assert.equal(skill.body, source.replace(/^---\r?\n[\s\S]*?^---\r?$(?:\n|$)/m, "").trim(), name);
  }
  assert.equal(product.text, (await buildSkillCatalog({ pluginTgz: archive })).text);
  assert.equal(product.entries.find(({ name }) => name === "openviking-memory").description.length, 500);
});

test("installed LoopX roots keep only recorded skills and respect model invocation frontmatter", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "capsule-proving-skills-test-"));
  const previous = process.env.EVIMED_LOOPX_ROOT;
  t.after(async () => {
    if (previous === undefined) delete process.env.EVIMED_LOOPX_ROOT;
    else process.env.EVIMED_LOOPX_ROOT = previous;
    await rm(directory, { recursive: true, force: true });
  });
  for (const name of ["loopx", "loopx-project", "loopx-doc-registry"]) {
    const skillDirectory = path.join(directory, "skills", name);
    await mkdir(skillDirectory, { recursive: true });
    const policy = name === "loopx" ? 'disable-model-invocation: "yes"' : "user-invocable: false";
    await writeFile(path.join(skillDirectory, "SKILL.md"), `---\nname: ${name}\ndescription: Test workflow.\n${policy}\n---\n\n# Test workflow\n`);
  }
  process.env.EVIMED_LOOPX_ROOT = directory;
  const catalog = await buildSkillCatalog({ includeMemory: false });
  assert.ok(!catalog.skills.has("loopx"), "Model invocation is disabled");
  assert.ok(!catalog.skills.has("loopx-doc-registry"), "Unkept workflows are absent");
  assert.ok(catalog.skills.has("loopx-project"), "User invocation does not control model visibility");
  assert.equal(catalog.skills.get("loopx-project").body, "# Test workflow");
});

productTest("product skill call loads upstream instructions and search arguments pass through unchanged", async () => {
  const memory = fakeMemory();
  const args = { query: "reply style", mode: "context" };
  const client = fakeClient([reply(null, [skillCall("openviking-memory")]), reply(null, [tool("search", args)]), reply("Concise replies.")]);
  const record = await answerQuestion({ ...options, memory, client, pluginTgz: archive });
  const catalog = await buildSkillCatalog({ pluginTgz: archive });
  assert.equal(record.error, undefined);
  assert.equal(record.answer, "Concise replies.");
  assert.equal(record.rounds, 3);
  assert.equal(record.toolCalls[0].name, "skill");
  assert.deepEqual(record.toolCalls[0].args, { name: "openviking-memory" });
  assert.equal(record.toolCalls[0].isError, false);
  assert.equal(record.toolCalls[0].blocks[0], renderSkillContent("openviking-memory", catalog.skills.get("openviking-memory")));
  assert.match(record.toolCalls[0].blocks[0], /<skill_instructions>\n/);
  assert.match(record.toolCalls[0].blocks[0], /mode[=: ]+"context"/);
  assert.equal(client.requests[1].messages.at(-1).content, record.toolCalls[0].blocks[0]);
  assert.equal(client.requests[1].messages.at(-1).name, "skill");
  assert.deepEqual(memory.calls, [{ name: "search", args }]);
  assert.equal(memory.tools.find(({ name }) => name === "search").inputSchema.properties.mode, undefined);
});

test("both baseline arms can load ordinary skills and return kernel errors for unavailable memory skills", async () => {
  for (const arm of ["no-memory", "keyword"]) {
    const client = fakeClient([reply(null, [skillCall("docx")]), reply(null, [skillCall("openviking-memory")]), reply("Done.")]);
    const record = await answerQuestion({ ...options, arm, memory: arm === "keyword" ? createTranscriptIndex([]) : undefined, client });
    assert.equal(record.error, undefined);
    assert.equal(record.answer, "Done.");
    assert.match(client.requests[1].messages.at(-1).content, /^<skill_content name="docx">\n<skill_resources>\nBase directory for this skill:/);
    assert.equal(record.toolCalls[1].isError, true);
    assert.deepEqual(record.toolCalls[1].blocks, ['skill "openviking-memory" is unknown or no longer available']);
    assert.equal(client.requests[2].messages.at(-1).content, 'Error: skill "openviking-memory" is unknown or no longer available');
    assert.deepEqual(client.requests[0].messages.map(({ role }) => role), ["system", "user", "user"]);
    assert.ok(!client.requests[0].messages[1].content.includes("- `openviking-memory`:"));
  }
});

productTest("unknown skill errors reach the product model without ending the question", async () => {
  const client = fakeClient([reply(null, [skillCall("missing-skill")]), reply("Answered without it.")]);
  const record = await answerQuestion({ ...options, memory: fakeMemory(), client });
  assert.equal(record.error, undefined);
  assert.equal(record.answer, "Answered without it.");
  assert.deepEqual(record.toolCalls[0].blocks, ['skill "missing-skill" is unknown or no longer available']);
  assert.equal(record.toolCalls[0].isError, true);
  assert.equal(client.requests[1].messages.at(-1).content, 'Error: skill "missing-skill" is unknown or no longer available');
  assert.throws(() => loadSkill(new Map(), "../bad"), { message: 'invalid skill name "../bad"' });
});

productTest("product arm preserves tool surface, opening order, multi-block output, usage and reasoning", async () => {
  const memory = fakeMemory();
  const client = fakeClient([reply(null, [tool("search", { query: "reply style" })]), reply("You prefer concise replies.")]);
  const record = await answerQuestion({ ...options, memory, client, project: { id: "p1" } });
  assert.equal(record.answer, "You prefer concise replies.");
  assert.equal(record.error, undefined);
  assert.deepEqual(client.requests[0].tools[0], skillTool);
  assert.deepEqual(client.requests[0].tools.slice(1).map(({ function: f }) => ({ name: f.name.replace("mcp__openviking__", ""), description: f.description, inputSchema: f.parameters })), memory.tools);
  const messages = client.requests[0].messages;
  assert.equal(messages[0].content, buildSystemPrompt());
  assert.equal(messages[1].role, "user");
  const catalog = await buildSkillCatalog({});
  assert.equal(messages[1].content, catalog.text);
  assert.match(messages[1].content, /- `openviking-memory`: Work with OpenViking/);
  assert.deepEqual(record.opening.skillCatalog, catalogSummary(catalog));
  assert.match(messages[2].content, /^<openviking-context source="profile">\n<user-profile/);
  assert.match(messages[2].content, /self\/style.md/);
  assert.equal(messages[3].content, "Project card");
  assert.match(messages[4].content, /^Today's date is 2026-03-23\.\n\n/);
  assert.equal(client.requests[1].messages.at(-1).content, "memory result\n\nhistorical excerpt");
  assert.equal(client.requests[1].messages.at(-2).reasoning_content, "Look up the prior preference.");
  assert.deepEqual(record.usage, { promptTokens: 20, completionTokens: 6, cachedTokens: 4 });
  assert.equal(record.rounds, 2);
  assert.equal(record.model.thinking, "disabled");
  assert.deepEqual(record.toolCalls[0].blocks, ["memory result", "historical excerpt"]);
  assert.deepEqual(memory.calls, [{ name: "search", args: { query: "reply style" } }]);
  assert.ok(record.ms >= 0);
});

productTest("remember and forget return ordinary success without mutating memory", async () => {
  const memory = fakeMemory();
  const uri = "viking://user/test-user/memories/preferences/self/style.md";
  const client = fakeClient([reply(null, [tool("remember", { messages: [{ role: "user", content: "Remember concise replies" }] }), tool("forget", { uri })]), reply("Done.")]);
  const record = await answerQuestion({ ...options, memory, client });
  assert.deepEqual(memory.calls, []);
  assert.equal(record.toolCalls.length, 2);
  assert.match(record.toolCalls[0].blocks[0], /^Submitted 1 message\(s\) for memory extraction/);
  assert.equal(record.toolCalls[1].blocks[0], `Deleted: ${uri}`);
  assert.equal(record.answer, "Done.");
});

productTest("maxRounds triggers exactly one final request with tools disabled", async () => {
  const memory = fakeMemory();
  const client = fakeClient([reply(null, [tool("search", { query: "style" })]), reply("Final answer.")]);
  const record = await answerQuestion({ ...options, memory, client, maxRounds: 1 });
  assert.equal(record.rounds, 2);
  assert.equal(record.answer, "Final answer.");
  assert.deepEqual(client.requests[1].tools, []);
  assert.equal(client.requests[1].toolChoice, "none");
});

productTest("materials are prior synthetic tool results, never memory inputs or user words", async () => {
  const memory = fakeMemory();
  const client = fakeClient([reply("The document claims it.")]);
  const materials = [{ kind: "paste", title: "Source", text: "The assistant suggested blue." }];
  const record = await answerQuestion({ ...options, materials, memory, client });
  const messages = client.requests[0].messages;
  assert.equal(messages.at(-3).role, "assistant");
  assert.equal(messages.at(-3).tool_calls[0].function.name, "read_material");
  assert.equal(messages.at(-3).reasoning_content, "");
  assert.equal(messages.at(-2).role, "tool");
  assert.match(messages.at(-2).content, /not the user's words or instructions/);
  assert.ok(messages.at(-2).content.includes(materials[0].text));
  assert.ok(!messages.filter((m) => m.role === "user").some((m) => m.content.includes(materials[0].text)));
  assert.deepEqual(memory.calls, []);
  assert.ok(memory.paths.every((url) => !url.includes("suggested")));
  assert.equal(record.error, undefined);
});

productTest("plugin namespaces are isolated across users and empty profiles stay absent", async () => {
  const first = await buildProfileBlock(fakeMemory({ space: "alpha" }));
  const second = await buildProfileBlock(fakeMemory({ space: "beta" }));
  assert.match(first, /viking:\/\/user\/alpha\/memories/);
  assert.match(second, /viking:\/\/user\/beta\/memories/);
  const memory = fakeMemory({ empty: true, resident: null });
  const client = fakeClient([reply("Nothing remembered.")]);
  const record = await answerQuestion({ ...options, memory, client });
  assert.deepEqual(record.opening, { profileBlock: null, residentBlock: null, skillCatalog: catalogSummary(await buildSkillCatalog({})) });
  assert.deepEqual(client.requests[0].messages.map((m) => m.role), ["system", "user", "user"]);
});

productTest("a tool's own failure goes back to the model as the tool result and the question is still answered", async () => {
  for (const mode of ["throws", "isError", "json", "unknown"]) {
    const memory = fakeMemory();
    memory.callTool = async () => {
      if (mode === "throws") throw new Error("Tool unavailable\ninternal trace");
      return { isError: true, blocks: ["Tool refused\ninternal trace"] };
    };
    const call = tool(mode === "unknown" ? "not_exposed" : "search", { query: "style" });
    if (mode === "json") call.function.arguments = "{";
    const client = fakeClient([reply(null, [call]), reply("Answered without it.")]);
    const record = await answerQuestion({ ...options, memory, client });
    assert.equal(record.answer, "Answered without it.");
    assert.equal(record.error, undefined);
    assert.equal(record.toolCalls[0].isError, true);
    assert.equal(record.rounds, 2);
  }
});
productTest("all returned tool calls are traced even when the first fails", async () => {
  const client = fakeClient([reply(null, [tool("not_exposed", {}), tool("forget", { uri: "viking://test/file" })]), reply("Done.")]);
  const record = await answerQuestion({ ...options, memory: fakeMemory(), client });
  assert.equal(record.toolCalls.length, 2);
  assert.equal(record.toolCalls[0].isError, true);
  assert.equal(record.toolCalls[1].isError, false);
  assert.equal(record.answer, "Done.");
});

productTest("profile archive digest mismatch is refused before import", async (t) => {
  const { keyFile } = await credential(t);
  await assert.rejects(buildProfileBlock(fakeMemory(), { pluginTgz: keyFile }), { code: "plugin_digest" });
  await assert.rejects(buildSkillCatalog({ pluginTgz: keyFile }), { code: "plugin_digest" });
});

test("system prompt matches remembered-format's generated persona and guidance exactly", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["evals/remembered-format/texts.mjs", "--model", "test-model"], { cwd: root });
  const { persona, guidance } = JSON.parse(stdout);
  assert.equal(buildSystemPrompt({ model: "test-model" }), `${persona}\n\n${guidance}`);
});

test("no-memory uses identical system text and the skill surface without touching memory", async () => {
  const client = fakeClient([reply("I don't know.")]);
  const memory = new Proxy({}, { get() { throw new Error("Memory should not be touched"); } });
  const record = await answerQuestion({ ...options, arm: "no-memory", memory, client });
  assert.equal(record.error, undefined);
  assert.equal(client.requests[0].messages[0].content, buildSystemPrompt());
  assert.deepEqual(client.requests[0].tools, [skillTool]);
  const catalog = await buildSkillCatalog({ includeMemory: false });
  assert.equal(client.requests[0].messages[1].content, catalog.text);
  assert.ok(!catalog.skills.has("openviking-memory"));
  assert.deepEqual(record.opening, { profileBlock: null, residentBlock: null, skillCatalog: catalogSummary(catalog) });
});

test("zero round cap, invalid date and model failures never throw", async () => {
  const client = fakeClient([reply("Final.")]);
  const record = await answerQuestion({ ...options, arm: "no-memory", client, maxRounds: 0 });
  assert.equal(record.rounds, 1);
  assert.equal(client.requests[0].toolChoice, "none");
  const failed = await answerQuestion({ ...options, arm: "no-memory", client: fakeClient([new Error("Model failed\nstack")]) });
  assert.equal(failed.error, "model_error: Model failed");
  assert.equal(failed.answer, "");
  const invalid = await answerQuestion({ ...options, asOf: "invalid", arm: "no-memory", client });
  assert.match(invalid.error, /^invalid_date: /);
  assert.throws(() => buildTimeContext(null), { code: "invalid_date" });
});

test("disabled-tool violation and malformed model responses are captured", async () => {
  const index = createTranscriptIndex([]);
  const record = await answerQuestion({ ...options, arm: "keyword", memory: index, maxRounds: 0, client: fakeClient([reply(null, [tool("search", { query: "a" })])]) });
  assert.match(record.error, /^unexpected_tool_call:/);
  assert.equal(record.toolCalls.length, 1);
  const malformed = await answerQuestion({ ...options, arm: "no-memory", client: fakeClient([{ message: { role: "assistant", content: null } }]) });
  assert.match(malformed.error, /^invalid_response:/);
});

test("date context uses UTC asOf and the question's English or Chinese language", () => {
  assert.equal(buildTimeContext("2026-01-01T23:00:00-05:00", "When?"), "Today's date is 2026-01-02.");
  assert.match(buildTimeContext(options.asOf, "\u4eca\u5929\u5462"), /2026-03-23/);
  assert.ok(!buildTimeContext(options.asOf, "\u4eca\u5929\u5462").includes("Today's"));
});

const transcript = [
  { sessionId: "s1", at: "2026-01-01T00:00:00Z", messages: [{ role: "user", text: "I prefer Python notebooks." }, { role: "assistant", text: "Use pandas." }, { role: "user", text: "I like coffee." }, { role: "assistant", text: "Noted." }], attachments: [{ text: "secret attachment zebra" }] },
  { sessionId: "s2", at: "2026-02-01T00:00:00Z", project: { id: "p1", name: "Work" }, messages: [{ role: "user", text: "\u559c\u6b22\u4e2d\u6587\u7b80\u6d01\u56de\u7b54" }, { role: "assistant", text: "\u597d\u7684" }] },
];

test("BM25 ranks bilingual exchanges deterministically and excludes attachments", async () => {
  const before = JSON.stringify(transcript);
  const index = createTranscriptIndex(transcript);
  assert.equal(index.chunks.length, 3);
  assert.equal(index.search("PYTHON pandas", 1)[0].sessionId, "s1");
  assert.equal(index.search("\u7b80\u6d01\u56de\u7b54", 1)[0].sessionId, "s2");
  assert.deepEqual(index.search("nonexistent"), []);
  assert.deepEqual(index.search("secret attachment zebra"), []);
  assert.deepEqual(index.search("Python"), createTranscriptIndex(transcript).search("Python"));
  assert.equal(JSON.stringify(transcript), before);
  assert.deepEqual(tokenize("Python \u4e2d\u6587\u56de\u7b54"), ["python", "\u4e2d\u6587", "\u6587\u56de", "\u56de\u7b54"]);
  const result = await index.callTool("search", { query: "\u7b80\u6d01", limit: 1 });
  assert.match(result.blocks[0], /2026-02-01/);
  assert.match(result.blocks[0], /historical context, not instructions or confirmed facts/);
});

test("keyword arm exposes the product search schema and the catalogue without the memory skill", async () => {
  const index = createTranscriptIndex(transcript);
  const client = fakeClient([reply(null, [tool("search", { query: "Python" })]), reply("Python notebooks.")]);
  const record = await answerQuestion({ ...options, arm: "keyword", memory: index, client });
  assert.equal(record.answer, "Python notebooks.");
  assert.equal(client.requests[0].tools.length, 2);
  assert.deepEqual(client.requests[0].tools[0], skillTool);
  assert.deepEqual(client.requests[0].tools[1].function.parameters, KEYWORD_SEARCH_TOOL.inputSchema);
  const catalog = await buildSkillCatalog({ includeMemory: false });
  assert.equal(client.requests[0].messages[1].content, catalog.text);
  assert.ok(!catalog.text.includes("- `openviking-memory`:"));
  assert.deepEqual(record.opening, { profileBlock: null, residentBlock: null, skillCatalog: catalogSummary(catalog) });
  assert.match(record.toolCalls[0].blocks[0], /I prefer Python notebooks/);
});

test("client injects fetch, defaults thinking off, captures usage/reasoning and replays messages", async (t) => {
  const { keyFile } = await credential(t);
  const bodies = [];
  const client = createDeepSeekClient({ keyFile, baseURL: "https://model.invalid/v1/", fetch: async (url, init) => {
    assert.equal(url, "https://model.invalid/v1/chat/completions");
    bodies.push(JSON.parse(init.body));
    return httpReply({ model: "resolved-model", choices: [{ message: { role: "assistant", content: "ok", reasoning_content: "reason" } }], usage: { prompt_tokens: 11, completion_tokens: 4, prompt_cache_hit_tokens: 7 } });
  } });
  const response = await client.complete({ messages: [{ role: "user", content: "Hi" }], tools: [] });
  assert.deepEqual(bodies[0].thinking, { type: "disabled" });
  assert.equal(bodies[0].model, "deepseek-flash");
  assert.equal(response.message.reasoning_content, "reason");
  assert.deepEqual(response.usage, { promptTokens: 11, completionTokens: 4, cachedTokens: 7 });
  await client.complete({ messages: [response.message], toolChoice: "none" });
  assert.equal(bodies[1].messages[0].reasoning_content, "reason");
  assert.equal(bodies[1].tool_choice, "none");
});

test("client enabled thinking and cached-token fallback are recorded in AnswerRecord", async (t) => {
  const { keyFile } = await credential(t);
  const client = createDeepSeekClient({ keyFile, model: "test-model", thinking: "enabled", fetch: async (_, init) => {
    assert.equal(JSON.parse(init.body).thinking.type, "enabled");
    return httpReply({ choices: [{ message: { role: "assistant", content: "ok", reasoning_content: "reason" } }], usage: { prompt_tokens_details: { cached_tokens: 9 } } });
  } });
  const record = await answerQuestion({ ...options, arm: "no-memory", client });
  assert.equal(record.model.thinking, "enabled");
  assert.equal(record.model.name, "test-model");
  assert.equal(record.usage.cachedTokens, 9);
});

test("client retries network, 429 and 5xx with exponential backoff", async (t) => {
  const { keyFile } = await credential(t);
  const waits = [];
  let count = 0;
  const client = createDeepSeekClient({ keyFile, backoffMs: 2, sleep: async (ms) => { waits.push(ms); }, fetch: async () => {
    count++;
    if (count === 1) throw new Error("Connection reset");
    if (count === 2) return httpReply({ error: { message: "Busy" } }, 429);
    if (count === 3) return httpReply({ error: { message: "Unavailable" } }, 503);
    return httpReply({ choices: [{ message: { role: "assistant", content: "Recovered" } }] });
  } });
  assert.equal((await client.complete({ messages: [] })).message.content, "Recovered");
  assert.deepEqual(waits, [2, 4, 8]);
});

test("client caps retries at five and never emits a key or error headers", async (t) => {
  const { keyFile, secret } = await credential(t);
  let count = 0;
  const client = createDeepSeekClient({ keyFile, maxRetries: 100, sleep: async () => {}, fetch: async () => {
    count++;
    return httpReply({ error: { message: `Failed with ${secret}\nAuthorization: Bearer secret` } }, 503);
  } });
  const record = await answerQuestion({ ...options, arm: "no-memory", client });
  assert.equal(count, 6);
  assert.match(record.error, /^http_503: Failed with \[redacted\]$/);
  assert.ok(!JSON.stringify(record).includes(secret));
  assert.ok(!JSON.stringify(record).includes("Authorization"));
});

test("nonretryable errors and malformed JSON fail once; missing key file is safe", async (t) => {
  const { keyFile, secret } = await credential(t);
  for (const mode of ["400", "json", "shape"]) {
    let count = 0;
    const client = createDeepSeekClient({ keyFile, fetch: async () => {
      count++;
      if (mode === "400") return httpReply({ error: { message: `Refused ${secret}\ntrace` } }, 400);
      if (mode === "json") return { ok: true, status: 200, async json() { throw new SyntaxError(secret); } };
      return httpReply({ choices: [] });
    } });
    const record = await answerQuestion({ ...options, arm: "no-memory", client });
    assert.equal(count, 1);
    assert.equal(record.answer, "");
    assert.ok(!JSON.stringify(record).includes(secret));
  }
  const client = createDeepSeekClient({ keyFile: `${keyFile}/missing`, fetch: async () => { throw new Error("Must not fetch"); } });
  assert.match((await answerQuestion({ ...options, arm: "no-memory", client })).error, /^key_file: Unable to read API key file$/);
});

test("per-request timeout works even when injected fetch ignores AbortSignal", async (t) => {
  const { keyFile } = await credential(t);
  const client = createDeepSeekClient({ keyFile, timeoutMs: 5, maxRetries: 0, fetch: async () => new Promise(() => {}) });
  const record = await answerQuestion({ ...options, arm: "no-memory", client });
  assert.equal(record.error, "timeout: Chat request timed out");
});

test("network exceptions are redacted through both the client and AnswerRecord", async (t) => {
  const { keyFile, secret } = await credential(t);
  const client = createDeepSeekClient({ keyFile, maxRetries: 0, fetch: async () => { throw new Error(`Failed ${secret}\nprivate trace`); } });
  const record = await answerQuestion({ ...options, arm: "no-memory", client });
  assert.equal(record.error, "network: Failed [redacted]");
  assert.ok(!JSON.stringify(record).includes(secret));
  assert.equal(firstLine("Authorization: Bearer top-secret\nnext"), "[redacted header]");
});

productTest("injected fetch drives the full product loop with exact tools and reasoning replay", async (t) => {
  const { keyFile } = await credential(t);
  const requests = [];
  const memory = fakeMemory();
  const client = createDeepSeekClient({ keyFile, thinking: "enabled", fetch: async (_, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    assert.equal(body.thinking.type, "enabled");
    if (requests.length === 1) return httpReply({ choices: [{ message: reply(null, [tool("search", { query: "style" }), tool("read", { uris: ["viking://test/style.md"] })]).message }], usage: { prompt_tokens: 4, completion_tokens: 3 } });
    assert.equal(body.messages.at(-3).reasoning_content, "Look up the prior preference.");
    assert.deepEqual(body.messages.slice(-2).map((message) => message.role), ["tool", "tool"]);
    return httpReply({ choices: [{ message: { role: "assistant", content: "Concise replies." } }], usage: { prompt_tokens: 6, completion_tokens: 4, prompt_cache_hit_tokens: 2 } });
  } });
  const record = await answerQuestion({ ...options, memory, client });
  assert.equal(record.answer, "Concise replies.");
  assert.equal(record.rounds, 2);
  assert.equal(record.toolCalls.length, 2);
  assert.deepEqual(memory.calls.map((call) => call.name), ["search", "read"]);
  assert.deepEqual(requests[0].tools.map((entry) => entry.function.name), ["skill", ...memory.tools.map((entry) => `mcp__openviking__${entry.name}`)]);
  assert.deepEqual(record.usage, { promptTokens: 10, completionTokens: 7, cachedTokens: 2 });
});

productTest("tool failure diagnostics redact the client's key as well as model errors", async (t) => {
  const { keyFile, secret } = await credential(t);
  const memory = fakeMemory();
  memory.callTool = async () => { throw new Error(`Tool failed ${secret}\nprivate trace`); };
  let calls = 0;
  const client = createDeepSeekClient({ keyFile, fetch: async () => httpReply({ choices: [{ message: (calls++ === 0 ? reply(null, [tool("search", { query: "style" })]) : reply("No record.")).message }] }) });
  const record = await answerQuestion({ ...options, memory, client });
  assert.deepEqual(record.toolCalls[0].blocks, ["Tool failed [redacted]"]);
  assert.equal(record.answer, "No record.");
  assert.ok(!JSON.stringify(record).includes(secret));
});

test("a network failure reading a response body is retried", async (t) => {
  const { keyFile } = await credential(t);
  let count = 0;
  const client = createDeepSeekClient({ keyFile, sleep: async () => {}, fetch: async () => {
    count++;
    if (count === 1) return { ok: true, status: 200, async json() { throw new TypeError("Socket closed while reading response"); } };
    return httpReply({ choices: [{ message: { role: "assistant", content: "Recovered" } }] });
  } });
  assert.equal((await client.complete({ messages: [] })).message.content, "Recovered");
  assert.equal(count, 2);
});


test("search hint opt-in changes only the product system prompt", () => {
  const plain = buildSystemPrompt();
  assert.equal(buildSystemPrompt({ config: { memorySearchHintEnabled: false } }), plain);
  const hint = buildSystemPrompt({ config: { memorySearchHintEnabled: true } });
  assert.notEqual(hint, plain);
  assert.match(hint, /mcp__openviking__search/);
});

productTest("each answer configuration builds its own hint prompt and preserves startup listing markers", async () => {
  const plain = fakeMemory();
  const hinted = { ...fakeMemory(), config: { memorySearchHintEnabled: true } };
  const first = fakeClient([reply("answer")]);
  const second = fakeClient([reply("answer")]);
  await answerQuestion({ ...options, memory: plain, client: first });
  await answerQuestion({ ...options, memory: hinted, client: second });
  assert.equal(first.requests[0].messages[0].content, buildSystemPrompt());
  assert.equal(second.requests[0].messages[0].content, buildSystemPrompt({ config: hinted.config }));
  for (const memory of [plain, hinted]) {
    const lists = memory.paths.map(url => new URL(url, "http://memory.invalid")).filter(url => /\/(preferences|entities)$/.test(url.searchParams.get("uri") ?? ""));
    assert.equal(lists.length, 2);
    for (const url of lists) assert.deepEqual(Object.fromEntries([...url.searchParams].filter(([key]) => key !== "uri")),
      { output: "agent", recursive: "true", abs_limit: "512", node_limit: "512" });
  }
});


test("answer grounding variants preserve original guidance bytes off and enable only their own wording", () => {
  const plain = buildSystemPrompt();
  const guidance = plain.slice(plain.indexOf('<evimed-orchestration>'));
  // Recorded before either change, by the 20-pair diagnosis replay against the original guidance.
  assert.equal(createHash('sha256').update(guidance).digest('hex'), '32046716dca679e404100b960f21b5c98fdd1bca225606193459a73347e3f894');
  assert.equal(buildSystemPrompt({ config: { memoryFormatGroundingEnabled: false, memoryMaterialAttributionEnabled: false } }), plain);
  const format = buildSystemPrompt({ config: { memoryFormatGroundingEnabled: true } });
  assert.ok(format.includes('否则整句改成【待补：…】'));
  assert.ok(!format.includes('对用户的描述只算材料的主张'));
  const material = buildSystemPrompt({ config: { memoryMaterialAttributionEnabled: true } });
  assert.ok(material.includes('对用户的描述只算材料的主张'));
  assert.ok(!material.includes('否则整句改成【待补：…】'));
});
