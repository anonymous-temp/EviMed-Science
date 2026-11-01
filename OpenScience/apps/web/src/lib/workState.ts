/** The domain's closed vocabulary for module work, typed for the web (`@evimed/domain` `workState.mjs`). */
export type WorkState = "todo" | "queued" | "running" | "waiting" | "minimal" | "done" | "failed" | "stale" | "stopped" | "paused";
export type WorkNeedKind = "provide" | "confirm" | "resolve" | "offline";
export type WorkActionKind = "draft" | "start" | "set" | "external";
