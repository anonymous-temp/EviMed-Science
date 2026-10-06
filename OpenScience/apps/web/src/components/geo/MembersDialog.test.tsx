import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MembersDialog } from "./MembersDialog";
import { ProducerDialog } from "./ProducerDialog";

const client = vi.hoisted(() => ({ getGeoMembers: vi.fn(), addGeoMember: vi.fn(), removeGeoMember: vi.fn(), patchGeoProject: vi.fn() }));
vi.mock("@/lib/geoClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/geoClient")>()), ...client }));

const ownerView = {
  members: [
    { userId: "u_owner", name: "王负责人", owner: true, roles: ["owner"], roleLabels: ["负责人"], abilities: ["read", "manage_members"], detail: {} },
    { userId: "u_rev", name: "张医生", owner: false, roles: ["medical_reviewer"], roleLabels: ["医学审核"], abilities: ["read", "review"], detail: { hospital: "某某医院" } },
  ],
  you: { roles: ["owner"], abilities: ["read", "edit", "run", "review", "manage_money", "manage_members", "delete"] },
};

beforeEach(() => {
  vi.clearAllMocks();
  client.getGeoMembers.mockResolvedValue(ownerView);
  client.addGeoMember.mockResolvedValue({});
  client.removeGeoMember.mockResolvedValue({ removed: 1 });
  client.patchGeoProject.mockResolvedValue({});
});

describe("成员", () => {
  it("lists the owner first, adds a medical reviewer with the hospital and department their byline shows, and removes a member", async () => {
    render(<MembersDialog geoId="geo_1" onClose={() => {}} />);
    const list = await screen.findByRole("list", { name: "成员列表" });
    expect(within(list).getAllByRole("listitem").map((row) => row.textContent)).toEqual(["王负责人负责人", "张医生医学审核移除"]);
    await userEvent.type(screen.getByLabelText("成员的账号"), "u_new");
    await userEvent.click(screen.getByRole("button", { name: "医学审核" }));
    await userEvent.type(screen.getByLabelText("医院"), "某某医院");
    await userEvent.type(screen.getByLabelText("科室"), "内分泌科");
    await userEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(client.addGeoMember).toHaveBeenCalledWith("geo_1", { userId: "u_new", role: "medical_reviewer", detail: { hospital: "某某医院", department: "内分泌科" } }));
    await userEvent.click(screen.getByRole("button", { name: "移除" }));
    await waitFor(() => expect(client.removeGeoMember).toHaveBeenCalledWith("geo_1", "u_rev"));
  });

  it("offers a member who cannot manage the list no form and no removal", async () => {
    client.getGeoMembers.mockResolvedValue({ ...ownerView, you: { roles: ["viewer"], abilities: ["read"] } });
    render(<MembersDialog geoId="geo_1" onClose={() => {}} />);
    await screen.findByRole("list", { name: "成员列表" });
    expect(screen.queryByLabelText("成员的账号")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
  });

  it("says what the server refused, in its own sentence", async () => {
    client.addGeoMember.mockRejectedValue(new Error("no"));
    render(<MembersDialog geoId="geo_1" onClose={() => {}} />);
    await screen.findByRole("list", { name: "成员列表" });
    await userEvent.type(screen.getByLabelText("成员的账号"), "u_new");
    await userEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

describe("出品方", () => {
  it("saves a company with no more than its kind when the name is left to the label's holder", async () => {
    const saved = vi.fn();
    render(<ProducerDialog geoId="geo_1" initial={null} onSaved={saved} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.patchGeoProject).toHaveBeenCalledWith("geo_1", { producer: { kind: "enterprise" } }));
    expect(saved).toHaveBeenCalled();
  });

  it("asks a doctor for the name, then saves it with the hospital and department the byline shows", async () => {
    render(<ProducerDialog geoId="geo_1" initial={null} onSaved={() => {}} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "医生" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("请填医生的姓名。")).toBeInTheDocument();
    expect(client.patchGeoProject).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("医生姓名"), "张医生");
    await userEvent.type(screen.getByLabelText("医院"), "某某医院");
    await userEvent.type(screen.getByLabelText("科室"), "内分泌科");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.patchGeoProject).toHaveBeenCalledWith("geo_1", { producer: { kind: "doctor", name: "张医生", hospital: "某某医院", department: "内分泌科" } }));
  });
});
