// @vitest-environment node
import { relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORK_STATE_LABEL } from "@evimed/domain";
import { shellSources, sourceStrings, walk } from "../test/sourceStrings";

/**
 * The state of work is said in one set of words (`@evimed/domain` `workState.mjs`, module workspace audit of 2026-11-01, §B): the
 * audit found five ways to say running and one word, 待核对, with four meanings. A page that needs a state word asks the domain
 * (`workStateLabel`); a string that spells one of the retired ways to say running on the pages below fails here, so the five do not
 * grow back. The walk is over every string a page can render, never over a comment.
 *
 * What is not a state of work is not held: a container's own running (`WebResourcesCard`, the operator's card for a runtime), a sentence that
 * says a thing is going on (「…还有排队或运行中的任务」), a keyboard shortcut's description.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const OWNED = [
  "app/routes/ActiveResearchPage.tsx", "app/routes/InboxPage.tsx", "app/routes/RunFilePage.tsx",
  "components/activeResearch", "components/inbox", "components/runs", "components/sources", "components/memory", "components/frontier", "components/search",
  "components/settings", "lib/runPresentation.ts", "lib/runProgress.ts", "lib/statusLabel.ts",
];
const RETIRED = /研究进行中|执行中|运行中|工作中/;
/** Strings that say something else with one of the words: the file and a piece of the string. */
const NOT_A_STATE: ReadonlyArray<readonly [string, string]> = [
  ["components/settings/WebResourcesCard.tsx", "运行中"],
  ["components/settings/ProjectsSection.tsx", "排队或运行中的任务"],
  ["components/settings/AppearanceSection.tsx", "运行中插话"],
];

describe("the words for the state of work on the pages of the module workspace", () => {
  const shell = new Set(shellSources(SRC));
  const files = OWNED.flatMap((entry) => walk(join(SRC, entry))).filter((path) => shell.has(path));

  it("walks the pages it names", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("spells none of the retired ways to say running", () => {
    const found: string[] = [];
    for (const path of files) {
      const name = relative(SRC, path).split("\\").join("/");
      for (const { line, text } of sourceStrings(path)) {
        if (!RETIRED.test(text)) continue;
        if (NOT_A_STATE.some(([file, piece]) => file === name && text.includes(piece))) continue;
        found.push(`${name}:${line} ${text.slice(0, 60)}`);
      }
    }
    expect(found, "say 进行中 (workStateLabel('running')); a sentence may say 正在…").toEqual([]);
  });

  it("holds the domain's words themselves: running is 进行中, a stop by the person is 已停止, a failure with partial work is 未完成", () => {
    expect([WORK_STATE_LABEL.running, WORK_STATE_LABEL.stopped, WORK_STATE_LABEL.failed, WORK_STATE_LABEL.queued]).toEqual(["进行中", "已停止", "未完成", "排队中"]);
  });
});
