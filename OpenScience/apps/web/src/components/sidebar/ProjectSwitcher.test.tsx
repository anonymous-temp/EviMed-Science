import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { WebApiError } from "@/lib/apiClient";
import { PROJECT_EXPLAINER } from "@/lib/projectNames";

const state = {
  projects: [
    { id: "default", name: "我的研究" },
    { id: "paper1", name: "Paper 1" },
  ] as Array<{ id: string; name: string }>,
  currentId: "default",
  loading: false,
  error: null as string | null,
  load: vi.fn(),
  select: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
};

vi.mock("@/lib/projects", () => ({
  useProjectStore: () => state,
}));

function renderSwitcher(props: { running?: boolean } = {}) {
  return render(
    <MemoryRouter>
      <ProjectSwitcher {...props} />
    </MemoryRouter>,
  );
}

async function openPanel() {
  await userEvent.click(screen.getByRole("button", { name: /^当前项目：/ }));
  return screen.getByRole("dialog", { name: "切换项目" });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.projects = [
    { id: "default", name: "我的研究" },
    { id: "paper1", name: "Paper 1" },
  ];
  state.currentId = "default";
  state.error = null;
  state.loading = false;
  state.select.mockResolvedValue(undefined);
  state.create.mockResolvedValue({ id: "p-1a2b3c4d", name: "阿司匹林一级预防" });
  state.rename.mockResolvedValue({ id: "paper1", name: "论文一" });
});

describe("ProjectSwitcher", () => {
  it("names the current project and lists every project on open", async () => {
    renderSwitcher();
    expect(state.load).toHaveBeenCalled();

    const panel = await openPanel();
    expect(within(panel).getByRole("button", { name: "Paper 1" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "我的研究" })).toHaveAttribute("aria-current", "true");
    // Focus lands on the current project, so ↑/↓ start from there.
    expect(within(panel).getByRole("button", { name: "我的研究" })).toHaveFocus();
  });

  // What a project is, said where the choice is made: switching one restarts
  // the runtime, and until 2026-09-18 nothing said so (review B §2e).
  it("says what a project is under the list", async () => {
    renderSwitcher();
    const panel = await openPanel();
    expect(within(panel).getByText(PROJECT_EXPLAINER)).toBeInTheDocument();
    expect(PROJECT_EXPLAINER).toContain("切换会重启研究运行时");
  });

  it("switches to a chosen project", async () => {
    renderSwitcher();
    const panel = await openPanel();
    await userEvent.click(within(panel).getByRole("button", { name: "Paper 1" }));

    await waitFor(() => expect(state.select).toHaveBeenCalledWith("paper1"));
  });

  it("moves between projects with the arrow keys and chooses with Enter", async () => {
    renderSwitcher();
    await openPanel();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "Paper 1" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(state.select).toHaveBeenCalledWith("paper1"));
  });

  it("closes on Escape and gives focus back to the trigger", async () => {
    renderSwitcher();
    await openPanel();
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "切换项目" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^当前项目：/ })).toHaveFocus();
  });

  // A switch that fails has to say so in the panel. Closing on failure would
  // read as success against a project the account never moved to.
  it("keeps the panel open and shows why a switch failed", async () => {
    state.select.mockRejectedValue(new WebApiError("project unavailable", { status: 503, code: "runtime_unavailable" }));
    renderSwitcher();
    const panel = await openPanel();
    await userEvent.click(within(panel).getByRole("button", { name: "Paper 1" }));

    expect(await screen.findByText("运行时出现问题，稍后重试。")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "切换项目" })).toBeInTheDocument();
  });

  // The field said 「新项目名」 and refused every Chinese name, because it was
  // the server's id (review B §2). It takes a name now; the server keys it.
  it("creates a project from a name in any language and moves to it", async () => {
    renderSwitcher();
    await openPanel();
    await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
    await userEvent.type(screen.getByRole("textbox", { name: "新项目名" }), "阿司匹林一级预防{Enter}");

    await waitFor(() => expect(state.create).toHaveBeenCalledWith("阿司匹林一级预防"));
    await waitFor(() => expect(state.select).toHaveBeenCalledWith("p-1a2b3c4d"));
  });

  it("asks for a name before creating, without calling the API", async () => {
    renderSwitcher();
    await openPanel();
    await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
    await userEvent.type(screen.getByRole("textbox", { name: "新项目名" }), "   {Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("请给项目起个名字。");
    expect(state.create).not.toHaveBeenCalled();
  });

  it("explains the project limit in Chinese, with its reason", async () => {
    state.create.mockRejectedValue(new WebApiError("This account already holds 2 projects", { status: 409, code: "project_limit_reached" }));
    renderSwitcher();
    await openPanel();
    await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
    await userEvent.type(screen.getByRole("textbox", { name: "新项目名" }), "第三个{Enter}");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("这个账号已有 2 个项目，达到上限");
    expect(alert).toHaveTextContent("每个项目都有自己的研究运行时和工作区");
    expect(alert.textContent).not.toMatch(/[A-Za-z]{4,}/);
  });

  it("renames a project in place", async () => {
    renderSwitcher();
    await openPanel();
    await userEvent.click(screen.getByRole("button", { name: "重命名项目「Paper 1」" }));
    const input = screen.getByRole("textbox", { name: "新的项目名" });
    expect(input).toHaveValue("Paper 1");
    await userEvent.clear(input);
    await userEvent.type(input, "论文一{Enter}");

    await waitFor(() => expect(state.rename).toHaveBeenCalledWith("paper1", "论文一"));
  });

  it("leaves a rename with Escape without closing the panel", async () => {
    renderSwitcher();
    await openPanel();
    await userEvent.click(screen.getByRole("button", { name: "重命名项目「Paper 1」" }));
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("textbox", { name: "新的项目名" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "切换项目" })).toBeInTheDocument();
    expect(state.rename).not.toHaveBeenCalled();
  });

  it("offers a search box past six projects, and filters by name", async () => {
    state.projects = [
      { id: "default", name: "我的研究" },
      ...["心衰", "房颤", "卒中", "糖尿病", "高血压", "慢阻肺"].map((name, index) => ({ id: `p${index}`, name })),
    ];
    renderSwitcher();
    await openPanel();
    const search = screen.getByRole("searchbox", { name: "搜索项目" });
    expect(search).toHaveFocus();
    await userEvent.type(search, "房");

    expect(screen.getByRole("button", { name: "房颤" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "心衰" })).not.toBeInTheDocument();
  });

  it("has no search box for a short list", async () => {
    renderSwitcher();
    await openPanel();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("marks the trigger when a run is going in this project", () => {
    renderSwitcher({ running: true });
    expect(screen.getByRole("button", { name: "当前项目：我的研究（有研究正在运行）" })).toBeInTheDocument();
  });

  it("links to the account page for managing projects", async () => {
    renderSwitcher();
    await openPanel();
    expect(screen.getByRole("link", { name: "管理项目" })).toHaveAttribute("href", "/app/account?tab=settings");
  });

  it("shows a read failure in place of the list", async () => {
    state.error = "项目列表暂时读不到";
    renderSwitcher();
    await openPanel();

    expect(screen.getByText("项目列表暂时读不到")).toBeInTheDocument();
  });
});
