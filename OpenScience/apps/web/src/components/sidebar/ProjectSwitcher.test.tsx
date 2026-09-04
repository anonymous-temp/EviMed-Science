import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSwitcher } from "./ProjectSwitcher";

const state = {
  projects: [
    { id: "default", name: "Default Project" },
    { id: "paper1", name: "Paper 1" },
  ],
  currentId: "default",
  loading: false,
  error: null as string | null,
  load: vi.fn(),
  select: vi.fn(),
  create: vi.fn(),
};

vi.mock("@/lib/projects", () => ({
  useProjectStore: () => state,
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.currentId = "default";
  state.error = null;
  state.loading = false;
  state.select.mockResolvedValue(undefined);
  state.create.mockResolvedValue({ id: "review", name: "review" });
});

describe("ProjectSwitcher", () => {
  it("names the current project and lists the rest on open", async () => {
    render(<ProjectSwitcher />);
    expect(state.load).toHaveBeenCalled();

    const trigger = screen.getByRole("button", { name: "当前项目：Default Project" });
    await userEvent.click(trigger);

    expect(screen.getByRole("option", { name: /Paper 1/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Default Project/ })).toHaveAttribute("aria-selected", "true");
  });

  it("switches to a chosen project", async () => {
    render(<ProjectSwitcher />);
    await userEvent.click(screen.getByRole("button", { name: "当前项目：Default Project" }));
    await userEvent.click(screen.getByRole("option", { name: /Paper 1/ }));

    await waitFor(() => expect(state.select).toHaveBeenCalledWith("paper1"));
  });

  // A switch that fails has to say so in the menu. Closing on failure would
  // read as success against a project the account never moved to.
  it("keeps the menu open and shows why a switch failed", async () => {
    state.select.mockRejectedValue(new Error("该项目当前不可用。"));
    render(<ProjectSwitcher />);
    await userEvent.click(screen.getByRole("button", { name: "当前项目：Default Project" }));
    await userEvent.click(screen.getByRole("option", { name: /Paper 1/ }));

    expect(await screen.findByText("该项目当前不可用。")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Paper 1/ })).toBeInTheDocument();
  });

  it("creates a project and moves to it", async () => {
    render(<ProjectSwitcher />);
    await userEvent.click(screen.getByRole("button", { name: "当前项目：Default Project" }));
    await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
    await userEvent.type(screen.getByRole("textbox", { name: "新项目名" }), "review{Enter}");

    await waitFor(() => expect(state.create).toHaveBeenCalledWith("review"));
    await waitFor(() => expect(state.select).toHaveBeenCalledWith("review"));
  });

  // The control plane refuses these ids; refusing them here means a person
  // sees why instead of a generic server error.
  it("refuses an id the server would reject, without calling the API", async () => {
    render(<ProjectSwitcher />);
    await userEvent.click(screen.getByRole("button", { name: "当前项目：Default Project" }));
    await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
    await userEvent.type(screen.getByRole("textbox", { name: "新项目名" }), "../private{Enter}");

    expect(await screen.findByText(/只能用字母、数字、连字符和下划线/)).toBeInTheDocument();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("shows a read failure in place of the list", async () => {
    state.error = "projects_unreadable";
    render(<ProjectSwitcher />);
    await userEvent.click(screen.getByRole("button", { name: "当前项目：Default Project" }));

    expect(screen.getByText("projects_unreadable")).toBeInTheDocument();
  });
});
