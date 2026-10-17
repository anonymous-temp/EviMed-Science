import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/projects";
import { ScopeMenu } from "@/components/ui/ScopeMenu";
import type { SourceScope } from "@/lib/sourceClient";
import { useKnowledgeScope } from "./KnowledgeScopeMenu";

const modules = vi.hoisted(() => ({ geo: new Set<string>() }));
vi.mock("@/lib/geoClient", () => ({ useGeoFeature: () => "on" }));
vi.mock("@/lib/vcrClient", () => ({ useVcrFeature: () => "off" }));
vi.mock("@/components/geo/useGeoProjectIds", () => ({ useGeoProjectIds: () => modules.geo }));
vi.mock("@/components/vcr/useVcrProjectIds", () => ({ useVcrProjects: () => ({ studies: new Set<string>(), drafts: new Set<string>() }) }));

/** The header's menu as the page draws it: the hook's answer handed to the one `ScopeMenu`. */
function Menu({ scope, onChange }: { scope: SourceScope; onChange: (scope: SourceScope) => void }) {
  return <ScopeMenu {...useKnowledgeScope(scope, onChange)} />;
}

describe("the knowledge base's scope menu", () => {
  beforeEach(() => {
    const year = new Date().getFullYear();
    modules.geo = new Set(["g1", "g2"]);
    useProjectStore.setState({
      projects: [
        { id: "default", name: "我的研究" },
        { id: "g1", name: "波立维", createdAt: new Date(year, 8, 29, 9, 0).toISOString() },
        { id: "g2", name: "波立维", createdAt: new Date(year, 9, 1, 9, 0).toISOString() },
      ],
    });
  });
  afterEach(cleanup);

  it("lists two projects of one name as two different entries, and says which is chosen", async () => {
    const onChange = vi.fn();
    render(<Menu scope={{ kind: "project", projectId: "g2" }} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "范围：波立维 · 10月1日" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "范围：波立维 · 10月1日" }));
    expect(await screen.findByRole("menuitemradio", { name: "波立维 · 9月29日" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "波立维 · 10月1日" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitemradio", { name: "波立维 · 9月29日" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "project", projectId: "g1" });
  });

  it("groups the projects as the sidebar does and ends with the documents every project shares, which is a scope and not a project", async () => {
    const onChange = vi.fn();
    render(<Menu scope={{ kind: "project", projectId: "default" }} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "范围：我的研究" }));
    const menu = await screen.findByRole("menu", { name: "范围" });
    expect([...menu.querySelectorAll("[role^=menuitem]")].map((item) => item.textContent)).toEqual(["我的研究", "波立维 · 9月29日", "波立维 · 10月1日", "所有项目共享"]);
    expect(within(menu).getByText("我的项目")).toBeInTheDocument();
    expect(within(menu).getByText("循证 GEO")).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: "所有项目共享" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "shared" });
  });

  it("says which scope is chosen when it is the shared one, and still names a project the list does not hold", async () => {
    const { unmount } = render(<Menu scope={{ kind: "shared" }} onChange={() => undefined} />);
    expect(screen.getByRole("button", { name: "范围：所有项目共享" })).toBeInTheDocument();
    unmount();
    render(<Menu scope={{ kind: "project", projectId: "gone" }} onChange={() => undefined} />);
    expect(screen.getByRole("button", { name: "范围：当前项目" })).toBeInTheDocument();
  });
});
