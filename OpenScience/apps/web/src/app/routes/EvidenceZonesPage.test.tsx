import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { EvidenceZonesPage } from "./EvidenceZonesPage";

const client = vi.hoisted(() => ({ fetchZoneDirectory: vi.fn() }));
vi.mock("@/lib/evidenceTopicClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceTopicClient")>()), ...client }));

function Where() { const location = useLocation(); return <pre data-testid="where">{location.pathname + location.search}</pre>; }
const mount = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/app/frontier/zones" element={<EvidenceZonesPage />} />
      <Route path="*" element={<Where />} />
    </Routes>
  </MemoryRouter>,
);

describe("the directory's old address", () => {
  it.each([
    ["/app/frontier/zones", "/app/frontier?view=zones"],
    ["/app/frontier/zones?scope=following", "/app/frontier?view=zones&scope=mine"],
    ["/app/frontier/zones?scope=owned", "/app/frontier?view=zones&scope=mine"],
    ["/app/frontier/zones?scope=mine", "/app/frontier?view=zones&scope=mine"],
    ["/app/frontier/zones?scope=community", "/app/frontier?view=zones&scope=community"],
    ["/app/frontier/zones?scope=nonsense", "/app/frontier?view=zones"],
    [`/app/frontier/zones?request=${encodeURIComponent("乳腺癌")}`, "/app/frontier?view=zones"],
    // The chooser of a zone for an item went with the cards the platform used to write: it lands on the directory too.
    ["/app/frontier/zones?fromItem=item-1", "/app/frontier?view=zones"],
  ])("hands %s over to the feed page's 证据专区 view", async (from, to) => {
    mount(from);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(to));
    expect(client.fetchZoneDirectory).not.toHaveBeenCalled();
  });
});
