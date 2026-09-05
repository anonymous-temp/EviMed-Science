import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { CapsulesPage } from "./CapsulesPage";
import * as api from "@/lib/productClient";

vi.mock("@/lib/productClient");
const capsule = { id: "capsule-one", revision: 1, payload: { title: "我的科研方法", description: "" }, createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:00:00Z", deletedAt: null };
const candidate = { id: "entry-one", revision: 1, payload: { capsuleId: capsule.id, factKind: "method_preference", layer: "methods", content: "保留分析方案和原始结果", status: "candidate", origin: "inferred", provenance: [] }, createdAt: capsule.createdAt, updatedAt: capsule.updatedAt, deletedAt: null };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.listCapsules).mockResolvedValue({ items: [capsule], nextCursor: null });
  vi.mocked(api.listCapsuleEntries).mockResolvedValue({ items: [candidate], nextCursor: null });
  vi.mocked(api.productErrorMessage).mockImplementation(() => "操作未完成，请重试。");
});

it("lets the researcher approve a proposed memory and activate its capsule", async () => {
  vi.mocked(api.updateCapsuleEntry).mockResolvedValue({ ...candidate, revision: 2, payload: { ...candidate.payload, status: "approved" } });
  vi.mocked(api.activateCapsule).mockResolvedValue({});
  render(<CapsulesPage />);
  expect(await screen.findByText("保留分析方案和原始结果")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "采用" }));
  await waitFor(() => expect(api.updateCapsuleEntry).toHaveBeenCalledWith(capsule.id, candidate.id, { status: "approved", expectedRevision: 1 }));
  await userEvent.click(screen.getByRole("button", { name: "用于当前项目" }));
  expect(await screen.findByRole("status")).toHaveTextContent("已用于当前项目");
});

it("creates a named capsule through the visible form", async () => {
  vi.mocked(api.listCapsules).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(api.createCapsule).mockResolvedValue(capsule);
  vi.mocked(api.listCapsuleEntries).mockResolvedValue({ items: [], nextCursor: null });
  render(<CapsulesPage />);
  await userEvent.click(screen.getByRole("button", { name: "新建胶囊" }));
  await userEvent.type(screen.getByLabelText("胶囊名称"), "我的科研方法");
  await userEvent.click(screen.getByRole("button", { name: "创建" }));
  await waitFor(() => expect(api.createCapsule).toHaveBeenCalledWith({ title: "我的科研方法", description: "" }));
  expect(await screen.findByRole("button", { name: "用于当前项目" })).toBeInTheDocument();
});

it("loads recoverable trash and restores a capsule after a new visit", async () => {
  const removed = { ...capsule, revision: 2, deletedAt: capsule.updatedAt };
  vi.mocked(api.listCapsules).mockImplementation(async ({ deleted } = {}) => ({ items: deleted ? [removed] : [], nextCursor: null }));
  vi.mocked(api.restoreCapsule).mockResolvedValue({ ...capsule, revision: 3 });
  render(<CapsulesPage />);
  await userEvent.click(screen.getByRole("radio", { name: "回收站" }));
  await userEvent.click(await screen.findByRole("button", { name: "恢复胶囊" }));
  await waitFor(() => expect(api.restoreCapsule).toHaveBeenCalledWith(capsule.id, 2));
});
