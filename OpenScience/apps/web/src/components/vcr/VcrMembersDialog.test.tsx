import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { VcrMembersDialog } from "./VcrMembersDialog";
const api = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => api);
it("labels retired roles for revocation while keeping them out of the add picker", async () => {
  api.productRequest.mockImplementation(async (_path: string, method?: string) => method === "DELETE" ? {} : { members: [{ userId: "old_user", name: "旧版成员", owner: false, roles: ["recruiter", "clinical_reviewer"] }] });
  render(<MemoryRouter><VcrMembersDialog studyId="std_a" onClose={() => {}} /></MemoryRouter>);
  expect(await screen.findByText("旧版协调角色（已停用）")).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /旧版|招募|中心/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "移除 旧版成员 的“旧版协调角色（已停用）”" }));
  await waitFor(() => expect(api.productRequest).toHaveBeenCalledWith("/vcr/studies/std_a/members/old_user?role=recruiter", "DELETE"));
});
