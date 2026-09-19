// The pages a run read, on its record (contract X5): read off the run's own
// transcripts — root and delegated children — at the end of the run, with the
// 官方来源 label recomputed here, and kept small on a ledger with a ceiling.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentRunStore } from "../src/agentRuns.mjs";
import { MAX_PAGES_READ, pagesReadFromSessions } from "../src/webReadPages.mjs";

const sha = (letter) => letter.repeat(64);

/** A `web_read` result exactly as the MCP server renders it into the transcript. */
function webReadOutput(url, digest, extra = {}) {
  return JSON.stringify({
    status: extra.status ?? "success",
    summary: "Read the page and preserved it (page 1 of 1).",
    data: {
      url, finalUrl: extra.finalUrl ?? url, title: extra.title ?? "公告通告", site: new URL(extra.finalUrl ?? url).hostname,
      fetchedAt: "2026-09-20T02:00:00.000Z", official: extra.official ?? false, rendered: extra.rendered ?? false,
      contentType: "html", mediaType: "text/html", sha256: digest,
      markdownPath: extra.markdownPath ?? `.evimed-sources/web-pages/${digest.slice(0, 16)}/${"c".repeat(64)}/page.md`,
      page: 1, pages: 1, nextPage: null, content: "…",
    },
    sources: [{ id: `web-page:${digest.slice(0, 16)}`, url, source: "web-page" }],
    artifacts: [`.evimed-sources/web-pages/${digest.slice(0, 16)}/${"c".repeat(64)}/page.md`],
  });
}

function session(sessionId, calls) {
  return {
    sessionId,
    transcript: {
      sessionId,
      messages: [{
        role: "assistant", turn: 1, seq: 1,
        parts: calls.map((call, index) => ({ type: "tool", tool: call.tool ?? "mcp__evimed__web_read", status: call.status ?? "completed", error: call.error ?? null, input: {}, output: call.output, completedSeq: index + 1 })),
      }],
    },
  };
}

test("the pages a run read come off its transcripts, children included, once each", () => {
  const nmpa = "https://www.nmpa.gov.cn/xxgk/ggtg/index.html";
  const blog = "https://blog.example.org/post";
  const { pages, total } = pagesReadFromSessions([
    session("root", [
      { output: webReadOutput(nmpa, sha("a"), { rendered: true, official: true }) },
      // A page claiming to be official does not make itself so.
      { output: webReadOutput(blog, sha("b"), { official: true }) },
      { tool: "mcp__evimed__literature_search", output: JSON.stringify({ status: "success", data: {} }) },
      { output: JSON.stringify({ status: "error", error: { code: "web_read_robots_disallowed" } }) },
    ]),
    session("child", [
      // The same page read again by a delegated child is one page.
      { output: webReadOutput(nmpa, sha("a"), { rendered: true }) },
      // A redirected read is recorded under the address the bytes came from.
      { output: webReadOutput("http://short.example.org/r", sha("d"), { finalUrl: "https://clinicaltrials.gov/study/NCT03036124" }) },
      // Malformed receipts are dropped rather than half-shown.
      { output: webReadOutput("https://x.example.org/", "not-a-digest") },
      { output: webReadOutput("https://y.example.org/", sha("e"), { markdownPath: "../../etc/passwd" }) },
      { output: "Error: {\"status\":\"error\"}" },
    ]),
  ]);
  assert.equal(total, 4);
  assert.deepEqual(pages.map((page) => [page.site, page.official, page.rendered]), [
    ["www.nmpa.gov.cn", true, true],
    ["blog.example.org", false, false],
    ["clinicaltrials.gov", true, false],
    ["y.example.org", false, false],
  ]);
  assert.equal(pages[0].snapshotPath, `.evimed-sources/web-pages/${"a".repeat(16)}/${"c".repeat(64)}/page.md`);
  assert.equal(pages[2].url, "http://short.example.org/r");
  assert.equal(pages[2].finalUrl, "https://clinicaltrials.gov/study/NCT03036124");
  assert.equal(pages[3].snapshotPath, undefined, "a path outside the web snapshots is not offered as a link");
});

test("a run that read more pages than a record keeps says how many it read", () => {
  const calls = Array.from({ length: MAX_PAGES_READ + 6 }, (_, index) => ({
    output: webReadOutput(`https://site${index}.example.org/`, index.toString(16).padStart(64, "0")),
  }));
  const { pages, total } = pagesReadFromSessions([session("root", calls)]);
  assert.equal(pages.length, MAX_PAGES_READ);
  assert.equal(total, MAX_PAGES_READ + 6);
});

test("the ledger keeps the reading list normalized, capped and merged like every learning field", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-pages-read-"));
  try {
    const project = { id: "project-1", userId: "user-1", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = { sessionId: "ses_pages", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro", monitorIntervalMs: 60_000, monitorMaxPolls: 20,
      readSessionHistory: async () => [], readSessionStatus: async () => "idle",
    });
    store.scheduleMonitor = () => {};
    const run = await store.dispatch(project, { sessionId: binding.sessionId, dispatchId: "turn_pages" }, async () => ({ accepted: true }));

    const reported = JSON.parse(webReadOutput("https://www.nice.org.uk/guidance/ng136", sha("f"), { title: "  Hypertension in adults \n" })).data;
    await store.recordLearning(project, run.id, {
      pagesRead: [{ ...reported, content: "PAGE TEXT MUST NOT REACH THE LEDGER" }, { url: "javascript:alert(1)", sha256: sha("a") }],
      pagesReadTotal: 2,
    });
    // Another writer's later field must not erase the list.
    await store.recordLearning(project, run.id, { mountedSkills: ["open-domain-answer"] });
    const [stored] = await store.list(project);
    assert.deepEqual(stored.pagesRead, [{
      url: "https://www.nice.org.uk/guidance/ng136",
      finalUrl: "https://www.nice.org.uk/guidance/ng136",
      title: "Hypertension in adults",
      site: "www.nice.org.uk",
      fetchedAt: "2026-09-20T02:00:00.000Z",
      official: true,
      rendered: false,
      snapshotPath: `.evimed-sources/web-pages/${"f".repeat(16)}/${"c".repeat(64)}/page.md`,
      sha256: sha("f"),
    }]);
    assert.equal(stored.pagesReadTotal, 2);
    assert.deepEqual(stored.mountedSkills, ["open-domain-answer"]);
    const ledger = await readFile(path.join(project.metaDir, "runs.jsonl"), "utf8");
    assert.ok(!ledger.includes("PAGE TEXT"), "a page's text reached the run ledger");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the terminal hook feeds the list from the transcript it already read", async () => {
  // Wired is not fed: a module nobody calls produces an empty card forever.
  // The hook reads the run's sessions once for the transcript; the list must
  // come from those same sessions and reach the ledger in a write of its own.
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const at = source.indexOf("const receipt = await persistRunTranscript({ project, run, sessions });");
  assert.ok(at >= 0, "the terminal hook's transcript write moved");
  const hook = source.slice(at);
  assert.match(hook.slice(0, 1200), /const reading = pagesReadFromSessions\(sessions\);/);
  assert.match(hook.slice(0, 1200), /recordLearning\(project, run\.id, \{ pagesRead: reading\.pages, pagesReadTotal: reading\.total \}\)/);
});
