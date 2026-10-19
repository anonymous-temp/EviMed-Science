import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { VcrReferenceSearch } from "./VcrReferenceSearch";
import { installVcrServer } from "./__fixtures__/serverFixtures";
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

it("reads the registration before applying preserved evidence to an existing study", async () => {
  const onApplied = vi.fn();
  const server = installVcrServer(network.productRequest, {
    "GET /vcr/precedents/search": { status: "ok", candidates: [{ registry: "clinicaltrials.gov", registryId: "NCT00000001", title: "Diabetes trial" }], registries: [{ registry: "clinicaltrials.gov", status: "ok", total: 1 }, { registry: "ctis", status: "unavailable", reason: "timeout" }] },
    "GET /vcr/precedents/record": { status: "ok", available: true, record: { title: "Preserved trial", text: "Enrollment anticipated 120", enrollment: { planned: 120, actual: null }, values: [{ parameter: "enrollment", value: 120, unit: "people", verification: "verified" }] } },
    "POST /vcr/precedents/apply": { status: "ok", counts: { verified: 1, refused: 0 } },
  });
  render(<MemoryRouter><VcrReferenceSearch query="diabetes" onApplied={onApplied} /></MemoryRouter>);
  await userEvent.click(await screen.findByText("NCT00000001"));
  expect(await screen.findByText("Preserved trial")).toBeInTheDocument();
  expect(screen.getByText("未登记")).toBeInTheDocument();
  expect(screen.getByText(/ctis · 未能查询：timeout/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "保存为研究参考试验" })).toBeDisabled();
  const choice = await screen.findByLabelText("用于现有研究");
  const option = choice.querySelectorAll("option")[1];
  await userEvent.selectOptions(choice, option.value);
  await userEvent.click(screen.getByRole("button", { name: "保存为研究参考试验" }));
  await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
  const applied = server.calls.find(row => row.method === "POST");
  expect(applied?.body).toEqual({ studyId: option.value, registry: "clinicaltrials.gov", registryId: "NCT00000001" });
});
