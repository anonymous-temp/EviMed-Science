import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seenKey, useMemoryWritePrompt, writePromptMessage } from "./useMemoryWritePrompt";

const client = vi.hoisted(() => ({
  fetchMemoryChanges: vi.fn(),
  undoMemoryRecord: vi.fn(),
  announceMemoryChanged: vi.fn(),
}));
vi.mock("@/lib/memoryClient", () => client);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));
const account = vi.hoisted(() => ({ me: vi.fn(), project: vi.fn() }));
vi.mock("@/lib/apiClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient")),
  fetchWebMe: () => account.me(),
  getWebProjectId: () => account.project(),
}));

function Probe() {
  useMemoryWritePrompt();
  return null;
}

const change = (id: string, summary: string, version = 2) => ({
  id, key: `k.${id}`, kind: "preference", scope: "user", scopeId: "", summary, status: "active",
  change: "created" as const, changedAt: "2026-09-20T01:00:00Z", version,
});

const KEY = seenKey("u1", "p1");

describe("the write prompt on the next visit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    account.me.mockResolvedValue({ user: { id: "u1", name: "甲" } });
    account.project.mockReturnValue("p1");
  });

  it("only starts the clock on the first visit, rather than listing everything ever learned", async () => {
    render(<Probe />);
    await waitFor(() => expect(window.localStorage.getItem(KEY)).toBeTruthy());
    expect(client.fetchMemoryChanges).not.toHaveBeenCalled();
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("keeps one clock for each account and project: a visit as one never starts or reads another's", async () => {
    window.localStorage.setItem(seenKey("u2", "p1"), "2026-09-19T00:00:00.000Z");
    window.localStorage.setItem(seenKey("u1", "p2"), "2026-09-19T00:00:00.000Z");
    window.localStorage.setItem("evimed.memory.seenAt", "2026-09-19T00:00:00.000Z");
    client.fetchMemoryChanges.mockResolvedValue([]);
    render(<Probe />);
    await waitFor(() => expect(window.localStorage.getItem(KEY)).toBeTruthy());
    // The other keys, and the old one key for everybody, were not this visit's clock: the first visit as this account in this project starts one.
    expect(client.fetchMemoryChanges).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(seenKey("u2", "p1"))).toBe("2026-09-19T00:00:00.000Z");
    expect(window.localStorage.getItem(seenKey("u1", "p2"))).toBe("2026-09-19T00:00:00.000Z");
  });

  it("starts no clock when there is no account to name", async () => {
    account.me.mockResolvedValue(null);
    render(<Probe />);
    await waitFor(() => expect(account.me).toHaveBeenCalled());
    expect(window.localStorage.length).toBe(0);
    expect(client.fetchMemoryChanges).not.toHaveBeenCalled();
  });

  it("says what was remembered since, in the researcher's words, and one click undoes all of it", async () => {
    window.localStorage.setItem(KEY, "2026-09-19T00:00:00.000Z");
    const changes = [change("a", "证据先用表格"), change("b", "队列 500 人", 3), change("c", "回答用中文")];
    client.fetchMemoryChanges.mockResolvedValue(changes);
    client.undoMemoryRecord.mockResolvedValue({ undone: "removed", record: null, restored: [] });
    render(<Probe />);
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(client.fetchMemoryChanges).toHaveBeenCalledWith({ since: "2026-09-19T00:00:00.000Z" });
    const [message, options] = toasts.success.mock.calls[0];
    expect(message).toBe("刚记住了 3 条：“证据先用表格”“队列 500 人” 等 3 条");
    expect(options.action.label).toBe("撤销");
    // No modal, no confirmation: the action is the undo.
    await options.action.onClick();
    await waitFor(() => expect(client.undoMemoryRecord).toHaveBeenCalledTimes(3));
    expect(client.undoMemoryRecord).toHaveBeenCalledWith("b", 3);
    expect(client.announceMemoryChanged).toHaveBeenCalled();
  });

  it("stays quiet when nothing changed", async () => {
    window.localStorage.setItem(KEY, "2026-09-19T00:00:00.000Z");
    client.fetchMemoryChanges.mockResolvedValue([]);
    render(<Probe />);
    await waitFor(() => expect(client.fetchMemoryChanges).toHaveBeenCalled());
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("names two and counts the rest", () => {
    expect(writePromptMessage([change("a", "甲")])).toBe("刚记住了 1 条：“甲”");
  });
});
