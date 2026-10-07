import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/projects";
import { KnowledgeScopeMenu } from "./KnowledgeScopeMenu";

const modules = vi.hoisted(() => ({ geo: new Set<string>() }));
vi.mock("@/lib/geoClient", () => ({ useGeoFeature: () => "on" }));
vi.mock("@/lib/vcrClient", () => ({ useVcrFeature: () => "off" }));
vi.mock("@/components/geo/useGeoProjectIds", () => ({ useGeoProjectIds: () => modules.geo }));
vi.mock("@/components/vcr/useVcrProjectIds", () => ({ useVcrProjects: () => ({ studies: new Set<string>(), drafts: new Set<string>() }) }));

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
    render(<KnowledgeScopeMenu scope={{ kind: "project", projectId: "g2" }} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "范围：波立维 · 10月1日" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "范围：波立维 · 10月1日" }));
    expect(await screen.findByRole("menuitemradio", { name: "波立维 · 9月29日" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "波立维 · 10月1日" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitemradio", { name: "波立维 · 9月29日" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "project", projectId: "g1" });
  });
});
