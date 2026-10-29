import { createRequire } from "node:module";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { ESLint } = require("eslint") as { ESLint: new () => { lintText: (code: string, options: { filePath: string }) => Promise<Array<{ messages: Array<{ message: string }> }>> } };

it("limits the IME submit lint rule to adopted text-submission handlers", async () => {
  const lint = new ESLint();
  const code = 'const onKeyDown = event => { if (event.key === "Enter") submit(); };';
  const adopted = await lint.lintText(code, { filePath: "src/app/routes/FrontierZonePage.tsx" });
  expect(adopted[0].messages.some(message => message.message.includes("Text submission must use isSubmitKey"))).toBe(true);
  const button = await lint.lintText(code, { filePath: "src/components/ui/Button.tsx" });
  expect(button[0].messages.some(message => message.message.includes("Text submission must use isSubmitKey"))).toBe(false);
  const guarded = await lint.lintText('const onKeyDown = event => { if (isSubmitKey(event)) submit(); };', { filePath: "src/app/routes/FrontierZonePage.tsx" });
  expect(guarded[0].messages.some(message => message.message.includes("Text submission must use isSubmitKey"))).toBe(false);
});

// Review R1 P2-3: the rule was written for the 虚拟临床研究 files in an override that the group's own syntax list later replaced, so
// it was dead there while the test only looked at an evidence-zone page.
it("holds the 虚拟临床研究 files to the IME submit rule too, whatever file of the group the handler is in", async () => {
  const lint = new ESLint();
  const raw = 'const onKeyDown = event => { if (event.key === "Enter") submit(); };';
  const flagged = (messages: Array<{ message: string }>) => messages.some(message => message.message.includes("Text submission must use isSubmitKey"));
  for (const filePath of ["src/components/vcr/VcrPrecedentsPanel.tsx", "src/components/vcr/tabs/OverviewTab.tsx", "src/app/virtual-research/VcrHomePage.tsx"]) {
    expect(flagged((await lint.lintText(raw, { filePath }))[0].messages), filePath).toBe(true);
    expect(flagged((await lint.lintText('const onKeyDown = event => { if (isSubmitKey(event)) submit(); };', { filePath }))[0].messages), filePath).toBe(false);
  }
});
