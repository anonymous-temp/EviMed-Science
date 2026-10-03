import { beforeEach, expect, it, vi } from "vitest";
import { extensionConnections, extensionHistory, extensionSourceUrl, sameExtensionCoordinate, saveProjectExtensions, updateExtension } from "./extensionsClient";
const request = vi.hoisted(() => vi.fn());
vi.mock("./productClient", () => ({ productRequest: request }));
beforeEach(() => request.mockReset());
it("sends an exact-coordinate update with the expected installation revision", async () => {
  const coordinate = { kind: "npm" as const, name: "@example/table", version: "1.2.3" };
  await updateExtension("extension:one", 4, coordinate);
  expect(request).toHaveBeenCalledWith("/extensions/installations/extension%3Aone/update", "POST", { expectedRevision: 4, coordinate });
});
it("pages revision history with both the bounded limit and opaque server revision cursor", async () => {
  await extensionHistory("extension:one", 49, 20);
  expect(request).toHaveBeenCalledWith("/extensions/installations/extension%3Aone/revisions?limit=20&beforeRevision=49");
});
it("scopes managed connection discovery by catalogue and project without connection secrets", async () => {
  await extensionConnections("catalogue:one", "project:one");
  expect(request).toHaveBeenCalledWith("/extensions/connections?catalogueId=catalogue%3Aone&projectId=project%3Aone");
});
it("writes only selection configuration and opaque connection ids", async () => {
  await saveProjectExtensions("project:one", 7, [{ installationId: "extension:one", enabled: true, settings: { fraction: 0.75 }, connectionRefs: ["connection:one"], catalogueId: "ignore", effective: true }]);
  expect(request).toHaveBeenCalledWith("/projects/project%3Aone/extensions", "PUT", { expectedRevision: 7, selections: [{ installationId: "extension:one", enabled: true, settings: { fraction: 0.75 }, connectionRefs: ["connection:one"] }] });
});
it("distinguishes github subdirectories and links the exact source pin", () => {
  const first = { kind: "github" as const, repository: "example/tool", commit: "a".repeat(40), subdirectory: "plugins/table" };
  expect(sameExtensionCoordinate(first, { ...first, subdirectory: "plugins/other" })).toBe(false);
  expect(sameExtensionCoordinate(first, { ...first })).toBe(true);
  expect(extensionSourceUrl(first)).toBe(`https://github.com/example/tool/tree/${first.commit}/plugins/table`);
  expect(extensionSourceUrl({ kind: "npm", name: "@example/tool", version: "1.2.3" })).toBe("https://www.npmjs.com/package/@example/tool/v/1.2.3");
});
