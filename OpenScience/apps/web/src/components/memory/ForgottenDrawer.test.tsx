import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plainRecord } from "./__fixtures__/memoryProfiles";
import { ForgottenDrawer } from "./ForgottenDrawer";
import userEvent from "@testing-library/user-event";
import { deleteConversationSource } from "@/lib/conversationSourceDeletionClient";

vi.mock("@/components/capsule/useCapsuleData", () => ({ useCapsuleData: () => ({ data: [], failed: false, reload: vi.fn() }) }));
vi.mock("@/lib/apiClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient")), updateStructuredMemory: vi.fn() }));
vi.mock("@/lib/memoryClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/memoryClient")>("@/lib/memoryClient")),
  announceMemoryChanged: vi.fn(), restoreCapsuleEntry: vi.fn(),
}));
vi.mock("@/lib/conversationSourceDeletionClient", () => ({ deleteConversationSource: vi.fn(), conversationSourceStatus: vi.fn() }));

function show(records: Parameters<typeof ForgottenDrawer>[0]["records"], requests?: Parameters<typeof ForgottenDrawer>[0]["requests"]) {
  return render(<ForgottenDrawer records={records} entries={[]} requests={requests} projectName={() => null} onClose={vi.fn()} onChanged={vi.fn()} />);
}

afterEach(cleanup);

describe("forgotten memory wording", () => {
  it("shows the statement held by a synthetic forget intent, never its generated name", () => {
    const record = plainRecord({
      id: "nm_forget", kind: "note", status: "archived", nativeType: "notes",
      summary: "forget-c804759d9785bde0331f4e01", value: "每周三晚上去游泳",
    });
    show([record]);
    expect(screen.getByText("每周三晚上去游泳（未存为记忆，已阻止以后记住）")).toBeInTheDocument();
    expect(screen.queryByText(/forget-c804/)).toBeNull();
  });

  it("prefers an archived record's stored words to its synthetic or topic summary", () => {
    show([plainRecord({ status: "archived", summary: "内部标题", value: "被忘记的原话" })]);
    expect(screen.getByText("被忘记的原话")).toBeInTheDocument();
    expect(screen.queryByText("内部标题")).toBeNull();
  });

  it("shows each request's reviewed status, without a restore action for a request", () => {
    show([], [
      { id: "a", text: "Request A", at: "", status: "requested" },
      { id: "b", text: "Request B", at: "", status: "executed" },
      { id: "c", text: "Request C", at: "", status: "pending_verification" },
      { id: "d", text: "Request D", at: "", status: "not_executed" },
    ]);
    for (const label of ["已请求", "已执行", "待核验", "未执行"]) {
      expect(screen.getByText(`遗忘请求 · ${label}`)).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "恢复" })).toBeNull();
  });

  it("deletes only the proven source conversation after its own confirmation", async () => {
    const user = userEvent.setup();
    vi.mocked(deleteConversationSource).mockResolvedValue({ id: "deletion", sessionId: "session_original", sourceRemoved: true, cleanup: "complete", reason: null });
    show([
      plainRecord({ id: "no-source", status: "archived", value: "Imported note" }),
      plainRecord({ id: "known", status: "archived", value: "Conversation note", evidence: [
        { sourceType: "conversation", sourceRef: "sessions/session_original/commits/archive_001", projectId: "p",
          quote: "", observedAt: null, weight: 1, fingerprint: "revision:1" },
      ] }),
    ]);
    await user.click(screen.getByRole("button", { name: "删除来源对话" }));
    expect(screen.getByText(/忘记记忆后，原始对话仍然保留/)).toBeInTheDocument();
    expect(deleteConversationSource).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "永久删除" }));
    expect(deleteConversationSource).toHaveBeenCalledWith("p", "session_original");
  });
});
