import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMemoryWritePrompt, writePromptMessage } from "./useMemoryWritePrompt";

const client = vi.hoisted(() => ({
  fetchMemoryChanges: vi.fn(),
  undoMemoryRecord: vi.fn(),
  announceMemoryChanged: vi.fn(),
}));
vi.mock("@/lib/memoryClient", () => client);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

function Probe() {
  useMemoryWritePrompt();
  return null;
}

const change = (id: string, summary: string, version = 2) => ({
  id, key: `k.${id}`, kind: "preference", scope: "user", scopeId: "", summary, status: "active",
  change: "created" as const, changedAt: "2026-09-20T01:00:00Z", version,
});

describe("the write prompt on the next visit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("only starts the clock on the first visit, rather than listing everything ever learned", async () => {
    render(<Probe />);
    expect(window.localStorage.getItem("evimed.memory.seenAt")).toBeTruthy();
    expect(client.fetchMemoryChanges).not.toHaveBeenCalled();
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("says what was remembered since, in the researcher's words, and one click undoes all of it", async () => {
    window.localStorage.setItem("evimed.memory.seenAt", "2026-09-19T00:00:00.000Z");
    const changes = [change("a", "证据先用表格"), change("b", "队列 500 人", 3), change("c", "回答用中文")];
    client.fetchMemoryChanges.mockResolvedValue(changes);
    client.undoMemoryRecord.mockResolvedValue({ undone: "removed", record: null, restored: [] });
    render(<Probe />);
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(client.fetchMemoryChanges).toHaveBeenCalledWith({ since: "2026-09-19T00:00:00.000Z" });
    const [message, options] = toasts.success.mock.calls[0];
    expect(message).toBe("刚记住了 3 条：「证据先用表格」「队列 500 人」 等 3 条");
    expect(options.action.label).toBe("撤销");
    // No modal, no confirmation: the action is the undo.
    await options.action.onClick();
    await waitFor(() => expect(client.undoMemoryRecord).toHaveBeenCalledTimes(3));
    expect(client.undoMemoryRecord).toHaveBeenCalledWith("b", 3);
    expect(client.announceMemoryChanged).toHaveBeenCalled();
  });

  it("stays quiet when nothing changed", async () => {
    window.localStorage.setItem("evimed.memory.seenAt", "2026-09-19T00:00:00.000Z");
    client.fetchMemoryChanges.mockResolvedValue([]);
    render(<Probe />);
    await waitFor(() => expect(client.fetchMemoryChanges).toHaveBeenCalled());
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("names two and counts the rest", () => {
    expect(writePromptMessage([change("a", "甲")])).toBe("刚记住了 1 条：「甲」");
  });
});
