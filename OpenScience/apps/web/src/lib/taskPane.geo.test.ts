import { expect, it } from "vitest";
import { geoConversationPane, geoPanePath } from "./geoLocation";
import { isPanePath, matchesGeoPane, type TaskPaneRequest } from "./taskPane";

it("admits only an explicit, exact, authorized GEO pane", () => {
  const address = geoConversationPane("/app/geo/g/answers/snap", "?conversation=open&session=s1");
  const request: TaskPaneRequest = { element: document.createElement("div"), projectId: "p", sessionId: "s1", scope: { kind: "geo", geoProjectId: "g", sessionId: "s1" } };
  expect(isPanePath("/app/geo/g/answers/snap", "?conversation=open&session=s1")).toBe(true);
  expect(matchesGeoPane(request, address)).toBe(true);
  expect(matchesGeoPane({ ...request, scope: { ...request.scope!, geoProjectId: "other" } }, address)).toBe(false);
  expect(matchesGeoPane({ ...request, sessionId: "stale" }, address)).toBe(false);
  expect(matchesGeoPane({ ...request, scope: { ...request.scope!, sessionId: "stale" } }, address)).toBe(false);
  expect(geoConversationPane("/app/geo/g/answers/snap", "?session=s1")).toBeNull();
  expect(geoConversationPane("/app/geo/g/answers/snap", "?conversation=open&session=s1&session=s2")).toBeNull();
  expect(geoPanePath("/app/geo/g/answers/snap", "?round=r1", "#source", "s1")).toBe("/app/geo/g/answers/snap?round=r1&conversation=open&session=s1#source");
});
