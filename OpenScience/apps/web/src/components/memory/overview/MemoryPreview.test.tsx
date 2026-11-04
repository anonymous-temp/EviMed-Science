import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { plainRecord } from "@/components/memory/__fixtures__/memoryProfiles";
import { livedIn, memoryMark } from "./__fixtures__/overviewDocs";
import { MemoryPreview } from "./MemoryPreview";

const reads = vi.hoisted(() => ({ profile: vi.fn(), capsule: vi.fn() }));
vi.mock("@/lib/apiClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient")), fetchMemoryProfile: reads.profile,
}));
vi.mock("@/lib/memoryClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/memoryClient")>("@/lib/memoryClient")), fetchMyCapsule: reads.capsule,
}));

beforeEach(() => { reads.profile.mockReset(); reads.capsule.mockReset(); });
afterEach(cleanup);

it("reads the selected record, hides its internal topic and opens real related marks and details", async () => {
  const user = userEvent.setup();
  const node = memoryMark("one", { label: "writing_style_notes" });
  const related = memoryMark("two", { label: "回答先给结论" });
  const doc = livedIn({ nodes: [node, related], edges: [{ from: node.id, to: related.id, type: "relates" }] });
  reads.profile.mockResolvedValue({ records: [plainRecord({ id: "one", value: "- 引用数字时先查原文。" })] });
  const onOpen = vi.fn();
  const onSelect = vi.fn();
  render(<MemoryRouter><MemoryPreview node={node} doc={doc} methods={[]} projectName={() => null} onOpen={onOpen} onSelect={onSelect} /></MemoryRouter>);

  const panel = screen.getByRole("complementary", { name: "记忆预览" });
  expect(await within(panel).findByText("引用数字时先查原文")).toBeInTheDocument();
  expect(within(panel).getByRole("heading", { name: "记忆内容" })).toBeInTheDocument();
  expect(within(panel).queryByText("writing_style_notes")).toBeNull();
  await user.click(within(panel).getByRole("button", { name: "回答先给结论" }));
  expect(onSelect).toHaveBeenCalledWith(related);
  await user.click(within(panel).getByRole("button", { name: "查看详情" }));
  expect(onOpen).toHaveBeenCalledWith(node);
});

it("distinguishes a failed read from a missing record and retries the same selection", async () => {
  const user = userEvent.setup();
  const node = memoryMark("one");
  reads.profile.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ records: [] });
  render(<MemoryRouter><MemoryPreview node={node} doc={livedIn()} methods={[]} projectName={() => null} onOpen={vi.fn()} onSelect={vi.fn()} /></MemoryRouter>);

  expect(await screen.findByText("暂时读不到完整内容。")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("这条内容已不存在。")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "查看详情" })).toBeNull();
});

it("does not show a slower earlier selection after the reader selects another record", async () => {
  let resolveFirst!: (value: unknown) => void;
  const first = memoryMark("one", { label: "第一条" });
  const second = memoryMark("two", { label: "第二条" });
  const doc = livedIn({ nodes: [first, second] });
  reads.profile.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
    .mockResolvedValueOnce({ records: [plainRecord({ id: "two", value: "第二条的正文" })] });
  const view = render(<MemoryRouter><MemoryPreview node={first} doc={doc} methods={[]} projectName={() => null} onOpen={vi.fn()} onSelect={vi.fn()} /></MemoryRouter>);
  view.rerender(<MemoryRouter><MemoryPreview node={second} doc={doc} methods={[]} projectName={() => null} onOpen={vi.fn()} onSelect={vi.fn()} /></MemoryRouter>);

  expect(await screen.findByText("第二条的正文")).toBeInTheDocument();
  resolveFirst({ records: [plainRecord({ id: "one", value: "第一条的旧正文" })] });
  await Promise.resolve();
  expect(screen.queryByText("第一条的旧正文")).toBeNull();
  expect(screen.getByRole("heading", { name: "第二条" })).toBeInTheDocument();
});
