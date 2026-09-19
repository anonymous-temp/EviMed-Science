import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryHubPage } from "./MemoryHubPage";

// The hub is a table of sections; each section has its own tests.
vi.mock("@/components/capsule/CapsuleOverview", () => ({ CapsuleOverview: () => <p>overview section</p> }));
vi.mock("@/components/capsule/UnderstandingSection", () => ({ UnderstandingSection: () => <p>understanding section</p> }));
vi.mock("@/components/capsule/ProjectDossierSection", () => ({ ProjectDossierSection: () => <p>dossier section</p> }));
vi.mock("@/components/capsule/CapsuleMethodsSection", () => ({ CapsuleMethodsSection: () => <p>methods section</p> }));
vi.mock("@/components/capsule/CapsuleTimeline", () => ({ CapsuleTimeline: () => <p>timeline section</p> }));
vi.mock("@/components/capsule/LibrarySection", () => ({ LibrarySection: () => <p>library section</p> }));
vi.mock("@/components/capsule/ReceivedShelf", () => ({ ReceivedShelf: () => null }));
vi.mock("@/components/memory/useMemoryWritePrompt", () => ({ useMemoryWritePrompt: () => {} }));
vi.mock("./MemoryPage", () => ({ MemoryPage: () => null }));
vi.mock("./CapsulesPage", () => ({ CapsulesPage: () => null }));
vi.mock("./CapsuleTransferPanel", () => ({ CapsuleTransferPanel: () => null }));
vi.mock("./MethodsPage", () => ({ MethodsPage: () => null }));

function Where() {
  const location = useLocation();
  return <span data-testid="where">{location.search}</span>;
}

function open(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/app/memory${search}`]}>
      <Routes><Route path="/app/memory" element={<><MemoryHubPage /><Where /></>} /></Routes>
    </MemoryRouter>,
  );
}

describe("记忆胶囊", () => {
  afterEach(cleanup);

  it("is one capsule in six sections, in the order a reader meets them", () => {
    open("");
    expect(screen.getByRole("heading", { name: "记忆胶囊" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["总览", "对你的理解", "项目档案", "方法", "资料", "时间轴"]);
    expect(screen.getByText("overview section")).toBeInTheDocument();
  });

  it("keeps the addresses people kept: 方法胶囊 opens 方法, 记忆 opens 对你的理解", () => {
    open("?tab=capsules");
    expect(screen.getByRole("tab", { name: "方法" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("where")).toHaveTextContent("?tab=methods");
    cleanup();
    open("?tab=notes");
    expect(screen.getByRole("tab", { name: "对你的理解" })).toHaveAttribute("aria-selected", "true");
  });

  it("an inbox notice that names a memory lands where memories are, keeping the name", () => {
    open("?record=rec_1");
    expect(screen.getByText("understanding section")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("record=rec_1");
  });
});
