import { createRequire } from "node:module";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { ESLint } = require("eslint") as { ESLint: new () => { lintText: (code: string, options: { filePath: string }) => Promise<Array<{ messages: Array<{ message: string }> }>> } };

it("limits the IME submit lint rule to adopted text-submission handlers", async () => {
  const lint = new ESLint();
  const code = 'const onKeyDown = event => { if (event.key === "Enter") submit(); };';
  const adopted = await lint.lintText(code, { filePath: "src/app/routes/EvidenceZonePage.tsx" });
  expect(adopted[0].messages.some(message => message.message.includes("Text submission must use isSubmitKey"))).toBe(true);
  const button = await lint.lintText(code, { filePath: "src/components/ui/Button.tsx" });
  expect(button[0].messages.some(message => message.message.includes("Text submission must use isSubmitKey"))).toBe(false);
  const guarded = await lint.lintText('const onKeyDown = event => { if (isSubmitKey(event)) submit(); };', { filePath: "src/app/routes/EvidenceZonePage.tsx" });
  expect(guarded[0].messages.some(message => message.message.includes("Text submission must use isSubmitKey"))).toBe(false);
});
