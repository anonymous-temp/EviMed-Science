import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownViewer } from "./MarkdownViewer";

const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

// Spec §3.4 and §21.10, audit F-G8: a report's title is the one place in it
// set in the serif — through the `doc-title` rung, which carries the family —
// and its sections are 18 / 600 in the sans.
describe("MarkdownViewer report headings", () => {
  it("sets the document title on the serif rung and the sections in the sans", () => {
    render(<MarkdownViewer variant="document">{"# 阿司匹林一级预防\n\n## 主要结果\n\n### 亚组\n\n#### 说明"}</MarkdownViewer>);
    const title = screen.getByRole("heading", { level: 1, name: "阿司匹林一级预防" });
    expect(title).toHaveClass("text-doc-title", "font-semibold");
    expect(screen.getByRole("heading", { level: 2 })).toHaveClass("text-section", "font-semibold");
    expect(screen.getByRole("heading", { level: 3 })).toHaveClass("text-body");
    expect(screen.getByRole("heading", { level: 4 })).toHaveClass("text-ui", "text-text-2");
    // No heading names the serif itself: the rung is the only way in.
    for (const heading of screen.getAllByRole("heading")) expect(heading.className).not.toMatch(/font-serif/);
    for (const level of [2, 3, 4]) expect(screen.getByRole("heading", { level }).className).not.toMatch(/text-(doc-title|wordmark|hero)/);
  });
});

describe("MarkdownViewer code blocks", () => {
  it("highlights a fenced block whose language highlight.js knows", () => {
    const { container } = render(
      <MarkdownViewer>{"```js\nconst answer = 42;\n```"}</MarkdownViewer>,
    );
    const code = container.querySelector("pre code.hljs");
    expect(code).toBeInTheDocument();
    // `const` and the number are wrapped into token spans by highlight.js.
    expect(code!.querySelector(".hljs-keyword")).toHaveTextContent("const");
    expect(code!.querySelector(".hljs-number")).toHaveTextContent("42");
  });

  it("renders an unlabeled fence as plain text (no auto-detect flicker)", () => {
    const { container } = render(
      <MarkdownViewer>{"```\nplain <code> & friends\n```"}</MarkdownViewer>,
    );
    const code = container.querySelector("pre code");
    expect(code).toBeInTheDocument();
    expect(code).not.toHaveClass("hljs");
    expect(code!.querySelector("[class*='hljs-']")).toBeNull();
    expect(code).toHaveTextContent("plain <code> & friends");
  });

  it("renders an unknown language as plain text without throwing", () => {
    const { container } = render(
      <MarkdownViewer>{"```madeuplang\nsome code\n```"}</MarkdownViewer>,
    );
    const code = container.querySelector("pre code");
    expect(code).not.toHaveClass("hljs");
    expect(code).toHaveTextContent("some code");
  });

  it("copies the raw code from the copy button", async () => {
    render(<MarkdownViewer>{"```python\nprint('hi')\n```"}</MarkdownViewer>);
    await userEvent.click(screen.getByRole("button", { name: "复制代码" }));
    expect(writeText).toHaveBeenCalledWith("print('hi')");
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  // A report follows the theme like the rest of the shell: no fixed paper
  // palette of its own, so dark mode does not leave one white page.
  it("renders a report's code blocks on the theme tokens, with no paper palette", () => {
    const { container } = render(
      <MarkdownViewer variant="document">{"```js\nlet x = 1;\n```"}</MarkdownViewer>,
    );
    const pre = container.querySelector("pre");
    expect(pre).toHaveClass("bg-surface-2");
    expect(pre).not.toHaveClass("hljs-paper");
  });

  it("keeps inline code unhighlighted and intact", () => {
    const { container } = render(<MarkdownViewer>{"use `npm test` to verify"}</MarkdownViewer>);
    const code = container.querySelector("code");
    expect(code).toHaveTextContent("npm test");
    expect(code).not.toHaveClass("hljs");
  });
});

describe("MarkdownViewer line breaks", () => {
  it("renders a single newline as a line break (chat prose convention)", () => {
    const { container } = render(<MarkdownViewer>{"第一行\n第二行"}</MarkdownViewer>);
    expect(container.querySelector("p br")).toBeInTheDocument();
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("keeps blank lines as paragraph breaks", () => {
    const { container } = render(<MarkdownViewer>{"第一段\n\n第二段"}</MarkdownViewer>);
    const ps = container.querySelectorAll("p");
    expect(ps).toHaveLength(2);
    expect(ps[0]).toHaveTextContent("第一段");
    expect(ps[1]).toHaveTextContent("第二段");
  });
});
