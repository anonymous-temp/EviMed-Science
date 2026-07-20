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

  it("marks document-variant blocks with the paper highlight palette", () => {
    const { container } = render(
      <MarkdownViewer variant="document">{"```js\nlet x = 1;\n```"}</MarkdownViewer>,
    );
    expect(container.querySelector("pre")).toHaveClass("hljs-paper");
  });

  it("keeps inline code unhighlighted and intact", () => {
    const { container } = render(<MarkdownViewer>{"use `npm test` to verify"}</MarkdownViewer>);
    const code = container.querySelector("code");
    expect(code).toHaveTextContent("npm test");
    expect(code).not.toHaveClass("hljs");
  });
});
