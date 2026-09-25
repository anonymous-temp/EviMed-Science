import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { GEO_SUMMARIES } from "@/components/geo/__fixtures__/geoProjects";
import { GEO_OFF_SENTENCE } from "@/components/geo/GeoStates";
import { GeoHomePage } from "./GeoHomePage";

const client = vi.hoisted(() => ({
  useGeoFeature: vi.fn(),
  listGeoProjects: vi.fn(),
  createGeoProject: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  useGeoFeature: client.useGeoFeature,
  listGeoProjects: client.listGeoProjects,
  createGeoProject: client.createGeoProject,
}));

// Opening a GEO conversation switches the shell's project; that has its own
// test (useOpenGeoConversation.test.tsx). Here it is the call it makes.
vi.mock("@/components/geo/useOpenGeoConversation", () => ({ useOpenGeoConversation: () => client.open }));

function renderHome() {
  return render(<MemoryRouter initialEntries={["/app/geo"]}><GeoHomePage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  client.useGeoFeature.mockReturnValue("on");
  client.listGeoProjects.mockResolvedValue(GEO_SUMMARIES);
  client.open.mockResolvedValue(undefined);
});

describe("循证 GEO home", () => {
  it("lists one row per product with its index, its trend against the target, and 品牌提及率 with its sample", async () => {
    renderHome();
    expect(screen.getByRole("heading", { level: 1, name: "循证 GEO" })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "GEO 项目" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    const masi = rows[0];
    expect(within(masi).getByRole("link", { name: "玛仕度肽注射液" })).toHaveAttribute("href", "/app/geo/geo_masi");
    expect(masi).toHaveTextContent("38");
    expect(masi).toHaveTextContent("18%");
    expect(masi).toHaveTextContent("310 次里 56 次");
    // The trend is drawn against a dashed target.
    expect(masi.querySelector("[data-geo-sparkline] [data-geo-target]")).not.toBeNull();
    // The one red sentence: what an engine says wrong about the product.
    const alert = within(masi).getByText("2 条讲错我方待纠正");
    expect(alert).toHaveClass("text-danger");
    expect(masi.querySelector("[data-geo-subline]")).toHaveTextContent(/^10月1日 – 12月31日/);

    // Under 30 answers the rate is not shown: 「样本不足」, with how few there were.
    const mitiao = rows[1];
    expect(mitiao).toHaveTextContent("样本不足");
    expect(mitiao).toHaveTextContent("12 次回答");
    expect(mitiao).not.toHaveTextContent("44%");
    expect(mitiao.querySelector(".text-danger")).toBeNull();

    // A project that did one step is in the list all the same, with 「—」.
    const xinli = rows[2];
    expect(xinli).toHaveTextContent("只做了信源分析");
    expect(within(xinli).getAllByText("—")).toHaveLength(2);
  });

  it("creates a project and lands in its conversation — no form", async () => {
    client.createGeoProject.mockResolvedValue({ id: "geo_new", projectId: "p-new", sessionId: "ses_new" });
    renderHome();
    await screen.findByRole("list", { name: "GEO 项目" });
    await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ projectId: "p-new", sessionId: "ses_new" }));
    expect(client.createGeoProject).toHaveBeenCalledWith({});
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("says there is nothing yet when there is no project, with the one button in the header", async () => {
    client.listGeoProjects.mockResolvedValue([]);
    renderHome();
    expect(await screen.findByText("还没有 GEO 项目")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "新建项目" })).toHaveLength(1);
  });

  it("offers a retry when the list cannot be read", async () => {
    client.listGeoProjects.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: "geo_unavailable" }));
    renderHome();
    await userEvent.click(await screen.findByRole("button", { name: /重试/ }));
    expect(await screen.findByRole("list", { name: "GEO 项目" })).toBeInTheDocument();
  });

  it("is one sentence where the module is off for this account", async () => {
    client.useGeoFeature.mockReturnValue("off");
    renderHome();
    expect(screen.getByText(GEO_OFF_SENTENCE)).toBeInTheDocument();
    expect(client.listGeoProjects).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "新建项目" })).not.toBeInTheDocument();
  });

  it("believes the route over the account read: geo_not_enabled is the off page too", async () => {
    client.useGeoFeature.mockReturnValue("error");
    client.listGeoProjects.mockRejectedValue(new WebApiError("off", { status: 404, code: "geo_not_enabled" }));
    renderHome();
    expect(await screen.findByText(GEO_OFF_SENTENCE)).toBeInTheDocument();
  });
});
