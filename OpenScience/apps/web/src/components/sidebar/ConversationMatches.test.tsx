import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provideFrameSessionSearch, type FrameSessionSearch } from "@/lib/runtimeUiBridge";
import { ConversationMatches } from "./ConversationMatches";

let release: (() => void) | null = null;

afterEach(() => {
  release?.();
  release = null;
});

function offer(search: FrameSessionSearch) {
  release = provideFrameSessionSearch(search);
}

describe("conversation matches under the task search", () => {
  it("is absent while no research frame offers the kernel's search", () => {
    const { container } = render(<MemoryRouter><ConversationMatches query="阿司匹林" shownSessionIds={new Set()} /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the kernel's matches, links each to its conversation, and skips ones already shown", async () => {
    const search = vi.fn<FrameSessionSearch>().mockResolvedValue({
      ok: true,
      hasMore: false,
      items: [
        { sessionId: "sess-a", title: "阿司匹林一级预防", snippet: "ASPREE 研究显示…" },
        { sessionId: "sess-b", title: "已在任务里", snippet: "" },
      ],
    });
    offer(search);
    render(<MemoryRouter><ConversationMatches query="ASPREE" shownSessionIds={new Set(["sess-b"])} /></MemoryRouter>);
    const link = await screen.findByRole("link", { name: /阿司匹林一级预防/ });
    expect(link).toHaveAttribute("href", "/app/chat/sess-a");
    expect(screen.queryByText("已在任务里")).toBeNull();
    expect(search).toHaveBeenCalledWith("ASPREE", expect.any(AbortSignal));
  });

  it("asks nothing for a one-character query and shows nothing when the kernel refuses", async () => {
    const search = vi.fn<FrameSessionSearch>().mockResolvedValue({ ok: false, items: [], hasMore: false, error: "search_failed" });
    offer(search);
    const { container, rerender } = render(<MemoryRouter><ConversationMatches query="阿" shownSessionIds={new Set()} /></MemoryRouter>);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(search).not.toHaveBeenCalled();
    rerender(<MemoryRouter><ConversationMatches query="阿司匹林" shownSessionIds={new Set()} /></MemoryRouter>);
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
