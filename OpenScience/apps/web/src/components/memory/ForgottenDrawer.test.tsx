import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plainRecord } from "./__fixtures__/memoryProfiles";
import { ForgottenDrawer } from "./ForgottenDrawer";

vi.mock("@/components/capsule/useCapsuleData", () => ({ useCapsuleData: () => ({ data: [], failed: false, reload: vi.fn() }) }));
vi.mock("@/lib/apiClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient")), updateStructuredMemory: vi.fn() }));
vi.mock("@/lib/memoryClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/memoryClient")>("@/lib/memoryClient")),
  announceMemoryChanged: vi.fn(), restoreCapsuleEntry: vi.fn(),
}));

function show(records: Parameters<typeof ForgottenDrawer>[0]["records"]) {
  return render(<ForgottenDrawer records={records} entries={[]} projectName={() => null} onClose={vi.fn()} onChanged={vi.fn()} />);
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
});
