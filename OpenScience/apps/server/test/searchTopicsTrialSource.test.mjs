import assert from "node:assert/strict";
import test from "node:test";
import { createSearchTopicsTrialSource } from "../src/searchTopicsTrialSource.mjs";

const AT = new Date("2026-10-30T04:00:00.000Z");
function study(id = "NCT07797140", updatedDate = "2026-10-29") {
  return { protocolSection: {
    identificationModule: { nctId: id, briefTitle: "Registered trial title" },
    statusModule: { lastUpdatePostDateStruct: { date: updatedDate }, studyFirstPostDateStruct: { date: "2026-10-01" } },
    conditionsModule: { conditions: ["Thyroid Cancer", "Thyroid Cancer"] },
    designModule: { studyType: "INTERVENTIONAL" },
    sponsorCollaboratorsModule: { leadSponsor: { name: "Public university" } },
    contactsLocationsModule: { centralContacts: [{ name: "Never copied", email: "private@example.org" }] },
  } };
}
function fixture(body, status = 200, headers = { "content-type": "application/json" }) {
  const seen = [];
  const source = createSearchTopicsTrialSource({ now: () => AT, fetchImpl: async (url, init) => {
    seen.push({ url: new URL(String(url)), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  } });
  return { source, seen };
}

test("reads only the fixed public trial API with a bounded recent-date query and scientific projection", async () => {
  const { source, seen } = fixture({ studies: [study()], nextPageToken: "not-followed" });
  const answer = await source.read();
  assert.equal(seen.length, 1);
  const { url, init } = seen[0];
  assert.equal(url.origin, "https://clinicaltrials.gov");
  assert.equal(url.pathname, "/api/v2/studies");
  assert.equal(url.searchParams.get("filter.advanced"), "AREA[StudyType]INTERVENTIONAL AND AREA[LastUpdatePostDate]RANGE[2026-09-30,2026-10-30]");
  assert.equal(url.searchParams.get("sort"), "LastUpdatePostDate:desc");
  assert.equal(url.searchParams.get("pageSize"), "100");
  assert.equal(url.searchParams.get("fields"), "NCTId,BriefTitle,Condition,LeadSponsorName,LastUpdatePostDate,StudyFirstPostDate,StudyType");
  assert.equal(init.redirect, "manual");
  assert.equal(init.method, "GET");
  assert.equal(init.headers.authorization, undefined);
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(answer, { records: [{ id: "NCT07797140", title: "Registered trial title", conditions: ["Thyroid Cancer"],
    sourceName: "ClinicalTrials.gov", sponsor: "Public university", updatedDate: "2026-10-29", firstPostedDate: "2026-10-01",
    url: "https://clinicaltrials.gov/study/NCT07797140" }], fetchedAt: AT.toISOString(), dataThrough: "2026-10-29T00:00:00.000Z",
    windowStart: "2026-09-30", windowEnd: "2026-10-30", hasMore: true });
  assert.equal(JSON.stringify(answer).includes("private@example.org"), false);
});

test("skips malformed, duplicate, old and future records without inventing dates or identities", async () => {
  const wrongFirstDate = study("NCT07797141");
  wrongFirstDate.protocolSection.statusModule.studyFirstPostDateStruct.date = "2026-11-01";
  const missingFirstDate = study("NCT07797142");
  delete missingFirstDate.protocolSection.statusModule.studyFirstPostDateStruct;
  const { source } = fixture({ studies: [study(), study(), study("not-NCT"), study("NCT00000000"), study("NCT07797143", "2026-11-01"),
    study("NCT07797144", "2026-09-29"), study("NCT07797145", "2026-10"), study("NCT07797146", "2026-02-30"), wrongFirstDate, missingFirstDate] });
  const answer = await source.read();
  assert.deepEqual(answer.records.map(item => item.id), ["NCT07797140", "NCT07797142"]);
  assert.equal(answer.records[1].firstPostedDate, null);
});

test("distinguishes an actual empty API page from an unreadable nonempty answer", async () => {
  const { source } = fixture({ studies: [] });
  const answer = await source.read();
  assert.deepEqual(answer.records, []);
  assert.equal(answer.dataThrough, null);
  assert.equal(answer.hasMore, false);
  await assert.rejects(fixture({ studies: [study("fake")] }).source.read(), { code: "search_topics_trials_unavailable" });
  await assert.rejects(fixture({ totalCount: 0 }).source.read(), { code: "search_topics_trials_unavailable" });
});

test("requires interventional trial records and keeps other valid study types as a real empty result", async () => {
  const observational = study("NCT07797141");
  observational.protocolSection.designModule.studyType = "OBSERVATIONAL";
  const expandedAccess = study("NCT07797142");
  expandedAccess.protocolSection.designModule.studyType = "EXPANDED_ACCESS";
  const missingType = study("NCT07797143");
  delete missingType.protocolSection.designModule.studyType;
  const mixed = await fixture({ studies: [study(), observational, expandedAccess, missingType] }).source.read();
  assert.deepEqual(mixed.records.map(item => item.id), ["NCT07797140"]);
  const none = await fixture({ studies: [observational, expandedAccess] }).source.read();
  assert.deepEqual(none.records, []);
  assert.equal(none.dataThrough, null);
  await assert.rejects(fixture({ studies: [missingType] }).source.read(), { code: "search_topics_trials_unavailable" });
});

test("refuses redirects, upstream refusals, wrong MIME and malformed JSON instead of returning fake zeroes", async () => {
  for (const source of [fixture("", 302, { location: "https://127.0.0.1/", "content-type": "application/json" }).source,
    fixture({}, 429).source, fixture({ studies: [] }, 200, { "content-type": "text/html" }).source,
    fixture("not-json").source]) {
    await assert.rejects(source.read(), { code: "search_topics_trials_unavailable" });
  }
});

test("caps source requests and oversized response bodies", async () => {
  let asked;
  const source = createSearchTopicsTrialSource({ now: () => AT, maxStudies: 1e9, fetchImpl: async url => {
    asked = new URL(String(url));
    return new Response(JSON.stringify({ studies: [study()] }), { headers: { "content-type": "application/json" } });
  } });
  await source.read();
  assert.equal(asked.searchParams.get("pageSize"), "200");
  await assert.rejects(fixture(" ".repeat(2 * 1024 * 1024 + 1)).source.read(), { code: "search_topics_trials_unavailable" });
});

test("aborts a stalled source read at its one deadline", async () => {
  let signal;
  const hold = setTimeout(() => {}, 1_000);
  try {
    const source = createSearchTopicsTrialSource({ now: () => AT, timeoutMs: 100, fetchImpl: async (_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    } });
    await assert.rejects(source.read(), { code: "search_topics_trials_unavailable" });
    assert.equal(signal.aborted, true);
  } finally { clearTimeout(hold); }
});
