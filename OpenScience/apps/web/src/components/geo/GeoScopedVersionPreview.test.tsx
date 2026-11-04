import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { GeoScopedVersionPreview } from "./GeoScopedVersionPreview";
import { WEB_SESSION_STARTED_EVENT } from "@/lib/sessionLifecycle";

const reads = vi.hoisted(() => ({ article: vi.fn(), publication: vi.fn() }));
vi.mock("@/lib/geoClient", async original => ({ ...await original<typeof import("@/lib/geoClient")>(), readGeoArticleVersion: reads.article, readGeoPublicationVersion: reads.publication }));
beforeEach(() => { reads.article.mockReset(); reads.publication.mockReset(); });

it("reads the selected article version within its GEO project", async () => {
  reads.article.mockResolvedValueOnce({ text: "Preserved article" });
  render(<GeoScopedVersionPreview geoId="geo-1" target={{ kind: "article", recordId: "article-1", versionId: "v1", digest: "d1" }} onClose={() => undefined} />);
  expect(await screen.findByText("Preserved article")).toBeVisible();
  expect(reads.article).toHaveBeenCalledWith("geo-1", "article-1", "v1", "d1");
});

it("does not substitute a newer publication when the preserved pin is refused", async () => {
  reads.publication.mockRejectedValueOnce(new Error("stale pin"));
  render(<GeoScopedVersionPreview geoId="geo-1" target={{ kind: "owned-links", recordId: "link-1", versionId: "old", digest: "old-digest", revision: 2 }} onClose={() => undefined} />);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("所选版本暂时无法读取"));
  expect(reads.publication).toHaveBeenCalledWith("geo-1", "owned-links", "link-1", "old", "old-digest", 2);
});

it("hides a prior account's preview as soon as the login changes", async () => {
  reads.article.mockResolvedValueOnce({ text: "Previous account's text" }).mockReturnValueOnce(new Promise(() => undefined));
  render(<GeoScopedVersionPreview geoId="geo-1" target={{ kind: "article", recordId: "article-1", versionId: "v1", digest: "d1" }} onClose={() => undefined} />);
  expect(await screen.findByText("Previous account's text")).toBeVisible();
  act(() => window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT)));
  expect(screen.queryByText("Previous account's text")).not.toBeInTheDocument();
});
