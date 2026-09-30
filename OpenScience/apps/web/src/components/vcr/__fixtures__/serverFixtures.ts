/**
 * The server's own pages, as the web tests read them.
 *
 * The JSON files under `apps/server/test/fixtures/vcr-views/` are what
 * `VcrService` sends: `vcrViews.integration.test.mjs` seeds a study through the
 * real stores, reads it through the real service, and fails if the result
 * differs from them by a byte. A web test that renders from these files is
 * therefore rendering what the server sends — not a shape the test made up,
 * which is how every study tab came to crash on the first real payload
 * (review of 2026-09-29, CW-1).
 *
 * Only the network is doubled: `installVcrServer` stands in for
 * `productRequest`, and everything above it — the readers, the client's route
 * functions, the components — is real.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";

// `import.meta.url` is a browser URL under jsdom, so the directory is found
// from where vitest runs: `apps/web` (its own package script and the
// workspace filter both start there).
const ROOT = resolve(process.cwd(), "../server/test/fixtures/vcr-views");

/** One fixture, parsed fresh: a test that edits it edits its own copy. */
export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, name), "utf8")) as T;
}

/** The EV-201 study's address in every fixture (ids are numbered across the whole set). */
export const STUDY_ID = "std_1";
/** The second study: created, nothing done. */
export const EMPTY_STUDY_ID = "std_2";

type Handler = unknown | ((request: { path: string; method: string; body: unknown; query: URLSearchParams }) => unknown);

export interface VcrServerCall { method: string; path: string; body: unknown }

/**
 * The routes the module answers, from the fixtures. `overrides` replace an
 * answer by its route (`"GET /vcr/studies/std_1/population"`) with a value or
 * a function; a function may throw a `WebApiError`. Every request is recorded
 * in `calls`, so a test can assert what the browser sent.
 */
export function installVcrServer(productRequest: ReturnType<typeof vi.fn>, overrides: Record<string, Handler> = {}) {
  const calls: VcrServerCall[] = [];
  productRequest.mockReset();
  productRequest.mockImplementation(async (rawPath: string, method = "GET", body?: unknown) => {
    const [path, search = ""] = rawPath.split("?");
    const query = new URLSearchParams(search);
    calls.push({ method, path: rawPath, body });
    const key = `${method} ${path}`;
    const override = overrides[`${method} ${rawPath}`] ?? overrides[key];
    if (override !== undefined) {
      return typeof override === "function" ? (override as (request: { path: string; method: string; body: unknown; query: URLSearchParams }) => unknown)({ path, method, body, query }) : override;
    }
    if (method === "GET") {
      if (path === "/vcr/studies") return fixture("ev201/home.json");
      if (path === "/vcr/models") return fixture("ev201/models.json");
      if (path === "/vcr/precedents") return fixture("ev201/precedents.json");
      const study = /^\/vcr\/studies\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(path);
      if (study) {
        const [, id, section, item] = study;
        const set = id === EMPTY_STUDY_ID ? "empty" : "ev201";
        if (!section) return fixture(`${set}/study.json`);
        if (section === "export") return fixture("ev201/export.json");
        // The ledger route answers the store's own rows (`referralOf` in `vcrMatchStore.mjs`), not a presented page:
        // one per person the referral counts of `matching-referral.json` add up to.
        if (section === "referrals") return referralsAnswer();
        if (section === "matching" && set === "ev201") {
          const view = query.get("view");
          // Two subjects have a page of their own: P-0201 (eligible, already contacted) and P-0192 (a referral waiting on a coordinator).
          if (query.get("candidate") === "P-0201") return fixture("ev201/matching-p0201.json");
          if (query.get("candidate") === "P-0192") return fixture("ev201/matching-p0192.json");
          return fixture(view && view !== "matching" ? `ev201/matching-${view}.json` : "ev201/matching.json");
        }
        void item;
        return fixture(`${set}/${section}.json`);
      }
    }
    // A write answers what the routes answer: the row, an empty object here.
    if (method === "POST" && /\/run$/.test(path)) return { sessionId: "ses_1", runId: "run_1" };
    if (method === "POST" && /\/export$/.test(path)) return { export: { id: "exp_9" }, sessionId: "ses_1", runId: "run_2", deferred: null };
    return {};
  });
  return { calls };
}

/** The referral ledger as `GET …/referrals` answers it: the four persons the fixture's counts name. */
export function referralsAnswer() {
  const row = (id: string, subjectKey: string, state: string, extra: Record<string, unknown> = {}) => ({
    id, studyId: STUDY_ID, assessmentId: `asm_${subjectKey}`, siteId: "ste_01", subjectKey, state, contactApprovedBy: null, contactApprovedAt: null,
    screenFailCriterionId: null, screenFailReason: null, enrolledOn: null, createdAt: "2026-09-20T08:00:00.000Z", updatedAt: "2026-09-25T08:00:00.000Z", ...extra,
  });
  return {
    referrals: [
      row("ref_seed_1", "P-0192", "contactable"),
      row("ref_seed_2", "P-0201", "contacted", { contactApprovedBy: "coordinator-1", contactApprovedAt: "2026-09-26T09:30:00.000Z" }),
      row("ref_seed_3", "P-0177", "needs_evidence"),
      row("ref_seed_4", "P-0150", "enrolled", { enrolledOn: "2026-09-18T00:00:00.000Z" }),
    ],
  };
}
