import { afterEach, expect, it } from "vitest";
import { WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT } from "./sessionLifecycle";
afterEach(() => sessionStorage.clear());
it.each([WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT])("clears pending database request IDs at session boundary %s without loading the database page", event => {
  sessionStorage.setItem("evimed.research-db.save.project", "pending-id");
  sessionStorage.setItem("evimed.research-db.snapshot.project.task", "pending-id-2");
  sessionStorage.setItem("unrelated", "keep");
  window.dispatchEvent(new Event(event));
  expect(sessionStorage.getItem("evimed.research-db.save.project")).toBeNull();
  expect(sessionStorage.getItem("evimed.research-db.snapshot.project.task")).toBeNull();
  expect(sessionStorage.getItem("unrelated")).toBe("keep");
});
